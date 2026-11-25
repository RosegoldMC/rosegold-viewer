import type { BreakingBlock, PathOverlay, SectionPosition, Vec3 } from "./renderer.js";
import { sectionKey } from "./terrain.js";
import type { EntitySink } from "./entity-glue.js";
import type { TerrainBatch } from "./wire.js";

type TerrainSink = Pick<import("./renderer.js").TerrainRenderer,
  "replaceSection" | "removeSection" | "setPose" | "setPaths" | "setBreaking" | "clear" | "dispose">;
type EntityFactory = (renderer: TerrainSink) => EntitySink | null;

function inWindow(position: SectionPosition, center: SectionPosition): boolean {
  return position.every((value, axis) => Math.abs(value - center[axis]) <= 2);
}

export class ViewerTerrain {
  private renderer: TerrainSink | null = null;
  private palette: string | null = null;
  private hasAir = false;
  private epoch: number | null = null;
  private center: SectionPosition | null = null;
  private eye: Vec3 | null = null;
  private look: Vec3 | null = null;
  private paths: PathOverlay[] = [];
  private marker: Vec3 | null = null;
  private dirty = false;
  private readonly displayed = new Map<string, SectionPosition>();

  private entities: EntitySink | null = null;

  constructor(private readonly createRenderer: (air: number[]) => TerrainSink, private readonly createEntities?: EntityFactory) {}

  get sectionCount(): number {
    return this.displayed.size;
  }

  setBreaking(value: BreakingBlock | null): void {
    this.renderer?.setBreaking(value);
  }

  reset(): void {
    if (this.epoch !== null) this.renderer?.clear();
    this.epoch = null;
    this.center = this.eye = this.look = null;
    this.hasAir = false;
    this.paths = [];
    this.marker = null;
    this.dirty = false;
    this.displayed.clear();
  }

  setMarker(point: Vec3 | null): void {
    const same = point === this.marker || (point && this.marker && point.every((v, i) => v === this.marker![i]));
    if (same) return;
    this.marker = point;
    this.dirty = true;
    this.syncPaths();
  }

  private syncPaths(): void {
    if (this.hasAir && this.dirty) {
      const marker = this.marker ? [{ name: "intervention", color: 0xFF4FD8, points: [this.marker] }] : [];
      this.renderer?.setPaths([...this.paths, ...marker]);
      this.dirty = false;
    }
  }

  apply(batch: TerrainBatch): void {
    if (batch.status !== "ready" || batch.epoch !== this.epoch) {
      this.reset();
      if (batch.status !== "ready") return;
      this.epoch = batch.epoch;
    }

    if (batch.air) {
      const air = [...new Set(batch.air)].sort((a, b) => a - b);
      const palette = air.join(",");
      if (this.hasAir && this.palette !== palette) throw new Error("Air IDs changed without a world reset");
      if (this.palette !== palette) {
        this.renderer?.dispose();
        this.renderer = this.createRenderer(air);
        this.entities = this.createEntities?.(this.renderer) ?? null;
        this.palette = palette;
      }
      this.hasAir = true;
    }

    if (batch.center) {
      this.center = batch.center;
      for (const [key, position] of this.displayed) {
        if (!inWindow(position, this.center)) {
          this.renderer?.removeSection(position);
          this.displayed.delete(key);
        }
      }
    }
    if (batch.eye) this.eye = batch.eye;
    if (batch.look) this.look = batch.look;
    if (this.eye && this.look && this.hasAir) this.renderer?.setPose(this.eye, this.look, batch.yaw);

    if (batch.paths !== undefined) {
      this.paths = batch.paths;
      this.dirty = true;
    }
    this.syncPaths();
    if (batch.entities !== undefined) this.entities?.replaceAll(batch.entities);

    const { section } = batch;
    if (!section) return;
    if (!this.center || !this.renderer || !this.hasAir) throw new Error("Missing terrain metadata");
    if (!inWindow(section.position, this.center)) return;

    const key = sectionKey(section.position);
    if (section.kind === "states") {
      this.renderer.replaceSection(section.position, section.states);
      this.displayed.set(key, section.position);
    } else {
      if (section.kind === "air") this.renderer.replaceSection(section.position, null);
      else this.renderer.removeSection(section.position);
      this.displayed.delete(key);
    }
  }
}
