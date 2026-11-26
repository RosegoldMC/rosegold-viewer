require "spec"
require "rosegold"
require "../src/rosegold_viewer/feed"

private class FeedSpecClient < Rosegold::Client
  @tick_ends = Channel(Nil).new(4)

  def initialize(protocol : UInt32 = 777_u32)
    super("localhost", offline: {uuid: "00000000-0000-0000-0000-000000000000", username: "viewer_spec"})
    replace_connection(protocol)
    physics.unpause_for_spawn_chunk
  end

  def replace_connection(protocol : UInt32 = 777_u32) : Nil
    @connection = Rosegold::Connection::Client.new(Minecraft::IO::Memory.new, Rosegold::ProtocolState::PLAY, protocol, self)
    set_protocol_state(Rosegold::ProtocolState::PLAY)
  end

  def receive(packet : T) : Nil forall T
    packet.callback(self)
    emit_event(packet)
  end

  def receive_block(location : Rosegold::Vec3i, state : UInt16) : Nil
    receive_wire(Rosegold::Clientbound::BlockChange) do |data|
      data.write(location)
      data.write(state.to_u32)
    end
  end

  def receive_wire(packet_type : T.class, &) : Nil forall T
    data = Minecraft::IO::Memory.new
    data.write(packet_type.packet_id_for_protocol(connection.protocol_version))
    yield data
    io = Minecraft::IO::Memory.new
    io.write(data.size.to_u32)
    io.write(data.to_slice)
    io.rewind
    connection.io = io
    read_packet
  end

  def transfer_to(new_host : String, new_port : UInt32) : Nil
    connection.disconnect("transferring")
    replace_connection
    set_protocol_state(Rosegold::ProtocolState::LOGIN)
  end

  def resume_physics : Nil
    physics.unpause_for_spawn_chunk
  end

  def tick_interactions : Nil
    interactions.tick
  end

  def send_packet!(packet : Rosegold::Serverbound::Packet)
    super
    @tick_ends.send(nil) if packet.is_a?(Rosegold::Serverbound::ClientTickEnd)
  end

  def await_tick_end : Bool
    select
    when @tick_ends.receive
      true
    when timeout(2.seconds)
      false
    end
  end

  def stop_ticker : Nil
    connection?.try &.disconnect("end of viewer spec")
    select
    when @ticker_done.receive
    when timeout(2.seconds)
      raise "ticker did not stop"
    end
  end
end

private class FeedSpecBot < Rosegold::Bot
  property? fail_pose = false

  def eyes
    raise "viewer pose error" if fail_pose?
    super
  end
end

private class SpecFeed < RosegoldViewer::Feed
  property? fail_dirty = false

  @clock = Time.instant

  def advance(span : Time::Span = 50.milliseconds) : Nil
    @clock += span
  end

  private def now : Time::Instant
    @clock
  end

  private def dirty(position : Tuple(Int32, Int32, Int32)) : Nil
    raise "viewer dirty error" if fail_dirty?
    super
  end
end

private class UnboundedViewerPoints
  include Enumerable(Rosegold::Vec3i)

  getter yielded = 0

  def each(& : Rosegold::Vec3i ->) : Nil
    loop do
      @yielded += 1
      raise "viewer kept reading after the point cap" if @yielded > 129
      yield Rosegold::Vec3i::ORIGIN
    end
  end
end

private record ViewerFrame, header : JSON::Any, data : Bytes do
  def epoch : UInt32
    header["epoch"].as_i64.to_u32
  end

  def seq : UInt32
    header["seq"].as_i64.to_u32
  end

  def status : String
    header["status"].as_s
  end

  def kind : String
    header["section"]["kind"].as_s
  end

  def position : Array(Int32)
    header["section"]["position"].as_a.map(&.as_i)
  end

  def state(index : Int32) : UInt16
    IO::ByteFormat::LittleEndian.decode(UInt16, data[index * 2, 2])
  end
end

private def viewer_frame(bytes : Bytes) : ViewerFrame
  length = IO::ByteFormat::LittleEndian.decode(UInt16, bytes[0, 2]).to_i
  ViewerFrame.new(JSON.parse(String.new(bytes[2, length])), bytes[2 + length..])
end

private def viewer_frame(feed : RosegoldViewer::Feed, epoch : UInt32 = 0_u32, seq : UInt32 = 0_u32) : ViewerFrame
  viewer_frame(feed.pull(epoch, seq).not_nil!)
end

private def viewer_frame(feed : RosegoldViewer::Feed, previous : ViewerFrame) : ViewerFrame
  viewer_frame(feed, previous.epoch, previous.seq)
end

private def viewer_state(name : String, protocol = 777_u32) : UInt16
  Rosegold::MCData.for(protocol).blocks.find! { |block| block.id_str == name }.min_state_id
end

private def viewer_chunk(world : Rosegold::Dimension, x : Int32, z : Int32, fluid_only : UInt16? = nil) : Rosegold::Chunk
  io = Minecraft::IO::Memory.new
  (world.world_height >> 4).times do |index|
    section = Rosegold::Section.empty
    if fluid_only && index == -(world.min_y >> 4)
      section.set_block_state(0_u32, fluid_only)
      start = io.pos
      section.write(io)
      io.to_slice[start + 1] = 0_u8
      io.to_slice[start + 3] = 1_u8
    else
      section.write(io)
    end
  end
  Rosegold::Chunk.new(x, z, Minecraft::IO::Memory.new(io.to_slice), world)
end

private def viewer_login : Rosegold::Clientbound::Login
  Rosegold::Clientbound::Login.new(
    7, false, ["minecraft:overworld"], 20_u32, 10_u32, 10_u32,
    false, true, false, 0_u32, "minecraft:overworld", 0_i64, 0_u8,
    -1_i8, false, false, false, nil, nil, 0_u32, 63_u32, false
  )
end

private def viewer_respawn : Rosegold::Clientbound::Respawn
  Rosegold::Clientbound::Respawn.new(
    0_u32, "minecraft:overworld", 0_i64, 0_u8, -1_i8,
    false, false, false, nil, nil, 0_u32, 63_u32, 0_u8
  )
end

describe RosegoldViewer::Feed do
  it "sends a detached HUD on changes and on a new epoch" do
    client = FeedSpecClient.new
    feed = SpecFeed.new
    feed.bind(Rosegold::Bot.new(client))
    feed.attach
    apple = Rosegold::MCData.for(777_u32).items.find! { |item| item.name == "apple" }
    slot = Rosegold::Slot.new(2_u32, apple.id)
    slot.components_to_add["custom_name"] = Rosegold::DataComponents::CustomName.new("private display name")
    client.receive(Rosegold::Clientbound::SetPlayerInventory.new(8, slot))
    client.receive(Rosegold::Clientbound::SetPlayerInventory.new(9, slot))
    client.receive(Rosegold::Clientbound::HeldItemChange.new(8_u32))
    client.receive(Rosegold::Clientbound::UpdateHealth.new(17.5_f32, 14_u32, 3_f32))

    first = viewer_frame(feed)
    hud = first.header["hud"]
    hud["health"].as_f.should eq(17.5)
    hud["food"].as_i.should eq(14)
    hud["selected"].as_i.should eq(8)
    hud["slots"].should eq(JSON.parse(%([null,null,null,null,null,null,null,null,{"item":"apple","count":2}])))
    feed.pull(first.epoch, first.seq).should be_nil

    slot.count = 3_u32
    updated = viewer_frame(feed, first)
    updated.header["section"]?.should be_nil
    updated.header["hud"]["slots"][8]["count"].as_i.should eq(3)
    hud["slots"][8]["count"].as_i.should eq(2)
    feed.advance
    terrain = viewer_frame(feed, updated)
    terrain.header["hud"]?.should be_nil

    resynced = viewer_frame(feed)
    resynced.epoch.should_not eq(terrain.epoch)
    resynced.header["hud"].should eq(updated.header["hud"])
  end

  it "bounds malformed health, hunger, and hotbar data without failing the feed" do
    client = FeedSpecClient.new
    client.player.health = Float32::NAN
    client.player.food = UInt32::MAX
    client.player.hotbar_selection = UInt32::MAX
    client.player_inventory[0] = Rosegold::Slot.new(UInt32::MAX, UInt32::MAX)
    client.player_inventory[1] = Rosegold::Slot.new(0_u32, UInt32::MAX)
    feed = SpecFeed.new
    feed.bind(Rosegold::Bot.new(client))
    feed.attach

    first = viewer_frame(feed)
    hud = first.header["hud"]
    hud["health"].as_f.should eq(0.0)
    hud["food"].as_i.should eq(20)
    hud["selected"].as_i.should eq(8)
    hud["slots"].should eq(JSON.parse(%([{"item":"unknown_item","count":999},null,null,null,null,null,null,null,null])))
    client.player.health = 3000_f32
    updated = viewer_frame(feed, first)
    updated.header["hud"]["health"].as_f.should eq(2048.0)
    feed.failure.should be_nil
  end

  it "reports native mining progress only when the core exposes it" do
    client = FeedSpecClient.new
    client.player.feet = Rosegold::Vec3d.new(-0.5, 0.9 - Rosegold::Player::DEFAULT_EYE_HEIGHT, 0.5)
    client.player.look = Rosegold::Look::SOUTH
    bot = Rosegold::Bot.new(client)
    world = bot.world
    world.load_chunk(viewer_chunk(world, -1, 0))
    world.set_block_state(-1, 0, 2, viewer_state("stone"))
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    first = viewer_frame(feed)
    first.header["hud"]["breaking"].raw.should be_nil

    {% if Rosegold::Bot.has_method?(:block_break_progress) %}
      first.header["hud"]["mining"].as_i.should eq(0)
      {% if Rosegold::Bot.has_method?(:block_break_target) %}
        world.set_block_state(-1, 0, 2, viewer_state("bedrock"))
        bot.start_digging
        client.tick_interactions
        bot.block_break_target.should eq(Rosegold::Vec3i.new(-1, 0, 2))
        bot.block_break_progress.should eq(0_f32)
        feed.pull(first.epoch, first.seq).should be_nil
        bot.stop_digging
        client.tick_interactions
        world.set_block_state(-1, 0, 2, viewer_state("stone"))
      {% end %}
      bot.start_digging
      client.tick_interactions
      active = viewer_frame(feed, first)
      (1..99).includes?(active.header["hud"]["mining"].as_i).should be_true
      {% if Rosegold::Bot.has_method?(:block_break_target) %}
        active.header["hud"]["breaking"].should eq(JSON.parse(%({"position":[-1,0,2],"stage":0})))
        1000.times do
          break if bot.block_break_progress >= 0.9_f32
          client.tick_interactions
        end
        active = viewer_frame(feed, active)
        active.header["hud"]["breaking"].should eq(JSON.parse(%({"position":[-1,0,2],"stage":9})))
      {% else %}
        active.header["hud"]["breaking"].raw.should be_nil
      {% end %}
      bot.stop_digging
      client.tick_interactions
      idle = viewer_frame(feed, active).header["hud"]
      idle["mining"].as_i.should eq(0)
      idle["breaking"].raw.should be_nil
    {% else %}
      first.header["hud"]["mining"].raw.should be_nil
    {% end %}
  end

  it "coalesces path edits into detached fixed-point snapshots without pacing terrain" do
    bot = Rosegold::Bot.new(FeedSpecClient.new)
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    first = viewer_frame(feed)
    first.header["paths"].as_a.should be_empty

    color = 0x39e4ff_u32
    point = Rosegold::Vec3d.new(-0.005, 1.25, 4)
    points = [point, Rosegold::Vec3d::ORIGIN]
    feed.draw_path("route", [Rosegold::Vec3i::ORIGIN], color: color).should be_true
    feed.draw_path("route", points, color: color).should be_true
    points.clear
    feed.draw_path("stop", [Rosegold::Vec3i.new(1, 2, 3)], color: 0_u32).should be_true
    updated = viewer_frame(feed, first)
    updated.header["section"]?.should be_nil
    updated.header["paths"].should eq(JSON.parse(%([
      {"name":"route","color":3794175,"points":[[-1,320,1024],[0,0,0]]},
      {"name":"stop","color":0,"points":[[256,512,768]]}
    ])))

    feed.draw_path("route", [point], color: color).should be_true
    feed.draw_path("route", [point, Rosegold::Vec3d::ORIGIN], color: color).should be_true
    feed.pull(updated.epoch, updated.seq).should be_nil
    feed.advance
    terrain = viewer_frame(feed, updated)
    terrain.header["section"]?.should_not be_nil
    terrain.header["paths"]?.should be_nil

    feed.draw_path("route", [] of Rosegold::Vec3d, color: color).should be_true
    one = viewer_frame(feed, terrain)
    one.header["paths"].as_a.map { |path| path["name"].as_s }.should eq(["stop"])
    feed.clear_path("stop")
    empty = viewer_frame(feed, one)
    empty.header["paths"].as_a.should be_empty
    feed.clear_path("stop")
    feed.pull(empty.epoch, empty.seq).should be_nil
  end

  it "rejects points copied across a world reset or an explicit clear" do
    client = FeedSpecClient.new
    feed = SpecFeed.new
    feed.bind(Rosegold::Bot.new(client))
    point = Rosegold::Vec3i::ORIGIN
    respawning = [point].each.map do |position|
      client.receive(viewer_respawn)
      client.resume_physics
      position
    end
    feed.draw_path("route", respawning, color: 0_u32).should be_false

    feed.draw_path("route", [point], color: 0_u32).should be_true
    clearing = [point].each.map do |position|
      feed.clear_paths
      position
    end
    feed.draw_path("route", clearing, color: 0_u32).should be_false
    feed.attach
    viewer_frame(feed).header["paths"].as_a.should be_empty
  end

  it "keeps the hotbar, validated paths and a states section in a single bounded batch" do
    client = FeedSpecClient.new
    client.player.health = 0.00012345678_f32
    client.player.food = 20_u32
    client.player.hotbar_selection = 8_u32
    longest = Rosegold::MCData.for(777_u32).items.max_by(&.name.bytesize)
    9.times { |index| client.player_inventory[index] = Rosegold::Slot.new(999_u32, longest.id) }
    bot = Rosegold::Bot.new(client)
    world = bot.world
    world.load_chunk(viewer_chunk(world, 0, 0))
    stone = viewer_state("stone")
    world.set_block_state(0, 0, 0, stone)
    feed = SpecFeed.new
    feed.draw_path("route", [Rosegold::Vec3i::ORIGIN], color: 0_u32).should be_false
    feed.bind(bot)

    edge = Rosegold::Vec3i.new(-30_000_000, -30_000_000, -30_000_000)
    names = (0...8).map { |i| "#{"x" * 31}#{i}" }
    names.each { |name| feed.draw_path(name, Array.new(16, edge), color: 0xffffff_u32).should be_true }
    name = names.first
    feed.draw_path(name, Array.new(17, edge), color: 0_u32).should be_false
    feed.draw_path("ninth", [edge], color: 0_u32).should be_false
    feed.draw_path(name, [edge], color: 0x1000000_u32).should be_false
    ["", "spaces forbidden", "x" * 33, "route\n", "voúte", String.new(Bytes[0xff])].each do |invalid|
      feed.draw_path(invalid, [edge], color: 0_u32).should be_false
    end
    [Float64::NAN, Float64::INFINITY, -Float64::INFINITY, 30_000_000.0001, -30_000_000.0001].each do |invalid|
      feed.draw_path(name, [Rosegold::Vec3d.new(invalid, 0, 0)], color: 0_u32).should be_false
    end
    feed.draw_path(name, ["not a point"], color: 0_u32).should be_false
    excessive = UnboundedViewerPoints.new
    feed.draw_path(name, excessive, color: 0_u32).should be_false
    excessive.yielded.should eq(129)

    feed.attach
    bytes = feed.pull(0_u32, 0_u32).not_nil!
    frame = viewer_frame(bytes)
    hud = frame.header["hud"]
    hud["slots"].as_a.should eq(Array.new(9, JSON.parse(%({"item":"#{longest.name}","count":999}))))
    name_padding = 9 * (64 - longest.name.bytesize)
    max_breaking = %({"position":[-2147483648,-2147483648,-2147483648],"stage":9})
    breaking_padding = max_breaking.bytesize - hud["breaking"].to_json.bytesize
    mining_padding = Math.max(0, 2 - hud["mining"].to_json.bytesize)
    (bytes.size + name_padding + breaking_padding + mining_padding).should be < 16 * 1024
    frame.kind.should eq("states")
    frame.data.size.should eq(8192)
    frame.state(0).should eq(stone)
    paths = frame.header["paths"].as_a
    paths.map { |path| path["name"].as_s }.should eq(names)
    paths.each do |path|
      path["color"].as_i.should eq(0xffffff)
      path["points"].as_a.size.should eq(16)
      path["points"].as_a.first.as_a.map(&.as_i64).should eq([-7_680_000_000_i64] * 3)
    end
    feed.failure.should be_nil
  end

  {775_u32, 777_u32}.each do |protocol|
    it "attaches late and copies authoritative x-fastest states at signed section positions on #{protocol}" do
      client = FeedSpecClient.new(protocol)
      bot = Rosegold::Bot.new(client)
      world = bot.world
      stone = viewer_state("stone", protocol)
      data = Rosegold::MCData.for(protocol)
      water = viewer_state("water", protocol)
      client.player.feet = Rosegold::Vec3d.new(-0.25, -1.0, -0.25)
      client.player.look = Rosegold::Look::WEST.up(30)
      world.load_chunk(viewer_chunk(world, -1, -1))
      target = Rosegold::Vec3i.new(-15, -14, -13)
      world.set_block_state(target, stone)
      world.predict_interaction_block_state(target, water, 1).should be_true
      feed = SpecFeed.new
      feed.bind(bot)
      feed.pull(0_u32, 0_u32).should be_nil

      feed.attach
      frame = viewer_frame(feed)
      frame.status.should eq("ready")
      frame.header["center"].as_a.map(&.as_i).should eq([-1, -1, -1])
      frame.header["eye"].as_a.map(&.as_f).should eq([bot.eyes.x, bot.eyes.y, bot.eyes.z])
      frame.header["yaw"].as_f.should eq(90.0)
      look = frame.header["look"].as_a.map(&.as_f)
      look[0].should be_close(-Math.sqrt(3) / 2, 0.00001)
      look[1].should be_close(0.5, 0.00001)
      look[2].should be_close(0, 0.00001)
      frame.header["air"].as_a.map(&.as_i).should eq(data.air_states.to_a.sort!)
      frame.position.should eq([-1, -1, -1])
      frame.kind.should eq("states")
      frame.data.size.should eq(8192)
      index = (2 * 16 + 3) * 16 + 1
      frame.state(index).should eq(stone)
      frame.state(index + 1).should eq(viewer_state("air", protocol))
      client.receive_block(target, water)
      world.block_state(target).should eq(water)
      frame.state(index).should eq(stone)
      feed.pull(frame.epoch, frame.seq).should be_nil
      feed.advance(49.milliseconds)
      feed.pull(frame.epoch, frame.seq).should be_nil
      feed.advance(1.millisecond)
      viewer_frame(feed, frame).seq.should eq(frame.seq + 1)
    end
  end

  it "updates rotation, eye position, and the section window without a bot tick" do
    client = FeedSpecClient.new
    client.player.feet = Rosegold::Vec3d::ORIGIN
    client.player.look = Rosegold::Look.new(15_f32, 0_f32)
    bot = Rosegold::Bot.new(client)
    bot.world.load_chunk(viewer_chunk(bot.world, 5, -1))
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    first = viewer_frame(feed)
    first.header["yaw"].as_f.should eq(15.0)
    first.header["center"].as_a.map(&.as_i).should eq([0, 0, 0])

    client.receive(Rosegold::Clientbound::PlayerRotation.new(135_f32, 0_f32))
    rotated = viewer_frame(feed, first)
    rotated.header["yaw"].as_f.should eq(135.0)
    rotated.header["look"].should_not eq(first.header["look"])
    rotated.header["section"]?.should be_nil

    client.receive(Rosegold::Clientbound::SynchronizePlayerPosition.new(80.5, 32.0, -15.5, 135_f32, 0_f32, 0, 1_u32))
    moved = viewer_frame(feed, rotated)
    moved.header["eye"].as_a.map(&.as_f).should eq([80.5, bot.eyes.y, -15.5])
    moved.header["eye"].should_not eq(rotated.header["eye"])
    moved.header["center"].as_a.map(&.as_i).should eq([5, 2, -1])
    moved.header["section"]?.should be_nil
    feed.pull(moved.epoch, moved.seq).should be_nil
    feed.advance
    viewer_frame(feed, moved).position.should eq([5, 2, -1])
  end

  it "sends the nearest populated section first even when closer sections are empty" do
    client = FeedSpecClient.new
    client.player.feet = Rosegold::Vec3d.new(0, 0, 0)
    bot = Rosegold::Bot.new(client)
    world = bot.world
    world.load_chunk(viewer_chunk(world, 0, 0))
    world.load_chunk(viewer_chunk(world, 2, 2))
    stone = viewer_state("stone")
    world.set_block_state(32, -32, 32, stone)
    world.set_block_state(0, -32, 0, stone)
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach

    first = viewer_frame(feed)
    first.position.should eq([0, -2, 0])
    first.kind.should eq("states")
    first.state(0).should eq(stone)
    feed.pull(first.epoch, first.seq).should be_nil
    feed.advance
    next_frame = viewer_frame(feed, first)
    next_frame.position.should eq([0, 0, 0])
    next_frame.kind.should eq("air")
  end

  it "keeps fluid-only sections and replaces populated sections with known air or unknown" do
    client = FeedSpecClient.new
    client.player.feet = Rosegold::Vec3d.new(0, 0, 0)
    bot = Rosegold::Bot.new(client)
    world = bot.world
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    water = viewer_state("water")
    client.receive(Rosegold::Clientbound::ChunkData.new(viewer_chunk(world, 0, 0, fluid_only: water)))
    frame = viewer_frame(feed)
    frame.kind.should eq("states")
    frame.state(0).should eq(water)

    client.receive(Rosegold::Clientbound::ChunkData.new(viewer_chunk(world, 0, 0)))
    feed.advance
    frame = viewer_frame(feed, frame)
    frame.position.should eq([0, 0, 0])
    frame.kind.should eq("air")
    frame.data.should be_empty

    client.receive(Rosegold::Clientbound::UnloadChunk.new(0, 0))
    feed.advance
    frame = viewer_frame(feed, frame)
    feed.advance
    frame = viewer_frame(feed, frame)
    frame.position.should eq([0, 0, 0])
    frame.kind.should eq("unloaded")
    frame.data.should be_empty
  end

  it "coalesces block and multi-block packets and sends the final replacement" do
    client = FeedSpecClient.new
    client.player.feet = Rosegold::Vec3d.new(0, 0, 0)
    bot = Rosegold::Bot.new(client)
    bot.world.load_chunk(viewer_chunk(bot.world, 0, 0))
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    first = viewer_frame(feed)
    first.kind.should eq("air")

    stone = viewer_state("stone")
    air = viewer_state("air")
    client.receive_block(Rosegold::Vec3i.new(0, 0, 0), stone)
    client.receive(Rosegold::Clientbound::MultiBlockChange.new(0, 0, 0, [{0, 0, 0, air}, {1, 0, 0, stone}]))
    feed.advance
    changed = viewer_frame(feed, first)
    changed.position.should eq([0, 0, 0])
    changed.state(0).should eq(air)
    changed.state(1).should eq(stone)
  end

  it "rotates through a bounded nearest-first baseline and repairs missed changes under dirty traffic" do
    client = FeedSpecClient.new
    client.player.feet = Rosegold::Vec3d.new(0, 0, 0)
    bot = Rosegold::Bot.new(client)
    world = bot.world
    world.load_chunk(viewer_chunk(world, 2, 2))
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    frame = viewer_frame(feed)
    positions = [frame.position]
    124.times do
      feed.advance
      frame = viewer_frame(feed, frame)
      positions << frame.position
    end
    positions.first.should eq([0, 0, 0])
    positions.uniq.size.should eq(125)
    positions.all? { |position| position.all? { |axis| axis.abs <= 2 } }.should be_true
    distances = positions.map { |position| position.sum { |axis| axis * axis } }
    distances.should eq(distances.sort)

    stone = viewer_state("stone")
    world.set_block_state(32, 32, 32, stone)
    repaired = false
    250.times do
      client.emit_event(Rosegold::Clientbound::BlockChange.new(Rosegold::Vec3i.new(0, 0, 0), stone))
      feed.advance
      frame = viewer_frame(feed, frame)
      next unless frame.position == [2, 2, 2]
      frame.kind.should eq("states")
      frame.state(0).should eq(stone)
      repaired = true
      break
    end
    repaired.should be_true

    client.player.feet = Rosegold::Vec3d.new(80, 0, 0)
    client.emit_event(Rosegold::Event::Tick.new)
    updated = viewer_frame(feed, frame)
    updated.header["center"].as_a.map(&.as_i).should eq([5, 0, 0])
    updated.header["section"]?.should be_nil
    feed.advance
    viewer_frame(feed, updated).position.should eq([5, 0, 0])
  end

  it "continues rotating refresh after the window moves one section" do
    client = FeedSpecClient.new
    client.player.feet = Rosegold::Vec3d.new(0, 0, 0)
    bot = Rosegold::Bot.new(client)
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    frame = viewer_frame(feed)
    125.times do
      feed.advance
      frame = viewer_frame(feed, frame)
    end
    frame.position.should eq([0, 0, 0])

    client.player.feet = Rosegold::Vec3d.new(16, 0, 0)
    client.emit_event(Rosegold::Event::Tick.new)
    25.times do
      feed.advance
      frame = viewer_frame(feed, frame)
      frame.position[0].should eq(3)
    end
    feed.advance
    viewer_frame(feed, frame).position.should eq([0, 0, 0])
  end

  it "invalidates cursors on lost responses and reattachment without bypassing copy pacing" do
    bot = Rosegold::Bot.new(FeedSpecClient.new)
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    first = viewer_frame(feed)
    fresh = viewer_frame(feed)
    fresh.epoch.should_not eq(first.epoch)
    fresh.seq.should eq(1)
    fresh.header["section"]?.should be_nil
    feed.detach
    feed.pull(fresh.epoch, fresh.seq).should be_nil
    feed.attach
    reopened = viewer_frame(feed, fresh)
    reopened.epoch.should_not eq(fresh.epoch)
    reopened.header["section"]?.should be_nil
    feed.advance
    viewer_frame(feed, reopened).position.should eq(reopened.header["center"].as_a.map(&.as_i))
  end

  it "clears generations on same-name respawn, login, reconfiguration and reconnect" do
    client = FeedSpecClient.new
    bot = Rosegold::Bot.new(client)
    feed = SpecFeed.new
    point = [Rosegold::Vec3i::ORIGIN]
    feed.bind(bot)
    feed.draw_path("route", point, color: 0_u32).should be_true
    feed.attach
    first = viewer_frame(feed)
    client.receive(viewer_respawn)
    respawned = viewer_frame(feed, first)
    respawned.epoch.should_not eq(first.epoch)
    respawned.status.should eq("waiting")
    respawned.header["center"]?.should be_nil
    respawned.header["paths"]?.should be_nil
    respawned.header["hud"]?.should be_nil

    client.resume_physics
    feed.draw_path("route", point, color: 0_u32).should be_true
    client.receive(viewer_login)
    logged_in = viewer_frame(feed, respawned)
    logged_in.epoch.should_not eq(respawned.epoch)
    logged_in.status.should eq("ready")
    logged_in.header["paths"].as_a.should be_empty

    feed.draw_path("route", point, color: 0_u32).should be_true
    client.receive(Rosegold::Clientbound::StartConfiguration.new)
    configuration = viewer_frame(feed, logged_in)
    configuration.epoch.should_not eq(logged_in.epoch)
    configuration.status.should eq("waiting")

    client.connection.disconnect("configuration finished")
    disconnected = viewer_frame(feed, configuration)
    disconnected.epoch.should_not eq(configuration.epoch)
    old = client.connection?.not_nil!
    client.replace_connection
    client.resume_physics
    replacement = viewer_frame(feed, disconnected)
    replacement.epoch.should_not eq(disconnected.epoch)
    replacement.status.should eq("ready")
    replacement.header["paths"].as_a.should be_empty
    feed.draw_path("route", point, color: 0_u32).should be_true
    drawn = viewer_frame(feed, replacement)
    client.emit_event(Rosegold::Event::Disconnected.new(old.close_reason.not_nil!))
    feed.pull(drawn.epoch, drawn.seq).should be_nil
    replacement_client = FeedSpecClient.new
    feed.bind(Rosegold::Bot.new(replacement_client))
    rebound = viewer_frame(feed, drawn)
    rebound.epoch.should_not eq(drawn.epoch)
    rebound.header["paths"].as_a.should be_empty
    client.connection.disconnect("old client")
    feed.pull(rebound.epoch, rebound.seq).should be_nil
  end

  it "keeps the old dimension out of the snapshot during a transfer" do
    client = FeedSpecClient.new
    bot = Rosegold::Bot.new(client)
    old_world = bot.world
    old_world.load_chunk(viewer_chunk(old_world, 0, 0))
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    first = viewer_frame(feed)
    first.kind.should eq("air")

    client.receive(Rosegold::Clientbound::StartConfiguration.new)
    client.receive(Rosegold::Clientbound::Transfer.new("localhost", 25565_u32))
    transferring = viewer_frame(feed, first)
    transferring.epoch.should_not eq(first.epoch)
    transferring.status.should eq("waiting")
    transferring.header["section"]?.should be_nil

    client.set_protocol_state(Rosegold::ProtocolState::PLAY)
    client.receive(viewer_login)
    client.resume_physics
    feed.advance
    arrived = viewer_frame(feed, transferring)
    arrived.epoch.should_not eq(transferring.epoch)
    arrived.status.should eq("ready")
    arrived.kind.should eq("unloaded")
  end

  it "removes only its own path hooks on a headless disconnect" do
    client = FeedSpecClient.new
    bot = Rosegold::Bot.new(client)
    feed = SpecFeed.new
    seen_disconnect = false
    client.on(Rosegold::Event::Disconnected) { seen_disconnect = true }
    before = client.event_handlers.values.sum(&.size)
    feed.bind(bot)
    feed.draw_path("route", [Rosegold::Vec3i::ORIGIN], color: 0_u32).should be_true
    client.connection.disconnect("headless disconnect")
    seen_disconnect.should be_true
    client.event_handlers.values.sum(&.size).should eq(before)

    client.replace_connection
    client.resume_physics
    feed.attach
    viewer_frame(feed).header["paths"].as_a.should be_empty
  end

  it "uses the new connection protocol for air states, item names, and dropped items" do
    client = FeedSpecClient.new
    feed = SpecFeed.new
    bot = Rosegold::Bot.new(client)
    feed.bind(bot)
    feed.attach
    previous = nil.as(ViewerFrame?)

    {777_u32, 775_u32}.each do |protocol|
      if previous
        client.replace_connection(protocol)
        client.resume_physics
        feed.advance
      end
      data = Rosegold::MCData.for(protocol)
      item = data.items.find! { |entry| entry.name == "diamond_pickaxe" }
      item_id = protocol == 775 ? 71_u32 : 72_u32
      slot = Rosegold::Slot.new(1_u32, item.id)
      selected = protocol == 775 ? 2_u32 : 3_u32
      client.player_inventory[selected.to_i] = slot
      Rosegold::Client.protocol_version = protocol
      begin
        client.receive_wire(Rosegold::Clientbound::HeldItemChange) { |packet| packet.write(selected) }
      ensure
        Rosegold::Client.reset_protocol_version!
      end
      entity = Rosegold::Entity.new(9_u32, UUID.random, item_id, Rosegold::Vec3d::ORIGIN, 0_f32, 0_f32, 0_f32, Rosegold::Vec3d::ORIGIN)
      entity.tracked_data[8_u8] = slot
      bot.world.entities[9_u64] = entity

      frame = previous ? viewer_frame(feed, previous) : viewer_frame(feed)
      frame.status.should eq("ready")
      frame.header["protocol"].as_i.should eq(protocol)
      frame.header["air"].as_a.map(&.as_i).should eq(data.air_states.to_a.sort!)
      frame.header["hud"]["selected"].as_i.should eq(selected)
      frame.header["hud"]["slots"][selected.to_i]["item"].as_s.should eq(item.name)
      frame.header["entities"][0]["item"]["name"].as_s.should eq(item.name)
      frame.epoch.should_not eq(previous.epoch) if previous
      previous = frame
    end
  end

  {775_u32, 777_u32}.each do |protocol|
    it "reports a pack mismatch for #{protocol} without touching pose or terrain" do
      client = FeedSpecClient.new(protocol)
      bot = FeedSpecBot.new(client)
      bot.fail_pose = true
      pack_protocol = protocol == 775 ? 777.0 : 775.0
      feed = SpecFeed.new(pack_protocol)
      feed.bind(bot)
      feed.attach
      frame = viewer_frame(feed)
      frame.status.should eq("pack_mismatch")
      frame.header["protocol"].as_i.should eq(protocol)
      frame.header["packProtocol"].as_f.should eq(pack_protocol)
      frame.header["control"]?.should be_nil
      frame.header["eye"]?.should be_nil
      frame.header["section"]?.should be_nil
      frame.data.should be_empty
      feed.failure.should be_nil
    end
  end

  it "reports unsupported without touching pose or terrain" do
    client = FeedSpecClient.new(776_u32)
    bot = FeedSpecBot.new(client)
    bot.fail_pose = true
    feed = SpecFeed.new
    feed.bind(bot)
    feed.draw_path("route", [Rosegold::Vec3i::ORIGIN], color: 0_u32).should be_false
    feed.attach
    client.emit_event(Rosegold::Event::Tick.new)
    frame = viewer_frame(feed)
    frame.status.should eq("unsupported")
    frame.header["eye"]?.should be_nil
    frame.header["section"]?.should be_nil
    frame.header["hud"]?.should be_nil
    feed.failure.should be_nil
  end

  it "detaches only its own hooks after a packet hook fault" do
    client = FeedSpecClient.new
    bot = Rosegold::Bot.new(client)
    world = bot.world
    world.load_chunk(viewer_chunk(world, 0, 0))
    feed = SpecFeed.new
    feed.bind(bot)
    feed.attach
    frame = viewer_frame(feed)
    feed.fail_dirty = true
    observer = 0
    client.on(Rosegold::Clientbound::BlockChange) { observer += 1 }
    point = Rosegold::Vec3i.new(0, 0, 0)
    stone = viewer_state("stone")
    client.receive_block(point, stone)
    world.block_state(point).should eq(stone)
    observer.should eq(1)
    feed.failure.try(&.message).should eq("viewer dirty error")
    feed.pull(frame.epoch, frame.seq).should be_nil
    client.event_handlers[Rosegold::Clientbound::BlockChange].size.should eq(1)
    client.receive_block(point, viewer_state("air"))
    observer.should eq(2)
    world.block_state(point).should eq(viewer_state("air"))
    client.connection.open?.should be_true
    client.start_ticker
    begin
      client.await_tick_end.should be_true
    ensure
      client.stop_ticker
    end
  end

  it "continues physics, ticker output, and packet processing after a pull faults" do
    client = FeedSpecClient.new
    bot = FeedSpecBot.new(client)
    world = bot.world
    world.load_chunk(viewer_chunk(world, 0, 0))
    feed = SpecFeed.new
    feed.bind(bot)
    ticks = 0
    client.on(Rosegold::Event::PhysicsTick) { ticks += 1 }
    baseline = client.event_handlers.values.sum(&.size)
    feed.attach
    frame = viewer_frame(feed)
    client.start_ticker
    begin
      client.await_tick_end.should be_true
      bot.fail_pose = true
      feed.pull(frame.epoch, frame.seq).should be_nil
      feed.failure.try(&.message).should eq("viewer pose error")
      client.event_handlers.values.sum(&.size).should eq(baseline)
      ticks_before = ticks
      client.await_tick_end.should be_true
      ticks.should be > ticks_before
      point = Rosegold::Vec3i.new(0, 0, 0)
      stone = viewer_state("stone")
      client.receive_block(point, stone)
      world.block_state(point).should eq(stone)
      client.connection.open?.should be_true
    ensure
      client.stop_ticker
    end
  end
end
