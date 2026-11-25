require "./spec_helper"

class ViewerSpecSink < IO
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

class ViewerSpecClient < Rosegold::Client
  getter sink = ViewerSpecSink.new

  def initialize
    super("localhost", offline: {uuid: "00000000-0000-0000-0000-000000000000", username: "viewerspec"})
    @connection = Rosegold::Connection::Client.new(Minecraft::IO::Wrap.new(sink), Rosegold::ProtocolState::PLAY, protocol_version, self)
    set_protocol_state(Rosegold::ProtocolState::PLAY)
    physics.unpause_for_spawn_chunk
    player.feet = Rosegold::Vec3d.new(0, 0, 0)
  end

  def close_windows : Array(Bytes)
    io = Minecraft::IO::Memory.new(sink.memory.to_slice.dup)
    frames = [] of Bytes
    close_id = Rosegold::Serverbound::CloseWindow.packet_id_for_protocol(protocol_version)
    while io.pos < io.size
      payload = Bytes.new(io.read_var_int)
      io.read_fully(payload)
      frames << payload if payload[0] == close_id
    end
    frames
  end
end

module RosegoldViewer
  def self.spec_controller(bot : Rosegold::Bot) : ManualController
    ManualController.new(777_u32).tap do |controller|
      controller.bind(bot)
      controller.enable
    end
  end

  def self.spec_input(controller : ManualController, grant : UInt32, sequence : UInt32, kind : InputKind, data = StaticArray(Int64, 5).new(0_i64)) : Nil
    controller.receive(Input.new(grant, sequence, kind, data), nil)
  end

  def self.spec_inventory_ready(client : ViewerSpecClient, bot : Rosegold::Bot) : Bool
    controller = spec_controller(bot)
    client.manual_control.grant.should_not be_nil
    snapshot = controller.snapshot.not_nil!
    spec_input(controller, snapshot[:grant], 1_u32, InputKind::Inventory)
    controller.snapshot.not_nil![:inventory].not_nil![:ready]
  end

  def self.spec_close_replaced_chest(client : ViewerSpecClient, bot : Rosegold::Bot) : Tuple(Int32, String)
    title = Rosegold::Chat.new("Chest")
    chest = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
    client.container_menu = chest
    controller = spec_controller(bot)
    client.manual_control.grant.should_not be_nil
    snapshot = controller.snapshot.not_nil!
    identity = snapshot[:inventory].not_nil![:menu].to_i64
    spec_input(controller, snapshot[:grant], 1_u32, InputKind::CloseInventory, StaticArray(Int64, 5).new { |index| index.zero? ? identity : 0_i64 })
    gate = Channel(Nil).new
    client.sink.gate = gate
    done = Channel(Nil).new
    spawn do
      client.send_packet! Rosegold::Serverbound::ClientTickEnd.new
      done.send(nil)
    end
    client.sink.entered.receive
    ticked = Channel(Nil).new
    spawn do
      controller.tick
      ticked.send(nil)
    end
    Fiber.yield
    client.container_menu = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
    gate.send(nil)
    done.receive
    ticked.receive
    {client.close_windows.size, controller.snapshot.not_nil![:mode]}
  end

  def self.spec_blocked_chest_close(client : ViewerSpecClient, bot : Rosegold::Bot, carried : Bool) : Tuple(Int32, Bool, String)
    title = Rosegold::Chat.new("Chest")
    chest = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
    client.container_menu = chest
    controller = spec_controller(bot)
    client.manual_control.grant.should_not be_nil
    snapshot = controller.snapshot.not_nil!
    identity = snapshot[:inventory].not_nil![:menu].to_i64
    chest.cursor = Rosegold::Slot.new(1_u32, Rosegold::MCData.default.items.find! { |item| item.name == "stone" }.id.to_u32) if carried
    spec_input(controller, snapshot[:grant], 1_u32, InputKind::CloseInventory, StaticArray(Int64, 5).new { |index| index.zero? ? identity : 0_i64 })
    gate = Channel(Nil).new
    client.sink.gate = gate
    done = Channel(Nil).new
    spawn do
      client.send_packet! Rosegold::Serverbound::ClientTickEnd.new
      done.send(nil)
    end
    client.sink.entered.receive
    ticked = Channel(Nil).new
    spawn do
      controller.tick
      ticked.send(nil)
    end
    Fiber.yield
    client.container_menu = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
    controller.menu_changed
    gate.send(nil)
    done.receive
    ticked.receive
    after = controller.snapshot.not_nil!
    {client.close_windows.size, after[:canReturn], after[:mode]}
  end

  def self.spec_stale_close_after_rebind(a : ViewerSpecClient, b : ViewerSpecClient, bot_a : Rosegold::Bot, bot_b : Rosegold::Bot) : Tuple(UInt32, UInt32, UInt32, Int32, Int32)
    controller = spec_controller(bot_a)
    a.manual_control.grant.should_not be_nil
    grant = controller.snapshot.not_nil![:grant]
    spec_input(controller, grant, 1_u32, InputKind::Inventory)
    spec_input(controller, grant, 2_u32, InputKind::CloseInventory)
    gate = Channel(Nil).new
    a.sink.gate = gate
    done = Channel(Nil).new
    spawn do
      a.send_packet! Rosegold::Serverbound::ClientTickEnd.new
      done.send(nil)
    end
    a.sink.entered.receive
    ticked = Channel(Nil).new
    spawn do
      controller.tick
      ticked.send(nil)
    end
    deadline = Time.instant + 2.seconds
    until a.connection.@writers.get > 1
      raise "A's close never reached the writer" if Time.instant > deadline
      sleep 1.millisecond
    end

    controller.bind(bot_b)
    controller.enable
    b.manual_control.grant.should_not be_nil
    grant_b = controller.snapshot.not_nil![:grant]
    spec_input(controller, grant_b, 1_u32, InputKind::Inventory)
    spec_input(controller, grant_b, 2_u32, InputKind::CloseInventory)
    spec_input(controller, grant_b, 3_u32, InputKind::Pause)
    b_gate = Channel(Nil).new
    b.sink.gate = b_gate
    b_done = Channel(Nil).new
    spawn do
      controller.tick
      b_done.send(nil)
    end
    select
    when b.sink.entered.receive
    when timeout(2.seconds)
      raise "B's close never reached its writer"
    end
    before = controller.snapshot.not_nil![:ack]
    gate.send(nil)
    select
    when done.receive
    when timeout(2.seconds)
      raise "A's writer never released"
    end
    select
    when ticked.receive
    when timeout(2.seconds)
      raise "A's stale tick never finished"
    end
    stale = controller.snapshot.not_nil![:ack]
    a_closes = a.close_windows.size
    b_gate.send(nil)
    select
    when b_done.receive
    when timeout(2.seconds)
      raise "B's tick never finished"
    end
    {before, stale, controller.snapshot.not_nil![:ack], a_closes, b.close_windows.size}
  end

  # Pauses the sink inside the real write of the queued packet, then changes the menu and optionally the wire grant.
  def self.spec_flush_with_replacement(client : ViewerSpecClient, bot : Rosegold::Bot, kind : Symbol, resync : Bool) : Tuple(Bool, String, Int32)
    title = Rosegold::Chat.new("Chest")
    chest = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
    client.container_menu = chest
    Rosegold::Clientbound::SetContainerContent.new(chest.id.to_u32, 0_u32, chest.slots, Rosegold::WindowSlot.new(-1, chest.cursor)).callback(client)
    controller = spec_controller(bot)
    client.manual_control.grant.should_not be_nil
    snapshot = controller.snapshot.not_nil![:inventory].not_nil!
    grant = controller.snapshot.not_nil![:grant]
    if kind == :click
      data = StaticArray(Int64, 5).new(0_i64)
      data[0] = snapshot[:menu].to_i64
      data[1] = snapshot[:revision].to_i64
      spec_input(controller, grant, 1_u32, InputKind::Click, StaticArray(Int64, 5).new { |index| {snapshot[:menu].to_i64, snapshot[:revision].to_i64, 1_i64, 0_i64, 0_i64}[index] })
    else
      spec_input(controller, grant, 1_u32, InputKind::CloseInventory, StaticArray(Int64, 5).new { |index| index.zero? ? snapshot[:menu].to_i64 : 0_i64 })
    end
    gate = Channel(Nil).new
    client.sink.gate = gate
    ticked = Channel(Nil).new
    spawn do
      controller.tick
      ticked.send(nil)
    end
    client.sink.entered.receive
    client.container_menu = Rosegold::ChestMenu.new(client, 1_u8, title, 1)
    controller.menu_changed
    controller.resynchronize if resync
    gate.send(nil)
    ticked.receive
    after = controller.snapshot.not_nil!
    {after[:canReturn], after[:mode], client.close_windows.size}
  end

  def self.spec_pause_behind_close(client : ViewerSpecClient, bot : Rosegold::Bot) : Tuple(UInt32, UInt32)
    controller = spec_controller(bot)
    client.manual_control.grant.should_not be_nil
    grant = controller.snapshot.not_nil![:grant]
    spec_input(controller, grant, 1_u32, InputKind::Inventory)
    spec_input(controller, grant, 2_u32, InputKind::CloseInventory)
    spec_input(controller, grant, 3_u32, InputKind::Pause)
    waiting = controller.snapshot.not_nil![:ack]
    controller.tick
    {waiting, controller.snapshot.not_nil![:ack]}
  end

  def self.spec_close_player_inventory(client : ViewerSpecClient, bot : Rosegold::Bot, change : Symbol? = nil) : Int32
    controller = spec_controller(bot)
    client.manual_control.grant.should_not be_nil
    snapshot = controller.snapshot.not_nil!
    spec_input(controller, snapshot[:grant], 1_u32, InputKind::Inventory)
    controller.snapshot.not_nil![:mode].should eq "inventory"
    spec_input(controller, snapshot[:grant], 2_u32, InputKind::CloseInventory)
    gate = Channel(Nil).new
    client.sink.gate = gate
    done = Channel(Nil).new
    spawn do
      client.send_packet! Rosegold::Serverbound::ClientTickEnd.new
      done.send(nil)
    end
    client.sink.entered.receive
    ticked = Channel(Nil).new
    spawn do
      controller.tick
      ticked.send(nil)
    end
    Fiber.yield
    case change
    when :resync then controller.resynchronize
    when :menu   then controller.menu_changed
    when :revoke then client.manual_control.revoke
    end
    gate.send(nil)
    done.receive
    ticked.receive
    client.close_windows.size
  end
end

describe RosegoldViewer do
  it "writes a player inventory close while the grant is unchanged" do
    client = ViewerSpecClient.new
    bot = Rosegold::Bot.new(client)
    closes = RosegoldViewer.spec_close_player_inventory(client, bot)
    closes.should eq 1
  end

  it "drops a blocked close when the wire grant rotates before the write" do
    client = ViewerSpecClient.new
    bot = Rosegold::Bot.new(client)
    closes = RosegoldViewer.spec_close_player_inventory(client, bot, :resync)
    closes.should eq 0
  end

  it "drops a blocked close when the window opening generation changes before the write" do
    client = ViewerSpecClient.new
    bot = Rosegold::Bot.new(client)
    closes = RosegoldViewer.spec_close_player_inventory(client, bot, :menu)
    closes.should eq 0
  end

  it "drops a blocked close when the grant ends before the write" do
    client = ViewerSpecClient.new
    bot = Rosegold::Bot.new(client)
    closes = RosegoldViewer.spec_close_player_inventory(client, bot, :revoke)
    closes.should eq 0
  end

  it "never reports inventory clicks as ready without guarded core clicks" do
    client = ViewerSpecClient.new
    bot = Rosegold::Bot.new(client)
    ready = RosegoldViewer.spec_inventory_ready(client, bot)
    {% unless Rosegold::Menu.has_method?(:send_click_if!) %}
      ready.should be_false
    {% end %}
  end

  {% if Rosegold::ContainerMenu.has_method?(:close_if!) %}
    it "refuses a close and keeps the replacement's mode when a same-window chest replaces the menu behind the writer" do
      client = ViewerSpecClient.new
      bot = Rosegold::Bot.new(client)
      closes, mode = RosegoldViewer.spec_close_replaced_chest(client, bot)
      closes.should eq 0
      mode.should eq "inventory"
    end
  {% end %}

  it "does not let a stale close completion from a rebound client drain the new grant's ack" do
    a = ViewerSpecClient.new
    b = ViewerSpecClient.new
    before, stale, final, a_closes, b_closes = RosegoldViewer.spec_stale_close_after_rebind(a, b, Rosegold::Bot.new(a), Rosegold::Bot.new(b))
    {before, stale, final}.should eq({1_u32, 1_u32, 3_u32})
    a_closes.should eq 0
    b_closes.should eq 1
  end

  it "does not acknowledge a pause across an unresolved queued close until it is decided" do
    client = ViewerSpecClient.new
    bot = Rosegold::Bot.new(client)
    waiting, decided = RosegoldViewer.spec_pause_behind_close(client, bot)
    waiting.should eq 1_u32
    decided.should eq 3_u32
  end

  {% if Rosegold::ContainerMenu.has_method?(:close_if!) && Rosegold::Menu.has_method?(:send_click_if!) %}
    it "keeps the replacement's mode and blocks return when a close is flushed while another menu opens" do
      client = ViewerSpecClient.new
      can_return, mode, closes = RosegoldViewer.spec_flush_with_replacement(client, Rosegold::Bot.new(client), :close, false)
      closes.should eq 1
      mode.should eq "inventory"
      can_return.should be_false
    end

    it "keeps click ambiguity when the wire grant rotates during a flushed click and menu replacement" do
      client = ViewerSpecClient.new
      can_return, _, _ = RosegoldViewer.spec_flush_with_replacement(client, Rosegold::Bot.new(client), :click, true)
      can_return.should be_false
    end

    it "keeps close ambiguity when the wire grant rotates during a flushed close and menu replacement" do
      client = ViewerSpecClient.new
      can_return, _, closes = RosegoldViewer.spec_flush_with_replacement(client, Rosegold::Bot.new(client), :close, true)
      closes.should eq 1
      can_return.should be_false
    end
  {% end %}

  {% if Rosegold::ContainerMenu.has_method?(:close_if!) %}
    it "allows return after a refused close and a clean replacement menu callback" do
      client = ViewerSpecClient.new
      bot = Rosegold::Bot.new(client)
      closes, can_return, _ = RosegoldViewer.spec_blocked_chest_close(client, bot, carried: false)
      closes.should eq 0
      can_return.should be_true
    end

    it "keeps return blocked when the replaced menu was carrying a stack" do
      client = ViewerSpecClient.new
      bot = Rosegold::Bot.new(client)
      closes, can_return, _ = RosegoldViewer.spec_blocked_chest_close(client, bot, carried: true)
      closes.should eq 0
      can_return.should be_false
    end
  {% end %}
end

describe RosegoldViewer::Feed do
  it "keeps a grant already held by a newly bound bot" do
    first = ViewerSpecClient.new
    second = ViewerSpecClient.new
    feed = RosegoldViewer::Feed.new
    feed.control.enable
    feed.bind(Rosegold::Bot.new(first))
    feed.attach
    second.manual_control.bind_host(feed.control)
    second.manual_control.grant.should_not be_nil
    feed.bind(Rosegold::Bot.new(second))
    second.manual_control.granted?.should be_true
    feed.pull(0_u32, 0_u32)
    second.manual_control.granted?.should be_true
  end
end
