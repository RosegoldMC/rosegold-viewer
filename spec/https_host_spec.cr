require "spec"
require "http/client"
require "rosegold/26.3"
require "../src/rosegold-viewer"

private def viewer_https_port : Int32
  TCPServer.open("127.0.0.1", 0) { |probe| probe.local_address.port }
end

private def viewer_https_connect(config : RosegoldViewer::HTTPS) : TCPSocket
  TCPSocket.new(config.bind_address, config.port, connect_timeout: 1.second).tap do |socket|
    socket.read_timeout = 2.seconds
    socket.write_timeout = 2.seconds
  end
end

private def viewer_https_request(config, context, method, path, extra = "", body = "", host = config.authority)
  socket = viewer_https_connect(config)
  OpenSSL::SSL::Socket::Client.open(socket, context, sync_close: true, hostname: "viewer.test") do |secure|
    secure << "#{method} #{path} HTTP/1.1\r\nHost: #{host}\r\nContent-Length: #{body.bytesize}\r\n#{extra}\r\n#{body}"
    secure.flush
    HTTP::Client::Response.from_io(secure)
  end
ensure
  socket.try &.close
end

private def viewer_https_close_reply(socket : TCPSocket) : Bytes
  reply = IO::Memory.new
  buffer = Bytes.new(64)
  deadline = Time.instant + 2.seconds
  loop do
    remaining = deadline - Time.instant
    fail "Viewer HTTPS connection stayed open" unless remaining.positive?
    socket.read_timeout = remaining
    count = socket.read(buffer)
    return reply.to_slice if count.zero?
    reply.write(buffer[0, count])
  end
rescue IO::TimeoutError
  fail "Viewer HTTPS connection stayed open"
rescue IO::Error
  reply.try(&.to_slice) || Bytes.empty
end

# OpenSSL rejects a plaintext request with one fatal alert record or none, depending on version.
private def viewer_tls_fatal_alert?(reply : Bytes) : Bool
  reply.size == 7 && reply[0] == 0x15 && reply[1] == 0x03 && reply[3] == 0x00 && reply[4] == 0x02 && reply[5] == 0x02
end

private def with_viewer_certificate(&)
  cert = File.tempfile("viewer-test-cert", ".pem")
  cert.close
  key = File.tempfile("viewer-test-key", ".pem")
  key.close
  Process.run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=viewer.test",
                          "-addext", "subjectAltName=DNS:viewer.test", "-out", cert.path, "-keyout", key.path], error: Process::Redirect::Close).success?.should be_true
  yield cert.path, key.path
ensure
  cert.try &.delete
  key.try &.delete
end

describe RosegoldViewer::HTTPS do
  it "requires a canonical HTTPS origin and a specific private IPv4 bind address" do
    ["http://viewer.test:8443", "https://VIEWER.test:8443", "https://viewer.test.", "https://viewer.test:443",
     "https://viewer.test:08443", "https://viewer.test:65536", "https://viewer.test:0", "https://viewer.test/",
     "https://user@viewer.test", "https://viewer.test?x=1", "https://viewer.test#x", "https://127.1", "https://0x7f000001"].each do |origin|
      expect_raises(ArgumentError) do
        RosegoldViewer::HTTPS.new(bind_address: "127.0.0.1", origin: origin, certificate_chain: "unused", private_key: "unused")
      end
    end
    ["0.0.0.0", "::", "localhost", "8.8.8.8", "172.32.0.5", "100.128.0.5"].each do |address|
      expect_raises(ArgumentError) do
        RosegoldViewer::HTTPS.new(bind_address: address, origin: "https://viewer.test", certificate_chain: "unused", private_key: "unused")
      end
    end
    config = RosegoldViewer::HTTPS.new(bind_address: "100.64.0.10", origin: "https://viewer.test", certificate_chain: "unused", private_key: "unused")
    config.port.should eq(443)
    config.authority.should eq("viewer.test")
  end

  it "does not open a plaintext fallback when TLS credentials cannot load" do
    config = RosegoldViewer::HTTPS.new(bind_address: "127.0.0.1", origin: "https://viewer.test:#{viewer_https_port}", certificate_chain: "", private_key: "")
    host = RosegoldViewer::Host.new(https: config)
    host.enable.should be_nil
    expect_raises(Socket::ConnectError) { viewer_https_connect(config) }
  ensure
    host.try &.disable
  end

  it "serves a verified TLS origin with the existing pairing and single-lease rules" do
    with_viewer_certificate do |cert, key|
      origin = "https://viewer.test:#{viewer_https_port}"
      config = RosegoldViewer::HTTPS.new(bind_address: "127.0.0.1", origin: origin, certificate_chain: cert, private_key: key)
      host = RosegoldViewer::Host.new(https: config)
      pairing = host.enable.not_nil!
      pairing.url.should eq(origin)
      pairing.url.should_not contain(pairing.secret)
      pairing.secret.should match(/\A[0-9a-f]{64}\z/)

      untrusted = viewer_https_connect(config)
      expect_raises(OpenSSL::SSL::Error) do
        OpenSSL::SSL::Socket::Client.new(untrusted, hostname: "viewer.test")
      end
      untrusted.close
      trust = OpenSSL::SSL::Context::Client.new
      trust.ca_certificates = cert
      wrong_name = viewer_https_connect(config)
      expect_raises(OpenSSL::SSL::Error) do
        OpenSSL::SSL::Socket::Client.new(wrong_name, trust, hostname: "wrong.test")
      end
      wrong_name.close

      headers = "Origin: #{origin}\r\nAuthorization: Bearer #{pairing.secret}\r\n"
      plaintext = nil
      ["GET /", "POST /session"].each do |target|
        plaintext = socket = viewer_https_connect(config)
        socket << "#{target} HTTP/1.1\r\nHost: #{config.authority}\r\n#{headers}\r\n"
        reply = viewer_https_close_reply(socket)
        fail "Plaintext #{target} received #{reply[0, Math.min(reply.size, 16)].hexstring}" unless reply.empty? || viewer_tls_fatal_alert?(reply)
        socket.close
      end
      asset = viewer_https_request(config, trust, "GET", "/")
      asset.status.should eq(HTTP::Status::OK)
      asset.body.should_not contain(pairing.secret)
      asset.headers.has_key?("Access-Control-Allow-Origin").should be_false
      viewer_https_request(config, trust, "GET", "/", "Origin: https://wrong.test\r\n").status.should eq(HTTP::Status::FORBIDDEN)
      viewer_https_request(config, trust, "POST", "/session", headers + "X-Forwarded-Host: #{config.authority}\r\n", host: "wrong.test").status.should eq(HTTP::Status::FORBIDDEN)
      viewer_https_request(config, trust, "POST", "/session", headers + "Host: #{config.authority}\r\n").status.should eq(HTTP::Status::FORBIDDEN)
      viewer_https_request(config, trust, "POST", "/session", headers + "Origin: #{origin}\r\n").status.should eq(HTTP::Status::FORBIDDEN)
      viewer_https_request(config, trust, "POST", "/session", headers.sub("https:", "http:") + "X-Forwarded-Proto: https\r\n").status.should eq(HTTP::Status::FORBIDDEN)
      viewer_https_request(config, trust, "POST", "/session", "Authorization: Bearer #{pairing.secret}\r\n").status.should eq(HTTP::Status::FORBIDDEN)
      viewer_https_request(config, trust, "POST", "/session", "Origin: #{origin}\r\n").status.should eq(HTTP::Status::UNAUTHORIZED)

      first = viewer_https_request(config, trust, "POST", "/session", headers)
      first.status.should eq(HTTP::Status::OK)
      first_lease = JSON.parse(first.body)["lease"].as_s
      second = viewer_https_request(config, trust, "POST", "/session", headers)
      second.status.should eq(HTTP::Status::OK)
      next_lease = JSON.parse(second.body)["lease"].as_s
      next_lease.should_not eq(first_lease)
      pull_headers = "Origin: #{origin}\r\nContent-Type: application/json\r\nAuthorization: Bearer "
      cursor = %({"epoch":0,"seq":0})
      viewer_https_request(config, trust, "POST", "/next", "#{pull_headers}#{first_lease}\r\n", cursor).status.should eq(HTTP::Status::UNAUTHORIZED)
      viewer_https_request(config, trust, "POST", "/next", "#{pull_headers}#{next_lease}\r\n", cursor).status.should eq(HTTP::Status::OK)
      viewer_https_request(config, trust, "POST", "/chat", "#{pull_headers}#{first_lease}\r\n", "{}").status.should eq(HTTP::Status::UNAUTHORIZED)

      stalled = viewer_https_connect(config)
      Fiber.yield
      host.disable
      viewer_https_close_reply(stalled).should be_empty
      expect_raises(Socket::ConnectError) { viewer_https_connect(config) }
      reopened = host.enable.not_nil!
      reopened.url.should eq(origin)
      reopened.secret.should_not eq(pairing.secret)
      viewer_https_request(config, trust, "POST", "/session", headers).status.should eq(HTTP::Status::UNAUTHORIZED)
      viewer_https_request(config, trust, "POST", "/next", "#{pull_headers}#{next_lease}\r\n", cursor).status.should eq(HTTP::Status::UNAUTHORIZED)
    ensure
      host.try &.disable
      untrusted.try &.close
      wrong_name.try &.close
      plaintext.try &.close
      stalled.try &.close
    end
  end
end
