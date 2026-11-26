require "json"
require "./player_skins"

module RosegoldViewer
  private class Entities
    MAX_ROWS         =         24
    private MAX_RECENT       =        256
    private SCAN_BUDGET      =        256
    private MAX_BYTES        =       4096
    private MAX_AXIS         = 30_000_000
    private RANGE_SQUARED    = 40 ** 2
    private DRAWABLE_SPECIES = {"item", "cow", "sheep", "pig", "chicken", "villager", "player"}

    private alias Vector = Tuple(Float64, Float64, Float64)
    private alias Item = NamedTuple(name: String, count: UInt32)
    private alias Candidate = Tuple(Float64, UInt64, Rosegold::Entity, String, Item?)
    private record Row, id : UInt64, position : Vector, species : String, yaw : Float32, pitch : Float32,
      pose : UInt32, item : Item?, appearance : PlayerSkins::Appearance? do
      include JSON::Serializable
    end
    private record Visible, entity : Rosegold::Entity, id : UInt64

    @world : Rosegold::Dimension?
    @scan : Iterator(UInt64)?
    @known = {} of UInt64 => Nil
    @visible = {} of UInt64 => Visible
    @next_id = 0_u64
    @species : Hash(UInt32, String)?
    @items : Hash(UInt32, String)?

    def initialize(@protocol : UInt32, @skins : PlayerSkins)
    end

    def reset : Nil
      @world = nil
      @scan = nil
      @known.clear
      @visible.clear
    end

    def name_for(entity_type : UInt32) : String?
      species_names[entity_type]?
    end

    def observe(world : Rosegold::Dimension, id : UInt64) : Nil
      synchronize(world)
      return if @known.has_key?(id)
      return unless (entity = world.entities[id]?) && DRAWABLE_SPECIES.includes?(name_for(entity.entity_type))
      @known.shift if @known.size == MAX_RECENT
      @known[id] = nil
    end

    def sample(world : Rosegold::Dimension, eye : Vector, self_id : UInt64) : String
      synchronize(world)
      candidates = [] of Candidate
      @known.reject! { |id, _| !world.entities.has_key?(id) }
      @known.each_key { |id| consider(world, eye, id, self_id, candidates) }
      @visible.each_key do |id|
        consider(world, eye, id, self_id, candidates) unless @known.has_key?(id)
      end
      scan = @scan ||= world.entities.each_key
      SCAN_BUDGET.times do
        id = scan.next
        if id.is_a?(Iterator::Stop)
          @scan = nil
          break
        end
        consider(world, eye, id, self_id, candidates) unless @known.has_key?(id) || @visible.has_key?(id)
      end
      candidates.sort_by! { |distance, id, _, _, _| {distance, id} }

      visible = {} of UInt64 => Visible
      payloads = [] of Tuple(UInt64, String)
      size = 2
      candidates.first(MAX_ROWS).each do |_, id, entity, species, item|
        appearance = species == "player" ? @skins.appearance(entity.uuid) : nil
        current = @visible[id]?
        token = current && current.entity.same?(entity) ? current.id : @next_id + 1
        pos = entity.position
        row = Row.new(token, {pos.x.round(4), pos.y.round(4), pos.z.round(4)}, species,
          angle(entity.yaw, 0_f32), angle(entity.pitch, -180_f32), entity.pose || 0_u32, item, appearance).to_json
        break if size + row.bytesize + 1 > MAX_BYTES
        @next_id = token if token > @next_id
        visible[id] = Visible.new(entity, token)
        payloads << {token, row}
        size += row.bytesize + 1
      end
      @visible = visible
      String.build do |io|
        io << '['
        payloads.sort_by!(&.[0]).each_with_index do |(_, row), index|
          io << ',' unless index.zero?
          io << row
        end
        io << ']'
      end
    end

    private def synchronize(world : Rosegold::Dimension) : Nil
      return if @world.same?(world)
      reset
      @world = world
    end

    private def consider(world, eye, id, self_id, candidates) : Nil
      return if id == self_id
      return unless entity = world.entities[id]?
      return if entity.invisible?
      pos = entity.position
      return unless valid_axis?(pos.x) && valid_axis?(pos.y) && valid_axis?(pos.z)
      distance = (pos.x - eye[0]) ** 2 + (pos.y - eye[1]) ** 2 + (pos.z - eye[2]) ** 2
      return unless distance <= RANGE_SQUARED
      return unless (species = name_for(entity.entity_type)) && DRAWABLE_SPECIES.includes?(species)
      item = item_stack(entity) if species == "item"
      return if species == "item" && item.nil?
      candidates << {distance, id, entity, species, item}
    end

    private def valid_axis?(axis : Float64) : Bool
      -MAX_AXIS <= axis <= MAX_AXIS
    end

    private def angle(value : Float32, offset : Float32) : Float32
      return 0_f32 unless value.finite?
      (((value.to_f64 - offset) % 360.0).round(3) % 360.0 + offset).to_f32
    end

    private def species_names : Hash(UInt32, String)
      @species ||= begin
        Array(Rosegold::Entity::Metadata).from_json(species_json)
          .to_h { |entry| {entry.id.to_u32, entry.name} }
      end
    end

    private def species_json : String
      {% begin %}
      case @protocol
      {% for protocol in [775, 777] %}
        {% if version = Rosegold::ENABLED_PROTOCOLS[protocol] %}
          when {{protocol}}_u32
            Minecraft::Data.read_asset({{version + "/entities.json"}})
        {% end %}
      {% end %}
      else
        raise "Unsupported viewer protocol: #{@protocol}"
      end
      {% end %}
    end

    private def item_stack(entity : Rosegold::Entity) : Item?
      if (slot = entity.item_stack) && slot.present?
        names = @items ||= Rosegold::MCData.for(@protocol).items.to_h { |entry| {entry.id, entry.name} }
        if name = names[slot.item_id_int]?
          {name: name, count: slot.count.clamp(1_u32, 999_u32)}
        end
      end
    end
  end
end
