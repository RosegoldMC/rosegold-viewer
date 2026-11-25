require "json"
require "./pack_assets"

module PackBuilder
  module GuiEntities
    TEXTURES = ASSETS + "textures/"
    MENUS    = %w(inventory crafting_table furnace blast_furnace smoker hopper brewing_stand anvil enchanting_table villager)

    alias Size = Tuple(Int32, Int32)

    HUD = begin
      hud = [
        {"crosshair", "crosshair", {15, 15}},
        {"hotbar", "hotbar", {182, 22}},
        {"hotbar_selection", "hotbar_selection", {24, 23}},
      ] of Tuple(String, String, Size)
      %w(container full half).each { |name| hud << {"heart_#{name}", "heart/#{name}", {9, 9}} }
      %w(empty full half).each { |name| hud << {"food_#{name}", "food_#{name}", {9, 9}} }
      hud
    end

    ENTITIES = begin
      entities = [
        {"cow", "cow/cow_temperate", {64, 64}},
        {"pig", "pig/pig_temperate", {64, 64}},
        {"chicken", "chicken/chicken_temperate", {64, 32}},
        {"sheep", "sheep/sheep", {64, 32}},
        {"sheep_wool", "sheep/sheep_wool", {64, 32}},
        {"sheep_undercoat", "sheep/sheep_wool_undercoat", {64, 32}},
      ] of Tuple(String, String, Size)
      %w(wide slim).each do |model|
        %w(steve alex ari efe kai makena noor sunny zuri).each do |name|
          entities << {"#{model}_#{name}", "player/#{model}/#{name}", {64, 64}}
        end
      end
      entities
    end

    ATLAS_BYTE_LIMIT = 512 * 1024
    ATLAS_WIDTH      = 128

    def self.art(assets : Layers, name : String, size : Size) : Image
      path = TEXTURES + name + ".png"
      found = assets.image(path, true) { |image| image.width == size[0] && image.height == size[1] }
      found || raise Error.new("missing or invalid required texture: #{path}")
    end

    def self.gui(assets : Layers, output : String) : Nil
      Dir.mkdir(output)
      HUD.each do |name, source, size|
        art(assets, "gui/sprites/hud/" + source, size).write_png(File.join(output, "#{name}.png"))
      end
      MENUS.each do |name|
        villager = name == "villager"
        source = villager ? {512, 256} : {256, 256}
        width = villager ? 276 : 176
        height = name == "hopper" ? 133 : 166
        image = art(assets, "gui/container/" + name, source).crop(0, 0, width, height)
        if name == "anvil"
          field = art(assets, "gui/sprites/container/anvil/text_field_disabled", {110, 16})
          image.composite(field, 59, 20)
        end
        image.write_png(File.join(output, "#{name}.png"))
      end
      chest = art(assets, "gui/container/generic_54", {256, 256})
      (1..6).each do |rows|
        top = 17 + 18 * rows
        image = Image.new(176, top + 97)
        image.paste(chest.crop(0, 0, 176, top), 0, 0)
        image.paste(chest.crop(0, 126, 176, 96), 0, top)
        image.write_png(File.join(output, "chest_#{rows}.png"))
      end
      puts "GUI: #{HUD.size + MENUS.size + 6} sprites and menus."
    end

    def self.entities(assets : Layers, output : String) : Nil
      images = {} of String => Image
      ENTITIES.each { |name, source, size| images[name] = art(assets, "entity/" + source, size) }
      villager = art(assets, "entity/villager/villager", {64, 64}).crop(0, 0, 64, 64)
      villager.composite(art(assets, "entity/villager/type/plains", {64, 64}))
      images["villager"] = villager

      x = y = row = 0
      rects = {} of String => Array(Int32)
      images.each do |name, image|
        if x + image.width > ATLAS_WIDTH
          y += row
          x = 0
          row = 0
        end
        rects[name] = [x, y, image.width, image.height]
        x += image.width
        row = Math.max(row, image.height)
      end
      height = y + row
      sheet = Image.new(ATLAS_WIDTH, height)
      rects.each { |name, rect| sheet.paste(images[name], rect[0], rect[1]) }
      png = File.join(output, "entities.png")
      sheet.write_png(png)
      raise Error.new("entity atlas PNG exceeds viewer byte limit") if File.size(png) > ATLAS_BYTE_LIMIT
      manifest = JSON.build do |json|
        json.object do
          json.field "width", ATLAS_WIDTH
          json.field "height", height
          json.field "textures" do
            json.object do
              rects.each { |name, rect| json.field name, rect }
            end
          end
        end
      end
      File.write(File.join(output, "entities.json"), manifest + "\n")
      puts "Entities: #{rects.size} textures."
    end
  end
end
