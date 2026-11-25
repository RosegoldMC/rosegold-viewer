import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../scripts/load-for-test.mjs";

const { modelQuads } = load("block-models");

const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const vertices = quad => [0, 3, 6, 9].map(i => quad.corners.slice(i, i + 3));
const params = quad => [0, 2, 4, 6].map(i => quad.uv.slice(i, i + 2));
const dot = (a, b) => a.reduce((total, value, axis) => total + value * b[axis], 0);
const minMax = (quad, axis) => {
  const values = vertices(quad).map(v => v[axis]);
  return [Math.min(...values), Math.max(...values)];
};

function normal([a, b, c]) {
  const [ux, uy, uz] = b.map((value, i) => value - a[i]);
  const [vx, vy, vz] = c.map((value, i) => value - a[i]);
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function direction(quad) {
  const n = normal(vertices(quad));
  return directions.findIndex(step => dot(n, step) > 0);
}

test("bounded variants reuse quads on the 1/32 grid with consistent triangles", () => {
  for (const [model, count] of Object.entries({ crop: 1, fence: 16, composter: 9, lantern: 2, rail: 10, stairs: 40 })) {
    assert.deepEqual(modelQuads(model, count), []);
    assert.deepEqual(modelQuads(model, -1), []);
    assert.deepEqual(modelQuads(model, 0.5), []);
    for (let i = 0; i < count; i++) {
      const quads = modelQuads(model, i);
      assert.ok(quads.length);
      assert.equal(quads, modelQuads(model, i));
      for (const quad of quads) {
        const [a, b, c, d] = vertices(quad);
        assert.equal(quad.corners.length, 12);
        assert.equal(quad.uv.length, 8);
        assert.ok([...quad.corners, ...quad.uv].every(value => Number.isInteger(32 * value)));
        assert.ok(quad.uv.every(value => value >= 0 && value <= 1));
        assert.ok(quad.face >= 0 && quad.face < directions.length);
        assert.ok(dot(normal([a, b, c]), normal([a, c, d])) > 0);
        if (model !== "composter") assert.ok(dot(normal([a, b, c]), directions[quad.face]) > 0);
      }
    }
  }
  for (const model of ["", "cross", "leaves", "cube", "__proto__"]) assert.deepEqual(modelQuads(model, 0), []);
});

test("crop follows the pack's six planes, half-pixel margins, and mirrored face UV rectangles", () => {
  const crop = modelQuads("crop", 0);
  assert.equal(crop.length, 12);
  for (const [axis, negative, positive] of [[0, 1, 0], [2, 5, 4]]) {
    for (const position of [3, 8, 13]) {
      const matches = crop.filter(quad => minMax(quad, axis).every(value => value === position / 16));
      assert.deepEqual(matches.map(quad => quad.face), [negative, positive]);
      for (const quad of matches) {
        assert.deepEqual(minMax(quad, 1), [-1 / 16, 15 / 16]);
        assert.deepEqual(minMax(quad, 2 - axis), [1 / 32, 31 / 32]);
        const mirrored = (position === 3) === (quad.face === positive);
        const [left, right] = mirrored ? [15 / 16, 0] : [0, 15 / 16];
        assert.deepEqual(params(quad), [[left, 0], [left, 1], [right, 1], [right, 0]]);
        assert.equal(quad.boundary, undefined);
        assert.ok(!quad.doubleSided);
      }
    }
  }
});

test("fence connection bits rotate north slats and their cull faces", () => {
  const post = modelQuads("fence", 0);
  assert.deepEqual(minMax(post[2], 0), [6 / 16, 10 / 16]);
  for (const [variant, boundary, axis, edge] of [[1, 5, 2, 0], [2, 0, 0, 1], [4, 4, 2, 1], [8, 1, 0, 0]]) {
    const slats = modelQuads("fence", variant).slice(post.length);
    assert.equal(slats.length, 10);
    assert.deepEqual(slats.filter(quad => quad.boundary === boundary).map(quad => minMax(quad, 1)),
      [[12 / 16, 15 / 16], [6 / 16, 9 / 16]]);
    assert.ok(slats.filter(quad => quad.boundary !== undefined).every(quad =>
      quad.boundary === boundary && minMax(quad, axis).every(value => value === edge)));
  }
  assert.equal(modelQuads("fence", 15).length, post.length + 40);
});

test("composter has a hollow rim and uses the fill tile only for contents", () => {
  for (const [level, height] of [2, 3, 5, 7, 9, 11, 13, 15, 15].entries()) {
    const quads = modelQuads("composter", level);
    const up = quads.filter(quad => direction(quad) === 2);
    assert.equal(up.length, 5);
    assert.equal(up.filter(quad => quad.face === 2 && quad.boundary === 2).length, 4);
    const inside = up.find(quad => quad.boundary === undefined);
    assert.equal(inside.face, level === 0 ? 3 : 1);
    assert.deepEqual(quads.filter(quad => quad.face === 1), level === 0 ? [] : [inside]);
    assert.deepEqual(minMax(inside, 1), [height / 16, height / 16]);
    for (const axis of [0, 2]) assert.deepEqual(minMax(inside, axis), [2 / 16, 14 / 16]);
    const walls = quads.filter(quad => quad.boundary === undefined && direction(quad) !== 2);
    assert.equal(walls.length, 4);
    assert.ok(walls.every(quad => minMax(quad, 1)[0] === height / 16));
    assert.ok(walls.every(quad => [0, 4, 5].includes(quad.face)));
  }
});

test("hanging lantern lifts the body and extends crossed chain to the ceiling", () => {
  for (const hanging of [0, 1]) {
    const lantern = modelQuads("lantern", hanging);
    const bottom = lantern.find(quad => quad.face === 3);
    assert.deepEqual(minMax(bottom, 1), [hanging / 16, hanging / 16]);
    assert.deepEqual(params(bottom), [[0, 9 / 16], [0, 15 / 16], [6 / 16, 15 / 16], [6 / 16, 9 / 16]]);
    assert.deepEqual(minMax(bottom, 0), [5 / 16, 11 / 16]);
    const chain = lantern.filter(quad => minMax(quad, 1)[0] >= (9 + hanging) / 16 && quad.face !== 2);
    assert.equal(chain.length, 4);
    assert.ok(chain.every(quad => directions.filter(step => dot(normal(vertices(quad)), step) > 0).length === 2));
    assert.equal(Math.max(...chain.map(quad => minMax(quad, 1)[1])), hanging ? 1 : 11 / 16);
  }
});

test("rail rotates authored UVs and puts its high edge in the ascending direction", () => {
  const names = ["north_south", "east_west", "ascending_east", "ascending_west", "ascending_north", "ascending_south",
    "south_east", "south_west", "north_west", "north_east"];
  const expectedUvOrigins = [[0, 0], [1, 0], [1, 0], [0, 1], [0, 0], [1, 1], [0, 0], [1, 0], [1, 1], [0, 1]];
  for (const [variant, name] of names.entries()) {
    const [quad] = modelQuads("rail", variant);
    assert.equal(quad.face, 2, name);
    assert.ok(quad.doubleSided, name);
    const [origin] = vertices(quad);
    assert.deepEqual([origin[0], origin[2]], expectedUvOrigins[variant], name);
    assert.deepEqual(params(quad), [[0, 0], [0, 1], [1, 1], [1, 0]], name);
    if (name.startsWith("ascending")) {
      assert.deepEqual(minMax(quad, 1), [1 / 32, 33 / 32]);
      const raised = vertices(quad).filter(v => v[1] > 1);
      const [axis, edge] = [[0, 1], [0, 0], [2, 0], [2, 1]][variant - 2];
      assert.equal(raised.length, 2);
      assert.ok(raised.every(v => v[axis] === edge), name);
    } else assert.deepEqual(minMax(quad, 1), [1 / 32, 1 / 32]);
  }
});

test("stairs expose only the expected half-cell surfaces in both halves and every rotation", () => {
  const straight = [[0, 1], [2, 3], [0, 2], [1, 3]];
  const innerLeft = [[0, 1, 2], [1, 2, 3], [0, 2, 3], [0, 1, 3]];
  const innerRight = [[0, 1, 3], [0, 2, 3], [0, 1, 2], [1, 2, 3]];
  const outerLeft = [[0], [3], [2], [1]];
  const outerRight = [[1], [2], [0], [3]];
  for (const [shape, quadrants] of [straight, innerLeft, innerRight, outerLeft, outerRight].entries()) {
    for (const [facing, raised] of quadrants.entries()) for (const top of [0, 1]) {
      const occupied = ([x, y, z]) => [x, y, z].every(v => v > 0 && v < 1)
        && ((y > 0.5) === Boolean(top) || raised.includes(Number(x > 0.5) + 2 * Number(z > 0.5)));
      const quads = modelQuads("stairs", facing + 4 * top + 8 * shape);
      for (const quad of quads) {
        const center = [0, 1, 2].map(axis => minMax(quad, axis).reduce((a, b) => (a + b) / 2));
        const normal = directions[quad.face];
        assert.ok(occupied(center.map((v, axis) => v - normal[axis] / 4)));
        assert.ok(!occupied(center.map((v, axis) => v + normal[axis] / 4)));
        const axis = quad.face >> 1;
        assert.equal(quad.boundary, center[axis] === (quad.face % 2 ? 0 : 1) ? quad.face : undefined);
      }
      const face = top ? 3 : 2, surfaceY = top ? 0 : 1;
      const extremeQuads = quads.filter(quad => quad.face === face && minMax(quad, 1)[0] === surfaceY);
      assert.deepEqual(extremeQuads.map(quad => 2 * minMax(quad, 0)[0] + 4 * minMax(quad, 2)[0]).sort(), raised);
    }
  }
});
