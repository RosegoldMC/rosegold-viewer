import { formatDebug, type DebugView } from "./debug-format.js";
import type { DebugInfo, TerrainBatch } from "./wire.js";

export interface DebugEnvironment {
  now(): number;
  frame(callback: () => void): number;
  cancel(handle: number): void;
  control(): string;
  sections(): number | null;
  gpu(): string | null;
  viewport(): DebugView["viewport"];
}

const renderInterval = 250;
const fpsWindow = 1000;

export class ViewerDebug {
  private open = false;
  private epoch: number | null = null;
  private info: DebugInfo | null = null;
  private feed = "detached";
  private handle: number | null = null;
  private windowStart = 0;
  private frames = 0;
  private lastFrame = 0;
  private worst = 0;
  private total = 0;
  private fps: DebugView["fps"] = null;
  private lastRender = -Infinity;
  private gpuName: string | null | undefined;
  private lastText = "";

  constructor(
    private readonly left: HTMLElement,
    private readonly right: HTMLElement,
    private readonly environment: DebugEnvironment,
  ) {}

  get enabled(): boolean {
    return this.open;
  }

  toggle(): boolean {
    this.open = !this.open;
    this.left.parentElement!.hidden = !this.open;
    if (this.open) this.start();
    else this.stop();
    return this.open;
  }

  requested(): boolean {
    return this.open;
  }

  setStatus(status: string): void {
    this.feed = status;
    if (status !== "ready") this.clearData();
    this.render(true);
  }

  reset(): void {
    this.clearData();
    this.render(true);
  }

  apply(batch: TerrainBatch): void {
    if (batch.status !== "ready" || batch.epoch !== this.epoch) {
      this.clearData();
      if (batch.status !== "ready") return;
      this.epoch = batch.epoch;
    }
    if (batch.debug) this.info = batch.debug;
  }

  private clearData(): void {
    this.epoch = null;
    this.info = null;
  }

  private start(): void {
    this.windowStart = this.lastFrame = this.environment.now();
    this.frames = this.total = this.worst = 0;
    this.fps = null;
    this.lastRender = -Infinity;
    this.render(true);
    this.tick();
  }

  private stop(): void {
    if (this.handle !== null) this.environment.cancel(this.handle);
    this.handle = null;
    this.lastText = "";
    this.left.replaceChildren();
    this.right.replaceChildren();
  }

  private tick(): void {
    this.handle = this.environment.frame(() => {
      this.handle = null;
      if (!this.open) return;
      const now = this.environment.now();
      const delta = now - this.lastFrame;
      this.lastFrame = now;
      this.frames++;
      this.total += delta;
      this.worst = Math.max(this.worst, delta);
      if (now - this.windowStart >= fpsWindow) {
        this.fps = {
          fps: Math.round(this.frames * 1000 / (now - this.windowStart)),
          average: this.total / this.frames,
          worst: this.worst,
        };
        this.windowStart = now;
        this.frames = this.total = this.worst = 0;
      }
      this.render(false);
      this.tick();
    });
  }

  private render(force: boolean): void {
    if (!this.open) return;
    const now = this.environment.now();
    if (!force && now - this.lastRender < renderInterval) return;
    this.lastRender = now;
    if (this.gpuName === undefined && this.feed === "ready") {
      const name = this.environment.gpu();
      if (name !== null) this.gpuName = name;
    }
    const lines = formatDebug({
      feed: this.feed,
      control: this.environment.control(),
      info: this.info,
      fps: this.fps,
      sections: this.environment.sections(),
      gpu: this.gpuName ?? null,
      viewport: this.environment.viewport(),
    });
    const text = JSON.stringify(lines);
    if (text === this.lastText) return;
    this.lastText = text;
    fill(this.left, lines.left);
    fill(this.right, lines.right);
  }
}

function fill(column: HTMLElement, lines: readonly string[]): void {
  const document = column.ownerDocument;
  column.replaceChildren(...lines.map(line => {
    const row = document.createElement("div");
    row.className = line === "" ? "gap" : "line";
    row.textContent = line;
    return row;
  }));
}
