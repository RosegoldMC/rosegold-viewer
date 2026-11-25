require "json"

module RosegoldViewer
  private record ChatRequest, epoch : UInt32, grant : UInt32, id : UInt32, text : String do
    MAX_BODY = 1600

    def command? : Bool
      text.starts_with?('/')
    end

    def self.read(body : Bytes) : self?
      source = String.new(body)
      return unless source.valid_encoding?

      reader = JSON::PullParser.new(source)
      epoch = grant = id = text = nil
      reader.read_object do |key|
        case key
        when "epoch"
          return if epoch
          epoch = positive_id(reader) || return
        when "grant"
          return if grant
          grant = positive_id(reader) || return
        when "id"
          return if id
          id = positive_id(reader) || return
        when "text"
          return if text || !reader.kind.string?
          raw = reader.read_string
          return if !raw.valid_encoding? || raw.bytesize > 256 || raw.matches?(/[\p{Cc}\p{Zl}\p{Zp}\x{200b}-\x{200f}\x{202a}-\x{202e}\x{2060}-\x{2069}\x{feff}§]/)
          text = raw.gsub(/\A\p{Zs}+|\p{Zs}+\z/, "")
          return if text.empty? || (text.starts_with?('/') && text.lchop('/').blank?)
        else
          return
        end
      end
      new(epoch, grant, id, text) if reader.kind.eof? && epoch && grant && id && text
    rescue JSON::ParseException
      nil
    end

    private def self.positive_id(reader : JSON::PullParser) : UInt32?
      return unless reader.kind.int?
      value = reader.read_raw.to_u32?(whitespace: false)
      value unless value.try(&.zero?)
    end
  end

  private class ChatHistory
    private MAX_HISTORY =  48
    private MAX_DISPLAY = 384
    private FRAME_LINES =   3

    private alias Entry = Tuple(UInt32, String)
    alias Snapshot = NamedTuple(epoch: UInt32, entries: Array(Entry))

    @epoch = 0_u32
    @id = 0_u32
    @entries = Deque(Entry).new

    def reset : Nil
      @epoch &+= 1
      @entries.clear
    end

    def add(display : String) : Nil
      text = String.build do |io|
        size = 0
        display.each_char do |char|
          char = ' ' if char.control? || char.in?(' ', ' ')
          size += char.bytesize
          break if size > MAX_DISPLAY
          io << char
        end
      end
      return if text.blank?
      if @id == UInt32::MAX
        reset
        @id = 0_u32
      end
      @id += 1
      @entries.shift if @entries.size == MAX_HISTORY
      @entries << {@id, text}
    end

    def since(epoch : UInt32?, id : UInt32) : Snapshot?
      entries = [] of Entry
      @entries.each do |entry|
        next if epoch == @epoch && entry[0] <= id
        entries << entry
        break if entries.size == FRAME_LINES
      end
      {epoch: @epoch, entries: entries} unless entries.empty? && epoch == @epoch
    end
  end
end
