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

test("intervention marker changes independently of pilot paths and break overlays", () => {
  const draws = [];
  let breaking = null;
  const terrain = new ViewerTerrain(() => ({
    setPaths(paths) { draws.push(paths); },
    setBreaking(block) { breaking = block; },
    clear() { draws.push([]); },
  }));
  const path = { name: "practice-path", color: 0x00e5ff, points: [[1, 2, 3], [4, 5, 6]] };
  const block = { position: [1, 1, 2], stage: 5 };
  const point = [3, 4, 5];
  const marker = { name: "intervention", color: 0xff4fd8, points: [point] };
  const frame = { epoch: 1, seq: 1, status: "ready", protocol: 777, yaw: 0 };

  terrain.apply({ ...frame, paths: [path] });
  terrain.setMarker(point);
  assert.deepEqual(draws, []);
  terrain.apply({ ...frame, seq: 2, air: [0] });
  terrain.setBreaking(block);
  assert.deepEqual(draws, [[path, marker]]);
  assert.deepEqual(breaking, block);

  terrain.setMarker([...point]);
  assert.equal(draws.length, 1);
  terrain.setMarker(null);
  assert.deepEqual(draws.at(-1), [path]);
  terrain.setMarker(point);
  assert.deepEqual(draws.at(-1), [path, marker]);

  terrain.apply({ ...frame, epoch: 2, air: [0] });
  assert.deepEqual(draws.at(-1), []);
});
