import { ViewerFeed, type FeedStatus } from "./feed.js";
import { TerrainRenderer } from "./renderer.js";
import { ViewerHud, heldLabel, itemLabel } from "./viewer-hud.js";
import { ViewerTerrain } from "./viewer-terrain.js";

const canvas = document.querySelector("canvas")!;
const form = document.querySelector("form")!;
const input = document.querySelector<HTMLInputElement>("#secret")!;
const connect = document.querySelector<HTMLButtonElement>("#connect")!;
const disconnect = document.querySelector<HTMLButtonElement>("#disconnect")!;
const feedStatus = document.querySelector<HTMLOutputElement>("#feed-status")!;
const rendererStatus = document.querySelector<HTMLOutputElement>("#renderer-status")!;

const hudRoot = document.querySelector<HTMLElement>("#hud")!;
const hudHealth = document.querySelector<HTMLElement>("#hud-health")!;
const hudFood = document.querySelector<HTMLElement>("#hud-food")!;
const hudHeld = document.querySelector<HTMLElement>("#hud-held")!;
const hudSlots = [...document.querySelectorAll<HTMLElement>("#hud-slots li")];
const mining = document.querySelector<HTMLElement>("#mining")!;
const miningBar = mining.querySelector("progress")!;
const miningText = mining.querySelector("output")!;

const labels: Record<FeedStatus, string> = {
  detached: "Disconnected",
  pairing: "Pairing…",
  loading: "Loading current terrain…",
  waiting: "Waiting for the bot…",
  unsupported: "Terrain viewing requires Minecraft 26.3 (protocol 777).",
  ready: "Connected",
  "rate-limited": "Rate limited. Retrying…",
  expired: "Viewer lease ended. Pair again to reconnect.",
  offline: "Viewer unavailable. Check that it is enabled and use its current URL.",
  rejected: "Pairing denied. Check the secret and use the current viewer URL.",
};

const terrain = new ViewerTerrain(air => new TerrainRenderer(canvas, {
  airStateIds: air,
  onStatus(status) {
    rendererStatus.hidden = status === "ready";
    rendererStatus.value = status === "lost" ? "WebGL2 context lost. Waiting for recovery…" : "WebGL2 unavailable";
  },
}));
const hud = new ViewerHud({
  show(state) {
    hudRoot.hidden = !state;
    if (!state) {
      mining.hidden = true;
      return;
    }
    hudHealth.textContent = String(Math.round(state.health * 10) / 10);
    hudFood.textContent = String(state.food);
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
    mining.hidden = progress <= 0;
    miningBar.value = progress;
    miningText.value = `${progress}%`;
  },
});
const feed = new ViewerFeed({
  apply(batch) {
    try {
      hud.apply(batch);
    } finally {
      terrain.apply(batch);
    }
  },
  reset() {
    hud.reset();
    terrain.reset();
  },
  status(status) {
    feedStatus.value = labels[status];
    const attached = status !== "detached" && status !== "expired" && status !== "offline" && status !== "rejected";
    form.hidden = attached;
    disconnect.hidden = !attached;
  },
});

form.addEventListener("submit", event => {
  event.preventDefault();
  const secret = input.value.trim();
  input.value = "";
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    feedStatus.value = "Enter the 64-character hexadecimal pairing secret.";
    return;
  }
  feed.attach(secret.toLowerCase());
});
disconnect.addEventListener("click", () => {
  feed.detach();
  input.focus();
});

function updateVisibility() {
  feed.setHidden(document.visibilityState === "hidden");
}

document.addEventListener("visibilitychange", updateVisibility);
window.addEventListener("pagehide", () => {
  input.value = "";
  feed.detach();
});
updateVisibility();
connect.disabled = false;
