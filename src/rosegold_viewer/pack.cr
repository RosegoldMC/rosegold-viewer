require "json"

module RosegoldViewer
  # Operator-supplied, already-built texture pack. The directory is read once, into memory, from a fixed
  # list of file names; request paths never reach the filesystem. Nothing is bundled, fetched, or converted.
  class Pack
    GUI_NAMES = %w(crosshair heart_container heart_full heart_half food_empty food_full food_half hotbar hotbar_selection
      inventory crafting_table furnace blast_furnace smoker chest_1 chest_2 chest_3 chest_4 chest_5 chest_6 hopper
      brewing_stand anvil enchanting_table villager)

    private MAX_PNG_BYTES   = 16 * 1024 * 1024
    private MAX_GUI_BYTES   = 1 * 1024 * 1024
    private MAX_JSON_BYTES  = 4 * 1024 * 1024
    private MAX_TOTAL_BYTES = 40 * 1024 * 1024
    private PNG_SIGNATURE   = Bytes[137, 80, 78, 71, 13, 10, 26, 10]

    record Asset, bytes : Bytes, content_type : String

    private record Entry, file : String, limit : Int32, json : Bool

    private ENTRIES = begin
      entries = {
        "atlas.png"     => Entry.new("atlas.png", MAX_PNG_BYTES, false),
        "atlas.json"    => Entry.new("atlas.json", MAX_JSON_BYTES, true),
        "entities.png"  => Entry.new("entities.png", MAX_PNG_BYTES, false),
        "entities.json" => Entry.new("entities.json", MAX_JSON_BYTES, true),
      }
      GUI_NAMES.each { |name| entries["gui/#{name}.png"] = Entry.new("gui/#{name}.png", MAX_GUI_BYTES, false) }
      entries
    end

    getter protocol : Float64?

    @assets = {} of String => Asset

    # Raises ArgumentError if *directory* is not a directory. Missing, oversized, symlinked,
    # or malformed files are skipped, so their requests answer not found.
    def initialize(directory : String)
      raise ArgumentError.new("Pack directory does not exist") unless Dir.exists?(directory)
      root = File.realpath(directory)
      total = 0
      ENTRIES.each do |key, entry|
        bytes = read(root, entry)
        next unless bytes && total + bytes.size <= MAX_TOTAL_BYTES
        total += bytes.size
        @assets[key] = Asset.new(bytes, entry.json ? "application/json" : "image/png")
      end
      if atlas = @assets["atlas.json"]?
        value = JSON.parse(String.new(atlas.bytes)).as_h?.try(&.["protocol"]?)
        @protocol = value.try(&.as_i64?).try(&.to_f64) || value.try(&.as_f?)
      end
    end

    # *name* is the path below the pack root, such as "atlas.png" or "gui/hotbar.png".
    def []?(name : String) : Asset?
      @assets[name]?
    end

    def empty? : Bool
      @assets.empty?
    end

    private def read(root : String, entry : Entry) : Bytes?
      path = File.join(root, entry.file)
      info = File.info?(path, follow_symlinks: false)
      return unless info && info.file? && info.size <= entry.limit
      return unless File.realpath(path) == path
      bytes = File.open(path) do |file|
        buffer = Bytes.new(entry.limit + 1)
        size = 0
        while size < buffer.size
          count = file.read(buffer[size..])
          break if count.zero?
          size += count
        end
        buffer[0, size]
      end
      return if bytes.size > entry.limit
      valid = entry.json ? json?(bytes) : bytes.size > 8 && bytes[0, 8] == PNG_SIGNATURE
      bytes if valid
    rescue File::Error | IO::Error
      nil
    end

    private def json?(bytes : Bytes) : Bool
      JSON.parse(String.new(bytes))
      true
    rescue JSON::ParseException
      false
    end
  end
end
