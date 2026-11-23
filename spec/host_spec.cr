require "spec"
require "http/client"
require "pretty_print"
require "rosegold/26.3"
require "../src/rosegold-viewer"

private class HostSpecClient < Rosegold::Client
  def initialize
    super("127.0.0.1")
    @connection = Rosegold::Connection::Client.new(Minecraft::IO::Memory.new, Rosegold::ProtocolState::PLAY, 777_u32, self)
    set_protocol_state(Rosegold::ProtocolState::PLAY)
    physics.unpause_for_spawn_chunk
    player.feet = Rosegold::Vec3d.new(0, 0, 0)
  end

  def handler_count : Int32
    event_handlers.values.sum(&.size)
  end

  def resume_physics : Nil
    physics.unpause_for_spawn_chunk
  end
end

private def viewer_post(pairing, path, token, body = "", content_type = "application/json", origin = pairing.url)
  HTTP::Client.post(pairing.url + path, headers: HTTP::Headers{
    "Origin"        => origin,
    "Authorization" => "Bearer #{token}",
    "Content-Type"  => content_type,
  }, body: body)
end

private def viewer_pair(pairing) : String
  reply = viewer_post(pairing, "/session", pairing.secret)
  reply.status.should eq(HTTP::Status::OK)
  reply.headers["Content-Type"].should eq("application/json")
  JSON.parse(reply.body)["lease"].as_s
end

private def viewer_frame(reply : HTTP::Client::Response) : JSON::Any
  reply.status.should eq(HTTP::Status::OK)
  reply.headers["Content-Type"].should eq("application/octet-stream")
  reply.body.bytesize.should be <= 16 * 1024
  io = IO::Memory.new(reply.body.to_slice)
  size = io.read_bytes(UInt16, IO::ByteFormat::LittleEndian)
  JSON.parse(io.read_string(size))
end

private def viewer_socket_closed?(socket : TCPSocket) : Bool
  socket.read_byte.nil?
rescue IO::TimeoutError
  false
rescue IO::Error
  true
end

describe RosegoldViewer::Host do
  it "embeds only the fixed asset routes and sends restrictive headers" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    pairing.url.should start_with("http://127.0.0.1:")
    pairing.secret.should match(/\A[0-9a-f]{64}\z/)
    {pairing.inspect, pairing.to_s, pairing.pretty_inspect}.each do |display|
      display.should contain(pairing.url)
      display.should_not contain(pairing.secret)
    end
    host.enable.should eq(pairing)

    {"/" => "text/html", "/viewer-bundle.js" => "text/javascript", "/viewer.css" => "text/css"}.each do |path, mime|
      reply = HTTP::Client.get(pairing.url + path)
      reply.status.should eq(HTTP::Status::OK)
      reply.headers["Content-Type"].should start_with(mime)
      reply.headers["Cache-Control"].should eq("no-store")
      reply.headers["X-Content-Type-Options"].should eq("nosniff")
      reply.headers["Content-Security-Policy"].should contain("frame-ancestors 'none'")
      reply.headers.has_key?("Access-Control-Allow-Origin").should be_false
      reply.body.should_not contain(pairing.secret)
    end

    ["/?x=1", "/viewer-bundle.js?x=1", "/%76iewer.css", "/fixture.html"].each do |path|
      HTTP::Client.get(pairing.url + path).status.should eq(HTTP::Status::NOT_FOUND)
    end
  ensure
    host.try &.disable
  end

  it "keeps the pairing secret and active lease out of host displays" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    lease = viewer_pair(pairing)
    {host.inspect, host.pretty_inspect, host.to_s}.each do |display|
      display.includes?(pairing.secret).should be_false
      display.includes?(lease).should be_false
    end
  ensure
    host.try &.disable
  end

  it "streams a bound bot's terrain and removes its hooks on expiration and repeated disables" do
    client = HostSpecClient.new
    bot = Rosegold::Bot.new(client)
    world = bot.world
    sections = Minecraft::IO::Memory.new
    (world.world_height >> 4).times { Rosegold::Section.empty.write(sections) }
    world.load_chunk(Rosegold::Chunk.new(0, 0, Minecraft::IO::Memory.new(sections.to_slice), world))
    stone = Rosegold::MCData.for(777_u32).blocks.find! { |block| block.id_str == "stone" }.min_state_id
    world.set_block_state(1, 2, 3, stone)
    baseline = client.handler_count
    host = RosegoldViewer::Host.new(lease_timeout: 500.milliseconds)
    host.bind(bot)
    pairing = host.enable.not_nil!
    HTTP::Client.get(pairing.url).status.should eq(HTTP::Status::OK)
    client.handler_count.should eq(baseline)

    lease = viewer_pair(pairing)
    attached = client.handler_count
    attached.should be > baseline
    reply = viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0}))
    frame = viewer_frame(reply)
    frame["status"].as_s.should eq("ready")
    frame["section"]["position"].as_a.map(&.as_i).should eq([0, 0, 0])
    frame["section"]["kind"].as_s.should eq("states")
    bytes = reply.body.to_slice
    header_size = IO::ByteFormat::LittleEndian.decode(UInt16, bytes[0, 2]).to_i
    states = bytes[2 + header_size..]
    states.size.should eq(8192)
    index = 1 + 16 * 3 + 256 * 2
    IO::ByteFormat::LittleEndian.decode(UInt16, states[index * 2, 2]).should eq(stone)

    deadline = Time.instant + 2.seconds
    until client.handler_count == baseline || Time.instant >= deadline
      sleep 5.milliseconds
    end
    client.handler_count.should eq(baseline)
    host.disable
    3.times do
      pairing = host.enable.not_nil!
      client.handler_count.should eq(baseline)
      viewer_pair(pairing)
      client.handler_count.should eq(attached)
      host.disable
      client.handler_count.should eq(baseline)
    end
  ensure
    host.try &.disable
    client.try(&.connection?).try &.disconnect("End of viewer host spec")
  end

  it "keeps headless paths across leasing, then drops them on same-name respawn or disable" do
    client = HostSpecClient.new
    bot = Rosegold::Bot.new(client)
    host = RosegoldViewer::Host.new(lease_timeout: 500.milliseconds)
    host.bind(bot)
    baseline = client.handler_count
    terrain_hooks = client.event_handlers[Rosegold::Clientbound::ChunkData]?.try(&.size) || 0
    point = [Rosegold::Vec3i.new(1, 2, 3)]
    host.draw_path("stop", point).should be_true
    headless = client.handler_count
    headless.should be > baseline
    (client.event_handlers[Rosegold::Clientbound::ChunkData]?.try(&.size) || 0).should eq(terrain_hooks)

    pairing = host.enable.not_nil!
    client.handler_count.should eq(headless)
    lease = viewer_pair(pairing)
    zero = %({"epoch":0,"seq":0})
    first = viewer_frame(viewer_post(pairing, "/next", lease, zero))
    first["paths"].should eq(JSON.parse(%([{"name":"stop","color":3794175,"points":[[256,512,768]]}])))
    lost = viewer_frame(viewer_post(pairing, "/next", lease, zero))
    lost["epoch"].should_not eq(first["epoch"])
    lost["paths"].should eq(first["paths"])

    deadline = Time.instant + 2.seconds
    until client.handler_count == headless || Time.instant >= deadline
      sleep 5.milliseconds
    end
    client.handler_count.should eq(headless)
    viewer_post(pairing, "/next", lease, zero).status.should eq(HTTP::Status::UNAUTHORIZED)
    lease = viewer_pair(pairing)
    viewer_frame(viewer_post(pairing, "/next", lease, zero))["paths"].should eq(first["paths"])

    deadline = Time.instant + 2.seconds
    until client.handler_count == headless || Time.instant >= deadline
      sleep 5.milliseconds
    end
    client.handler_count.should eq(headless)
    respawn = Rosegold::Clientbound::Respawn.new(
      0_u32, "minecraft:overworld", 0_i64, 0_u8, -1_i8,
      false, false, false, nil, nil, 0_u32, 63_u32, 0_u8
    )
    respawn.callback(client)
    client.emit_event(respawn)
    client.handler_count.should eq(baseline)
    host.draw_path("stop", point).should be_false
    client.resume_physics
    lease = viewer_pair(pairing)
    viewer_frame(viewer_post(pairing, "/next", lease, zero))["paths"].as_a.should be_empty

    host.draw_path("stop", point).should be_true
    host.disable
    client.handler_count.should eq(baseline)
    host.draw_path("stop", point).should be_true
    host.clear_path("stop")
    client.handler_count.should eq(baseline)
    host.draw_path("stop", point).should be_true
    host.disable
    client.handler_count.should eq(baseline)
    pairing = host.enable.not_nil!
    lease = viewer_pair(pairing)
    viewer_frame(viewer_post(pairing, "/next", lease, zero))["paths"].as_a.should be_empty
  ensure
    host.try &.disable
    client.try(&.connection?).try &.disconnect("End of viewer host spec")
  end

  it "requires separate pairing and lease tokens and replaces the previous lease" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    viewer_post(pairing, "/session", "wrong").status.should eq(HTTP::Status::UNAUTHORIZED)
    viewer_post(pairing, "/session", pairing.secret, origin: "http://localhost").status.should eq(HTTP::Status::FORBIDDEN)
    viewer_post(pairing, "/session", pairing.secret, "x").status.should eq(HTTP::Status::BAD_REQUEST)
    viewer_post(pairing, "/next", pairing.secret, %({"epoch":0,"seq":0})).status.should eq(HTTP::Status::UNAUTHORIZED)
    lease = viewer_pair(pairing)
    lease.should match(/\A[0-9a-f]{64}\z/)
    viewer_post(pairing, "/session", lease).status.should eq(HTTP::Status::UNAUTHORIZED)
    replacement = viewer_pair(pairing)
    replacement.should_not eq(lease)
    viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})).status.should eq(HTTP::Status::UNAUTHORIZED)
    viewer_frame(viewer_post(pairing, "/next", replacement, %({"epoch":0,"seq":0})))["status"].as_s.should eq("waiting")
  ensure
    host.try &.disable
  end

  it "validates the complete cursor and sends a fresh baseline after a lost response" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    lease = viewer_pair(pairing)
    ["", "[]", %({"seq":0}), %({"epoch":0,"seq":0,"extra":0}), %({"epoch":0,"epoch":0,"seq":0}),
     %({"epoch":0,"seq":0}[]), %({"epoch":0,"seq":-1}), %({"epoch":4294967296,"seq":0}),
     %({"epoch":184467440737095516161,"seq":0}), %({"epoch":0.0,"seq":0})].each do |invalid|
      viewer_post(pairing, "/next", lease, invalid).status.should eq(HTTP::Status::BAD_REQUEST)
    end
    viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0}), "text/plain").status.should eq(HTTP::Status::UNSUPPORTED_MEDIA_TYPE)
    first = viewer_frame(viewer_post(pairing, "/next", lease, %({"seq":0,"epoch":0})))
    cursor = {epoch: first["epoch"].as_i, seq: first["seq"].as_i}.to_json
    viewer_post(pairing, "/next", lease, cursor).status.should eq(HTTP::Status::NO_CONTENT)
    reset = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
    reset["epoch"].should_not eq(first["epoch"])
    reset["seq"].as_i.should eq(1)
  ensure
    host.try &.disable
  end

  it "rejects an unauthorized request without waiting for its body" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    url = URI.parse(pairing.url)
    socket = TCPSocket.new("127.0.0.1", url.port.not_nil!)
    socket.read_timeout = 500.milliseconds
    socket << "POST /session HTTP/1.1\r\nHost: #{url.authority}\r\nOrigin: #{pairing.url}\r\nContent-Length: 1\r\n\r\n"
    HTTP::Client::Response.from_io(socket).status.should eq(HTTP::Status::UNAUTHORIZED)
  ensure
    socket.try &.close
    host.try &.disable
  end

  it "rechecks the lease when a body arrives after expiry" do
    host = RosegoldViewer::Host.new(lease_timeout: 250.milliseconds)
    pairing = host.enable.not_nil!
    lease = viewer_pair(pairing)
    url = URI.parse(pairing.url)
    socket = TCPSocket.new("127.0.0.1", url.port.not_nil!)
    socket.read_timeout = 500.milliseconds
    body = %({"epoch":0,"seq":0})
    socket << "POST /next HTTP/1.1\r\nHost: #{url.authority}\r\nOrigin: #{pairing.url}\r\nAuthorization: Bearer #{lease}\r\nContent-Type: application/json\r\nContent-Length: #{body.bytesize}\r\n\r\n"
    sleep 300.milliseconds
    socket << body
    HTTP::Client::Response.from_io(socket).status.should eq(HTTP::Status::UNAUTHORIZED)
    viewer_pair(pairing).should_not eq(lease)
  ensure
    socket.try &.close
    host.try &.disable
  end

  it "revokes pairing and active sockets on disable and starts a fresh generation" do
    host = RosegoldViewer::Host.new
    first = host.enable.not_nil!
    lease = viewer_pair(first)
    url = URI.parse(first.url)
    socket = TCPSocket.new("127.0.0.1", url.port.not_nil!)
    socket.read_timeout = 500.milliseconds
    socket << "POST /next HTTP/1.1\r\nHost: #{url.authority}\r\nOrigin: #{first.url}\r\nAuthorization: Bearer #{lease}\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n"
    Fiber.yield
    host.disable
    host.disable
    viewer_socket_closed?(socket).should be_true

    next_pairing = host.enable.not_nil!
    next_pairing.url.should_not eq(first.url)
    next_pairing.secret.should_not eq(first.secret)
    viewer_post(next_pairing, "/session", first.secret).status.should eq(HTTP::Status::UNAUTHORIZED)
    viewer_post(next_pairing, "/next", lease, %({"epoch":0,"seq":0})).status.should eq(HTTP::Status::UNAUTHORIZED)
  ensure
    socket.try &.close
    host.try &.disable
  end
end
