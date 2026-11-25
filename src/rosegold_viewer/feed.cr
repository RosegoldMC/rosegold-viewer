require "json"
require "./chat"
require "./debug"
require "./entities"
require "./hud"
require "./manual_controller"
require "./paths"

module RosegoldViewer
  class Feed
    MAX_BATCH         = 16 * 1024
    private CHAT_SEND_TIMEOUT = 500.milliseconds
    private PROTOCOL          = 777_u32
    private RADIUS            =       2
    private INTERVAL          = 50.milliseconds
    private DEBUG_INTERVAL    = 250.milliseconds

    private alias Position = Tuple(Int32, Int32, Int32)
    private alias Vector = Tuple(Float64, Float64, Float64)
    private record Pose, center : Position, eye : Vector, look : Vector, yaw : Float32

    getter failure : Exception?

    @bot : Rosegold::Bot?
    @attached = false
    @lease_valid : Proc(Bool)?
    @subscriptions : Array(Proc(Nil))?
    @connection : Rosegold::Connection::Client?
    @world : Rosegold::Dimension?
    @input_suspended = false
    @epoch = 0_u32
    @seq = 0_u32
    @status : String?
    @sent_pose : Pose?
    @center : Position?
    @window = [] of Position
    @baseline = Set(Position).new
    @dirty = Set(Position).new
    @initial_sample = true
    @prefer_dirty = false
    @refresh_index = 0
    @last_sample : Time::Instant?
    @air : Array(UInt16)?
    @paths = Paths.new(PROTOCOL)
    @sent_paths : Paths::Snapshot?
    @hud = Hud.new(PROTOCOL)
    @sent_hud : Hud::Snapshot?
    @chat = ChatHistory.new
    @sent_chat_epoch : UInt32?
    @sent_chat_id = 0_u32
    @chat_submit_id = 0_u32
    @last_chat_submit : Time::Instant?
    @chat_sending = false
    @entities = Entities.new(PROTOCOL)
    @sent_entities : String?
    @debug = Debug.new(PROTOCOL)
    @sent_debug : Debug::Snapshot?
    @last_debug : Time::Instant?
    getter control = ManualController.new(PROTOCOL)
    @sent_control : ManualController::Snapshot?

    def bind(bot : Rosegold::Bot) : Nil
      unsubscribe
      @connection = nil
      @world = nil
      @control.bind(bot)
      @paths.bind(bot)
      @bot = bot
      reset
      subscribe(bot) if @attached
    rescue error
      fail_attachment(error)
    end

    def set_player_skin(uuid : UUID, path : String, *, slim : Bool) : Bool
      @entities.skins.register(uuid, path, slim: slim)
    end

    def skin_asset(key : String) : Bytes?
      @entities.skins.asset(key)
    end

    def draw_path(name : String, points : Enumerable(T), *, color : UInt32) : Bool forall T
      @paths.draw(name, points, color)
    end

    def clear_path(name : String) : Nil
      @paths.remove(name)
    end

    def clear_paths : Nil
      @paths.clear
    end

    def attach(lease_valid : Proc(Bool)? = nil) : Nil
      unsubscribe
      @lease_valid = lease_valid
      @attached = true
      @failure = nil
      reset
      @bot.try { |bot| subscribe(bot) }
    rescue error
      fail_attachment(error)
    end

    def detach : Nil
      @attached = false
      @lease_valid = nil
      unsubscribe
      @control.cancel
      @connection = nil
      reset
    end

    def reset : Nil
      @chat.reset
      @chat_submit_id = 0_u32
      @entities.reset
      @world = nil
      @input_suspended = false
      reset_stream
    end

    private def reset_stream : Nil
      @epoch &+= 1
      @seq = 0_u32
      @status = nil
      @sent_pose = nil
      @sent_paths = nil
      @sent_hud = nil
      @sent_chat_epoch = nil
      @sent_entities = nil
      @sent_debug = nil
      @last_debug = nil
      @sent_control = nil
      @center = nil
      @window.clear
      @baseline.clear
      @dirty.clear
      @initial_sample = true
      @prefer_dirty = false
      @refresh_index = 0
    end

    # Pull only on the bot's scheduler thread. Returned bytes do not reference live world data.
    def pull(epoch : UInt32, seq : UInt32, input : Input? = nil, lease_deadline : Time::Instant? = nil, debug : Bool = false) : Bytes?
      return unless @attached
      @paths.synchronize
      bot = @bot
      client = bot.try &.client
      synchronize_connection(client.try &.connection?)
      if @seq == UInt32::MAX || (@seq != 0 && (epoch != @epoch || seq != @seq))
        @control.resynchronize
        reset_stream
      end

      connection = @connection
      return status_frame("waiting") unless connection
      return status_frame("unsupported") unless connection.protocol_version == PROTOCOL
      unless bot && client && client.current_protocol_state == Rosegold::ProtocolState::PLAY
        session_changed if @world
        return status_frame("waiting")
      end

      world = bot.world
      synchronize_world(world)
      return status_frame("waiting") unless input_available?(bot)
      if input && @status == "ready" && epoch == @epoch && seq == @seq
        @control.receive(input, lease_deadline, @lease_valid)
        return unless @attached && epoch == @epoch && @bot.same?(bot) && @connection.same?(connection) && bot.world.same?(world) && bot.spawned?
      end
      pose = sample_pose(bot)
      update_window(pose.center) unless pose.center == @center

      paths = @paths.snapshot
      changed_paths = paths unless paths == @sent_paths
      hud = @hud.sample(bot)
      changed_hud = hud unless hud == @sent_hud
      entities = @entities.sample(world, pose.eye, client.player.entity_id)
      changed_entities = entities unless entities == @sent_entities
      changed_debug = sample_debug(bot, debug)
      control = @control.snapshot
      changed_control = control != @sent_control
      chat = @chat.since(@sent_chat_epoch, @sent_chat_id)
      position = next_position(world)
      return unless position || @status != "ready" || @sent_pose != pose || changed_paths || changed_hud || changed_debug || changed_control || changed_entities || chat
      @sent_pose = pose
      @sent_paths = paths
      @sent_hud = hud
      @sent_debug = changed_debug if changed_debug
      @sent_control = control
      kind, data = position ? read_section(world, position) : {nil, nil}
      frame("ready", pose, position, kind, data, paths: changed_paths, hud: changed_hud, entities: changed_entities, debug: changed_debug, control: control, changed_control: changed_control, chat: chat)
    rescue error
      fail_attachment(error)
      nil
    end

    private def sample_debug(bot : Rosegold::Bot, requested : Bool) : Debug::Snapshot?
      unless requested
        @sent_debug = nil
        @last_debug = nil
        return
      end
      time = now
      if (last = @last_debug) && time - last < DEBUG_INTERVAL
        return
      end
      @last_debug = time
      sample = @debug.sample(bot)
      sample unless sample == @sent_debug
    end

    def send_chat(request : ChatRequest) : HTTP::Status
      return HTTP::Status::CONFLICT unless (bot = @bot) && chat_dispatch_allowed?(bot, request)
      return HTTP::Status::CONFLICT if request.id <= @chat_submit_id
      @chat_submit_id = request.id
      time = Time.instant
      if (last = @last_chat_submit) && time - last < 1.second
        return HTTP::Status::TOO_MANY_REQUESTS
      end
      @last_chat_submit = time
      return HTTP::Status::SERVICE_UNAVAILABLE if @chat_sending
      @chat_sending = true
      result = Channel(HTTP::Status).new(1)
      manager = bot.client.chat_manager
      spawn(name: "viewer chat send", same_thread: true) do
        status = begin
          outcome = if request.command?
                      manager.try_send_command(request.text) { chat_dispatch_allowed?(bot, request) }
                    else
                      manager.try_send_message(request.text) { chat_dispatch_allowed?(bot, request) }
                    end
          case outcome
          in .sent?    then HTTP::Status::NO_CONTENT
          in .busy?    then HTTP::Status::SERVICE_UNAVAILABLE
          in .refused? then HTTP::Status::CONFLICT
          end
        rescue
          HTTP::Status::BAD_GATEWAY
        end
        @chat_sending = false
        result.send(status)
      end
      select
      when status = result.receive
        status
      when timeout(CHAT_SEND_TIMEOUT)
        HTTP::Status::GATEWAY_TIMEOUT
      end
    rescue
      HTTP::Status::BAD_GATEWAY
    end

    private def chat_dispatch_allowed?(bot : Rosegold::Bot, request : ChatRequest) : Bool
      @attached && @lease_valid.try(&.call) == true && request.epoch == @epoch && @status == "ready" &&
        @bot.same?(bot) && live_play?(bot.client) && !!bot.spawned? && @world.same?(bot.world) && @control.chat_allowed?(request.grant)
    end

    private def capture_chat(bot : Rosegold::Bot, &display : -> String) : Nil
      return unless live_play?(bot.client) && @lease_valid.try(&.call) != false
      world = bot.world
      synchronize_world(world)
      epoch = @epoch
      text = display.call
      if epoch == @epoch && @attached && @bot.same?(bot) && live_play?(bot.client) && world.same?(bot.world) && @lease_valid.try(&.call) != false
        @chat.add(text)
      end
    end

    private def chat_text(component : Rosegold::TextComponent, depth : Int32 = 0) : String
      return "" if depth >= 16
      String.build do |io|
        if key = component.translate
          io << translated_chat_text(component, key, depth)
        else
          io << component.text
        end
        component.extra.try &.each { |part| io << chat_text(part, depth + 1) }
      end
    end

    private def translated_chat_text(component : Rosegold::TextComponent, key : String, depth : Int32) : String
      format = Rosegold::TextComponent.translations[key]?
      return component.fallback || key unless format
      args = component.with
      return format unless args
      format % args.map { |part| part.is_a?(String) ? part : chat_text(part, depth + 1) }
    rescue ArgumentError
      component.fallback || key
    end

    private def subscribe(bot : Rosegold::Bot) : Nil
      client = bot.client
      owner = @subscriptions = [] of Proc(Nil)

      hook(client, owner, Rosegold::Clientbound::PlayerChatMessage) do |event|
        if event.filter_type.zero?
          registry = client.registries["minecraft:chat_type"]?
          type = registry.try(&.entries[event.chat_type.to_i64 - 1]?.try(&.[:id])) if event.chat_type > 0
          if (registry.nil? || type == "minecraft:chat") && event.network_target_name.nil?
            capture_chat(bot) do
              sender = chat_text(event.network_name)
              text = event.unsigned_content.try { |content| chat_text(content) } || event.message
              type ? "<#{sender}> #{text}" : "[Player chat] #{sender}: #{text}"
            end
          elsif type == "minecraft:msg_command_incoming"
            capture_chat(bot) do
              text = event.unsigned_content.try { |content| chat_text(content) } || event.message
              "[Whisper from #{chat_text(event.network_name)}] #{text}"
            end
          elsif type == "minecraft:msg_command_outgoing" && (target = event.network_target_name)
            capture_chat(bot) do
              text = event.unsigned_content.try { |content| chat_text(content) } || event.message
              "[Whisper to #{chat_text(target)}] #{text}"
            end
          end
        end
      end
      hook(client, owner, Rosegold::Clientbound::DisguisedChatMessage) do |event|
        registry = client.registries["minecraft:chat_type"]?
        type = registry.try(&.entries[event.chat_type.to_i64 - 1]?.try(&.[:id])) if event.chat_type > 0
        capture_chat(bot) do
          if type == "minecraft:msg_command_incoming"
            "[Whisper from #{chat_text(event.sender_name)}] #{chat_text(event.message)}"
          elsif type == "minecraft:msg_command_outgoing" && (target = event.target_name)
            "[Whisper to #{chat_text(target)}] #{chat_text(event.message)}"
          else
            "[Disguised chat] #{chat_text(event.sender_name)}: #{chat_text(event.message)}"
          end
        end
      end
      hook(client, owner, Rosegold::Clientbound::SystemChatMessage) do |event|
        capture_chat(bot) { chat_text(event.message) } unless event.overlay?
      end

      hook(client, owner, Rosegold::Clientbound::ChunkData) do |event|
        dirty_column(event.chunk_x, event.chunk_z) if live_play?(client)
      end
      hook(client, owner, Rosegold::Clientbound::UnloadChunk) do |event|
        dirty_column(event.chunk_x, event.chunk_z) if live_play?(client)
      end
      hook(client, owner, Rosegold::Clientbound::BlockChange) do |event|
        dirty(section_position(event.location)) if live_play?(client)
      end
      hook(client, owner, Rosegold::Clientbound::MultiBlockChange) do |event|
        dirty({event.section_x, event.section_y, event.section_z}) if live_play?(client)
      end
      {% for type in [Rosegold::Clientbound::SpawnEntity, Rosegold::Clientbound::EntityPosition, Rosegold::Clientbound::EntityPositionAndRotation, Rosegold::Clientbound::EntityPositionSync, Rosegold::Clientbound::TeleportEntity, Rosegold::Clientbound::SetEntityData] %}
        hook(client, owner, {{type}}) do |event|
          @entities.observe(bot.world, event.entity_id) if live_play?(client)
        end
      {% end %}
      hook(client, owner, Rosegold::Clientbound::Login) do
        if (connection = client.connection?) && connection.open? && client.current_protocol_state == Rosegold::ProtocolState::PLAY
          @connection = connection
          session_changed
        end
      end
      hook(client, owner, Rosegold::Clientbound::Respawn) do
        session_changed if current_connection?(client) && client.current_protocol_state == Rosegold::ProtocolState::PLAY
      end
      hook(client, owner, Rosegold::Clientbound::StartConfiguration) do
        session_changed if current_connection?(client) && client.current_protocol_state == Rosegold::ProtocolState::CONFIGURATION
      end
      hook(client, owner, Rosegold::Clientbound::OpenWindow) do
        @control.menu_changed if live_play?(client)
      end
      hook(client, owner, Rosegold::Clientbound::CloseWindow) do
        @control.menu_changed if live_play?(client)
      end
      hook(client, owner, Rosegold::Event::PlayerPositionUpdate) do
        if live_play?(client)
          synchronize_world(bot.world)
          input_available?(bot)
        end
      end
      hook(client, owner, Rosegold::Event::Tick) do
        if (valid = @lease_valid) && !valid.call
          @control.cancel
        elsif live_play?(client)
          synchronize_world(bot.world)
          @control.tick if input_available?(bot)
        elsif @world
          session_changed
        end
      end
      hook(client, owner, Rosegold::Clientbound::Transfer) do
        synchronize_connection(client.connection?)
      end
      hook(client, owner, Rosegold::Event::Disconnected) do |event|
        if (connection = @connection) && connection.same?(client.connection?) && event.reason.same?(connection.close_reason)
          synchronize_connection(connection)
        end
      end

      synchronize_connection(client.connection?)
    end

    private def hook(client : Rosegold::Client, owner : Array(Proc(Nil)), type : T.class, &block : T ->) : Nil forall T
      id = client.on(type) do |event|
        if owner.same?(@subscriptions)
          begin
            block.call(event)
          rescue error
            fail_attachment(error)
          end
        end
      end
      owner << -> { client.off(type, id); nil }
    end

    private def unsubscribe : Nil
      owner = @subscriptions
      @subscriptions = nil
      owner.try &.each(&.call)
    end

    private def fail_attachment(error : Exception) : Nil
      @failure = error
      detach
    end

    private def synchronize_connection(connection : Rosegold::Connection::Client?) : Nil
      connection = nil if connection.try(&.closed?)
      return if @connection == connection
      previous = @connection
      @connection = connection
      previous ? session_changed : reset
    end

    private def session_changed : Nil
      @control.session_changed
      reset
    end

    private def synchronize_world(world : Rosegold::Dimension) : Nil
      session_changed if @world && !@world.same?(world)
      @world = world
    end

    private def input_available?(bot : Rosegold::Bot) : Bool
      ready = !!bot.spawned?
      @control.resynchronize unless ready || @input_suspended
      @input_suspended = !ready
      ready
    end

    private def current_connection?(client : Rosegold::Client) : Bool
      connection = @connection
      !!(connection && connection.same?(client.connection?) && connection.open?)
    end

    private def live_play?(client : Rosegold::Client) : Bool
      @connection.try(&.protocol_version) == PROTOCOL && current_connection?(client) && client.current_protocol_state == Rosegold::ProtocolState::PLAY
    end

    private def sample_pose(bot : Rosegold::Bot) : Pose
      eye = bot.eyes
      angles = bot.look
      yaw = angles.yaw
      raise ArgumentError.new("Invalid viewer yaw") unless yaw.finite?
      look = angles.to_vec3
      Pose.new(section_position(bot.location.block), {eye.x, eye.y, eye.z}, {look.x, look.y, look.z}, yaw)
    end

    private def section_position(location : Rosegold::Vec3i) : Position
      {location.x >> 4, location.y >> 4, location.z >> 4}
    end

    private def inside?(position : Position, center : Position) : Bool
      near?(position[0], center[0]) && near?(position[1], center[1]) && near?(position[2], center[2])
    end

    private def near?(coordinate : Int32, center : Int32) : Bool
      center - RADIUS <= coordinate <= center + RADIUS
    end

    private def dirty(position : Position) : Nil
      center = @center
      @dirty.add(position) if center && inside?(position, center)
    end

    private def dirty_column(x : Int32, z : Int32) : Nil
      if center = @center
        return unless near?(x, center[0]) && near?(z, center[2])
        (center[1] - RADIUS..center[1] + RADIUS).each { |y| @dirty.add({x, y, z}) }
      end
    end

    private def update_window(center : Position) : Nil
      previous = @center
      @center = center
      @baseline.reject! { |position| !inside?(position, center) }
      @dirty.reject! { |position| !inside?(position, center) }
      @window.clear
      (-RADIUS..RADIUS).each do |dx|
        (-RADIUS..RADIUS).each do |dy|
          (-RADIUS..RADIUS).each do |dz|
            position = {center[0] + dx, center[1] + dy, center[2] + dz}
            @window << position
            @baseline.add(position) unless previous && inside?(position, previous)
          end
        end
      end
      @window.sort_by! do |x, y, z|
        {(x - center[0]) ** 2 + (y - center[1]) ** 2 + (z - center[2]) ** 2, x, y, z}
      end
      @prefer_dirty = false
    end

    private def next_position(world : Rosegold::Dimension) : Position?
      time = now
      if (last = @last_sample) && time - last < INTERVAL
        return
      end
      @last_sample = time

      if @initial_sample
        @initial_sample = false
        position = @window.find do |candidate|
          (section = section_at(world, candidate)) && !empty?(section)
        end
      end
      position ||= @window.find { |candidate| @dirty.includes?(candidate) } if @prefer_dirty
      position ||= @window.find { |candidate| @baseline.includes?(candidate) }
      unless position
        position = @window[@refresh_index]
        @refresh_index = (@refresh_index + 1) % @window.size
      end
      @prefer_dirty = !@prefer_dirty
      @baseline.delete(position)
      @dirty.delete(position)
      position
    end

    private def now : Time::Instant
      Time.instant
    end

    private def section_at(world : Rosegold::Dimension, position : Position) : Rosegold::Section?
      x, y, z = position
      index = y - (world.min_y >> 4)
      return if index < 0
      world.chunk_at?(x, z).try(&.sections[index]?)
    end

    private def empty?(section : Rosegold::Section) : Bool
      section.has_only_air? && section.fluid_count.zero?
    end

    private def read_section(world : Rosegold::Dimension, position : Position) : Tuple(String, Bytes?)
      section = section_at(world, position)
      return {"unloaded", nil} unless section
      return {"air", nil} if empty?(section)

      bytes = Bytes.new(8192)
      4096_u32.times do |i|
        value = section.block_state(i)
        bytes[i * 2] = value.to_u8!
        bytes[i * 2 + 1] = (value >> 8).to_u8
      end
      {"states", bytes}
    end

    private def status_frame(status : String) : Bytes?
      return if @status == status
      reset_stream if @status == "ready"
      frame(status)
    end

    private def frame(status : String, pose : Pose? = nil, position : Position? = nil, kind : String? = nil, data : Bytes? = nil, *, paths : Paths::Snapshot? = nil, hud : Hud::Snapshot? = nil, entities : String? = nil, debug : Debug::Snapshot? = nil, control : ManualController::Snapshot? = nil, changed_control : Bool = false, chat : ChatHistory::Snapshot? = nil) : Bytes
      @seq += 1
      @status = status
      header = frame_header(status, pose, position, kind, paths, hud, entities, debug, control, changed_control, chat)
      if position && 2 + header.bytesize + (data.try(&.size) || 0) > MAX_BATCH
        @dirty.add(position)
        position = kind = data = nil
        header = frame_header(status, pose, position, kind, paths, hud, entities, debug, control, changed_control, chat)
      end
      if entities && 2 + header.bytesize > MAX_BATCH
        entities = nil
        header = frame_header(status, pose, position, kind, paths, hud, entities, debug, control, changed_control, chat)
      elsif entities
        @sent_entities = entities
      end
      if chat && 2 + header.bytesize > MAX_BATCH
        header = frame_header(status, pose, position, kind, paths, hud, entities, debug, control, changed_control, nil)
      elsif chat
        @sent_chat_epoch = chat[:epoch]
        @sent_chat_id = chat[:entries].last?.try(&.[0]) || 0_u32
      end
      io = IO::Memory.new(2 + header.bytesize + (data.try(&.size) || 0))
      io.write_bytes(header.bytesize.to_u16, IO::ByteFormat::LittleEndian)
      io << header
      io.write(data) if data
      io.to_slice
    end

    private def frame_header(status, pose, position, kind, paths, hud, entities, debug, control, changed_control, chat) : String
      JSON.build do |json|
        json.object do
          json.field "epoch", @epoch
          json.field "seq", @seq
          json.field "status", status
          if pose
            json.field "center", pose.center
            json.field "eye", pose.eye
            json.field "look", pose.look
            json.field "yaw", pose.yaw
            json.field "air", @air ||= Rosegold::MCData.for(PROTOCOL).air_states.to_a.sort!
            json.field "paths", paths.values if paths
            json.field "hud", hud if hud
            json.field("entities") { json.raw(entities) } if entities
            json.field "debug", debug if debug
            if changed_control
              json.field "control" do
                if control
                  json.object do
                    control.each do |key, value|
                      json.field key.to_s, value unless (key == :canChat && !control[:canChat]) || (key == :chatSupported && control[:chatSupported])
                    end
                  end
                else
                  json.null
                end
              end
            end
            json.field "chat", chat if chat
          end
          if position
            json.field "section" do
              json.object do
                json.field "position", position
                json.field "kind", kind
              end
            end
          end
        end
      end
    end
  end
end
