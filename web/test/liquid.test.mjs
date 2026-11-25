import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../scripts/load-for-test.mjs";

const { parseManifest } = load("atlas");
const { Terrain, VERTEX_POSITION_SCALE, VERTEX_STRIDE, VERTEX_UV_SCALE, cellIndex } = load("terrain");

const origin = [0, 0, 0];
const water = 100, lava = 200;
const modelFor = state => state >= water && state < water + 16 ? "water" :
  state >= lava && state < lava + 16 ? "lava" : undefined;
const tiles = { water: [1, 1, 0, 0, 1, 1], lava: [3, 3, 2, 2, 3, 3] };

function terrain() {
  const result = new Terrain([0]);
  result.setTextures({ columns: 4, modelFor, tilesFor: state => tiles[modelFor(state)], variantFor: state => state % 100 });
  return result;
}

function section(...cells) {
  const states = new Uint16Array(4096);
  for (const [x, y, z, state] of cells) states[cellIndex(x, y, z)] = state;
  return states;
}

function quads(world, position, waterOnly) {
  const packed = world.mesh(position, waterOnly);
  if (!packed) return [];
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const result = [];
  for (let i = 0; i < packed.length; i += VERTEX_STRIDE * 6) {
    const corners = [0, 1, 2, 5].map(n => [0, 2, 4, 9, 10].map((byte, j) => {
      const offset = i + n * VERTEX_STRIDE + byte;
      return j < 3 ? 16 * position[j] + view.getInt16(offset, true) / VERTEX_POSITION_SCALE : packed[offset];
    }));
    const [a, b, c] = corners;
    const [ux, uy, uz] = b.map((v, axis) => v - a[axis]);
    const [vx, vy, vz] = c.map((v, axis) => v - a[axis]);
    result.push({ corners, normal: [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx],
      tile: packed[i + 11] + 4 * packed[i + 12], material: packed[i + 13] });
  }
  return result;
}

const tops = (world, position = origin, waterOnly = true) => quads(world, position, waterOnly).filter(quad => quad.normal[1] > 0);
const edge = (quad, axis, coordinate) => quad.corners.filter(v => v[axis] === coordinate);
const average = values => values.reduce((a, b) => a + b, 0) / values.length;

for (const [kind, source, still, flow] of [["water", water, 0, 1], ["lava", lava, 2, 3]]) {
  const waterOnly = kind === "water";
  test(`${kind} lowers successive levels and stitches neighboring top edges without an internal wall`, () => {
    const world = terrain();
    world.replaceSection(origin, section([4, 8, 8, source], [5, 8, 8, source + 2], [6, 8, 8, source + 5]));
    const top = tops(world, origin, waterOnly);
    assert.equal(top.length, 3);
    assert.deepEqual(top.map(q => q.tile), [flow, flow, flow]);
    const elevations = top.map(q => average(q.corners.map(([, y]) => y)));
    assert.ok(elevations[0] > elevations[1] && elevations[1] > elevations[2]);
    for (const [sharedX, i] of [[5, 0], [6, 1]]) {
      const heights = q => edge(q, 0, sharedX).map(([, y]) => y).sort();
      assert.deepEqual(heights(top[i]), heights(top[i + 1]));
      assert.equal(quads(world, origin, waterOnly).some(q => q.corners.every(([x]) => x === sharedX)), false);
    }
    for (const q of top) {
      const westV = average(edge(q, 0, q.corners[0][0]).map(v => v[4]));
      const eastV = average(edge(q, 0, q.corners[0][0] + 1).map(v => v[4]));
      assert.equal(eastV - westV, VERTEX_UV_SCALE, "eastward flowing top spans all 16 texels in the crop");
    }
    assert.equal(world.mesh(origin, !waterOnly), null);

    world.replaceSection(origin, section([4, 8, 8, source]));
    assert.equal(tops(world, origin, waterOnly)[0].tile, still);
    const faces = quads(world, origin, waterOnly);
    assert.deepEqual(faces.map(q => q.tile), [flow, flow, still, still, flow, flow]);
    for (const side of faces.filter(q => q.normal[1] === 0)) {
      assert.deepEqual([...new Set(side.corners.map(v => v[3]))].sort((a, b) => a - b), [0, VERTEX_UV_SCALE]);
      for (const [, y, , , v] of side.corners) assert.equal(v, Math.round((9 - y) * VERTEX_UV_SCALE));
    }
    world.replaceSection(origin, section([4, 8, 8, source + 15]));
    const [falling] = tops(world, origin, waterOnly);
    assert.equal(falling.tile, still, "horizontal flow is zero even though the cell falls");
    assert.ok(falling.corners.every(([, y]) => y >= 8.75), "falling levels keep near-full height");
  });

  test(`${kind} keeps a sub-full top below solid cover across a vertical section boundary`, () => {
    const world = terrain();
    const above = [0, 1, 0];
    world.replaceSection(origin, section([4, 15, 8, source + 5]));
    world.replaceSection(above, section([4, 0, 8, 1]));
    const centerTop = () => tops(world, origin, waterOnly).find(q => q.corners.every(([x]) => x >= 4 && x <= 5));
    const top = centerTop();
    assert.ok(top.corners.every(([, y]) => y > 15 && y < 16), "there is a visible gap below the cover");
    world.replaceSection(origin, section([3, 15, 8, source], [4, 15, 8, source + 5], [5, 15, 8, source]));
    world.replaceSection(above, section([3, 0, 8, source], [4, 0, 8, 1], [5, 0, 8, source]));
    assert.equal(centerTop(), undefined, "neighboring columns raise all corners flush with the cover");
  });
}

test("downhill continuation rotates flow UVs instead of treating air as still water", () => {
  const world = terrain();
  world.replaceSection(origin, section([4, 8, 8, water], [4, 7, 7, water + 8]));
  const [source] = tops(world).filter(q => q.corners[0][1] > 8);
  assert.equal(source.tile, 1);
  assert.ok(average(edge(source, 2, 8).map(v => v[4])) > average(edge(source, 2, 9).map(v => v[4])));
});

test("diagonal flow preserves one cropped tile per block while keeping packed UVs unsigned", () => {
  const world = terrain();
  world.replaceSection(origin, section([4, 8, 8, water], [5, 8, 8, water + 4], [4, 8, 9, water + 4]));
  const [top] = tops(world);
  const uv = q => q.slice(3);
  const [start, end] = top.corners.map(uv);
  const width = Math.hypot(end[0] - start[0], end[1] - start[1]);
  assert.ok(Math.abs(width - VERTEX_UV_SCALE) < 1);
  const coordinates = top.corners.flatMap(uv);
  assert.ok(Math.min(...coordinates) > 0 && Math.min(...coordinates) < VERTEX_UV_SCALE);
  assert.ok(Math.max(...coordinates) > 2 * VERTEX_UV_SCALE);
});

test("corner follows load, change, and removal across three section axes", () => {
  const world = terrain();
  const home = [-1, -1, -1], east = [0, -1, -1], diagonal = [0, -1, 0], above = [0, 0, 0];
  world.replaceSection(home, section([15, 15, 15, water]));
  world.replaceSection(east, section([0, 15, 15, water + 4]));
  world.takeDirty();
  const sharedHeight = pos => tops(world, pos)[0].corners.find(([x, , z]) => x === 0 && z === 0)[1];
  const lower = sharedHeight(home);
  assert.equal(sharedHeight(east), lower);
  world.replaceSection(diagonal, section([0, 15, 0, water]));
  assert.ok(world.takeDirty().some(p => p.join() === home.join()));
  const raised = sharedHeight(home);
  assert.ok(raised > lower);
  assert.equal(sharedHeight(east), raised);
  world.replaceSection(diagonal, section([0, 15, 0, water], [7, 7, 7, 1]));
  assert.ok(!world.takeDirty().some(p => p.join() === home.join()), "an interior edit does not dirty the diagonal");
  world.replaceSection(above, section([0, 0, 0, water + 8]));
  assert.ok(world.takeDirty().some(p => p.join() === home.join()));
  assert.equal(sharedHeight(home), 0);
  assert.equal(sharedHeight(east), 0);
  assert.equal(tops(world, diagonal).length, 0, "same fluid above hides the shared surface");
  world.replaceSection(above, section([0, 0, 0, lava + 8]));
  assert.ok(world.takeDirty().some(p => p.join() === home.join()));
  assert.equal(sharedHeight(home), raised, "different fluid above does not fill the corner");
  world.replaceSection(diagonal, null);
  assert.ok(world.takeDirty().some(p => p.join() === home.join()));
  assert.equal(sharedHeight(home), lower);
});

test("liquid animation metadata validates each sprite independently and honors tile and timing bounds", () => {
  const manifest = { protocol: 777, tileSize: 16, columns: 2, rows: 3, blocks: [] };
  const waterStill = [[0, 2], [3, 1], [0, 5]];
  const parsed = parseManifest({ ...manifest, animations: {
    waterStill, waterFlow: [[1, 5], [6, 1]], lavaStill: [[2, 0], [3, 1]], lavaFlow: [[4, 1]], other: [[0, 1], [1, 1]],
  } });
  assert.deepEqual(parsed.animations, { waterStill });
  for (const bad of [null, [], { waterStill: Array(257).fill([0, 1]) }, { waterStill: [[0, 1201], [1, 1]] }]) {
    assert.equal(parseManifest({ ...manifest, animations: bad }).animations, undefined);
  }
});
