import assert from "node:assert/strict";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { compile } from "../scripts/compile.mjs";

const modules = new Map();
function load(name) {
  if (!modules.has(name)) {
    const exports = {};
    modules.set(name, exports);
    runInThisContext(`(require, exports) => {\n${compile(name.slice(2, -3), true)}\n}`)(load, exports);
  }
  return modules.get(name);
}
const { decodeBatch } = load("./wire.js");

function frame(entities, status = "ready") {
  const header = new TextEncoder().encode(JSON.stringify({ epoch: 1, seq: 1, status, protocol: 777, yaw: 0, entities }));
  const bytes = new Uint8Array(header.length + 2);
  new DataView(bytes.buffer).setUint16(0, header.length, true);
  bytes.set(header, 2);
  return decodeBatch(bytes);
}

const item = { id: 1, position: [-0.25, 64, 0.1], species: "item", yaw: 270, pitch: -30, pose: 0 };
const player = { id: 2, position: [5, 64, 3.5], species: "player", yaw: 0, pitch: 0, pose: 5, appearance: { model: "slim", key: "default-slim" } };

test("decodes replacement snapshots, deferred stack data, and safe appearance keys", () => {
  assert.equal(frame(undefined).entities, undefined);
  assert.deepEqual(frame([]).entities, []);
  assert.deepEqual(frame([item, player]).entities, [item, player]);
  const typed = { ...item, item: { name: "wheat", count: 6 } };
  const local = { ...player, appearance: { model: "classic", key: "ab".repeat(32) } };
  assert.deepEqual(frame([typed, { ...local, uuid: "not copied", auth: "not copied" }]).entities, [typed, local]);
});

test("rejects unbounded or ambiguous entity snapshots", () => {
  const invalid = [
    [item, item], [null], [{ ...item, id: 0 }], [{ ...item, position: [30_000_001, 4, 5] }],
    [{ ...item, species: "item\n" }], [{ ...item, yaw: 360 }], [{ ...item, pitch: 180 }],
    [{ ...item, item: { name: "seed", count: 0 } }], [{ ...item, item: { name: "seed\n", count: 1 } }],
    [{ ...player, appearance: undefined }], [{ ...player, appearance: { model: "slim", key: "default-classic" } }],
    [{ ...player, appearance: { model: "slim", key: "https://example.invalid/skin.png" } }],
    [{ ...player, appearance: { model: "slim", key: "a".repeat(64) + "\n" } }],
    Array.from({ length: 25 }, (_, index) => ({ ...item, id: index + 1 })),
  ];
  for (const rows of invalid) assert.throws(() => frame(rows));
  assert.throws(() => frame([], "waiting"));
});
