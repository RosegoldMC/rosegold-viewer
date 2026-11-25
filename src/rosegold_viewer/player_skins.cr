require "digest/crc32"
require "digest/sha256"

module RosegoldViewer
  private class PlayerSkins
    private MAX_SKINS     = 32
    private MAX_BYTES     = 32 * 1024
    private PNG_SIGNATURE = Bytes[137, 80, 78, 71, 13, 10, 26, 10]

    alias Appearance = NamedTuple(model: String, key: String)
    private record Skin, appearance : Appearance, bytes : Bytes

    @skins = {} of UUID => Skin
    @assets = {} of String => Bytes

    def register(uuid : UUID, path : String, *, slim : Bool) : Bool
      return false unless (@skins.has_key?(uuid) || @skins.size < MAX_SKINS) && File.file?(path)
      raw = File.open(path) do |file|
        buffer = Bytes.new(MAX_BYTES + 1)
        size = 0
        while size < buffer.size
          count = file.read(buffer[size..])
          break if count.zero?
          size += count
        end
        buffer[0, size]
      end
      return false unless bytes = skin_png(raw, slim)
      return false unless @skins.has_key?(uuid) || @skins.size < MAX_SKINS

      key = Digest::SHA256.hexdigest(bytes)
      @skins[uuid] = Skin.new({model: slim ? "slim" : "classic", key: key}, bytes)
      @assets = @skins.values.to_h { |skin| {skin.appearance[:key], skin.bytes} }
      true
    rescue IO::Error
      false
    end

    def appearance(uuid : UUID) : Appearance
      if skin = @skins[uuid]?
        skin.appearance
      elsif uuid.bytes[15].odd?
        {model: "slim", key: "default-slim"}
      else
        {model: "classic", key: "default-classic"}
      end
    end

    def asset(key : String) : Bytes?
      @assets[key]?
    end

    private def skin_png(bytes : Bytes, slim : Bool) : Bytes?
      return unless 45 <= bytes.size <= MAX_BYTES && bytes[0, 8] == PNG_SIGNATURE
      output = IO::Memory.new
      output.write(PNG_SIGNATURE)
      offset = 8
      image_data = false
      while offset + 12 <= bytes.size
        length = IO::ByteFormat::BigEndian.decode(UInt32, bytes[offset, 4])
        return if length > bytes.size - offset - 12
        chunk = bytes[offset, length.to_i + 12]
        type = String.new(chunk[4, 4])
        checksum = IO::ByteFormat::BigEndian.decode(UInt32, chunk[chunk.size - 4, 4])
        return unless Digest::CRC32.checksum(chunk[4, chunk.size - 8]) == checksum
        return if offset == 8 && type != "IHDR"
        case type
        when "IHDR"
          return unless offset == 8 && length == 13
          width = IO::ByteFormat::BigEndian.decode(UInt32, chunk[8, 4])
          height = IO::ByteFormat::BigEndian.decode(UInt32, chunk[12, 4])
          return unless width == 64 && (height == 64 || (!slim && height == 32))
        when "IDAT"
          image_data = true unless length.zero?
        when "PLTE", "tRNS"
          return if image_data
        when "IEND"
          return unless image_data && length.zero? && offset + chunk.size == bytes.size
          output.write(chunk)
          return output.to_slice
        else
          return if (chunk[4] & 0x20) == 0
          offset += chunk.size
          next
        end
        output.write(chunk)
        offset += chunk.size
      end
      nil
    end
  end
end
