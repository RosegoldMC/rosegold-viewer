import type { PathOverlay, SectionPosition, Vec3 } from "./renderer.js";
import { SECTION_VOLUME } from "./terrain.js";

export const MAX_BATCH_BYTES = 16 * 1024;
export const MAX_SESSION_BYTES = 256;

const maxEntities = 24;
const maxEntityAxis = 30_000_000;
const maxPaths = 8;
const maxInventorySlots = 160;
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
  ice: boolean;
  breaking?: { position: SectionPosition; stage: number } | null;
}

export interface InventorySnapshot {
  menu: number;
  revision: number;
  layout: string;
  slots: (HudSlot | null)[];
  cursor: HudSlot | null;
  pending: boolean;
  ready: boolean;
}

export type DebugTarget =
  | { kind: "block"; position: SectionPosition; id: string | null; props: Record<string, string> | null }
  | { kind: "entity"; id: string | null };

export interface EntityAppearance {
  model: "classic" | "slim";
  key: string;
}

export interface EntitySnapshot {
  id: number;
  position: Vec3;
  species: string;
  yaw: number;
  pitch: number;
  pose: number;
  item?: { name: string; count: number };
  appearance?: EntityAppearance;
}

export interface DebugInfo {
  feet: Vec3;
  rotation: readonly [yaw: number, pitch: number];
  dimension: string;
  time: number | null;
  target: DebugTarget | null;
}

export interface ChatInfo {
  epoch: number;
  entries: [number, string][];
}

export type ControlMode = "available" | "play" | "pause" | "inventory";
export type Checkpoint = "none" | "pending" | "parked";

export interface ControlInfo {
  grant: number;
  ack: number;
  mode: ControlMode;
  canReturn: boolean;
  canPlay: boolean;
  canResume: boolean;
  canRestart: boolean;
  canChat: boolean;
  chatSupported?: boolean;
  checkpoint: Checkpoint;
  marker?: Vec3 | null;
  inventory?: InventorySnapshot | null;
}

export type SectionUpdate = {
  position: SectionPosition;
} & ({ kind: "states"; states: Uint16Array } | { kind: "air" | "unloaded" });

export type TerrainBatch = Cursor & (
  { status: "waiting" | "unsupported"; paths?: never; entities?: never } |
  { status: "ready"; yaw: number; paths?: PathOverlay[]; entities?: EntitySnapshot[] }
) & {
  center?: SectionPosition;
  eye?: Vec3;
  look?: Vec3;
  air?: number[];
  section?: SectionUpdate;
  hud?: Hud;
  debug?: DebugInfo;
  control?: ControlInfo | null;
  chat?: ChatInfo;
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

function entityName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || /[^a-z0-9_]/.test(value)) return invalid();
  return value;
}

function decodeEntities(value: unknown): EntitySnapshot[] {
  if (!Array.isArray(value) || value.length > maxEntities) return invalid();
  const ids = new Set<number>();
  return value.map(entry => {
    const { id, position: point, species: rawSpecies, yaw, pitch, pose, item, appearance } = object(entry);
    const species = entityName(rawSpecies);
    const key = integer(id, 1, Number.MAX_SAFE_INTEGER);
    if (ids.has(key)) return invalid();
    ids.add(key);
    const where = vec3(point);
    if (!where.every(axis => Math.abs(axis) <= maxEntityAxis)) return invalid();
    if (typeof yaw !== "number" || !Number.isFinite(yaw) || yaw < 0 || yaw >= 360) return invalid();
    if (typeof pitch !== "number" || !Number.isFinite(pitch) || pitch < -180 || pitch >= 180) return invalid();
    const entity: EntitySnapshot = { id: key, position: where, species, yaw, pitch, pose: unsigned(pose, 0xFFFFFFFF) };
    if (item !== undefined) {
      if (species !== "item") return invalid();
      const { name, count } = object(item);
      entity.item = { name: entityName(name), count: integer(count, 1, 999) };
    }
    if (appearance !== undefined) {
      if (species !== "player") return invalid();
      const { model, key } = object(appearance);
      if (model !== "classic" && model !== "slim") return invalid();
      if (typeof key !== "string" || (key !== `default-${model}` && (key.length !== 64 || /[^0-9a-f]/.test(key)))) return invalid();
      entity.appearance = { model, key };
    } else if (species === "player") {
      return invalid();
    }
    return entity;
  });
}

function decodeHud(value: unknown): Hud {
  const { health, food, selected, slots, mining, breaking, ice } = object(value);
  if (typeof health !== "number" || !Number.isFinite(health) || health < 0 || health > 2048) return invalid();
  if (!Array.isArray(slots) || slots.length !== 9) return invalid();
  const decoded: Hud = {
    health,
    food: integer(food, 0, 20),
    selected: integer(selected, 0, 8),
    slots: slots.map(stack),
    mining: mining === null ? null : integer(mining, 0, 99),
    ice: ice === true,
  };
  if (breaking !== undefined) {
    if (breaking === null) {
      decoded.breaking = null;
    } else {
      const target = object(breaking);
      decoded.breaking = { position: position(target.position), stage: integer(target.stage, 0, 9) };
    }
  }
  return decoded;
}

function stack(entry: unknown): HudSlot | null {
  if (entry === null) return null;
  const { item, count } = object(entry);
  if (typeof item !== "string" || !/^[a-z0-9_]{1,64}$/.test(item)) return invalid();
  return { item, count: integer(count, 1, 999) };
}

function pair(entry: unknown): HudSlot | null {
  if (entry === null) return null;
  if (!Array.isArray(entry) || entry.length !== 2) return invalid();
  const [item, count] = entry;
  if (typeof item !== "string" || !/^[a-z0-9_]{1,64}$/.test(item)) return invalid();
  return { item, count: integer(count, 1, 999) };
}

function flag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") return invalid();
  return value;
}

const maxDebugCoordinate = 30_000_000 * 4;

function registryId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value) || value.length > 64) return invalid();
  return value;
}

function decodeDebug(value: unknown): DebugInfo {
  const { feet, rotation, dimension, time, target } = object(value);
  if (!Array.isArray(rotation) || rotation.length !== 2 || !rotation.every(Number.isFinite)) return invalid();
  if (Math.abs(rotation[0]) > 1e7 || Math.abs(rotation[1]) > 90) return invalid();
  const position3 = vec3(feet);
  if (!position3.every(n => Math.abs(n) <= maxDebugCoordinate)) return invalid();
  const name = registryId(dimension);
  if (name === null) return invalid();
  const decoded: DebugInfo = {
    feet: position3,
    rotation: [rotation[0], rotation[1]],
    dimension: name,
    time: time === null ? null : integer(time, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    target: null,
  };
  if (target === null) return decoded;
  const hit = object(target);
  if (hit.kind === "entity") {
    decoded.target = { kind: "entity", id: registryId(hit.id) };
  } else if (hit.kind === "block") {
    const where = position(hit.position);
    let props: Record<string, string> | null = null;
    if (hit.props !== null) {
      const entries = Object.entries(object(hit.props));
      if (entries.length > 16) return invalid();
      props = Object.create(null) as Record<string, string>;
      for (const [key, entry] of entries) {
        if (!/^[a-z0-9_]{1,32}$/.test(key) || typeof entry !== "string" || !/^[a-z0-9_]{1,32}$/.test(entry)) return invalid();
        props[key] = entry;
      }
    }
    decoded.target = { kind: "block", position: where, id: registryId(hit.id), props };
  } else {
    return invalid();
  }
  return decoded;
}

function decodeInventory(value: unknown): InventorySnapshot | null {
  if (value === null) return null;
  const { menu, revision, layout, slots, cursor, pending, ready } = object(value);
  if (typeof layout !== "string" || !/^[a-z0-9_]{1,32}$/.test(layout)) return invalid();
  if (!Array.isArray(slots) || slots.length > maxInventorySlots || typeof pending !== "boolean") return invalid();
  return { menu: unsigned(menu, 0xFFFFFFFF), revision: unsigned(revision, 0xFFFFFFFF), layout, slots: slots.map(pair), cursor: pair(cursor), pending, ready: ready === undefined ? true : flag(ready) };
}

function decodeControl(value: unknown): ControlInfo | null {
  if (value === null) return null;
  const { grant, ack, mode, canPlay, canReturn, canResume, canRestart, canChat, chatSupported, checkpoint, marker, inventory } = object(value);
  if (mode !== "available" && mode !== "play" && mode !== "pause" && mode !== "inventory") return invalid();
  if (checkpoint !== undefined && checkpoint !== "none" && checkpoint !== "pending" && checkpoint !== "parked") return invalid();
  const control: ControlInfo = {
    grant: unsigned(grant, 0xFFFFFFFF), ack: unsigned(ack, 0xFFFFFFFF), mode,
    canReturn: flag(canReturn), canPlay: canPlay === undefined ? true : flag(canPlay), canResume: flag(canResume), canRestart: flag(canRestart), canChat: flag(canChat), chatSupported: chatSupported === undefined ? true : flag(chatSupported), checkpoint: checkpoint ?? "none",
  };
  if (marker !== undefined) control.marker = marker === null ? null : vec3(marker);
  if (inventory !== undefined) control.inventory = decodeInventory(inventory);
  return control;
}

function decodeChat(value: unknown): ChatInfo {
  const { epoch, entries } = object(value);
  if (!Array.isArray(entries) || entries.length > 16) return invalid();
  return {
    epoch: unsigned(epoch, 0xFFFFFFFF),
    entries: entries.map((entry): [number, string] => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[1] !== "string" || entry[1].length > 2048) return invalid();
      return [unsigned(entry[0], 0xFFFFFFFF), entry[1]];
    }),
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
    if (header.entities !== undefined) batch.entities = decodeEntities(header.entities);
  } else {
    if (header.paths !== undefined || header.entities !== undefined) return invalid();
    batch = { ...cursor, status };
  }
  if (header.hud !== undefined) {
    if (status !== "ready") return invalid();
    batch.hud = decodeHud(header.hud);
  }
  if (header.debug !== undefined) {
    if (status !== "ready") return invalid();
    batch.debug = decodeDebug(header.debug);
  }
  if (header.control !== undefined) {
    if (status !== "ready") return invalid();
    batch.control = decodeControl(header.control);
  }
  if (header.chat !== undefined) {
    if (status !== "ready") return invalid();
    batch.chat = decodeChat(header.chat);
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
