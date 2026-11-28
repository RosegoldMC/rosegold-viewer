import { HotbarWheel, wheelHotbar } from "./input.js";
import { loadAtlas, ProtocolAtlas, type Atlas } from "./atlas.js";
import { ViewerFeed, type ChatResult, type FeedStatus } from "./feed.js";
import { TerrainRenderer } from "./renderer.js";
import { ViewerControl } from "./viewer-control.js";
import { InventoryView } from "./viewer-inventory.js";
import { ViewerHud, ViewerMenu, ViewerTutorial, isMenuEscape, drawItemIcon, heldLabel, itemLabel } from "./viewer-hud.js";
import type { TutorialCue } from "./viewer-hud.js";
import type { Hud } from "./wire.js";
import type { ClickOp } from "./inventory.js";
import { ViewerChat } from "./chat.js";
import { TouchSurface, type Hold } from "./touch.js";
import { ViewerTerrain } from "./viewer-terrain.js";
import { createEntityPackLoader, createEntitySink } from "./entity-glue.js";
import { ViewerDebug } from "./viewer-debug.js";
import { bindPairingForm } from "./pairing.js";
import { packMismatchLabel, type Protocol } from "./protocol.js";

const canvas = document.querySelector("canvas")!;
const form = document.querySelector("form")!;
const input = document.querySelector<HTMLInputElement>("#secret")!;
const remember = document.querySelector<HTMLInputElement>("#remember")!;
const connect = document.querySelector<HTMLButtonElement>("#connect")!;
const disconnect = document.querySelector<HTMLButtonElement>("#disconnect")!;
const panel = document.querySelector<HTMLElement>("#connection")!;
const menuToggle = document.querySelector<HTMLButtonElement>("#menu-toggle")!;
const feedStatus = document.querySelector<HTMLOutputElement>("#feed-status")!;
const rendererStatus = document.querySelector<HTMLOutputElement>("#renderer-status")!;

const textureStatus = document.querySelector<HTMLOutputElement>("#texture-status")!;

const hudRoot = document.querySelector<HTMLElement>("#hud")!;
const hudHealth = document.querySelector<HTMLElement>("#hud-health")!;
const hudFood = document.querySelector<HTMLElement>("#hud-food")!;
const hearts = document.querySelector<HTMLElement>("#hearts")!;
const hunger = document.querySelector<HTMLElement>("#hunger")!;
function paintMeter(root: HTMLElement, value: number): void {
  if (root.children.length !== 10) root.replaceChildren(...Array.from({ length: 10 }, () => document.createElement("i")));
  [...root.children].forEach((icon, i) => {
    const fill = Math.max(0, Math.min(2, Math.floor(value) - i * 2));
    (icon as HTMLElement).dataset.fill = String(fill);
  });
}
const hudIce = document.querySelector<HTMLElement>("#ice-road")!;
const hudHeld = document.querySelector<HTMLElement>("#hud-held")!;
const hudSlots = [...document.querySelectorAll<HTMLElement>("#hud-slots li")];
const hudIcons = hudSlots.map(element => element.querySelector<HTMLCanvasElement>(".icon")!);
const cueRoot = document.querySelector<HTMLElement>("#cue")!;
const cueIcon = cueRoot.querySelector<HTMLCanvasElement>(".icon")!;
const cueHeading = document.querySelector<HTMLElement>("#cue-heading")!;
const cueText = document.querySelector<HTMLElement>("#cue-text")!;
const controlRoot = document.querySelector<HTMLElement>("#control")!;
const takeButton = document.querySelector<HTMLButtonElement>("#take-control")!;
const pauseMenu = document.querySelector<HTMLElement>("#pause-menu")!;
const resumeButton = document.querySelector<HTMLButtonElement>("#resume-play")!;
const returnButtons = [...document.querySelectorAll<HTMLButtonElement>(".return-script")];
const controlNotice = document.querySelector<HTMLElement>("#control-notice")!;
const inventoryRoot = document.querySelector<HTMLElement>("#inventory")!;
const inventoryPanel = document.querySelector<HTMLElement>("#inventory-panel")!;
const playHint = document.querySelector<HTMLElement>("#play-hint")!;
const keyboardButton = document.querySelector<HTMLButtonElement>("#play-keyboard")!;
const resumeScriptButton = document.querySelector<HTMLButtonElement>("#resume-script")!;
const restartButton = document.querySelector<HTMLButtonElement>("#restart-script")!;
const restartConfirm = document.querySelector<HTMLElement>("#restart-confirm")!;
const restartYes = document.querySelector<HTMLButtonElement>("#restart-yes")!;
const restartNo = document.querySelector<HTMLButtonElement>("#restart-no")!;
const scriptStatus = document.querySelector<HTMLElement>("#script-status")!;
const inventoryHint = document.querySelector<HTMLElement>("#inventory-hint")!;
const carried = document.querySelector<HTMLElement>("#carried")!;

let loadedAtlas: Atlas | null = null;
let shownHud: Hud | null = null;
let shownCue: TutorialCue | null = null;
const atlas = new ProtocolAtlas(() => loadAtlas({ fetch: (input, init) => fetch(input, init), createImageBitmap: (blob, options) => createImageBitmap(blob, options) })
  .catch((): null => {
    console.warn("Block texture atlas could not be loaded; rendering terrain without textures.");
    return null;
  }), loaded => {
  loadedAtlas = loaded;
  syncIcons(shownHud);
  drawItemIcon(cueIcon, loadedAtlas, shownCue?.item);
  inventoryView.setAtlas(loadedAtlas);
  active?.setAtlas(loadedAtlas);
  syncMiningMeter();
});

function syncIcons(state: Hud | null): void {
  hudIcons.forEach((canvas, i) => {
    const item = state?.slots[i]?.item;
    const drawn = drawItemIcon(canvas, loadedAtlas, item);
    hudSlots[i].toggleAttribute("data-no-icon", item !== undefined && !drawn);
  });
}
const mining = document.querySelector<HTMLElement>("#mining")!;
const miningBar = mining.querySelector("progress")!;
const miningText = mining.querySelector("output")!;

let overlayDrawn = false;

function syncMiningMeter(): void {
  mining.hidden = hudRoot.hidden || miningBar.value <= 0 || overlayDrawn;
}

const chatRoot = document.querySelector<HTMLElement>("#chat")!;
const chatLog = document.querySelector<HTMLOListElement>("#chat-log")!;
const chatForm = document.querySelector<HTMLFormElement>("#chat-form")!;
const chatInput = document.querySelector<HTMLInputElement>("#chat-input")!;
const chatNote = document.querySelector<HTMLOutputElement>("#chat-note")!;

const touchRoot = document.querySelector<HTMLElement>("#touch")!;
const touchStick = document.querySelector<HTMLElement>("#touch-stick")!;
const touchThumb = document.querySelector<HTMLElement>("#touch-thumb")!;
const touchLook = document.querySelector<HTMLElement>("#touch-look")!;
const touchSprint = document.querySelector<HTMLButtonElement>('#touch [data-action="sprint"]')!;
const touchSneak = document.querySelector<HTMLButtonElement>('#touch [data-action="sneak"]')!;
const touchOps = [...document.querySelectorAll<HTMLButtonElement>("#touch-inventory [data-op]")];
const touchHotbar = document.querySelector<HTMLSelectElement>("#touch-hotbar")!;
const chatClose = document.querySelector<HTMLButtonElement>("#chat-close")!;

const labels: Record<FeedStatus, string> = {
  detached: "Disconnected",
  pairing: "Pairing…",
  loading: "Loading current terrain…",
  waiting: "Waiting for the bot…",
  unsupported: "Terrain viewing requires Minecraft 26.1 or 26.3 support in this build.",
  pack_mismatch: "The viewer pack does not match the bot’s Minecraft version. Build a pack from the matching client JAR.",
  ready: "Connected",
  "rate-limited": "Rate limited. Retrying…",
  expired: "Viewer lease ended. Pair again to reconnect.",
  offline: "Viewer unavailable. Check that it is enabled and use its current URL.",
  rejected: "Pairing denied. Check the secret and use the current viewer URL.",
};

let mismatch: { protocol: Protocol; packProtocol: number } | null = null;
const entityPack = createEntityPackLoader();
let active: TerrainRenderer | null = null;
const terrain = new ViewerTerrain(air => {
  const renderer: TerrainRenderer = new TerrainRenderer(canvas, {
    airStateIds: air,
    onStatus(status) {
      rendererStatus.hidden = status === "ready";
      rendererStatus.value = status === "lost" ? "WebGL2 context lost. Waiting for recovery…" : "WebGL2 unavailable";
    },
    onBreakingDrawn(drawn) {
      if (active !== null && active !== renderer) return;
      overlayDrawn = drawn;
      syncMiningMeter();
    },
    onTextureStatus(textured) {
      textureStatus.hidden = !textured;
      syncMiningMeter();
      textureStatus.value = "Local texture pack loaded";
    },
  });
  if (loadedAtlas) renderer.setAtlas(loadedAtlas);
  active = renderer;
  return renderer;
}, renderer => createEntitySink(renderer as TerrainRenderer, entityPack));
const hotbarWheel = new HotbarWheel();
const hud = new ViewerHud({
  show(state) {
    shownHud = state;
    syncIcons(state);
    hudRoot.hidden = !state;
    terrain.setBreaking(state?.breaking ?? null);
    if (!state) {
      hudIce.hidden = true;
      mining.hidden = true;
      return;
    }
    hudHealth.textContent = String(Math.round(state.health * 10) / 10);
    hudFood.textContent = String(state.food);
    hudIce.hidden = !state.ice;
    paintMeter(hearts, state.health);
    paintMeter(hunger, state.food);
    hudHeld.textContent = heldLabel(state);
    hudSlots.forEach((element, i) => {
      const slot = state.slots[i];
      const selected = i === state.selected;
      if (selected) element.setAttribute("aria-current", "true");
      else element.removeAttribute("aria-current");
      element.querySelector(".item")!.textContent = slot ? itemLabel(slot.item) : "";
      element.querySelector(".count")!.textContent = slot && slot.count > 1 ? String(slot.count) : "";
      element.setAttribute("aria-label", `Slot ${i + 1}: ${slot ? `${itemLabel(slot.item)} ×${slot.count}` : "empty"}${selected ? ", selected" : ""}`);
    });
    const progress = state.mining ?? 0;
    miningBar.value = progress;
    syncMiningMeter();
    miningText.value = `${progress}%`;
  },
});
const tutorial = new ViewerTutorial({
  show(cue) {
    shownCue = cue;
    cueRoot.hidden = !cue;
    cueHeading.textContent = cue?.heading ?? "";
    cueText.textContent = cue?.text ?? "";
    drawItemIcon(cueIcon, loadedAtlas, cue?.item);
  },
});
const menu = new ViewerMenu();
let returnFocus: HTMLElement | null = null;
let openedByTrigger = false;

function syncMenu(): void {
  const wasHidden = panel.hidden;
  const visible = menu.visible;
  panel.hidden = !visible;
  menuToggle.hidden = !menu.available;
  menuToggle.setAttribute("aria-expanded", String(menu.available && visible));
  if (visible && wasHidden && menu.available) {
    const previous = document.activeElement;
    returnFocus = previous instanceof HTMLElement && previous !== document.body && previous !== menuToggle ? previous : null;
    openedByTrigger = previous === menuToggle;
    disconnect.focus();
  } else if (!visible && !wasHidden) {
    const restore = returnFocus?.isConnected && !returnFocus.hidden ? returnFocus : openedByTrigger && !menuToggle.hidden ? menuToggle : null;
    returnFocus = null;
    if (restore) restore.focus();
    else if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }
}

function toggleMenu(): void {
  if (menu.toggle()) syncMenu();
}

const chat = new ViewerChat({
  show(lines) {
    chatRoot.hidden = lines.length === 0 && !chatRoot.classList.contains("open");
    chatLog.replaceChildren(...lines.map(line => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    }));
    chatLog.scrollTop = chatLog.scrollHeight;
  },
});
let touchMode = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
function syncTouch() {
  document.body.classList.toggle("touch", touchMode);
  touchSprint.setAttribute("aria-pressed", String(touch.sprint));
  touchSneak.setAttribute("aria-pressed", String(touch.sneak));
  for (const button of touchRoot.querySelectorAll("button.held")) if (!touch.active) button.classList.remove("held");
  if (!touch.stickOffset) {
    touchThumb.style.removeProperty("left");
    touchThumb.style.removeProperty("bottom");
    touchThumb.style.setProperty("--tx", "0px");
    touchThumb.style.setProperty("--ty", "0px");
  }
}
const touch = new TouchSurface({
  keys: bits => control.touchKeys(bits),
  look: (dx, dy) => control.touchLook(dx, dy),
  abort: bits => control.touchAbort(bits),
});
function cancelTouch() {
  touch.cancel();
  syncTouch();
}
const inventoryView = new InventoryView(inventoryRoot, carried, inventoryHint, {
  click: (op, slot, button) => control.inventoryClick(op, slot, button),
});
const control = new ViewerControl({
  state(view) {
    const granted = view.mode !== "view";
    if (view.mode === "play" && menu.visible && menu.available) toggleMenu();
    controlRoot.hidden = !granted || view.mode === "play";
    takeButton.hidden = view.mode !== "idle";
    takeButton.textContent = view.label;
    takeButton.disabled = resumeButton.disabled = keyboardButton.disabled = !view.canPlay;
    playHint.hidden = view.canPlay || (view.mode !== "pause" && view.mode !== "idle");
    pauseMenu.hidden = view.mode !== "pause";
    keyboardButton.hidden = !view.denied || (view.mode !== "idle" && view.mode !== "pause");
    setChatOpen(view.chatOpen, view.chatSeed);
    if (view.chatOpen) chatNote.value = view.chatNote;
    if (view.mode === "play" && !view.chatOpen && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    inventoryPanel.hidden = view.mode !== "inventory";
    for (const button of returnButtons) button.disabled = !view.canReturn;
    resumeScriptButton.hidden = !view.canResume;
    restartButton.hidden = !view.canRestart;
    if (!view.canRestart || view.mode !== "pause") restartConfirm.hidden = true;
    controlNotice.hidden = view.notice === "";
    controlNotice.textContent = view.notice;
    scriptStatus.hidden = !granted || view.checkpoint === "none";
    scriptStatus.textContent = view.checkpoint === "pending"
      ? "Intervention requested. The script is running to its checkpoint."
      : "Script paused at its checkpoint.";
    document.body.dataset.controlMode = view.mode;
    document.body.classList.toggle("playing", view.mode === "play");
    touchRoot.hidden = view.mode !== "play" || view.chatOpen;
    if (touchRoot.hidden) cancelTouch();
  },
  lock() {
    try {
      const pending = canvas.requestPointerLock() as unknown;
      if (pending instanceof Promise) pending.catch(() => control.lockDenied());
    } catch {
      control.lockDenied();
    }
  },
  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  },
  inventory(inv) {
    if (inv) inventoryView.show(inv);
    else inventoryView.hide();
  },
  marker: point => terrain.setMarker(point),
  say: (grant, id, text): Promise<ChatResult> => feed.sendChat(grant, id, text),
});
const debug = new ViewerDebug(
  document.querySelector<HTMLElement>("#debug-left")!,
  document.querySelector<HTMLElement>("#debug-right")!,
  {
    now: () => performance.now(),
    frame: callback => requestAnimationFrame(callback),
    cancel: handle => cancelAnimationFrame(handle),
    control: () => control.mode,
    sections: () => (active ? terrain.sectionCount : null),
    gpu() {
      if (!active) return null;
      try {
        const gl = canvas.getContext("webgl2");
        if (!gl) return null;
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        const name = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
        return typeof name === "string" && name !== "" ? name.slice(0, 64) : null;
      } catch {
        return null;
      }
    },
    viewport: () => ({ width: canvas.width, height: canvas.height, ratio: window.devicePixelRatio || 1 }),
  },
);
const feed = new ViewerFeed({
  apply(batch) {
    if (batch.status === "ready") atlas.select(batch.protocol);
    if (batch.status === "pack_mismatch") mismatch = batch;
    terrain.apply(batch);
    hud.apply(batch);
    chat.apply(batch);
    tutorial.apply(batch);
    control.apply(batch);
    debug.apply(batch);
  },
  reset() {
    terrain.reset();
    hud.reset();
    chat.reset();
    tutorial.reset();
    control.reset();
    debug.reset();
  },
  outbound: () => {
    const outbound = control.outbound();
    return debug.requested() ? { ...outbound, d: 1 } : outbound;
  },
  paired(secret) {
    pairing.paired(secret);
  },
  status(status) {
    if (status === "rejected") pairing.rejected();
    feedStatus.value = status === "pack_mismatch" && mismatch ? packMismatchLabel(mismatch.protocol, mismatch.packProtocol) : labels[status];
    const attached = status !== "detached" && status !== "expired" && status !== "offline" && status !== "rejected";
    form.hidden = attached;
    if (!attached) control.reset();
    disconnect.hidden = !attached;
    menu.update(status);
    syncMenu();
    debug.setStatus(status);
  },
});

const pairing = bindPairingForm(form, input, remember, secret => feed.attach(secret), () => {
  feedStatus.value = "Enter the 64-character hexadecimal pairing secret.";
});
menuToggle.addEventListener("click", toggleMenu);
disconnect.addEventListener("click", () => {
  feed.detach();
  input.focus();
});

document.addEventListener("pointerdown", event => {
  const next = event.pointerType === "touch";
  if (next === touchMode || (event.pointerType !== "touch" && event.pointerType !== "mouse")) return;
  touchMode = next;
  if (!touchMode) cancelTouch();
  else syncTouch();
}, true);

function holdButton(button: HTMLButtonElement) {
  const hold = button.dataset.touch as Hold;
  button.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    try { button.setPointerCapture(event.pointerId); } catch {}
    if (touch.beginHold(event.pointerId, hold)) button.classList.add("held");
  });
  button.addEventListener("pointerup", event => {
    touch.end(event.pointerId);
    button.classList.remove("held");
    syncTouch();
  });
  for (const name of ["pointercancel", "lostpointercapture"]) button.addEventListener(name, (event => {
    touch.lose((event as PointerEvent).pointerId);
    button.classList.remove("held");
    syncTouch();
  }) as EventListener);
  button.addEventListener("click", event => {
    if (event.detail === 0) touch.tap(hold);
  });
}
for (const button of touchRoot.querySelectorAll<HTMLButtonElement>("button[data-touch]")) holdButton(button);

function zone(element: HTMLElement, begin: (id: number, x: number, y: number) => boolean, onMove?: () => void) {
  element.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    try { element.setPointerCapture(event.pointerId); } catch {}
    if (begin(event.pointerId, event.clientX, event.clientY)) onMove?.();
  });
  element.addEventListener("pointermove", event => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    touch.move(event.pointerId, event.clientX, event.clientY);
    onMove?.();
  });
  element.addEventListener("pointerup", event => {
    touch.end(event.pointerId);
    syncTouch();
  });
  for (const name of ["pointercancel", "lostpointercapture"]) element.addEventListener(name, (event => {
    touch.lose((event as PointerEvent).pointerId);
    syncTouch();
  }) as EventListener);
}
zone(touchStick, (id, x, y) => {
  if (!touch.beginStick(id, x, y)) return false;
  const box = touchStick.getBoundingClientRect();
  touchThumb.style.setProperty("left", `${x - box.left - touchThumb.offsetWidth / 2}px`);
  touchThumb.style.setProperty("bottom", `${box.bottom - y - touchThumb.offsetHeight / 2}px`);
  return true;
}, () => {
  const offset = touch.stickOffset;
  touchThumb.style.setProperty("--tx", `${offset?.x ?? 0}px`);
  touchThumb.style.setProperty("--ty", `${offset?.y ?? 0}px`);
});
zone(touchLook, (id, x, y) => touch.beginLook(id, x, y));

touchRoot.addEventListener("click", event => {
  const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "sprint") touch.toggleSprint();
  else if (action === "sneak") touch.toggleSneak();
  else if (action === "pause") control.keyDown("Escape", false);
  else if (action === "inventory") control.keyDown("KeyE", false);
  else if (action === "chat") control.openChat();
  else if (action === "command") control.openChat("/");
  syncTouch();
});
hudRoot.querySelector("#hud-slots")!.addEventListener("click", event => {
  const index = hudSlots.indexOf((event.target as HTMLElement).closest<HTMLElement>("li")!);
  if (touchMode && index >= 0) {
    if (control.playReady && shownHud) hotbarWheel.note(shownHud.selected, index, performance.now());
    control.touchSlot(index);
  }
});
function chooseOp() {
  const pressed = touchOps.find(button => button.getAttribute("aria-pressed") === "true");
  inventoryView.setTouchOp((pressed?.dataset.op ?? "pickup") as ClickOp, Number(touchHotbar.value) - 1);
}
for (const button of touchOps) button.addEventListener("click", () => {
  for (const other of touchOps) other.setAttribute("aria-pressed", String(other === button));
  chooseOp();
});
touchHotbar.addEventListener("change", chooseOp);
document.querySelector("#close-inventory")!.addEventListener("click", () => control.keyDown("KeyE", false));
chatClose.addEventListener("click", () => control.closeChat());

function setChatOpen(open: boolean, seed = "") {
  if (chatRoot.classList.contains("open") === open) return;
  chatRoot.classList.toggle("open", open);
  chatForm.hidden = !open;
  chatNote.value = "";
  if (open) {
    chatRoot.hidden = false;
    chatInput.value = seed;
    chatInput.focus();
    chatInput.setSelectionRange(seed.length, seed.length);
    chatLog.scrollTop = chatLog.scrollHeight;
  } else {
    chatInput.value = "";
    chatInput.blur();
    chatRoot.hidden = chatLog.childElementCount === 0;
  }
}

chatForm.addEventListener("submit", event => {
  event.preventDefault();
  control.submitChat(chatInput.value);
});
chatInput.addEventListener("keydown", event => {
  event.stopPropagation();
  if (event.isComposing) return;
  if (event.code === "Escape") {
    event.preventDefault();
    if (!event.repeat) control.closeChat();
  } else if (event.code === "Enter" || event.code === "NumpadEnter" || event.key === "Enter") {
    event.preventDefault();
    if (!event.repeat) control.submitChat(chatInput.value);
  } else if (event.code === "KeyT" && event.repeat && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
  }
});
chatInput.addEventListener("blur", () => {
  if (control.chatOpen) setTimeout(() => { if (control.chatOpen && document.activeElement !== chatInput) chatInput.focus(); }, 0);
});

takeButton.addEventListener("click", () => touchMode ? control.playWithoutCapture() : control.intervene());
document.querySelector<HTMLButtonElement>("#open-inventory")!.addEventListener("click", () => control.keyDown("KeyE", false));
keyboardButton.addEventListener("click", () => control.playWithoutCapture());
resumeButton.addEventListener("click", () => touchMode ? control.playWithoutCapture() : control.resumePlay());
resumeScriptButton.addEventListener("click", () => control.resumeScript());
restartButton.addEventListener("click", () => {
  restartConfirm.hidden = false;
  restartNo.focus();
});
restartNo.addEventListener("click", () => {
  restartConfirm.hidden = true;
  restartButton.focus();
});
restartYes.addEventListener("click", () => {
  restartConfirm.hidden = true;
  control.restartScript();
});
for (const button of returnButtons) button.addEventListener("click", () => control.returnToScript());

document.addEventListener("pointerlockchange", () => hotbarWheel.reset());
document.addEventListener("pointerlockchange", () => control.lockChanged(document.pointerLockElement === canvas));
document.addEventListener("pointerlockerror", () => control.lockDenied());
const CTRL_PLAY_KEYS = new Set(["ControlLeft", "KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]);
document.addEventListener("keydown", event => {
  if (event.metaKey || event.altKey || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]"))) return;
  if (event.ctrlKey && !(control.mode === "play" && CTRL_PLAY_KEYS.has(event.code))) return;
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (digit && control.mode === "inventory") {
    event.preventDefault();
    inventoryView.hotbarSwap(Number(digit[1]) - 1);
    return;
  }
  if (event.code === "F3" && !event.shiftKey) {
    event.preventDefault();
    if (!event.repeat) debug.toggle();
    return;
  }
  if ((control.mode === "view" || control.mode === "idle") && menu.available && isMenuEscape(event)) {
    event.preventDefault();
    toggleMenu();
    return;
  }
  if (event.key === "/" && !event.repeat && !event.ctrlKey && control.openChat("/")) {
    event.preventDefault();
    return;
  }
  const wasReady = control.playReady;
  if (control.keyDown(event.code, event.repeat)) event.preventDefault();
  if (digit && wasReady && !event.repeat && shownHud) hotbarWheel.note(shownHud.selected, Number(digit[1]) - 1, performance.now());
});
document.addEventListener("keyup", event => control.keyUp(event.code));
canvas.addEventListener("mousedown", event => {
  if (control.mode !== "play") return;
  event.preventDefault();
  if (control.captureOnClick()) return;
  control.mouseDown(event.button);
});
document.addEventListener("mouseup", event => control.mouseUp(event.button));
canvas.addEventListener("wheel", event => wheelHotbar(event, {
  captured: control.mode === "play" && document.pointerLockElement === canvas,
  ready: control.playReady,
  selected: shownHud?.selected ?? null,
  now: performance.now(),
  wheel: hotbarWheel,
  choose: slot => control.touchSlot(slot),
}), { passive: false });
canvas.addEventListener("contextmenu", event => event.preventDefault());
document.addEventListener("mousemove", event => {
  if (document.pointerLockElement === canvas) control.mouseMove(event.movementX, event.movementY);
});
window.addEventListener("blur", () => {
  hotbarWheel.reset();
  control.focusLost();
  cancelTouch();
});

function updateVisibility() {
  if (document.visibilityState === "hidden") {
    hotbarWheel.reset();
    control.focusLost();
    cancelTouch();
  }
  feed.setHidden(document.visibilityState === "hidden");
}

document.addEventListener("visibilitychange", updateVisibility);
window.addEventListener("pagehide", () => {
  input.value = "";
  feed.detach();
  control.reset();
  cancelTouch();
});
updateVisibility();
connect.disabled = false;
pairing.restore();
