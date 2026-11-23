require "crypto/subtle"
require "json"
require "random/secure"

module RosegoldViewer
  class Host
    private Log       = ::Log.for(self)
    private MAX_BATCH = 16 * 1024
    private HTML      = {{ read_file("#{__DIR__}/../../web/dist/index.html") }}
    private JS        = {{ read_file("#{__DIR__}/../../web/dist/viewer-bundle.js") }}
    private CSS       = {{ read_file("#{__DIR__}/../../web/dist/viewer.css") }}
    private alias Request = LoopbackHost::Request
    private alias Reply = LoopbackHost::Reply

    record Pairing, url : String, secret : String do
      def inspect(io : IO) : Nil
        io << "RosegoldViewer::Host::Pairing(" << url << ')'
      end

      def pretty_print(pp : PrettyPrint) : Nil
        pp.text(inspect)
      end
    end

    private class Lease
      getter token : String = Random::Secure.hex(32)
      property expires_at : Time::Instant

      def initialize(@expires_at)
      end
    end

    private class Generation
      getter secret : String = Random::Secure.hex(32)
      getter stopped = Channel(Nil).new
      property pairing : Pairing?
      property lease : Lease?
    end

    @transport = LoopbackHost.new
    @feed = Feed.new
    @generation : Generation?

    def initialize(@lease_timeout : Time::Span = 15.seconds)
      raise ArgumentError.new("Lease timeout must be positive") unless @lease_timeout.positive?
    end

    def inspect(io : IO) : Nil
      to_s(io)
    end

    def pretty_print(pp : PrettyPrint) : Nil
      pp.text(inspect)
    end

    def bind(bot : Rosegold::Bot) : Nil
      @feed.bind(bot)
    end

    # Draws or replaces a named path in the bound bot's world. One point draws a marker,
    # and an empty enumerable removes the path. Returns false if the bot is not ready or the path is invalid.
    def draw_path(name : String, points : Enumerable(T), *, color : UInt32 = 0x39e4ff_u32) : Bool forall T
      @feed.draw_path(name, points, color: color)
    end

    # Removes a named path from the bound bot's world.
    def clear_path(name : String) : Nil
      @feed.clear_path(name)
    end

    def enable : Pairing?
      if current = @generation
        return current.pairing if @transport.active?
        stop
      end

      @generation = generation = Generation.new
      url = @transport.enable { |request| respond(generation, request) }
      unless url
        stop
        return
      end

      pairing = generation.pairing = Pairing.new(url, generation.secret)
      spawn(name: "viewer lease", same_thread: true) { watch(generation) }
      pairing
    rescue
      stop
      Log.warn { "Could not enable the viewer" }
      nil
    end

    def disable : Nil
      @feed.clear_paths
    ensure
      stop
    end

    private def stop : Nil
      generation = @generation
      @generation = nil
      if generation
        generation.lease = nil
        generation.stopped.close
        @feed.detach
      end
    rescue
      Log.warn { "Could not detach the viewer feed" }
    ensure
      @transport.disable
    end

    private def watch(generation : Generation) : Nil
      interval = Math.min(@lease_timeout, 1.second)
      loop do
        select
        when generation.stopped.receive?
          return
        when timeout(interval)
        end
        return unless @generation.same?(generation)
        unless @transport.active?
          stop
          return
        end
        live_lease(generation)
      end
    end

    private def respond(generation : Generation, request : Request) : Reply
      return Reply.new(:service_unavailable) unless @generation.same?(generation)
      case {request.method, request.resource}
      when {"GET", "/"}
        Reply.new(body: HTML, content_type: "text/html; charset=utf-8")
      when {"GET", "/viewer-bundle.js"}
        Reply.new(body: JS, content_type: "text/javascript; charset=utf-8")
      when {"GET", "/viewer.css"}
        Reply.new(body: CSS, content_type: "text/css; charset=utf-8")
      when {"POST", "/session"}
        pair(generation, request)
      when {"POST", "/next"}
        pull(generation, request)
      else
        Reply.new(:not_found)
      end
    end

    private def pair(generation : Generation, request : Request) : Reply
      return Reply.new(:unauthorized) unless authorized?(request, generation.secret)
      return Reply.new(:bad_request) unless request.body.empty?
      return Reply.new(:service_unavailable) unless @generation.same?(generation)

      lease = Lease.new(Time.instant + @lease_timeout)
      generation.lease = nil
      @feed.attach
      return feed_error(generation) if @feed.failure

      generation.lease = lease
      Reply.new(body: {lease: lease.token}.to_json, content_type: "application/json")
    end

    private def pull(generation : Generation, request : Request) : Reply
      lease = live_lease(generation)
      return Reply.new(:unauthorized) unless lease && authorized?(request, lease.token)
      return Reply.new(:unsupported_media_type) unless exact_header?(request, "Content-Type", "application/json")
      body = request.body
      return Reply.new(:unauthorized) unless live_lease(generation).same?(lease)
      cursor = read_cursor(body)
      return Reply.new(:bad_request) unless cursor

      batch = @feed.pull(*cursor)
      return feed_error(generation) if @feed.failure || (batch && batch.size > MAX_BATCH)
      return Reply.new(:unauthorized) unless live_lease(generation).same?(lease)

      lease.expires_at = Time.instant + @lease_timeout
      if batch
        Reply.new(body: batch, content_type: "application/octet-stream")
      else
        Reply.new(:no_content)
      end
    end

    private def live_lease(generation : Generation) : Lease?
      return unless @generation.same?(generation)
      return unless lease = generation.lease
      if @feed.failure
        feed_error(generation)
      elsif lease.expires_at <= Time.instant
        revoke(generation)
      else
        return lease
      end
      nil
    end

    private def revoke(generation : Generation) : Nil
      generation.lease = nil
      @feed.detach
    end

    private def feed_error(generation : Generation) : Reply
      reason = @feed.failure.try(&.class.name) || "oversized batch"
      revoke(generation)
      Log.warn { "Viewer feed stopped (#{reason})" }
      Reply.new(:internal_server_error)
    end

    private def authorized?(request : Request, token : String) : Bool
      values = request.headers.get?("Authorization")
      !!(values && values.size == 1 && Crypto::Subtle.constant_time_compare(values.first, "Bearer #{token}"))
    end

    private def exact_header?(request : Request, name : String, value : String) : Bool
      values = request.headers.get?(name)
      !!(values && values.size == 1 && values.first == value)
    end

    private def read_cursor(body : Bytes) : Tuple(UInt32, UInt32)?
      reader = JSON::PullParser.new(IO::Memory.new(body))
      epoch = seq = nil
      reader.read_object do |key|
        return unless reader.kind.int?
        value = reader.read_raw.to_u32?(whitespace: false)
        return unless value
        case key
        when "epoch"
          return if epoch
          epoch = value
        when "seq"
          return if seq
          seq = value
        else
          return
        end
      end
      {epoch, seq} if reader.kind.eof? && epoch && seq
    rescue JSON::ParseException
      nil
    end
  end
end
