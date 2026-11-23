import type { Hud, TerrainBatch } from "./wire.js";

interface HudSink {
  show(hud: Hud | null): void;
}

export function itemLabel(item: string): string {
  return item.split("_").filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
}

export function heldLabel(hud: Hud): string {
  const slot = hud.slots[hud.selected];
  if (!slot) return "Empty hand";
  return slot.count > 1 ? `${itemLabel(slot.item)} ×${slot.count}` : itemLabel(slot.item);
}

export class ViewerHud {
  private epoch: number | null = null;
  private current: Hud | null = null;

  constructor(private readonly sink: HudSink) {}

  reset(): void {
    this.epoch = null;
    if (this.current) this.sink.show(null);
    this.current = null;
  }

  apply(batch: TerrainBatch): void {
    if (batch.status !== "ready" || batch.epoch !== this.epoch) {
      this.reset();
      if (batch.status !== "ready") return;
      this.epoch = batch.epoch;
    }
    if (!batch.hud) return;
    this.current = batch.hud;
    this.sink.show(batch.hud);
  }
}
