import { isProtocol, type Protocol } from "./protocol.js";
import type { ModelQuad } from "./block-models.js";
import { LIQUID_SPRITES, type LiquidAnimations, type LiquidFrame } from "./liquid.js";

export const TILE_SIZE = 16;
export const MAX_COLUMNS = 38;
export const MAX_ROWS = 32;
export const MAX_PNG_BYTES = 1024 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_RANGES = 8192;
export const MAX_ITEM_ICONS = 1024;
export const MAX_ITEM_BLOCKS = 1024;
export const NO_TILE = -1;
export const BREAK_STAGES = 10;

const MODEL_VARIANT_MAX = {
  leaves: 0, cross: 0, crop: 0, glass: 0,
  fence: 15, composter: 8, lantern: 1, torch: 0, rail: 9, stairs: 39, water: 15, lava: 15,
  mesh: 255,
} as const;
export type BlockModel = keyof typeof MODEL_VARIANT_MAX;
const MODELS = Object.keys(MODEL_VARIANT_MAX) as BlockModel[];
const LEGACY_MESHES = new Set(["slab", "wall", "lily_pad", "campfire", "hopper", "chest", "trapdoor"]);
const MAX_MESH_QUADS = 1024;
const MAX_QUADS_PER_VARIANT = 48;

export interface BlockMesh {
  readonly cutout: boolean;
  readonly quads: readonly ModelQuad[];
}

export type FaceTiles = readonly [number, number, number, number, number, number];
type BlockRange = { min: number; max: number; faces: FaceTiles; model?: BlockModel; variant?: number };

export interface Atlas {
  readonly protocol: Protocol;
  readonly image: ImageBitmap;
  readonly columns: number;
  readonly rows: number;
  readonly breakStages?: readonly number[];
  readonly itemIcons?: ReadonlyMap<string, number>;
  readonly itemBlocks?: ReadonlyMap<string, FaceTiles>;
  readonly animations?: LiquidAnimations;
  readonly meshes?: readonly BlockMesh[];
  tilesFor(state: number): FaceTiles | undefined;
  modelFor?(state: number): BlockModel | undefined;
  variantFor?(state: number): number;
  nameFor?(state: number): string | undefined;
  invisibleFor?(state: number): boolean;
  registered?(state: number): boolean;
}

export interface Registry {
  readonly max: number;
  readonly blocks: readonly (readonly [min: number, name: string])[];
}

export interface Manifest {
  readonly protocol: Protocol;
  readonly registry?: Registry;
  readonly invisible?: readonly (readonly [min: number, max: number])[];
  readonly columns: number;
  readonly rows: number;
  readonly breakStages?: readonly number[];
  readonly itemIcons?: ReadonlyMap<string, number>;
  readonly itemBlocks?: ReadonlyMap<string, FaceTiles>;
  readonly animations?: LiquidAnimations;
  readonly meshes?: readonly BlockMesh[];
  readonly ranges: readonly BlockRange[];
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function parseManifest(value: unknown): Manifest {
  const root = value as Record<string, unknown> | null;
  const protocol = root?.protocol;
  if (!root || typeof root !== "object" || !isProtocol(protocol) || root.tileSize !== TILE_SIZE) throw new Error("Unsupported atlas manifest");
  const { columns, rows, blocks } = root;
  if (!isInt(columns, 1, MAX_COLUMNS) || !isInt(rows, 1, MAX_ROWS)) throw new Error("Atlas exceeds bounds");
  if (!Array.isArray(blocks) || blocks.length > MAX_RANGES) throw new Error("Invalid atlas blocks");
  const meshes = parseMeshes(root.models);
  const ranges: BlockRange[] = [];
  const legacy = new Set<BlockRange>();
  for (const block of blocks) {
    const { min, max, faces, model, variant } = (block ?? {}) as Record<string, unknown>;
    if (!isInt(min, 0, 65535) || !isInt(max, min, 65535)) throw new Error("Invalid atlas state range");
    if (!Array.isArray(faces) || faces.length !== 6 || !faces.every(tile => isInt(tile, NO_TILE, columns * rows - 1))) {
      throw new Error("Invalid atlas faces");
    }
    const range: BlockRange = { min, max, faces: faces as unknown as FaceTiles };
    if (typeof model === "string" && LEGACY_MESHES.has(model)) {
      legacy.add(range);
    } else {
      if (model !== undefined) {
        if (typeof model !== "string" || !Object.hasOwn(MODEL_VARIANT_MAX, model)) throw new Error("Invalid atlas block model");
        range.model = model as BlockModel;
      }
      if (variant !== undefined) {
        if (!range.model || !isInt(variant, 0, MODEL_VARIANT_MAX[range.model])) throw new Error("Invalid atlas model variant");
        range.variant = variant;
      }
      if (range.model === "mesh") {
        const mesh = range.variant === undefined ? undefined : meshes?.[range.variant];
        if (!mesh || mesh.quads.some(quad => range.faces[quad.face] === NO_TILE)) throw new Error("Invalid atlas mesh binding");
      }
    }
    ranges.push(range);
  }
  ranges.sort((a, b) => a.min - b.min);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].min <= ranges[i - 1].max) throw new Error("Overlapping atlas ranges");
  const tiles = columns * rows;
  return { protocol, columns, rows, ranges: legacy.size ? ranges.filter(range => !legacy.has(range)) : ranges, meshes, breakStages: parseBreakStages(root.breakStages, tiles),
    itemIcons: parseItemIcons(root.itemIcons, tiles), itemBlocks: parseItemBlocks(root.itemBlocks, tiles), animations: parseAnimations(root.animations, tiles),
    registry: parseRegistry(root.registry), invisible: parseInvisible(root.invisible) };
}

function parseMeshes(value: unknown): readonly BlockMesh[] | undefined {
  if (value === undefined) return undefined;
  const { quads, variants } = (value ?? {}) as Record<string, unknown>;
  if (!Array.isArray(quads) || quads.length > MAX_MESH_QUADS || !Array.isArray(variants)
    || variants.length > MODEL_VARIANT_MAX.mesh + 1) throw new Error("Invalid atlas meshes");
  const vector = (input: unknown, size: number, min: number, max: number): input is number[] =>
    Array.isArray(input) && input.length === size && input.every(value => typeof value === "number" && value >= min && value <= max);
  const faces = quads.map((quad): ModelQuad => {
    if (!Array.isArray(quad) || quad.length !== 4) throw new Error("Invalid atlas quad");
    const [corners, uv, face, boundary] = quad;
    if (!vector(corners, 12, -2, 3) || !vector(uv, 8, 0, 1) || !isInt(face, 0, 5)
      || (boundary !== null && (!isInt(boundary, 0, 5) || !corners.every((coordinate, i) =>
        i % 3 !== (boundary >> 1) || coordinate === 1 - boundary % 2)))) throw new Error("Invalid atlas quad");
    return { corners, uv, face, boundary: boundary ?? undefined };
  });
  return variants.map(variant => {
    if (!Array.isArray(variant) || variant.length !== 2) throw new Error("Invalid atlas mesh variant");
    const [cutout, ids] = variant;
    if (typeof cutout !== "boolean" || !Array.isArray(ids) || ids.length > MAX_QUADS_PER_VARIANT
      || !ids.every(id => isInt(id, 0, faces.length - 1))) throw new Error("Invalid atlas mesh variant");
    return { cutout, quads: ids.map(id => faces[id]) };
  });
}

function parseRegistry(value: unknown): Registry | undefined {
  const { max, blocks } = (value ?? {}) as Record<string, unknown>;
  if (!isInt(max, 0, 65535) || !Array.isArray(blocks) || blocks.length === 0 || blocks.length > MAX_RANGES) return undefined;
  let previous = -1;
  for (const entry of blocks) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isInt(entry[0], previous + 1, max)
      || typeof entry[1] !== "string" || !/^[a-z0-9_]{1,64}$/.test(entry[1])) return undefined;
    previous = entry[0];
  }
  return { max, blocks: blocks as unknown as Registry["blocks"] };
}

function parseInvisible(value: unknown): readonly (readonly [number, number])[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RANGES) return undefined;
  let previous = -1;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isInt(entry[0], previous + 1, 65535) || !isInt(entry[1], entry[0], 65535)) return undefined;
    previous = entry[1];
  }
  return value as unknown as readonly (readonly [number, number])[];
}

export function lookupNames(registry: Registry | undefined): ((state: number) => string | undefined) | undefined {
  if (!registry) return undefined;
  const { blocks, max } = registry;
  return state => {
    if (!Number.isInteger(state) || state < blocks[0][0] || state > max) return undefined;
    let lo = 0, hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (blocks[mid][0] <= state) lo = mid;
      else hi = mid - 1;
    }
    return `minecraft:${blocks[lo][1]}`;
  };
}

export function lookupInvisible(ranges: Manifest["invisible"]): ((state: number) => boolean) | undefined {
  if (!ranges) return undefined;
  return state => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (state < ranges[mid][0]) hi = mid - 1;
      else if (state > ranges[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

function parseAnimations(value: unknown, tiles: number): LiquidAnimations | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const animations: LiquidAnimations = {};
  const input = value as Record<string, unknown>;
  for (const sprite of LIQUID_SPRITES) {
    const sequence = input[sprite];
    if (!Array.isArray(sequence) || sequence.length < 2 || sequence.length > 256) continue;
    const frames: LiquidFrame[] = [];
    for (const frame of sequence) {
      if (!Array.isArray(frame) || frame.length !== 2 || !isInt(frame[0], 0, tiles - 1) || !isInt(frame[1], 1, 1200)) break;
      frames.push([frame[0], frame[1]]);
    }
    if (frames.length === sequence.length) animations[sprite] = frames;
  }
  return LIQUID_SPRITES.some(sprite => animations[sprite]) ? animations : undefined;
}

function parseItemIcons(value: unknown, tiles: number): ReadonlyMap<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_ITEM_ICONS) return undefined;
  const icons = new Map<string, number>();
  for (const [name, tile] of entries) {
    if (!/^[a-z0-9_]{1,64}$/.test(name) || !isInt(tile, 0, tiles - 1)) return undefined;
    icons.set(name, tile);
  }
  return icons;
}

function parseItemBlocks(value: unknown, tiles: number): ReadonlyMap<string, FaceTiles> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_ITEM_BLOCKS) return undefined;
  const blocks = new Map<string, FaceTiles>();
  for (const [name, faces] of entries) {
    if (!/^[a-z0-9_]{1,64}$/.test(name) || !Array.isArray(faces) || faces.length !== 6 || !faces.every(tile => isInt(tile, 0, tiles - 1))) return undefined;
    blocks.set(name, faces as unknown as FaceTiles);
  }
  return blocks;
}

function parseBreakStages(value: unknown, tiles: number): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length !== BREAK_STAGES) return undefined;
  if (!value.every(tile => isInt(tile, 0, tiles - 1))) return undefined;
  return [...value] as number[];
}

export function lookupTiles(manifest: Manifest): (state: number) => FaceTiles | undefined {
  const { ranges } = manifest;
  return state => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const range = ranges[mid];
      if (state < range.min) hi = mid - 1;
      else if (state > range.max) lo = mid + 1;
      else return range.faces;
    }
    return undefined;
  };
}

export function lookupModels(manifest: Manifest): (state: number) => BlockModel | undefined {
  const codes = new Uint8Array(65536);
  for (const { min, max, faces, model } of manifest.ranges) {
    if (!model || (model !== "mesh" && faces.includes(NO_TILE))) continue;
    codes.fill(MODELS.indexOf(model) + 1, min, max + 1);
  }
  return state => {
    const code = Number.isInteger(state) && state >= 0 && state < 65536 ? codes[state] : 0;
    return code ? MODELS[code - 1] : undefined;
  };
}

export function lookupVariants(manifest: Manifest): (state: number) => number {
  const variants = new Uint8Array(65536);
  for (const { min, max, faces, model, variant } of manifest.ranges) {
    if (!model || !variant || (model !== "mesh" && faces.includes(NO_TILE))) continue;
    variants.fill(variant, min, max + 1);
  }
  return state => Number.isInteger(state) ? variants[state] ?? 0 : 0;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error("Atlas file too large");
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("Atlas file too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function checkPngHeader(bytes: Uint8Array, width: number, height: number): void {
  if (bytes.length < 24) throw new Error("Atlas image is not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isIhdr = view.getUint32(12) === 0x49484452;
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b) || view.getUint32(8) !== 13 || !isIhdr) {
    throw new Error("Atlas image is not a PNG");
  }
  if (view.getUint32(16) !== width || view.getUint32(20) !== height) throw new Error("Atlas image does not match its manifest");
}

export interface AtlasLoaderDeps {
  fetch: typeof fetch;
  createImageBitmap: (blob: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;
}

export async function loadAtlas(deps: AtlasLoaderDeps, base = "/local-pack/"): Promise<Atlas> {
  const init: RequestInit = { method: "GET", credentials: "omit", cache: "no-store", redirect: "error" };
  const [jsonBytes, pngBytes] = await Promise.all([
    deps.fetch(`${base}atlas.json`, init).then(r => readBounded(r, MAX_JSON_BYTES)),
    deps.fetch(`${base}atlas.png`, init).then(r => readBounded(r, MAX_PNG_BYTES)),
  ]);
  const manifest = parseManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes)));
  checkPngHeader(pngBytes, manifest.columns * TILE_SIZE, manifest.rows * TILE_SIZE);
  const image = await deps.createImageBitmap(new Blob([pngBytes as BlobPart], { type: "image/png" }), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  if (image.width !== manifest.columns * TILE_SIZE || image.height !== manifest.rows * TILE_SIZE) {
    image.close?.();
    throw new Error("Atlas image does not match its manifest");
  }
  return { protocol: manifest.protocol, image, columns: manifest.columns, rows: manifest.rows, breakStages: manifest.breakStages, itemIcons: manifest.itemIcons, itemBlocks: manifest.itemBlocks,
    animations: manifest.animations, meshes: manifest.meshes, tilesFor: lookupTiles(manifest), modelFor: lookupModels(manifest), variantFor: lookupVariants(manifest),
    ...registryLookups(manifest) };
}

export class ProtocolAtlas {
  private selected: Protocol | null = null;
  private loading: Promise<Atlas | null>;

  constructor(private readonly load: () => Promise<Atlas | null>, private readonly show: (atlas: Atlas | null) => void) {
    this.loading = this.fetch();
  }

  select(protocol: Protocol): void {
    if (protocol === this.selected) return;
    this.selected = protocol;
    this.show(null);
    const loading = this.loading = this.loading.then(atlas => atlas?.protocol === protocol ? atlas : this.fetch());
    void loading.then(atlas => {
      if (this.loading === loading) this.show(atlas?.protocol === protocol ? atlas : null);
    });
  }

  private fetch(): Promise<Atlas | null> {
    return this.load().catch(() => null);
  }
}

function registryLookups(manifest: Manifest): Pick<Atlas, "nameFor" | "invisibleFor" | "registered"> {
  const nameFor = lookupNames(manifest.registry);
  return { nameFor, invisibleFor: lookupInvisible(manifest.invisible), registered: nameFor && (state => nameFor(state) !== undefined) };
}
