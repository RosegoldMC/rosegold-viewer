import type { PathOverlay, SectionPosition, Vec3 } from "./renderer.js";
import { SECTION_VOLUME } from "./terrain.js";

export const MAX_BATCH_BYTES = 16 * 1024;
export const MAX_SESSION_BYTES = 256;

const maxPaths = 8;
const maxPathPoints = 128;
const pathScale = 256;
const maxPathCoordinate = 30_000_000 * pathScale;

export interface Cursor {
  epoch: number;
  seq: number;
}

export interface HudSlot {
  item: string;
  count: number;
}

export interface Hud {
  health: number;
  food: number;
  selected: number;
  slots: (HudSlot | null)[];
  mining: number | null;
}

export type SectionUpdate = {
  position: SectionPosition;
} & ({ kind: "states"; states: Uint16Array } | { kind: "air" | "unloaded" });

export type TerrainBatch = Cursor & (
  { status: "waiting" | "unsupported"; paths?: never } | { status: "ready"; yaw: number; paths?: PathOverlay[] }
) & {
  center?: SectionPosition;
  eye?: Vec3;
  look?: Vec3;
  air?: number[];
  section?: SectionUpdate;
  hud?: Hud;
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalid(): never {
  throw new Error("Invalid viewer reply");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function json(bytes: Uint8Array): Record<string, unknown> {
  return object(JSON.parse(utf8.decode(bytes)));
}

function unsigned(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}

function vec3(value: unknown): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return invalid();
  return [value[0], value[1], value[2]];
}

function position(value: unknown): SectionPosition {
  const coordinates = vec3(value);
  if (!coordinates.every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)) return invalid();
  return coordinates;
}

function decodePaths(value: unknown): PathOverlay[] {
  if (!Array.isArray(value) || value.length > maxPaths) return invalid();
  const names = new Set<string>();
  let total = 0;
  return value.map(entry => {
    const { name, color, points } = object(entry);
    if (typeof name !== "string" || name.length === 0 || name.length > 32 || /[^A-Za-z0-9_-]/.test(name) || names.has(name)) return invalid();
    names.add(name);
    if (!Array.isArray(points) || points.length === 0 || (total += points.length) > maxPathPoints) return invalid();
    return {
      name,
      color: unsigned(color, 0xFFFFFF),
      points: points.map((point): Vec3 => {
        const coordinates = vec3(point);
        if (!coordinates.every(n => Number.isSafeInteger(n) && Math.abs(n) <= maxPathCoordinate)) return invalid();
        return [coordinates[0] / pathScale, coordinates[1] / pathScale, coordinates[2] / pathScale];
      }),
    };
  });
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}

function decodeHud(value: unknown): Hud {
  const { health, food, selected, slots, mining } = object(value);
  if (typeof health !== "number" || !Number.isFinite(health) || health < 0 || health > 2048) return invalid();
  if (!Array.isArray(slots) || slots.length !== 9) return invalid();
  return {
    health,
    food: integer(food, 0, 20),
    selected: integer(selected, 0, 8),
    slots: slots.map(entry => {
      if (entry === null) return null;
      const { item, count } = object(entry);
      if (typeof item !== "string" || !/^[a-z0-9_]{1,64}$/.test(item)) return invalid();
      return { item, count: integer(count, 1, 999) };
    }),
    mining: mining === null ? null : integer(mining, 0, 99),
  };
}

export function decodeLease(bytes: Uint8Array): string {
  const { lease } = json(bytes);
  if (typeof lease !== "string" || !/^(?:[0-9a-f]{2}){1,64}$/i.test(lease)) return invalid();
  return lease;
}

export function decodeBatch(bytes: Uint8Array): TerrainBatch {
  if (bytes.length < 2 || bytes.length > MAX_BATCH_BYTES) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerEnd = 2 + view.getUint16(0, true);
  if (headerEnd > bytes.length) return invalid();

  const header = json(bytes.subarray(2, headerEnd));
  const status = header.status;
  if (status !== "waiting" && status !== "unsupported" && status !== "ready") return invalid();
  const cursor = { epoch: unsigned(header.epoch), seq: unsigned(header.seq) };
  let batch: TerrainBatch;
  if (status === "ready") {
    const yaw = header.yaw;
    if (typeof yaw !== "number" || !Number.isFinite(yaw)) return invalid();
    batch = { ...cursor, status, yaw };
    if (header.paths !== undefined) batch.paths = decodePaths(header.paths);
  } else {
    if (header.paths !== undefined) return invalid();
    batch = { ...cursor, status };
  }
  if (header.hud !== undefined) {
    if (status !== "ready") return invalid();
    batch.hud = decodeHud(header.hud);
  }
  if (header.center !== undefined) batch.center = position(header.center);
  if (header.eye !== undefined) batch.eye = vec3(header.eye);
  if (header.look !== undefined) {
    batch.look = vec3(header.look);
    const length = Math.hypot(...batch.look);
    if (!Number.isFinite(length) || length === 0) return invalid();
  }
  if (header.air !== undefined) {
    if (!Array.isArray(header.air)) return invalid();
    batch.air = header.air.map(id => unsigned(id, 65535));
  }
  if (header.section !== undefined) {
    if (status !== "ready") return invalid();
    const section = object(header.section);
    const where = position(section.position);
    if (section.kind === "states") {
      if (bytes.length - headerEnd !== SECTION_VOLUME * 2) return invalid();
      const states = new Uint16Array(SECTION_VOLUME);
      for (let i = 0; i < states.length; i++) states[i] = view.getUint16(headerEnd + i * 2, true);
      batch.section = { position: where, kind: "states", states };
      return batch;
    }
    if (section.kind !== "air" && section.kind !== "unloaded") return invalid();
    batch.section = { position: where, kind: section.kind };
  }
  if (bytes.length !== headerEnd) return invalid();
  return batch;
}

export async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return bytes.subarray(0, length);
      if (length + value.length > limit) {
        await reader.cancel();
        return invalid();
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}
