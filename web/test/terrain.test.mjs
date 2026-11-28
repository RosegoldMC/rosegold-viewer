import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../scripts/load-for-test.mjs";

const { MAX_MISSING_REPORTS, SECTION_VOLUME, Terrain, VERTEX_POSITION_SCALE, VERTEX_STRIDE, VERTEX_UV_SCALE, cellIndex, describeMissingTexture, faceUv } = load("terrain");
const { cameraMatrix, unitLook } = load("camera");
const { lookupModels, lookupTiles, lookupVariants, parseManifest } = load("atlas");

const bytesPerFace = 6 * VERTEX_STRIDE;
const origin = [0, 0, 0];

function section(...cells) {
  const states = new Uint16Array(SECTION_VOLUME);
  for (const [x, y, z, state = 1] of cells) states[x + 16 * z + 256 * y] = state;
  return states;
}

function faceCount(world, position) {
  return (world.mesh(position)?.length ?? 0) / bytesPerFace;
}

function point(vertices, index) {
  const view = new DataView(vertices.buffer, vertices.byteOffset + index, 6);
  return [0, 2, 4].map(offset => view.getInt16(offset, true) / VERTEX_POSITION_SCALE);
}

function tileAt(vertices, index) {
  return [...vertices.subarray(index + 11, index + 13)];
}

function normal(vertices, index) {
  const a = point(vertices, index), b = point(vertices, index + VERTEX_STRIDE), c = point(vertices, index + 2 * VERTEX_STRIDE);
  const [ux, uy, uz] = b.map((value, i) => value - a[i]);
  const [vx, vy, vz] = c.map((value, i) => value - a[i]);
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

test("meshes x-fastest, then z, then y, with outward facing triangles", () => {
  const world = new Terrain([0]);
  const position = [-4, -3, -2];
  world.replaceSection(position, section([2, 3, 5]));
  assert.equal(cellIndex(2, 3, 5), 850);
  const vertices = world.mesh(position);
  assert.equal(VERTEX_POSITION_SCALE, 32);
  assert.equal(VERTEX_STRIDE, 16);
  assert.equal(vertices.length, 6 * bytesPerFace);
  const xyz = [new Set(), new Set(), new Set()];
  for (let i = 0; i < vertices.length; i += VERTEX_STRIDE) {
    point(vertices, i).forEach((value, axis) => xyz[axis].add(value));
    assert.deepEqual([...vertices.subarray(i + 6, i + 9)], [...vertices.subarray(6, 9)]);
  }
  assert.deepEqual(xyz, [new Set([2, 3]), new Set([3, 4]), new Set([5, 6])]);
  const normals = new Set();
  for (let i = 0; i < vertices.length; i += bytesPerFace) {
    const n = normal(vertices, i);
    const centerToFaceVertex = point(vertices, i).map((value, axis) => value - [2.5, 3.5, 5.5][axis]);
    assert.equal(n.reduce((dot, value, axis) => dot + value * centerToFaceVertex[axis], 0), 0.5);
    assert.deepEqual(normal(vertices, i + bytesPerFace / 2), n);
    normals.add(n.join(","));
  }
  assert.equal(normals.size, 6);
});

test("meshes a floor torch with its vanilla bounds, cap UVs, and cutout tile", () => {
  const { lookupModels, lookupTiles, parseManifest } = load("atlas");
  const world = new Terrain([0]);
  const torch = 4926;
  const atlas = parseManifest({ protocol: 777, tileSize: 16, columns: 8, rows: 2,
    blocks: [{ min: torch, max: torch, faces: [12, 12, 12, 12, 12, 12], model: "torch" }],
  });
  world.setTextures({ columns: atlas.columns, modelFor: lookupModels(atlas), tilesFor: lookupTiles(atlas) });
  world.replaceSection(origin, section([0, 0, 0, torch]));
  const mesh = world.mesh(origin);
  assert.equal(mesh.length, 6 * bytesPerFace);
  const positions = [new Set(), new Set(), new Set()];
  const bounds = [];
  for (let start = 0; start < mesh.length; start += bytesPerFace) {
    const us = new Set(), vs = new Set();
    for (let i = start; i < start + bytesPerFace; i += VERTEX_STRIDE) {
      point(mesh, i).forEach((value, axis) => positions[axis].add(value));
      assert.deepEqual(tileAt(mesh, i), [4, 1]);
      assert.equal(mesh[i + 13], 1);
      us.add(mesh[i + 9] * 16 / VERTEX_UV_SCALE);
      vs.add(mesh[i + 10] * 16 / VERTEX_UV_SCALE);
    }
    assert.deepEqual([...us].sort((a, b) => a - b), [7, 9]);
    bounds.push([...vs].sort((a, b) => a - b));
  }
  assert.deepEqual(positions, [new Set([7 / 16, 9 / 16]), new Set([0, 10 / 16]), new Set([7 / 16, 9 / 16])]);
  assert.deepEqual(bounds, [[6, 16], [6, 16], [6, 8], [13, 15], [6, 16], [6, 16]]);
  world.replaceSection([0, -1, 0], section([0, 15, 0]));
  assert.equal(faceCount(world, origin), 5);
});

test("removes shared faces inside a section", () => {
  const world = new Terrain([0]);
  world.replaceSection(origin, section([4, 7, 5, 1], [4, 7, 6, 2]));
  assert.equal(faceCount(world, origin), 10);
});

for (const [axis, name] of ["X", "Y", "Z"].entries()) {
  test(`rebuilds both sides of the ${name} seam across zero`, () => {
    const world = new Terrain([0]);
    const negative = [0, 0, 0];
    negative[axis] = -1;
    const edge = [4, 7, 9];
    const opposingEdge = [...edge];
    edge[axis] = 15;
    opposingEdge[axis] = 0;

    world.replaceSection(negative, section(edge));
    assert.deepEqual(world.takeDirty(), [negative]);
    assert.equal(faceCount(world, negative), 6);
    world.replaceSection(origin, section(opposingEdge));
    assert.deepEqual(world.takeDirty(), [origin, negative]);
    assert.equal(faceCount(world, negative), 5);
    assert.equal(faceCount(world, origin), 5);

    const offEdge = [...opposingEdge];
    offEdge[axis] = 1;
    world.replaceSection(origin, section(offEdge));
    assert.deepEqual(world.takeDirty(), [origin, negative]);
    assert.equal(faceCount(world, negative), 6);
    assert.equal(faceCount(world, origin), 6);

    world.replaceSection(origin, section(opposingEdge));
    assert.equal(faceCount(world, negative), 5);
    world.takeDirty();
    world.replaceSection(origin, null);
    assert.deepEqual(world.takeDirty(), [negative]);
    assert.equal(faceCount(world, negative), 6);
    assert.equal(world.mesh(origin), null);
  });
}

test("identical refresh leaves buffers clean, while a changed section rebuilds the seam", () => {
  const world = new Terrain([0]);
  const neighbor = [-1, 0, 0];
  const loaded = section([0, 5, 6]);
  world.replaceSection(neighbor, section([15, 5, 6]));
  world.replaceSection(origin, loaded);
  assert.equal(faceCount(world, neighbor), 5);
  world.takeDirty();

  world.replaceSection(origin, loaded.slice());
  assert.deepEqual(world.takeDirty(), []);

  world.replaceSection(origin, section([1, 5, 6]));
  assert.deepEqual(world.takeDirty(), [origin, neighbor]);
  assert.equal(faceCount(world, neighbor), 6);
});

test("air-only replacement clears prior mesh and restores the seam", () => {
  const world = new Terrain([13, 40000]);
  const empty = new Uint16Array(SECTION_VOLUME).fill(40000);
  empty[3] = 13;
  const populated = empty.slice();
  populated[cellIndex(0, 2, 3)] = 0;
  const negative = [-1, 0, 0];
  const across = empty.slice();
  across[cellIndex(15, 2, 3)] = 65535;

  world.replaceSection(negative, across);
  world.replaceSection(origin, populated);
  assert.equal(faceCount(world, origin), 5);
  assert.equal(faceCount(world, negative), 5);
  world.takeDirty();
  world.replaceSection(origin, empty);
  assert.deepEqual(world.takeDirty(), [negative]);
  assert.equal(world.mesh(origin), null);
  assert.equal(faceCount(world, negative), 6);
});

test("repeated evictions without a draw leave only live sections dirty", () => {
  const world = new Terrain([0]);
  const populated = section([0, 0, 0]);
  world.replaceSection(origin, populated);
  for (let x = 1; x <= 10_000; x++) {
    const position = [x, 0, 0];
    assert.equal(world.replaceSection(position, populated), true);
    assert.equal(world.replaceSection(position, null), true);
    assert.equal(world.replaceSection(position, null), false);
  }
  const dirty = world.takeDirty();
  assert.equal(dirty.length, 1);
  assert.deepEqual(dirty[0], origin);
});

test("owns submitted arrays and meshes only the latest state in a draw batch", () => {
  const world = new Terrain([0]);
  const position = [-2, 0, 1];
  const first = section([2, 3, 4]);
  const latest = section([5, 6, 7]);
  world.replaceSection(position, first);
  world.replaceSection(position, null);
  world.replaceSection(position, latest);
  latest.fill(0);
  assert.deepEqual(world.takeDirty(), [position]);
  assert.deepEqual(point(world.mesh(position), 0), [6, 6, 7]);
});

test("clear drops terrain and pending updates; context rebuild marks only retained sections", () => {
  const world = new Terrain([0]);
  world.replaceSection(origin, section([0, 0, 0]));
  world.clear();
  world.markAllDirty();
  assert.deepEqual(world.takeDirty(), []);
  assert.equal(world.mesh(origin), null);
  world.replaceSection(origin, section([0, 0, 0]));
  world.takeDirty();
  world.markAllDirty();
  assert.deepEqual(world.takeDirty(), [origin]);
});

test("rejects malformed section data and air IDs", () => {
  const world = new Terrain([0]);
  assert.throws(() => world.replaceSection([1.5, 0, 0], section()), RangeError);
  assert.throws(() => world.replaceSection([2147483648, 0, 0], section()), RangeError);
  assert.throws(() => world.replaceSection(origin, new Uint16Array(4095)), RangeError);
  assert.throws(() => new Terrain([65536]), RangeError);
});

function transform(matrix, point) {
  return [0, 1, 2, 3].map(i => point.reduce((result, value, j) => result + value * matrix[4 * j + i], 0));
}

test("projects Minecraft look forward, including vertical views", () => {
  const south = cameraMatrix(unitLook([0, 0, 2]), 1, 0);
  const east = cameraMatrix(unitLook([2, 0, 0]), 1, 270);
  assert.ok(transform(south, [-1, 0, 3, 1])[0] > 0, "west is right facing south");
  assert.ok(transform(east, [3, 0, 1, 1])[0] > 0, "south is right facing east");
  assert.ok(transform(south, [0, 1, 3, 1])[1] > 0);
  assert.ok(transform(south, [0, 0, -3, 1])[3] < 0);
  for (const sign of [-1, 1]) {
    const upOrDown = cameraMatrix(unitLook([0, sign, 0]), 1, 180);
    assert.ok(upOrDown.every(Number.isFinite));
    const [x, y, z, w] = transform(upOrDown, [0, sign * 3, 0, 1]);
    assert.deepEqual([x, y, w], [0, 0, 3]);
    assert.ok(Math.abs(z) < w);
  }
  assert.throws(() => unitLook([0, 0, 0]), RangeError);
});

test("keeps northern yaw at both Minecraft pitch limits", () => {
  for (const vertical of [-1, 1]) {
    const look = unitLook([-3.82137093032941e-15, vertical, 4.371138828673793e-8]);
    const matrix = cameraMatrix(look, 1, 180);
    const [x, , , w] = transform(matrix, [1, look[1] * 3, 0, 1]);
    assert.ok(x > 0 && w > 0, "east is right when looking north");
  }
});

test("meshes per-face UV corners and tile coordinates, with fallback tiles marked", () => {
  const world = new Terrain([0]);
  world.replaceSection(origin, section([1, 1, 1, 5], [8, 8, 8, 6]));
  world.setTextures({ columns: 4, tilesFor: state => state === 5 ? [0, 1, 6, -1, 7, 11] : undefined });
  const vertices = world.mesh(origin);
  const faces = [];
  for (let i = 0; i < vertices.length; i += 6 * VERTEX_STRIDE) {
    const vertex = vertices.subarray(i, i + VERTEX_STRIDE);
    faces.push([...vertex.subarray(11, 13)]);
    const corners = new Set();
    for (let v = 0; v < 6; v++) corners.add([...vertices.subarray(i + v * VERTEX_STRIDE + 9, i + v * VERTEX_STRIDE + 11)].join());
    assert.deepEqual([...corners].sort(), ["0,0", "0,32", "32,0", "32,32"]);
  }
  assert.deepEqual(faces, [[0, 0], [1, 0], [2, 1], [255, 255], [3, 1], [3, 2], ...Array(6).fill([255, 255])]);
  assert.deepEqual(faceUv(4, 1, 1, 1), [1, 0]);
  assert.deepEqual(faceUv(4, 0, 0, 1), [0, 1]);
  world.setTextures(null);
  assert.deepEqual(world.takeDirty().length, 1);
  assert.equal(world.mesh(origin)[11], 255);
});

test("leaves occlude neither opaque cubes nor other leaves at section seams", () => {
  const world = new Terrain([0]);
  const negative = [-1, 0, 0];
  world.replaceSection(negative, section([15, 4, 5, 2]));
  world.replaceSection(origin, section([0, 4, 5]));
  assert.equal(world.opaqueAt(-1, 4, 5), true);
  world.takeDirty();
  world.setTextures({ columns: 4, tilesFor: () => Array(6).fill(6), modelFor: state => state === 2 ? "leaves" : undefined });
  assert.deepEqual(world.takeDirty(), [negative, origin]);
  assert.equal(world.solidAt(-1, 4, 5), true);
  assert.equal(world.opaqueAt(-1, 4, 5), false);
  assert.equal(world.opaqueAt(0, 4, 5), true);
  assert.equal(world.opaqueAt(0, 5, 5), false);
  assert.equal(world.opaqueAt(16, 4, 5), false);
  assert.equal(faceCount(world, negative), 5);
  assert.equal(faceCount(world, origin), 6);

  world.replaceSection(origin, section([0, 4, 5, 2]));
  assert.equal(faceCount(world, negative), 6);
  assert.equal(faceCount(world, origin), 6);
});

test("cross uses upright double-sided cutout quads without hiding a neighboring cube", () => {
  const endpoints = [[0, 0, 1, 1], [1, 0, 0, 1]];
  const world = new Terrain([0]);
  world.replaceSection(origin, section([15, 15, 15, 2]));
  world.setTextures({ columns: 4, tilesFor: () => [6, 7, 8, 9, 10, 11], modelFor: state => state === 2 ? "cross" : undefined });
  assert.equal(world.solidAt(15, 15, 15), true);
  assert.equal(world.opaqueAt(15, 15, 15), false);
  const vertices = world.mesh(origin);
  assert.equal(vertices.length, endpoints.length * 2 * bytesPerFace);
  for (const [plane, [x1, z1, x2, z2]] of endpoints.entries()) {
    const start = plane * 2 * bytesPerFace;
    const corners = new Set([
      [x1, 0, z1, 0, 32], [x1, 1, z1, 0, 0], [x2, 1, z2, 32, 0], [x2, 0, z2, 32, 32],
    ].map(corner => corner.join()));
    for (const side of [start, start + bytesPerFace]) {
      const found = new Set();
      for (let i = side; i < side + bytesPerFace; i += VERTEX_STRIDE) {
        found.add([...point(vertices, i).map(value => value - 15), ...vertices.subarray(i + 9, i + 11)].join());
        assert.deepEqual(tileAt(vertices, i), [2, 1]);
        assert.equal(vertices[i + 13], 1);
      }
      assert.deepEqual(found, corners);
      const first = normal(vertices, side);
      const second = normal(vertices, side + bytesPerFace / 2);
      assert.ok(first.every((value, axis) => value === second[axis]));
    }
    const front = normal(vertices, start);
    const back = normal(vertices, start + bytesPerFace);
    assert.deepEqual(front.map((value, axis) => value + back[axis]), [0, 0, 0]);
  }
  const across = [1, 0, 0];
  world.replaceSection(across, section([0, 15, 15]));
  assert.equal(faceCount(world, across), 6);
  world.setTextures(null);
  assert.equal(faceCount(world, origin), 5);
  assert.equal(faceCount(world, across), 5);
});

const slab = { corners: [0, -1 / 16, 0, 1, -1 / 16, 0, 1, 0.5, 1, 0, 0.5, 1], uv: [0, 1, 1, 1, 1, 0, 0, 0], face: 4 };
const bottom = { corners: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], uv: [0, 0, 1, 0, 1, 1, 0, 1], face: 3, boundary: 3 };
const side = { corners: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], uv: [0, 1, 1, 1, 1, 0, 0, 0], face: 4, boundary: 4, doubleSided: true };
const quadSource = (model, variant) => {
  quadSource.calls.push([model, variant]);
  return [slab, bottom, side];
};
quadSource.calls = [];
const shaped = model => ({ columns: 4, tilesFor: () => [0, 1, 2, 3, 4, 5], modelFor: state => state === 2 ? model : undefined, variantFor: () => 3 });

test("packs signed fractional positions, uv, tiles and the explicit cutout byte", () => {
  quadSource.calls = [];
  const world = new Terrain([0], quadSource);
  world.replaceSection(origin, section([0, 0, 0, 2]));
  world.setTextures(shaped("rail"));
  const vertices = world.mesh(origin);
  assert.deepEqual(quadSource.calls, [["rail", 3]]);
  assert.equal(vertices.length, (6 + 6 + 12) * VERTEX_STRIDE);
  const view = new DataView(vertices.buffer, vertices.byteOffset);
  assert.equal(view.getInt16(2, true), -2, "y = -1/16 is -2 in 1/32 units");
  assert.deepEqual(point(vertices, 0), [0, -1 / 16, 0]);
  assert.deepEqual(point(vertices, 2 * VERTEX_STRIDE), [1, 0.5, 1]);
  assert.deepEqual([...vertices.subarray(9, 11)], [0, 32]);
  assert.deepEqual(tileAt(vertices, 0), [0, 1]);
  assert.equal(vertices[13], 1, "rail is cutout");
  world.setTextures(shaped("stairs"));
  assert.equal(world.mesh(origin)[13], 0, "stairs are not cutout");
  world.setTextures(shaped("fence"));
  assert.equal(world.mesh(origin)[13], 1, "fence is cutout");
  world.setTextures(shaped("water"));
  assert.equal(world.mesh(origin), null);
  assert.equal(world.mesh(origin, true)[13], 3, "water side uses the flowing sprite");
});

test("legacy and model-less tiles keep a zero cutout byte while glass and leaves set it", () => {
  const world = new Terrain([0]);
  world.replaceSection(origin, section([1, 1, 1, 1]));
  world.setTextures({ columns: 4, tilesFor: () => Array(6).fill(0) });
  const legacy = world.mesh(origin);
  assert.equal(legacy.length, 6 * bytesPerFace);
  for (let i = 0; i < legacy.length; i += VERTEX_STRIDE) assert.equal(legacy[i + 13], 0);
  for (const model of ["glass", "leaves"]) {
    world.setTextures({ columns: 4, tilesFor: () => Array(6).fill(0), modelFor: () => model });
    const cutout = world.mesh(origin);
    assert.equal(cutout.length, 6 * bytesPerFace);
    for (let i = 0; i < cutout.length; i += VERTEX_STRIDE) assert.equal(cutout[i + 13], 1);
  }
});

test("shaped boundary quads cull against opaque neighbors across sections; partial shapes never occlude", () => {
  const world = new Terrain([0], quadSource);
  const south = [0, 0, 1];
  const stairs = { ...shaped("stairs"), modelFor: state => state === 2 ? "stairs" : undefined };
  world.replaceSection(origin, section([15, 4, 15, 2]));
  world.setTextures(stairs);
  assert.equal(world.opaqueAt(15, 4, 15), false);
  assert.equal(world.mesh(origin).length, 24 * VERTEX_STRIDE);
  world.replaceSection(south, section([15, 4, 0, 1]));
  assert.deepEqual(world.takeDirty().length, 2);
  assert.equal(world.mesh(origin).length, 12 * VERTEX_STRIDE, "+z boundary hidden by the next section");
  world.replaceSection(origin, section([15, 4, 15, 2], [15, 3, 15, 1]));
  assert.equal(world.mesh(origin).length, (6 + 36) * VERTEX_STRIDE, "slab remains beside the full stone cube once both boundaries are covered");
  world.replaceSection(origin, section([5, 4, 4, 2], [5, 4, 5, 2], [5, 3, 4, 2]));
  assert.equal(world.mesh(origin).length, 3 * 24 * VERTEX_STRIDE, "partial neighbors do not hide boundaries");
});

test("water culls against opaque cells and itself, and is meshed apart from opaque terrain", () => {
  const world = new Terrain([0]);
  const water = { columns: 4, tilesFor: () => [0, 0, 2, 2, 0, 0], modelFor: state => state === 2 ? "water" : undefined };
  world.replaceSection(origin, section([5, 15, 5, 2]));
  world.setTextures(water);
  assert.equal(world.mesh(origin), null);
  assert.equal(world.mesh(origin, true).length, 6 * bytesPerFace);
  world.replaceSection(origin, section([5, 15, 5, 2], [5, 14, 5, 1]));
  assert.equal(world.mesh(origin, true).length, 5 * bytesPerFace, "opaque below hides the bottom");
  assert.equal(world.mesh(origin).length, 6 * bytesPerFace, "water above a cube does not hide its top");
  world.replaceSection(origin, section([5, 15, 5, 2], [5, 14, 5, 2]));
  assert.equal(world.mesh(origin, true).length, 10 * bytesPerFace, "water above water hides the shared face");
  assert.equal(world.mesh(origin), null);
});

test("glass culls against glass but leaves do not cull leaves", () => {
  const glass = new Terrain([0]);
  glass.replaceSection(origin, section([1, 1, 1, 2], [2, 1, 1, 2]));
  glass.setTextures({ columns: 4, tilesFor: () => Array(6).fill(0), modelFor: () => "glass" });
  assert.equal(faceCount(glass, origin), 10);
  const leaves = new Terrain([0]);
  leaves.replaceSection(origin, section([1, 1, 1, 2], [2, 1, 1, 2]));
  leaves.setTextures({ columns: 4, tilesFor: () => Array(6).fill(0), modelFor: () => "leaves" });
  assert.equal(faceCount(leaves, origin), 12);
});

test("crop emits exactly the shared model quads; non-finite variants are not cached", () => {
  const calls = [];
  const world = new Terrain([0], (model, variant) => { calls.push([model, variant]); return [slab]; });
  world.replaceSection(origin, section([0, 0, 0, 2], [1, 0, 0, 2]));
  let variant = 1;
  world.setTextures({ columns: 4, tilesFor: () => [0, 1, 2, 3, 4, 5], modelFor: () => "crop", variantFor: () => variant });
  assert.equal(world.mesh(origin).length, 12 * VERTEX_STRIDE);
  assert.deepEqual(calls, [["crop", 1]], "cached per model and variant");
  variant = Number.NaN;
  world.mesh(origin);
  world.mesh(origin);
  assert.deepEqual(calls.slice(1), [["crop", 0], ["crop", 0], ["crop", 0], ["crop", 0]]);
});

test("crack cube skips solid-neighbor faces and maps side UVs by axis", () => {
  const { fillCube } = load("terrain");
  const out = new Float32Array(360);
  assert.equal(fillCube(out, [0, 0, 0], [0, 0, 0], 0, 0, () => false), 36);
  const axis = [pos => pos[2], pos => 1 - pos[2], null, null, pos => pos[0], pos => 1 - pos[0]];
  for (const face of [0, 1, 4, 5]) {
    for (let i = 0; i < 6; i++) {
      const o = (face * 6 + i) * 10;
      const pos = out.subarray(o, o + 3);
      assert.equal(out[o + 6], axis[face](pos), `face ${face} u`);
      assert.equal(out[o + 7], 1 - pos[1]);
    }
  }
  const steps = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let f = 0; f < 6; f++) {
    const solid = (x, y, z) => x === steps[f][0] && y === steps[f][1] && z === steps[f][2];
    const emitted = new Float32Array(360);
    assert.equal(fillCube(emitted, [0, 0, 0], [0, 0, 0], 0, 0, solid), 30);
  }
  assert.equal(fillCube(out, [0, 0, 0], [0, 0, 0], 0, 0, () => true), 0);
});

test("reports missing block textures once per state and reason across remeshes", () => {
  const reports = [];
  const world = new Terrain([0], undefined, missing => reports.push(missing));
  const position = [0, 0, 0];
  world.replaceSection(position, section([1, 1, 1, 5], [5, 5, 5, 6], [9, 9, 9, 7], [12, 12, 12, 8]));
  world.mesh(position);
  assert.deepEqual(reports, [], "no report without textures");
  const tiles = new Map([[6, [0, 1, 2, 3, 4, 5]], [7, [0, 1, 2, -1, 4, 5]], [8, [0, 1, 2, 3, 4, 5]]]);
  world.setTextures({ columns: 4, tilesFor: state => tiles.get(state), modelFor: () => undefined, nameFor: state => state === 5 ? "minecraft:test_block" : undefined });
  for (let pass = 0; pass < 3; pass++) {
    world.mesh(position);
    world.replaceSection(position, section([1, 1, 1, 5], [5, 5, 5, 6], [9, 9, 9, 7], [12, 12, 12, 8], [0, 0, 0, 5]));
  }
  assert.deepEqual(reports.map(({ state, name, reason, faces }) => ({ state, name, reason, faces })), [
    { state: 5, name: "minecraft:test_block", reason: "no-atlas-entry", faces: [0] },
    { state: 7, name: undefined, reason: "face-without-tile", faces: [3] },
  ]);
  assert.match(describeMissingTexture(reports[0]), /minecraft:test_block state 5 is unresolved in the built atlas/);
  const same = { columns: 4, tilesFor: () => undefined };
  world.setTextures(same);
  world.mesh(position);
  const count = reports.length;
  world.setTextures(null);
  world.setTextures(same);
  world.mesh(position);
  assert.equal(reports.length, count, "same atlas reattached does not repeat");
});

test("does not report air, culled faces, or untextured meshes", () => {
  const reports = [];
  const world = new Terrain([0], undefined, missing => reports.push(missing));
  const position = [0, 0, 0];
  const cells = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) cells.push([x, y, z, 7]);
  world.replaceSection(position, section(...cells));
  world.setTextures({ columns: 4, tilesFor: state => state === 7 ? [0, 1, 2, 3, 4, 5] : undefined });
  world.mesh(position);
  assert.deepEqual(reports, []);
  world.replaceSection(position, section([2, 2, 2, 9]));
  world.mesh(position);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].state, 9);
});

test("reports every registered state, and caps only unregistered IDs", () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  try {
    const run = registered => {
      const reports = [];
      const world = new Terrain([0], undefined, missing => reports.push(missing));
      world.setTextures({ columns: 4, tilesFor: () => undefined, registered });
      for (let base = 1; base < 1200; base += 16) {
        const position = [0, 0, 0];
        world.replaceSection(position, section(...Array.from({ length: 16 }, (_, i) => [i, 0, 0, base + i])));
        world.mesh(position);
      }
      return reports;
    };
    assert.equal(run(undefined).length, 1200);
    assert.equal(run(() => true).length, 1200);
    assert.equal(warnings.length, 0);
    assert.equal(run(() => false).length, MAX_MISSING_REPORTS);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = warn;
  }
});

test("skips intentionally invisible states but still draws them", () => {
  const reports = [];
  const world = new Terrain([0], undefined, missing => reports.push(missing));
  world.setTextures({ columns: 4, tilesFor: () => undefined, invisibleFor: state => state === 3 });
  const position = [0, 0, 0];
  world.replaceSection(position, section([1, 1, 1, 3], [5, 5, 5, 4]));
  assert.equal(faceCount(world, position), 12);
  assert.deepEqual(reports.map(({ state }) => state), [4]);
});


test("uses loaded geometry, cutout material and bound tiles and forgets them when the atlas is replaced", () => {
  const world = new Terrain([0]);
  world.replaceSection(origin, section([0, 0, 0, 4], [2, 0, 0, 5]));
  const manifest = parseManifest({ protocol: 777, tileSize: 16, columns: 2, rows: 1,
    blocks: [{ min: 4, max: 4, model: "mesh", variant: 0, faces: [0, 0, 0, 0, 1, 0] },
      { min: 5, max: 5, model: "mesh", variant: 1, faces: Array(6).fill(-1) }],
    models: { quads: [[[0, 0.25, 1, 0, 0, 1, 1, 0, 1, 1, 0.25, 1], [0, 0, 0, 1, 1, 1, 1, 0], 4, 4]],
      variants: [[true, [0]], [false, []]] },
  });
  world.setTextures({ columns: manifest.columns, meshes: manifest.meshes, tilesFor: lookupTiles(manifest),
    modelFor: lookupModels(manifest), variantFor: lookupVariants(manifest) });
  const mesh = world.mesh(origin);
  assert.equal(mesh.length, bytesPerFace);
  assert.deepEqual(point(mesh, 0), [0, 0.25, 1]);
  assert.deepEqual(tileAt(mesh, 0), [1, 0]);
  assert.equal(mesh[13], 1);
  assert.equal(world.opaqueAt(0, 0, 0), false);
  world.replaceSection(origin, section([0, 0, 0, 4], [0, 0, 1, 6], [2, 0, 0, 5]));
  assert.equal(faceCount(world, origin), 6, "opaque neighbor culls the bound quad but still draws its own face");
  world.setTextures(null);
  assert.equal(faceCount(world, origin), 16);
});

const SHADE_OFFSET = 14;
const brightness = (vertices, index) => 1 - vertices[index + SHADE_OFFSET] / 255;
const faceOf = n => {
  const axis = n.findIndex(value => value !== 0);
  return axis * 2 + (n[axis] > 0 ? 0 : 1);
};

test("opaque cube faces carry directional shade and ignore the base color", () => {
  const world = new Terrain([0]);
  world.replaceSection(origin, section([4, 4, 4]));
  const vertices = world.mesh(origin);
  const expected = [0.6, 0.6, 1, 0.5, 0.8, 0.8];
  const seen = new Set();
  for (let i = 0; i < vertices.length; i += bytesPerFace) {
    const face = faceOf(normal(vertices, i));
    seen.add(face);
    for (let v = 0; v < 6; v++) {
      assert.ok(Math.abs(brightness(vertices, i + v * VERTEX_STRIDE) - expected[face]) < 1 / 255);
      assert.equal(vertices[i + v * VERTEX_STRIDE + SHADE_OFFSET + 1], 0);
    }
  }
  assert.equal(seen.size, 6);
});

test("model quads shade by outward geometry, including rotated stairs; crossed planes stay unshaded", () => {
  const world = new Terrain([0]);
  world.replaceSection(origin, section([0, 0, 0, 2]));
  for (const model of ["stairs", "fence"]) {
    world.setTextures({ columns: 4, tilesFor: () => [0, 1, 2, 3, 4, 5], modelFor: () => model, variantFor: () => 3 });
    const vertices = world.mesh(origin);
    assert.ok(vertices, model);
    for (let i = 0; i < vertices.length; i += 6 * VERTEX_STRIDE) {
      const n = normal(vertices, i);
      const face = faceOf(n);
      assert.ok(Math.abs(brightness(vertices, i) - [0.6, 0.6, 1, 0.5, 0.8, 0.8][face]) < 1 / 255, `${model} face ${face}`);
    }
  }
  world.setTextures({ columns: 4, tilesFor: () => [0, 0, 0, 0, 0, 0], modelFor: () => "cross" });
  const cross = world.mesh(origin);
  for (let i = 0; i < cross.length; i += VERTEX_STRIDE) assert.equal(cross[i + SHADE_OFFSET], 0);
});

test("shading leaves tile, cutout and liquid material bytes unchanged and covers water faces", () => {
  const world = new Terrain([0]);
  world.replaceSection(origin, section([0, 0, 0, 100]));
  world.setTextures({ columns: 4, tilesFor: () => [1, 1, 0, 0, 1, 1], modelFor: () => "water", variantFor: () => 0 });
  const vertices = world.mesh(origin, true);
  const tops = [], sides = [];
  for (let i = 0; i < vertices.length; i += bytesPerFace) {
    const face = faceOf(normal(vertices, i));
    (face === 2 ? tops : sides).push([face, brightness(vertices, i)]);
    assert.ok(vertices[i + 13] >= 2, "liquid material byte preserved");
  }
  assert.ok(tops.every(([, b]) => b === 1));
  assert.ok(sides.every(([face, b]) => Math.abs(b - [0.6, 0.6, 0, 0.5, 0.8, 0.8][face]) < 1 / 255));
});
