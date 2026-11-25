require "set"
require "./cube_models"

module PackBuilder::SceneModels
  alias Unsupported = CubeModels::Unsupported
  alias Props = Hash(String, String)
  alias Point = Tuple(Float64, Float64, Float64)
  alias Quad = Tuple(Array(Float64), Array(Float64), Int32, Int32?)
  alias Part = Tuple(Array(Quad), Array(String))
  alias Variant = Tuple(Bool, Array(Int32))
  MAX_VARIANTS      =  256
  MAX_QUADS         = 1024
  MAX_FACES         =   48
  MAX_OVERLAY_BYTES = 32 * 1024

  class Table
    getter quads = [] of Quad
    getter variants = [] of Variant
    @quad_ids = {} of Quad => Int32
    @variant_ids = {} of Variant => Int32
    @bytes = 0
    @byte_limit : Int32? = nil

    def limit_overlay_growth : Nil
      @byte_limit = @bytes + MAX_OVERLAY_BYTES
    end

    def add?(cutout : Bool, quads : Array(Quad), &reserve : -> Bool) : Int32?
      return if quads.size > MAX_FACES
      pending = {} of Quad => Int32
      ids = quads.map do |quad|
        @quad_ids[quad]? || (pending[quad] ||= @quads.size + pending.size)
      end
      return if @quads.size + pending.size > MAX_QUADS
      key = {cutout, ids}
      existing = @variant_ids[key]?
      if existing
        return reserve.call ? existing : nil
      end
      return if @variants.size == MAX_VARIANTS
      cost = key.to_json.bytesize + 1 + pending.keys.sum { |quad| quad.to_json.bytesize + 1 }
      return if (limit = @byte_limit) && @bytes + cost > limit
      return unless reserve.call
      @bytes += cost
      pending.each do |quad, index|
        @quad_ids[quad] = index
        @quads << quad
      end
      @variant_ids[key] = @variants.size
      @variants << key
      @variants.size - 1
    end
  end

  class Sources
    @models = {} of String => Tuple(Array(JSON::Any), Hash(String, JSON::Any))
    @parts = {} of JSON::Any => Part

    def initialize(@assets : Layers | Archive)
    end

    def blockstate(name : String) : Hash(String, JSON::Any)
      @assets.object("#{ASSETS}blockstates/#{name}.json") || raise Unsupported.new("missing scene blockstate")
    end

    def parts(state : Hash(String, JSON::Any), props : Props) : Part
      parts = SceneModels.entries(state, props).map { |entry| @parts[entry] ||= bake(entry) }
      textures = [] of String
      quads = parts.flat_map do |faces, names|
        slots = names.map do |texture|
          textures.index(texture) || begin
            textures << texture
            textures.size - 1
          end
        end
        faces.map { |xyz, uv, slot, boundary| {xyz, uv, slots[slot], boundary} }
      end
      if quads.size > MAX_FACES || textures.size > 6
        raise Unsupported.new("too many faces or textures in scene mesh")
      end
      {quads, textures}
    end

    private def flatten(start : String) : Tuple(Array(JSON::Any), Hash(String, JSON::Any))
      elements = nil
      textures = {} of String => JSON::Any
      parents = Set(String).new
      name = start
      while name
        raise Unsupported.new("cyclic or deep scene model inheritance") unless parents.size < 16 && parents.add?(name)
        data = @assets.object("#{ASSETS}models/#{name}.json") || raise Unsupported.new("missing scene model")
        if own = data["textures"]?
          variables = own.as_h? || raise Unsupported.new("invalid scene texture variables")
          textures = variables.merge(textures)
        end
        if own = data["elements"]?
          elements ||= own.as_a? || raise Unsupported.new("invalid scene elements")
        end
        name = data["parent"]?.try { |parent| CubeModels.resource(parent) }
      end
      unless elements && elements.size <= MAX_FACES && textures.size <= 128
        raise Unsupported.new("missing or oversized scene model")
      end
      {elements, textures}
    end

    private def bake(value : JSON::Any) : Part
      entry = value.as_h? || raise Unsupported.new("invalid scene model entry")
      name = CubeModels.resource(entry["model"]?)
      x, y = SceneModels.turns(entry["x"]?), SceneModels.turns(entry["y"]?)
      lock = entry["uvlock"]?.try(&.as_bool?)
      raise Unsupported.new("invalid scene UV lock") if entry.has_key?("uvlock") && lock.nil?
      orientation = CubeModels::ORIENTATIONS[{x, y}]
      elements, textures = @models[name] ||= flatten(name)
      names = [] of String
      quads = [] of Quad
      elements.each do |data|
        element = data.as_h? || raise Unsupported.new("invalid scene element")
        lo = SceneModels.point(element["from"]?)
        hi = SceneModels.point(element["to"]?)
        faces = element["faces"]?.try(&.as_h?) || raise Unsupported.new("missing scene faces")
        rotation = element["rotation"]?.try { |field| SceneModels.rotation(field) }
        faces.each do |direction, raw_face|
          side = CubeModels::DIRECTIONS.index(direction) || raise Unsupported.new("invalid scene face direction")
          face = raw_face.as_h? || raise Unsupported.new("invalid scene face")
          texture = CubeModels.texture_ref(textures, face["texture"]?)
          slot = names.index(texture) || begin
            names << texture
            names.size - 1
          end
          corners = SceneModels.corners(side, lo, hi)
          uv = SceneModels.uv(face["uv"]?, side, lo, hi, SceneModels.turns(face["rotation"]?))
          dest = orientation[side][0]
          if lock
            uv = uv.each_slice(2).flat_map do |pair|
              point = CubeModels.transform(CubeModels.point(side, pair[0], pair[1]), x, y)
              CubeModels.face_uv(dest, *point).to_a.map(&.round(4))
            end.to_a
          end
          boundary = nil
          if rotation
            corners = corners.map { |corner| SceneModels.rotate(corner, rotation) }
          elsif corners[0][side >> 1] == (side.even? ? 1.0 : 0.0)
            boundary = dest
          end
          xyz = corners.flat_map do |corner|
            CubeModels.transform(corner, x, y).to_a.map do |coordinate|
              raise Unsupported.new("scene face outside coordinate bounds") unless -2 <= coordinate <= 3
              coordinate.round(4) + 0.0
            end
          end
          quads << {xyz, uv, slot, boundary}
          raise Unsupported.new("too many scene faces") if quads.size > MAX_FACES
        end
      end
      {quads, names}
    end
  end

  def self.entries(state : Hash(String, JSON::Any), props : Props) : Array(JSON::Any)
    if variants = state["variants"]?.try(&.as_h?)
      raise Unsupported.new("too many scene selectors") if variants.size > 512
      selected = variants.select do |key, _|
        raise Unsupported.new("oversized scene selector") if key.bytesize > 512
        key.empty? || key.split(',').all? do |pair|
          name, _, value = pair.partition('=')
          props[name]? == value
        end
      end
      raise Unsupported.new("ambiguous or absent scene variant") unless selected.size == 1
      return [choice(selected.first[1])]
    end
    multipart = state["multipart"]?.try(&.as_a?) || raise Unsupported.new("missing scene selectors")
    raise Unsupported.new("too many scene parts") if multipart.size > 32
    multipart.compact_map do |rule|
      part = rule.as_h? || raise Unsupported.new("invalid scene selector")
      condition = part["when"]?
      if !condition || matches?(condition, props, 0)
        choice(part["apply"]? || raise Unsupported.new("missing scene part"))
      end
    end
  end

  private def self.choice(entry : JSON::Any) : JSON::Any
    choices = entry.as_a?
    return entry unless choices
    raise Unsupported.new("invalid scene alternatives") unless 1 <= choices.size <= 32
    choices.first
  end

  private def self.matches?(condition : JSON::Any, props : Props, depth : Int32) : Bool
    fields = condition.as_h? || raise Unsupported.new("invalid multipart scene condition")
    raise Unsupported.new("oversized scene condition") if depth > 8 || fields.size > 16
    fields.all? do |key, value|
      if key.in?("OR", "AND")
        clauses = value.as_a? || raise Unsupported.new("invalid multipart scene clauses")
        raise Unsupported.new("oversized scene clause") unless 1 <= clauses.size <= 16
        key == "OR" ? clauses.any? { |clause| matches?(clause, props, depth + 1) } : clauses.all? { |clause| matches?(clause, props, depth + 1) }
      else
        options = value.as_s? || raise Unsupported.new("invalid multipart scene value")
        props[key]?.in?(options.split('|'))
      end
    end
  end

  def self.turns(value : JSON::Any?) : Int32
    return 0 unless value
    angle = CubeModels.angle?(value) || raise Unsupported.new("unsupported scene rotation")
    (angle // 90).to_i
  end

  def self.point(value : JSON::Any?) : Point
    values = vector(value, 3, -16, 32)
    {values[0], values[1], values[2]}
  end

  private def self.vector(value : JSON::Any?, size : Int32, min : Int32, max : Int32) : Array(Float64)
    array = value.try(&.as_a?)
    raise Unsupported.new("invalid scene vector") unless array && array.size == size
    array.map do |raw|
      number = CubeModels.number(raw)
      raise Unsupported.new("invalid scene coordinate") unless number && number.finite? && min <= number <= max
      number / 16
    end
  end

  alias Rotation = Tuple(Point, String, Float64, Bool)

  def self.rotation(value : JSON::Any) : Rotation
    fields = value.as_h? || raise Unsupported.new("invalid scene element rotation")
    angle = CubeModels.number(fields["angle"]?)
    axis = fields["axis"]?.try(&.as_s?)
    unless angle && angle.in?(-45.0, -22.5, 0.0, 22.5, 45.0) && axis && axis.in?("x", "y", "z")
      raise Unsupported.new("unsupported scene element rotation")
    end
    {point(fields["origin"]?), axis, angle * Math::PI / 180, fields["rescale"]?.try(&.as_bool?) == true}
  end

  def self.rotate(point : Point, rotation : Rotation) : Point
    origin, axis, angle, rescale = rotation
    ox, oy, oz = origin
    x, y, z = point[0] - ox, point[1] - oy, point[2] - oz
    c, s = Math.cos(angle), Math.sin(angle)
    scale = rescale ? 1 / c : 1.0
    case axis
    when "x" then y, z = (y * c - z * s) * scale, (y * s + z * c) * scale
    when "y" then x, z = (x * c + z * s) * scale, (z * c - x * s) * scale
    else          x, y = (x * c - y * s) * scale, (x * s + y * c) * scale
    end
    {x + ox, y + oy, z + oz}
  end

  def self.corners(face : Int32, lo : Point, hi : Point) : Array(Point)
    x, y, z = lo
    a, b, c = hi
    case face
    when 0 then [{a, b, c}, {a, y, c}, {a, y, z}, {a, b, z}]
    when 1 then [{x, b, z}, {x, y, z}, {x, y, c}, {x, b, c}]
    when 2 then [{x, b, z}, {x, b, c}, {a, b, c}, {a, b, z}]
    when 3 then [{x, y, c}, {x, y, z}, {a, y, z}, {a, y, c}]
    when 4 then [{x, b, c}, {x, y, c}, {a, y, c}, {a, b, c}]
    else        [{a, b, z}, {a, y, z}, {x, y, z}, {x, b, z}]
    end
  end

  def self.uv(value : JSON::Any?, side : Int32, lo : Point, hi : Point, turns : Int32) : Array(Float64)
    if value
      u, v, a, b = vector(value, 4, 0, 16)
    else
      u, v = CubeModels.face_uv(side, *corners(side, lo, hi)[0])
      a, b = CubeModels.face_uv(side, *corners(side, lo, hi)[2])
      unless [u, v, a, b].all? { |coordinate| 0 <= coordinate <= 1 }
        raise Unsupported.new("implicit scene UV outside texture bounds")
      end
    end
    [[u, v], [u, b], [a, b], [a, v]].rotate(turns).flatten.map { |coordinate| coordinate.round(4) + 0.0 }
  end
end
