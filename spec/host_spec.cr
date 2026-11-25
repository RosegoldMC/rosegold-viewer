require "spec"
require "http/client"
require "pretty_print"
require "rosegold/26.3"
require "../src/rosegold-viewer"

# Container clicks and closes need the core's guarded inventory writes; older pins must fail closed instead.
macro guarded_it(name, &block)
  {% if Rosegold::Menu.has_method?(:send_click_if!) && Rosegold::ContainerMenu.has_method?(:close_if!) %}
    it({{name}}) {{block}}
  {% else %}
    pending({{name}}) { }
  {% end %}
end

private class HostSpecSink < Minecraft::IO::Memory
  CLICK_ID = Rosegold::Serverbound::ClickWindow.packet_id_for_protocol(777_u32)
  CLOSE_ID = Rosegold::Serverbound::CloseWindow.packet_id_for_protocol(777_u32)

  getter click_windows = [] of UInt32
  getter closed_windows = [] of UInt16
  property fail_click = false
  property fail_close = false
  property after_click_write : Proc(Nil)?

  # The frame is decoded from the bytes the real transport wrote, then the injected outcome applies.
  def flush : Nil
    frame = Minecraft::IO::Memory.new(to_slice.dup)
    clear
    frame.read_fully(bytes = Bytes.new(frame.read_var_int))
    packet = Minecraft::IO::Memory.new(bytes)
    case packet.read_var_int
    when CLICK_ID
      click_windows << packet.read_var_int
      after_click_write.try &.call
      raise IO::Error.new("Click write failed") if fail_click
    when CLOSE_ID
      closed_windows << packet.read_var_int.to_u16
      raise IO::Error.new("Close write failed") if fail_close
    end
  end
end

# The core applies a click and retires a menu only after the frame is written; raising there is its non-disconnecting failure path.
# Click snapshots are copies, so the click fails only on the live menu.
private class HostSpecPlayerMenu < Rosegold::PlayerMenu
  property? fail_commit = false

  def []=(index : Int32, slot : Rosegold::Slot)
    raise IO::Error.new("Click commit failed") if fail_commit? && @client.container_menu.same?(self)
    super
  end
end

private class HostSpecChest < Rosegold::ChestMenu
  property? fail_commit = false

  def handle_close
    raise IO::Error.new("Close commit failed") if fail_commit?
    super
  end
end

private class HostSpecClient < Rosegold::Client
  getter sink = HostSpecSink.new

  def click_sends : Int32
    sink.click_windows.size
  end

  def closed_windows : Array(UInt16)
    sink.closed_windows
  end

  def close_sends : Int32
    closed_windows.size
  end

  def fail_click_commit=(value : Bool)
    @inventory_menu.as(HostSpecPlayerMenu).fail_commit = value
  end

  def fail_click=(value : Bool)
    sink.fail_click = value
  end

  def fail_close=(value : Bool)
    sink.fail_close = value
  end

  def after_click_write=(hook : Proc(Nil))
    sink.after_click_write = hook
  end

  def initialize
    super("127.0.0.1")
    @connection = Rosegold::Connection::Client.new(sink, Rosegold::ProtocolState::PLAY, 777_u32, self)
    @inventory_menu = HostSpecPlayerMenu.new(self)
    @container_menu = @inventory_menu
    set_protocol_state(Rosegold::ProtocolState::PLAY)
    physics.unpause_for_spawn_chunk
    player.feet = Rosegold::Vec3d.new(0, 0, 0)
  end

  def handler_count : Int32
    event_handlers.values.sum(&.size)
  end

  def pause_physics : Nil
    physics.pause
  end

  def forward_pressed? : Bool
    physics.keys.forward?
  end

  def sprint_requested? : Bool
    physics.@sprint_requested
  end

  def resume_physics : Nil
    physics.unpause_for_spawn_chunk
  end

  def viewer_tick : Nil
    {% if Rosegold::Client.has_method?(:manual_control) %}
      manual_control.before_tick
      manual_control.after_tick
    {% end %}
    emit_event Rosegold::Event::Tick.new
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

private def viewer_pull(pairing, lease, frame : JSON::Any, input = nil) : HTTP::Client::Response
  epoch = frame["epoch"].as_i64
  sequence = frame["seq"].as_i64
  body = input ? {epoch: epoch, seq: sequence, i: input}.to_json : {epoch: epoch, seq: sequence}.to_json
  viewer_post(pairing, "/next", lease, body)
end

private def viewer_menu_content(client : HostSpecClient, menu : Rosegold::Menu, state_id : UInt32 = 0_u32) : Nil
  event = Rosegold::Clientbound::SetContainerContent.new(menu.id.to_u32, state_id, menu.slots, Rosegold::WindowSlot.new(-1, menu.cursor))
  event.callback(client)
  client.emit_event(event)
end

private def hold_viewer_writer(client : HostSpecClient) : Channel(Nil)
  release = Channel(Nil).new
  held = Channel(Nil).new
  connection = client.connection
  spawn do
    connection.send_packet(-> { held.send(nil); release.receive; Bytes.new(1) }, -> { }, -> { true })
  end
  held.receive
  release
end

private def viewer_tick_behind_writer(client : HostSpecClient) : Channel(Nil)
  done = Channel(Nil).new(1)
  spawn do
    client.viewer_tick
  ensure
    done.send(nil)
  end
  100.times do
    break if client.connection.@writers.get > 1
    Fiber.yield
  end
  client.connection.@writers.get.should be > 1
  done
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

  it "keeps an ungranted viewer read-only even when it sends well-formed input" do
    client = HostSpecClient.new
    bot = Rosegold::Bot.new(client)
    host = RosegoldViewer::Host.new
    host.bind(bot)
    pairing = host.enable.not_nil!
    lease = viewer_pair(pairing)
    first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
    first["status"].as_s.should eq("ready")
    first["control"]?.should be_nil
    original_look = bot.look

    sleep 55.milliseconds
    response = viewer_pull(pairing, lease, first, [1, 1, 1, 255, 9000, 9000, 7, 8])
    viewer_frame(response)["control"]?.should be_nil
    bot.look.should eq(original_look)
    bot.hotbar_selection.should eq(1)
  ensure
    host.try &.disable
    client.try(&.connection?).try &.disconnect("End of viewer host spec")
  end

  {% if Rosegold::Client.has_method?(:manual_control) %}
    it "applies each input once, neutralizes expired frames, and ignores old grants after re-pairing" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      bot.manual_control = true
      lease = viewer_pair(pairing)
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      first["control"]["mode"].as_s.should eq("available")

      premature = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 1, 0, 1200, 0, 0, -1]))
      premature["control"]["mode"].as_s.should eq("available")
      ready = viewer_frame(viewer_pull(pairing, lease, premature, [grant, 2, 1, 0, 0, 0, 0, -1]))
      ready["control"]["mode"].as_s.should eq("play")
      original = bot.look.yaw
      play = [grant, 3, 1, 0, 1200, 0, 0, -1]
      active = viewer_frame(viewer_pull(pairing, lease, ready, play))
      viewer_pull(pairing, lease, active, play).status.in?(HTTP::Status::OK, HTTP::Status::NO_CONTENT).should be_true
      client.viewer_tick
      bot.look.yaw.should eq(Rosegold::Look.wrap_yaw(original + 12_f32))
      client.viewer_tick
      bot.look.yaw.should eq(Rosegold::Look.wrap_yaw(original + 12_f32))

      active = viewer_frame(viewer_pull(pairing, lease, active, [grant, 4, 1, 0, 1200, 0, 0, -1]))
      6.times do
        sleep 55.milliseconds
        active = viewer_frame(viewer_pull(pairing, lease, active))
      end
      client.viewer_tick
      bot.look.yaw.should eq(Rosegold::Look.wrap_yaw(original + 12_f32))
      bot.manual_control?.should be_true

      new_lease = viewer_pair(pairing)
      bot.manual_control?.should be_false
      viewer_pull(pairing, lease, active, play).status.should eq(HTTP::Status::UNAUTHORIZED)
      client.viewer_tick
      bot.manual_control = true
      current = viewer_frame(viewer_post(pairing, "/next", new_lease, %({"epoch":0,"seq":0})))
      current["control"]["grant"].as_i.should_not eq(grant)
      rejected = viewer_pull(pairing, new_lease, current, play)
      rejected.status.in?(HTTP::Status::OK, HTTP::Status::NO_CONTENT).should be_true
      client.viewer_tick
      bot.look.yaw.should eq(Rosegold::Look.wrap_yaw(original + 12_f32))
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "keeps a queued return through a pause heartbeat until the next native tick" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      bot.manual_control = true
      lease = viewer_pair(pairing)
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = frame["control"]["grant"].as_i
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 1, 1, 0, 0, 0, 0, -1]))
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 2, 5]))
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 3, 0]))
      bot.manual_control?.should be_true
      client.viewer_tick
      bot.manual_control?.should be_false
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "rechecks the server cursor before returning control on the native tick" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = frame["control"]["grant"].as_i
      frame["control"]["canReturn"].as_bool.should be_true
      queued = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 1, 5]))
      stone = Rosegold::MCData.for(777_u32).items.find!(&.name.==("stone"))
      Rosegold::Clientbound::SetCursorItem.new(Rosegold::Slot.new(3_u32, stone.id)).callback(client)
      client.viewer_tick
      bot.manual_control?.should be_true
      blocked = viewer_frame(viewer_pull(pairing, lease, queued, [grant, 2, 0]))
      blocked["control"]["canReturn"].as_bool.should be_false

      Rosegold::Clientbound::SetCursorItem.new(Rosegold::Slot.new).callback(client)
      settled = viewer_frame(viewer_pull(pairing, lease, blocked))
      settled["control"]["canReturn"].as_bool.should be_true
      viewer_frame(viewer_pull(pairing, lease, settled, [grant, 3, 5]))
      client.viewer_tick
      bot.manual_control?.should be_false
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "maps the sprint bit to native sprint and rejects keys beyond it" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = frame["control"]["grant"].as_i
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 1, 1, 0, 0, 0, 0, -1]))
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 2, 1, 257, 0, 0, 0, -1]))
      client.viewer_tick
      client.forward_pressed?.should be_true
      client.sprint_requested?.should be_true
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 3, 1, 1, 0, 0, 0, -1]))
      client.viewer_tick
      client.sprint_requested?.should be_false
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 4, 1, 273, 0, 0, 0, -1]))
      client.viewer_tick
      client.sprint_requested?.should be_false
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 5, 1, 511, 0, 0, 0, -1]))
      client.viewer_tick
      client.sprint_requested?.should be_false
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 6, 1, 495, 0, 0, 0, -1]))
      client.viewer_tick
      client.sprint_requested?.should be_true
      viewer_pull(pairing, lease, frame, [grant, 7, 1, 512, 0, 0, 0, -1]).status.should eq(HTTP::Status::BAD_REQUEST)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "keeps a parked intervention through a waiting pull but cancels it on respawn" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      gate = Channel(Nil).new
      resumed = Channel(Nil).new(1)
      spawn do
        client.intervention.register_owner
        gate.receive
        client.intervention.checkpoint
        resumed.send(nil)
      end
      Fiber.yield
      client.intervention.permitted = true
      initial = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = initial["control"]["grant"].as_i
      takeover = viewer_frame(viewer_pull(pairing, lease, initial, [grant, 1, 6]))
      native_id = client.manual_control.grant_id.not_nil!
      gate.send(nil)
      Fiber.yield
      play = viewer_frame(viewer_pull(pairing, lease, takeover, [grant, 2, 1, 0, 0, 0, 0, -1]))
      play["control"]["checkpoint"].as_s.should eq("parked")
      play = viewer_frame(viewer_pull(pairing, lease, play, [grant, 3, 1, 1, 1200, 0, 0, -1]))
      original = bot.look.yaw
      client.pause_physics
      waiting = viewer_frame(viewer_pull(pairing, lease, play, [grant, 4, 1, 1, 1200, 0, 0, -1]))
      waiting["status"].as_s.should eq("waiting")
      client.manual_control.grant_id.should eq(native_id)
      client.intervention.parked?.should be_true
      client.viewer_tick
      bot.look.yaw.should eq(original)
      client.forward_pressed?.should be_false

      client.resume_physics
      recovered = viewer_frame(viewer_pull(pairing, lease, waiting))
      recovered["control"]["mode"].as_s.should eq("pause")
      recovered["control"]["checkpoint"].as_s.should eq("parked")
      recovered["control"]["marker"].should eq(takeover["control"]["marker"])
      recovered["control"]["grant"].as_i.should_not eq(grant)
      client.manual_control.grant_id.should eq(native_id)

      respawn = Rosegold::Clientbound::Respawn.new(
        0_u32, "minecraft:overworld", 0_i64, 0_u8, -1_i8,
        false, false, false, nil, nil, 0_u32, 63_u32, 0_u8
      )
      respawn.callback(client)
      client.emit_event(respawn)
      bot.manual_control?.should be_false
      client.intervention.last_cancellation.not_nil!.reason.session_changed?.should be_true
      select
      when resumed.receive
      when timeout(1.second)
        fail "Respawn did not release the parked script"
      end
    ensure
      host.try &.disable
      gate.try &.close
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "preserves native input sequencing across a tick-only pause" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      native_id = client.manual_control.grant_id.not_nil!
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      old_grant = frame["control"]["grant"].as_i
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [old_grant, 1, 1, 0, 0, 0, 0, -1]))
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [old_grant, 2, 1, 1, 0, 0, 0, -1]))
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [old_grant, 3, 1, 1, 0, 0, 0, -1]))
      client.viewer_tick
      client.forward_pressed?.should be_true
      original = bot.look.yaw

      client.pause_physics
      client.viewer_tick
      client.forward_pressed?.should be_false
      client.resume_physics
      recovered = viewer_frame(viewer_pull(pairing, lease, frame, [old_grant, 4, 1, 1, 1200, 0, 0, -1]))
      new_grant = recovered["control"]["grant"].as_i
      new_grant.should_not eq(old_grant)
      recovered["control"]["mode"].as_s.should eq("pause")
      client.viewer_tick
      client.forward_pressed?.should be_false
      bot.look.yaw.should eq(original)
      client.manual_control.grant_id.should eq(native_id)

      frame = viewer_frame(viewer_pull(pairing, lease, recovered, [new_grant, 1, 1, 0, 0, 0, 0, -1]))
      viewer_frame(viewer_pull(pairing, lease, frame, [new_grant, 2, 1, 1, 1200, 0, 0, -1]))
      client.viewer_tick
      bot.look.yaw.should eq(Rosegold::Look.wrap_yaw(original + 12_f32))
      client.forward_pressed?.should be_true
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "discards queued gameplay when a teleport pauses into an unloaded chunk" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = frame["control"]["grant"].as_i
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 1, 1, 0, 0, 0, 0, -1]))
      viewer_frame(viewer_pull(pairing, lease, frame, [grant, 2, 1, 1, 1200, 0, 0, -1]))
      Rosegold::Clientbound::SynchronizePlayerPosition.new(96.0, 64.0, 0.0, 30_f32, 0_f32, 0, 1_u32).callback(client)
      bot.spawned?.should be_false
      client.resume_physics
      client.viewer_tick
      bot.look.yaw.should eq(30_f32)
      client.forward_pressed?.should be_false
      bot.manual_control?.should be_true
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "bounds a full inventory with paths and HUD, then sends the deferred terrain section" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      world = bot.world
      raw = Minecraft::IO::Memory.new
      (world.world_height >> 4).times { Rosegold::Section.empty.write(raw) }
      world.load_chunk(Rosegold::Chunk.new(0, 0, Minecraft::IO::Memory.new(raw.to_slice), world))
      stone = Rosegold::MCData.for(777_u32).blocks.find! { |block| block.id_str == "stone" }.min_state_id
      world.set_block_state(1, 2, 3, stone)
      chest = Rosegold::ChestMenu.new(client, 1_u8, Rosegold::Chat.new("Chest"), 6)
      item = Rosegold::MCData.for(777_u32).items.select { |entry| entry.name.bytesize <= 64 }.max_by(&.name.bytesize)
      chest.update_all_slots(Array.new(chest.total_slots) { Rosegold::Slot.new(999_u32, item.id) }, Rosegold::Slot.new, 1_u32)
      client.container_menu = chest
      viewer_menu_content(client, chest)

      host = RosegoldViewer::Host.new
      host.bind(bot)
      points = Array.new(16, Rosegold::Vec3d.new(-30_000_000, -30_000_000, -30_000_000))
      8.times { |index| host.draw_path("#{index}#{"x" * 31}", points).should be_true }
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      first["control"]["inventory"]["ready"].as_bool.should be_true
      first["control"]["inventory"]["slots"].as_a.size.should eq(90)
      first["control"]["inventory"]["slots"][89].should eq(JSON.parse([item.name, 999].to_json))
      first["paths"].as_a.size.should eq(8)
      first["hud"]["slots"].as_a.size.should eq(9)
      first["section"]?.should be_nil
      sleep 55.milliseconds
      next_frame = viewer_frame(viewer_pull(pairing, lease, first))
      next_frame["section"]["kind"].as_s.should eq("states")
      next_frame["section"]["position"].as_a.map(&.as_i).should eq([0, 0, 0])
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "dispatches a golden browser click once after late pairing and treats later slot data as authoritative" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      stone = Rosegold::MCData.for(777_u32).items.find! { |item| item.name == "stone" }
      menu = client.inventory_menu
      menu[36] = Rosegold::Slot.new(5_u32, stone.id)
      viewer_menu_content(client, menu)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      wire = JSON.parse({{ read_file("#{__DIR__}/fixtures/manual_inventory_wire.json") }})
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      entered = viewer_frame(viewer_pull(pairing, lease, first, wire["open"]))
      pending = viewer_frame(viewer_pull(pairing, lease, entered, wire["click"]))
      JSON.parse(pending["control"].as_h.reject("chatSupported").to_json).should eq(wire["pending"])
      client.click_sends.should eq(0)
      duplicate = viewer_pull(pairing, lease, pending, wire["click"])
      pending = viewer_frame(duplicate) if duplicate.status.ok?
      client.viewer_tick
      client.click_sends.should eq(1)
      menu.cursor.count.should eq(3)
      menu[36].count.should eq(2)

      prediction = viewer_frame(viewer_pull(pairing, lease, pending, wire["click"]))
      control = prediction["control"]
      control["ack"].as_i.should eq(2)
      control["inventory"]["pending"].as_bool.should be_false
      control["inventory"]["cursor"].should eq(JSON.parse(%(["stone",3])))
      client.viewer_tick
      client.click_sends.should eq(1)
      revision = control["inventory"]["revision"].as_i
      queued = viewer_frame(viewer_pull(pairing, lease, prediction, [1, 3, 3, 1, revision, 36, 0, 0]))
      menu.update_slot(36, Rosegold::Slot.new(5_u32, stone.id), 1_u32)
      menu.update_slot(-1, Rosegold::Slot.new, 1_u32)
      client.viewer_tick
      client.click_sends.should eq(1)
      corrected = viewer_frame(viewer_pull(pairing, lease, queued))["control"]
      corrected["ack"].as_i.should eq(3)
      corrected["inventory"]["revision"].as_i.should_not eq(revision)
      corrected["inventory"]["cursor"].raw.should be_nil
      corrected["inventory"]["slots"][36].should eq(JSON.parse(%(["stone",5])))
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "requires full initial container content regardless of the server state ID" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      stone = Rosegold::MCData.for(777_u32).items.find! { |item| item.name == "stone" }
      menu = Rosegold::ChestMenu.new(client, 1_u8, Rosegold::Chat.new("Chest"), 1)
      client.container_menu = menu
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      first["control"]["inventory"]["ready"].as_bool.should be_false
      first["control"]["inventory"]["pending"].as_bool.should be_false
      menu.update_slot(1, Rosegold::Slot.new(2_u32, stone.id), 9_u32)
      partial = viewer_frame(viewer_pull(pairing, lease, first))
      partial["control"]["inventory"]["ready"].as_bool.should be_false
      inventory = partial["control"]["inventory"]
      grant = partial["control"]["grant"].as_i
      identity = inventory["menu"].as_i
      revision = inventory["revision"].as_i
      rejected = viewer_frame(viewer_pull(pairing, lease, partial, [grant, 1, 3, identity, revision, 1, 0, 0]))
      rejected["control"]["ack"].as_i.should eq(1)
      client.viewer_tick
      client.click_sends.should eq(0)

      menu[1] = Rosegold::Slot.new
      viewer_menu_content(client, menu)
      loaded = viewer_frame(viewer_pull(pairing, lease, rejected))
      inventory = loaded["control"]["inventory"]
      menu.state_id.should eq(0)
      inventory["ready"].as_bool.should be_true
      inventory["slots"].as_a.all?(&.raw.nil?).should be_true
      revision = inventory["revision"].as_i
      viewer_frame(viewer_pull(pairing, lease, loaded, [grant, 2, 3, identity, revision, 1, 0, 0]))
      client.viewer_tick
      client.click_sends.should eq(1)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "rejects a queued click after window ID reuse and preserves a chest on handback" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      stone = Rosegold::MCData.for(777_u32).items.find! { |item| item.name == "stone" }
      title = Rosegold::Chat.new("Chest")
      initial = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
      initial.update_slot(1, Rosegold::Slot.new(5_u32, stone.id), 1_u32)
      client.container_menu = initial
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      viewer_menu_content(client, initial)
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      inventory = first["control"]["inventory"]
      menu = inventory["menu"].as_i
      revision = inventory["revision"].as_i
      queued = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 3, menu, revision, 1, 0, 0]))
      replacement = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
      replacement.update_slot(1, Rosegold::Slot.new(7_u32, stone.id), 1_u32)
      replacement.update_slot(2, Rosegold::Slot.new(2_u32, stone.id), 1_u32)
      client.container_menu = replacement
      viewer_menu_content(client, replacement)
      client.viewer_tick
      client.click_sends.should eq(0)
      replacement[1].count.should eq(7)
      current = viewer_frame(viewer_pull(pairing, lease, queued))
      inventory = current["control"]["inventory"]
      inventory["menu"].as_i.should_not eq(menu)
      menu = inventory["menu"].as_i
      revision = inventory["revision"].as_i

      queued = viewer_frame(viewer_pull(pairing, lease, current, [grant, 2, 3, menu, revision, 1, 1, 0]))
      client.viewer_tick
      client.click_sends.should eq(1)
      replacement[1].empty?.should be_true
      shifted = viewer_frame(viewer_pull(pairing, lease, queued))
      revision = shifted["control"]["inventory"]["revision"].as_i
      queued = viewer_frame(viewer_pull(pairing, lease, shifted, [grant, 3, 3, menu, revision, 2, 2, 0]))
      client.viewer_tick
      client.click_sends.should eq(2)
      replacement[replacement.hotbar_slot_index(0)].count.should eq(2)
      swapped = viewer_frame(viewer_pull(pairing, lease, queued))
      swapped["control"]["canReturn"].as_bool.should be_true
      viewer_frame(viewer_pull(pairing, lease, swapped, [grant, 4, 5]))
      client.viewer_tick
      bot.manual_control?.should be_false
      client.container_menu.same?(replacement).should be_true
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "closes an open chest natively once, however often the close is repeated" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      chest = Rosegold::ChestMenu.new(client, 1_u8, Rosegold::Chat.new("Chest"), 1)
      client.container_menu = chest
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      viewer_menu_content(client, chest)
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      entered = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 2]))
      menu = entered["control"]["inventory"]["menu"].as_i
      closing = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 4, menu]))
      if control = closing["control"]?
        control["ack"].as_i.should eq(1)
      end
      repeat = viewer_pull(pairing, lease, closing, [grant, 2, 4, menu])
      closing = viewer_frame(repeat) if repeat.status.ok?
      client.close_sends.should eq(0)
      client.viewer_tick
      client.viewer_tick
      client.close_sends.should eq(1)
      client.container_menu.same?(client.inventory_menu).should be_true
      client.container_menu.same?(chest).should be_false
      viewer_frame(viewer_pull(pairing, lease, closing))["control"]["ack"].as_i.should eq(2)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    {% for name, own in {"own inventory" => true, "a container" => false} %}
    guarded_it "closes {{name.id}} natively while the cursor holds a stack and leaves return protections" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      stone = Rosegold::MCData.for(777_u32).items.find!(&.name.==("stone"))
      held = {{own}} ? client.inventory_menu : Rosegold::ChestMenu.new(client, 1_u8, Rosegold::Chat.new("Chest"), 1)
      client.container_menu = held
      held.cursor = Rosegold::Slot.new(3_u32, stone.id)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      viewer_menu_content(client, held)
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      entered = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 2]))
      entered["control"]["inventory"]["cursor"].should eq(JSON.parse(%(["stone",3])))
      entered["control"]["canReturn"].as_bool.should be_false
      menu = entered["control"]["inventory"]["menu"].as_i
      closing = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 4, menu]))
      client.close_sends.should eq(0)
      client.viewer_tick
      client.viewer_tick
      client.close_sends.should eq(1)
      client.container_menu.same?(client.inventory_menu).should be_true
      acked = viewer_frame(viewer_pull(pairing, lease, closing))
      acked["control"]["ack"].as_i.should eq(2)
      acked["control"]["canPlay"].as_bool.should eq(!{{own}})
      if {{own}}
        client.inventory_menu.cursor.count.should eq(3)
        Rosegold::Clientbound::SetCursorItem.new(Rosegold::Slot.new).callback(client)
      end
      settled = viewer_frame(viewer_pull(pairing, lease, acked, [grant, 3, 0]))["control"]
      settled["canPlay"].as_bool.should be_true
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end
    {% end %}

    it "sends one vanilla window-zero close for an inventory close without an identity" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      viewer_menu_content(client, client.inventory_menu)
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      entered = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 2]))
      closing = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 4]))
      closing["control"]["ack"].as_i.should eq(1)
      repeat = viewer_pull(pairing, lease, closing, [grant, 2, 4])
      closing = viewer_frame(repeat) if repeat.status.ok?
      client.closed_windows.should be_empty
      client.viewer_tick
      client.viewer_tick
      client.closed_windows.should eq([0_u16])
      client.container_menu.same?(client.inventory_menu).should be_true
      settled = viewer_frame(viewer_pull(pairing, lease, closing))["control"]
      settled["ack"].as_i.should eq(2)
      settled["canReturn"].as_bool.should be_true
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    {% for target in %w(chest window_zero) %}
    {% for expiry in %w(deadline revoked lease transport released) %}
    guarded_it "{{expiry == "released" ? "sends".id : "refuses".id}} a queued {{target.id}} close {{expiry == "released" ? "once the writer frees in time".id : ("when " + expiry + " authority ends behind the writer").id}}" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      held = {{target == "chest"}} ? Rosegold::ChestMenu.new(client, 1_u8, Rosegold::Chat.new("Chest"), 1) : client.inventory_menu
      window = {{target == "chest" ? 1 : 0}}_u16
      client.container_menu = held
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      viewer_menu_content(client, held)
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      entered = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 2]))
      menu = entered["control"]["inventory"]["menu"].as_i
      closing = viewer_frame(viewer_pull(pairing, lease, entered, {{target == "chest"}} ? [grant, 2, 4, menu] : [grant, 2, 4]))

      release = hold_viewer_writer(client)
      ticked = viewer_tick_behind_writer(client)
      {% if expiry == "deadline" %}
        sleep 350.milliseconds
      {% elsif expiry == "revoked" %}
        bot.manual_control = false
      {% elsif expiry == "lease" %}
        lease = viewer_pair(pairing)
      {% elsif expiry == "transport" %}
        host.@transport.disable
      {% end %}
      release.send(nil)
      ticked.receive

      {% if expiry == "released" %}
        client.closed_windows.should eq([window])
        client.container_menu.same?(client.inventory_menu).should be_true
        settled = viewer_frame(viewer_pull(pairing, lease, closing))["control"]
        settled["ack"].as_i.should eq(2)
        settled["mode"].as_s.should eq("pause")
      {% elsif expiry == "deadline" %}
        client.closed_windows.should be_empty
        client.container_menu.should be(held)
        refused = viewer_frame(viewer_pull(pairing, lease, closing))
        refused["control"]["ack"].as_i.should eq(2)
        refused["control"]["mode"].as_s.should eq("inventory")
        refused["control"]["inventory"]["menu"].as_i.should eq(menu)
        refused["control"]["inventory"]["pending"].as_bool.should be_false
        viewer_frame(viewer_pull(pairing, lease, refused, {{target == "chest"}} ? [grant, 3, 4, menu] : [grant, 3, 4]))
        client.viewer_tick
        client.closed_windows.should eq([window])
        client.container_menu.same?(client.inventory_menu).should be_true
      {% else %}
        client.closed_windows.should be_empty
        client.container_menu.should be(held)
        client.viewer_tick
        bot.manual_control?.should be_false
        client.closed_windows.should be_empty
        client.container_menu.should be(held)
      {% end %}
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end
    {% end %}
    {% end %}

    guarded_it "treats a server close after a refused carried-stack close as unresolved" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      chest = Rosegold::ChestMenu.new(client, 1_u8, Rosegold::Chat.new("Chest"), 1)
      chest.cursor = Rosegold::Slot.new(3_u32, Rosegold::MCData.for(777_u32).items.find!(&.name.==("stone")).id)
      client.container_menu = chest
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      viewer_menu_content(client, chest)
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      menu = first["control"]["inventory"]["menu"].as_i
      closing = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 4, menu]))
      release = hold_viewer_writer(client)
      ticked = viewer_tick_behind_writer(client)
      sleep 350.milliseconds
      release.send(nil)
      ticked.receive
      client.closed_windows.should be_empty

      server_close = Rosegold::Clientbound::CloseWindow.new(1_u32)
      server_close.callback(client)
      client.emit_event(server_close)
      current = viewer_frame(viewer_pull(pairing, lease, closing))["control"]
      current["canReturn"].as_bool.should be_false
      current["canPlay"].as_bool.should be_false
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "never applies a close to a menu that replaced the one it was pressed in" do
      %w(before_receipt after_enqueue legacy).each do |case_name|
        client = HostSpecClient.new
        bot = Rosegold::Bot.new(client)
        title = Rosegold::Chat.new("Chest")
        chest = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
        replacement = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
        client.container_menu = chest
        host = RosegoldViewer::Host.new
        host.bind(bot)
        pairing = host.enable.not_nil!
        lease = viewer_pair(pairing)
        bot.manual_control = true
        viewer_menu_content(client, chest)
        first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
        grant = first["control"]["grant"].as_i
        entered = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 2]))
        menu = entered["control"]["inventory"]["menu"].as_i
        case case_name
        when "before_receipt"
          client.container_menu = replacement
          viewer_menu_content(client, replacement)
          frame = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 4, menu]))
        when "after_enqueue"
          frame = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 4, menu]))
          client.container_menu = replacement
          viewer_menu_content(client, replacement)
          client.viewer_tick
          again = viewer_pull(pairing, lease, frame)
          frame = viewer_frame(again) if again.status.ok?
        else
          frame = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 4]))
          client.viewer_tick
          again = viewer_pull(pairing, lease, frame)
          frame = viewer_frame(again) if again.status.ok?
        end
        client.viewer_tick
        client.close_sends.should eq(0)
        client.container_menu.should_not be(client.inventory_menu)
        frame["control"]["mode"].as_s.should eq("inventory")
        frame["control"]["ack"].as_i.should eq(2)
        if case_name != "legacy"
          frame["control"]["inventory"]["menu"].as_i.should_not eq(menu)
        end
      ensure
        host.try &.disable
        client.try(&.connection?).try &.disconnect("End of viewer host spec")
      end
    end

    guarded_it "keeps a queued close when a fresh pause arrives before the next tick" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      chest = Rosegold::ChestMenu.new(client, 1_u8, Rosegold::Chat.new("Chest"), 1)
      client.container_menu = chest
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      viewer_menu_content(client, chest)
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      entered = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 2]))
      menu = entered["control"]["inventory"]["menu"].as_i
      closing = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 4, menu]))
      paused = viewer_frame(viewer_pull(pairing, lease, closing, [grant, 3, 0]))
      paused["control"]["mode"].as_s.should eq("pause")
      client.viewer_tick
      client.close_sends.should eq(1)
      client.container_menu.same?(client.inventory_menu).should be_true
      viewer_frame(viewer_pull(pairing, lease, paused))["control"]["ack"].as_i.should eq(3)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "blocks retries and handback after an ambiguous click, even after the cursor clears" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      stone = Rosegold::MCData.for(777_u32).items.find!(&.name.==("stone"))
      client.inventory_menu[36] = Rosegold::Slot.new(3_u32, stone.id)
      viewer_menu_content(client, client.inventory_menu)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      result = Channel(Rosegold::ManualControl::Cancelled).new(1)
      spawn do
        bot.manual_debug_until_button_pressed_in_menu
      rescue error : Rosegold::ManualControl::Cancelled
        result.send(error)
      end
      Fiber.yield
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = frame["control"]["grant"].as_i
      entered = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 1, 2]))
      inventory = entered["control"]["inventory"]
      menu = inventory["menu"].as_i
      revision = inventory["revision"].as_i
      client.fail_click_commit = true
      queued = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 3, menu, revision, 36, 0, 0]))
      client.viewer_tick
      failed = viewer_frame(viewer_pull(pairing, lease, queued))
      failed["control"]["ack"].as_i.should eq(2)
      failed["control"]["inventory"]["cursor"].raw.should be_nil
      failed["control"]["inventory"]["pending"].as_bool.should be_true
      failed["control"]["canReturn"].as_bool.should be_false
      failed["control"]["canPlay"].as_bool.should be_false

      client.fail_click_commit = false
      Rosegold::Clientbound::SetCursorItem.new(Rosegold::Slot.new(3_u32, stone.id)).callback(client)
      carried = viewer_frame(viewer_pull(pairing, lease, failed))
      carried["control"]["inventory"]["cursor"].should eq(JSON.parse(%(["stone",3])))
      carried["control"]["inventory"]["pending"].as_bool.should be_true
      Rosegold::Clientbound::SetCursorItem.new(Rosegold::Slot.new).callback(client)
      corrected = viewer_frame(viewer_pull(pairing, lease, carried))
      inventory = corrected["control"]["inventory"]
      inventory["cursor"].raw.should be_nil
      inventory["pending"].as_bool.should be_true
      revision = inventory["revision"].as_i
      retry_frame = viewer_frame(viewer_pull(pairing, lease, corrected, [grant, 3, 3, menu, revision, 36, 0, 0]))
      retry_frame["control"]["ack"].as_i.should eq(3)
      client.viewer_tick
      client.click_sends.should eq(1)

      close_reply = viewer_pull(pairing, lease, retry_frame, [grant, 4, 4, menu])
      retry_frame = viewer_frame(close_reply) unless close_reply.status.no_content?
      client.viewer_tick
      client.closed_windows.should be_empty
      blocked = viewer_frame(viewer_pull(pairing, lease, retry_frame, [grant, 5, 5]))
      blocked["control"]["canReturn"].as_bool.should be_false
      client.viewer_tick
      bot.manual_control?.should be_true
      host.disable
      select
      when error = result.receive
        error.unresolved_inventory?.should be_true
      when timeout(1.second)
        fail "Debug waiter was not cancelled"
      end
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "blocks handback when the menu changes during a click write" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      title = Rosegold::Chat.new("Chest")
      initial = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
      replacement = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
      client.container_menu = initial
      viewer_menu_content(client, initial)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      inventory = first["control"]["inventory"]
      menu = inventory["menu"].as_i
      revision = inventory["revision"].as_i
      client.after_click_write = -> do
        client.container_menu = replacement
        viewer_menu_content(client, replacement)
      end

      queued = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 3, menu, revision, 1, 0, 0]))
      client.viewer_tick
      client.click_sends.should eq(1)
      current = viewer_frame(viewer_pull(pairing, lease, queued))
      current["control"]["ack"].as_i.should eq(1)
      inventory = current["control"]["inventory"]
      inventory["menu"].as_i.should_not eq(menu)
      inventory["cursor"].raw.should be_nil
      inventory["pending"].as_bool.should be_true
      current["control"]["canReturn"].as_bool.should be_false
      viewer_frame(viewer_pull(pairing, lease, current, [grant, 2, 5]))
      client.viewer_tick
      bot.manual_control?.should be_true
      client.container_menu.should be(replacement)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "keeps the viewer attached and blocks handback after an ambiguous chest close" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      chest = HostSpecChest.new(client, 1_u8, Rosegold::Chat.new("Chest"), 1)
      client.container_menu = chest
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      menu = first["control"]["inventory"]["menu"].as_i
      chest.fail_commit = true
      queued = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 4, menu]))
      client.viewer_tick
      client.closed_windows.should eq([1_u16])
      client.container_menu.should be(chest)
      failed = viewer_frame(viewer_pull(pairing, lease, queued))
      failed["control"]["ack"].as_i.should eq(1)
      failed["control"]["canPlay"].as_bool.should be_false
      failed["control"]["canReturn"].as_bool.should be_false

      chest.fail_commit = false
      close_reply = viewer_pull(pairing, lease, failed, [grant, 2, 4, menu])
      retry_frame = close_reply.status.no_content? ? failed : viewer_frame(close_reply)
      client.viewer_tick
      client.closed_windows.should eq([1_u16])
      viewer_frame(viewer_pull(pairing, lease, retry_frame, [grant, 3, 5]))
      client.viewer_tick
      bot.manual_control?.should be_true
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "drops the viewer when the transport fails writing a click, without a second write" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      stone = Rosegold::MCData.for(777_u32).items.find!(&.name.==("stone"))
      client.inventory_menu[36] = Rosegold::Slot.new(3_u32, stone.id)
      viewer_menu_content(client, client.inventory_menu)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      result = Channel(Rosegold::ManualControl::Cancelled).new(1)
      spawn do
        bot.manual_debug_until_button_pressed_in_menu
      rescue error : Rosegold::ManualControl::Cancelled
        result.send(error)
      end
      Fiber.yield
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = frame["control"]["grant"].as_i
      entered = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 1, 2]))
      inventory = entered["control"]["inventory"]
      client.fail_click = true
      queued = viewer_frame(viewer_pull(pairing, lease, entered, [grant, 2, 3, inventory["menu"].as_i, inventory["revision"].as_i, 36, 0, 0]))
      client.viewer_tick
      client.click_sends.should eq(1)
      client.connection?.try(&.closed?).should be_true
      lost = viewer_frame(viewer_pull(pairing, lease, queued))
      lost["status"].as_s.should eq("waiting")
      lost["control"]?.should be_nil
      client.viewer_tick
      client.click_sends.should eq(1)
      client.closed_windows.should be_empty
      bot.manual_control?.should be_false
      select
      when error = result.receive
        error.unresolved_inventory?.should be_true
      when timeout(1.second)
        fail "Debug waiter was not cancelled"
      end
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    guarded_it "drops the viewer when the transport fails writing a chest close, without a second write" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      chest = Rosegold::ChestMenu.new(client, 1_u8, Rosegold::Chat.new("Chest"), 1)
      client.container_menu = chest
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      bot.manual_control = true
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = first["control"]["grant"].as_i
      menu = first["control"]["inventory"]["menu"].as_i
      client.fail_close = true
      queued = viewer_frame(viewer_pull(pairing, lease, first, [grant, 1, 4, menu]))
      client.viewer_tick
      client.closed_windows.should eq([1_u16])
      client.connection?.try(&.closed?).should be_true
      lost = viewer_frame(viewer_pull(pairing, lease, queued))
      lost["status"].as_s.should eq("waiting")
      lost["control"]?.should be_nil
      client.viewer_tick
      client.closed_windows.should eq([1_u16])
      client.click_sends.should eq(0)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "keeps a carried stack and open container on forced loss" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      result = Channel(Rosegold::ManualControl::Cancelled).new(1)
      spawn do
        bot.manual_debug_until_button_pressed_in_menu
      rescue error : Rosegold::ManualControl::Cancelled
        result.send(error)
      end
      Fiber.yield
      title = Rosegold::Chat.new("Chest")
      menu = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
      client.container_menu = menu
      first = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      previous_id = first["control"]["inventory"]["menu"].as_i
      grant = first["control"]["grant"].as_i
      replacement = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
      replacement.cursor = Rosegold::Slot.new(2_u32, Rosegold::MCData.for(777_u32).items.find!(&.name.==("stone")).id)
      client.container_menu = replacement
      current = viewer_frame(viewer_pull(pairing, lease, first))
      current["control"]["inventory"]["menu"].as_i.should_not eq(previous_id)
      current["control"]["canReturn"].as_bool.should be_false
      viewer_frame(viewer_pull(pairing, lease, current, [grant, 1, 5]))
      client.viewer_tick
      bot.manual_control?.should be_true
      host.disable
      select
      when error = result.receive
        error.reason.host_disabled?.should be_true
        error.unresolved_inventory?.should be_true
      when timeout(1.second)
        fail "Debug waiter was not cancelled"
      end
      client.container_menu.same?(replacement).should be_true
      replacement.cursor.count.should eq(2)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end

    it "returns a debug waiter without detaching and cancels a later waiter on disable" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      expect_raises(Rosegold::ManualControl::Cancelled) { bot.manual_debug_until_button_pressed_in_menu }
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      results = Channel(Symbol | Rosegold::ManualControl::Cancelled).new(2)
      spawn do
        results.send(bot.manual_debug_until_button_pressed_in_menu)
      rescue error : Rosegold::ManualControl::Cancelled
        results.send(error)
      end
      Fiber.yield
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = frame["control"]["grant"].as_i
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 1, 5]))
      bot.manual_control?.should be_true
      client.viewer_tick
      bot.manual_control?.should be_false
      select
      when result = results.receive
        result.should eq(:returned)
      when timeout(1.second)
        fail "Debug waiter did not return"
      end
      viewer_frame(viewer_pull(pairing, lease, frame))["control"].raw.should be_nil

      client.viewer_tick
      spawn do
        results.send(bot.manual_debug_until_button_pressed_in_menu)
      rescue error : Rosegold::ManualControl::Cancelled
        results.send(error)
      end
      Fiber.yield
      bot.manual_control?.should be_true
      host.disable
      select
      when result = results.receive
        result.as(Rosegold::ManualControl::Cancelled).reason.host_disabled?.should be_true
      when timeout(1.second)
        fail "Debug waiter was not cancelled"
      end
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end
  {% end %}

  {% if Rosegold::Client.has_method?(:intervention) && Rosegold::Intervention.has_method?(:can_take_over?) %}
    it "takes over only by request and resumes the parked script" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = viewer_pair(pairing)
      gate = Channel(Nil).new
      resumed = Channel(Nil).new(1)
      spawn do
        client.intervention.register_owner(restartable: true)
        gate.receive
        client.intervention.checkpoint
        resumed.send(nil)
      end
      Fiber.yield
      client.intervention.permitted = true
      offer = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = offer["control"]["grant"].as_i
      bot.manual_control?.should be_false
      ignored = viewer_frame(viewer_pull(pairing, lease, offer, [grant, 1, 1, 0, 0, 0, 0, -1]))
      ignored["control"]["checkpoint"].as_s.should eq("none")
      bot.manual_control?.should be_false
      pending = viewer_frame(viewer_pull(pairing, lease, ignored, [grant, 2, 6]))
      pending["control"]["grant"].as_i.should eq(grant)
      pending["control"]["checkpoint"].as_s.should eq("pending")
      pending["control"]["canRestart"].as_bool.should be_false
      bot.manual_control?.should be_true

      gate.send(nil)
      Fiber.yield
      parked = viewer_frame(viewer_pull(pairing, lease, pending))
      parked["control"]["checkpoint"].as_s.should eq("parked")
      parked["control"]["canRestart"].as_bool.should be_true
      response = viewer_frame(viewer_pull(pairing, lease, parked, [grant, 3, 7]))
      response["control"]["ack"].as_i.should eq(3)
      client.viewer_tick
      bot.manual_control?.should be_false
      select
      when resumed.receive
      when timeout(1.second)
        fail "Intervention did not resume"
      end
      client.viewer_tick
      next_offer = viewer_frame(viewer_pull(pairing, lease, response))
      next_offer["control"]["grant"].as_i.should_not eq(grant)
    ensure
      host.try &.disable
      gate.try &.close
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end
  {% end %}

  {% if Rosegold.has_constant?(:ManualControl) && Rosegold::ManualControl.has_method?(:ice_road?) %}
    it "runs the ice road on native ticks from one toggle and stops it on pause" do
      client = HostSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      bot.manual_control = true
      lease = viewer_pair(pairing)
      frame = viewer_frame(viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0})))
      grant = frame["control"]["grant"].as_i
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 1, 1, 0, 0, 0, 0, -1]))
      client.player.look = Rosegold::Look.new(100_f32, 0_f32)
      frame = viewer_frame(viewer_pull(pairing, lease, frame, [grant, 2, 1, 0, 0, 0, 8, -1]))
      client.viewer_tick
      (client.player.look.yaw - 90_f32).abs.should be < 0.001
      client.manual_control.ice_road?.should be_true
      3.times do
        client.viewer_tick
        client.forward_pressed?.should be_true
      end
      frame = viewer_frame(viewer_pull(pairing, lease, frame))
      frame["hud"]["ice"].as_bool.should be_true

      viewer_pull(pairing, lease, frame, [grant, 3, 0])
      client.manual_control.ice_road?.should be_false
      client.viewer_tick
      client.forward_pressed?.should be_false
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer host spec")
    end
  {% end %}

  it "rejects malformed input including replayable or out-of-range fields" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    lease = viewer_pair(pairing)
    invalid_inputs = ["null", "[]", "[0,1,0]", "[1,0,0]", "[1,1,10]", "[1,1,9,0]", "[1,1,0,0]", "[1,1,1,512,0,0,0,-1]",
                      "[1,1,1,0,18001,0,0,-1]", "[1,1,1,0,0,0,16,-1]", "[1,1,3,1,1,-999,0,0]", "[1,1,3,1,1,0,2,9]", "[1,1,4,0]"]
    invalid_inputs.each do |input|
      viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0,"i":#{input}})).status.should eq(HTTP::Status::BAD_REQUEST)
    end
    viewer_post(pairing, "/next", lease, %({"epoch":0,"seq":0,"i":[1,1,0],"i":[1,2,0]})).status.should eq(HTTP::Status::BAD_REQUEST)
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
