require "deque"
require "http/request"
require "http/client/response"
require "log"
require "socket"

module RosegoldViewer
  # The owner and all host fibers must use the same scheduler thread.
  # Local processes can forge Host and Origin. The handler must authenticate sensitive requests.
  class LoopbackHost
    private Log                  = ::Log.for(self)
    private ADDRESS              = "127.0.0.1"
    private MAX_CONNECTIONS      =    8
    private MAX_REQUEST_LINE     = 2048
    private MAX_HEADERS          = 8192
    private MAX_CONTROL_BYTES    =  128
    private MAX_RESPONSE_BYTES   = 1024 * 1024
    private MAX_CONTENT_TYPE     = 128
    private MAX_POSTS_PER_SECOND =  20
    private CSP                  = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

    record Reply, status : HTTP::Status = HTTP::Status::OK, body : String | Bytes = "", content_type : String = "text/plain; charset=utf-8"

    class Request
      delegate method, resource, path, headers, to: @head

      @body : Bytes?

      def initialize(@head : HTTP::Request, &@read_body : -> Bytes)
      end

      # Authenticate before reading. The body can only be read during the handler call.
      def body : Bytes
        @body ||= @read_body.call
      end
    end

    @generation : Generation?
    @previous_port : Int32?

    def initialize(@idle_timeout : Time::Span = 1.second, @phase_timeout : Time::Span = 2.seconds)
      raise ArgumentError.new("Timeouts must be positive") unless @idle_timeout.positive? && @phase_timeout.positive?
    end

    # If already enabled, returns the current URL and keeps its original handler.
    # The handler must finish promptly. Disable closes socket I/O but cannot interrupt application code.
    def enable(&handler : Request -> Reply) : String?
      if current = @generation
        return current.url if current.active?
      end

      listener = TCPServer.new(ADDRESS, 0, backlog: MAX_CONNECTIONS)
      if listener.local_address.port == @previous_port
        previous = listener
        begin
          listener = TCPServer.new(ADDRESS, 0, backlog: MAX_CONNECTIONS)
        ensure
          previous.close
        end
      end
      generation = Generation.new(listener, handler, @idle_timeout, @phase_timeout)
      @generation = generation
      @previous_port = listener.local_address.port
      generation.start
      generation.url
    rescue ex : IO::Error
      listener.try &.close
      Log.warn(exception: ex) { "Could not start the viewer listener" }
      nil
    end

    def active? : Bool
      @generation.try(&.active?) || false
    end

    def disable : Nil
      generation = @generation
      @generation = nil
      generation.try &.stop
    end

    private class Connection
      getter socket : TCPSocket
      property pending_body = 0

      @done = Channel(Nil).new
      @deadline : Time::Instant

      def initialize(@socket, @idle_timeout : Time::Span, @phase_timeout : Time::Span)
        @deadline = Time.instant + @phase_timeout
        @socket.read_timeout = @idle_timeout
        @socket.write_timeout = @idle_timeout
      end

      def next_phase : Nil
        check_open
        @deadline = Time.instant + @phase_timeout
      end

      def check_open : Nil
        raise IO::TimeoutError.new if Time.instant >= @deadline
        raise IO::Error.new("Viewer connection closed") if @socket.closed?
      end

      def watch : Nil
        spawn(name: "viewer deadline", same_thread: true) do
          loop do
            remaining = @deadline - Time.instant
            break close if remaining <= Time::Span.zero
            select
            when @done.receive?
              break
            when timeout(remaining)
            end
          end
        end
      end

      def finish_response : Nil
        return if @pending_body.zero?

        # Closing with unread TCP bytes can reset the connection before the peer sees the reply.
        @socket.close_write
        deadline = Time.instant + 50.milliseconds
        buffer = uninitialized UInt8[MAX_CONTROL_BYTES]
        until @pending_body.zero?
          remaining = deadline - Time.instant
          break unless remaining.positive?
          @socket.read_timeout = Math.min(remaining, @idle_timeout)
          count = @socket.read(buffer.to_slice[0, @pending_body])
          break if count.zero?
          @pending_body -= count
        end
      end

      def close : Nil
        @done.close
        @socket.close
      rescue IO::Error
      end
    end

    private class Generation
      getter url : String
      getter? active = true

      @connections = Set(Connection).new
      @stopped = Channel(Nil).new
      @post_times = Deque(Time::Instant).new
      @post_in_flight : Connection?

      def initialize(@listener : TCPServer, @handler : Request -> Reply, @idle_timeout : Time::Span, @phase_timeout : Time::Span)
        @authority = "#{ADDRESS}:#{@listener.local_address.port}"
        @url = "http://#{@authority}"
      end

      def start : Nil
        spawn(name: "viewer accept", same_thread: true) { accept }
      end

      def stop : Nil
        return unless @active
        @active = false
        @stopped.close
        begin
          @listener.close
        rescue IO::Error
        end
        @connections.each(&.close)
      end

      private def accept : Nil
        retry_in = 10.milliseconds
        while @active
          begin
            socket = @listener.accept?
          rescue ex : IO::Error
            break unless @active && !@listener.closed?
            Log.warn(exception: ex) { "Viewer listener could not accept a connection; retrying" } if retry_in == 10.milliseconds
            select
            when @stopped.receive?
            when timeout(retry_in)
            end
            retry_in = Math.min(retry_in * 2, 250.milliseconds)
            next
          end
          break unless socket
          retry_in = 10.milliseconds

          if @active && @connections.size < MAX_CONNECTIONS
            connection = Connection.new(socket, @idle_timeout, @phase_timeout)
            @connections.add(connection)
            spawn(serve(connection), name: "viewer connection", same_thread: true)
          else
            socket.close
          end
          Fiber.yield
        end
      rescue ex : IO::Error
        Log.warn(exception: ex) { "Viewer listener stopped accepting connections" } if @active
      ensure
        stop
      end

      private def serve(connection : Connection) : Nil
        connection.watch
        request = read_head(connection.socket)
        connection.socket.read_buffering = false
        connection.next_phase
        return unless @active && request

        if request.is_a?(HTTP::Status)
          reply = Reply.new(request)
        else
          reply = dispatch(connection, request)
        end

        return unless @active
        connection.next_phase
        sent = send_reply(connection.socket, reply)
        release_post(connection)
        connection.finish_response if sent
      rescue IO::Error
      ensure
        connection.close
        @connections.delete(connection)
        release_post(connection)
      end

      private def release_post(connection : Connection) : Nil
        @post_in_flight = nil if @post_in_flight.same?(connection)
      end

      private def read_head(socket : TCPSocket) : HTTP::Request | HTTP::Status | Nil
        line = socket.gets(MAX_REQUEST_LINE + 1) || return nil
        return HTTP::Status::URI_TOO_LONG if line.bytesize > MAX_REQUEST_LINE
        return HTTP::Status::BAD_REQUEST unless line.ends_with?("\r\n")

        # Request.from_io may try to decompress a body while parsing the headers.
        # Give it only the bounded preamble and read the body separately.
        head = IO::Memory.new
        head << line
        remaining = MAX_HEADERS
        loop do
          line = socket.gets(remaining + 1)
          return HTTP::Status::BAD_REQUEST unless line
          return HTTP::Status::REQUEST_HEADER_FIELDS_TOO_LARGE if line.bytesize > remaining
          return HTTP::Status::BAD_REQUEST unless line.ends_with?("\r\n")
          head << line
          break if line == "\r\n"
          remaining -= line.bytesize
        end
        parse_head(head)
      end

      private def parse_head(head : IO::Memory) : HTTP::Request | HTTP::Status | Nil
        head.rewind
        HTTP::Request.from_io(head, max_request_line_size: MAX_REQUEST_LINE, max_headers_size: MAX_HEADERS)
      rescue
        HTTP::Status::BAD_REQUEST
      end

      private def dispatch(connection : Connection, head : HTTP::Request) : Reply
        headers = head.headers
        return Reply.new(:forbidden) unless exact_header?(headers, "Host", @authority)
        return Reply.new(:method_not_allowed) unless head.method.in?("GET", "POST")
        target = head.resource
        return Reply.new(:bad_request) unless target.starts_with?('/') && !target.starts_with?("//") && !target.includes?('#')
        return Reply.new(:expectation_failed) if headers.has_key?("Expect")
        return Reply.new(:bad_request) if headers.has_key?("Transfer-Encoding") || headers.has_key?("Content-Encoding")
        return Reply.new(:bad_request) if head.body && !head.body.is_a?(HTTP::FixedLengthContent)

        if lengths = headers.get?("Content-Length")
          return Reply.new(:bad_request) unless lengths.size == 1 && lengths.first.each_byte.all? { |byte| 48 <= byte <= 57 }
          length = lengths.first.to_u64?(whitespace: false)
          return Reply.new(:bad_request) unless length
        else
          length = 0_u64
        end
        return Reply.new(:payload_too_large) if length > MAX_CONTROL_BYTES

        if head.method == "GET"
          return Reply.new(:bad_request) unless length.zero?
          return invoke(connection, head, 0)
        end

        return Reply.new(:forbidden) unless exact_header?(headers, "Origin", @url)
        connection.pending_body = length.to_i
        now = Time.instant
        while (first = @post_times.first?) && now - first >= 1.second
          @post_times.shift
        end
        return Reply.new(:too_many_requests) if @post_in_flight || @post_times.size >= MAX_POSTS_PER_SECOND

        @post_times.push(now)
        @post_in_flight = connection
        invoke(connection, head, length.to_i)
      end

      private def exact_header?(headers : HTTP::Headers, name : String, value : String) : Bool
        values = headers.get?(name)
        !!(values && values.size == 1 && values.first == value)
      end

      private def invoke(connection : Connection, head : HTTP::Request, length : Int32) : Reply
        connection.check_open
        return Reply.new(:service_unavailable) unless @active

        reading_allowed = true
        @handler.call(Request.new(head) do
          raise IO::Error.new("Viewer request is no longer active") unless reading_allowed && @active
          connection.check_open
          body = Bytes.new(length)
          connection.socket.read_fully(body)
          connection.pending_body = 0
          connection.check_open
          body
        end)
      rescue ex : IO::Error
        raise ex
      rescue
        Log.warn { "Viewer request handler failed" }
        Reply.new(:internal_server_error)
      ensure
        reading_allowed = false
      end

      private def send_reply(socket : TCPSocket, reply : Reply) : Bool
        body = reply.body
        body_size = body.is_a?(String) ? body.bytesize : body.size
        if body_size > MAX_RESPONSE_BYTES || !(200..599).includes?(reply.status.code) || !valid_content_type?(reply.content_type)
          Log.warn { "Invalid viewer response" }
          reply = Reply.new(:internal_server_error)
          body = ""
        end
        headers = HTTP::Headers{
          "Connection"              => "close",
          "Cache-Control"           => "no-store",
          "Content-Security-Policy" => CSP,
          "Content-Type"            => reply.content_type,
          "X-Content-Type-Options"  => "nosniff",
        }
        headers["Allow"] = "GET, POST" if reply.status.method_not_allowed?
        payload = (body.is_a?(String) ? body : String.new(body)) if HTTP::Client::Response.mandatory_body?(reply.status)
        HTTP::Client::Response.new(reply.status, payload, headers).to_io(socket)
        true
      rescue ex : IO::Error
        raise ex
      rescue
        Log.warn { "Viewer response could not be serialized" }
        false
      end

      private def valid_content_type?(value : String) : Bool
        0 < value.bytesize <= MAX_CONTENT_TYPE && value.each_byte.all? { |byte| 32 <= byte <= 126 }
      end
    end
  end
end
