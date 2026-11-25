module RosegoldViewer
  private class Hud
    private alias Slot = NamedTuple(item: String, count: UInt32)
    private alias Breaking = NamedTuple(position: Tuple(Int32, Int32, Int32), stage: Int32)
    alias Snapshot = NamedTuple(health: Float32, food: UInt32, selected: UInt32, slots: StaticArray(Slot?, 9), mining: Int32?, breaking: Breaking?, ice: Bool)

    private UNKNOWN_ITEM = "unknown_item"

    @item_names : Hash(UInt32, String)?

    def initialize(@protocol : UInt32)
    end

    def sample(bot : Rosegold::Bot) : Snapshot
      player = bot.client.player
      inventory = bot.client.player_inventory.items
      health = player.health
      slots = StaticArray(Slot?, 9).new do |index|
        if (slot = inventory[index]?) && slot.present?
          {item: item_name(slot.item_id_int), count: slot.count.clamp(1_u32, 999_u32)}
        end
      end
      progress = break_progress(bot)
      {
        health:   health.finite? ? health.clamp(0_f32, 2048_f32) : 0_f32,
        food:     player.food.clamp(0_u32, 20_u32),
        selected: player.hotbar_selection.clamp(0_u32, 8_u32),
        slots:    slots,
        mining:   progress.try { |fraction| fraction.zero? ? 0 : (fraction * 100).to_i.clamp(1, 99) },
        breaking: breaking(bot, progress),
        ice:      ice_road?(bot),
      }
    end

    private def item_name(id : UInt32) : String
      names = @item_names ||= Rosegold::MCData.for(@protocol).items.to_h do |item|
        {item.id, valid_name?(item.name) ? item.name : UNKNOWN_ITEM}
      end
      names[id]? || UNKNOWN_ITEM
    end

    private def valid_name?(name : String) : Bool
      1 <= name.bytesize <= 64 && name.each_byte.all? do |byte|
        'a'.ord <= byte <= 'z'.ord || '0'.ord <= byte <= '9'.ord || byte == '_'.ord
      end
    end

    private def ice_road?(bot : Rosegold::Bot) : Bool
      bot.client.manual_control.ice_road?
    end

    private def break_progress(bot : Rosegold::Bot) : Float32?
      fraction = bot.block_break_progress
      fraction.finite? ? fraction.clamp(0_f32, 1_f32) : 0_f32
    end

    private def breaking(bot : Rosegold::Bot, progress : Float32?) : Breaking?
      if progress && progress > 0 && (target = bot.block_break_target)
        {position: {target.x, target.y, target.z}, stage: (progress * 10).to_i.clamp(0, 9)}
      end
    end
  end
end
