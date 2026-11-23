require "json"
require "./paths"

module RosegoldViewer
  class Feed
    private PROTOCOL = 777_u32
    private RADIUS   =       2
    private INTERVAL = 50.milliseconds

    private alias Position = Tuple(Int32, Int32, Int32)
    private alias Vector = Tuple(Float64, Float64, Float64)
    private record Pose, center : Position, eye : Vector, look : Vector, yaw : Float32

    getter failure : Exception?

    @bot : Rosegold::Bot?
    @attached = false
    @subscriptions : Array(Proc(Nil))?
    @connection : Rosegold::Connection::Client?
    @world : Rosegold::Dimension?
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

    def bind(bot : Rosegold::Bot) : Nil
      @paths.bind(bot)
      unsubscribe
      @bot = bot
      reset
      subscribe(bot) if @attached
    rescue error
      fail_attachment(error)
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

    def attach : Nil
      unsubscribe
      @attached = true
      @failure = nil
      reset
      @bot.try { |bot| subscribe(bot) }
    rescue error
      fail_attachment(error)
    end

    def detach : Nil
      @attached = false
      unsubscribe
      @connection = nil
      reset
    end

    def reset : Nil
      @epoch &+= 1
      @seq = 0_u32
      @status = nil
      @world = nil
      @sent_pose = nil
      @sent_paths = nil
      @center = nil
      @window.clear
      @baseline.clear
      @dirty.clear
      @initial_sample = true
      @prefer_dirty = false
      @refresh_index = 0
    end

    # Pull only on the bot's scheduler thread. Returned bytes do not reference live world data.
    def pull(epoch : UInt32, seq : UInt32) : Bytes?
      return unless @attached
      @paths.synchronize
      bot = @bot
      client = bot.try &.client
      synchronize_connection(client.try &.connection?)
      reset if @seq == UInt32::MAX || (@seq != 0 && (epoch != @epoch || seq != @seq))

      connection = @connection
      return status_frame("waiting") unless connection
      return status_frame("unsupported") unless connection.protocol_version == PROTOCOL
      return status_frame("waiting") unless bot && client && client.current_protocol_state == Rosegold::ProtocolState::PLAY && bot.spawned?

      world = bot.world
      previous = @world
      reset if previous && !world.same?(previous)
      @world = world
      pose = sample_pose(bot)
      update_window(pose.center) unless pose.center == @center

      paths = @paths.snapshot
      changed_paths = paths unless paths == @sent_paths
      position = next_position(world)
      return unless position || @status != "ready" || @sent_pose != pose || changed_paths
      @sent_pose = pose
      @sent_paths = paths
      if position
        kind, data = read_section(world, position)
        frame("ready", pose, position, kind, data, paths: changed_paths)
      else
        frame("ready", pose, paths: changed_paths)
      end
    rescue error
      fail_attachment(error)
      nil
    end

    private def subscribe(bot : Rosegold::Bot) : Nil
      client = bot.client
      owner = @subscriptions = [] of Proc(Nil)

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
      hook(client, owner, Rosegold::Clientbound::Login) do
        if (connection = client.connection?) && connection.open? && client.current_protocol_state == Rosegold::ProtocolState::PLAY
          @connection = connection
          reset
        end
      end
      hook(client, owner, Rosegold::Clientbound::Respawn) do
        reset if current_connection?(client) && client.current_protocol_state == Rosegold::ProtocolState::PLAY
      end
      hook(client, owner, Rosegold::Clientbound::StartConfiguration) do
        reset if current_connection?(client) && client.current_protocol_state == Rosegold::ProtocolState::CONFIGURATION
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
      @connection = connection
      reset
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
      reset if @status == "ready"
      frame(status)
    end

    private def frame(status : String, pose : Pose? = nil, position : Position? = nil, kind : String? = nil, data : Bytes? = nil, *, paths : Paths::Snapshot? = nil) : Bytes
      @seq += 1
      @status = status
      header = JSON.build do |json|
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
      io = IO::Memory.new(2 + header.bytesize + (data.try(&.size) || 0))
      io.write_bytes(header.bytesize.to_u16, IO::ByteFormat::LittleEndian)
      io << header
      io.write(data) if data
      io.to_slice
    end
  end
end
