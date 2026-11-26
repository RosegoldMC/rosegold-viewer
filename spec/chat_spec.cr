require "spec"
require "http/client"
require "rosegold"
require "../src/rosegold-viewer"

private class GatedSink < IO
  getter memory = IO::Memory.new
  property gate : Channel(Nil)?
  getter entered = Channel(Nil).new(1)

  def read(slice : Bytes)
    0
  end

  def write(slice : Bytes) : Nil
    if gate = @gate
      @gate = nil
      entered.send(nil)
      gate.receive
    end
    memory.write slice
  end
end

private class GatedChatSpecClient < Rosegold::Client
  getter sink = GatedSink.new

  def initialize
    super("127.0.0.1")
    @connection = Rosegold::Connection::Client.new(Minecraft::IO::Wrap.new(sink), Rosegold::ProtocolState::PLAY, 777_u32, self)
    set_protocol_state(Rosegold::ProtocolState::PLAY)
    physics.unpause_for_spawn_chunk
    player.feet = Rosegold::Vec3d.new(0, 0, 0)
  end
end

private class ChatSpecClient < Rosegold::Client
  getter output = Minecraft::IO::Memory.new

  def initialize
    super("127.0.0.1")
    @connection = Rosegold::Connection::Client.new(output, Rosegold::ProtocolState::PLAY, 777_u32, self)
    set_protocol_state(Rosegold::ProtocolState::PLAY)
    physics.unpause_for_spawn_chunk
    player.feet = Rosegold::Vec3d.new(0, 0, 0)
  end

  def resume_physics : Nil
    physics.unpause_for_spawn_chunk
  end

  def forward_pressed? : Bool
    physics.keys.forward?
  end
end

private def chat_post(pairing, path, token, body = "", origin = pairing.url)
  HTTP::Client.post(pairing.url + path, headers: HTTP::Headers{
    "Origin"        => origin,
    "Authorization" => "Bearer #{token}",
    "Content-Type"  => "application/json",
  }, body: body)
end

private def chat_pair(pairing) : String
  reply = chat_post(pairing, "/session", pairing.secret)
  reply.status.should eq(HTTP::Status::OK)
  JSON.parse(reply.body)["lease"].as_s
end

private def chat_pull(pairing, lease, previous : JSON::Any? = nil, input = nil) : JSON::Any
  epoch = previous.try { |frame| frame["epoch"].as_i64 } || 0
  sequence = previous.try { |frame| frame["seq"].as_i64 } || 0
  payload = input ? {epoch: epoch, seq: sequence, i: input}.to_json : {epoch: epoch, seq: sequence}.to_json
  reply = chat_post(pairing, "/next", lease, payload)
  reply.status.should eq(HTTP::Status::OK)
  reply.body.bytesize.should be <= 16 * 1024
  io = IO::Memory.new(reply.body.to_slice)
  JSON.parse(io.read_string(io.read_bytes(UInt16, IO::ByteFormat::LittleEndian)))
end

private def chat_lines(frame) : Array(String)
  frame["chat"]["entries"].as_a.map { |entry| entry[1].as_s }
end

private def chat_text(text) : Rosegold::TextComponent
  Rosegold::TextComponent.new(text)
end

describe "Viewer chat" do
  it "streams plain chat without overlays or filtered content and replays bounded history without crossing leases" do
    client = ChatSpecClient.new
    host = RosegoldViewer::Host.new
    host.bind(Rosegold::Bot.new(client))
    pairing = host.enable.not_nil!
    client.emit_event Rosegold::Clientbound::SystemChatMessage.new(chat_text("before lease"))
    lease = chat_pair(pairing)
    chat_types = Rosegold::Clientbound::RegistryData.new("minecraft:chat_type", [
      {id: "minecraft:chat", data: nil}, {id: "minecraft:msg_command_incoming", data: nil},
    ] of Rosegold::Clientbound::RegistryData::RegistryEntry)
    chat_types.callback(client)
    client.emit_event Rosegold::Clientbound::SystemChatMessage.new(chat_text("hello\nworld"))
    client.emit_event Rosegold::Clientbound::SystemChatMessage.new(chat_text("overlay"), true)
    client.emit_event Rosegold::Clientbound::DisguisedChatMessage.new(chat_text("<em>plain</em>"), 0_u32, chat_text("Sender"), nil)
    client.emit_event Rosegold::Clientbound::PlayerChatMessage.new(
      0_u32, UUID.random, 0_u32, Bytes.new(256), "signed", 0_i64, 0_i64, [] of Bytes,
      chat_text("unsigned display"), 0_u32, nil, 1_u32, chat_text("Player"), nil
    )
    client.emit_event Rosegold::Clientbound::PlayerChatMessage.new(
      0_u32, UUID.random, 0_u32, nil, "filtered", 0_i64, 0_i64, [] of Bytes,
      nil, 1_u32, nil, 1_u32, chat_text("Player"), nil
    )
    client.emit_event Rosegold::Clientbound::PlayerChatMessage.new(
      0_u32, UUID.random, 0_u32, nil, "other chat types are not ordinary chat", 0_i64, 0_i64, [] of Bytes,
      nil, 0_u32, nil, 3_u32, chat_text("Player"), nil
    )
    first = chat_pull(pairing, lease)
    chat_lines(first).should eq(["hello world", "[Disguised chat] Sender: <em>plain</em>", "<Player> unsigned display"])
    replay = chat_pull(pairing, lease)
    replay["epoch"].should_not eq(first["epoch"])
    replay["chat"].should eq(first["chat"])

    52.times { |index| client.emit_event Rosegold::Clientbound::SystemChatMessage.new(chat_text("line #{index}")) }
    bounded = chat_pull(pairing, lease)
    chat_lines(bounded).should eq(["line 4", "line 5", "line 6"])
    chat_lines(chat_pull(pairing, lease, bounded)).should eq(["line 7", "line 8", "line 9"])

    fresh_lease = chat_pair(pairing)
    fresh = chat_pull(pairing, fresh_lease)
    fresh["chat"]["epoch"].should_not eq(first["chat"]["epoch"])
    chat_lines(fresh).should be_empty

    client.emit_event Rosegold::Clientbound::SystemChatMessage.new(chat_text("old world"))
    respawn = Rosegold::Clientbound::Respawn.new(
      0_u32, "minecraft:overworld", 0_i64, 0_u8, -1_i8,
      false, false, false, nil, nil, 0_u32, 63_u32, 0_u8
    )
    respawn.callback(client)
    client.emit_event(respawn)
    client.resume_physics
    client.emit_event Rosegold::Clientbound::SystemChatMessage.new(chat_text("new world"))
    changed_world = chat_pull(pairing, fresh_lease, fresh)
    changed_world["chat"]["epoch"].should_not eq(fresh["chat"]["epoch"])
    chat_lines(changed_world).should eq(["new world"])

    replacement = ChatSpecClient.new
    host.bind(Rosegold::Bot.new(replacement))
    rebound = chat_pull(pairing, fresh_lease, changed_world)
    rebound["chat"]["epoch"].should_not eq(changed_world["chat"]["epoch"])
    chat_lines(rebound).should be_empty
  ensure
    host.try &.disable
    replacement.try(&.connection?).try &.disconnect("End of viewer chat spec")
    client.try(&.connection?).try &.disconnect("End of viewer chat spec")
  end

  it "authenticates the chat route and preserves the smaller control body cap" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    lease = chat_pair(pairing)
    body = {epoch: 1, grant: 1, id: 1, text: "🧊" * 64}.to_json
    chat_post(pairing, "/next", lease, body).status.should eq(HTTP::Status::PAYLOAD_TOO_LARGE)
    chat_post(pairing, "/chat", lease, " " * 1601).status.should eq(HTTP::Status::PAYLOAD_TOO_LARGE)
    chat_post(pairing, "/chat", lease, body, "http://127.0.0.1").status.should eq(HTTP::Status::FORBIDDEN)
    chat_post(pairing, "/chat", pairing.secret, body).status.should eq(HTTP::Status::UNAUTHORIZED)
    chat_post(pairing, "/chat", lease, body).status.should eq(HTTP::Status::CONFLICT)
    ["", "/", " /  ", "\nmuted", "bad\u0085space", "bad\u202Eorder", "§a Color", "🧊" * 65].each do |text|
      bad = {epoch: 1, grant: 1, id: 1, text: text}.to_json
      chat_post(pairing, "/chat", lease, bad).status.should eq(HTTP::Status::BAD_REQUEST)
    end
  ensure
    host.try &.disable
  end

  it "labels pass-through whispers and never exposes filtered or partially filtered ones" do
    client = ChatSpecClient.new
    host = RosegoldViewer::Host.new
    host.bind(Rosegold::Bot.new(client))
    pairing = host.enable.not_nil!
    lease = chat_pair(pairing)
    Rosegold::Clientbound::RegistryData.new("minecraft:chat_type", [
      {id: "minecraft:chat", data: nil}, {id: "minecraft:msg_command_incoming", data: nil}, {id: "minecraft:msg_command_outgoing", data: nil},
    ] of Rosegold::Clientbound::RegistryData::RegistryEntry).callback(client)
    whisper = ->(text : String, filter : UInt32, mask : Bytes?, type : UInt32, target : Rosegold::TextComponent?) do
      client.emit_event Rosegold::Clientbound::PlayerChatMessage.new(
        0_u32, UUID.random, 0_u32, nil, text, 0_i64, 0_i64, [] of Bytes, nil, filter, mask, type, chat_text("Eve"), target
      )
    end
    whisper.call("secret full", 1_u32, nil, 2_u32, nil)
    whisper.call("secret partial", 2_u32, Bytes.new(8), 2_u32, nil)
    whisper.call("psst", 0_u32, nil, 2_u32, nil)
    whisper.call("hi bob", 0_u32, nil, 3_u32, chat_text("Bob"))
    client.emit_event Rosegold::Clientbound::DisguisedChatMessage.new(chat_text("ping"), 2_u32, chat_text("Eve"), nil)
    client.emit_event Rosegold::Clientbound::DisguisedChatMessage.new(chat_text("pong"), 3_u32, chat_text("Me"), chat_text("Bob"))
    whispers = chat_pull(pairing, lease)
    chat_lines(whispers).should eq(["[Whisper from Eve] psst", "[Whisper to Bob] hi bob", "[Whisper from Eve] ping"])
    chat_lines(chat_pull(pairing, lease, whispers)).should eq(["[Whisper to Bob] pong"])
  ensure
    host.try &.disable
  end

  {% if Rosegold::Client.has_method?(:manual_control) && !Rosegold::ChatManager.has_method?(:try_send_message) %}
    it "reports a read-only core as unable to chat and refuses chat posts" do
      client = ChatSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = chat_pair(pairing)
      bot.manual_control = true
      frame = chat_pull(pairing, lease)
      frame["control"]["chatSupported"].as_bool.should be_false
      frame["control"]["canChat"]?.should be_nil
      grant = frame["control"]["grant"].as_i
      body = {epoch: frame["epoch"].as_i, grant: grant, id: 1, text: "/list"}.to_json
      chat_post(pairing, "/chat", lease, body).status.should eq(HTTP::Status::CONFLICT)
    ensure
      host.try &.disable
    end
  {% end %}
  {% if Rosegold::Client.has_method?(:manual_control) && Rosegold::ChatManager.has_method?(:try_send_message) %}
    it "neutralizes native input on compose and sends at most one ordinary chat packet" do
      client = ChatSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = chat_pair(pairing)
      bot.manual_control = true
      frame = chat_pull(pairing, lease)
      grant = frame["control"]["grant"].as_i
      epoch = frame["epoch"].as_i
      body = {epoch: epoch, grant: grant, id: 1, text: "  local test  "}.to_json
      chat_post(pairing, "/chat", lease, body).status.should eq(HTTP::Status::CONFLICT)
      frame = chat_pull(pairing, lease, frame, [grant, 1, 1, 0, 0, 0, 0, -1])
      {% if Rosegold::ManualControl.has_method?(:ice_road?) %}
        taps = 8
      {% else %}
        taps = 0
      {% end %}
      frame = chat_pull(pairing, lease, frame, [grant, 2, 1, 1, 0, 0, taps, -1])
      client.manual_control.before_tick
      client.manual_control.after_tick
      client.forward_pressed?.should be_true
      {% if Rosegold::ManualControl.has_method?(:ice_road?) %}
        client.manual_control.ice_road?.should be_true
      {% end %}
      frame = chat_pull(pairing, lease, frame, [grant, 3, 9])
      frame["control"]["canChat"].as_bool.should be_true
      client.forward_pressed?.should be_false
      {% if Rosegold::ManualControl.has_method?(:ice_road?) %}
        client.manual_control.ice_road?.should be_false
      {% end %}
      frame = chat_pull(pairing, lease, frame, [grant, 4, 1, 1, 0, 0, 0, -1])
      frame["control"]["canChat"].as_bool.should be_true
      client.manual_control.before_tick
      client.manual_control.after_tick
      client.forward_pressed?.should be_false

      start = client.output.size
      chat_post(pairing, "/chat", lease, body).status.should eq(HTTP::Status::NO_CONTENT)
      packets = Minecraft::IO::Memory.new(client.output.to_slice[start..])
      packets.read_var_int
      packets.read_var_int.should eq(Rosegold::Serverbound::ChatMessage.packet_id_for_protocol(777_u32))
      packets.read_var_string.should eq("local test")
      end_position = client.output.size
      chat_post(pairing, "/chat", lease, body).status.should eq(HTTP::Status::CONFLICT)
      second = {epoch: epoch, grant: grant, id: 2, text: "second"}.to_json
      chat_post(pairing, "/chat", lease, second).status.should eq(HTTP::Status::TOO_MANY_REQUESTS)
      client.output.size.should eq(end_position)
      {% if Rosegold::ChatManager.has_method?(:try_send_command) %}
        sleep 1.1.seconds
        command = {epoch: epoch, grant: grant, id: 3, text: "  /list  "}.to_json
        chat_post(pairing, "/chat", lease, command).status.should eq(HTTP::Status::NO_CONTENT)
        packets = Minecraft::IO::Memory.new(client.output.to_slice[end_position..])
        packets.read_var_int
        packets.read_var_int.should eq(Rosegold::Serverbound::ChatCommand.packet_id_for_protocol(777_u32))
        packets.read_var_string.should eq("list")
        end_position = client.output.size
        chat_post(pairing, "/chat", lease, command).status.should eq(HTTP::Status::CONFLICT)
        client.output.size.should eq(end_position)
      {% end %}

      frame = chat_pull(pairing, lease, frame, [grant, 5, 0])
      frame["control"]["canChat"]?.should be_nil
      chat_post(pairing, "/chat", lease, second).status.should eq(HTTP::Status::CONFLICT)
      chat_pair(pairing)
      chat_post(pairing, "/chat", lease, second).status.should eq(HTTP::Status::UNAUTHORIZED)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer chat spec")
    end
  {% end %}
  {% if Rosegold::ChatManager.has_method?(:try_send_message) %}
    it "refuses a browser message when the writer is contended and a later send succeeds" do
      client = GatedChatSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = chat_pair(pairing)
      bot.manual_control = true
      frame = chat_pull(pairing, lease)
      grant = frame["control"]["grant"].as_i
      epoch = frame["epoch"].as_i
      frame = chat_pull(pairing, lease, frame, [grant, 1, 1, 0, 0, 0, 0, -1])
      frame = chat_pull(pairing, lease, frame, [grant, 2, 1, 1, 0, 0, 0, -1])
      frame = chat_pull(pairing, lease, frame, [grant, 3, 9])
      frame["control"]["canChat"].as_bool.should be_true

      gate = Channel(Nil).new
      client.sink.gate = gate
      done = Channel(Nil).new
      spawn do
        client.send_packet! Rosegold::Serverbound::ClientTickEnd.new
        done.send(nil)
      end
      client.sink.entered.receive
      size = client.sink.memory.size
      first = {epoch: epoch, grant: grant, id: 1, text: "stale"}.to_json
      chat_post(pairing, "/chat", lease, first).status.should eq(HTTP::Status::SERVICE_UNAVAILABLE)
      gate.send(nil)
      done.receive
      after_ordinary = client.sink.memory.size
      after_ordinary.should be > size

      sleep 1.1.seconds
      second = {epoch: epoch, grant: grant, id: 2, text: "fresh"}.to_json
      chat_post(pairing, "/chat", lease, second).status.should eq(HTTP::Status::NO_CONTENT)
      client.sink.memory.size.should be > after_ordinary
      String.new(client.sink.memory.to_slice).should_not contain("stale")
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer chat spec")
    end
    it "bounds a stalled admitted chat write so viewer posts stay available" do
      client = GatedChatSpecClient.new
      bot = Rosegold::Bot.new(client)
      host = RosegoldViewer::Host.new
      host.bind(bot)
      pairing = host.enable.not_nil!
      lease = chat_pair(pairing)
      bot.manual_control = true
      frame = chat_pull(pairing, lease)
      grant = frame["control"]["grant"].as_i
      epoch = frame["epoch"].as_i
      frame = chat_pull(pairing, lease, frame, [grant, 1, 1, 0, 0, 0, 0, -1])
      frame = chat_pull(pairing, lease, frame, [grant, 2, 1, 1, 0, 0, 0, -1])
      frame = chat_pull(pairing, lease, frame, [grant, 3, 9])

      gate = Channel(Nil).new
      client.sink.gate = gate
      started = Time.instant
      first = {epoch: epoch, grant: grant, id: 1, text: "stalled"}.to_json
      chat_post(pairing, "/chat", lease, first).status.should eq(HTTP::Status::GATEWAY_TIMEOUT)
      (Time.instant - started).should be < 2.seconds
      client.sink.entered.receive
      sleep 1.1.seconds
      second = {epoch: epoch, grant: grant, id: 2, text: "again"}.to_json
      chat_post(pairing, "/chat", lease, second).status.should eq(HTTP::Status::SERVICE_UNAVAILABLE)
      next_status = chat_post(pairing, "/next", lease, {epoch: frame["epoch"].as_i64, seq: frame["seq"].as_i64}.to_json).status
      [HTTP::Status::OK, HTTP::Status::NO_CONTENT].should contain(next_status)
      client.connection.open?.should be_true
      gate.send(nil)
      sleep 1.1.seconds
      third = {epoch: epoch, grant: grant, id: 3, text: "later"}.to_json
      chat_post(pairing, "/chat", lease, third).status.should eq(HTTP::Status::NO_CONTENT)
    ensure
      host.try &.disable
      client.try(&.connection?).try &.disconnect("End of viewer chat spec")
    end
  {% end %}
end
