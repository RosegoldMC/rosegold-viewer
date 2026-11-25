import { TILE_SIZE, type Atlas } from "./atlas.js";
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

export interface TutorialCue {
  readonly key: string;
  readonly heading: string;
  readonly text: string;
  readonly item: string;
}

const tutorialCues: Record<string, TutorialCue> = {
  "tutorial-ready": { key: "ready", heading: "Welcome to the orchard", text: "Watch the bot get ready. It will head for the wheat field.", item: "wooden_hoe" },
  "tutorial-wheat": { key: "wheat", heading: "Harvest the wheat", text: "The bot breaks the ripe wheat, then replants it.", item: "wheat" },
  "tutorial-oak": { key: "oak", heading: "Chop the oak", text: "Next it chops the oak tree, working from its original base.", item: "oak_log" },
  "tutorial-descent": { key: "descent", heading: "Head underground", text: "The bot descends toward the copper vein.", item: "stone_pickaxe" },
  "tutorial-copper": { key: "copper", heading: "Mine the copper", text: "It breaks the copper ore.", item: "raw_copper" },
  "tutorial-return": { key: "return", heading: "Back to the orchard", text: "The ore is broken. The bot climbs back to the surface.", item: "copper_ingot" },
  "tutorial-done": { key: "done", heading: "Tutorial complete", text: "That is the loop: harvest and plant again, chop, mine, return.", item: "golden_apple" },
};

export function tutorialCue(paths: readonly { readonly name: string }[] | undefined): TutorialCue | null {
  if (!paths) return null;
  for (const path of paths) {
    if (Object.hasOwn(tutorialCues, path.name)) return tutorialCues[path.name];
  }
  return null;
}

interface CueSink {
  show(cue: TutorialCue | null): void;
}

export class ViewerTutorial {
  private epoch: number | null = null;
  private current: TutorialCue | null = null;

  constructor(private readonly sink: CueSink) {}

  reset(): void {
    this.epoch = null;
    this.set(null);
  }

  apply(batch: TerrainBatch): void {
    if (batch.status !== "ready" || batch.epoch !== this.epoch) {
      this.reset();
      if (batch.status !== "ready") return;
      this.epoch = batch.epoch;
    }
    if (batch.paths === undefined) return;
    this.set(tutorialCue(batch.paths));
  }

  private set(cue: TutorialCue | null): void {
    if (cue?.key === this.current?.key) return;
    this.current = cue;
    this.sink.show(cue);
  }
}

export interface IconContext {
  imageSmoothingEnabled: boolean;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: any, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

export interface IconCanvas {
  hidden: boolean | string;
  getContext(type: "2d"): IconContext | null;
}

type IconAtlas = Pick<Atlas, "image" | "columns" | "rows" | "itemIcons">;

export function itemIconTile(atlas: IconAtlas | null | undefined, item: string | undefined): number | undefined {
  if (!atlas || item === undefined) return undefined;
  const tile = atlas.itemIcons?.get(item);
  return tile !== undefined && tile >= 0 && tile < atlas.columns * atlas.rows ? tile : undefined;
}

export function drawItemIcon(canvas: IconCanvas, atlas: IconAtlas | null | undefined, item: string | undefined): boolean {
  const tile = itemIconTile(atlas, item);
  let drawn = false;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    if (tile !== undefined && atlas) {
      context.imageSmoothingEnabled = false;
      try {
        context.drawImage(atlas.image, (tile % atlas.columns) * TILE_SIZE, Math.floor(tile / atlas.columns) * TILE_SIZE,
          TILE_SIZE, TILE_SIZE, 0, 0, TILE_SIZE, TILE_SIZE);
        drawn = true;
      } catch {
        context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      }
    }
  }
  canvas.hidden = !drawn;
  return drawn;
}

export class ViewerMenu {
  private ready = false;
  private open = false;

  get visible(): boolean {
    return !this.ready || this.open;
  }

  get available(): boolean {
    return this.ready;
  }

  update(status: string): void {
    const ready = status === "ready";
    if (!ready || !this.ready) this.open = false;
    this.ready = ready;
  }

  toggle(): boolean {
    if (!this.ready) return false;
    this.open = !this.open;
    return true;
  }
}

export interface EscapeEvent {
  readonly key: string;
  readonly repeat: boolean;
  readonly defaultPrevented: boolean;
  readonly isComposing?: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function isMenuEscape(event: EscapeEvent): boolean {
  return event.key === "Escape" && !event.repeat && !event.defaultPrevented && !event.isComposing
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}
