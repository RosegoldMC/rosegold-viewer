require "set"
require "./pack_assets"

module PackBuilder::TerrainRules
  alias Props = Hash(String, String)
  alias Rule = Proc(Props, Array(String))
  alias ShapeRule = Proc(Props, Tuple(Array(String), Int32?))
  alias Color = Tuple(UInt8, UInt8, UInt8, UInt8)

  TILE         = 16
  BREAK_STAGES = (0...10).map { |i| "destroy_stage_#{i}" }
  COLORS       = %w(white orange magenta light_blue yellow lime pink gray light_gray cyan purple blue brown green red black)
  TREES        = %w(oak spruce birch jungle acacia dark_oak mangrove cherry pale_oak)
  WOODS        = TREES + %w(bamboo crimson warped)
  TREE_LEAVES  = TREES.map { |wood| "#{wood}_leaves" }.to_set
  LEAVES       = TREE_LEAVES | Set{"azalea_leaves", "flowering_azalea_leaves"}
  CROSS        = TREES.reject("mangrove").map { |wood| "#{wood}_sapling" }.to_set | Set.new(%w(
    short_grass fern short_dry_grass tall_dry_grass dandelion poppy blue_orchid allium azure_bluet
    red_tulip orange_tulip white_tulip pink_tulip oxeye_daisy cornflower lily_of_the_valley
    wither_rose torchflower closed_eyeblossom
  ))
  ORES               = %w(coal copper iron gold redstone lapis emerald diamond)
  DIRECTIONS         = %w(east west up down south north)
  GLASS              = Set{"glass"} | COLORS.map { |color| "#{color}_stained_glass" }.to_set
  RAILS              = %w(north_south east_west ascending_east ascending_west ascending_north ascending_south south_east south_west north_west north_east)
  STAIR_FACINGS      = %w(north south west east)
  STAIR_SHAPES       = %w(straight inner_left inner_right outer_left outer_right)
  COMPOSTER_SIDE     = "composter/composter_side"
  COMPOSTER_TOP      = "composter/composter_top"
  COMPOSTER_BOTTOM   = "composter/composter_bottom"
  COMPOSTER_CONTENTS = [COMPOSTER_SIDE] + (1..7).map { |i| "composter/composter_compost#{i}" } + ["composter/composter_ready"]
  WAXED              = Set.new(%w(copper_block exposed_copper weathered_copper oxidized_copper cut_copper exposed_cut_copper weathered_cut_copper oxidized_cut_copper))
  UNIFORM            = Set.new(%w(
    bedrock dirt coarse_dirt rooted_dirt mud packed_mud mud_bricks clay
    stone granite diorite andesite polished_granite polished_diorite polished_andesite
    cobblestone mossy_cobblestone smooth_stone stone_bricks mossy_stone_bricks
    cracked_stone_bricks chiseled_stone_bricks cobbled_deepslate polished_deepslate
    deepslate_bricks cracked_deepslate_bricks deepslate_tiles cracked_deepslate_tiles
    chiseled_deepslate tuff polished_tuff tuff_bricks calcite dripstone_block gravel
    sand red_sand bricks terracotta glass obsidian crying_obsidian glowstone
    packed_ice blue_ice moss_block pale_moss_block
    nether_bricks red_nether_bricks netherrack soul_sand soul_soil end_stone end_stone_bricks
    smooth_basalt polished_blackstone polished_blackstone_bricks
    nether_gold_ore nether_quartz_ore amethyst_block budding_amethyst
    coal_block copper_block iron_block gold_block redstone_block lapis_block
    emerald_block diamond_block netherite_block raw_copper_block raw_iron_block
    raw_gold_block oxidized_copper exposed_copper weathered_copper cut_copper
    exposed_cut_copper weathered_cut_copper oxidized_cut_copper
    honeycomb_block sponge wet_sponge bamboo_mosaic
  )) | ORES.flat_map { |ore| ["#{ore}_ore", "deepslate_#{ore}_ore"] }.to_set |
                       COLORS.flat_map { |color| %w(wool concrete concrete_powder terracotta stained_glass).map { |kind| "#{color}_#{kind}" } }.to_set
  PLANKS = WOODS.flat_map { |wood| %w(planks stairs slab).map { |kind| {"#{wood}_#{kind}", "#{wood}_planks"} } }.to_h

  def self.faces(side : T, top : T = side, bottom : T = top) : Array(T) forall T
    [side, side, top, bottom, side, side]
  end

  private def self.fixed(side : String, top : String = side, bottom : String = top) : Rule
    ->(_props : Props) { faces(side, top, bottom) }
  end

  private def self.directed(side, top, bottom, direction, front)
    result = faces(side, top, bottom)
    result[DIRECTIONS.index!(direction)] = front
    result
  end

  private def self.axial(side, end_texture, axis)
    result = Array.new(6, side)
    index = %w(x y z).index!(axis) * 2
    result[index] = result[index + 1] = end_texture
    result
  end

  def self.legacy(name : String) : Rule?
    if planks = PLANKS[name]?
      return fixed(planks)
    end
    return fixed(name) if UNIFORM.includes?(name)
    if name.starts_with?("waxed_") && WAXED.includes?(name[6..])
      return fixed(name[6..])
    end
    base = name.lchop("smooth_")
    if base.in?("sandstone", "red_sandstone")
      return name == base ? fixed(base, base + "_top", base + "_bottom") : fixed(base + "_top")
    end
    WOODS.each do |wood|
      suffix = wood.in?("crimson", "warped") ? "stem" : wood == "bamboo" ? "block" : "log"
      {"", "stripped_"}.each do |prefix|
        stem = "#{prefix}#{wood}_#{suffix}"
        return ->(p : Props) { axial(name, name + "_top", p["axis"]) } if name == stem
        wood_suffix = wood.in?("crimson", "warped") ? "hyphae" : "wood"
        return fixed(stem) if name == "#{prefix}#{wood}_#{wood_suffix}"
      end
    end
    if TREE_LEAVES.includes?(name)
      return fixed(name.in?("cherry_leaves", "pale_oak_leaves") ? name : "@" + name)
    end
    case name
    when "deepslate", "infested_deepslate", "basalt", "polished_basalt", "hay_block", "bone_block", "ochre_froglight", "verdant_froglight", "pearlescent_froglight"
      texture = name.lchop("infested_")
      side = texture == "deepslate" ? texture : texture + "_side"
      ->(p : Props) { axial(side, texture + "_top", p["axis"]) }
    when "snow_block"
      fixed("snow")
    when "grass_block"
      ->(p : Props) { faces(p["snowy"] == "true" ? "grass_block_snow" : "@grass_block_side", "@grass_block_top", "dirt") }
    when "podzol", "mycelium"
      ->(p : Props) { faces(p["snowy"] == "true" ? "grass_block_snow" : name + "_side", name + "_top", "dirt") }
    when "farmland"
      ->(p : Props) { faces("dirt", p["moisture"] == "7" ? "farmland_moist" : "farmland", "dirt") }
    when "dirt_path"
      fixed("dirt_path_side", "dirt_path_top", "dirt")
    when "cactus", "reinforced_deepslate"
      fixed(name + "_side", name + "_top", name + "_bottom")
    when "melon", "pumpkin", "ancient_debris"
      fixed(name + "_side", name + "_top")
    when "blackstone"
      fixed(name, name + "_top")
    when "carved_pumpkin", "jack_o_lantern"
      ->(p : Props) { directed("pumpkin_side", "pumpkin_top", "pumpkin_top", p["facing"], name) }
    when "crafting_table"
      ->(_props : Props) { %w(crafting_table_side crafting_table_front crafting_table_top oak_planks crafting_table_side crafting_table_front) }
    when "furnace", "blast_furnace", "smoker"
      ->(p : Props) do
        directed(name + "_side", name + "_top", name + (name == "smoker" ? "_bottom" : "_top"), p["facing"],
          name + (p["lit"] == "true" ? "_front_on" : "_front"))
      end
    when "barrel"
      ->(p : Props) do
        f = p["facing"]
        result = directed("barrel_side", "barrel_side", "barrel_side", f, p["open"] == "true" ? "barrel_top_open" : "barrel_top")
        result[DIRECTIONS.index!(f) ^ 1] = "barrel_bottom"
        result
      end
    when "redstone_lamp"
      ->(p : Props) { faces(p["lit"] == "true" ? "redstone_lamp_on" : "redstone_lamp") }
    when "sea_lantern"
      fixed(name)
    end
  end

  def self.plant(name : String) : Tuple(String?, Rule?)
    if LEAVES.includes?(name)
      {"leaves", fixed(name)}
    elsif CROSS.includes?(name)
      {"cross", fixed(name.in?("short_grass", "fern") ? "@" + name : name)}
    elsif name == "tall_grass"
      {"cross", ->(p : Props) { faces("@tall_grass_" + (p["half"] == "upper" ? "top" : "bottom")) }}
    elsif name == "wheat"
      {"crop", ->(p : Props) { faces("wheat_stage#{p["age"]}") }}
    else
      {nil, nil}
    end
  end

  private def self.shape(texture, &variant : Props -> Int32?) : ShapeRule
    ->(p : Props) { {faces(texture), variant.call(p)} }
  end

  def self.shapes(name : String) : Tuple(String?, ShapeRule?)
    return {"glass", shape(name) { nil }} if GLASS.includes?(name)
    case name
    when "shroomlight"
      {nil, shape(name) { nil }}
    when "spruce_fence", "oak_fence"
      {"fence", shape("fence/" + name) do |p|
        %w(north east south west).each_with_index.sum { |direction, bit| p[direction] == "true" ? 1 << bit : 0 }
      end}
    when "composter"
      rule : ShapeRule = ->(p : Props) do
        level = p["level"].to_i
        {[COMPOSTER_SIDE, COMPOSTER_CONTENTS[level], COMPOSTER_TOP, COMPOSTER_BOTTOM, COMPOSTER_SIDE, COMPOSTER_SIDE], level.as(Int32?)}
      end
      {"composter", rule}
    when "lantern"
      {"lantern", shape(name) { |p| p["hanging"] == "true" ? 1 : 0 }}
    when "torch"
      {"torch", shape(name) { nil }}
    when "rail"
      rail_rule : ShapeRule = ->(p : Props) do
        variant = RAILS.index!(p["shape"])
        {faces(variant >= 6 ? "rail_corner" : name), variant.as(Int32?)}
      end
      {"rail", rail_rule}
    when "stone_brick_stairs"
      {"stairs", shape("stone_bricks") do |p|
        STAIR_FACINGS.index!(p["facing"]) + 4 * (p["half"] == "top" ? 1 : 0) + 8 * STAIR_SHAPES.index!(p["shape"])
      end}
    else
      {nil, nil}
    end
  end

  def self.multiply(tile : Image, color : Color) : Image
    result = Image.new(tile.width, tile.height)
    tile.height.times do |y|
      tile.width.times do |x|
        r, g, b, a = tile.pixel(x, y)
        a_r, a_g, a_b, a_a = color
        result.set_pixel(x, y, {((r.to_i * a_r) // 255).to_u8, ((g.to_i * a_g) // 255).to_u8,
                                ((b.to_i * a_b) // 255).to_u8, ((a.to_i * a_a) // 255).to_u8})
      end
    end
    result
  end

  def self.cube_icon(top : Image, left : Image, right : Image) : Image
    icon = Image.new(TILE, TILE)
    TILE.times do |y|
      TILE.times do |x|
        px, py = x + 0.5, y + 0.5
        dx = (px - 8) / 7.5
        edge = 4 * dx.abs
        next if dx.abs > 1 || py < edge || py >= 16 - edge
        if py < 8 - edge
          u, v = (dx + py / 4) / 2, (py / 4 - dx) / 2
          source, shade = top, 1.0
        elsif px < 8
          u = (px - 0.5) / 7.5
          v = (py - 4 - 4 * u) / 8
          source, shade = left, 0.8
        else
          u = (px - 8) / 7.5
          v = (py - 8 + 4 * u) / 8
          source, shade = right, 0.6
        end
        r, g, b, a = source.pixel((u * TILE).to_i.clamp(0, 15), (v * TILE).to_i.clamp(0, 15))
        icon.set_pixel(x, y, {(r * shade).round.to_u8, (g * shade).round.to_u8, (b * shade).round.to_u8, a})
      end
    end
    icon
  end
end
