import type { InventorySnapshot } from "./wire.js";

export type ClickOp = "pickup" | "split" | "quick" | "swap";

export interface ClickRequest {
  menu: number;
  revision: number;
  slot: number;
  op: number;
  button: number;
}

export interface SlotGroup {
  label: string;
  slots: number[];
  columns: number;
  area: string;
  x: number;
  y: number;
}

export type DecorKind = "arrow" | "flame" | "preview" | "offers" | "trades" | "name" | "bubbles" | "fuel";

export interface Decor {
  kind: DecorKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Geometry {
  width: number;
  height: number;
  art: string;
  groups: SlotGroup[];
  decor: Decor[];
}

export const CELL = 18;

const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);
const group = (label: string, area: string, slots: number[], columns: number, x: number, y: number): SlotGroup => ({ label, area, slots, columns, x: x - 1, y: y - 1 });
const decor = (kind: DecorKind, x: number, y: number, w: number, h: number): Decor => ({ kind, x, y, w, h });

function lower(top: number, y: number, x = 8): SlotGroup[] {
  return [group("Inventory", "inventory", range(top, 27), 9, x, y), group("Hotbar", "hotbar", range(top + 27, 9), 9, x, y + 58)];
}

function frame(art: string, width: number, height: number, top: SlotGroup[], lowerStart: number, y: number, extra: Decor[] = []): Geometry {
  return { art, width, height, groups: [...top, ...lower(lowerStart, y)], decor: extra };
}

export function geometry(inv: InventorySnapshot): Geometry | null {
  const count = inv.slots.length;
  switch (inv.layout) {
    case "player":
      if (count !== 46) return null;
      return {
        art: "inventory", width: 176, height: 166, decor: [decor("preview", 26, 8, 50, 75), decor("arrow", 134, 29, 16, 13)],
        groups: [
          group("Crafting", "crafting", range(1, 4), 2, 98, 18),
          group("Result", "result", [0], 1, 154, 28),
          group("Armor", "armor", range(5, 4), 1, 8, 8),
          group("Offhand", "offhand", [45], 1, 77, 62),
          ...lower(9, 84),
        ],
      };
    case "crafting":
      if (count !== 46) return null;
      return frame("crafting_table", 176, 166, [group("Crafting", "crafting", range(1, 9), 3, 30, 17), group("Result", "result", [0], 1, 124, 35)], 10, 84, [decor("arrow", 90, 35, 22, 15)]);
    case "furnace":
      if (count !== 39) return null;
      return frame("furnace", 176, 166, [group("Input", "input", [0], 1, 56, 17), group("Fuel", "fuel", [1], 1, 56, 53), group("Output", "output", [2], 1, 116, 35)], 3, 84, [decor("flame", 56, 36, 14, 14), decor("arrow", 79, 34, 24, 17)]);
    case "hopper":
      if (count !== 41) return null;
      return frame("hopper", 176, 133, [group("Hopper", "container", range(0, 5), 5, 44, 20)], 5, 51);
    case "brewing":
      if (count !== 41) return null;
      return frame("brewing_stand", 176, 166, [
        group("Fuel", "fuel", [4], 1, 17, 17),
        group("Ingredient", "ingredient", [3], 1, 79, 17),
        group("Bottle 1", "bottle-1", [0], 1, 56, 51),
        group("Bottle 2", "bottle-2", [1], 1, 79, 58),
        group("Bottle 3", "bottle-3", [2], 1, 102, 51),
      ], 5, 84, [decor("fuel", 60, 44, 18, 4), decor("bubbles", 63, 14, 12, 29), decor("arrow", 97, 16, 9, 28)]);
    case "anvil":
      if (count !== 39) return null;
      return frame("anvil", 176, 166, [group("Left", "left", [0], 1, 27, 47), group("Right", "right", [1], 1, 76, 47), group("Result", "result", [2], 1, 134, 47)], 3, 84, [decor("name", 59, 20, 110, 16), decor("arrow", 99, 47, 22, 15)]);
    case "enchantment":
      if (count !== 38) return null;
      return frame("enchanting_table", 176, 166, [group("Item", "item", [0], 1, 15, 47), group("Lapis", "lapis", [1], 1, 35, 47)], 2, 84, [decor("offers", 60, 14, 108, 57)]);
    case "merchant":
      if (count !== 39) return null;
      return {
        art: "villager", width: 276, height: 166, decor: [decor("trades", 5, 17, 88, 140), decor("arrow", 186, 36, 22, 15)],
        groups: [group("Payment 1", "payment-1", [0], 1, 136, 37), group("Payment 2", "payment-2", [1], 1, 162, 37), group("Result", "result", [2], 1, 220, 37), ...lower(3, 84, 108)],
      };
    case "chest": {
      const top = count - 36;
      if (top < 9 || top > 54 || top % 9 !== 0) return null;
      const rows = top / 9;
      return frame(`chest_${rows}`, 176, 114 + 18 * rows, [group("Chest", "container", range(0, top), 9, 8, 18)], top, 18 * rows + 30);
    }
    default:
      return null;
  }
}

export function layout(inv: InventorySnapshot): SlotGroup[] | null {
  return geometry(inv)?.groups ?? null;
}

export function buildClick(inv: InventorySnapshot, op: ClickOp, slot: number, button: number): ClickRequest | null {
  if (inv.pending || inv.ready === false || !layout(inv) || !Number.isInteger(slot) || slot < 0 || slot >= inv.slots.length || slot > 127) return null;
  const base = { menu: inv.menu, revision: inv.revision, slot };
  switch (op) {
    case "pickup": return { ...base, op: 0, button: 0 };
    case "split": return { ...base, op: 0, button: 1 };
    case "quick": return { ...base, op: 1, button: button === 1 ? 1 : 0 };
    case "swap": return button >= 0 && button <= 8 ? { ...base, op: 2, button } : null;
  }
}

export function canHandBack(canReturn: boolean, inv: InventorySnapshot | null, clickPending: boolean): boolean {
  return canReturn && !clickPending && (!inv || (inv.cursor === null && !inv.pending));
}
