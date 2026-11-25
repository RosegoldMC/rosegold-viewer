export const LIQUID_SPRITES = ["waterStill", "waterFlow", "lavaStill", "lavaFlow"] as const;
export const FIRST_LIQUID_MATERIAL = 2;
export const FLOW_TOP_MATERIAL_OFFSET = LIQUID_SPRITES.length;
export const FLOW_TOP_UV_BIAS = 1;
export type LiquidSprite = typeof LIQUID_SPRITES[number];
export type LiquidKind = "water" | "lava";
export type LiquidFrame = readonly [tile: number, ticks: number];
export type LiquidAnimations = Partial<Record<LiquidSprite, readonly LiquidFrame[]>>;

export const BLOCKED = -1;
export const EMPTY = 0;
const SOURCE_HEIGHT = 8 / 9;
const cardinal = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const topCorners = [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]] as const;

export function liquidMaterial(kind: LiquidKind, flowing: boolean, rotated: boolean): number {
  return FIRST_LIQUID_MATERIAL + (kind === "lava" ? 2 : 0) + Number(flowing) + (rotated ? FLOW_TOP_MATERIAL_OFFSET : 0);
}

export function liquidHeight(level: number): number {
  return level >= 8 ? SOURCE_HEIGHT : (8 - level) / 9;
}

function averageCorner(center: number, x: number, z: number, diagonal: number): number {
  if (x === 1 || z === 1 || ((x > 0 || z > 0) && diagonal === 1)) return 1;
  let sum = 0, weight = 0;
  for (const h of [center, x, z, (x > 0 || z > 0) ? diagonal : BLOCKED]) {
    if (h < 0) continue;
    const w = h >= 0.8 ? 10 : 1;
    sum += h * w;
    weight += w;
  }
  return sum / weight;
}

type SampleLiquid = (dx: number, dy: number, dz: number) => number;

export function liquidSurface(level: number, sample: SampleLiquid): {
  heights: readonly [northWest: number, southWest: number, southEast: number, northEast: number];
  flowUv: readonly number[] | undefined;
} {
  const own = liquidHeight(level);
  const center = sample(0, 1, 0) > EMPTY ? 1 : own;
  const cell = (dx: number, dz: number) => {
    const state = sample(dx, 0, dz);
    if (state <= EMPTY) return state;
    return sample(dx, 1, dz) > EMPTY ? 1 : liquidHeight(state - 1);
  };
  const west = center === 1 ? 1 : cell(-1, 0);
  const east = center === 1 ? 1 : cell(1, 0);
  const north = center === 1 ? 1 : cell(0, -1);
  const south = center === 1 ? 1 : cell(0, 1);
  const corner = (x: number, z: number, sideX: number, sideZ: number) =>
    center === 1 ? 1 : averageCorner(center, sideX, sideZ, cell(x, z));
  const heights = [corner(-1, -1, west, north), corner(-1, 1, west, south),
    corner(1, 1, east, south), corner(1, -1, east, north)] as const;

  let flowX = 0, flowZ = 0;
  for (const [dx, dz] of cardinal) {
    const adjacent = sample(dx, 0, dz);
    let drop = 0;
    if (adjacent > EMPTY) drop = own - liquidHeight(adjacent - 1);
    else if (adjacent === EMPTY) {
      const below = sample(dx, -1, dz);
      if (below > EMPTY) drop = own + SOURCE_HEIGHT - liquidHeight(below - 1);
    }
    flowX += dx * drop;
    flowZ += dz * drop;
  }
  const length = Math.hypot(flowX, flowZ);
  if (length < 1e-6) return { heights, flowUv: undefined };
  const x = flowX / length, z = flowZ / length;
  const flowUv = topCorners.flatMap(([dx, dz]) => [
    FLOW_TOP_UV_BIAS + 0.5 + z * dx - x * dz,
    FLOW_TOP_UV_BIAS + 0.5 + x * dx + z * dz,
  ]);
  return { heights, flowUv };
}

export function liquidFrameAt(frames: readonly LiquidFrame[], tick: number): { tile: number; remaining: number } {
  const duration = frames.reduce((total, [, ticks]) => total + ticks, 0);
  let offset = tick % duration;
  for (const [tile, ticks] of frames) {
    if (offset < ticks) return { tile, remaining: ticks - offset };
    offset -= ticks;
  }
  return { tile: frames[0][0], remaining: 1 };
}
