import { SUPPORTED_KINDS, type EntityKind } from "./entity-geometry.js";

export const MAX_ENTITIES = 256;
export const INTERPOLATION_MS = 100;
export const SNAP_DISTANCE = 8;
const MAX_COORDINATE = 30_000_000;
const TICK_MS = 50;

export interface EntityState {
  id: number;
  kind: EntityKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  headYaw?: number;
  item?: string;
  count?: number;
  color?: number;
  skin?: string;
  slim?: boolean;
}

export interface DrawnEntity extends EntityState {
  headYaw: number;
  age: number;
  swing: number;
  amount: number;
}

function finite(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

export function sanitizeEntity(value: unknown): EntityState | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  const { id, kind } = e;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return null;
  if (typeof kind !== "string" || !(SUPPORTED_KINDS as readonly string[]).includes(kind)) return null;
  if (!finite(e.x, MAX_COORDINATE) || !finite(e.y, MAX_COORDINATE) || !finite(e.z, MAX_COORDINATE)) return null;
  if (!finite(e.yaw, 1e6) || !finite(e.pitch, 1e6)) return null;
  const clean: EntityState = { id, kind: kind as EntityKind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: Math.max(-90, Math.min(90, e.pitch)) };
  if (e.headYaw !== undefined) {
    if (!finite(e.headYaw, 1e6)) return null;
    clean.headYaw = e.headYaw;
  }
  if (kind === "item") {
    if (typeof e.item !== "string" || !/^[a-z0-9_]{1,64}$/.test(e.item)) return null;
    const count = e.count ?? 1;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 999) return null;
    clean.item = e.item;
    clean.count = count;
  }
  if (e.color !== undefined) {
    if (typeof e.color !== "number" || !Number.isInteger(e.color) || e.color < 0 || e.color > 15) return null;
    clean.color = e.color;
  }
  if (e.skin !== undefined) {
    if (typeof e.skin !== "string" || !/^[0-9a-f-]{1,64}$/.test(e.skin)) return null;
    clean.skin = e.skin;
  }
  if (e.slim !== undefined) {
    if (typeof e.slim !== "boolean") return null;
    clean.slim = e.slim;
  }
  return clean;
}

interface Pose6 { x: number; y: number; z: number; yaw: number; pitch: number; headYaw: number }

interface Tracked {
  state: EntityState;
  from: Pose6;
  to: Pose6;
  start: number;
  born: number;
  last: Pose6 | null;
  lastSample: number;
  swing: number;
  amount: number;
}

function wrap(degrees: number): number {
  const r = ((degrees + 180) % 360 + 360) % 360 - 180;
  return r;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + wrap(b - a) * t;
}

function poseOf(state: EntityState): Pose6 {
  return { x: state.x, y: state.y, z: state.z, yaw: state.yaw, pitch: state.pitch, headYaw: state.headYaw ?? state.yaw };
}

export class EntityStore {
  private readonly entities = new Map<number, Tracked>();

  constructor(private readonly clock: () => number = () => performance.now()) {}

  get size(): number {
    return this.entities.size;
  }

  clear(): void {
    this.entities.clear();
  }

  ids(): number[] {
    return [...this.entities.keys()];
  }

  remove(ids: Iterable<number>): void {
    for (const id of ids) this.entities.delete(id);
  }

  // Lifetime belongs to the feed: a full snapshot replaces the set, and an epoch reset or detach clears it.
  replaceAll(list: readonly unknown[]): void {
    const states: EntityState[] = [];
    const seen = new Set<number>();
    for (const raw of list) {
      const state = sanitizeEntity(raw);
      if (state && !seen.has(state.id)) {
        seen.add(state.id);
        states.push(state);
      }
    }
    for (const id of [...this.entities.keys()]) if (!seen.has(id)) this.entities.delete(id);
    this.apply(states);
  }

  upsert(list: readonly unknown[]): void {
    const states: EntityState[] = [];
    for (const raw of list) {
      const state = sanitizeEntity(raw);
      if (state) states.push(state);
    }
    this.apply(states);
  }

  skinKeys(): Set<string> {
    const keys = new Set<string>();
    for (const { state } of this.entities.values()) if (state.skin) keys.add(state.skin);
    return keys;
  }

  private apply(states: readonly EntityState[]): void {
    const now = this.clock();
    for (const state of states) {
      const existing = this.entities.get(state.id);
      if (!existing && this.entities.size >= MAX_ENTITIES) continue;
      const target = poseOf(state);
      if (!existing) {
        this.entities.set(state.id, { state, from: target, to: target, start: now, born: now, last: null, lastSample: now, swing: 0, amount: 0 });
        continue;
      }
      const shown = this.pose(existing, now);
      const jump = Math.hypot(target.x - shown.x, target.y - shown.y, target.z - shown.z);
      existing.from = state.kind !== existing.state.kind || jump > SNAP_DISTANCE ? target : shown;
      if (existing.from === target) existing.last = null;
      existing.to = target;
      existing.start = now;
      existing.state = state;
    }
  }

  private pose(entity: Tracked, now: number): Pose6 {
    const t = Math.max(0, Math.min(1, (now - entity.start) / INTERPOLATION_MS));
    const { from, to } = entity;
    return {
      x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t,
      yaw: lerpAngle(from.yaw, to.yaw, t), pitch: from.pitch + (to.pitch - from.pitch) * t, headYaw: lerpAngle(from.headYaw, to.headYaw, t),
    };
  }

  sample(): DrawnEntity[] {
    const now = this.clock();
    const out: DrawnEntity[] = [];
    for (const entity of this.entities.values()) {
      const pose = this.pose(entity, now);
      if (entity.last) {
        const ticks = Math.max(0.2, (now - entity.lastSample) / TICK_MS);
        const speed = Math.hypot(pose.x - entity.last.x, pose.z - entity.last.z) / ticks;
        const amount = Math.min(speed * 4, 1);
        entity.amount += (amount - entity.amount) * 0.4;
        entity.swing += amount * ticks;
      }
      entity.last = pose;
      entity.lastSample = now;
      out.push({ ...entity.state, ...pose, age: (now - entity.born) / TICK_MS, swing: entity.swing, amount: entity.amount < 0.01 ? 0 : entity.amount });
    }
    return out;
  }
}
