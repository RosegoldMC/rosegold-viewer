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

const { ViewerTerrain } = requireModule("./viewer-terrain.js");
const { EntityLayer } = requireModule("./entity-layer.js");
const { toLayerEntities } = requireModule("./entity-glue.js");

const row = (id, x = 0) => ({ id, position: [x, 0, 0], species: "cow", yaw: 0, pitch: 0, pose: 0 });
const ready = (extra = {}) => ({ epoch: 1, seq: 1, status: "ready", yaw: 0, air: [0], center: [0, 0, 0], eye: [0, 1, 0], look: [0, 0, 1], ...extra });

function setup() {
  const layer = new EntityLayer({ clock: () => 0 });
  const terrain = new ViewerTerrain(
    () => ({ replaceSection() {}, removeSection() {}, setPose() {}, setPaths() {}, setBreaking() {}, clear: () => layer.clear(), dispose() {} }),
    () => ({ replaceAll: rows => layer.replaceAll(toLayerEntities(rows)) }),
  );
  return { layer, terrain };
}

test("entities persist across batches that carry none and clear on explicit empty list", () => {
  const { layer, terrain } = setup();
  terrain.apply(ready({ entities: [row(1), row(2)] }));
  assert.equal(layer.entityCount, 2);
  terrain.apply(ready({ seq: 2 }));
  assert.equal(layer.entityCount, 2, "missing field means unchanged");
  terrain.apply(ready({ seq: 3, entities: [row(2)] }));
  assert.equal(layer.entityCount, 1, "dropped id is a despawn or pickup");
  terrain.apply(ready({ seq: 4, entities: [] }));
  assert.equal(layer.entityCount, 0);
});

test("reset, new epoch and non-ready status clear entities without replaying them", () => {
  const { layer, terrain } = setup();
  terrain.apply(ready({ entities: [row(1)] }));
  terrain.reset();
  assert.equal(layer.entityCount, 0, "feed disconnect or detach");
  terrain.apply(ready({ entities: [row(1)] }));
  terrain.apply(ready({ epoch: 2, seq: 1 }));
  assert.equal(layer.entityCount, 0, "new epoch starts empty until its own snapshot");
  terrain.apply(ready({ epoch: 2, seq: 2, entities: [row(3)] }));
  terrain.apply({ epoch: 2, seq: 3, status: "waiting" });
  assert.equal(layer.entityCount, 0);
});
