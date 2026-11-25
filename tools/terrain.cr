require "json"
require "./scene_models"
require "./terrain_rules"

module PackBuilder::Terrain
  alias Rules = TerrainRules
  alias Props = Rules::Props
  alias Frames = Tuple(Hash(Int32, Image), Array(Tuple(Int32, Int32)))
  alias Faces = Array(Int32)
  alias Animation = Array(Tuple(Int32, Int32))
  TILE         = 16
  MAX_ROWS     = 32
  MAX_COLUMNS  = 38
  MAX_TILES    = MAX_ROWS * MAX_COLUMNS
  MAX_ITEMS    = 1024
  NAME         = /\A[a-z0-9_]{1,64}\z/
  RESOURCE     = /\A(?:minecraft:)?(?:block|item)\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\z/
  FLUIDS       = {"water", "lava"}
  SCENE_BLOCKS = %w(stone_brick_slab spruce_slab stone_brick_wall lily_pad campfire hopper chest spruce_trapdoor)
  SCENE_CUTOUT = %w(lily_pad campfire hopper spruce_trapdoor)
  PREFERRED    = %w(wheat_seeds bread wheat carrot potato beetroot beetroot_seeds melon_seeds pumpkin_seeds porkchop beef mutton chicken feather
    melon_slice sugar_cane torch composter rail lantern bone_meal apple stick bucket water_bucket lava_bucket redstone string coal iron_ingot
    gold_ingot diamond emerald bow arrow shield fishing_rod shears flint_and_steel elytra)
  GEAR = /\A(?:wooden|stone|copper|iron|golden|chainmail|leather|diamond|netherite|turtle)_(?:axe|pickaxe|hoe|shovel|spear|sword|boots|chestplate|helmet|leggings)\z/

  record Block, name : String, start : Int32, props : Hash(String, Array(String)) do
    def states(& : Int32, Props ->)
      keys = props.keys
      values = props.values
      count = values.reduce(1) { |total, options| total * options.size }
      count.times do |offset|
        remainder = offset
        properties = Props.new
        (keys.size - 1).downto(0) do |i|
          options = values[i]
          properties[keys[i]] = options[remainder % options.size]
          remainder //= options.size
        end
        yield start + offset, properties
      end
    end
  end

  record TileRange, min : Int32, max : Int32, faces : Faces, model : String?, variant : Int32? do
    def to_json(json : JSON::Builder)
      json.object do
        json.field "min", min
        json.field "max", max
        json.field "faces", faces
        json.field "model", model if model
        json.field "variant", variant if variant
      end
    end
  end

  record Material, faces : Faces, model : String?, variant : Int32?

  class Atlas
    getter meshes = SceneModels::Table.new
    getter images = [] of Image
    getter blocks = {} of Int32 => Material
    @indices = {} of String => Int32

    def add(images : Array(Image)) : Faces?
      pixels = images.map { |image| String.new(image.pixels) }
      return if @indices.size + pixels.uniq.count { |p| !@indices.has_key?(p) } > MAX_TILES
      pixels.map_with_index do |key, i|
        @indices[key] ||= begin
          @images << images[i]
          @images.size - 1
        end
      end
    end

    def put(state : Int32, faces : Faces, model : String? = nil, variant : Int32? = nil)
      @blocks[state] = Material.new(faces, model, variant)
    end

    def put_mesh(state : Int32, images : Array(Image), cutout : Bool, quads : Array(SceneModels::Quad)) : Bool
      indices = nil
      variant = @meshes.add?(cutout, quads) { !!(indices = add(images)) }
      if variant && (faces = indices)
        put(state, faces + Array.new(6 - faces.size, faces.first? || -1), "mesh", variant)
        return true
      end
      false
    end

    def ranges : Array(TileRange)
      ranges = [] of TileRange
      @blocks.keys.sort!.each do |state|
        material = @blocks[state]
        if (last = ranges.last?) && last.max == state - 1 && last.faces == material.faces && last.model == material.model && last.variant == material.variant
          ranges[-1] = TileRange.new(last.min, state, last.faces, last.model, last.variant)
        else
          ranges << TileRange.new(state, state, material.faces, material.model, material.variant)
        end
      end
      ranges
    end
  end

  def self.texture_path(name : String) : String
    "#{ASSETS}textures/#{name}.png"
  end

  private def self.resource(value : JSON::Any?) : String?
    if (name = value.try(&.as_s?)) && name.bytesize <= 256 && RESOURCE.matches?(name)
      name.lchop("minecraft:")
    end
  end

  private def self.cutout(image : Image) : Bool
    lo, hi = image.alpha_extrema
    lo < 128 <= hi
  end

  private def self.sprite(assets : Layers, name : String, animated : Bool = false, & : Image -> Bool) : Image?
    assets.texture_layers(texture_path(name)) do |image, meta, _layer|
      width = image.width
      next unless width.in?(16, 32, 64) && image.height >= width && (image.height % width).zero?
      next if !animated && (meta.has_key?("animation") || image.height != width)
      tile = image.crop(0, 0, width, width).resize(TILE, TILE)
      return tile if yield tile
    end
    nil
  end

  private def self.sprite(assets : Layers, name : String, animated : Bool = false) : Image?
    sprite(assets, name, animated) { true }
  end

  private def self.foliage(tile : Image) : Image
    Rules.multiply(tile, {145_u8, 189_u8, 89_u8, 255_u8})
  end

  private def self.authored_tile(assets : Layers, name : String, model : String?) : Image?
    base = name.lchop("@")
    if model == "fence" && base.starts_with?("fence/")
      if tile = sprite(assets, "block/" + base) { |image| cutout(image) }
        return tile
      end
      base = base.split('/').last.sub("_fence", "_planks")
    end
    if model == "composter" && base.starts_with?("composter/")
      if tile = sprite(assets, "block/" + base)
        return tile
      end
      base = base.split('/').last
      base = "composter_compost" if base.starts_with?("composter_compost")
    end
    pix = sprite(assets, "block/" + base, model.nil? || model == "lantern") do |image|
      case model
      when "glass"
        lo, hi = image.alpha_extrema
        lo < 255 && hi > 0
      when "leaves", "crop", "cross", "rail", "lantern"
        cutout(image)
      else
        true
      end
    end
    return unless pix
    if model == "glass" && !cutout(pix)
      low, high = pix.alpha_extrema
      if low < high
        i = 3
        while i < pix.pixels.size
          pix.pixels[i] = pix.pixels[i] == high ? 255_u8 : 0_u8
          i += 4
        end
      end
    end
    if base == "grass_block_side"
      if overlay = sprite(assets, "block/grass_block_side_overlay")
        pix.composite(foliage(overlay))
      end
      return pix
    end
    name.starts_with?("@") ? foliage(pix) : pix
  end

  private def self.authored(assets : Layers, atlas : Atlas, blocks : Array(Block))
    cache = {} of Tuple(String, String?) => Image?
    blocks.each do |block|
      name = block.name
      next if FLUIDS.includes?(name)
      legacy = Rules.legacy(name)
      plant_name, plant = Rules.plant(name)
      shape_name, shape = Rules.shapes(name)
      next unless legacy || plant || shape
      block.states do |state, props|
        next if atlas.blocks.has_key?(state)
        next if SCENE_BLOCKS.includes?(name) && name.ends_with?("_slab") && props["type"]? != "double"
        choices = [] of Tuple(Array(String), String?, Int32?)
        if rule = shape
          textures, variant = rule.call(props)
          choices << {textures, shape_name, variant}
        end
        choices << {(legacy || plant).not_nil!.call(props), plant_name, nil} if plant
        choices << {legacy.call(props), nil, nil} if legacy
        choices.each do |textures, model, variant|
          images = textures.compact_map do |name|
            key = {name, model}
            if cache.has_key?(key)
              cache[key]
            else
              cache[key] = authored_tile(assets, name, model)
            end
          end
          next unless images.size == textures.size
          indices = atlas.add(images) || raise Error.new("atlas is full at required terrain block #{name}")
          atlas.put(state, indices, model, variant)
          break
        end
      end
    end
  end

  private def self.chests(assets : Layers, atlas : Atlas, block : Block)
    full = assets.image(texture_path("entity/chest/normal")) { |image| image.width == 64 && image.height == 64 }
    return unless full
    images = (0...4).map do |i|
      tile = Image.new(TILE, TILE)
      tile.paste(full.crop(i * 14, 14, 14, 5))
      tile.paste(full.crop(i * 14, 34, 14, 9), 0, 5)
      tile
    end
    { {14, 0}, {28, 19} }.each do |x, y|
      tile = Image.new(TILE, TILE)
      tile.paste(full.crop(x, y, 14, 14))
      images << tile
    end
    indices = atlas.add(images) || raise Error.new("atlas is full at required chest textures")
    inset, span = 1.0 / 16, 14.0 / 16
    quads = (0...6).map do |side|
      points = SceneModels.corners(side, {inset, 0.0, inset}, {1 - inset, span, 1 - inset})
      {points.flat_map(&.to_a), [0.0, 0.0, 0.0, span, span, span, span, 0.0], side, nil.as(Int32?)}
    end
    variant = atlas.meshes.add?(false, quads) { true } || return
    headings = %w(east south west north)
    side_tiles = [3, 2, 1, 0]
    block.states do |state, props|
      next unless props["type"]? == "single"
      heading = headings.index(props["facing"]?) || next
      east, south, west, north = side_tiles.rotate(-heading)
      atlas.put(state, [east, west, 4, 5, south, north].map { |face| indices[face] }, "mesh", variant)
    end
  end

  private def self.scene(assets : Layers, atlas : Atlas, blocks : Array(Block))
    supported = blocks.select { |block| SCENE_BLOCKS.includes?(block.name) }
    if chest = supported.find { |block| block.name == "chest" }
      chests(assets, atlas, chest)
    end
    supported.reject! { |block| block.name == "chest" }
    vanilla = assets.overlay ? Layers.new(assets.jar) : assets
    scene_layer(vanilla, atlas, supported)
    rejected = 0
    if assets.overlay
      atlas.meshes.limit_overlay_growth
      rejected = scene_layer(assets, atlas, supported)
    end
    unless atlas.meshes.variants.empty?
      puts "Scene models: #{atlas.meshes.variants.size} variants; #{rejected} overlay states kept their fallback."
    end
  end

  private def self.scene_layer(assets : Layers, atlas : Atlas, blocks : Array(Block)) : Int32
    sources = SceneModels::Sources.new(assets)
    cubes = CubeModels::Sources.new(assets)
    textures = {} of Tuple(String, Bool) => Image?
    rejected = 0
    blocks.each do |block|
      state_data = sources.blockstate(block.name)
      tint = block.name == "lily_pad"
      cutout = SCENE_CUTOUT.includes?(block.name)
      block.states do |state, props|
        begin
          if props["type"]? == "double"
            tiles = cubes.state_faces(cubes.selectors(block.name), props)
            if indices = atlas.add(tiles)
              atlas.put(state, indices)
            else
              rejected += 1
            end
            next
          end
          quads, names = sources.parts(state_data, props)
          images = names.compact_map do |name|
            key = {name, tint}
            textures.fetch(key) do
              tile = sprite(assets, name, true)
              textures[key] = tile && tint ? Rules.multiply(tile, {32_u8, 128_u8, 48_u8, 255_u8}) : tile
            end
          end
          rejected += 1 unless images.size == names.size && atlas.put_mesh(state, images, cutout, quads)
        rescue SceneModels::Unsupported
          rejected += 1
        end
      end
    rescue SceneModels::Unsupported
      next
    end
    rejected
  end

  private def self.fluid_frames(assets : Layers, texture : String) : Frames?
    assets.texture_layers(texture_path("block/" + texture)) do |image, meta, _|
      width = image.width
      next unless width.in?(16, 32, 64) && (image.height % width).zero?
      count = image.height // width
      next unless 1 <= count <= 128
      raw_animation = meta["animation"]?
      animation = raw_animation ? raw_animation.as_h? : count == 1 ? {} of String => JSON::Any : nil
      next unless animation && animation.keys.all?(&.in?("frametime", "frames", "interpolate", "width", "height"))
      next unless {"width", "height"}.all? { |key| !animation.has_key?(key) || animation[key].as_i64? == width }
      raw_time = animation["frametime"]?
      default = raw_time ? raw_time.as_i64? : 1_i64
      raw_frames = animation["frames"]?
      frames = raw_frames ? raw_frames.as_a? : (0...count).map { |i| JSON::Any.new(i.to_i64) }
      next unless frames && 1 <= frames.size <= 256
      sequence = frames.compact_map do |entry|
        if entry.as_h?
          time_field = entry["time"]?
          index, time = entry["index"]?.try(&.as_i64?), time_field ? time_field.as_i64? : default
        else
          index, time = entry.as_i64?, default
        end
        {index.to_i, time.to_i} if index && time && 0 <= index < count && 1 <= time <= 1200
      end
      next unless sequence.size == frames.size
      # The renderer wraps one flow quadrant; a still texture uses the whole frame.
      size = texture.ends_with?("_flow") && width > TILE ? width // 2 : width
      indices = (sequence.map(&.[0]) + [0]).uniq.sort!
      tiles = indices.to_h { |i| {i, image.crop(0, i * width, size, size).resize(TILE, TILE)} }
      water = texture.starts_with?("water")
      if tiles.values.all? { |tile| lo, hi = tile.alpha_extrema; water ? 0 < lo <= hi < 255 : lo == 255 }
        return {tiles, sequence}
      end
    end
    nil
  end

  private def self.fluids(assets : Layers, atlas : Atlas, blocks : Array(Block)) : Hash(String, Animation)
    animations = {} of String => Animation
    blocks.each do |block|
      name = block.name
      next unless FLUIDS.includes?(name)
      still = fluid_frames(assets, name + "_still")
      flow = fluid_frames(assets, name + "_flow")
      next unless still && flow
      indices = atlas.add(still[0].values + flow[0].values) || raise Error.new("atlas is full at required #{name} textures")
      still_ids = still[0].keys.zip(indices[0, still[0].size]).to_h
      flow_ids = flow[0].keys.zip(indices[still[0].size..]).to_h
      block.states { |state, props| atlas.put(state, Rules.faces(flow_ids[0], still_ids[0]), name, props["level"].to_i) }
      { {"Still", still[1], still_ids}, {"Flow", flow[1], flow_ids} }.each do |suffix, sequence, ids|
        sequence = sequence * 2 if sequence.size == 1 && sequence[0][0] != 0
        animations[name + suffix] = sequence.map { |i, time| {ids[i], time} } if sequence.size > 1
      end
    end
    animations
  end

  private def self.exact(assets : Layers, atlas : Atlas, blocks : Array(Block), registry : JSON::Any) : Hash(String, Int32)
    sources = CubeModels::Sources.new(assets)
    opaque = Set(Int32).new
    registry["opaque"].as_a.each { |entry| opaque.concat(entry[0].as_i..entry[1].as_i) }
    stats = Hash(String, Int32).new(0)
    blocks.each do |block|
      eligible = [] of Tuple(Int32, Props)
      block.states { |state, props| eligible << {state, props} if opaque.includes?(state) && !atlas.blocks.has_key?(state) }
      next if eligible.empty?
      begin
        selectors = sources.selectors(block.name)
        images = eligible.flat_map { |_, props| sources.state_faces(selectors, props) }
      rescue ex : CubeModels::Unsupported
        stats[ex.message || "unsupported cube"] += 1
        next
      end
      if indices = atlas.add(images)
        eligible.each_with_index { |(state, _), i| atlas.put(state, indices[i * 6, 6]) }
        stats["mapped states"] += eligible.size
        stats["mapped block types"] += 1
      else
        stats["tile limit"] += 1
      end
    end
    stats
  end

  private def self.item_sprite(assets : Layers, name : String) : Image?
    model = assets.object("#{ASSETS}items/#{name}.json").try(&.["model"]?)
    reference = nil
    8.times do
      break unless model && model.as_h?
      case model["type"]?.try(&.as_s?).try(&.lchop("minecraft:"))
      when "model"
        reference = resource(model["model"]?)
        break
      when "select", "range_dispatch"
        model = model["fallback"]?
      when "condition"
        model = model["on_false"]?
      else
        break
      end
    end
    return unless reference && reference.starts_with?("item/")
    seen = Set(String).new
    layers = {} of String => JSON::Any
    until reference.in?("item/generated", "item/handheld", "item/handheld_rod")
      return if seen.size >= 16 || !seen.add?(reference)
      geometry = assets.object("#{ASSETS}models/#{reference}.json")
      return unless geometry && !geometry.has_key?("elements")
      if raw = geometry["textures"]?
        textures = raw.as_h? || return nil
        layers = textures.merge(layers)
      end
      reference = resource(geometry["parent"]?) || return nil
    end
    result = nil
    5.times do |i|
      value = layers["layer#{i}"]? || break
      tex = resource(value) || return nil
      tile = sprite(assets, tex) || return nil
      if current = result
        current.composite(tile)
      else
        result = tile
      end
    end
    result
  end

  private def self.items(assets : Layers, atlas : Atlas, blocks : Array(Block))
    prefix = "#{ASSETS}items/"
    names = assets.jar.entries.keys.compact_map do |path|
      if path.starts_with?(prefix) && path.ends_with?(".json")
        name = path.lchop(prefix).rchop(".json")
        name if NAME.matches?(name)
      end
    end.to_set
    cubes = {} of String => Faces
    icons = {} of String => Int32
    omitted = 0
    blocks.each do |block|
      next unless names.includes?(block.name)
      defaults = block.props.to_h do |key, vals|
        {key, key == "axis" ? "y" : vals.includes?("false") ? "false" : vals[0]}
      end
      state = block.start
      block.states { |sid, props| state = sid if props == defaults }
      if (terrain = atlas.blocks[state]?) && terrain.model.nil? && cubes.size < MAX_ITEMS
        cubes[block.name] = terrain.faces
      end
    end
    overlay = assets.overlay
    names.to_a.sort_by do |name|
      if i = PREFERRED.index(name)
        {0, i, name}
      elsif overlay.try(&.entries.has_key?(texture_path("item/" + name))) || GEAR.matches?(name) ||
            {"_planks", "_log", "_wood", "_stem"}.any? { |suffix| name.ends_with?(suffix) } || name.in?("cobblestone", "stone", "dirt", "crafting_table")
        {1, 0, name}
      elsif cubes.has_key?(name) && (Rules.legacy(name) || Rules.shapes(name)[1])
        {2, 0, name}
      else
        {cubes.has_key?(name) ? 4 : 3, 0, name}
      end
    end.each do |name|
      tile = item_sprite(assets, name)
      if !tile && overlay && overlay.entries.has_key?(texture_path("item/" + name)) &&
         !overlay.entries.has_key?("#{ASSETS}items/#{name}.json") && !overlay.entries.has_key?("#{ASSETS}models/item/#{name}.json")
        tile = sprite(assets, "item/" + name)
      end
      if !tile && (indices = cubes[name]?)
        tile = Rules.cube_icon(atlas.images[indices[2]], atlas.images[indices[4]], atlas.images[indices[0]])
      end
      next unless tile
      if icons.size < MAX_ITEMS && (slot = atlas.add([tile]))
        icons[name] = slot[0]
      else
        omitted += 1
      end
    end
    {icons, cubes, omitted}
  end

  def self.build(assets : Layers, output : String) : Nil
    registry = File.open(File.join(__DIR__, "states-26.3.json")) { |io| JSON.parse(io) }
    blocks = registry["blocks"].as_a.map do |row|
      Block.new(row[0].as_s, row[1].as_i, row[2].as_h.transform_values { |values| values.as_a.map(&.as_s) })
    end
    atlas = Atlas.new
    scene(assets, atlas, blocks)
    authored(assets, atlas, blocks)
    animations = fluids(assets, atlas, blocks)
    breaks = Rules::BREAK_STAGES.compact_map do |name|
      sprite(assets, "block/" + name) { |image| lo, hi = image.alpha_extrema; lo < 255 && hi > 0 }
    end
    break_indices = atlas.add(breaks) if breaks.size == 10
    stats = exact(assets, atlas, blocks, registry)
    icons, cubes, omitted = items(assets, atlas, blocks)
    raise Error.new("client JAR did not yield supported terrain textures") if atlas.blocks.empty?
    ranges = atlas.ranges
    columns = Math.max(Math.min(16, atlas.images.size), (atlas.images.size + MAX_ROWS - 1) // MAX_ROWS)
    rows = (atlas.images.size + columns - 1) // columns
    manifest = JSON.build do |json|
      json.object do
        json.field "protocol", PROTOCOL
        json.field "tileSize", TILE
        json.field "columns", columns
        json.field "rows", rows
        json.field "registry", {max: registry["max"].as_i, blocks: blocks.map { |block| {block.start, block.name} }}
        json.field "invisible", registry["invisible"]
        json.field "blocks", ranges
        unless atlas.meshes.variants.empty?
          json.field "models", {quads: atlas.meshes.quads, variants: atlas.meshes.variants}
        end
        json.field "animations", animations
        json.field "itemIcons", icons
        json.field "itemBlocks", cubes
        json.field "breakStages", break_indices if break_indices
      end
    end
    raise Error.new("atlas manifest exceeds viewer limits") if manifest.bytesize + 1 > 256 * 1024 || ranges.size > 8192
    sheet = Image.new(columns * TILE, rows * TILE)
    atlas.images.each_with_index { |image, i| sheet.paste(image, i % columns * TILE, i // columns * TILE) }
    png = File.join(output, "atlas.png")
    sheet.write_png(png)
    raise Error.new("atlas PNG exceeds viewer byte limit") if File.size(png) > 1024 * 1024
    File.write(File.join(output, "atlas.json"), manifest + '\n')
    puts "Terrain: #{atlas.blocks.size} mapped states in #{ranges.size} ranges; #{atlas.images.size} tiles."
    mapped_states = stats.delete("mapped states") || 0
    mapped_types = stats.delete("mapped block types") || 0
    gaps = stats.empty? ? "none" : stats.keys.sort!.map { |reason| "#{reason}: #{stats[reason]}" }.join(", ")
    puts "Exact cubes: #{mapped_states} states across #{mapped_types} block types; unmapped: #{gaps}."
    puts "Items: #{icons.size} icons, #{cubes.size} cube fallbacks; #{omitted} icons omitted at atlas capacity."
    if animations.size < 4
      puts "Liquid animations: #{animations.empty? ? "none" : animations.keys.join(", ")}; other liquids use a static frame when available."
    end
    puts "Break overlay unavailable: a complete set of 10 transparent sprites is required." unless break_indices
  end
end
