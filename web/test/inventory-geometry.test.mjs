import assert from "node:assert/strict";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { compile } from "../scripts/compile.mjs";

const modules = new Map();
function requireModule(name) {
  if (!modules.has(name)) {
    const exports = {};
    modules.set(name, exports);
    runInThisContext(`(require, exports) => {\n${compile(name.slice(2, -3), true)}\n}`)(requireModule, exports);
  }
  return modules.get(name);
}
const { geometry } = requireModule("./inventory.js");
const inv = (layout, count) => ({ menu: 1, revision: 1, layout, slots: Array(count).fill(null), cursor: null, pending: false, ready: true });
const COUNTS = { player: 46, crafting: 46, furnace: 39, hopper: 41, brewing: 41, anvil: 39, enchantment: 38, merchant: 39, chest: 63 };

test("every supported layout places each vanilla slot exactly once, inside its frame", () => {
  for (const [name, count] of Object.entries(COUNTS)) {
    const shape = geometry(inv(name, count));
    const ids = shape.groups.flatMap(g => g.slots).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: count }, (_, i) => i), name);
    for (const g of shape.groups) {
      const rows = Math.ceil(g.slots.length / g.columns);
      assert.ok(g.x >= 0 && g.y >= 0 && g.x + g.columns * 18 <= shape.width && g.y + rows * 18 <= shape.height, `${name} ${g.area}`);
    }
  }
});

test("slot positions match vanilla screens", () => {
  const at = (name, count, area) => { const g = geometry(inv(name, count)).groups.find(x => x.area === area); return [g.slots[0], g.x + 1, g.y + 1]; };
  assert.deepEqual(at("furnace", 39, "input"), [0, 56, 17]);
  assert.deepEqual(at("furnace", 39, "fuel"), [1, 56, 53]);
  assert.deepEqual(at("furnace", 39, "output"), [2, 116, 35]);
  assert.deepEqual(at("furnace", 39, "inventory"), [3, 8, 84]);
  assert.deepEqual(at("furnace", 39, "hotbar"), [30, 8, 142]);
  assert.deepEqual(at("crafting", 46, "result"), [0, 124, 35]);
  assert.deepEqual(at("crafting", 46, "crafting"), [1, 30, 17]);
  assert.deepEqual(at("player", 46, "armor"), [5, 8, 8]);
  assert.deepEqual(at("player", 46, "crafting"), [1, 98, 18]);
  assert.deepEqual(at("player", 46, "result"), [0, 154, 28]);
  assert.deepEqual(at("player", 46, "offhand"), [45, 77, 62]);
  assert.deepEqual(at("brewing", 41, "ingredient"), [3, 79, 17]);
  assert.deepEqual(at("brewing", 41, "fuel"), [4, 17, 17]);
  assert.deepEqual(at("anvil", 39, "result"), [2, 134, 47]);
  assert.deepEqual(at("enchantment", 38, "lapis"), [1, 35, 47]);
  assert.deepEqual(at("merchant", 39, "inventory"), [3, 108, 84]);
  assert.deepEqual(at("hopper", 41, "hotbar"), [32, 8, 109]);
  assert.equal(geometry(inv("chest", 63)).height, 168);
  assert.equal(geometry(inv("chest", 90)).height, 222);
  assert.equal(geometry(inv("hopper", 41)).height, 133);
});

test("malformed slot counts and unknown layouts fail closed", () => {
  for (const [name, count] of Object.entries(COUNTS)) {
    assert.equal(geometry(inv(name, count - 1)), null, name);
    assert.equal(geometry(inv(name, count + 1)), null, name);
  }
  assert.equal(geometry(inv("chest", 36)), null);
  assert.equal(geometry(inv("chest", 94)), null);
  assert.equal(geometry(inv("shulker", 63)), null);
  assert.equal(geometry(inv("unsupported", 0)), null);
});

test("unsupported controls are inert decor with no slot ids", () => {
  const shape = geometry(inv("enchantment", 38));
  assert.ok(shape.decor.some(d => d.kind === "offers"));
  assert.ok(geometry(inv("merchant", 39)).decor.some(d => d.kind === "trades"));
});

test("art keys follow the screen, with one chest image per row count", () => {
  const key = (name, count) => geometry(inv(name, count)).art;
  assert.deepEqual(
    [["player", 46], ["crafting", 46], ["furnace", 39], ["hopper", 41], ["brewing", 41], ["anvil", 39], ["enchantment", 38], ["merchant", 39]].map(([n, c]) => key(n, c)),
    ["inventory", "crafting_table", "furnace", "hopper", "brewing_stand", "anvil", "enchanting_table", "villager"]);
  for (let rows = 1; rows <= 6; rows++) assert.equal(key("chest", 36 + 9 * rows), `chest_${rows}`);
});
