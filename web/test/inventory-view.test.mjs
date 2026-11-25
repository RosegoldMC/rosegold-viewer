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

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.parent = null; this.dataset = {}; this.handlers = {}; this.attrs = new Map(); this.hidden = false; this.textContent = ""; this.className = ""; this.props = {}; this.style = { setProperty: (k, v) => { this.props[k] = v; }, removeProperty: k => { delete this.props[k]; } }; this.classes = new Set(); this.classList = { toggle: (k, on) => { if (on) this.classes.add(k); else this.classes.delete(k); } }; this.offsetWidth = 40; this.offsetHeight = 40; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attrs.set(k, v); }
  removeAttribute(k) { this.attrs.delete(k); }
  toggleAttribute(k, on) { if (on) this.attrs.set(k, ""); else this.attrs.delete(k); }
  getContext() { return null; }
  closest(selector) {
    assert.equal(selector, "[data-slot]");
    for (let n = this; n; n = n.parent) if (n.dataset.slot !== undefined) return n;
    return null;
  }
  querySelectorAll(selector) {
    assert.equal(selector, "[data-slot]");
    return this.children.flatMap(c => [...(c.dataset.slot !== undefined ? [c] : []), ...c.querySelectorAll(selector)]);
  }
}
const docHandlers = {};
globalThis.document = { createElement: tag => new El(tag), addEventListener: (type, fn) => { docHandlers[type] = fn; } };
globalThis.window = { innerWidth: 200, innerHeight: 100 };

const { InventoryView } = requireModule("./viewer-inventory.js");
const slots = n => Array(n).fill(null);
const snapshot = (extra = {}) => ({ menu: 1, revision: 1, layout: "player", slots: slots(46), cursor: null, pending: false, ready: true, ...extra });

function view() {
  const clicks = [];
  const root = new El("div"), cursor = new El("div"), hint = new El("p");
  const v = new InventoryView(root, cursor, hint, { click: (op, slot, button) => clicks.push([op, slot, button]) });
  const cell = n => root.querySelectorAll("[data-slot]").find(c => c.dataset.slot === String(n));
  const over = target => root.handlers.mouseover({ target });
  return { v, root, cursor, clicks, cell, over };
}

test("hotbar swap targets only the slot under the pointer", () => {
  const { v, root, clicks, cell, over } = view();
  v.show(snapshot());
  v.hotbarSwap(2);
  assert.deepEqual(clicks, []);
  over(cell(12));
  v.hotbarSwap(2);
  assert.deepEqual(clicks, [["swap", 12, 2]]);
  const heading = root.children[0];
  over(heading);
  v.hotbarSwap(3);
  over(root);
  v.hotbarSwap(3);
  assert.equal(clicks.length, 1);
});

test("hotbar swap drops a hover across pointer leave, rebuilds and a closed menu", () => {
  const { v, root, clicks, cell, over } = view();
  v.show(snapshot());
  over(cell(9));
  root.handlers.mouseleave();
  v.hotbarSwap(0);
  over(cell(9));
  v.show(snapshot({ menu: 2, layout: "crafting" }));
  v.hotbarSwap(0);
  over(cell(37));
  v.show(snapshot({ menu: 2, layout: "crafting", revision: 2 }));
  v.hotbarSwap(0);
  assert.deepEqual(clicks, [["swap", 37, 0]]);
  over(cell(10));
  v.hide();
  v.hotbarSwap(1);
  over(cell(1));
  assert.equal(clicks.length, 1);
  v.show(snapshot({ ready: false }));
  v.hotbarSwap(1);
  assert.equal(clicks.length, 1);
});

test("a readiness loss drops hover until the pointer moves again; a ready refresh keeps it", () => {
  const { v, root, clicks, cell, over } = view();
  v.show(snapshot());
  over(cell(14));
  v.show(snapshot({ revision: 2 }));
  v.hotbarSwap(4);
  assert.deepEqual(clicks, [["swap", 14, 4]]);
  v.show(snapshot({ revision: 3, ready: false }));
  v.show(snapshot({ revision: 4 }));
  v.hotbarSwap(4);
  assert.equal(clicks.length, 1);
  over(cell(14));
  v.hotbarSwap(5);
  assert.deepEqual(clicks.at(-1), ["swap", 14, 5]);
  root.hidden = true;
  over(cell(14));
  root.hidden = false;
  v.hotbarSwap(6);
  assert.equal(clicks.length, 2);
});

test("carried stack follows a mouse pointer, clamps to the viewport and falls back for touch", () => {
  const { v, cursor } = view();
  const stack = { cursor: { item: "minecraft:stone", count: 3 } };
  v.show(snapshot(stack));
  assert.equal(cursor.classes.has("following"), false);
  docHandlers.pointermove({ pointerType: "mouse", clientX: 100, clientY: 50 });
  assert.equal(cursor.classes.has("following"), true);
  assert.equal(cursor.props.transform, "translate(80px, 30px)");
  docHandlers.pointermove({ pointerType: "mouse", clientX: 1000, clientY: -20 });
  assert.equal(cursor.props.transform, "translate(160px, 0px)");
  docHandlers.pointerdown({ pointerType: "touch", clientX: 5, clientY: 5 });
  assert.equal(cursor.classes.has("following"), false);
  assert.equal(cursor.props.transform, undefined);
  docHandlers.pointermove({ pointerType: "mouse", clientX: 100, clientY: 50 });
  v.show(snapshot({ cursor: null }));
  assert.equal(cursor.hidden, true);
  assert.equal(cursor.classes.has("following"), false);
  v.show(snapshot({ ...stack, ready: false }));
  assert.equal(cursor.classes.has("following"), false);
});

test("touch taps use the selected slot action; mouse clicks keep their mapping", () => {
  const { v, root, clicks, cell } = view();
  v.show(snapshot());
  docHandlers.pointerdown({ pointerType: "touch", clientX: 1, clientY: 1 });
  const tap = n => root.handlers.mousedown({ target: cell(n), button: 0, shiftKey: false, preventDefault() {} });
  tap(12);
  v.setTouchOp("split", 0);
  tap(12);
  v.setTouchOp("quick", 0);
  tap(12);
  v.setTouchOp("swap", 3);
  tap(12);
  docHandlers.pointerdown({ pointerType: "mouse", clientX: 1, clientY: 1 });
  tap(12);
  assert.deepEqual(clicks, [["pickup", 12, 0], ["split", 12, 1], ["quick", 12, 0], ["swap", 12, 3], ["pickup", 12, 0]]);
});
