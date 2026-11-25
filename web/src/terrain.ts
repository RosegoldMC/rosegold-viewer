import type { BlockMesh, BlockModel } from "./atlas.js";
import { modelQuads, type ModelQuad } from "./block-models.js";
import { BLOCKED, EMPTY, liquidMaterial, liquidSurface } from "./liquid.js";

export type SectionPosition = readonly [x: number, y: number, z: number];

export const SECTION_SIZE = 16;
export const SECTION_VOLUME = SECTION_SIZE ** 3;
export const VERTEX_STRIDE = 14;
export const VERTEX_POSITION_SCALE = 32;
export const VERTEX_UV_SCALE = 32;
export const NO_TILE_BYTE = 255;

const SECTION_MASK = SECTION_SIZE - 1;
const faces = [
  { step: [1, 0, 0], corners: [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1] },
  { step: [-1, 0, 0], corners: [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0] },
  { step: [0, 1, 0], corners: [0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0] },
  { step: [0, -1, 0], corners: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1] },
  { step: [0, 0, 1], corners: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1] },
  { step: [0, 0, -1], corners: [0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0] },
] as const;

const triangles = [0, 3, 6, 0, 6, 9];
const quadOrder = [0, 1, 2, 0, 2, 3];
const cubeOrder = quadOrder;
const doubleSidedOrder = [...quadOrder, 0, 2, 1, 0, 3, 2];

function uprightPlane(x1: number, z1: number, x2: number, z2: number): readonly number[] {
  return [x1, 0, z1, x1, 1, z1, x2, 1, z2, x2, 0, z2];
}

const cross = [uprightPlane(0, 0, 1, 1), uprightPlane(1, 0, 0, 1)];
const crossUv = [0, 1, 0, 0, 1, 0, 1, 1];
const palette = [
  [154, 161, 192], [111, 187, 139], [111, 121, 155], [215, 149, 105],
  [97, 191, 199], [238, 203, 134], [187, 143, 191], [202, 103, 114],
] as const;

function stateColor(state: number): readonly [number, number, number] {
  if (state < palette.length) return palette[state];
  const hash = Math.imul(state, 0x9e3779b1);
  return [96 + (hash & 127), 96 + ((hash >>> 8) & 127), 96 + ((hash >>> 16) & 127)];
}

export function faceUv(face: number, x: number, y: number, z: number): readonly [number, number] {
  switch (face) {
    case 0: return [1 - z, 1 - y];
    case 1: return [z, 1 - y];
    case 2: return [x, z];
    case 3: return [x, 1 - z];
    case 4: return [x, 1 - y];
    default: return [1 - x, 1 - y];
  }
}

export type TerrainModel = BlockModel;

const CUTOUT_MODELS: ReadonlySet<TerrainModel> = new Set(["leaves", "cross", "crop", "glass", "fence", "lantern", "torch", "rail", "composter"]);

export interface TileSource {
  readonly columns: number;
  readonly meshes?: readonly BlockMesh[];
  tilesFor(state: number): readonly number[] | undefined;
  modelFor?(state: number): TerrainModel | undefined;
  variantFor?(state: number): number;
  nameFor?(state: number): string | undefined;
  invisibleFor?(state: number): boolean;
  registered?(state: number): boolean;
}

export type MissingTextureReason = "no-atlas-entry" | "face-without-tile";

export interface MissingTexture {
  readonly state: number;
  readonly name?: string;
  readonly reason: MissingTextureReason;
  readonly faces: readonly number[];
}

export const MAX_MISSING_REPORTS = 256;

export function describeMissingTexture({ state, name, reason, faces }: MissingTexture): string {
  const detail = reason === "no-atlas-entry" ? "is unresolved in the built atlas" : `has faces ${faces.join(",")} unresolved in the built atlas`;
  return `Missing block texture: ${name ? `${name} ` : ""}state ${state} ${detail}; drawing a flat color`;
}

export type QuadSource = (model: TerrainModel, variant: number) => readonly ModelQuad[];

const MAX_CACHED_MODELS = 1024;

function offset(position: SectionPosition, [dx, dy, dz]: SectionPosition): SectionPosition {
  return [position[0] + dx, position[1] + dy, position[2] + dz];
}

export function fillCube(
  out: Float32Array, origin: SectionPosition, eye: readonly number[], tileX: number, tileY: number,
  solidAt: (x: number, y: number, z: number) => boolean,
): number {
  let n = 0;
  for (let f = 0; f < faces.length; f++) {
    const { corners, step } = faces[f];
    if (solidAt(origin[0] + step[0], origin[1] + step[1], origin[2] + step[2])) continue;
    for (const i of triangles) {
      const [baseU, v] = faceUv(f, corners[i], corners[i + 1], corners[i + 2]);
      const u = f < 2 ? 1 - baseU : baseU;
      out[n++] = origin[0] + corners[i] - eye[0];
      out[n++] = origin[1] + corners[i + 1] - eye[1];
      out[n++] = origin[2] + corners[i + 2] - eye[2];
      out[n++] = 0;
      out[n++] = 0;
      out[n++] = 0;
      out[n++] = u;
      out[n++] = v;
      out[n++] = tileX;
      out[n++] = tileY;
    }
  }  return n / 10;
}

export const CUBE_VERTICES = faces.length * triangles.length;

export function sectionKey(position: SectionPosition): string {
  return position.join(",");
}

export function cellIndex(x: number, y: number, z: number): number {
  return x + SECTION_SIZE * (z + SECTION_SIZE * y);
}

function boundaryChanged(previous: Uint16Array, next: Uint16Array, [dx, dy, dz]: SectionPosition): boolean {
  for (let y = dy > 0 ? SECTION_MASK : 0; y <= (dy < 0 ? 0 : SECTION_MASK); y++) {
    for (let z = dz > 0 ? SECTION_MASK : 0; z <= (dz < 0 ? 0 : SECTION_MASK); z++) {
      for (let x = dx > 0 ? SECTION_MASK : 0; x <= (dx < 0 ? 0 : SECTION_MASK); x++) {
        const i = cellIndex(x, y, z);
        if (previous[i] !== next[i]) return true;
      }
    }
  }
  return false;
}

export class Terrain {
  private readonly sections = new Map<string, { position: SectionPosition; states: Uint16Array }>();
  private readonly dirty = new Map<string, SectionPosition>();
  private readonly air = new Set<number>();
  private readonly quadCache = new Map<string, readonly ModelQuad[]>();
  private textures: TileSource | null = null;
  private reportedFor: TileSource | null = null;
  private readonly reportedStates = new Uint8Array(65536);
  private readonly reportedUnknown = new Set<string>();

  constructor(
    airStateIds: Iterable<number>, private readonly quadSource: QuadSource = modelQuads,
    private readonly reportMissing?: (missing: MissingTexture) => void,
  ) {
    for (const id of airStateIds) {
      if (!Number.isInteger(id) || id < 0 || id > 65535) throw new RangeError("Invalid air state ID");
      this.air.add(id);
    }
  }

  replaceSection(position: SectionPosition, states: Uint16Array | null): boolean {
    if (position.length !== 3 || position.some(value => !Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
      throw new RangeError("Expected signed 32-bit section coordinates");
    }
    if (states !== null && states.length !== SECTION_VOLUME) {
      throw new RangeError(`Expected ${SECTION_VOLUME} section states`);
    }

    const key = sectionKey(position);
    const previous = this.sections.get(key);
    if (previous && states?.every((state, i) => state === previous.states[i])) return false;

    const populated = states !== null && !states.every(id => this.air.has(id));
    if (!populated && !previous) return false;
    if (populated) {
      const storedPosition: SectionPosition = previous?.position ?? [...position];
      this.sections.set(key, { position: storedPosition, states: states.slice() });
      this.dirty.set(key, storedPosition);
    } else {
      this.sections.delete(key);
      this.dirty.delete(key);
    }

    const markNeighbor = (step: SectionPosition, diagonal = false) => {
      const key = sectionKey(offset(position, step));
      const neighbor = this.sections.get(key);
      if (neighbor && (!diagonal || !previous || !populated || boundaryChanged(previous.states, states, step))) {
        this.dirty.set(key, neighbor.position);
      }
    };
    for (const face of faces) markNeighbor(face.step);
    if (this.textures?.modelFor) {
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1) markNeighbor([dx, dy, dz], true);
      }
    }
    return true;
  }

  setTextures(source: TileSource | null): void {
    if (this.textures === source) return;
    this.textures = source;
    if (source && source !== this.reportedFor) {
      this.reportedFor = source;
      this.reportedStates.fill(0);
      this.reportedUnknown.clear();
    }
    this.quadCache.clear();
    this.markAllDirty();
  }

  clear(): void {
    this.sections.clear();
    this.dirty.clear();
  }

  markAllDirty(): void {
    for (const [key, { position }] of this.sections) this.dirty.set(key, position);
  }

  takeDirty(): SectionPosition[] {
    const positions = [...this.dirty.values()];
    this.dirty.clear();
    return positions;
  }

  private stateAt(x: number, y: number, z: number): number | undefined {
    const section = this.sections.get(sectionKey([x >> 4, y >> 4, z >> 4]));
    return section?.states[cellIndex(x & SECTION_MASK, y & SECTION_MASK, z & SECTION_MASK)];
  }

  solidAt(x: number, y: number, z: number): boolean {
    const state = this.stateAt(x, y, z);
    return state !== undefined && !this.air.has(state);
  }

  opaqueAt(x: number, y: number, z: number): boolean {
    return this.isOpaque(this.stateAt(x, y, z));
  }

  private isOpaque(state: number | undefined): boolean {
    return state !== undefined && !this.air.has(state) && this.textures?.modelFor?.(state) === undefined;
  }

  private hides(model: TerrainModel | undefined, adjacent: number | undefined): boolean {
    if (adjacent === undefined || this.air.has(adjacent)) return false;
    const adjacentModel = this.textures?.modelFor?.(adjacent);
    if (adjacentModel === undefined) return true;
    return adjacentModel === model && (model === "glass" || model === "water" || model === "lava");
  }

  private quadsFor(model: TerrainModel, variant: number): readonly ModelQuad[] {
    if (!Number.isFinite(variant)) return this.quadSource(model, 0);
    const key = `${model}:${variant}`;
    let quads = this.quadCache.get(key);
    if (!quads) {
      quads = this.quadSource(model, variant);
      if (this.quadCache.size >= MAX_CACHED_MODELS) this.quadCache.clear();
      this.quadCache.set(key, quads);
    }
    return quads;
  }

  private noteMissing(state: number, face: number): void {
    const { textures } = this;
    if (!textures || !this.reportMissing || textures.invisibleFor?.(state)) return;
    const tiles = textures.tilesFor(state);
    const reason = tiles ? "face-without-tile" : "no-atlas-entry";
    const bit = reason === "no-atlas-entry" ? 1 : 2;
    if (Number.isInteger(state) && state >= 0 && state < 65536 && textures.registered?.(state) !== false) {
      if (this.reportedStates[state] & bit) return;
      this.reportedStates[state] |= bit;
    } else {
      const key = `${state}:${reason}`;
      if (this.reportedUnknown.has(key) || this.reportedUnknown.size > MAX_MISSING_REPORTS) return;
      this.reportedUnknown.add(key);
      if (this.reportedUnknown.size > MAX_MISSING_REPORTS) {
        console.warn(`Missing block textures: more than ${MAX_MISSING_REPORTS} unregistered state IDs; further reports suppressed`);
        return;
      }
    }
    const faces = tiles ? tiles.flatMap((tile, f) => tile < 0 ? [f] : []) : [];
    this.reportMissing({ state, name: textures.nameFor?.(state), reason, faces: faces.length ? faces : [face] });
  }

  hasSection(key: string): boolean {
    return this.sections.has(key);
  }

  mesh(position: SectionPosition, waterOnly = false): Uint8Array | null {
    const section = this.sections.get(sectionKey(position));
    if (!section) return null;
    const { states } = section;
    const neighbors = faces.map(face => this.sections.get(sectionKey(offset(position, face.step)))?.states);
    let bytes = new Uint8Array(1024 * VERTEX_STRIDE);
    let view = new DataView(bytes.buffer);
    let length = 0;
    const columns = this.textures?.columns ?? 1;
    let current = -1;

    const adjacentAt = (x: number, y: number, z: number, f: number): number | undefined => {
      const [dx, dy, dz] = faces[f].step;
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const outside = nx < 0 || ny < 0 || nz < 0 || nx === SECTION_SIZE || ny === SECTION_SIZE || nz === SECTION_SIZE;
      return outside
        ? neighbors[f]?.[cellIndex(nx & SECTION_MASK, ny & SECTION_MASK, nz & SECTION_MASK)]
        : states[cellIndex(nx, ny, nz)];
    };

    const liquidNeighbors = new Map<number, Uint16Array | undefined>();
    const liquidStateAt = (x: number, y: number, z: number): number | undefined => {
      const dx = x >> 4, dy = y >> 4, dz = z >> 4;
      if ((dx | dy | dz) === 0) return states[cellIndex(x, y, z)];
      const key = dx + 3 * dy + 9 * dz;
      if (!liquidNeighbors.has(key)) {
        liquidNeighbors.set(key, this.sections.get(sectionKey(offset(position, [dx, dy, dz])))?.states);
      }
      return liquidNeighbors.get(key)?.[cellIndex(x & SECTION_MASK, y & SECTION_MASK, z & SECTION_MASK)];
    };

    const emit = (
      x: number, y: number, z: number, corners: readonly number[], uv: readonly number[] | undefined,
      order: readonly number[], color: readonly [number, number, number], tile: number, material: number, face: number,
    ) => {
      if (length + order.length * VERTEX_STRIDE > bytes.length) {
        const larger = new Uint8Array(bytes.length * 2);
        larger.set(bytes);
        bytes = larger;
        view = new DataView(bytes.buffer);
      }
      if (tile < 0) this.noteMissing(current, face);
      const tileX = tile < 0 ? NO_TILE_BYTE : tile % columns;
      const tileY = tile < 0 ? NO_TILE_BYTE : Math.floor(tile / columns);
      for (const index of order) {
        const cx = corners[index * 3], cy = corners[index * 3 + 1], cz = corners[index * 3 + 2];
        view.setInt16(length, Math.round((x + cx) * VERTEX_POSITION_SCALE), true);
        view.setInt16(length + 2, Math.round((y + cy) * VERTEX_POSITION_SCALE), true);
        view.setInt16(length + 4, Math.round((z + cz) * VERTEX_POSITION_SCALE), true);
        bytes[length + 6] = color[0];
        bytes[length + 7] = color[1];
        bytes[length + 8] = color[2];
        const [u, v] = uv ? [uv[index * 2], uv[index * 2 + 1]] : faceUv(face, cx, cy, cz);
        bytes[length + 9] = Math.round(u * VERTEX_UV_SCALE);
        bytes[length + 10] = Math.round(v * VERTEX_UV_SCALE);
        bytes[length + 11] = tileX;
        bytes[length + 12] = tileY;
        bytes[length + 13] = material;
        length += VERTEX_STRIDE;
      }
    };

    for (let y = 0; y < SECTION_SIZE; y++) {
      for (let z = 0; z < SECTION_SIZE; z++) {
        for (let x = 0; x < SECTION_SIZE; x++) {
          const state = states[cellIndex(x, y, z)];
          if (this.air.has(state)) continue;
          current = state;
          const model = this.textures?.modelFor?.(state);
          if ((model === "water") !== waterOnly) continue;
          const tiles = this.textures?.tilesFor(state);
          const variant = this.textures?.variantFor?.(state) ?? 0;
          const mesh = model === "mesh" ? this.textures?.meshes?.[variant] : undefined;
          const material = Number(mesh?.cutout || (model !== undefined && CUTOUT_MODELS.has(model)));

          if (model === "water" || model === "lava") {
            const coveredTop = this.isOpaque(adjacentAt(x, y, z, 2));
            const visible = faces.map((_, f) => !this.hides(model, adjacentAt(x, y, z, f)));
            if (!coveredTop && !visible.some(Boolean)) continue;
            const { heights, flowUv } = liquidSurface(variant, (dx, dy, dz) => {
              const nearby = liquidStateAt(x + dx, y + dy, z + dz);
              if (nearby === undefined || this.air.has(nearby)) return EMPTY;
              return this.textures?.modelFor?.(nearby) === model ? (this.textures.variantFor?.(nearby) ?? 0) + 1 : BLOCKED;
            });
            if (coveredTop && heights.some(height => height < 1)) visible[2] = true;
            const color = stateColor(state);
            for (let f = 0; f < faces.length; f++) {
              if (!visible[f]) continue;
              const rotated = f === 2 && flowUv !== undefined;
              const flowing = rotated || (f !== 2 && f !== 3);
              const corners = faces[f].corners.map((value, i, coords) => {
                if (i % 3 !== 1 || value === 0) return value;
                const cx = coords[i - 1], cz = coords[i + 1];
                return heights[cx === 0 ? cz : 3 - cz];
              });
              const tile = tiles?.[rotated ? 0 : f] ?? -1;
              emit(x, y, z, corners, rotated ? flowUv : undefined, quadOrder, color, tile, liquidMaterial(model, flowing, rotated), f);
            }
            continue;
          }

          if (model === "cross") {
            const color = stateColor(state);
            for (const corners of cross) {
              emit(x, y, z, corners, crossUv, doubleSidedOrder, color, tiles?.[0] ?? -1, material, 0);
            }
            continue;
          }

          if (model !== undefined && model !== "leaves" && model !== "glass" && (model !== "mesh" || mesh)) {
            const color = stateColor(state);
            for (const quad of mesh?.quads ?? this.quadsFor(model, variant)) {
              if (quad.boundary !== undefined && this.hides(model, adjacentAt(x, y, z, quad.boundary))) continue;
              emit(x, y, z, quad.corners, quad.uv, quad.doubleSided ? doubleSidedOrder : quadOrder, color,
                tiles?.[quad.face] ?? -1, material, quad.face);
            }
            continue;
          }

          let color: readonly [number, number, number] | undefined;
          for (let f = 0; f < faces.length; f++) {
            if (this.hides(model, adjacentAt(x, y, z, f))) continue;
            color ??= stateColor(state);
            emit(x, y, z, faces[f].corners, undefined, cubeOrder, color, tiles?.[f] ?? -1, material, f);
          }
        }
      }
    }
    return length ? bytes.subarray(0, length) : null;
  }
}
