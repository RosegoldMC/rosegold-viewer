import { CELL, geometry, type ClickOp } from "./inventory.js";
import type { Atlas } from "./atlas.js";
import { drawItemIcon, itemLabel } from "./viewer-hud.js";
import type { HudSlot, InventorySnapshot } from "./wire.js";

interface InventoryEvents {
  click(op: ClickOp, slot: number, button: number): void;
}

function hue(item: string): number {
  let hash = 0;
  for (const char of item) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function fill(element: HTMLElement, slot: HudSlot | null, name: string, atlas: Atlas | null): void {
  element.replaceChildren();
  element.style.removeProperty("--icon");
  element.removeAttribute("data-no-icon");
  if (!slot) {
    element.setAttribute("aria-label", `${name}: empty`);
    return;
  }
  element.style.setProperty("--icon", `hsl(${hue(slot.item)} 45% 42%)`);
  const icon = document.createElement("canvas");
  icon.className = "icon";
  icon.width = icon.height = 16;
  icon.setAttribute("aria-hidden", "true");
  element.toggleAttribute("data-no-icon", !drawItemIcon(icon, atlas, slot.item));
  element.append(icon);
  const label = document.createElement("span");
  label.className = "item";
  label.textContent = itemLabel(slot.item);
  element.append(label);
  if (slot.count > 1) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(slot.count);
    element.append(count);
  }
  element.setAttribute("aria-label", `${name}: ${itemLabel(slot.item)} ×${slot.count}`);
}

function place(element: HTMLElement, x: number, y: number, w: number, h: number): void {
  element.style.setProperty("--x", String(x));
  element.style.setProperty("--y", String(y));
  element.style.setProperty("--cw", String(w));
  element.style.setProperty("--ch", String(h));
}

export class InventoryView {
  private hovered: number | null = null;
  private atlas: Atlas | null = null;
  private shown: InventorySnapshot | null = null;
  private touchOp: { op: ClickOp; hotbar: number } = { op: "pickup", hotbar: 0 };
  private touching = false;
  private pointer: { x: number; y: number } | null = null;

  constructor(private readonly root: HTMLElement, private readonly cursor: HTMLElement, private readonly hint: HTMLElement, private readonly events: InventoryEvents, private readonly art: (key: string) => string | null = key => `local-pack/gui/${key}.png`) {
    root.addEventListener("contextmenu", event => event.preventDefault());
    document.addEventListener?.("pointermove", event => this.track(event));
    document.addEventListener?.("pointerdown", event => {
      this.touching = event.pointerType === "touch";
      this.track(event);
    });
    document.documentElement?.addEventListener?.("pointerleave", () => this.track(null));
    globalThis.window?.addEventListener?.("resize", () => this.follow());
    root.addEventListener("mousedown", event => {
      this.track(event as PointerEvent);
      const slot = this.slotOf(event.target);
      if (slot === null) return;
      event.preventDefault();
      if (this.touching && event.button === 0) {
        const { op, hotbar } = this.touchOp;
        this.events.click(op, slot, op === "swap" ? hotbar : op === "split" ? 1 : 0);
        return;
      }
      if (event.button !== 0 && event.button !== 2) return;
      const right = event.button === 2 ? 1 : 0;
      this.events.click(event.shiftKey ? "quick" : right ? "split" : "pickup", slot, right);
    });
    root.addEventListener("mouseover", event => { this.hovered = this.root.hidden ? null : this.slotOf(event.target); });
    root.addEventListener("mouseleave", () => { this.hovered = null; });
  }

  private track(event: PointerEvent | null): void {
    const mouse = event && (event.pointerType === undefined || event.pointerType === "mouse" || event.pointerType === "pen");
    this.pointer = mouse && typeof event.clientX === "number" ? { x: event.clientX, y: event.clientY } : null;
    this.follow();
  }

  private follow(): void {
    const visible = !this.cursor.hidden && !this.root.hidden && this.pointer !== null;
    this.cursor.classList.toggle("following", visible);
    if (!visible || !this.pointer) {
      this.cursor.style.removeProperty("transform");
      return;
    }
    const width = this.cursor.offsetWidth || 40;
    const height = this.cursor.offsetHeight || 40;
    const x = Math.min(Math.max(this.pointer.x - width / 2, 0), Math.max(window.innerWidth - width, 0));
    const y = Math.min(Math.max(this.pointer.y - height / 2, 0), Math.max(window.innerHeight - height, 0));
    this.cursor.style.setProperty("transform", `translate(${x}px, ${y}px)`);
  }

  private slotOf(target: EventTarget | null): number | null {
    const element = (target as HTMLElement | null)?.closest<HTMLElement>("[data-slot]");
    return element ? Number(element.dataset.slot) : null;
  }

  setTouchOp(op: ClickOp, hotbar: number): void {
    this.touchOp = { op, hotbar };
  }

  hotbarSwap(hotbar: number): void {
    if (this.hovered === null || this.root.hidden || !this.shown || this.hovered >= this.shown.slots.length) return;
    this.events.click("swap", this.hovered, hotbar);
  }

  setAtlas(atlas: Atlas | null): void {
    this.atlas = atlas;
    if (this.shown) this.show(this.shown);
  }

  hide(): void {
    this.shown = null;
    this.hovered = null;
    this.hint.hidden = true;
    this.root.hidden = true;
    this.cursor.hidden = true;
    this.follow();
    this.root.replaceChildren();
  }

  show(inv: InventorySnapshot): void {
    const shape = geometry(inv);
    if (!shape) {
      this.hide();
      this.root.hidden = false;
      this.root.textContent = "This container is not supported here. Close it from the script or the game.";
      return;
    }
    const rebuild = !this.shown || this.shown.menu !== inv.menu || this.shown.layout !== inv.layout || this.shown.slots.length !== inv.slots.length;
    if (rebuild) {
      this.hovered = null;
      this.root.dataset.layout = inv.layout;
      const stage = document.createElement("div");
      stage.className = "stage";
      stage.style.setProperty("--w", String(shape.width));
      stage.style.setProperty("--h", String(shape.height));
      const art = this.art(shape.art);
      if (art) stage.style.setProperty("--art", `url("${art}")`);
      for (const item of shape.decor) {
        const mark = document.createElement("div");
        mark.className = `decor ${item.kind}`;
        mark.setAttribute("aria-hidden", "true");
        place(mark, item.x, item.y, item.w, item.h);
        stage.append(mark);
      }
      for (const entry of shape.groups) {
        const section = document.createElement("section");
        section.dataset.area = entry.area;
        place(section, entry.x, entry.y, entry.columns * CELL, Math.ceil(entry.slots.length / entry.columns) * CELL);
        const heading = document.createElement("h2");
        heading.textContent = entry.label;
        const grid = document.createElement("div");
        grid.className = "slots";
        grid.style.setProperty("--columns", String(entry.columns));
        for (const index of entry.slots) {
          const cell = document.createElement("div");
          cell.className = "slot";
          cell.dataset.slot = String(index);
          cell.setAttribute("role", "button");
          grid.append(cell);
        }
        section.append(heading, grid);
        stage.append(section);
      }
      this.root.replaceChildren(stage);
    }
    this.root.hidden = inv.ready === false;
    if (inv.ready === false) this.hovered = null;
    this.root.classList.toggle("busy", inv.pending);
    this.hint.hidden = inv.ready !== false;
    this.hint.textContent = inv.layout === "player"
      ? "Waiting for the server to send your full inventory. Clicks are off until it arrives."
      : "This container has not finished loading, so clicks are off. Press E to close it, then open it again.";
    for (const cell of this.root.querySelectorAll<HTMLElement>("[data-slot]")) {
      const index = Number(cell.dataset.slot);
      fill(cell, inv.slots[index] ?? null, `Slot ${index}`, this.atlas);
    }
    fill(this.cursor, inv.cursor, "Carried", this.atlas);
    this.cursor.hidden = inv.cursor === null || inv.ready === false;
    this.follow();
    this.shown = inv;
  }
}
