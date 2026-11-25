require "./pull_request"

module RosegoldViewer
  private class ManualController
    # Menu clicks write only through a core API that rechecks the session and a guard under the write lock and
    # leaves slots untouched when refused. Until `Menu#send_click_if!` exists, inventory is shown but never clickable.
    private GUARDED_CLICK = {{ Rosegold::Menu.has_method?(:send_click_if!) }}
    private INPUT_TIMEOUT = 300.milliseconds
    private MAX_SLOTS     = 90

    include Rosegold::ManualControl::Host

    private alias Item = Tuple(String, UInt32)
    private alias Marker = Tuple(Float64, Float64, Float64)
    alias Inventory = NamedTuple(menu: UInt32, revision: UInt32, layout: String, slots: Array(Item?), cursor: Item?, ready: Bool, pending: Bool)
    alias Snapshot = NamedTuple(grant: UInt32, ack: UInt32, mode: String, canPlay: Bool, canChat: Bool, chatSupported: Bool, canReturn: Bool, canResume: Bool, canRestart: Bool, checkpoint: String, marker: Marker?, inventory: Inventory?)

    private class Binding
    end

    private class Dispatch
      property? menu_changed = false
    end

    @bot : Rosegold::Bot?
    @enabled = false
    @native_id : UInt64?
    @native_sequence = 0_u64
    @offered = false
    @marker : Marker?
    @grant = 0_u32
    @sequence = 0_u32
    @ack = 0_u32
    @deferred_ack = 0_u32
    @binding = Binding.new
    @deferred_ack = 0_u32
    @mode = "available"
    @chat_focused = false
    @menu : Rosegold::Menu?
    @closing : Rosegold::Menu?
    @menu_id = 0_u32
    @opening = 0_u64
    @revision = 0_u32
    @state_id : UInt32?
    @observed_slots : Array(Rosegold::Slot)?
    @observed_cursor : Rosegold::Slot?
    @inventory_ambiguous = false
    @dispatch : Dispatch?
    @deadline : Time::Instant?
    @watcher : Channel(Nil)?
    @queued : Tuple(Input, Time::Instant, Proc(Bool)?)?
    @names : Hash(UInt32, String)?

    def initialize(@protocol : UInt32)
    end

    def bind(bot : Rosegold::Bot) : Nil
      unbind
      @bot = bot
      bind_native if @enabled
    end

    def enable : Nil
      @enabled = true
      bind_native
    end

    def disable : Nil
      @enabled = false
      unbind
    end

    def manual_control_enabled? : Bool
      @enabled
    end

    def manual_inventory_unresolved? : Bool
      @inventory_ambiguous || !!@dispatch || !!@menu.try { |menu| !menu.cursor.empty? }
    end

    def cancel : Nil
      native.try &.revoke(Rosegold::ManualControl::Reason::ControllerLost)
      forget_grant
    end

    def session_changed : Nil
      native.try &.reset
      forget_grant
    end

    def resynchronize : Nil
      neutralize
      @mode = "pause" if @mode == "play"
      next_wire_grant if @offered || @native_id
    end

    def snapshot : Snapshot?
      return unless synchronize_grant
      expire_input
      discard_expired_command
      menu = synchronize_menu if @native_id
      inventory = inventory_snapshot(menu) if menu && @mode == "inventory"
      checkpoint, restartable = intervention_state
      safe = !!@native_id && can_return?(menu)
      {grant: @grant, ack: @ack, mode: @mode, canPlay: @offered || can_play?(menu), canChat: @chat_focused && can_play?(menu), chatSupported: true,
       canReturn: safe && checkpoint == "none",
       canResume: safe && checkpoint == "parked", canRestart: safe && checkpoint == "parked" && restartable,
       checkpoint: checkpoint, marker: @marker, inventory: inventory}
    end

    def chat_allowed?(grant : UInt32) : Bool
      return false unless ready? && synchronize_grant && @grant == grant && @native_id && @mode == "play"
      menu = synchronize_menu
      @chat_focused && can_play?(menu)
    end

    def receive(input : Input, lease_deadline : Time::Instant?, lease_valid : Proc(Bool)? = nil) : Nil
      return unless synchronize_grant && input.grant == @grant && input.sequence > @sequence
      expire_input
      discard_expired_command
      return if @dispatch || (@queued && !input.kind.pause?)
      @sequence = input.sequence
      unless (input.kind.click? && !@offered) || input.kind.close_inventory?
        if (queued = @queued) && (queued[0].kind.click? || queued[0].kind.close_inventory?)
          @deferred_ack = input.sequence
        else
          @ack = input.sequence
        end
      end
      if @offered
        if input.kind.takeover? && (bot = @bot) && (id = bot.client.intervention.request_takeover)
          @offered = false
          @native_id = id
          position = bot.location
          @marker = {position.x, position.y, position.z}
        end
        return
      end
      menu = synchronize_menu
      deadline = Time.instant + INPUT_TIMEOUT
      deadline = Math.min(deadline, lease_deadline) if lease_deadline
      case input.kind
      when .pause?
        neutralize(keep_handback: true)
        @mode = "pause" unless @mode == "available"
      when .play?
        return if @chat_focused && !neutral?(input)
        return unless @mode == "play" || ((@mode == "available" || @mode == "pause") && neutral?(input))
        return unless can_play?(menu)
        @chat_focused = false
        @mode = "play"
        submit(input, deadline)
      when .chat_focus?
        return unless @mode == "play" && Time.instant < deadline && ready? && can_play?(menu)
        neutralize
        @chat_focused = true
      when .inventory?
        if @mode != "inventory"
          neutralize
          @mode = "inventory"
        end
      when .click?
        if menu && click_allowed?(menu, input)
          @queued = {input, deadline, lease_valid}
        else
          acknowledge(input)
        end
      when .close_inventory?
        if close_matches?(input, menu)
          @queued = {input, deadline, lease_valid}
        else
          acknowledge(input)
        end
      when .return?, .resume?, .restart?
        @queued = {input, deadline, lease_valid}
      end
    end

    def menu_changed : Nil
      @opening &+= 1
      synchronize_menu if synchronize_grant && @native_id
    end

    def tick : Nil
      return unless synchronize_grant && (id = @native_id)
      binding = @binding
      menu = synchronize_menu
      return unless entry = @queued
      @queued = nil
      input, deadline, lease_valid = entry
      if input.kind.click?
        click(menu, input, id, deadline, lease_valid) if menu && @mode == "inventory" && Time.instant < deadline
        acknowledge(input) if @binding.same?(binding)
        return
      end
      unless Time.instant < deadline
        acknowledge(input) if @binding.same?(binding)
        return
      end
      case input.kind
      when .close_inventory?
        if (@mode == "inventory" || @mode == "pause") && close_matches?(input, menu) && !pending?
          close_container(menu, id, deadline, lease_valid)
        end
        acknowledge(input) if @binding.same?(binding)
      when .return?
        if intervention_state[0] == "none" && can_return?(menu)
          native.try &.return_to_script(id)
        end
      when .resume?, .restart?
        if can_return?(menu) && (intervention = @bot.try(&.client.intervention)) && intervention.grant_id == id && intervention.parked?
          input.kind.resume? ? intervention.resume(id) : intervention.restart(id)
        end
      end
    end

    private def synchronize_grant : Bool
      id = native_grant
      offered = id.nil? && takeover_available?
      if id != @native_id || offered != @offered
        forget_grant
        next_wire_grant if id || offered
        @native_id = id
        @offered = offered
      end
      !!id || offered
    end

    private def next_wire_grant : Nil
      @grant &+= 1
      @grant = 1_u32 if @grant.zero?
      @sequence = 0_u32
      @ack = 0_u32
      @deferred_ack = 0_u32
    end

    private def forget_grant : Nil
      @binding = Binding.new
      stop_input_deadline
      @queued = nil
      @dispatch = nil
      @native_id = nil
      @native_sequence = 0_u64
      @offered = false
      @marker = nil
      @sequence = 0_u32
      @ack = 0_u32
      @deferred_ack = 0_u32
      @mode = "available"
      @chat_focused = false
      @menu = nil
      @closing = nil
      @state_id = nil
      @observed_slots = nil
      @observed_cursor = nil
      @inventory_ambiguous = false
    end

    private def bind_native : Nil
      @bot.try &.client.manual_control.bind_host(self)
    end

    private def unbind : Nil
      native.try &.unbind_host(self)
      forget_grant
    end

    private def native : Rosegold::ManualControl?
      manual = @bot.try &.client.manual_control
      manual if manual && manual.bound_host?(self)
    end

    private def native_grant : UInt64?
      native.try &.grant_id if @enabled
    end

    private def ready? : Bool
      return false unless @enabled && (bot = @bot) && bot.spawned?
      client = bot.client
      client.current_protocol_state == Rosegold::ProtocolState::PLAY && client.connection?.try(&.protocol_version) == @protocol
    end

    private def takeover_available? : Bool
      ready? && !!native && !!@bot.try(&.client.intervention.can_take_over?)
    end

    private def intervention_state : Tuple(String, Bool)
      if (id = @native_id) && (intervention = @bot.try(&.client.intervention)) && intervention.grant_id == id
        return {"pending", false} if intervention.pending?
        return {"parked", intervention.restartable?} if intervention.parked?
      end
      {"none", false}
    end

    private def neutral?(input : Input) : Bool
      data = input.data
      data[0].zero? && data[1].zero? && data[2].zero? && data[3].zero? && data[4] == -1
    end

    private def submit(input : Input, deadline : Time::Instant) : Nil
      return unless (id = @native_id) && (manual = native)
      keys, yaw, pitch, taps, hotbar = input.data
      frame = Rosegold::ManualControl::Input.new(
        forward: keys.bit(0) == 1, backward: keys.bit(1) == 1,
        left: keys.bit(2) == 1, right: keys.bit(3) == 1,
        sneak: keys.bit(4) == 1, sprint: keys.bit(8) == 1, jump: keys.bit(5) == 1, jump_tap: taps.bit(0) == 1,
        ice_road_toggle: taps.bit(3) == 1,
        attack: keys.bit(6) == 1, use: keys.bit(7) == 1,
        attack_taps: taps.bit(1).to_i, use_taps: taps.bit(2).to_i,
        yaw_delta: yaw.to_f32 / 100_f32, pitch_delta: pitch.to_f32 / 100_f32,
        hotbar: hotbar < 0 ? nil : (hotbar + 1).to_u8,
      )
      @native_sequence += 1
      if manual.submit(id, @native_sequence, frame, deadline)
        @deadline = deadline
        unless @watcher
          watcher = @watcher = Channel(Nil).new
          spawn(name: "viewer input deadline", same_thread: true) { watch_input(watcher) }
        end
      end
    end

    private def watch_input(watcher : Channel(Nil)) : Nil
      while @watcher.same?(watcher) && (deadline = @deadline)
        remaining = deadline - Time.instant
        if remaining <= Time::Span.zero
          expire_input
          return
        end
        select
        when watcher.receive?
          return
        when timeout(remaining)
        end
      end
    end

    private def expire_input : Nil
      if (deadline = @deadline) && Time.instant >= deadline
        neutralize(keep_handback: true)
        @mode = "pause" if @mode == "play"
      end
    end

    private def discard_expired_command : Nil
      discard_command if (entry = @queued) && Time.instant >= entry[1]
    end

    private def acknowledge(input : Input) : Nil
      return unless input.grant == @grant
      @ack = Math.max(@ack, input.sequence)
      @ack = Math.max(@ack, @deferred_ack) if @queued.nil?
    end

    private def discard_command(keep_handback : Bool = false) : Nil
      if entry = @queued
        return if keep_handback && (entry[0].kind.close_inventory? || entry[0].kind.return? || entry[0].kind.resume? || entry[0].kind.restart?)
        @queued = nil
        acknowledge(entry[0])
      end
    end

    private def stop_input_deadline : Nil
      @deadline = nil
      @watcher.try &.close
      @watcher = nil
    end

    private def neutralize(keep_handback : Bool = false) : Nil
      @chat_focused = false
      stop_input_deadline
      discard_command(keep_handback)
      if id = @native_id
        native.try &.clear(id)
      end
    end

    private def synchronize_menu : Rosegold::Menu?
      return unless bot = @bot
      menu = bot.client.container_menu
      if !menu.same?(@menu)
        previous = @menu
        @inventory_ambiguous = true if previous && ((!previous.cursor.empty? && !previous.same?(@closing)))
        @dispatch.try &.menu_changed = true
        @closing = nil
        @menu = menu
        @menu_id &+= 1
        @menu_id = 1_u32 if @menu_id.zero?
        @state_id = nil
        @observed_slots = nil
        @observed_cursor = nil
        if !menu.same?(bot.client.inventory_menu)
          neutralize
          @mode = "inventory"
        elsif previous && !previous.same?(bot.client.inventory_menu)
          neutralize
          @mode = "pause"
        end
      end
      observe_inventory(menu) if @mode == "inventory"
      menu
    end

    private def observe_inventory(menu : Rosegold::Menu) : Nil
      return if layout_for(menu) == "unsupported"
      slots = @observed_slots
      cursor = @observed_cursor
      if @state_id == menu.state_id && slots && cursor && menu.slots_match?(cursor, menu.cursor) &&
         slots.each_with_index.all? { |slot, index| menu.slots_match?(slot, menu[index]) }
        return
      end
      @state_id = menu.state_id
      @observed_slots = Array(Rosegold::Slot).new(menu.total_slots) { |index| menu.copy_slot(menu[index]) }
      @observed_cursor = menu.copy_slot(menu.cursor)
      @revision &+= 1
      @revision = 1_u32 if @revision.zero?
    end

    private def inventory_snapshot(menu : Rosegold::Menu) : Inventory
      layout = layout_for(menu)
      slots = if layout == "unsupported"
                [] of Item?
              else
                Array(Item?).new(menu.total_slots) { |index| item(menu[index]) }
              end
      {menu: @menu_id, revision: @revision, layout: layout, slots: slots, cursor: item(menu.cursor), ready: GUARDED_CLICK && loaded?(menu), pending: pending?}
    end

    private def pending? : Bool
      @inventory_ambiguous || !!@dispatch || !!@queued
    end

    private def loaded?(menu : Rosegold::Menu) : Bool
      menu.content_loaded?
    end

    private def can_return?(menu : Rosegold::Menu?) : Bool
      !pending? && (menu.nil? || menu.cursor.empty?)
    end

    private def can_play?(menu : Rosegold::Menu?) : Bool
      @mode != "inventory" && menu.is_a?(Rosegold::PlayerMenu) && can_return?(menu)
    end

    private def close_matches?(input : Input, menu : Rosegold::Menu?) : Bool
      return false unless menu
      identity = input.data[0]
      identity.zero? ? !menu.is_a?(Rosegold::ContainerMenu) : identity == @menu_id
    end

    # The server returns, stacks, or drops the cursor stack and personal crafting grid when the window closes.
    # Nothing is written, and no mode or menu state changes, unless the core write lock still sees the same
    # native grant, wire grant, dispatch, input deadline, lease, window opening, and menu.
    private def close_container(menu : Rosegold::Menu?, grant_id : UInt64, deadline : Time::Instant, lease_valid : Proc(Bool)?) : Nil
      return unless menu && (bot = @bot) && (session = bot.client.play_session?)
      client = bot.client
      wire_grant = @grant
      binding = @binding
      generation = @opening
      dispatch = @dispatch = Dispatch.new
      authorized = -> do
        @dispatch.same?(dispatch) && @native_id == grant_id && native_grant == grant_id && @grant == wire_grant && @binding.same?(binding) &&
        ready? && Time.instant < deadline && lease_valid.try(&.call) != false && @opening == generation &&
        @menu.same?(menu) && client.container_menu.same?(menu)
      end
      begin
        sent = if menu.is_a?(Rosegold::ContainerMenu)
                 {% if Rosegold::ContainerMenu.has_method?(:close_if!) %}
                   menu.close_if!(session, &authorized)
                 {% else %}
                   false
                 {% end %}
               else
                 client.send_packet_if!(Rosegold::Serverbound::CloseWindow.new(0_u16), session, &authorized)
               end
        if sent && @dispatch.same?(dispatch) && @binding.same?(binding)
          if dispatch.menu_changed?
            @inventory_ambiguous = true
          else
            @closing = menu if menu.is_a?(Rosegold::ContainerMenu)
            @mode = "pause"
          end
        end
      rescue
        if @dispatch.same?(dispatch) && @binding.same?(binding)
          @inventory_ambiguous = true
          @mode = "pause" unless dispatch.try(&.menu_changed?)
        end
      ensure
        @dispatch = nil if @dispatch.same?(dispatch)
      end
    end

    private def click_allowed?(menu : Rosegold::Menu, input : Input) : Bool
      identity, revision, slot, _, _ = input.data
      GUARDED_CLICK && @mode == "inventory" && !pending? && loaded?(menu) && layout_for(menu) != "unsupported" &&
        identity == @menu_id && revision == @revision && slot < menu.total_slots
    end

    private def click(menu : Rosegold::Menu, input : Input, grant_id : UInt64, deadline : Time::Instant, lease_valid : Proc(Bool)?) : Nil
      {% if Rosegold::Menu.has_method?(:send_click_if!) %}
        return unless click_allowed?(menu, input)
        _, _, slot, operation, button = input.data
        return unless (bot = @bot) && (session = bot.client.play_session?) && native_grant == grant_id
        client = bot.client
        wire_grant = @grant
        binding = @binding
        generation = @opening
        revision = @revision
        click = case operation
                when 0 then button.zero? ? Rosegold::ClickOperation::LeftClick : Rosegold::ClickOperation::RightClick
                when 1 then Rosegold::ClickOperation::ShiftClick
                when 2 then Rosegold::ClickOperation.swap_hotbar(button.to_i)
                else        return
                end

        dispatch = @dispatch = Dispatch.new
        begin
          authorized = -> do
            @dispatch.same?(dispatch) && @native_id == grant_id && native_grant == grant_id && @grant == wire_grant && @binding.same?(binding) &&
            ready? && Time.instant < deadline && lease_valid.try(&.call) != false && @mode == "inventory" &&
            @opening == generation && @revision == revision && @menu.same?(menu) && client.container_menu.same?(menu)
          end
          sent = menu.send_click_if!(slot.to_i, click, session, &authorized)
          if sent && @dispatch.same?(dispatch) && @binding.same?(binding)
            if client.container_menu.same?(menu) && !dispatch.menu_changed?
              @state_id = nil
            else
              @inventory_ambiguous = true
            end
          end
        rescue
          @inventory_ambiguous = true if @dispatch.same?(dispatch) && @binding.same?(binding)
        ensure
          @dispatch = nil if @dispatch.same?(dispatch)
        end
      {% end %}
    end

    private def item(slot : Rosegold::Slot) : Item?
      return if slot.empty?
      names = @names ||= Rosegold::MCData.for(@protocol).items.to_h do |item|
        name = item.name
        {item.id, name.matches?(/\A[a-z0-9_]{1,64}\z/) ? name : "unknown_item"}
      end
      {names[slot.item_id_int]? || "unknown_item", slot.count.clamp(1_u32, 999_u32)}
    end

    private def layout_for(menu : Rosegold::Menu) : String
      return "unsupported" if menu.total_slots > MAX_SLOTS
      case menu
      when Rosegold::PlayerMenu       then "player"
      when Rosegold::ChestMenu        then "chest"
      when Rosegold::CraftingMenu     then "crafting"
      when Rosegold::FurnaceMenu      then "furnace"
      when Rosegold::HopperMenu       then "hopper"
      when Rosegold::BrewingStandMenu then "brewing"
      when Rosegold::AnvilMenu        then "anvil"
      when Rosegold::EnchantmentMenu  then "enchantment"
      when Rosegold::MerchantMenu     then "merchant"
      else                                 "unsupported"
      end
    end
  end
end
