export const SUPPORTED_KINDS = ["item", "cow", "sheep", "pig", "chicken", "villager", "player"] as const;
export type EntityKind = (typeof SUPPORTED_KINDS)[number];
export type ModelKind = Exclude<EntityKind, "item">;

export type TextureName = "main" | "wool";

interface BoxDef {
  u: number; v: number;
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  inflate?: number;
  tex?: TextureName;
  outer?: boolean;
}

interface PartDef {
  name: string;
  pivot: readonly [number, number, number];
  rot?: readonly [number, number, number];
  boxes: readonly BoxDef[];
}

export interface Pose {
  swing: number;
  amount: number;
  headYaw: number;
  pitch: number;
}

type Rotations = Record<string, readonly [number, number, number]>;

const HALF_PI = Math.PI / 2;
const RAD = Math.PI / 180;

const quadruped = (head: PartDef, body: PartDef, legs: readonly (readonly [number, number, number])[], legBox: BoxDef): PartDef[] => [
  head,
  body,
  ...(["right_hind", "left_hind", "right_front", "left_front"] as const).map((name, i): PartDef => ({
    name: `${name}_leg`, pivot: [legs[i][0], legs[i][1], legs[i][2]], boxes: [legBox],
  })),
];

const leg4 = { u: 0, v: 16, x: -2, y: 0, z: -2, w: 4, h: 12, d: 4 };

const MODELS: Record<ModelKind, readonly PartDef[]> = {
  cow: quadruped(
    {
      name: "head", pivot: [0, 4, -8], boxes: [
        { u: 0, v: 0, x: -4, y: -4, z: -6, w: 8, h: 8, d: 6 },
        { u: 22, v: 0, x: -5, y: -5, z: -5, w: 1, h: 3, d: 1 },
        { u: 22, v: 0, x: 4, y: -5, z: -5, w: 1, h: 3, d: 1 },
      ],
    },
    {
      name: "body", pivot: [0, 5, 2], rot: [HALF_PI, 0, 0], boxes: [
        { u: 18, v: 4, x: -6, y: -10, z: -7, w: 12, h: 18, d: 10 },
        { u: 52, v: 0, x: -2, y: 2, z: -8, w: 4, h: 6, d: 1 },
      ],
    },
    [[-4, 12, 7], [4, 12, 7], [-4, 12, -6], [4, 12, -6]],
    leg4,
  ),
  pig: quadruped(
    {
      name: "head", pivot: [0, 12, -6], boxes: [
        { u: 0, v: 0, x: -4, y: -4, z: -8, w: 8, h: 8, d: 8 },
        { u: 16, v: 16, x: -2, y: 0, z: -9, w: 4, h: 3, d: 1 },
      ],
    },
    { name: "body", pivot: [0, 11, 2], rot: [HALF_PI, 0, 0], boxes: [{ u: 28, v: 8, x: -5, y: -10, z: -7, w: 10, h: 16, d: 8 }] },
    [[-3, 18, 7], [3, 18, 7], [-3, 18, -5], [3, 18, -5]],
    { ...leg4, h: 6 },
  ),
  sheep: (() => {
    const parts = quadruped(
      { name: "head", pivot: [0, 6, -8], boxes: [{ u: 0, v: 0, x: -3, y: -4, z: -6, w: 6, h: 6, d: 8 }] },
      { name: "body", pivot: [0, 5, 2], rot: [HALF_PI, 0, 0], boxes: [{ u: 28, v: 8, x: -4, y: -10, z: -7, w: 8, h: 16, d: 6 }] },
      [[-3, 12, 7], [3, 12, 7], [-3, 12, -5], [3, 12, -5]],
      leg4,
    );
    const wool: Record<string, BoxDef> = {
      head: { u: 0, v: 0, x: -3, y: -4, z: -4, w: 6, h: 6, d: 6, inflate: 0.6, tex: "wool" },
      body: { u: 28, v: 8, x: -4, y: -10, z: -7, w: 8, h: 16, d: 6, inflate: 1.75, tex: "wool" },
    };
    return parts.map(part => ({
      ...part,
      boxes: [...part.boxes, wool[part.name] ?? { u: 0, v: 16, x: -2, y: 0, z: -2, w: 4, h: 6, d: 4, inflate: 0.5, tex: "wool" }],
    }));
  })(),
  chicken: [
    {
      name: "head", pivot: [0, 15, -4], boxes: [
        { u: 0, v: 0, x: -2, y: -6, z: -2, w: 4, h: 6, d: 3 },
        { u: 14, v: 0, x: -2, y: -4, z: -4, w: 4, h: 2, d: 2 },
        { u: 14, v: 4, x: -1, y: -2, z: -3, w: 2, h: 2, d: 2 },
      ],
    },
    { name: "body", pivot: [0, 16, 0], rot: [HALF_PI, 0, 0], boxes: [{ u: 0, v: 9, x: -3, y: -4, z: -3, w: 6, h: 8, d: 6 }] },
    { name: "right_leg", pivot: [-2, 19, 1], boxes: [{ u: 26, v: 0, x: -1, y: 0, z: -3, w: 3, h: 5, d: 3 }] },
    { name: "left_leg", pivot: [1, 19, 1], boxes: [{ u: 26, v: 0, x: -1, y: 0, z: -3, w: 3, h: 5, d: 3 }] },
    { name: "right_wing", pivot: [-4, 13, 0], boxes: [{ u: 24, v: 13, x: 0, y: 0, z: -3, w: 1, h: 4, d: 6 }] },
    { name: "left_wing", pivot: [4, 13, 0], boxes: [{ u: 24, v: 13, x: -1, y: 0, z: -3, w: 1, h: 4, d: 6 }] },
  ],
  villager: [
    {
      name: "head", pivot: [0, 0, 0], boxes: [
        { u: 0, v: 0, x: -4, y: -10, z: -4, w: 8, h: 10, d: 8 },
        { u: 24, v: 0, x: -1, y: -3, z: -6, w: 2, h: 4, d: 2 },
      ],
    },
    {
      name: "body", pivot: [0, 0, 0], boxes: [
        { u: 16, v: 20, x: -4, y: 0, z: -3, w: 8, h: 12, d: 6 },
        { u: 0, v: 38, x: -4, y: 0, z: -3, w: 8, h: 20, d: 6, inflate: 0.5 },
      ],
    },
    {
      name: "arms", pivot: [0, 3, -1], rot: [-0.75, 0, 0], boxes: [
        { u: 44, v: 22, x: -8, y: -2, z: -2, w: 4, h: 8, d: 4 },
        { u: 44, v: 22, x: 4, y: -2, z: -2, w: 4, h: 8, d: 4 },
        { u: 40, v: 38, x: -4, y: 2, z: -2, w: 8, h: 4, d: 4 },
      ],
    },
    { name: "right_leg", pivot: [-2, 12, 0], boxes: [{ ...leg4, v: 22 }] },
    { name: "left_leg", pivot: [2, 12, 0], boxes: [{ ...leg4, v: 22 }] },
  ],
  player: [],
};

function playerParts(slim: boolean): PartDef[] {
  const arm = slim ? 3 : 4;
  const limb = (name: string, pivot: [number, number, number], base: [number, number], outer: [number, number], x: number, w: number): PartDef => ({
    name, pivot, boxes: [
      { u: base[0], v: base[1], x, y: -2, z: -2, w, h: 12, d: 4 },
      { u: outer[0], v: outer[1], x, y: -2, z: -2, w, h: 12, d: 4, inflate: 0.25, outer: true },
    ],
  });
  const legBox = (name: string, pivot: [number, number, number], base: [number, number], outer: [number, number]): PartDef => ({
    name, pivot, boxes: [
      { u: base[0], v: base[1], x: -2, y: 0, z: -2, w: 4, h: 12, d: 4 },
      { u: outer[0], v: outer[1], x: -2, y: 0, z: -2, w: 4, h: 12, d: 4, inflate: 0.25, outer: true },
    ],
  });
  return [
    {
      name: "head", pivot: [0, 0, 0], boxes: [
        { u: 0, v: 0, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8 },
        { u: 32, v: 0, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8, inflate: 0.5, outer: true },
      ],
    },
    {
      name: "body", pivot: [0, 0, 0], boxes: [
        { u: 16, v: 16, x: -4, y: 0, z: -2, w: 8, h: 12, d: 4 },
        { u: 16, v: 32, x: -4, y: 0, z: -2, w: 8, h: 12, d: 4, inflate: 0.25, outer: true },
      ],
    },
    limb("right_arm", [-5, slim ? 2.5 : 2, 0], [40, 16], [40, 32], -3, arm),
    limb("left_arm", [5, slim ? 2.5 : 2, 0], [32, 48], [48, 48], -1, arm),
    legBox("right_leg", [-1.9, 12, 0], [0, 16], [0, 32]),
    legBox("left_leg", [1.9, 12, 0], [16, 48], [0, 48]),
  ];
}

export function modelParts(kind: ModelKind, slim = false): readonly PartDef[] {
  return kind === "player" ? playerParts(slim) : MODELS[kind];
}

export function poseRotations(kind: ModelKind, pose: Pose): Rotations {
  const { swing, amount, headYaw, pitch } = pose;
  const phase = swing * 0.6662;
  const a = Math.cos(phase) * 1.4 * amount;
  const b = Math.cos(phase + Math.PI) * 1.4 * amount;
  const head = [pitch * RAD, headYaw * RAD, 0] as const;
  switch (kind) {
    case "chicken":
      return { head, right_leg: [a, 0, 0], left_leg: [b, 0, 0] };
    case "villager":
      return { head, right_leg: [a * 0.5, 0, 0], left_leg: [b * 0.5, 0, 0] };
    case "player":
      return {
        head,
        right_arm: [Math.cos(phase + Math.PI) * amount, 0, 0],
        left_arm: [Math.cos(phase) * amount, 0, 0],
        right_leg: [a, 0, 0],
        left_leg: [b, 0, 0],
      };
    default:
      return { head, right_hind_leg: [a, 0, 0], left_hind_leg: [b, 0, 0], right_front_leg: [b, 0, 0], left_front_leg: [a, 0, 0] };
  }
}

type Corner = readonly [0 | 1, 0 | 1, 0 | 1];
interface FaceDef { corners: readonly [Corner, Corner, Corner, Corner]; uv: (u: number, v: number, w: number, h: number, d: number) => readonly [number, number, number, number] }

const c = (n: number): Corner => [(n >> 2) & 1, (n >> 1) & 1, n & 1] as Corner;
const quad = (a: number, b: number, d: number, e: number): FaceDef["corners"] => [c(a), c(b), c(d), c(e)];

// Cuboid faces and texture rectangles as laid out by vanilla ModelPart.Cube; corner bits are x, y, z (1 = max).
const FACES: readonly FaceDef[] = [
  { corners: quad(0b101, 0b001, 0b000, 0b100), uv: (u, v, w, _h, d) => [u + d, v, u + d + w, v + d] },
  { corners: quad(0b110, 0b010, 0b011, 0b111), uv: (u, v, w, _h, d) => [u + d + w, v + d, u + d + 2 * w, v] },
  { corners: quad(0b000, 0b001, 0b011, 0b010), uv: (u, v, _w, h, d) => [u, v + d, u + d, v + d + h] },
  { corners: quad(0b100, 0b000, 0b010, 0b110), uv: (u, v, w, h, d) => [u + d, v + d, u + d + w, v + d + h] },
  { corners: quad(0b101, 0b100, 0b110, 0b111), uv: (u, v, w, h, d) => [u + d + w, v + d, u + 2 * d + w, v + d + h] },
  { corners: quad(0b001, 0b101, 0b111, 0b011), uv: (u, v, w, h, d) => [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h] },
];

export interface Rect { x: number; y: number; w: number; h: number }

export interface Sink {
  push(x: number, y: number, z: number, u: number, v: number, r: number, g: number, b: number): void;
}

export interface Placement {
  x: number; y: number; z: number;
  yaw: number;
  scale?: number;
  tint?: readonly [number, number, number];
}

export function shade(nx: number, ny: number, nz: number): number {
  const light = 0.62 + 0.38 * (nx * 0.25 + ny * 0.85 + nz * 0.45);
  return Math.min(1, Math.max(0.55, light));
}

function rotateZYX(p: [number, number, number], [rx, ry, rz]: readonly [number, number, number]): void {
  let [x, y, z] = p;
  if (rx) { const s = Math.sin(rx), k = Math.cos(rx); [y, z] = [y * k - z * s, y * s + z * k]; }
  if (ry) { const s = Math.sin(ry), k = Math.cos(ry); [x, z] = [x * k + z * s, -x * s + z * k]; }
  if (rz) { const s = Math.sin(rz), k = Math.cos(rz); [x, y] = [x * k - y * s, x * s + y * k]; }
  p[0] = x; p[1] = y; p[2] = z;
}

function boxCenter(part: PartDef, rot: readonly [number, number, number], box: BoxDef, place: Placement, sinYaw: number, cosYaw: number): [number, number, number] {
  const scale = place.scale ?? 1;
  const p: [number, number, number] = [box.x + box.w / 2, box.y + box.h / 2, box.z + box.d / 2];
  rotateZYX(p, rot);
  const lx = -(p[0] + part.pivot[0]) / 16 * scale, ly = (1.501 - (p[1] + part.pivot[1]) / 16) * scale, lz = (p[2] + part.pivot[2]) / 16 * scale;
  return [place.x + lx * cosYaw + lz * sinYaw, place.y + ly, place.z - lx * sinYaw + lz * cosYaw];
}

export function emitModel(
  kind: ModelKind,
  slim: boolean,
  pose: Pose,
  place: Placement,
  rects: Record<TextureName, Rect | undefined>,
  sinks: { solid: (name: TextureName) => Sink | undefined; outer: (name: TextureName) => Sink | undefined },
  wool: readonly [number, number, number] = [1, 1, 1],
): void {
  const rotations = poseRotations(kind, pose);
  const scale = place.scale ?? 1;
  const yaw = (180 - place.yaw) * RAD;
  const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw);
  const world: [number, number, number][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const model: [number, number, number][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

  for (const part of modelParts(kind, slim)) {
    const base = part.rot ?? [0, 0, 0];
    const extra = rotations[part.name] ?? [0, 0, 0];
    const rot = [base[0] + extra[0], base[1] + extra[1], base[2] + extra[2]] as const;
    for (const box of part.boxes) {
      const texture = box.tex ?? "main";
      const rect = rects[texture];
      const sink = (box.outer ? sinks.outer : sinks.solid)(texture);
      if (!rect || !sink) continue;
      const g = box.inflate ?? 0;
      const min = [box.x - g, box.y - g, box.z - g], max = [box.x + box.w + g, box.y + box.h + g, box.z + box.d + g];
      const tint = texture === "wool" ? wool : place.tint ?? [1, 1, 1];
      for (const face of FACES) {
        face.corners.forEach(([cx, cy, cz], i) => {
          const p = model[i];
          p[0] = cx ? max[0] : min[0]; p[1] = cy ? max[1] : min[1]; p[2] = cz ? max[2] : min[2];
          rotateZYX(p, rot);
          p[0] += part.pivot[0]; p[1] += part.pivot[1]; p[2] += part.pivot[2];
          const lx = -p[0] / 16 * scale, ly = (1.501 - p[1] / 16) * scale, lz = p[2] / 16 * scale;
          const w = world[i];
          w[0] = place.x + lx * cosYaw + lz * sinYaw;
          w[1] = place.y + ly;
          w[2] = place.z - lx * sinYaw + lz * cosYaw;
        });
        const [ax, ay, az] = [world[1][0] - world[0][0], world[1][1] - world[0][1], world[1][2] - world[0][2]];
        const [bx, by, bz] = [world[2][0] - world[1][0], world[2][1] - world[1][1], world[2][2] - world[1][2]];
        const center = boxCenter(part, rot, box, place, sinYaw, cosYaw);
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length; ny /= length; nz /= length;
        if (nx * (world[0][0] - center[0]) + ny * (world[0][1] - center[1]) + nz * (world[0][2] - center[2]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const light = shade(nx, ny, nz);
        const [left, top, right, bottom] = face.uv(box.u, box.v, box.w, box.h, box.d);
        const ox = rect.x, oy = rect.y;
        const uvs: readonly [number, number][] = [[right, top], [left, top], [left, bottom], [right, bottom]];
        for (const i of [0, 1, 2, 0, 2, 3]) {
          const [u, v] = uvs[i];
          sink.push(world[i][0], world[i][1], world[i][2], ox + u, oy + v, light * tint[0], light * tint[1], light * tint[2]);
        }
      }
    }
  }
}
