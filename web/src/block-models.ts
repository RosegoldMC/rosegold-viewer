export interface ModelQuad {
  corners: readonly number[];
  uv: readonly number[];
  face: number;
  boundary?: number;
  doubleSided?: boolean;
}

type Point = readonly [x: number, y: number, z: number];
type UvRect = readonly [u0: number, v0: number, u1: number, v1: number];

const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
const clockwise = [4, 5, 2, 3, 1, 0];

function projectedUv(face: number, [x, y, z]: Point): readonly [number, number] {
  switch (face) {
    case 0: return [16 - z, 16 - y];
    case 1: return [z, 16 - y];
    case 2: return [x, z];
    case 3: return [x, 16 - z];
    case 4: return [x, 16 - y];
    default: return [16 - x, 16 - y];
  }
}

function plane(
  face: number, [x, y, z]: Point, [X, Y, Z]: Point, rect?: UvRect, tile = face,
): ModelQuad {
  const faceCorners: Point[][] = [
    [[X, Y, Z], [X, y, Z], [X, y, z], [X, Y, z]],
    [[x, Y, z], [x, y, z], [x, y, Z], [x, Y, Z]],
    [[x, Y, z], [x, Y, Z], [X, Y, Z], [X, Y, z]],
    [[x, y, Z], [x, y, z], [X, y, z], [X, y, Z]],
    [[x, Y, Z], [x, y, Z], [X, y, Z], [X, Y, Z]],
    [[X, Y, z], [X, y, z], [x, y, z], [x, Y, z]],
  ];
  const corners = faceCorners[face];
  const uv = rect ? [rect[0], rect[1], rect[0], rect[3], rect[2], rect[3], rect[2], rect[1]]
    : corners.flatMap(point => projectedUv(face, point));
  const axis = face >> 1;
  const boundary = corners[0][axis] === (face % 2 ? 0 : 16) ? face : undefined;
  return { corners: corners.flat().map(value => value / 16), uv: uv.map(value => value / 16), face: tile, boundary };
}

function rotate(quad: ModelQuad, turns: number): ModelQuad {
  for (let turn = 0; turn < turns; turn++) {
    const corners = [...quad.corners];
    for (let i = 0; i < corners.length; i += 3) {
      [corners[i], corners[i + 2]] = [1 - corners[i + 2], corners[i]];
    }
    const boundary = quad.boundary === undefined ? undefined : clockwise[quad.boundary];
    quad = { ...quad, corners, face: clockwise[quad.face], boundary };
  }
  return quad;
}

function crop(): ModelQuad[] {
  const result: ModelQuad[] = [];
  const forward: UvRect = [0, 0, 15, 16];
  const reverse: UvRect = [15, 0, 0, 16];
  for (const at of [3, 13, 8]) {
    result.push(plane(1, [at, -1, 0.5], [at, 15, 15.5], at === 3 ? forward : reverse));
    result.push(plane(0, [at, -1, 0.5], [at, 15, 15.5], at === 3 ? reverse : forward));
  }
  for (const at of [3, 13, 8]) {
    result.push(plane(5, [0.5, -1, at], [15.5, 15, at], at === 3 ? forward : reverse));
    result.push(plane(4, [0.5, -1, at], [15.5, 15, at], at === 3 ? reverse : forward));
  }
  return result;
}

function fence(connections: number): ModelQuad[] {
  const result = directions.map((_, face) => plane(face, [6, 0, 6], [10, 16, 10],
    face === 2 || face === 3 ? [4, 0, 8, 4] : [0, 0, 4, 16]));
  for (let turn = 0; turn < 4; turn++) {
    if ((connections & (1 << turn)) === 0) continue;
    for (const [y, v, u] of [[12, 0, 4], [6, 3, 6]]) {
      const from: Point = [7, y, 0], to: Point = [9, y + 3, 6];
      const northSlat = [
        plane(0, from, to, [14, v, 8, v + 3]), plane(1, from, to, [8, v, 14, v + 3]),
        plane(2, from, to, [u, 4, u + 2, 10]), plane(3, from, to, [u, 10, u + 2, 4]),
        plane(5, from, to, [14, v, 16, v + 3]),
      ];
      result.push(...northSlat.map(quad => rotate(quad, turn)));
    }
  }
  return result;
}

function composter(level: number): ModelQuad[] {
  const fill = level === 0 ? 2 : Math.min(2 * level + 1, 15);
  return [
    plane(0, [0, 0, 0], [16, 16, 16]), plane(1, [0, 0, 0], [16, 16, 16], undefined, 0),
    plane(4, [0, 0, 0], [16, 16, 16]), plane(5, [0, 0, 0], [16, 16, 16]),
    plane(3, [0, 0, 0], [16, 16, 16]),
    plane(2, [0, 0, 0], [2, 16, 16]), plane(2, [14, 0, 0], [16, 16, 16]),
    plane(2, [2, 0, 0], [14, 16, 2]), plane(2, [2, 0, 14], [14, 16, 16]),
    plane(0, [2, fill, 2], [2, 16, 14]), plane(1, [14, fill, 2], [14, 16, 14], undefined, 0),
    plane(4, [2, fill, 2], [14, 16, 2]), plane(5, [2, fill, 14], [14, 16, 14]),
    plane(2, [2, fill, 2], [14, fill, 14], undefined, level === 0 ? 3 : 1),
  ];
}

function lantern(hanging: number): ModelQuad[] {
  const result = directions.map((_, face) => plane(face, [5, hanging, 5], [11, 7 + hanging, 11],
    face === 2 || face === 3 ? [0, 9, 6, 15] : [0, 2, 6, 9]));
  const cap = [0, 1, 2, 4, 5].map(face => plane(face, [6, 7 + hanging, 6], [10, 9 + hanging, 10],
    face === 2 ? [1, 10, 5, 14] : [1, 0, 5, 2]));
  const a0 = hanging ? 11 : 9, a1 = hanging ? 15 : 11;
  const b0 = hanging ? 10 : 9, b1 = hanging ? 16 : 11;
  const aV = hanging ? 5 : 3, bV = hanging ? 6 : 10;
  const handle = [
    plane(4, [6.5, a0, 8], [9.5, a1, 8], [11, 1, 14, aV]),
    plane(5, [6.5, a0, 8], [9.5, a1, 8], [14, 1, 11, aV]),
    plane(0, [8, b0, 6.5], [8, b1, 9.5], [11, bV, 14, 12]),
    plane(1, [8, b0, 6.5], [8, b1, 9.5], [14, bV, 11, 12]),
  ].map(quad => {
    const corners = [...quad.corners];
    for (let i = 0; i < corners.length; i += 3) {
      const x = Math.sign(corners[i] - 0.5), z = Math.sign(corners[i + 2] - 0.5);
      corners[i] = (8 + x + z) / 16;
      corners[i + 2] = (8 - x + z) / 16;
    }
    return { ...quad, corners };
  });
  return [...result, ...cap, ...handle];
}

function torch(): ModelQuad[] {
  return directions.map((_, face) => plane(face, [7, 0, 7], [9, 10, 9],
    face === 2 ? [7, 6, 9, 8] : face === 3 ? [7, 13, 9, 15] : [7, 6, 9, 16]));
}

const railTurns = [0, 1, 1, 3, 0, 2, 0, 1, 2, 3];

function rail(shape: number): ModelQuad[] {
  const base = plane(2, [0, 0.5, 0], [16, 0.5, 16]);
  const corners = [...base.corners];
  if (shape >= 2 && shape <= 5) {
    for (let i = 0; i < corners.length; i += 3) corners[i + 1] += 1 - corners[i + 2];
  }
  return [rotate({ ...base, corners, doubleSided: true }, railTurns[shape])];
}

function stairs(variant: number): ModelQuad[] {
  const facing = variant % 4, slabY = (variant >> 2) % 2, shape = variant >> 3;
  const occupied = (x: number, y: number, z: number) => {
    if (x < 0 || x > 1 || y < 0 || y > 1 || z < 0 || z > 1) return false;
    if (y === slabY) return true;
    const forward = [z === 0, z === 1, x === 0, x === 1][facing];
    const left = [x === 0, x === 1, z === 1, z === 0][facing];
    switch (shape) {
      case 1: return forward || left;
      case 2: return forward || !left;
      case 3: return forward && left;
      case 4: return forward && !left;
      default: return forward;
    }
  };
  const result: ModelQuad[] = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    if (!occupied(x, y, z)) continue;
    directions.forEach(([dx, dy, dz], face) => {
      if (!occupied(x + dx, y + dy, z + dz)) {
        result.push(plane(face, [8 * x, 8 * y, 8 * z], [8 * (x + 1), 8 * (y + 1), 8 * (z + 1)]));
      }
    });
  }
  return result;
}

const models = new Map<string, readonly (readonly ModelQuad[])[]>([
  ["crop", [crop()]],
  ["fence", Array.from({ length: 16 }, (_, i) => fence(i))],
  ["composter", Array.from({ length: 9 }, (_, i) => composter(i))],
  ["lantern", [lantern(0), lantern(1)]],
  ["torch", [torch()]],
  ["rail", railTurns.map((_, i) => rail(i))],
  ["stairs", Array.from({ length: 40 }, (_, i) => stairs(i))],
]);
const empty: readonly ModelQuad[] = [];

export function modelQuads(model: string, variant: number): readonly ModelQuad[] {
  return Number.isInteger(variant) ? models.get(model)?.[variant] ?? empty : empty;
}
