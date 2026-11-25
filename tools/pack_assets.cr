require "compress/zip"
require "json"

@[Link("png", pkg_config: "libpng")]
lib LibPNG
  struct Image
    opaque : Void*
    version : UInt32
    width : UInt32
    height : UInt32
    format : UInt32
    flags : UInt32
    colormap_entries : UInt32
    warning_or_error : UInt32
    message : UInt8[64]
  end

  fun png_image_begin_read_from_memory(image : Image*, memory : Void*, size : LibC::SizeT) : Int32
  fun png_image_finish_read(image : Image*, background : Void*, buffer : Void*, row_stride : Int32, colormap : Void*) : Int32
  fun png_image_write_to_file(image : Image*, file : UInt8*, convert_to_8bit : Int32, buffer : Void*, row_stride : Int32, colormap : Void*) : Int32
  fun png_image_free(image : Image*)
end

module PackBuilder
  VERSION         = "26.3"
  PROTOCOL        = 777
  RESOURCE_FORMAT = {97_i64, 1_i64}
  ASSETS          = "assets/minecraft/"

  alias Color = Tuple(UInt8, UInt8, UInt8, UInt8)

  PNG_HEADER      = Bytes[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  TRANSPARENT     = {0_u8, 0_u8, 0_u8, 0_u8}
  MAX_IMAGE_SIDE  = 16384
  MAX_IMAGE_AREA  = 64 * 1024 * 1024
  PNG_FORMAT_RGBA = 3_u32

  class Error < Exception
  end

  class Image
    getter width : Int32
    getter height : Int32
    getter pixels : Bytes

    def initialize(@width : Int32, @height : Int32, fill : Color = TRANSPARENT)
      if @width <= 0 || @height <= 0 || @width > MAX_IMAGE_SIDE || @height > MAX_IMAGE_SIDE ||
         @width.to_i64 * @height > MAX_IMAGE_AREA
        raise Error.new("unsupported image size #{@width}x#{@height}")
      end
      @pixels = Bytes.new(@width * @height * 4)
      unless fill == TRANSPARENT
        (@width * @height).times do |i|
          @pixels[i * 4] = fill[0]
          @pixels[i * 4 + 1] = fill[1]
          @pixels[i * 4 + 2] = fill[2]
          @pixels[i * 4 + 3] = fill[3]
        end
      end
    end

    protected def initialize(@width : Int32, @height : Int32, @pixels : Bytes)
    end

    def pixel(x : Int32, y : Int32) : Color
      i = index(x, y)
      {@pixels[i], @pixels[i + 1], @pixels[i + 2], @pixels[i + 3]}
    end

    def set_pixel(x : Int32, y : Int32, color : Color) : Nil
      i = index(x, y)
      @pixels[i] = color[0]
      @pixels[i + 1] = color[1]
      @pixels[i + 2] = color[2]
      @pixels[i + 3] = color[3]
    end

    # Out-of-bounds areas are transparent.
    def crop(x : Int32, y : Int32, width : Int32, height : Int32) : Image
      result = Image.new(width, height)
      result.paste(self, -x, -y)
      result
    end

    # Nearest-neighbour, sampling at pixel centres.
    def resize(width : Int32, height : Int32) : Image
      result = Image.new(width, height)
      height.times do |y|
        sy = ((y * 2 + 1).to_i64 * @height // (height * 2)).to_i
        width.times do |x|
          sx = ((x * 2 + 1).to_i64 * @width // (width * 2)).to_i
          from = (sy * @width + sx) * 4
          (result.pixels + (y * width + x) * 4).copy_from(@pixels.to_unsafe + from, 4)
        end
      end
      result
    end

    # Replaces pixels, clipped to this image.
    def paste(image : Image, x : Int32 = 0, y : Int32 = 0) : Nil
      each_overlap(image, x, y) do |from, to, count|
        (@pixels + to).copy_from(image.pixels.to_unsafe + from, count)
      end
    end

    # Alpha source-over, clipped to this image.
    def composite(image : Image, x : Int32 = 0, y : Int32 = 0) : Nil
      src = image.pixels
      each_overlap(image, x, y) do |from, to, count|
        (count // 4).times do |k|
          s = from + k * 4
          d = to + k * 4
          sa = src[s + 3].to_u64
          next if sa == 0
          da = @pixels[d + 3].to_u64
          blend = da * (255 - sa)
          out255 = sa * 255 + blend
          coef1 = sa * 255 * 255 * 128 // out255
          coef2 = 255_u64 * 128 - coef1
          3.times do |c|
            sum = src[s + c].to_u64 * coef1 + @pixels[d + c].to_u64 * coef2 + (0x80_u64 << 7)
            @pixels[d + c] = ((((sum >> 8) + sum) >> 8) >> 7).to_u8!
          end
          total = out255 + 0x80
          @pixels[d + 3] = (((total >> 8) + total) >> 8).to_u8!
        end
      end
    end

    def alpha_extrema : Tuple(UInt8, UInt8)
      low = 255_u8
      high = 0_u8
      (@width * @height).times do |i|
        a = @pixels[i * 4 + 3]
        low = a if a < low
        high = a if a > high
      end
      {low, high}
    end

    def write_png(path : String) : Nil
      temporary = "#{path}.tmp#{Process.pid}"
      info = LibPNG::Image.new
      info.version = 1_u32
      info.width = @width.to_u32
      info.height = @height.to_u32
      info.format = PNG_FORMAT_RGBA
      begin
        ok = LibPNG.png_image_write_to_file(pointerof(info), temporary.to_unsafe, 0, @pixels.to_unsafe.as(Void*), 0, Pointer(Void).null)
        raise Error.new("cannot write PNG #{path}") if ok == 0
        File.rename(temporary, path)
      ensure
        LibPNG.png_image_free(pointerof(info))
        File.delete?(temporary)
      end
    end

    private def index(x : Int32, y : Int32) : Int32
      raise Error.new("pixel #{x},#{y} is outside #{@width}x#{@height}") unless 0 <= x < @width && 0 <= y < @height
      (y * @width + x) * 4
    end

    private def each_overlap(image : Image, x : Int32, y : Int32, &)
      left = Math.max(0, x)
      right = Math.min(@width, x + image.width)
      return if left >= right
      Math.max(0, y).upto(Math.min(@height, y + image.height) - 1) do |row|
        yield ((row - y) * image.width + (left - x)) * 4, (row * @width + left) * 4, (right - left) * 4
      end
    end
  end

  # Decodes a PNG after dropping ancillary chunks; nil when unsupported.
  def self.png(data : Bytes?) : Image?
    png(data) { |_| }
  end

  def self.png(data : Bytes?, &reserve : Int64 ->) : Image?
    return nil if data.nil? || data.size < 33 || data[0, 16] != PNG_HEADER
    format = IO::ByteFormat::BigEndian
    width = format.decode(UInt32, data[16, 4])
    height = format.decode(UInt32, data[20, 4])
    return nil unless 0 < width <= 1024 && 0 < height <= 2048 && width.to_u64 * height <= 1024 * 1024
    reserve.call(width.to_i64 * height * 4)

    clean = IO::Memory.new
    clean.write(data[0, 8])
    offset = 8
    finished = false
    2048.times do
      return nil if offset + 12 > data.size
      size = format.decode(UInt32, data[offset, 4]).to_i64
      kind = String.new(data[offset + 4, 4])
      stop = offset + size + 12
      return nil if stop > data.size || (kind == "IHDR" && offset != 8)
      if {"IHDR", "PLTE", "IDAT", "IEND", "tRNS"}.includes?(kind)
        clean.write(data[offset, size + 12])
      elsif data[offset + 4] & 0x20 == 0
        return nil
      end
      offset = stop.to_i
      if kind == "IEND"
        return nil if size != 0 || offset != data.size
        finished = true
        break
      end
    end
    return nil unless finished
    decode_clean(clean.to_slice, width.to_i, height.to_i)
  end

  private def self.decode_clean(bytes : Bytes, width : Int32, height : Int32) : Image?
    info = LibPNG::Image.new
    info.version = 1_u32
    begin
      return nil if LibPNG.png_image_begin_read_from_memory(pointerof(info), bytes.to_unsafe.as(Void*), bytes.size) == 0
      return nil unless info.width == width && info.height == height
      info.format = PNG_FORMAT_RGBA
      pixels = Bytes.new(width * height * 4)
      return nil if LibPNG.png_image_finish_read(pointerof(info), Pointer(Void).null, pixels.to_unsafe.as(Void*), 0, Pointer(Void).null) == 0
      Image.new(width, height, pixels)
    ensure
      LibPNG.png_image_free(pointerof(info))
    end
  end

  def self.json_object(raw : Bytes?, path : String) : Hash(String, JSON::Any)?
    return nil if raw.nil?
    raw = raw[3..] if raw.size >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF
    begin
      parser = JSON::PullParser.new(String.new(raw))
      raise Error.new("expected a JSON object in #{path}") unless parser.kind.begin_object?
      value = json_value(parser)
      raise JSON::ParseException.new("trailing data", 0, 0) unless parser.kind.eof?
      value.as_h
    rescue ex : JSON::ParseException
      raise Error.new("invalid JSON in #{path}: #{ex.message}")
    end
  end

  private def self.json_value(parser : JSON::PullParser) : JSON::Any
    case parser.kind
    when .null?
      parser.read_next
      JSON::Any.new(nil)
    when .bool?
      JSON::Any.new(parser.read_bool)
    when .int?
      JSON::Any.new(parser.read_int)
    when .float?
      JSON::Any.new(parser.read_float)
    when .string?
      JSON::Any.new(parser.read_string)
    when .begin_array?
      list = [] of JSON::Any
      parser.read_array { list << json_value(parser) }
      JSON::Any.new(list)
    when .begin_object?
      map = {} of String => JSON::Any
      parser.read_object do |key, location|
        raise JSON::ParseException.new("duplicate key", *location) if map.has_key?(key)
        map[key] = json_value(parser)
      end
      JSON::Any.new(map)
    else
      raise JSON::ParseException.new("unexpected token", 0, 0)
    end
  end

  class Archive
    getter label : String
    getter entries : Hash(String, Compress::Zip::File::Entry)

    @zip : Compress::Zip::File?
    @file : File?
    @directory_start = 0_i64
    @cache = {} of String => Bytes
    @remaining : Int64 = 128_i64 << 20
    @images = {} of String => Image?
    @image_bytes = 0_i64

    def initialize(path : String, overlay : Bool = false, *, @decode_budget : Int64 = 128_i64 << 20)
      @label = overlay ? "resource pack" : "client JAR"
      @entries = {} of String => Compress::Zip::File::Entry
      raise Error.new("#{@label} must be a local ZIP file: #{path}") unless File.file?(path)
      maximum, limit = overlay ? {64_i64, 20000} : {128_i64, 50000}
      file = File.open(path)
      begin
        flags, @directory_start = directory(file, maximum << 20, limit)
        @file = file
        @zip = zip = Compress::Zip::File.new(file, sync_close: true)
        list = zip.entries
        raise Error.new("#{@label} ZIP directory entry count disagrees with header") unless list.size == flags.size
        expanded = 0_i64
        list.each_with_index do |entry, i|
          name = entry.filename
          _, unix_mode = flags[i]
          check_name(name)
          raise Error.new("#{@label} has an unsafe ZIP member: #{name[0, 120].inspect}") if unix_mode & 0o170000 == 0o120000
          raise Error.new("#{@label} has a duplicate ZIP member: #{name.inspect}") if @entries.has_key?(name)
          @entries[name] = entry
          if name.starts_with?(ASSETS) || name == "pack.mcmeta" || name == "version.json"
            expanded += entry.uncompressed_size
          end
        end
        raise Error.new("#{@label} declares more than 96 MiB of Minecraft assets") if expanded > 96_i64 << 20
      rescue ex
        file.close
        raise ex if ex.is_a?(Error)
        raise Error.new("#{@label} is not a supported ZIP archive: #{ex.message}")
      end
    end

    def close : Nil
      @zip.try &.close
      @zip = nil
      @file = nil
      @cache.clear
      @images.clear
      @image_bytes = 0_i64
    end

    def read(name : String) : Bytes?
      if cached = @cache[name]?
        return cached
      end
      entry = @entries[name]?
      return nil if entry.nil?
      maximum = name.ends_with?(".png") ? 2_i64 << 20 : 256_i64 << 10
      size = entry.uncompressed_size.to_i64
      compressed = entry.compressed_size.to_i64
      method = entry.compression_method
      unless entry.general_purpose_bit_flag & 1 == 0 && (method.stored? || method.deflated?) &&
             0 < compressed <= maximum + (64_i64 << 10) && 0 < size <= maximum && size <= 2048 * compressed
        raise Error.new("#{@label} has an oversized, encrypted, or unsupported asset: #{name}")
      end
      raise Error.new("#{@label} exceeds the decompressed read budget") if size > @remaining
      memory = IO::Memory.new
      begin
        validate_span(entry)
        entry.open { |io| IO.copy(io, memory, size + 1) }
      rescue ex : Compress::Zip::Error | Compress::Deflate::Error | IO::Error | ArgumentError
        raise Error.new("#{@label} cannot read #{name}: #{ex.message}")
      end
      raise Error.new("#{@label} has an invalid asset length: #{name}") unless memory.size == size
      @remaining -= size
      data = memory.to_slice
      @cache.shift if @cache.size >= 512
      @cache[name] = data
      data
    end

    # Callers use cached source images read-only and transform copies.
    def image(name : String) : Image?
      return unless @entries.has_key?(name)
      if @images.has_key?(name)
        cached = @images.delete(name)
        @images[name] = cached
        return cached
      end
      image = PackBuilder.png(read(name)) do |estimated_bytes|
        raise Error.new("#{@label} exceeds the PNG decode budget") if estimated_bytes > @decode_budget
        @decode_budget -= estimated_bytes
      end
      bytes = image.try(&.pixels.size) || 0
      while @images.size >= 4096 || @image_bytes + bytes > 16_i64 << 20
        _, evicted = @images.shift
        @image_bytes -= evicted.try(&.pixels.size) || 0
      end
      @images[name] = image
      @image_bytes += bytes
      image
    end

    def object(name : String) : Hash(String, JSON::Any)?
      PackBuilder.json_object(read(name), name)
    end

    def self.span_fits?(start : Int64, size : Int64, before : Int64) : Bool
      0 <= start <= before && 0 <= size <= before - start
    end

    private def validate_span(entry : Compress::Zip::File::Entry) : Nil
      file = @file || raise Error.new("#{@label} is closed")
      offset = entry.offset.to_i64
      invalid = Error.new("#{@label} has a ZIP member outside its data region: #{entry.filename}")
      raise invalid unless Archive.span_fits?(offset, 30_i64, @directory_start)
      format = IO::ByteFormat::LittleEndian
      file.read_at(offset, 30) do |header|
        raise invalid unless header.read_bytes(UInt32, format) == 0x04034b50_u32
        header.skip(22)
        name_length = header.read_bytes(UInt16, format)
        extra_length = header.read_bytes(UInt16, format)
        data = offset + 30 + name_length + extra_length
        raise invalid unless Archive.span_fits?(data, entry.compressed_size.to_i64, @directory_start)
      end
    end

    private def check_name(name : String) : Nil
      parts = name.chomp('/').split('/', remove_empty: false)
      if name.size > 512 || name.includes?('\\') || name.includes?(':') ||
         parts.any? { |part| part.empty? || part == "." || part == ".." } ||
         name.each_char.any? { |c| c.ord < 32 || c.ord == 127 }
        raise Error.new("#{@label} has an unsafe ZIP member: #{name[0, 120].inspect}")
      end
    end

    # Returns {flags, unix mode} per central directory entry after bounding the directory.
    private def directory(file : File, maximum : Int64, limit : Int32) : Tuple(Array(Tuple(UInt16, UInt32)), Int64)
      size = file.size
      raise Error.new("#{@label} exceeds #{maximum >> 20} MiB") if size > maximum
      start = Math.max(0_i64, size - 65557)
      file.pos = start
      tail = Bytes.new((size - start).to_i)
      file.read_fully(tail)
      format = IO::ByteFormat::LittleEndian
      ending = nil
      (tail.size - 4).downto(0) do |i|
        if tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 5 && tail[i + 3] == 6
          ending = i
          break
        end
      end
      unsupported = Error.new("#{@label} is not a supported ZIP archive")
      raise unsupported if ending.nil? || tail.size - ending < 22
      disk = format.decode(UInt16, tail[ending + 4, 2])
      directory_disk = format.decode(UInt16, tail[ending + 6, 2])
      disk_count = format.decode(UInt16, tail[ending + 8, 2])
      count = format.decode(UInt16, tail[ending + 10, 2])
      length = format.decode(UInt32, tail[ending + 12, 4])
      offset = format.decode(UInt32, tail[ending + 16, 4])
      comment = format.decode(UInt16, tail[ending + 20, 2])
      if disk != 0 || directory_disk != 0 || disk_count != count || !(0 < count <= limit) ||
         length > 12 << 20 || offset.to_i64 + length != start + ending || ending + 22 + comment != tail.size
        raise Error.new("#{@label} has an invalid or oversized ZIP directory")
      end
      central = Bytes.new(length)
      file.pos = offset
      file.read_fully(central)
      result = [] of Tuple(UInt16, UInt32)
      position = 0
      count.times do
        raise Error.new("#{@label} has an invalid or oversized ZIP directory") if position + 46 > central.size ||
                                                                                  format.decode(UInt32, central[position, 4]) != 0x02014b50_u32
        flags = format.decode(UInt16, central[position + 8, 2])
        name_length = format.decode(UInt16, central[position + 28, 2]).to_i
        extra_length = format.decode(UInt16, central[position + 30, 2]).to_i
        comment_length = format.decode(UInt16, central[position + 32, 2]).to_i
        attributes = format.decode(UInt32, central[position + 38, 4])
        position += 46 + name_length + extra_length + comment_length
        raise Error.new("#{@label} has an invalid or oversized ZIP directory") if position > central.size
        result << {flags, attributes >> 16}
      end
      {result, offset.to_i64}
    end
  end

  class Layers
    getter jar : Archive
    getter overlay : Archive?
    getter skipped = Set(Tuple(String, String)).new
    getter archives : Array(Archive)

    def initialize(@jar : Archive, @overlay : Archive? = nil)
      @archives = overlay ? [overlay, jar] : [jar]
      version = jar.object("version.json") || {} of String => JSON::Any
      unless version["id"]?.try(&.as_s?) == VERSION && version["protocol_version"]?.try(&.as_i64?) == PROTOCOL
        raise Error.new("expected a Minecraft Java #{VERSION} client JAR (protocol #{PROTOCOL})")
      end
      unless jar.entries.has_key?(ASSETS + "blockstates/stone.json")
        raise Error.new("client JAR has no Minecraft blockstate assets; use the launcher client JAR, not a server JAR")
      end
      if overlay
        unless overlay.entries.keys.any? { |name| name.starts_with?(ASSETS) && !name.ends_with?('/') }
          raise Error.new("resource pack has no assets/minecraft files at the archive root")
        end
        if metadata = overlay.object("pack.mcmeta")
          validate_pack(metadata)
        end
      end
    end

    def object(path : String) : Hash(String, JSON::Any)?
      locate(path).try &.object(path)
    end

    def image(path : String, required : Bool = false, &accept : Image -> Bool) : Image?
      @archives.each do |layer|
        next unless layer.entries.has_key?(path)
        image = layer.image(path)
        return image if image && accept.call(image)
        @skipped << {layer.label, path}
      end
      raise Error.new("missing or unsupported image: #{path}") if required
      nil
    end

    def image(path : String, required : Bool = false) : Image?
      image(path, required) { |_| true }
    end

    def texture_layers(path : String, &)
      @archives.each_with_index do |layer, index|
        next unless layer.entries.has_key?(path)
        image = layer.image(path)
        if image.nil?
          @skipped << {layer.label, path}
          next
        end
        meta_path = path + ".mcmeta"
        inherited = if layer == locate(path)
                      @archives[0...index].find { |candidate| candidate.entries.has_key?(meta_path) }
                    end
        providers = inherited ? {inherited, layer} : {layer}
        providers.each do |provider|
          data = provider.read(meta_path)
          begin
            metadata = PackBuilder.json_object(data, meta_path) || {} of String => JSON::Any
          rescue Error
            @skipped << {provider.label, meta_path}
            next
          end
          yield image, metadata, layer
        end
      end
    end

    def locate(path : String) : Archive?
      @archives.find { |layer| layer.entries.has_key?(path) }
    end

    private def validate_pack(metadata : Hash(String, JSON::Any)) : Nil
      raise Error.new("resource pack overlays and filters are not supported") if metadata.has_key?("overlays") || metadata.has_key?("filter")
      pack = metadata["pack"]?.try(&.as_h?)
      raise Error.new("pack.mcmeta is missing its pack object") if pack.nil?
      if pack.has_key?("min_format") || pack.has_key?("max_format")
        lower = format_bound(pack["min_format"]?)
        upper = format_bound(pack["max_format"]?, upper: true)
      else
        supported = pack["supported_formats"]? || pack["pack_format"]?
        if hash = supported.try(&.as_h?)
          lower = format_bound(hash["min_inclusive"]?)
          upper = format_bound(hash["max_inclusive"]?, upper: true)
        elsif (list = supported.try(&.as_a?)) && list.size == 2
          lower = format_bound(list[0])
          upper = format_bound(list[1], upper: true)
        else
          lower = format_bound(supported)
          upper = format_bound(supported, upper: true)
        end
      end
      raise Error.new("inverted resource pack format range in pack.mcmeta") if lower > upper
      unless lower <= RESOURCE_FORMAT && RESOURCE_FORMAT <= upper
        STDERR.puts "Warning: resource pack does not declare 26.3 format 97.1; using compatible assets only."
      end
    end

    private def format_bound(value : JSON::Any?, upper : Bool = false) : Tuple(Int64, Int64)
      fallback = upper ? 65535_i64 : 0_i64
      if value && (number = value.as_i64?) && number >= 0
        return {number, fallback}
      end
      if value && (list = value.as_a?) && 1 <= list.size <= 2
        parts = list.map(&.as_i64?)
        if parts.all? { |part| part && 0 <= part <= 65535 }
          return {parts[0].not_nil!, parts.size == 2 ? parts[1].not_nil! : fallback}
        end
      end
      raise Error.new("invalid resource pack format range in pack.mcmeta")
    end
  end
end
