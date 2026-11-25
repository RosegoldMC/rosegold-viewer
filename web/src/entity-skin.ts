export const SKIN_SIZE = 64;
export const MAX_SKIN_BYTES = 32 * 1024;
export const DEFAULT_SKINS = ["steve", "alex", "ari", "efe", "kai", "makena", "noor", "sunny", "zuri"] as const;
const KEY = /^[0-9a-f-]{1,64}$/;

export interface SkinPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

export function defaultSkinName(id: number, slim?: boolean): string {
  const hash = Math.imul(id >>> 0 ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  const wide = slim === undefined ? hash % 2 === 0 : !slim;
  return `${wide ? "wide" : "slim"}_${DEFAULT_SKINS[(hash >>> 1) % DEFAULT_SKINS.length]}`;
}

function copyRect(px: Uint8Array, x: number, y: number, dx: number, dy: number, w: number, h: number): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const from = ((y + j) * SKIN_SIZE + x + i) * 4;
      const to = ((y + dy + j) * SKIN_SIZE + (x + dx + w - 1 - i)) * 4;
      px.copyWithin(to, from, from + 4);
    }
  }
}

function opaque(px: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * SKIN_SIZE + x) * 4 + 3] = 255;
}

const LEGACY_LIMBS: readonly (readonly [number, number, number, number, number])[] = [
  [4, 16, 16, 4, 4], [8, 16, 16, 4, 4], [0, 20, 24, 4, 12], [4, 20, 16, 4, 12], [8, 20, 8, 4, 12], [12, 20, 16, 4, 12],
  [44, 16, -8, 4, 4], [48, 16, -8, 4, 4], [40, 20, 0, 4, 12], [44, 20, -8, 4, 12], [48, 20, -16, 4, 12], [52, 20, -8, 4, 12],
];

// Returns a 64x64 RGBA copy with legacy limbs mirrored and base-layer alpha forced opaque, or null for unsupported sizes.
export function normalizeSkin(skin: SkinPixels): Uint8Array | null {
  const { width, height, data } = skin;
  if (width !== SKIN_SIZE || (height !== SKIN_SIZE && height !== 32) || data.length !== width * height * 4) return null;
  const px = new Uint8Array(SKIN_SIZE * SKIN_SIZE * 4);
  px.set(data);
  if (height === 32) for (const [x, y, dx, w, h] of LEGACY_LIMBS) copyRect(px, x, y, dx, 32, w, h);
  opaque(px, 0, 0, 32, 16);
  opaque(px, 0, 16, 64, 32);
  opaque(px, 16, 48, 48, 64);
  return px;
}

export function skinPath(key: string): string | null {
  return KEY.test(key) ? `/local-pack/skins/${key}.png` : null;
}

export interface SkinLoaderDeps {
  fetch: typeof fetch;
  decode: (png: Uint8Array) => Promise<SkinPixels>;
}

// Same-origin local files only; a skin key never selects a remote host.
export async function loadLocalSkin(deps: SkinLoaderDeps, key: string): Promise<Uint8Array | null> {
  const path = skinPath(key);
  if (!path) return null;
  const response = await deps.fetch(path, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", mode: "same-origin" });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_SKIN_BYTES || bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!signature.every((b, i) => bytes[i] === b) || view.getUint32(12) !== 0x49484452) return null;
  if (view.getUint32(16) !== SKIN_SIZE || (view.getUint32(20) !== SKIN_SIZE && view.getUint32(20) !== 32)) return null;
  return normalizeSkin(await deps.decode(bytes));
}
