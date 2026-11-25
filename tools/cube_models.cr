require "json"
require "./pack_assets"

module PackBuilder
  module CubeModels
    class Unsupported < Exception
    end

    DIRECTIONS = %w(east west up down south north)
    UV         = [{0, 0}, {0, 1}, {1, 1}, {1, 0}]
    ANGLES     = [0, 90, 180, 270]
    RESOURCE   = /\A(?:minecraft:)?block\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\z/
    MODEL_KEYS = %w(parent textures elements ambientocclusion display gui_light)
    FACE_KEYS  = %w(texture cullface uv rotation)
    TILE       = 16

    alias Face = Tuple(String, Bool, Bool, Int32)
    alias Selector = Tuple(Hash(String, String), Array(JSON::Any))

    def self.resource(value : JSON::Any?) : String
      text = value.try(&.as_s?)
      if text.nil? || text.size > 256 || !RESOURCE.matches?(text)
        raise Unsupported.new("unsupported resource reference")
      end
      text.lchop("minecraft:")
    end

    def self.texture_ref(textures : Hash(String, JSON::Any), value : JSON::Any?) : String
      seen = Set(String).new
      while (text = value.try(&.as_s?)) && text.starts_with?('#')
        key = text[1..]
        raise Unsupported.new("unresolved texture alias") if seen.includes?(text) || !textures.has_key?(key)
        seen << text
        value = textures[key]
      end
      resource(value)
    end

    def self.number(value : JSON::Any?) : Float64?
      raw = value.try(&.raw)
      case raw
      when Int64   then raw.to_f
      when Float64 then raw
      end
    end

    def self.numbers?(value : JSON::Any?, expected : Array(Int32)) : Bool
      array = value.try(&.as_a?)
      return false unless array && array.size == expected.size
      array.zip(expected).all? { |item, wanted| number(item) == wanted.to_f }
    end

    def self.integer?(value : JSON::Any?) : Int64?
      value.try(&.raw).as?(Int64)
    end

    def self.angle?(value : JSON::Any?) : Int64?
      angle = integer?(value)
      angle if angle && ANGLES.includes?(angle)
    end

    class Sources
      @models = {} of String => Array(Face)
      @textures = {} of String => Image
      @oriented = {} of Face => Image

      def initialize(@assets : Layers)
      end

      def object(path : String) : Hash(String, JSON::Any)
        @assets.object(path) || raise Unsupported.new("missing model or blockstate")
      end

      def model(name : String) : Array(Face)
        @models[name] ||= resolve_model(name)
      end

      private def resolve_model(start : String) : Array(Face)
        elements = nil
        ambient = nil
        textures = {} of String => JSON::Any
        seen = Set(String).new
        name = start
        while name
          name = CubeModels.resource(JSON::Any.new(name))
          raise Unsupported.new("cyclic or deep model inheritance") if seen.includes?(name) || seen.size == 32
          seen << name
          model = object("assets/minecraft/models/#{name}.json")
          raise Unsupported.new("unsupported model feature") unless (model.keys - MODEL_KEYS).empty?
          if model.has_key?("textures")
            own = model["textures"].as_h? || raise Unsupported.new("invalid model or metadata")
            textures = own.merge(textures)
          end
          if elements.nil? && model.has_key?("elements")
            elements = model["elements"].as_a? || raise Unsupported.new("invalid model or metadata")
          end
          if ambient.nil? && model.has_key?("ambientocclusion")
            ambient = model["ambientocclusion"]
            raise Unsupported.new("unsupported shading") unless ambient.raw == true
          end
          name = model.has_key?("parent") ? CubeModels.resource(model["parent"]) : nil
        end
        single = elements.try(&.first?)
        element = single.try(&.as_h?)
        unless elements && elements.size == 1 && element
          raise Unsupported.new("not a single full cube")
        end
        unless (element.keys - %w(from to faces shade light_emission)).empty? &&
               CubeModels.numbers?(element["from"]?, [0, 0, 0]) && CubeModels.numbers?(element["to"]?, [16, 16, 16])
          raise Unsupported.new("not a single full cube")
        end
        if (element.has_key?("shade") && element["shade"].raw != true) ||
           (element.has_key?("light_emission") && CubeModels.number(element["light_emission"]) != 0.0)
          raise Unsupported.new("unsupported shading")
        end
        faces = element["faces"]?.try(&.as_h?)
        raise Unsupported.new("not a single full cube") unless faces && faces.keys.sort == DIRECTIONS.sort
        DIRECTIONS.map do |direction|
          face = faces[direction].as_h? || raise Unsupported.new("unsupported face culling")
          raise Unsupported.new("unsupported face culling") unless face["cullface"]?.try(&.as_s?) == direction
          raise Unsupported.new("unsupported face feature") unless (face.keys - FACE_KEYS).empty?
          uv = face["uv"]? ? face["uv"].as_a? : [0, 0, 16, 16].map { |value| JSON::Any.new(value.to_i64) }
          values = uv.try(&.map { |value| CubeModels.number(value) })
          unless uv && values && uv.size == 4 && values.all?
            raise Unsupported.new("unsupported face UV")
          end
          floats = values.map(&.not_nil!)
          unless [floats[0], floats[2]].sort == [0.0, 16.0] && [floats[1], floats[3]].sort == [0.0, 16.0]
            raise Unsupported.new("unsupported face UV")
          end
          turns = face.has_key?("rotation") ? CubeModels.angle?(face["rotation"]) : 0_i64
          raise Unsupported.new("unsupported face UV") unless turns
          {CubeModels.texture_ref(textures, face["texture"]?), floats[0] == 16.0, floats[1] == 16.0, (turns // 90).to_i}
        end
      end

      def texture(name : String) : Image
        @textures[name] ||= load_texture(name)
      end

      private def load_texture(name : String) : Image
        found = nil
        @assets.texture_layers("assets/minecraft/textures/#{name}.png") do |image, metadata, _archive|
          next unless (metadata.keys - ["texture"]).empty?
          next unless image.width == image.height && {16, 32, 64}.includes?(image.width)
          next unless image.alpha_extrema == {255, 255}
          found = image.resize(TILE, TILE)
          break
        end
        found || raise Unsupported.new("missing or unsupported opaque texture")
      end

      def oriented(face : Face) : Image
        @oriented[face] ||= orient(face)
      end

      private def orient(face : Face) : Image
        name, mirror_u, mirror_v, turns = face
        source = texture(name)
        last = TILE - 1
        result = Image.new(TILE, TILE)
        TILE.times do |y|
          TILE.times do |x|
            sx, sy = x, y
            case turns
            when 1 then sx, sy = y, last - x
            when 2 then sx, sy = last - x, last - y
            when 3 then sx, sy = last - y, x
            end
            sx = last - sx if mirror_u
            sy = last - sy if mirror_v
            result.set_pixel(x, y, source.pixel(sx, sy))
          end
        end
        result
      end
    end

    def self.point(face : Int32, u : Float64, v : Float64) : Tuple(Float64, Float64, Float64)
      case face
      when 0 then {1.0, 1 - v, 1 - u}
      when 1 then {0.0, 1 - v, u}
      when 2 then {u, 1.0, v}
      when 3 then {u, 0.0, 1 - v}
      when 4 then {u, 1 - v, 1.0}
      else        {1 - u, 1 - v, 0.0}
      end
    end

    def self.face_uv(face : Int32, x : Float64, y : Float64, z : Float64) : Tuple(Float64, Float64)
      case face
      when 0 then {1 - z, 1 - y}
      when 1 then {z, 1 - y}
      when 2 then {x, z}
      when 3 then {x, 1 - z}
      when 4 then {x, 1 - y}
      else        {1 - x, 1 - y}
      end
    end

    def self.transform(point : Tuple(Float64, Float64, Float64), x_turns : Int32, y_turns : Int32)
      x, y, z = point
      x_turns.times { y, z = z, 1 - y }
      y_turns.times { x, z = 1 - z, x }
      {x, y, z}
    end

    ORIENTATIONS = begin
      table = {} of Tuple(Int32, Int32) => Array(Tuple(Int32, Int32))
      4.times do |x_turns|
        4.times do |y_turns|
          table[{x_turns, y_turns}] = (0...6).map do |source|
            corners = UV.map { |u, v| transform(point(source, u.to_f, v.to_f), x_turns, y_turns) }
            axes = (0...3).select { |axis| corners.map { |corner| corner[axis] }.uniq.size == 1 }
            raise "state transform is not a face" unless axes.size == 1
            axis = axes.first
            dest = axis * 2 + (1 - corners[0][axis]).to_i
            mapped = corners.map { |corner| face_uv(dest, *corner) }
            turns = UV.index { |u, v| {u.to_f, v.to_f} == mapped[0] } || raise "state transform is not a UV rotation"
            expected = (UV[turns..] + UV[...turns]).map { |u, v| {u.to_f, v.to_f} }
            raise "state transform is not a UV quadrant rotation" unless mapped == expected
            {dest, turns}
          end
        end
      end
      table
    end

    def self.variant_faces(sources : Sources, entry : JSON::Any) : Array(Face?)
      hash = entry.as_h?
      unless hash && (hash.keys - %w(model x y uvlock weight)).empty?
        raise Unsupported.new("unsupported state transform")
      end
      x = hash.has_key?("x") ? angle?(hash["x"]) : 0_i64
      y = hash.has_key?("y") ? angle?(hash["y"]) : 0_i64
      lock = hash.has_key?("uvlock") ? hash["uvlock"].as_bool? : false
      weight = hash.has_key?("weight") ? integer?(hash["weight"]) : 1_i64
      if x.nil? || y.nil? || lock.nil? || (lock && (x != 0 || y != 0)) || weight.nil? || weight < 1
        raise Unsupported.new("unsupported state transform")
      end
      result = Array(Face?).new(6, nil)
      sources.model(resource(hash["model"]?)).zip(ORIENTATIONS[{(x // 90).to_i, (y // 90).to_i}]) do |(name, mirror_u, mirror_v, face_turns), (dest, state_turns)|
        result[dest] = {name, mirror_u, mirror_v, (face_turns - state_turns) % 4}
      end
      result
    end

    class Sources
      def selectors(name : String) : Array(Selector)
        data = object("assets/minecraft/blockstates/#{name}.json")
        raise Unsupported.new("multipart model") if data.has_key?("multipart")
        variants = data["variants"]?.try(&.as_h?)
        raise Unsupported.new("unsupported blockstate") unless data.keys == ["variants"] && variants
        raise Unsupported.new("too many variant selectors") if variants.size > 512
        variants.map do |key, models|
          list = models.as_a?
          raise Unsupported.new("oversized model selector") if key.size > 512 || (list && list.size > 32)
          pairs = key.empty? ? [] of Array(String) : key.split(",", remove_empty: false).map(&.split("=", remove_empty: false))
          if pairs.any? { |pair| pair.size != 2 || pair.any?(&.empty?) }
            raise Unsupported.new("invalid variant selector")
          end
          wanted = pairs.to_h { |pair| {pair[0], pair[1]} }
          raise Unsupported.new("invalid variant selector") unless wanted.size == pairs.size
          {wanted, list || [models]}
        end
      end

      def state_faces(selectors : Array(Selector), props : Hash(String, String)) : Array(Image)
        selected = selectors.select { |wanted, _| wanted.all? { |key, value| props[key]? == value } }
        raise Unsupported.new("ambiguous or absent variant") unless selected.size == 1 && !selected[0][1].empty?
        result = nil
        selected[0][1].each do |model|
          tiles = CubeModels.variant_faces(self, model).map { |face| oriented(face.not_nil!) }
          if result.nil?
            result = tiles
          elsif result.zip(tiles).any? { |a, b| a.pixels != b.pixels }
            raise Unsupported.new("weighted alternatives differ")
          end
        end
        result.not_nil!
      end
    end
  end
end
