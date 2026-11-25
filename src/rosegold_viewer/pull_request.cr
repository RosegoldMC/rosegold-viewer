require "json"

module RosegoldViewer
  private enum InputKind
    Pause
    Play
    Inventory
    Click
    CloseInventory
    Return
    Takeover
    Resume
    Restart
    ChatFocus
  end

  private record Input, grant : UInt32, sequence : UInt32, kind : InputKind, data : StaticArray(Int64, 5) do
    def self.read(reader : JSON::PullParser) : self?
      values = StaticArray(Int64, 8).new(0_i64)
      size = 0
      reader.read_array do
        return if size == values.size || !reader.kind.int?
        value = reader.read_raw.to_i64?(whitespace: false)
        return unless value
        values[size] = value
        size += 1
      end
      return unless size >= 3
      return unless (1..UInt32::MAX).includes?(values[0]) && (1..UInt32::MAX).includes?(values[1])
      return unless (InputKind::Pause.value..InputKind::ChatFocus.value).includes?(values[2])

      kind = InputKind.from_value(values[2].to_i)
      data = StaticArray(Int64, 5).new { |index| values[index + 3] }
      valid = case kind
              when .play?
                size == 8 && (0..511).includes?(data[0]) && (-18000..18000).includes?(data[1]) &&
                  (-9000..9000).includes?(data[2]) && (0..15).includes?(data[3]) && (-1..8).includes?(data[4])
              when .click?
                size == 8 && (1..UInt32::MAX).includes?(data[0]) && (1..UInt32::MAX).includes?(data[1]) &&
                  (0..127).includes?(data[2]) && (0..2).includes?(data[3]) && (0..(data[3] == 2 ? 8 : 1)).includes?(data[4])
              when .close_inventory?
                size == 3 || (size == 4 && (1..UInt32::MAX).includes?(data[0]))
              else
                size == 3
              end
      new(values[0].to_u32, values[1].to_u32, kind, data) if valid
    end
  end

  private record PullRequest, epoch : UInt32, sequence : UInt32, input : Input?, debug : Bool = false do
    def self.read(body : Bytes) : self?
      reader = JSON::PullParser.new(IO::Memory.new(body))
      epoch = sequence = input = nil
      debug = false
      reader.read_object do |key|
        case key
        when "epoch"
          return if epoch || !reader.kind.int?
          epoch = reader.read_raw.to_u32?(whitespace: false) || return
        when "seq"
          return if sequence || !reader.kind.int?
          sequence = reader.read_raw.to_u32?(whitespace: false) || return
        when "i"
          return if input
          input = Input.read(reader) || return
        when "d"
          return unless reader.kind.int? && reader.read_raw == "1"
          debug = true
        else
          return
        end
      end
      new(epoch, sequence, input, debug) if reader.kind.eof? && epoch && sequence
    rescue JSON::ParseException
      nil
    end
  end
end
