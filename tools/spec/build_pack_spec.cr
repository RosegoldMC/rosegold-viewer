require "spec"
require "../pack_builder"

module PackFixture
  include PackBuilder

  ALPHA   = {225_u8, 54_u8, 117_u8, 255_u8}
  BETA    = {66_u8, 204_u8, 90_u8, 255_u8}
  GAMMA   = {50_u8, 94_u8, 240_u8, 255_u8}
  WATER_A = {225_u8, 54_u8, 117_u8, 160_u8}
  WATER_B = {66_u8, 204_u8, 90_u8, 160_u8}
  WATER_C = {50_u8, 94_u8, 240_u8, 160_u8}

  class Fixture
    getter dir : String
    @sequence = 0

    def initialize
      @dir = File.tempname("native-pack-spec-", nil)
      Dir.mkdir(@dir, 0o700)
    end

    def path(name : String) : String
      File.join(@dir, name)
    end

    def png(image : Image) : Bytes
      name = path("art-#{@sequence += 1}.png")
      image.write_png(name)
      File.read(name).to_slice
    end

    def zip(name : String, files : Hash(String, Bytes)) : String
      filename = path(name)
      File.open(filename, "w") do |io|
        Compress::Zip::Writer.open(io) do |writer|
          files.each do |member, data|
            writer.add(member) { |destination| destination.write(data) }
          end
        end
      end
      filename
    end

    def art(files : Hash(String, Bytes), name : String, w : Int32, h : Int32, color : Color = ALPHA, pixel : Color? = nil)
      image = Image.new(w, h, color)
      image.set_pixel(0, 0, pixel) if pixel
      files[Terrain.texture_path(name)] = png(image)
    end

    def client : String
      files = {
        "version.json"                            => {id: "26.3", protocol_version: 777}.to_json.to_slice,
        ASSETS + "blockstates/stone.json"         => %({"variants":{}}).to_slice,
        ASSETS + "blockstates/iron_ore.json"      => %({"variants":{"":{"model":"block/fixture_cube","y":90}}}).to_slice,
        ASSETS + "models/block/fixture_cube.json" => %({"parent":"block/fixture_parent","textures":{"side":"block/diamond_block","accent":"block/fixture_face"}}).to_slice,
        ASSETS + "items/apple.json"               => %({"model":{"type":"minecraft:model","model":"item/apple"}}).to_slice,
        ASSETS + "models/item/apple.json"         => %({"parent":"item/generated","textures":{"layer0":"item/apple"}}).to_slice,
        ASSETS + "items/torch.json"               => %({"model":{"type":"minecraft:model","model":"item/torch"}}).to_slice,
        ASSETS + "models/item/torch.json"         => %({"parent":"item/generated","textures":{"layer0":"block/torch"}}).to_slice,
      }
      cube = %w(east west up down south north).to_h do |face|
        {face, {cullface: face, texture: face.in?("north", "up") ? "#top" : "#side"}}
      end
      parent = {elements: [{from: [0, 0, 0], to: [16, 16, 16], faces: cube}], textures: {top: "#accent"}}
      files[ASSETS + "models/block/fixture_parent.json"] = parent.to_json.to_slice
      files[ASSETS + "blockstates/stone_brick_wall.json"] = %({"multipart":[
        {"when":{"up":"true"},"apply":{"model":"block/fixture_post"}},
        {"when":{"AND":[{"up":"true"},{"OR":[{"north":"low"},{"east":"low"}]}]},
          "apply":[{"model":"block/fixture_panel","y":90,"uvlock":true},{"model":"block/unused"}]}]}).to_slice
      files[ASSETS + "models/block/fixture_post.json"] = %({"parent":"block/fixture_panel","textures":{"surface":"block/fixture_wall"}}).to_slice
      files[ASSETS + "models/block/fixture_panel.json"] = %({"textures":{"surface":"block/fixture_panel"},"elements":[
        {"from":[0,0,0],"to":[4,8,16],"faces":{"west":{"texture":"#surface","rotation":90},"up":{"texture":"#surface","uv":[2,4,6,8]}}}]}).to_slice
      files[ASSETS + "blockstates/spruce_slab.json"] = %({"variants":{
        "type=top":{"model":"block/fixture_slab","x":180},
        "type=bottom":{"model":"block/fixture_slab"},
        "type=double":{"model":"block/fixture_cube"}}}).to_slice
      files[ASSETS + "models/block/fixture_slab.json"] = %({"textures":{"surface":"block/fixture_slab"},"elements":[
        {"from":[0,0,0],"to":[16,6,16],"faces":{"up":{"texture":"#surface"}}}]}).to_slice
      art(files, "block/fixture_slab", 16, 16, BETA)
      art(files, "block/fixture_wall", 16, 16, BETA)
      art(files, "block/fixture_panel", 16, 16, GAMMA)
      art(files, "block/stone", 16, 16)
      art(files, "block/torch", 16, 16, {0_u8, 0_u8, 0_u8, 0_u8}, ALPHA)
      art(files, "block/stone_bricks", 16, 16, GAMMA)
      art(files, "block/diamond_block", 16, 16, GAMMA)
      art(files, "block/fixture_face", 16, 16, BETA, ALPHA)
      art(files, "item/apple", 16, 16, GAMMA)
      {"water", "lava"}.each do |kind|
        {"still", "flow"}.each do |type|
          name = "block/#{kind}_#{type}"
          art(files, name, 16, 32, kind == "water" ? WATER_A : BETA, kind == "water" ? WATER_B : GAMMA)
          files[Terrain.texture_path(name) + ".mcmeta"] = %({"animation":{"frames":[1,{"index":0,"time":3}]}}).to_slice
        end
      end
      10.times { |i| art(files, "block/destroy_stage_#{i}", 16, 16, {0_u8, 0_u8, 0_u8, 0_u8}, BETA) }
      GuiEntities::HUD.each { |_, source, (w, h)| art(files, "gui/sprites/hud/" + source, w, h) }
      (GuiEntities::MENUS + ["generic_54"]).each do |name|
        art(files, "gui/container/" + name, name == "villager" ? 512 : 256, 256, ALPHA, GAMMA)
      end
      art(files, "gui/sprites/container/anvil/text_field_disabled", 110, 16, BETA)
      GuiEntities::ENTITIES.each { |_, source, (w, h)| art(files, "entity/" + source, w, h) }
      art(files, "entity/villager/villager", 64, 64)
      art(files, "entity/villager/type/plains", 64, 64, {0_u8, 0_u8, 0_u8, 0_u8}, BETA)
      zip("client.jar", files)
    end

    def layered : String
      files = {} of String => Bytes
      art(files, "block/stone", 32, 32, BETA)
      files[ASSETS + "models/block/fixture_post.json"] = %({"parent":"block/fixture_panel","textures":{"surface":"block/overlay_surface"},"elements":[
        {"from":[0,0,0],"to":[4,12,16],"faces":{"west":{"texture":"#surface","rotation":90}}}]}).to_slice
      art(files, "block/overlay_surface", 16, 16, ALPHA)
      art(files, "entity/cow/cow_temperate", 24, 24, BETA)
      files[Terrain.texture_path("block/fixture_face") + ".mcmeta"] = %({"animation":{}}).to_slice
      files[Terrain.texture_path("item/apple") + ".mcmeta"] = %({"animation":{}}).to_slice
      still = Image.new(32, 32, WATER_A)
      still.paste(Image.new(16, 16, WATER_B), 16, 16)
      files[Terrain.texture_path("block/water_still")] = png(still)
      flow = Image.new(64, 64, WATER_C)
      flow.paste(Image.new(32, 32, WATER_A))
      flow.paste(Image.new(16, 16, WATER_B), 16, 16)
      files[Terrain.texture_path("block/water_flow")] = png(flow)
      zip("overlay.zip", files)
    end

    def over_budget : String
      files = {
        ASSETS + "models/block/fixture_slab.json" => %({"textures":{"surface":"block/unavailable"},"elements":[
          {"from":[0,0,0],"to":[16,7,16],"faces":{"up":{"texture":"#surface"}}}]}).to_slice,
      }
      fields = %w(east north south up waterlogged west)
      sides = %w(none low tall)
      flags = %w(true false)
      variants = {} of String => NamedTuple(model: String)
      combinations = [sides, sides, sides, flags, flags, sides]
      combinations[0].cartesian_product(combinations[1], combinations[2], combinations[3], combinations[4], combinations[5]).each_with_index do |values, i|
        name = "block/fixture_wall_#{i}"
        key = fields.zip(values.to_a).map { |field, value| "#{field}=#{value}" }.join(',')
        variants[key] = {model: name}
        elements = [{from: [0.0, 0.0, i / 100.0], to: [1.0, 1.0, i / 100.0 + 1], faces: {up: {texture: "block/fixture_wall"}}}]
        files[ASSETS + "models/#{name}.json"] = {elements: elements}.to_json.to_slice
      end
      files[ASSETS + "blockstates/stone_brick_wall.json"] = {variants: variants}.to_json.to_slice
      zip("over-budget.zip", files)
    end

    def image(name : String) : Image
      PackBuilder.png(File.read(path(name)).to_slice).not_nil!
    end

    def manifest(name : String) : JSON::Any
      JSON.parse(File.read(path("pack/#{name}.json")))
    end

    def state(atlas : JSON::Any, name : String, offset : Int32 = 0) : JSON::Any
      id = atlas["registry"]["blocks"].as_a.find! { |row| row[1].as_s == name }[0].as_i + offset
      atlas["blocks"].as_a.find! { |row| row["min"].as_i <= id <= row["max"].as_i }
    end

    def sample(atlas : JSON::Any, sheet : Image, tile : JSON::Any, x : Int32, y : Int32)
      n, columns = tile.as_i, atlas["columns"].as_i
      sheet.pixel(n % columns * 16 + x, n // columns * 16 + y)
    end

    def close
      FileUtils.rm_r(@dir)
    end
  end

  def self.with(&)
    fixture = Fixture.new
    begin
      yield fixture
    ensure
      fixture.close
    end
  end
end

describe PackBuilder do
  it "generates the viewer contract with exact cube orientation, animation, crops, and composited entity textures" do
    PackFixture.with do |f|
      PackBuilder.build(f.client, f.path("pack"))
      atlas = f.manifest("atlas")
      atlas["protocol"].as_i.should eq 777
      atlas["tileSize"].as_i.should eq 16
      atlas["registry"]["max"].as_i.should eq 35722
      f.state(atlas, "water", 15)["variant"].as_i.should eq 15
      atlas["animations"]["waterFlow"].as_a.map { |entry| entry[1].as_i }.should eq [1, 3]
      atlas["breakStages"].as_a.size.should eq 10
      sheet = f.image("pack/atlas.png")
      {sheet.width, sheet.height}.should eq({atlas["columns"].as_i * 16, atlas["rows"].as_i * 16})
      torch = f.state(atlas, "torch")
      torch["model"].as_s.should eq "torch"
      torch["faces"].as_a.uniq.should eq [atlas["itemIcons"]["torch"]]
      f.sample(atlas, sheet, torch["faces"][0], 0, 0).should eq PackFixture::ALPHA
      f.sample(atlas, sheet, torch["faces"][0], 1, 1).should eq({0_u8, 0_u8, 0_u8, 0_u8})
      ore = f.state(atlas, "iron_ore")["faces"]
      f.sample(atlas, sheet, ore[0], 1, 1).should eq PackFixture::BETA
      f.sample(atlas, sheet, ore[0], 0, 0).should eq PackFixture::ALPHA
      f.sample(atlas, sheet, ore[1], 1, 1).should eq PackFixture::GAMMA
      f.sample(atlas, sheet, atlas["itemIcons"]["apple"], 1, 1).should eq PackFixture::GAMMA
      chest = f.image("pack/gui/chest_6.png")
      {chest.width, chest.height}.should eq({176, 222})
      chest.pixel(0, 0).should eq PackFixture::GAMMA
      chest.pixel(1, 200).should eq PackFixture::ALPHA
      f.image("pack/gui/anvil.png").pixel(59, 20).should eq PackFixture::BETA
      Dir.children(f.path("pack/gui")).size.should eq 25
      entities = f.manifest("entities")
      entities["textures"].as_h.size.should eq 25
      person = entities["textures"]["villager"]
      x, y = person[0].as_i, person[1].as_i
      f.image("pack/entities.png").pixel(x, y).should eq PackFixture::BETA
      f.image("pack/entities.png").pixel(x + 1, y).should eq PackFixture::ALPHA
      expect_raises(PackBuilder::Error, "output already exists") do
        PackBuilder.build(f.path("client.jar"), f.path("pack"))
      end
      f.manifest("atlas").should eq atlas
    end
  end

  it "bakes multipart models and inherited face bindings from local archives" do
    PackFixture.with do |f|
      jar = f.client
      PackBuilder.build(jar, f.path("pack"), f.layered)
      atlas = f.manifest("atlas")
      sheet = f.image("pack/atlas.png")
      wall = f.state(atlas, "stone_brick_wall", 36)
      wall["model"].as_s.should eq "mesh"
      model = atlas["models"]
      variant = model["variants"][wall["variant"].as_i]
      variant[0].as_bool.should be_false
      quads = variant[1].as_a.map { |index| model["quads"][index.as_i] }
      quads.size.should eq 3
      post, panel, cap = quads
      post[0].as_a.map(&.as_f).should eq [0, 0.75, 0, 0, 0, 0, 0, 0, 1, 0, 0.75, 1]
      post[1].as_a.map(&.as_f).should eq [0, 1, 1, 1, 1, 0.25, 0, 0.25]
      post[3].as_i.should eq 1
      panel[3].as_i.should eq 5
      panel[0].as_a.map(&.as_f).should eq [1, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 0.5, 0]
      cap[1].as_a.map(&.as_f).should eq [0.75, 0.125, 0.5, 0.125, 0.5, 0.375, 0.75, 0.375]
      f.sample(atlas, sheet, wall["faces"][post[2].as_i], 1, 1).should eq PackFixture::ALPHA
      f.sample(atlas, sheet, wall["faces"][panel[2].as_i], 1, 1).should eq PackFixture::GAMMA
      equivalent = f.state(atlas, "stone_brick_wall", 39)
      equivalent["variant"].should eq wall["variant"]
      absent = f.state(atlas, "stone_brick_wall", 6)
      model["variants"][absent["variant"].as_i][1].as_a.should be_empty
    end
  end

  it "keeps complete vanilla models when the overlay reaches the mesh budget or a face texture is missing" do
    PackFixture.with do |f|
      PackBuilder.build(f.client, f.path("pack"), f.over_budget)
      atlas = f.manifest("atlas")
      sheet = f.image("pack/atlas.png")
      table = atlas["models"]
      variants = table["variants"].as_a
      variants.size.should be <= PackBuilder::SceneModels::MAX_VARIANTS
      324.times { |offset| f.state(atlas, "stone_brick_wall", offset)["model"].as_s.should eq "mesh" }
      early_wall = f.state(atlas, "stone_brick_wall", 0)
      late_wall = f.state(atlas, "stone_brick_wall", 312)
      early_wall["variant"].as_i.should be > late_wall["variant"].as_i
      late_wall["model"].as_s.should eq "mesh"
      late_quad = table["quads"][variants[late_wall["variant"].as_i][1][0].as_i]
      late_quad[0].as_a.map(&.as_f).max.should eq 1.0
      late_quad[3].as_i.should eq 1
      f.sample(atlas, sheet, late_wall["faces"][late_quad[2].as_i], 1, 1).should eq PackFixture::BETA
      slab = f.state(atlas, "spruce_slab", 2)
      slab["model"].as_s.should eq "mesh"
      slab_quad = table["quads"][variants[slab["variant"].as_i][1][0].as_i]
      slab_quad[0].as_a[1].as_f.should eq 0.375
      f.sample(atlas, sheet, slab["faces"][slab_quad[2].as_i], 1, 1).should eq PackFixture::BETA
      f.state(atlas, "spruce_slab", 4)["model"]?.should be_nil
    end
  end

  it "scales a higher-resolution still and a flow quadrant while using vanilla for incompatible entity overrides" do
    PackFixture.with do |f|
      PackBuilder.build(f.client, f.path("pack"), f.layered)
      atlas = f.manifest("atlas")
      sheet = f.image("pack/atlas.png")
      f.sample(atlas, sheet, f.state(atlas, "stone")["faces"][0], 0, 0).should eq PackFixture::BETA
      f.sample(atlas, sheet, f.state(atlas, "iron_ore")["faces"][0], 1, 1).should eq PackFixture::BETA
      f.sample(atlas, sheet, atlas["itemIcons"]["apple"], 1, 1).should eq PackFixture::GAMMA
      water = f.state(atlas, "water")["faces"]
      f.sample(atlas, sheet, water[2], 3, 3).should eq PackFixture::WATER_A
      f.sample(atlas, sheet, water[2], 14, 14).should eq PackFixture::WATER_B
      f.sample(atlas, sheet, water[0], 3, 3).should eq PackFixture::WATER_A
      f.sample(atlas, sheet, water[0], 14, 14).should eq PackFixture::WATER_B
      cow = f.manifest("entities")["textures"]["cow"]
      f.image("pack/entities.png").pixel(cow[0].as_i, cow[1].as_i).should eq PackFixture::ALPHA
    end
  end

  it "cleans up its own links after cancellation without deleting an unrelated output file" do
    PackFixture.with do |f|
      Dir.mkdir(f.path("stage"))
      Dir.mkdir(f.path("stage/gui"))
      File.write(f.path("stage/atlas.json"), "generated")
      File.write(f.path("stage/atlas.png"), "generated")
      expect_raises(PackBuilder::Interrupted) do
        PackBuilder.publish(f.path("stage"), f.path("pack")) do
          if File.exists?(f.path("pack/atlas.json"))
            File.write(f.path("pack/keep.txt"), "not generated")
            raise PackBuilder::Interrupted.new
          end
        end
      end
      Dir.children(f.path("pack")).should eq ["keep.txt"]
      File.read(f.path("pack/keep.txt")).should eq "not generated"
      File.read(f.path("stage/atlas.json")).should eq "generated"
    end
  end
end
