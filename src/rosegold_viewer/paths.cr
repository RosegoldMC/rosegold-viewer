require "json"

module RosegoldViewer
  private class Paths
    private MAX_PATHS  =          8
    private MAX_POINTS =        128
    private MAX_AXIS   = 30_000_000
    private SCALE      =        256

    private alias Point = Tuple(Int64, Int64, Int64)
    private alias Path = NamedTuple(name: String, color: UInt32, points: Array(Point))
    alias Snapshot = Hash(String, Path)

    private record Scope, connection : Rosegold::Connection::Client, world : Rosegold::Dimension, unsubscribe : Array(Proc(Nil))

    getter snapshot = Snapshot.new

    @bot : Rosegold::Bot?
    @scope : Scope?
    @world_generation = 0_u64
    @hook_id = UUID.random

    def initialize(@protocol : UInt32)
    end

    def bind(@bot : Rosegold::Bot) : Nil
      clear
    end

    def draw(name : String, points : Enumerable(T), color : UInt32) : Bool forall T
      return false unless valid_name?(name) && color <= 0xffffff_u32
      synchronize
      return false unless bot = @bot
      return false unless connection = ready_connection(bot)
      world = bot.world
      generation = @world_generation

      copy = [] of Point
      points.each do |point|
        return false if copy.size == MAX_POINTS
        return false unless point.is_a?(Rosegold::Vec3i | Rosegold::Vec3d)
        x = encode(point.x)
        y = encode(point.y)
        z = encode(point.z)
        return false unless x && y && z
        copy << {x, y, z}
      end
      return false unless @world_generation == generation && connection.same?(ready_connection(bot)) && world.same?(bot.world)

      if copy.empty?
        remove(name)
        return true
      end

      existing = @snapshot[name]?
      return false if !existing && @snapshot.size == MAX_PATHS
      total = @snapshot.values.sum { |path| path[:points].size }
      return false if total - (existing.try(&.[:points].size) || 0) + copy.size > MAX_POINTS

      path = {name: name, color: color, points: copy}
      return true if existing == path

      subscribe(bot.client, connection, world) unless @scope
      @snapshot = @snapshot.merge({name => path})
      true
    end

    def remove(name : String) : Nil
      return unless valid_name?(name) && @snapshot.has_key?(name)
      @snapshot = @snapshot.dup
      @snapshot.delete(name)
      unsubscribe if @snapshot.empty?
    end

    def clear : Nil
      @world_generation &+= 1
      @snapshot = Snapshot.new unless @snapshot.empty?
      unsubscribe
    end

    def synchronize : Nil
      if (scope = @scope) && (bot = @bot)
        client = bot.client
        clear unless scope.connection.same?(client.connection?) && scope.connection.open? && scope.world.same?(bot.world) && client.current_protocol_state == Rosegold::ProtocolState::PLAY
      end
    end

    private def ready_connection(bot : Rosegold::Bot) : Rosegold::Connection::Client?
      client = bot.client
      connection = client.connection?
      connection if connection && connection.protocol_version == @protocol && client.current_protocol_state == Rosegold::ProtocolState::PLAY && bot.spawned?
    end

    private def valid_name?(name : String) : Bool
      1 <= name.bytesize <= 32 && name.each_byte.all? do |byte|
        'A'.ord <= byte <= 'Z'.ord || 'a'.ord <= byte <= 'z'.ord || '0'.ord <= byte <= '9'.ord || byte == '_'.ord || byte == '-'.ord
      end
    end

    private def encode(axis : Int32 | Float64) : Int64?
      return unless -MAX_AXIS <= axis <= MAX_AXIS
      (axis.to_f64 * SCALE).round_away.to_i64
    end

    private def subscribe(client : Rosegold::Client, connection : Rosegold::Connection::Client, world : Rosegold::Dimension) : Nil
      scope = @scope = Scope.new(connection, world, [] of Proc(Nil))
      hook(client, scope, Rosegold::Clientbound::Login) do
        clear if connection.same?(client.connection?) && client.current_protocol_state == Rosegold::ProtocolState::PLAY
      end
      hook(client, scope, Rosegold::Clientbound::Respawn) do
        clear if connection.same?(client.connection?) && client.current_protocol_state == Rosegold::ProtocolState::PLAY
      end
      hook(client, scope, Rosegold::Clientbound::StartConfiguration) do
        clear if connection.same?(client.connection?) && client.current_protocol_state == Rosegold::ProtocolState::CONFIGURATION
      end
      hook(client, scope, Rosegold::Clientbound::Transfer) do
        synchronize
      end
      hook(client, scope, Rosegold::Event::Disconnected) do |event|
        clear if connection.same?(client.connection?) && event.reason.same?(connection.close_reason)
      end
    end

    private def hook(client : Rosegold::Client, scope : Scope, type : T.class, &block : T ->) : Nil forall T
      id = client.on(type, id: @hook_id) do |event|
        block.call(event) if @scope.try(&.unsubscribe).same?(scope.unsubscribe)
      rescue
        clear
      end
      scope.unsubscribe << -> { client.off(type, id); nil }
    end

    private def unsubscribe : Nil
      scope = @scope
      @scope = nil
      scope.try &.unsubscribe.each(&.call)
    end
  end
end
