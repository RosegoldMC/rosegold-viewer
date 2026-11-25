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

const { decodeBatch } = requireModule("./wire.js");
const { formatDebug, facing, localCoordinate, fixed } = requireModule("./debug-format.js");
const { ViewerDebug } = requireModule("./viewer-debug.js");

const encode = value => new TextEncoder().encode(JSON.stringify(value));
function bytes(data) {
  const json = encode(data);
  const out = new Uint8Array(2 + json.length);
  out.set(json, 2);
  new DataView(out.buffer).setUint16(0, json.length, true);
  return out;
}
const base = { epoch: 1, seq: 1, status: "ready", yaw: 0 };
const info = { feet: [-0.5, 64, -17.25], rotation: [0, 0], dimension: "minecraft:overworld", time: 25000, target: null };

const baseView = { feed: "ready", control: "view", info, fps: { fps: 60, average: 16.7, worst: 20 }, sections: 12, gpu: "Test GPU", viewport: { width: 800, height: 600, ratio: 2 } };

test("decodes debug info and rejects malformed values", () => {
  const target = { kind: "block", position: [-3, 64, 5], id: "minecraft:oak_stairs", props: { facing: "north", waterlogged: "false" } };
  const decoded = decodeBatch(bytes({ ...base, debug: { ...info, target } })).debug;
  assert.deepEqual({ ...decoded, target: { ...decoded.target, props: { ...decoded.target.props } } }, { ...info, target });
  assert.equal(decodeBatch(bytes({ ...base, debug: { ...info, time: null, target: { kind: "entity", id: null } } })).debug.target.kind, "entity");
  for (const bad of [
    { ...info, feet: [0, 0] }, { ...info, rotation: [0, 91] }, { ...info, rotation: [0] }, { ...info, dimension: "Over World" }, { ...info, time: 1.5 },
    { ...info, target: { kind: "block", position: [0, 0, 0], id: null, props: { "Bad": "x" } } },
    { ...info, target: { kind: "fluid" } },
  ]) assert.throws(() => decodeBatch(bytes({ ...base, debug: bad })));
  assert.throws(() => decodeBatch(bytes({ epoch: 1, seq: 1, status: "waiting", debug: info })));
});

test("floors block, local and chunk coordinates for negatives", () => {
  const lines = formatDebug(baseView).left;
  assert.ok(lines.includes("XYZ: -0.500 / 64.000 / -17.250"));
  assert.ok(lines.includes("Block: -1 64 -18"));
  assert.ok(lines.includes("Chunk: 15 0 14 in -1 4 -2"));
  assert.equal(localCoordinate(-16), 0);
  assert.equal(fixed(-0.0004, 3), "0.000");
});

test("formats facing axis, yaw and pitch from the sampled rotation", () => {
  assert.equal(facing(0), "south (Towards positive Z)");
  assert.equal(facing(90), "west (Towards negative X)");
  assert.equal(facing(180), "north (Towards negative Z)");
  assert.equal(facing(-90), "east (Towards positive X)");
  assert.equal(facing(450), "west (Towards negative X)");
  const at = (yaw, pitch) => formatDebug({ ...baseView, info: { ...info, rotation: [yaw, pitch] } }).left.find(line => line.startsWith("Facing"));
  assert.equal(at(0, 0), "Facing: south (Towards positive Z) (0.0 / 0.0)");
  assert.equal(at(73.3, 10.8), "Facing: west (Towards negative X) (73.3 / 10.8)");
  assert.equal(at(270, -90), "Facing: east (Towards positive X) (-90.0 / -90.0)");
});

test("labels unavailable fields without inventing values", () => {
  const { left, right } = formatDebug({ ...baseView, info: null, fps: null, sections: null, gpu: null, viewport: null });
  for (const prefix of ["XYZ", "Block", "Chunk", "Facing", "Biome", "Dimension", "World time"]) {
    assert.ok(left.some(line => line === `${prefix}: n/a`), prefix);
  }
  assert.ok(right.includes("WebGL: n/a") && right.includes("Sections: n/a"));
  assert.ok(![...left, ...right].some(line => /memory|tps|seed|light|jvm/i.test(line)));
  assert.ok(formatDebug({ ...baseView, info: { ...info, time: null } }).left.includes("World time: n/a"));
});

test("shows crosshair block with properties or entity", () => {
  const block = { kind: "block", position: [-3, 64, 5], id: "minecraft:lever", props: { face: "wall", powered: "true" } };
  const { right } = formatDebug({ ...baseView, info: { ...info, target: block } });
  assert.deepEqual(right.slice(-4), ["Targeted Block: -3, 64, 5", "minecraft:lever", "face: wall", "powered: true"]);
  assert.ok(formatDebug({ ...baseView, info: { ...info, target: { kind: "entity", id: "minecraft:cow" } } }).right.includes("minecraft:cow"));
  assert.ok(formatDebug(baseView).right.includes("Targeted Block: none"));
});

class El {
  constructor() { this.children = []; this.hidden = true; this.ownerDocument = { createElement: () => new El() }; this.parentElement = null; }
  replaceChildren(...c) { this.children = c; }
}

function harness() {
  const parent = new El();
  const left = new El(), right = new El();
  left.parentElement = parent;
  let time = 0, next = 1;
  const frames = new Map();
  const env = {
    now: () => time, frame: cb => { frames.set(next, cb); return next++; }, cancel: h => frames.delete(h),
    control: () => "view", sections: () => 3, gpu: () => "GPU", viewport: () => ({ width: 1, height: 1, ratio: 1 }),
  };
  const debug = new ViewerDebug(left, right, env);
  const step = ms => { time += ms; const [h, cb] = [...frames][0] ?? []; if (cb) { frames.delete(h); cb(); } };
  return { debug, parent, left, right, frames, step };
}

test("toggles twice, measures frames and stops the loop when closed", () => {
  const { debug, parent, left, frames, step } = harness();
  assert.equal(debug.requested(), false);
  debug.toggle();
  assert.equal(parent.hidden, false);
  assert.equal(debug.requested(), true);
  for (let i = 0; i < 70; i++) step(16);
  assert.ok(left.children.some(row => /^6\d fps/.test(row.textContent)));
  debug.toggle();
  assert.equal(parent.hidden, true);
  assert.equal(frames.size, 0);
  assert.equal(left.children.length, 0);
  assert.equal(debug.requested(), false);
  debug.toggle();
  assert.equal(frames.size, 1);
});

test("clears stale values on reset, epoch change and non-ready status", () => {
  const { debug, left, step } = harness();
  debug.toggle();
  debug.setStatus("ready");
  debug.apply({ ...base, debug: info });
  step(300);
  assert.ok(left.children.some(row => row.textContent.startsWith("Block: -1 64 -18")));
  debug.apply({ ...base, epoch: 2 });
  step(300);
  assert.ok(left.children.some(row => row.textContent === "Block: n/a"));
  debug.apply({ ...base, epoch: 2, debug: info });
  debug.setStatus("loading");
  assert.ok(left.children.some(row => row.textContent === "XYZ: n/a"));
  debug.apply({ ...base, epoch: 3, debug: info });
  debug.reset();
  assert.ok(left.children.some(row => row.textContent === "XYZ: n/a"));
});
