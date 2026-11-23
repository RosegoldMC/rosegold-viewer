import assert from "node:assert/strict";
import test from "node:test";
import { SECTION_VOLUME, Terrain, VERTEX_STRIDE, cellIndex } from "../dist/terrain.js";
import { cameraMatrix, unitLook } from "../dist/camera.js";

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

function normal(vertices, index) {
  const point = v => [...vertices.subarray(index + v * VERTEX_STRIDE, index + v * VERTEX_STRIDE + 3)];
  const a = point(0), b = point(1), c = point(2);
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
  assert.equal(vertices.length, 6 * bytesPerFace);
  const xyz = [new Set(), new Set(), new Set()];
  for (let i = 0; i < vertices.length; i += VERTEX_STRIDE) {
    xyz.forEach((values, axis) => values.add(vertices[i + axis]));
    assert.deepEqual([...vertices.subarray(i + 3, i + 6)], [...vertices.subarray(3, 6)]);
  }
  assert.deepEqual(xyz, [new Set([2, 3]), new Set([3, 4]), new Set([5, 6])]);
  const normals = new Set();
  for (let i = 0; i < vertices.length; i += bytesPerFace) {
    const n = normal(vertices, i);
    const centerToFaceVertex = [2.5, 3.5, 5.5].map((value, axis) => vertices[i + axis] - value);
    assert.equal(n.reduce((dot, value, axis) => dot + value * centerToFaceVertex[axis], 0), 0.5);
    assert.deepEqual(normal(vertices, i + bytesPerFace / 2), n);
    normals.add(n.join(","));
  }
  assert.equal(normals.size, 6);
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
  assert.deepEqual([...world.mesh(position).subarray(0, 3)], [6, 6, 7]);
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
