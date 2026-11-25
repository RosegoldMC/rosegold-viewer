require "spec"
require "../src/rosegold_viewer/loopback_host"

class RosegoldViewer::LoopbackHost
  def spec_generation
    @generation.not_nil!
  end

  def spec_enable_with(listener : TCPServer, &handler : Request -> Reply) : String
    generation = Generation.new(listener, handler, @idle_timeout, @phase_timeout)
    @generation = generation
    generation.start
    generation.url
  end

  private class Generation
    def spec_connection_count
      @connections.size
    end

    def spec_socket
      @connections.first.socket
    end
  end
end

private alias Host = RosegoldViewer::LoopbackHost
private alias Reply = RosegoldViewer::LoopbackHost::Reply

private class RetryListener < TCPServer
  def initialize(@failures : Int32)
    super("127.0.0.1", 0)
  end

  def accept? : TCPSocket?
    if @failures.positive?
      @failures -= 1
      raise IO::Error.new("Synthetic transient accept error")
    end
    super
  end
end

private def connect_viewer(url : String) : TCPSocket
  socket = TCPSocket.new("127.0.0.1", URI.parse(url).port.not_nil!, connect_timeout: 1.second)
  socket.read_timeout = 2.seconds
  socket.write_timeout = 2.seconds
  socket
end

private def request_head(url : String, method = "GET", target = "/", extra = "") : String
  "#{method} #{target} HTTP/1.1\r\nHost: #{url.lchop("http://")}\r\n#{extra}\r\n"
end

private def control_head(url : String, extra = "", origin = url) : String
  request_head(url, "POST", "/control", "Origin: #{origin}\r\n#{extra}")
end

private def roundtrip(url : String, wire : String) : HTTP::Client::Response
  socket = connect_viewer(url)
  socket << wire
  response = HTTP::Client::Response.from_io(socket)
  socket.read_byte.should be_nil
  response
ensure
  socket.try &.close
end

private def eventually(timeout = 2.seconds, &condition : -> Bool) : Nil
  deadline = Time.instant + timeout
  until condition.call
    raise "Condition did not become true in #{timeout}" if Time.instant >= deadline
    sleep 1.millisecond
  end
end

private def await_signal(channel : Channel(Nil)) : Nil
  select
  when channel.receive
  when timeout(2.seconds)
    raise "Timed out waiting for handler"
  end
end

private def viewer_fiber_count : Int32
  count = 0
  Fiber.each { |fiber| count += 1 if fiber.name.try(&.starts_with?("viewer ")) }
  count
end

private def begin_stalled_response(url, generation, wire) : TCPSocket
  peer = connect_viewer(url)
  peer.recv_buffer_size = 4096
  eventually { generation.spec_connection_count == 1 }
  generation.spec_socket.send_buffer_size = 4096
  peer << wire
  peer.gets.should eq("HTTP/1.1 200 OK")
  generation.spec_connection_count.should eq(1)
  peer
rescue ex
  peer.try &.close
  raise ex
end

private def disconnected?(socket : TCPSocket) : Bool
  socket.read_byte.nil?
rescue IO::TimeoutError
  false
rescue IO::Error
  true
end

describe Host do
  it "serves one bounded request per loopback connection" do
    host = Host.new
    url = host.enable { |request| Reply.new(body: request.path) }.not_nil!
    url.should start_with("http://127.0.0.1:")
    response = roundtrip(url, request_head(url, target: "/test?x=1", extra: "Connection: keep-alive\r\n"))
    response.status.should eq(HTTP::Status::OK)
    response.body.should eq("/test")
    response.headers["Connection"].should eq("close")
    response.headers["Cache-Control"].should eq("no-store")
    response.headers["Content-Security-Policy"].should eq("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  ensure
    host.try &.disable
  end

  it "keeps its URL and original handler on duplicate enable" do
    host = Host.new
    url = host.enable { Reply.new(body: "original") }.not_nil!
    host.enable { Reply.new(body: "replacement") }.should eq(url)
    roundtrip(url, request_head(url)).body.should eq("original")
  ensure
    host.try &.disable
  end

  it "backs off after transient accept errors and still serves the current generation" do
    host = Host.new
    listener = RetryListener.new(2)
    started = Time.instant
    url = host.spec_enable_with(listener) { Reply.new(body: "accepted") }
    roundtrip(url, request_head(url)).body.should eq("accepted")
    (Time.instant - started).should be >= 20.milliseconds
  ensure
    host.try &.disable
    listener.try &.close
  end

  it "reports listener failure as inactive and can enable again" do
    host = Host.new
    host.active?.should be_false
    listener = RetryListener.new(0)
    url = host.spec_enable_with(listener) { Reply.new(body: "old") }
    host.active?.should be_true
    roundtrip(url, request_head(url)).body.should eq("old")
    listener.close
    eventually { !host.active? }
    reopened = host.enable { Reply.new(body: "current") }.not_nil!
    host.active?.should be_true
    roundtrip(reopened, request_head(reopened)).body.should eq("current")
    host.disable
    host.active?.should be_false
  ensure
    host.try &.disable
    listener.try &.close
  end

  it "contains invalid response metadata and keeps serving requests" do
    host = Host.new
    url = host.enable do |request|
      content_type = case request.path
                     when "/oversized" then "x" * 129
                     when "/invalid"   then "text/plain\r\nX-Bad: control"
                     else                   "text/plain"
                     end
      Reply.new(body: "ok", content_type: content_type)
    end.not_nil!
    {"/oversized", "/invalid"}.each do |target|
      response = roundtrip(url, request_head(url, target: target))
      response.status.should eq(HTTP::Status::INTERNAL_SERVER_ERROR)
      response.headers.has_key?("X-Bad").should be_false
      response.headers.has_key?("Content-Security-Policy").should be_true
    end
    roundtrip(url, request_head(url)).body.should eq("ok")
  ensure
    host.try &.disable
  end

  it "sends binary bytes unchanged with the correct Content-Length" do
    host = Host.new
    body = Bytes[0x00, 0xff, 0xc2, 0x80, 0x01]
    url = host.enable { Reply.new(body: body, content_type: "application/octet-stream") }.not_nil!
    response = roundtrip(url, request_head(url))
    response.headers["Content-Length"].should eq(body.size.to_s)
    response.headers["Content-Type"].should eq("application/octet-stream")
    response.body.to_slice.should eq(body)
  ensure
    host.try &.disable
  end

  it "requires one exact Host on every request and one exact Origin on POST" do
    host = Host.new
    calls = 0
    url = host.enable { calls += 1; Reply.new }.not_nil!
    roundtrip(url, "GET / HTTP/1.1\r\n\r\n").status.should eq(HTTP::Status::FORBIDDEN)
    roundtrip(url, request_head(url.sub("127.0.0.1", "localhost"))).status.should eq(HTTP::Status::FORBIDDEN)
    roundtrip(url, request_head(url, extra: "Host: #{url.lchop("http://")}\r\n")).status.should eq(HTTP::Status::FORBIDDEN)
    roundtrip(url, request_head(url, "POST")).status.should eq(HTTP::Status::FORBIDDEN)
    roundtrip(url, control_head(url, origin: "http://localhost:#{URI.parse(url).port}")).status.should eq(HTTP::Status::FORBIDDEN)
    roundtrip(url, control_head(url, "Origin: #{url}\r\n")).status.should eq(HTTP::Status::FORBIDDEN)
    calls.should eq(0)
    roundtrip(url, control_head(url)).status.should eq(HTTP::Status::OK)
    calls.should eq(1)
  ensure
    host.try &.disable
  end

  it "rejects invalid framing before waiting for any body bytes" do
    host = Host.new
    calls = 0
    url = host.enable { calls += 1; Reply.new }.not_nil!
    {
      "Content-Length: 129\r\n"                             => HTTP::Status::PAYLOAD_TOO_LARGE,
      "Content-Length: 1\r\nContent-Length: 1\r\n"          => HTTP::Status::BAD_REQUEST,
      "Content-Length: 1\r\nContent-Length: 2\r\n"          => HTTP::Status::BAD_REQUEST,
      "Content-Length: invalid\r\n"                         => HTTP::Status::BAD_REQUEST,
      "Content-Length: +1\r\n"                              => HTTP::Status::BAD_REQUEST,
      "Content-Length: 18446744073709551616\r\n"            => HTTP::Status::BAD_REQUEST,
      "Transfer-Encoding: chunked\r\n"                      => HTTP::Status::BAD_REQUEST,
      "Transfer-Encoding: identity\r\n"                     => HTTP::Status::BAD_REQUEST,
      "Transfer-Encoding: chunked\r\nContent-Length: 1\r\n" => HTTP::Status::BAD_REQUEST,
      "Content-Encoding: gzip\r\nContent-Length: 64\r\n"    => HTTP::Status::BAD_REQUEST,
      "Content-Encoding: deflate\r\nContent-Length: 64\r\n" => HTTP::Status::BAD_REQUEST,
      "Expect: 100-continue\r\nContent-Length: 1\r\n"       => HTTP::Status::EXPECTATION_FAILED,
    }.each do |extra, status|
      roundtrip(url, control_head(url, extra)).status.should eq(status)
    end
    roundtrip(url, request_head(url, "PUT", extra: "Content-Length: 1\r\n")).status.should eq(HTTP::Status::METHOD_NOT_ALLOWED)
    roundtrip(url, request_head(url, extra: "Content-Length: 1\r\n")).status.should eq(HTTP::Status::BAD_REQUEST)
    calls.should eq(0)
  ensure
    host.try &.disable
  end

  it "bounds wire bytes in the request line and combined headers" do
    host = Host.new
    url = host.enable { Reply.new }.not_nil!
    roundtrip(url, "G" * 2049).status.should eq(HTTP::Status::URI_TOO_LONG)
    header = "X-A: " + "x" * 4091 + "\r\n"
    authority = url.lchop("http://")
    prefix = "GET / HTTP/1.1\r\nHost: #{authority}\r\n"
    remainder = 8193 - "Host: #{authority}\r\n".bytesize - header.bytesize
    roundtrip(url, prefix + header + "X-B: " + "x" * (remainder - 5)).status.should eq(HTTP::Status::REQUEST_HEADER_FIELDS_TOO_LARGE)
    roundtrip(url, "GET / HTTP/1.1\n\n").status.should eq(HTTP::Status::BAD_REQUEST)
  ensure
    host.try &.disable
  end

  it "lets the handler reject before reading and copies at most the validated body length" do
    host = Host.new
    url = host.enable do |request|
      if request.headers.has_key?("Authorization")
        Reply.new(body: String.new(request.body))
      else
        Reply.new(:unauthorized)
      end
    end.not_nil!
    roundtrip(url, control_head(url, "Content-Length: 128\r\n")).status.should eq(HTTP::Status::UNAUTHORIZED)
    body = "x" * 128
    response = roundtrip(url, control_head(url, "Authorization: synthetic\r\nContent-Length: 128\r\n") + body)
    response.body.should eq(body)
  ensure
    host.try &.disable
  end

  it "delivers a rejection before gracefully closing a valid unread control body" do
    host = Host.new
    entered = Channel(Nil).new(1)
    release = Channel(Nil).new
    url = host.enable do
      entered.send(nil)
      release.receive?
      Reply.new(:unauthorized, "pair first")
    end.not_nil!
    peer = connect_viewer(url)
    peer << control_head(url, "Content-Length: 128\r\n")
    await_signal(entered)
    peer << "x" * 128
    release.close
    response = HTTP::Client::Response.from_io(peer)
    response.status.should eq(HTTP::Status::UNAUTHORIZED)
    response.body.should eq("pair first")
    peer.read_byte.should be_nil
  ensure
    release.try &.close
    host.try &.disable
    peer.try &.close
  end

  it "caps accepted sockets and recovers capacity after a peer leaves" do
    host = Host.new
    url = host.enable { Reply.new(body: "ok") }.not_nil!
    generation = host.spec_generation
    peers = Array.new(8) { connect_viewer(url) }
    eventually { generation.spec_connection_count == 8 }
    extra = connect_viewer(url)
    disconnected?(extra).should be_true
    generation.spec_connection_count.should eq(8)
    peers.first.close
    eventually { generation.spec_connection_count == 7 }
    roundtrip(url, request_head(url)).body.should eq("ok")
  ensure
    host.try &.disable
    peers.try &.each(&.close)
    extra.try &.close
  end

  it "closes idle socket reads before the absolute phase deadline" do
    host = Host.new(idle_timeout: 120.milliseconds, phase_timeout: 2.seconds)
    entered = Channel(Nil).new(1)
    url = host.enable do |request|
      entered.send(nil)
      Reply.new(body: String.new(request.body))
    end.not_nil!
    generation = host.spec_generation
    idle = connect_viewer(url)
    body = connect_viewer(url)
    body << control_head(url, "Content-Length: 5\r\n") << "a"
    await_signal(entered)
    eventually(1.second) { generation.spec_connection_count == 0 }
    disconnected?(idle).should be_true
    disconnected?(body).should be_true
  ensure
    host.try &.disable
    idle.try &.close
    body.try &.close
  end

  it "expires incomplete headers even when data arrives before every idle timeout" do
    host = Host.new(idle_timeout: 160.milliseconds, phase_timeout: 290.milliseconds)
    url = host.enable { Reply.new(:internal_server_error) }.not_nil!
    peer = connect_viewer(url)
    peer << "GET / HTTP/1.1\r\nX-Trickle: "
    generation = host.spec_generation
    eventually { generation.spec_connection_count == 1 }
    done = Channel(Nil).new(1)
    spawn do
      loop do
        sleep 60.milliseconds
        peer << "a"
      end
    rescue IO::Error
    ensure
      done.send(nil)
    end
    eventually(800.milliseconds) { generation.spec_connection_count == 0 }
    disconnected?(peer).should be_true
  ensure
    host.try &.disable
    peer.try &.close
    done.try { |channel| await_signal(channel) }
  end

  it "holds the one in-flight POST slot through the response write and bounds write time" do
    host = Host.new(idle_timeout: 160.milliseconds, phase_timeout: 2.seconds)
    payload = "x" * (1024 * 1024)
    url = host.enable { Reply.new(body: payload) }.not_nil!
    generation = host.spec_generation
    peer = begin_stalled_response(url, generation, control_head(url))
    roundtrip(url, control_head(url)).status.should eq(HTTP::Status::TOO_MANY_REQUESTS)
    eventually(1.second) { generation.spec_connection_count == 0 }
  ensure
    host.try &.disable
    peer.try &.close
  end

  it "bounds response write time even when the socket timeout is longer" do
    host = Host.new(idle_timeout: 2.seconds, phase_timeout: 300.milliseconds)
    payload = "x" * (1024 * 1024)
    url = host.enable { Reply.new(body: payload) }.not_nil!
    generation = host.spec_generation
    peer = begin_stalled_response(url, generation, request_head(url))
    eventually(1.second) { generation.spec_connection_count == 0 }
  ensure
    host.try &.disable
    peer.try &.close
  end

  it "limits POST starts in a rolling second" do
    host = Host.new
    calls = 0
    url = host.enable { calls += 1; Reply.new(:no_content) }.not_nil!
    20.times { roundtrip(url, control_head(url)).status.should eq(HTTP::Status::NO_CONTENT) }
    roundtrip(url, control_head(url)).status.should eq(HTTP::Status::TOO_MANY_REQUESTS)
    calls.should eq(20)
    sleep 1.second
    roundtrip(url, control_head(url)).status.should eq(HTTP::Status::NO_CONTENT)
  ensure
    host.try &.disable
  end

  it "revokes in-flight work and closes idle and incomplete requests before re-enabling" do
    host = Host.new
    eventually { viewer_fiber_count == 0 }
    3.times do
      entered = Channel(Nil).new(1)
      release = Channel(Nil).new
      url = host.enable do |request|
        entered.send(nil)
        release.receive?
        Reply.new(body: "stale #{request.path}")
      end.not_nil!
      generation = host.spec_generation
      idle = connect_viewer(url)
      headers = connect_viewer(url)
      pull = connect_viewer(url)
      headers << "GET / HTTP/1.1\r\nHost: "
      pull << control_head(url)
      await_signal(entered)
      eventually { generation.spec_connection_count == 3 }
      started = Time.instant
      host.disable
      host.disable
      (Time.instant - started).should be < 250.milliseconds
      {idle, headers, pull}.each { |socket| disconnected?(socket).should be_true }
      expect_raises(Socket::ConnectError) { connect_viewer(url) }

      reopened = host.enable { Reply.new(body: "current") }.not_nil!
      reopened.should_not eq(url)
      release.close
      eventually { generation.spec_connection_count == 0 }
      roundtrip(reopened, control_head(url)).status.should eq(HTTP::Status::FORBIDDEN)
      roundtrip(reopened, control_head(reopened)).body.should eq("current")
      host.disable
      eventually { viewer_fiber_count == 0 }
    ensure
      host.disable
      release.try &.close
      idle.try &.close
      headers.try &.close
      pull.try &.close
    end
  end

  it "closes a socket with a response stalled on a non-reading peer" do
    host = Host.new(idle_timeout: 5.seconds, phase_timeout: 5.seconds)
    payload = "x" * (1024 * 1024)
    url = host.enable { Reply.new(body: payload) }.not_nil!
    generation = host.spec_generation
    peer = begin_stalled_response(url, generation, request_head(url))
    started = Time.instant
    host.disable
    (Time.instant - started).should be < 250.milliseconds
    eventually(1.second) { generation.spec_connection_count == 0 }
  ensure
    host.try &.disable
    peer.try &.close
  end
end
