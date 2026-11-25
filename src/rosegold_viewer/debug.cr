require "json"

class Rosegold::Interactions
  def debug_crosshair : {Symbol, Vec3i?, UInt16?, String?}?
    case hit = reach_block_or_entity
    when ReachedBlock
      {:block, hit.block, client.dimension.block_state(hit.block), nil}
    when ReachedEntity
      {:entity, nil, nil, hit.entity.metadata.try(&.name)}
    end
  end
end

class Rosegold::Client
  def debug_crosshair
    interactions.debug_crosshair
  end
end

module RosegoldViewer
  private class Debug
    alias Target = NamedTuple(kind: String, position: Tuple(Int32, Int32, Int32)?, id: String?, props: Hash(String, String)?)
    alias Snapshot = NamedTuple(
      feet: Tuple(Float64, Float64, Float64),
      rotation: Tuple(Float32, Float32),
      dimension: String,
      time: Int64?,
      target: Target?)

    MAX_PROPS = 16

    @blocks : Array(Minecraft::Data::Block)?

    def initialize(@protocol : UInt32)
    end

    def sample(bot : Rosegold::Bot) : Snapshot
      feet = bot.location
      look = bot.look
      dimension = bot.world
      {
        feet:      {feet.x, feet.y, feet.z},
        rotation:  {look.yaw.finite? ? look.yaw : 0_f32, look.pitch.finite? ? look.pitch.clamp(-90_f32, 90_f32) : 0_f32},
        dimension: dimension.name.size <= 64 ? dimension.name : "unknown",
        time:      dimension.world_age.zero? ? nil : dimension.time_of_day,
        target:    target(bot),
      }
    end

    private def target(bot : Rosegold::Bot) : Target?
      hit = bot.client.debug_crosshair
      return unless hit
      kind, position, state, entity = hit
      if kind == :entity
        return {kind: "entity", position: nil, id: entity.try { |name| qualified(name) }, props: nil}
      end
      return unless position
      block = state.try { |value| find_block(value) }
      {
        kind:     "block",
        position: {position.x, position.y, position.z},
        id:       block.try { |found| qualified(found.id_str) },
        props:    block && state ? properties(block, state) : nil,
      }
    end

    private def qualified(name : String) : String?
      name.size <= 64 && name.each_char.all? { |char| char.ascii_lowercase? || char.ascii_number? || char.in?('_', ':', '/', '.', '-') } ? (name.includes?(':') ? name : "minecraft:#{name}") : nil
    end

    private def find_block(state : UInt16) : Minecraft::Data::Block?
      blocks = @blocks ||= Rosegold::MCData.for(@protocol).blocks
      blocks.find { |block| block.min_state_id <= state <= block.max_state_id }
    end

    private def properties(block : Minecraft::Data::Block, state : UInt16) : Hash(String, String)?
      return if block.states.empty? || block.states.size > MAX_PROPS
      offset = (state - block.min_state_id).to_i
      result = Hash(String, String).new
      block.states.reverse_each do |property|
        count = property.num_values.to_i
        return if count.zero?
        index = offset % count
        offset //= count
        value = case property.type
                when .bool? then index.zero? ? "true" : "false"
                when .int?  then (property.values.try(&.[index]?) || index.to_s)
                else             property.values.try(&.[index]?) || return
                end
        result[property.name] = value
      end
      result
    end
  end
end
