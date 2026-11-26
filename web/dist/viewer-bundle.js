(() => {
const modules = {
  "./viewer.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const atlas_js_1 = require("./atlas.js");
const feed_js_1 = require("./feed.js");
const renderer_js_1 = require("./renderer.js");
const viewer_control_js_1 = require("./viewer-control.js");
const viewer_inventory_js_1 = require("./viewer-inventory.js");
const viewer_hud_js_1 = require("./viewer-hud.js");
const chat_js_1 = require("./chat.js");
const touch_js_1 = require("./touch.js");
const viewer_terrain_js_1 = require("./viewer-terrain.js");
const entity_glue_js_1 = require("./entity-glue.js");
const viewer_debug_js_1 = require("./viewer-debug.js");
const pairing_js_1 = require("./pairing.js");
const protocol_js_1 = require("./protocol.js");
const canvas = document.querySelector("canvas");
const form = document.querySelector("form");
const input = document.querySelector("#secret");
const remember = document.querySelector("#remember");
const connect = document.querySelector("#connect");
const disconnect = document.querySelector("#disconnect");
const panel = document.querySelector("#connection");
const menuToggle = document.querySelector("#menu-toggle");
const feedStatus = document.querySelector("#feed-status");
const rendererStatus = document.querySelector("#renderer-status");
const textureStatus = document.querySelector("#texture-status");
const hudRoot = document.querySelector("#hud");
const hudHealth = document.querySelector("#hud-health");
const hudFood = document.querySelector("#hud-food");
const hearts = document.querySelector("#hearts");
const hunger = document.querySelector("#hunger");
function paintMeter(root, value) {
    if (root.children.length !== 10)
        root.replaceChildren(...Array.from({ length: 10 }, () => document.createElement("i")));
    [...root.children].forEach((icon, i) => {
        const fill = Math.max(0, Math.min(2, Math.floor(value) - i * 2));
        icon.dataset.fill = String(fill);
    });
}
const hudIce = document.querySelector("#ice-road");
const hudHeld = document.querySelector("#hud-held");
const hudSlots = [...document.querySelectorAll("#hud-slots li")];
const hudIcons = hudSlots.map(element => element.querySelector(".icon"));
const cueRoot = document.querySelector("#cue");
const cueIcon = cueRoot.querySelector(".icon");
const cueHeading = document.querySelector("#cue-heading");
const cueText = document.querySelector("#cue-text");
const controlRoot = document.querySelector("#control");
const takeButton = document.querySelector("#take-control");
const pauseMenu = document.querySelector("#pause-menu");
const resumeButton = document.querySelector("#resume-play");
const returnButtons = [...document.querySelectorAll(".return-script")];
const controlNotice = document.querySelector("#control-notice");
const inventoryRoot = document.querySelector("#inventory");
const inventoryPanel = document.querySelector("#inventory-panel");
const playHint = document.querySelector("#play-hint");
const keyboardButton = document.querySelector("#play-keyboard");
const resumeScriptButton = document.querySelector("#resume-script");
const restartButton = document.querySelector("#restart-script");
const restartConfirm = document.querySelector("#restart-confirm");
const restartYes = document.querySelector("#restart-yes");
const restartNo = document.querySelector("#restart-no");
const scriptStatus = document.querySelector("#script-status");
const inventoryHint = document.querySelector("#inventory-hint");
const carried = document.querySelector("#carried");
let loadedAtlas = null;
let shownHud = null;
let shownCue = null;
const atlas = new atlas_js_1.ProtocolAtlas(() => (0, atlas_js_1.loadAtlas)({ fetch: (input, init) => fetch(input, init), createImageBitmap: (blob, options) => createImageBitmap(blob, options) })
    .catch(() => {
    console.warn("Block texture atlas could not be loaded; rendering terrain without textures.");
    return null;
}), loaded => {
    loadedAtlas = loaded;
    syncIcons(shownHud);
    (0, viewer_hud_js_1.drawItemIcon)(cueIcon, loadedAtlas, shownCue?.item);
    inventoryView.setAtlas(loadedAtlas);
    active?.setAtlas(loadedAtlas);
    syncMiningMeter();
});
function syncIcons(state) {
    hudIcons.forEach((canvas, i) => {
        const item = state?.slots[i]?.item;
        const drawn = (0, viewer_hud_js_1.drawItemIcon)(canvas, loadedAtlas, item);
        hudSlots[i].toggleAttribute("data-no-icon", item !== undefined && !drawn);
    });
}
const mining = document.querySelector("#mining");
const miningBar = mining.querySelector("progress");
const miningText = mining.querySelector("output");
let overlayDrawn = false;
function syncMiningMeter() {
    mining.hidden = hudRoot.hidden || miningBar.value <= 0 || overlayDrawn;
}
const chatRoot = document.querySelector("#chat");
const chatLog = document.querySelector("#chat-log");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatNote = document.querySelector("#chat-note");
const touchRoot = document.querySelector("#touch");
const touchStick = document.querySelector("#touch-stick");
const touchThumb = document.querySelector("#touch-thumb");
const touchLook = document.querySelector("#touch-look");
const touchSprint = document.querySelector('#touch [data-action="sprint"]');
const touchSneak = document.querySelector('#touch [data-action="sneak"]');
const touchOps = [...document.querySelectorAll("#touch-inventory [data-op]")];
const touchHotbar = document.querySelector("#touch-hotbar");
const chatClose = document.querySelector("#chat-close");
const labels = {
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
let mismatch = null;
const entityPack = (0, entity_glue_js_1.createEntityPackLoader)();
let active = null;
const terrain = new viewer_terrain_js_1.ViewerTerrain(air => {
    const renderer = new renderer_js_1.TerrainRenderer(canvas, {
        airStateIds: air,
        onStatus(status) {
            rendererStatus.hidden = status === "ready";
            rendererStatus.value = status === "lost" ? "WebGL2 context lost. Waiting for recovery…" : "WebGL2 unavailable";
        },
        onBreakingDrawn(drawn) {
            if (active !== null && active !== renderer)
                return;
            overlayDrawn = drawn;
            syncMiningMeter();
        },
        onTextureStatus(textured) {
            textureStatus.hidden = !textured;
            syncMiningMeter();
            textureStatus.value = "Local texture pack loaded";
        },
    });
    if (loadedAtlas)
        renderer.setAtlas(loadedAtlas);
    active = renderer;
    return renderer;
}, renderer => (0, entity_glue_js_1.createEntitySink)(renderer, entityPack));
const hud = new viewer_hud_js_1.ViewerHud({
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
        hudHeld.textContent = (0, viewer_hud_js_1.heldLabel)(state);
        hudSlots.forEach((element, i) => {
            const slot = state.slots[i];
            const selected = i === state.selected;
            if (selected)
                element.setAttribute("aria-current", "true");
            else
                element.removeAttribute("aria-current");
            element.querySelector(".item").textContent = slot ? (0, viewer_hud_js_1.itemLabel)(slot.item) : "";
            element.querySelector(".count").textContent = slot && slot.count > 1 ? String(slot.count) : "";
            element.setAttribute("aria-label", `Slot ${i + 1}: ${slot ? `${(0, viewer_hud_js_1.itemLabel)(slot.item)} ×${slot.count}` : "empty"}${selected ? ", selected" : ""}`);
        });
        const progress = state.mining ?? 0;
        miningBar.value = progress;
        syncMiningMeter();
        miningText.value = `${progress}%`;
    },
});
const tutorial = new viewer_hud_js_1.ViewerTutorial({
    show(cue) {
        shownCue = cue;
        cueRoot.hidden = !cue;
        cueHeading.textContent = cue?.heading ?? "";
        cueText.textContent = cue?.text ?? "";
        (0, viewer_hud_js_1.drawItemIcon)(cueIcon, loadedAtlas, cue?.item);
    },
});
const menu = new viewer_hud_js_1.ViewerMenu();
let returnFocus = null;
let openedByTrigger = false;
function syncMenu() {
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
    }
    else if (!visible && !wasHidden) {
        const restore = returnFocus?.isConnected && !returnFocus.hidden ? returnFocus : openedByTrigger && !menuToggle.hidden ? menuToggle : null;
        returnFocus = null;
        if (restore)
            restore.focus();
        else if (panel.contains(document.activeElement))
            document.activeElement.blur();
    }
}
function toggleMenu() {
    if (menu.toggle())
        syncMenu();
}
const chat = new chat_js_1.ViewerChat({
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
    for (const button of touchRoot.querySelectorAll("button.held"))
        if (!touch.active)
            button.classList.remove("held");
    if (!touch.stickOffset) {
        touchThumb.style.removeProperty("left");
        touchThumb.style.removeProperty("bottom");
        touchThumb.style.setProperty("--tx", "0px");
        touchThumb.style.setProperty("--ty", "0px");
    }
}
const touch = new touch_js_1.TouchSurface({
    keys: bits => control.touchKeys(bits),
    look: (dx, dy) => control.touchLook(dx, dy),
    abort: bits => control.touchAbort(bits),
});
function cancelTouch() {
    touch.cancel();
    syncTouch();
}
const inventoryView = new viewer_inventory_js_1.InventoryView(inventoryRoot, carried, inventoryHint, {
    click: (op, slot, button) => control.inventoryClick(op, slot, button),
});
const control = new viewer_control_js_1.ViewerControl({
    state(view) {
        const granted = view.mode !== "view";
        if (view.mode === "play" && menu.visible && menu.available)
            toggleMenu();
        controlRoot.hidden = !granted || view.mode === "play";
        takeButton.hidden = view.mode !== "idle";
        takeButton.textContent = view.label;
        takeButton.disabled = resumeButton.disabled = keyboardButton.disabled = !view.canPlay;
        playHint.hidden = view.canPlay || (view.mode !== "pause" && view.mode !== "idle");
        pauseMenu.hidden = view.mode !== "pause";
        keyboardButton.hidden = !view.denied || (view.mode !== "idle" && view.mode !== "pause");
        setChatOpen(view.chatOpen, view.chatSeed);
        if (view.chatOpen)
            chatNote.value = view.chatNote;
        if (view.mode === "play" && !view.chatOpen && document.activeElement instanceof HTMLElement && document.activeElement !== document.body)
            document.activeElement.blur();
        inventoryPanel.hidden = view.mode !== "inventory";
        for (const button of returnButtons)
            button.disabled = !view.canReturn;
        resumeScriptButton.hidden = !view.canResume;
        restartButton.hidden = !view.canRestart;
        if (!view.canRestart || view.mode !== "pause")
            restartConfirm.hidden = true;
        controlNotice.hidden = view.notice === "";
        controlNotice.textContent = view.notice;
        scriptStatus.hidden = !granted || view.checkpoint === "none";
        scriptStatus.textContent = view.checkpoint === "pending"
            ? "Intervention requested. The script is running to its checkpoint."
            : "Script paused at its checkpoint.";
        document.body.dataset.controlMode = view.mode;
        document.body.classList.toggle("playing", view.mode === "play");
        touchRoot.hidden = view.mode !== "play" || view.chatOpen;
        if (touchRoot.hidden)
            cancelTouch();
    },
    lock() {
        try {
            const pending = canvas.requestPointerLock();
            if (pending instanceof Promise)
                pending.catch(() => control.lockDenied());
        }
        catch {
            control.lockDenied();
        }
    },
    unlock() {
        if (document.pointerLockElement)
            document.exitPointerLock();
    },
    inventory(inv) {
        if (inv)
            inventoryView.show(inv);
        else
            inventoryView.hide();
    },
    marker: point => terrain.setMarker(point),
    say: (grant, id, text) => feed.sendChat(grant, id, text),
});
const debug = new viewer_debug_js_1.ViewerDebug(document.querySelector("#debug-left"), document.querySelector("#debug-right"), {
    now: () => performance.now(),
    frame: callback => requestAnimationFrame(callback),
    cancel: handle => cancelAnimationFrame(handle),
    control: () => control.mode,
    sections: () => (active ? terrain.sectionCount : null),
    gpu() {
        if (!active)
            return null;
        try {
            const gl = canvas.getContext("webgl2");
            if (!gl)
                return null;
            const info = gl.getExtension("WEBGL_debug_renderer_info");
            const name = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
            return typeof name === "string" && name !== "" ? name.slice(0, 64) : null;
        }
        catch {
            return null;
        }
    },
    viewport: () => ({ width: canvas.width, height: canvas.height, ratio: window.devicePixelRatio || 1 }),
});
const feed = new feed_js_1.ViewerFeed({
    apply(batch) {
        if (batch.status === "ready")
            atlas.select(batch.protocol);
        if (batch.status === "pack_mismatch")
            mismatch = batch;
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
        if (status === "rejected")
            pairing.rejected();
        feedStatus.value = status === "pack_mismatch" && mismatch ? (0, protocol_js_1.packMismatchLabel)(mismatch.protocol, mismatch.packProtocol) : labels[status];
        const attached = status !== "detached" && status !== "expired" && status !== "offline" && status !== "rejected";
        form.hidden = attached;
        if (!attached)
            control.reset();
        disconnect.hidden = !attached;
        menu.update(status);
        syncMenu();
        debug.setStatus(status);
    },
});
const pairing = (0, pairing_js_1.bindPairingForm)(form, input, remember, secret => feed.attach(secret), () => {
    feedStatus.value = "Enter the 64-character hexadecimal pairing secret.";
});
menuToggle.addEventListener("click", toggleMenu);
disconnect.addEventListener("click", () => {
    feed.detach();
    input.focus();
});
document.addEventListener("pointerdown", event => {
    const next = event.pointerType === "touch";
    if (next === touchMode || (event.pointerType !== "touch" && event.pointerType !== "mouse"))
        return;
    touchMode = next;
    if (!touchMode)
        cancelTouch();
    else
        syncTouch();
}, true);
function holdButton(button) {
    const hold = button.dataset.touch;
    button.addEventListener("pointerdown", event => {
        if (event.pointerType === "mouse")
            return;
        event.preventDefault();
        try {
            button.setPointerCapture(event.pointerId);
        }
        catch { }
        if (touch.beginHold(event.pointerId, hold))
            button.classList.add("held");
    });
    button.addEventListener("pointerup", event => {
        touch.end(event.pointerId);
        button.classList.remove("held");
        syncTouch();
    });
    for (const name of ["pointercancel", "lostpointercapture"])
        button.addEventListener(name, (event => {
            touch.lose(event.pointerId);
            button.classList.remove("held");
            syncTouch();
        }));
    button.addEventListener("click", event => {
        if (event.detail === 0)
            touch.tap(hold);
    });
}
for (const button of touchRoot.querySelectorAll("button[data-touch]"))
    holdButton(button);
function zone(element, begin, onMove) {
    element.addEventListener("pointerdown", event => {
        if (event.pointerType === "mouse")
            return;
        event.preventDefault();
        try {
            element.setPointerCapture(event.pointerId);
        }
        catch { }
        if (begin(event.pointerId, event.clientX, event.clientY))
            onMove?.();
    });
    element.addEventListener("pointermove", event => {
        if (event.pointerType === "mouse")
            return;
        event.preventDefault();
        touch.move(event.pointerId, event.clientX, event.clientY);
        onMove?.();
    });
    element.addEventListener("pointerup", event => {
        touch.end(event.pointerId);
        syncTouch();
    });
    for (const name of ["pointercancel", "lostpointercapture"])
        element.addEventListener(name, (event => {
            touch.lose(event.pointerId);
            syncTouch();
        }));
}
zone(touchStick, (id, x, y) => {
    if (!touch.beginStick(id, x, y))
        return false;
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
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "sprint")
        touch.toggleSprint();
    else if (action === "sneak")
        touch.toggleSneak();
    else if (action === "pause")
        control.keyDown("Escape", false);
    else if (action === "inventory")
        control.keyDown("KeyE", false);
    else if (action === "chat")
        control.openChat();
    else if (action === "command")
        control.openChat("/");
    syncTouch();
});
hudRoot.querySelector("#hud-slots").addEventListener("click", event => {
    const index = hudSlots.indexOf(event.target.closest("li"));
    if (touchMode && index >= 0)
        control.touchSlot(index);
});
function chooseOp() {
    const pressed = touchOps.find(button => button.getAttribute("aria-pressed") === "true");
    inventoryView.setTouchOp((pressed?.dataset.op ?? "pickup"), Number(touchHotbar.value) - 1);
}
for (const button of touchOps)
    button.addEventListener("click", () => {
        for (const other of touchOps)
            other.setAttribute("aria-pressed", String(other === button));
        chooseOp();
    });
touchHotbar.addEventListener("change", chooseOp);
document.querySelector("#close-inventory").addEventListener("click", () => control.keyDown("KeyE", false));
chatClose.addEventListener("click", () => control.closeChat());
function setChatOpen(open, seed = "") {
    if (chatRoot.classList.contains("open") === open)
        return;
    chatRoot.classList.toggle("open", open);
    chatForm.hidden = !open;
    chatNote.value = "";
    if (open) {
        chatRoot.hidden = false;
        chatInput.value = seed;
        chatInput.focus();
        chatInput.setSelectionRange(seed.length, seed.length);
        chatLog.scrollTop = chatLog.scrollHeight;
    }
    else {
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
    if (event.isComposing)
        return;
    if (event.code === "Escape") {
        event.preventDefault();
        if (!event.repeat)
            control.closeChat();
    }
    else if (event.code === "Enter" || event.code === "NumpadEnter" || event.key === "Enter") {
        event.preventDefault();
        if (!event.repeat)
            control.submitChat(chatInput.value);
    }
    else if (event.code === "KeyT" && event.repeat && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
    }
});
chatInput.addEventListener("blur", () => {
    if (control.chatOpen)
        setTimeout(() => { if (control.chatOpen && document.activeElement !== chatInput)
            chatInput.focus(); }, 0);
});
takeButton.addEventListener("click", () => touchMode ? control.playWithoutCapture() : control.intervene());
document.querySelector("#open-inventory").addEventListener("click", () => control.keyDown("KeyE", false));
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
for (const button of returnButtons)
    button.addEventListener("click", () => control.returnToScript());
document.addEventListener("pointerlockchange", () => control.lockChanged(document.pointerLockElement === canvas));
document.addEventListener("pointerlockerror", () => control.lockDenied());
const CTRL_PLAY_KEYS = new Set(["ControlLeft", "KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]);
document.addEventListener("keydown", event => {
    if (event.metaKey || event.altKey || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")))
        return;
    if (event.ctrlKey && !(control.mode === "play" && CTRL_PLAY_KEYS.has(event.code)))
        return;
    const digit = /^Digit([1-9])$/.exec(event.code);
    if (digit && control.mode === "inventory") {
        event.preventDefault();
        inventoryView.hotbarSwap(Number(digit[1]) - 1);
        return;
    }
    if (event.code === "F3" && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat)
            debug.toggle();
        return;
    }
    if ((control.mode === "view" || control.mode === "idle") && menu.available && (0, viewer_hud_js_1.isMenuEscape)(event)) {
        event.preventDefault();
        toggleMenu();
        return;
    }
    if (event.key === "/" && !event.repeat && !event.ctrlKey && control.openChat("/")) {
        event.preventDefault();
        return;
    }
    if (control.keyDown(event.code, event.repeat))
        event.preventDefault();
});
document.addEventListener("keyup", event => control.keyUp(event.code));
canvas.addEventListener("mousedown", event => {
    if (control.mode !== "play")
        return;
    event.preventDefault();
    if (control.captureOnClick())
        return;
    control.mouseDown(event.button);
});
document.addEventListener("mouseup", event => control.mouseUp(event.button));
canvas.addEventListener("contextmenu", event => event.preventDefault());
document.addEventListener("mousemove", event => {
    if (document.pointerLockElement === canvas)
        control.mouseMove(event.movementX, event.movementY);
});
window.addEventListener("blur", () => {
    control.focusLost();
    cancelTouch();
});
function updateVisibility() {
    if (document.visibilityState === "hidden") {
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
  },
  "./atlas.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProtocolAtlas = exports.BREAK_STAGES = exports.NO_TILE = exports.MAX_ITEM_BLOCKS = exports.MAX_ITEM_ICONS = exports.MAX_RANGES = exports.MAX_JSON_BYTES = exports.MAX_PNG_BYTES = exports.MAX_ROWS = exports.MAX_COLUMNS = exports.TILE_SIZE = void 0;
exports.parseManifest = parseManifest;
exports.lookupNames = lookupNames;
exports.lookupInvisible = lookupInvisible;
exports.lookupTiles = lookupTiles;
exports.lookupModels = lookupModels;
exports.lookupVariants = lookupVariants;
exports.loadAtlas = loadAtlas;
const protocol_js_1 = require("./protocol.js");
const liquid_js_1 = require("./liquid.js");
exports.TILE_SIZE = 16;
exports.MAX_COLUMNS = 38;
exports.MAX_ROWS = 32;
exports.MAX_PNG_BYTES = 1024 * 1024;
exports.MAX_JSON_BYTES = 256 * 1024;
exports.MAX_RANGES = 8192;
exports.MAX_ITEM_ICONS = 1024;
exports.MAX_ITEM_BLOCKS = 1024;
exports.NO_TILE = -1;
exports.BREAK_STAGES = 10;
const MODEL_VARIANT_MAX = {
    leaves: 0, cross: 0, crop: 0, glass: 0,
    fence: 15, composter: 8, lantern: 1, torch: 0, rail: 9, stairs: 39, water: 15, lava: 15,
    mesh: 255,
};
const MODELS = Object.keys(MODEL_VARIANT_MAX);
const LEGACY_MESHES = new Set(["slab", "wall", "lily_pad", "campfire", "hopper", "chest", "trapdoor"]);
const MAX_MESH_QUADS = 1024;
const MAX_QUADS_PER_VARIANT = 48;
function isInt(value, min, max) {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function parseManifest(value) {
    const root = value;
    const protocol = root?.protocol;
    if (!root || typeof root !== "object" || !(0, protocol_js_1.isProtocol)(protocol) || root.tileSize !== exports.TILE_SIZE)
        throw new Error("Unsupported atlas manifest");
    const { columns, rows, blocks } = root;
    if (!isInt(columns, 1, exports.MAX_COLUMNS) || !isInt(rows, 1, exports.MAX_ROWS))
        throw new Error("Atlas exceeds bounds");
    if (!Array.isArray(blocks) || blocks.length > exports.MAX_RANGES)
        throw new Error("Invalid atlas blocks");
    const meshes = parseMeshes(root.models);
    const ranges = [];
    const legacy = new Set();
    for (const block of blocks) {
        const { min, max, faces, model, variant } = (block ?? {});
        if (!isInt(min, 0, 65535) || !isInt(max, min, 65535))
            throw new Error("Invalid atlas state range");
        if (!Array.isArray(faces) || faces.length !== 6 || !faces.every(tile => isInt(tile, exports.NO_TILE, columns * rows - 1))) {
            throw new Error("Invalid atlas faces");
        }
        const range = { min, max, faces: faces };
        if (typeof model === "string" && LEGACY_MESHES.has(model)) {
            legacy.add(range);
        }
        else {
            if (model !== undefined) {
                if (typeof model !== "string" || !Object.hasOwn(MODEL_VARIANT_MAX, model))
                    throw new Error("Invalid atlas block model");
                range.model = model;
            }
            if (variant !== undefined) {
                if (!range.model || !isInt(variant, 0, MODEL_VARIANT_MAX[range.model]))
                    throw new Error("Invalid atlas model variant");
                range.variant = variant;
            }
            if (range.model === "mesh") {
                const mesh = range.variant === undefined ? undefined : meshes?.[range.variant];
                if (!mesh || mesh.quads.some(quad => range.faces[quad.face] === exports.NO_TILE))
                    throw new Error("Invalid atlas mesh binding");
            }
        }
        ranges.push(range);
    }
    ranges.sort((a, b) => a.min - b.min);
    for (let i = 1; i < ranges.length; i++)
        if (ranges[i].min <= ranges[i - 1].max)
            throw new Error("Overlapping atlas ranges");
    const tiles = columns * rows;
    return { protocol, columns, rows, ranges: legacy.size ? ranges.filter(range => !legacy.has(range)) : ranges, meshes, breakStages: parseBreakStages(root.breakStages, tiles),
        itemIcons: parseItemIcons(root.itemIcons, tiles), itemBlocks: parseItemBlocks(root.itemBlocks, tiles), animations: parseAnimations(root.animations, tiles),
        registry: parseRegistry(root.registry), invisible: parseInvisible(root.invisible) };
}
function parseMeshes(value) {
    if (value === undefined)
        return undefined;
    const { quads, variants } = (value ?? {});
    if (!Array.isArray(quads) || quads.length > MAX_MESH_QUADS || !Array.isArray(variants)
        || variants.length > MODEL_VARIANT_MAX.mesh + 1)
        throw new Error("Invalid atlas meshes");
    const vector = (input, size, min, max) => Array.isArray(input) && input.length === size && input.every(value => typeof value === "number" && value >= min && value <= max);
    const faces = quads.map((quad) => {
        if (!Array.isArray(quad) || quad.length !== 4)
            throw new Error("Invalid atlas quad");
        const [corners, uv, face, boundary] = quad;
        if (!vector(corners, 12, -2, 3) || !vector(uv, 8, 0, 1) || !isInt(face, 0, 5)
            || (boundary !== null && (!isInt(boundary, 0, 5) || !corners.every((coordinate, i) => i % 3 !== (boundary >> 1) || coordinate === 1 - boundary % 2))))
            throw new Error("Invalid atlas quad");
        return { corners, uv, face, boundary: boundary ?? undefined };
    });
    return variants.map(variant => {
        if (!Array.isArray(variant) || variant.length !== 2)
            throw new Error("Invalid atlas mesh variant");
        const [cutout, ids] = variant;
        if (typeof cutout !== "boolean" || !Array.isArray(ids) || ids.length > MAX_QUADS_PER_VARIANT
            || !ids.every(id => isInt(id, 0, faces.length - 1)))
            throw new Error("Invalid atlas mesh variant");
        return { cutout, quads: ids.map(id => faces[id]) };
    });
}
function parseRegistry(value) {
    const { max, blocks } = (value ?? {});
    if (!isInt(max, 0, 65535) || !Array.isArray(blocks) || blocks.length === 0 || blocks.length > exports.MAX_RANGES)
        return undefined;
    let previous = -1;
    for (const entry of blocks) {
        if (!Array.isArray(entry) || entry.length !== 2 || !isInt(entry[0], previous + 1, max)
            || typeof entry[1] !== "string" || !/^[a-z0-9_]{1,64}$/.test(entry[1]))
            return undefined;
        previous = entry[0];
    }
    return { max, blocks: blocks };
}
function parseInvisible(value) {
    if (!Array.isArray(value) || value.length > exports.MAX_RANGES)
        return undefined;
    let previous = -1;
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || !isInt(entry[0], previous + 1, 65535) || !isInt(entry[1], entry[0], 65535))
            return undefined;
        previous = entry[1];
    }
    return value;
}
function lookupNames(registry) {
    if (!registry)
        return undefined;
    const { blocks, max } = registry;
    return state => {
        if (!Number.isInteger(state) || state < blocks[0][0] || state > max)
            return undefined;
        let lo = 0, hi = blocks.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (blocks[mid][0] <= state)
                lo = mid;
            else
                hi = mid - 1;
        }
        return `minecraft:${blocks[lo][1]}`;
    };
}
function lookupInvisible(ranges) {
    if (!ranges)
        return undefined;
    return state => {
        let lo = 0, hi = ranges.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (state < ranges[mid][0])
                hi = mid - 1;
            else if (state > ranges[mid][1])
                lo = mid + 1;
            else
                return true;
        }
        return false;
    };
}
function parseAnimations(value, tiles) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const animations = {};
    const input = value;
    for (const sprite of liquid_js_1.LIQUID_SPRITES) {
        const sequence = input[sprite];
        if (!Array.isArray(sequence) || sequence.length < 2 || sequence.length > 256)
            continue;
        const frames = [];
        for (const frame of sequence) {
            if (!Array.isArray(frame) || frame.length !== 2 || !isInt(frame[0], 0, tiles - 1) || !isInt(frame[1], 1, 1200))
                break;
            frames.push([frame[0], frame[1]]);
        }
        if (frames.length === sequence.length)
            animations[sprite] = frames;
    }
    return liquid_js_1.LIQUID_SPRITES.some(sprite => animations[sprite]) ? animations : undefined;
}
function parseItemIcons(value, tiles) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value);
    if (entries.length > exports.MAX_ITEM_ICONS)
        return undefined;
    const icons = new Map();
    for (const [name, tile] of entries) {
        if (!/^[a-z0-9_]{1,64}$/.test(name) || !isInt(tile, 0, tiles - 1))
            return undefined;
        icons.set(name, tile);
    }
    return icons;
}
function parseItemBlocks(value, tiles) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value);
    if (entries.length > exports.MAX_ITEM_BLOCKS)
        return undefined;
    const blocks = new Map();
    for (const [name, faces] of entries) {
        if (!/^[a-z0-9_]{1,64}$/.test(name) || !Array.isArray(faces) || faces.length !== 6 || !faces.every(tile => isInt(tile, 0, tiles - 1)))
            return undefined;
        blocks.set(name, faces);
    }
    return blocks;
}
function parseBreakStages(value, tiles) {
    if (!Array.isArray(value) || value.length !== exports.BREAK_STAGES)
        return undefined;
    if (!value.every(tile => isInt(tile, 0, tiles - 1)))
        return undefined;
    return [...value];
}
function lookupTiles(manifest) {
    const { ranges } = manifest;
    return state => {
        let lo = 0, hi = ranges.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const range = ranges[mid];
            if (state < range.min)
                hi = mid - 1;
            else if (state > range.max)
                lo = mid + 1;
            else
                return range.faces;
        }
        return undefined;
    };
}
function lookupModels(manifest) {
    const codes = new Uint8Array(65536);
    for (const { min, max, faces, model } of manifest.ranges) {
        if (!model || (model !== "mesh" && faces.includes(exports.NO_TILE)))
            continue;
        codes.fill(MODELS.indexOf(model) + 1, min, max + 1);
    }
    return state => {
        const code = Number.isInteger(state) && state >= 0 && state < 65536 ? codes[state] : 0;
        return code ? MODELS[code - 1] : undefined;
    };
}
function lookupVariants(manifest) {
    const variants = new Uint8Array(65536);
    for (const { min, max, faces, model, variant } of manifest.ranges) {
        if (!model || !variant || (model !== "mesh" && faces.includes(exports.NO_TILE)))
            continue;
        variants.fill(variant, min, max + 1);
    }
    return state => Number.isInteger(state) ? variants[state] ?? 0 : 0;
}
async function readBounded(response, limit) {
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
        await response.body?.cancel();
        throw new Error("Atlas file too large");
    }
    if (!response.body)
        return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.length;
        if (total > limit) {
            await reader.cancel();
            throw new Error("Atlas file too large");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function checkPngHeader(bytes, width, height) {
    if (bytes.length < 24)
        throw new Error("Atlas image is not a PNG");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const isIhdr = view.getUint32(12) === 0x49484452;
    if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b) || view.getUint32(8) !== 13 || !isIhdr) {
        throw new Error("Atlas image is not a PNG");
    }
    if (view.getUint32(16) !== width || view.getUint32(20) !== height)
        throw new Error("Atlas image does not match its manifest");
}
async function loadAtlas(deps, base = "/local-pack/") {
    const init = { method: "GET", credentials: "omit", cache: "no-store", redirect: "error" };
    const [jsonBytes, pngBytes] = await Promise.all([
        deps.fetch(`${base}atlas.json`, init).then(r => readBounded(r, exports.MAX_JSON_BYTES)),
        deps.fetch(`${base}atlas.png`, init).then(r => readBounded(r, exports.MAX_PNG_BYTES)),
    ]);
    const manifest = parseManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes)));
    checkPngHeader(pngBytes, manifest.columns * exports.TILE_SIZE, manifest.rows * exports.TILE_SIZE);
    const image = await deps.createImageBitmap(new Blob([pngBytes], { type: "image/png" }), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
    });
    if (image.width !== manifest.columns * exports.TILE_SIZE || image.height !== manifest.rows * exports.TILE_SIZE) {
        image.close?.();
        throw new Error("Atlas image does not match its manifest");
    }
    return { protocol: manifest.protocol, image, columns: manifest.columns, rows: manifest.rows, breakStages: manifest.breakStages, itemIcons: manifest.itemIcons, itemBlocks: manifest.itemBlocks,
        animations: manifest.animations, meshes: manifest.meshes, tilesFor: lookupTiles(manifest), modelFor: lookupModels(manifest), variantFor: lookupVariants(manifest),
        ...registryLookups(manifest) };
}
class ProtocolAtlas {
    load;
    show;
    selected = null;
    loading;
    constructor(load, show) {
        this.load = load;
        this.show = show;
        this.loading = this.fetch();
    }
    select(protocol) {
        if (protocol === this.selected)
            return;
        this.selected = protocol;
        this.show(null);
        const loading = this.loading = this.loading.then(atlas => atlas?.protocol === protocol ? atlas : this.fetch());
        void loading.then(atlas => {
            if (this.loading === loading)
                this.show(atlas?.protocol === protocol ? atlas : null);
        });
    }
    fetch() {
        return this.load().catch(() => null);
    }
}
exports.ProtocolAtlas = ProtocolAtlas;
function registryLookups(manifest) {
    const nameFor = lookupNames(manifest.registry);
    return { nameFor, invisibleFor: lookupInvisible(manifest.invisible), registered: nameFor && (state => nameFor(state) !== undefined) };
}
  },
  "./feed.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewerFeed = void 0;
const wire_js_1 = require("./wire.js");
const authFailures = [401, 403, 404, 410];
const visibleInterval = 60;
const hiddenInterval = 1000;
const requestTimeout = 6000;
function retryDelay(response) {
    const header = response.headers.get("Retry-After");
    if (!header)
        return 500;
    const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    return Number.isNaN(delay) ? 500 : Math.max(250, Math.min(15_000, delay));
}
class ViewerFeed {
    events;
    request;
    auth = null;
    cursor = { epoch: 0, seq: 0 };
    stableStatus = "loading";
    timer = null;
    pending = null;
    lastStart = -Infinity;
    retryAt = 0;
    failures = 0;
    hidden = false;
    chatJob = null;
    constructor(events, request = (input, init) => fetch(input, init)) {
        this.events = events;
        this.request = request;
    }
    attach(secret) {
        if (!/^[0-9a-f]{64}$/i.test(secret))
            throw new Error("Invalid pairing secret");
        this.stop();
        this.auth = { kind: "pairing", token: secret };
        this.events.status("pairing");
        this.schedule();
    }
    sendChat(grant, id, text) {
        if (!this.auth || this.auth.kind !== "lease" || this.chatJob)
            return Promise.resolve("failed");
        return new Promise(resolve => {
            this.chatJob = { grant, id, text, resolve };
            this.cancelTimer();
            this.schedule();
        });
    }
    settleChat(result) {
        const job = this.chatJob;
        this.chatJob = null;
        job?.resolve(result);
    }
    detach() {
        this.disconnect("detached");
    }
    setHidden(hidden) {
        if (hidden === this.hidden)
            return;
        this.hidden = hidden;
        this.cancelTimer();
        this.schedule();
    }
    clearCursor() {
        this.cursor = { epoch: 0, seq: 0 };
        this.stableStatus = "loading";
        this.events.reset();
    }
    cancelTimer() {
        if (this.timer !== null)
            clearTimeout(this.timer);
        this.timer = null;
    }
    stop() {
        this.settleChat("failed");
        this.auth = null;
        this.retryAt = this.failures = 0;
        this.cancelTimer();
        this.pending?.abort();
        this.clearCursor();
    }
    disconnect(status) {
        this.stop();
        this.events.status(status);
    }
    schedule() {
        if (!this.auth || this.pending || this.timer !== null)
            return;
        const interval = this.hidden ? hiddenInterval : visibleInterval;
        const start = Math.max(this.retryAt, this.lastStart + interval);
        this.timer = setTimeout(() => { void this.pull(); }, Math.max(0, Math.ceil(start - performance.now())));
    }
    async pull() {
        this.timer = null;
        const auth = this.auth;
        if (!auth || this.pending)
            return;
        const active = new AbortController();
        const timeout = setTimeout(() => active.abort(), requestTimeout);
        this.pending = active;
        this.lastStart = performance.now();
        const pairing = auth.kind === "pairing";
        const job = pairing ? null : this.chatJob;
        try {
            const headers = { Authorization: `Bearer ${auth.token}` };
            if (!pairing)
                headers["Content-Type"] = "application/json";
            if (job) {
                this.chatJob = null;
                let outcome = "failed";
                try {
                    const reply = await this.request("/chat", {
                        method: "POST", headers, body: JSON.stringify({ epoch: this.cursor.epoch, grant: job.grant, id: job.id, text: job.text }),
                        credentials: "omit", cache: "no-store", mode: "same-origin", redirect: "error",
                        referrerPolicy: "same-origin", signal: active.signal,
                    });
                    await reply.body?.cancel();
                    if (reply.ok)
                        outcome = "sent";
                    else if (reply.status === 429)
                        outcome = "limited";
                    else if (reply.status !== 502 && reply.status !== 504)
                        outcome = "rejected";
                    if (this.auth === auth && (reply.status === 401 || reply.status === 403 || reply.status === 410)) {
                        job.resolve("rejected");
                        this.disconnect("expired");
                        return;
                    }
                }
                catch {
                    outcome = "failed";
                }
                job.resolve(outcome);
                return;
            }
            const result = await this.request(pairing ? "/session" : "/next", {
                method: "POST", headers, body: pairing ? undefined : JSON.stringify({ ...this.cursor, ...this.events.outbound?.(this.cursor) }),
                credentials: "omit", cache: "no-store", mode: "same-origin", redirect: "error",
                referrerPolicy: "same-origin", signal: active.signal,
            });
            if (this.auth !== auth) {
                await result.body?.cancel();
                return;
            }
            if (!result.ok) {
                await result.body?.cancel();
                if (this.auth !== auth)
                    return;
                if (result.status === 429) {
                    this.retryAt = performance.now() + retryDelay(result);
                    this.events.status("rate-limited");
                    return;
                }
                if (authFailures.includes(result.status)) {
                    this.disconnect(pairing ? "rejected" : "expired");
                    return;
                }
                throw new Error("Viewer request failed");
            }
            if (pairing) {
                const lease = (0, wire_js_1.decodeLease)(await (0, wire_js_1.readBytes)(result, wire_js_1.MAX_SESSION_BYTES));
                if (this.auth !== auth)
                    return;
                if (active.signal.aborted)
                    throw new Error("Viewer request timed out");
                this.auth = { kind: "lease", token: lease };
                this.events.paired?.(auth.token);
                this.events.status("loading");
            }
            else if (result.status === 204) {
                if (active.signal.aborted)
                    throw new Error("Viewer request timed out");
                this.events.status(this.stableStatus);
            }
            else {
                const batch = (0, wire_js_1.decodeBatch)(await (0, wire_js_1.readBytes)(result, wire_js_1.MAX_BATCH_BYTES));
                if (this.auth !== auth)
                    return;
                if (active.signal.aborted)
                    throw new Error("Viewer request timed out");
                if (batch.epoch === this.cursor.epoch && batch.seq < this.cursor.seq)
                    throw new Error("Viewer cursor regressed");
                this.events.apply(batch);
                this.cursor = { epoch: batch.epoch, seq: batch.seq };
                this.stableStatus = batch.status;
                this.events.status(batch.status);
            }
            this.retryAt = this.failures = 0;
        }
        catch {
            if (this.auth !== auth)
                return;
            if (pairing || ++this.failures >= 3) {
                this.disconnect("offline");
            }
            else {
                this.clearCursor();
                this.retryAt = performance.now() + this.failures * 250;
                this.events.status("loading");
            }
        }
        finally {
            clearTimeout(timeout);
            this.pending = null;
            this.schedule();
        }
    }
}
exports.ViewerFeed = ViewerFeed;
  },
  "./renderer.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerrainRenderer = void 0;
const camera_js_1 = require("./camera.js");
const atlas_js_1 = require("./atlas.js");
const liquid_js_1 = require("./liquid.js");
const terrain_js_1 = require("./terrain.js");
const breakVertexStride = 10 * Float32Array.BYTES_PER_ELEMENT;
const pathVertexStride = 6 * Float32Array.BYTES_PER_ELEMENT;
const vertexSource = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
layout(location = 2) in vec2 a_corner;
layout(location = 3) in vec2 a_tile;
layout(location = 4) in float a_material;
uniform mat4 u_camera;
uniform vec3 u_offset;
uniform float u_positionScale;
uniform float u_uvScale;
out vec3 v_color;
out vec2 v_local;
flat out vec2 v_tile;
flat out float v_material;
void main() {
  gl_Position = u_camera * vec4(a_position / u_positionScale + u_offset, 1.0);
  gl_PointSize = 7.0;
  v_color = a_color;
  v_local = a_corner / u_uvScale * ${atlas_js_1.TILE_SIZE}.0;
  v_tile = a_tile;
  v_material = a_material;
}`;
const fragmentSource = `#version 300 es
precision mediump float;
in vec3 v_color;
in vec2 v_local;
flat in vec2 v_tile;
flat in float v_material;
uniform bool u_textured;
uniform bool u_water;
uniform bool u_overlay;
uniform vec2 u_atlasSize;
uniform sampler2D u_atlas;
uniform vec4 u_liquidFrames[${liquid_js_1.LIQUID_SPRITES.length}];
out vec4 color;
void main() {
  if (u_overlay) {
    if (!u_textured || v_tile.x > 254.5) discard;
    vec2 crack = v_tile * ${atlas_js_1.TILE_SIZE}.0 + clamp(v_local, 0.5, ${atlas_js_1.TILE_SIZE - 0.5}0);
    vec4 stage = texture(u_atlas, crack / u_atlasSize);
    if (stage.a < 0.004) discard;
    color = stage;
    return;
  }
  if (u_textured && v_tile.x < 254.5) {
    vec2 tile = v_tile;
    vec2 local = v_local;
    if (v_material >= ${liquid_js_1.FIRST_LIQUID_MATERIAL}.0) {
      int sprite = int(v_material) - ${liquid_js_1.FIRST_LIQUID_MATERIAL};
      if (sprite >= ${liquid_js_1.FLOW_TOP_MATERIAL_OFFSET}) {
        sprite -= ${liquid_js_1.FLOW_TOP_MATERIAL_OFFSET};
        local = fract(local / ${atlas_js_1.TILE_SIZE}.0) * ${atlas_js_1.TILE_SIZE}.0;
      }
      vec4 frame = u_liquidFrames[sprite];
      if (all(equal(frame.xy, v_tile))) tile = frame.zw;
    }
    vec2 texel = tile * ${atlas_js_1.TILE_SIZE}.0 + clamp(local, 0.5, ${atlas_js_1.TILE_SIZE - 0.5}0);
    vec4 sampled = texture(u_atlas, texel / u_atlasSize);
    if (u_water) {
      if (sampled.a < 0.004) discard;
      color = vec4(sampled.rgb * vec3(0.247, 0.463, 0.894), sampled.a);
      return;
    }
    if (sampled.a < 0.5) {
      if (v_material == 1.0) discard;
      color = vec4(v_color, 1.0);
      return;
    }
    color = vec4(sampled.rgb, 1.0);
    return;
  }
  color = vec4(v_color, 1.0);
}`;
function compile(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader)
        return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        return shader;
    gl.deleteShader(shader);
    return null;
}
function makePipeline(gl) {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    if (!vertex)
        return null;
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!fragment) {
        gl.deleteShader(vertex);
        return null;
    }
    const program = gl.createProgram();
    if (program) {
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        gl.detachShader(program, vertex);
        gl.detachShader(program, fragment);
    }
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!program)
        return null;
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const camera = gl.getUniformLocation(program, "u_camera");
        const offset = gl.getUniformLocation(program, "u_offset");
        const textured = gl.getUniformLocation(program, "u_textured");
        const atlasSize = gl.getUniformLocation(program, "u_atlasSize");
        const atlas = gl.getUniformLocation(program, "u_atlas");
        const overlay = gl.getUniformLocation(program, "u_overlay");
        const positionScale = gl.getUniformLocation(program, "u_positionScale");
        const uvScale = gl.getUniformLocation(program, "u_uvScale");
        const water = gl.getUniformLocation(program, "u_water");
        const liquidFrames = gl.getUniformLocation(program, "u_liquidFrames[0]");
        if (camera && offset && textured && atlasSize && atlas && overlay && positionScale && uvScale && water && liquidFrames) {
            return { program, camera, offset, textured, atlasSize, atlas, overlay, positionScale, uvScale, water, liquidFrames };
        }
    }
    gl.deleteProgram(program);
    return null;
}
function openContext(canvas) {
    try {
        return canvas.getContext("webgl2", { alpha: false });
    }
    catch {
        return null;
    }
}
class TerrainRenderer {
    canvas;
    terrain;
    gl;
    meshes = new Map();
    waterMeshes = new Map();
    resizeObserver;
    pipeline = null;
    pose = null;
    entities = null;
    paths = [];
    pathVertices = new Float32Array(0);
    pathBuffer = null;
    breaking = null;
    breakBuffer = null;
    breakVertices = new Float32Array(terrain_js_1.CUBE_VERTICES * 10);
    atlas = null;
    texture = null;
    textured = false;
    liquidFrames = new Float32Array(liquid_js_1.LIQUID_SPRITES.length * 4);
    liquidTimer = null;
    frame = null;
    disposed = false;
    constructor(canvas, options) {
        this.canvas = canvas;
        this.terrain = new terrain_js_1.Terrain(options.airStateIds, undefined, missing => console.warn((0, terrain_js_1.describeMissingTexture)(missing)));
        this.onStatus = options.onStatus;
        this.onTextureStatus = options.onTextureStatus;
        this.onBreakingDrawn = options.onBreakingDrawn;
        this.gl = openContext(canvas);
        canvas.addEventListener("webglcontextlost", this.onLost);
        canvas.addEventListener("webglcontextrestored", this.initialize);
        this.resizeObserver = new ResizeObserver(this.requestDraw);
        this.resizeObserver.observe(canvas);
        window.addEventListener("resize", this.requestDraw);
        this.initialize();
    }
    onStatus;
    onTextureStatus;
    onBreakingDrawn;
    breakingDrawn = false;
    setBreakingDrawn(value) {
        if (this.breakingDrawn === value)
            return;
        this.breakingDrawn = value;
        this.onBreakingDrawn?.(value);
    }
    setAtlas(atlas) {
        if (this.disposed)
            return;
        this.atlas = atlas;
        if (this.pipeline)
            this.uploadAtlas();
    }
    uploadAtlas() {
        const { gl, atlas } = this;
        this.releaseTexture();
        this.releaseBreakBuffer();
        if (!gl || gl.isContextLost() || !atlas)
            return this.setTextured(false);
        const texture = gl.createTexture();
        if (!texture)
            return this.setTextured(false);
        try {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            if (gl.getError() !== gl.NO_ERROR)
                throw new Error("Texture upload failed");
        }
        catch {
            gl.deleteTexture(texture);
            return this.setTextured(false);
        }
        finally {
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
        this.texture = texture;
        this.setTextured(true);
    }
    releaseTexture() {
        if (this.texture && this.gl && !this.gl.isContextLost())
            this.gl.deleteTexture(this.texture);
        this.texture = null;
    }
    setTextured(value) {
        this.terrain.setTextures(value ? this.atlas : null);
        if (this.textured !== value) {
            this.textured = value;
            this.onTextureStatus?.(value);
        }
        this.requestDraw();
    }
    replaceSection(position, states) {
        if (!this.disposed && this.terrain.replaceSection(position, states))
            this.requestDraw();
    }
    removeSection(position) {
        this.replaceSection(position, null);
    }
    setEntityLayer(layer) {
        if (this.disposed || layer === this.entities)
            return;
        this.entities?.release();
        this.entities?.setRequestDraw(null);
        this.entities = layer;
        layer?.setRequestDraw(this.requestDraw);
        if (layer && this.pipeline && this.gl)
            layer.attach(this.gl);
        this.requestDraw();
    }
    setPaths(paths) {
        if (this.disposed)
            return;
        this.paths = paths.map(path => ({ ...path, points: path.points.map((p) => [p[0], p[1], p[2]]) }));
        const count = this.paths.reduce((sum, path) => sum + path.points.length, 0);
        this.pathVertices = new Float32Array(count * 6);
        this.requestDraw();
    }
    setBreaking(value) {
        if (this.disposed)
            return;
        if (value === null) {
            if (this.breaking === null)
                return;
            this.breaking = null;
            this.setBreakingDrawn(false);
            this.requestDraw();
            return;
        }
        const { position, stage } = value;
        if (position.length !== 3 || !position.every(Number.isSafeInteger))
            throw new RangeError("Expected integer block coordinates");
        if (!Number.isInteger(stage) || stage < 0 || stage >= atlas_js_1.BREAK_STAGES)
            throw new RangeError("Expected a break stage from 0 to 9");
        const current = this.breaking;
        if (current?.stage === stage && position.every((v, i) => v === current.position[i]))
            return;
        this.breaking = { position: [position[0], position[1], position[2]], stage };
        this.requestDraw();
    }
    clear() {
        this.stopLiquidTimer();
        this.pose = null;
        this.breaking = null;
        this.setBreakingDrawn(false);
        this.paths = [];
        this.pathVertices = new Float32Array(0);
        this.terrain.clear();
        this.entities?.clear();
        this.releaseBuffers();
        if (this.gl && !this.gl.isContextLost())
            this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        this.requestDraw();
    }
    setPose(eye, look, yaw) {
        if (this.disposed)
            return;
        if (eye.length !== 3 || !eye.every(Number.isFinite))
            throw new RangeError("Expected a finite eye position");
        if (!Number.isFinite(yaw))
            throw new RangeError("Expected a finite yaw");
        const direction = (0, camera_js_1.unitLook)(look);
        const current = this.pose;
        if (current?.yaw === yaw && eye.every((value, i) => value === current.eye[i] && direction[i] === current.look[i]))
            return;
        this.pose = { eye: [...eye], look: direction, yaw };
        this.requestDraw();
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.canvas.removeEventListener("webglcontextlost", this.onLost);
        this.canvas.removeEventListener("webglcontextrestored", this.initialize);
        window.removeEventListener("resize", this.requestDraw);
        this.resizeObserver.disconnect();
        this.stopDrawing();
        this.clear();
        this.entities?.dispose();
        this.entities?.setRequestDraw(null);
        this.entities = null;
    }
    initialize = () => {
        if (this.disposed || this.pipeline)
            return;
        const { gl } = this;
        if (!gl) {
            this.onStatus?.("unavailable");
            return;
        }
        const pipeline = makePipeline(gl);
        if (!pipeline) {
            this.onStatus?.(gl.isContextLost() ? "lost" : "unavailable");
            return;
        }
        this.pipeline = pipeline;
        if (this.atlas)
            this.uploadAtlas();
        this.entities?.attach(gl);
        gl.enable(gl.CULL_FACE);
        gl.enable(gl.DEPTH_TEST);
        gl.clearColor(0.105, 0.143, 0.207, 1);
        this.terrain.markAllDirty();
        this.requestDraw();
        this.onStatus?.("ready");
    };
    onLost = (event) => {
        event.preventDefault();
        this.stopDrawing();
        this.onStatus?.("lost");
    };
    stopDrawing() {
        this.stopLiquidTimer();
        if (this.frame !== null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
        this.setBreakingDrawn(false);
        this.releaseBuffers();
        this.releaseTexture();
        this.entities?.release();
        this.terrain.setTextures(null);
        if (this.textured) {
            this.textured = false;
            this.onTextureStatus?.(false);
        }
        if (this.pipeline && this.gl && !this.gl.isContextLost()) {
            this.gl.useProgram(null);
            this.gl.deleteProgram(this.pipeline.program);
        }
        this.pipeline = null;
    }
    releaseBuffers() {
        if (this.gl && !this.gl.isContextLost()) {
            for (const mesh of this.meshes.values())
                this.gl.deleteBuffer(mesh.buffer);
            for (const mesh of this.waterMeshes.values())
                this.gl.deleteBuffer(mesh.buffer);
            if (this.pathBuffer)
                this.gl.deleteBuffer(this.pathBuffer);
        }
        this.meshes.clear();
        this.waterMeshes.clear();
        this.pathBuffer = null;
        this.releaseBreakBuffer();
    }
    releaseBreakBuffer() {
        if (this.breakBuffer && this.gl && !this.gl.isContextLost())
            this.gl.deleteBuffer(this.breakBuffer);
        this.breakBuffer = null;
    }
    drawBreaking(gl, pipeline, eye) {
        const { breaking, atlas } = this;
        if (!breaking || !atlas)
            return false;
        const [x, y, z] = breaking.position;
        const tile = atlas.breakStages?.[breaking.stage];
        if (tile === undefined || !Number.isInteger(tile) || tile < 0 || tile >= atlas.columns * atlas.rows)
            return false;
        if (!this.terrain.opaqueAt(x, y, z))
            return false;
        this.breakBuffer ??= gl.createBuffer();
        if (!this.breakBuffer) {
            this.stopDrawing();
            if (!gl.isContextLost())
                this.onStatus?.("unavailable");
            return false;
        }
        const count = (0, terrain_js_1.fillCube)(this.breakVertices, [x, y, z], eye, tile % atlas.columns, Math.floor(tile / atlas.columns), (nx, ny, nz) => this.terrain.opaqueAt(nx, ny, nz));
        if (count === 0)
            return false;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.breakBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.breakVertices.subarray(0, count * 10), gl.DYNAMIC_DRAW);
        gl.uniform3f(pipeline.offset, 0, 0, 0);
        gl.uniform1f(pipeline.positionScale, 1);
        gl.uniform1f(pipeline.uvScale, 1);
        gl.uniform1i(pipeline.overlay, 1);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, breakVertexStride, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, breakVertexStride, 3 * Float32Array.BYTES_PER_ELEMENT);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, breakVertexStride, 6 * Float32Array.BYTES_PER_ELEMENT);
        gl.vertexAttribPointer(3, 2, gl.FLOAT, false, breakVertexStride, 8 * Float32Array.BYTES_PER_ELEMENT);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1, -1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES, 0, count);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.depthFunc(gl.LESS);
        gl.uniform1i(pipeline.overlay, 0);
        return true;
    }
    drawPaths(gl, pipeline, eye) {
        const { paths, pathVertices: vertices } = this;
        if (!vertices.length)
            return;
        this.pathBuffer ??= gl.createBuffer();
        if (!this.pathBuffer) {
            this.stopDrawing();
            if (!gl.isContextLost())
                this.onStatus?.("unavailable");
            return;
        }
        let i = 0;
        for (const { color, points } of paths) {
            const r = (color >>> 16) / 255;
            const g = ((color >>> 8) & 255) / 255;
            const b = (color & 255) / 255;
            for (const point of points) {
                vertices[i++] = point[0] - eye[0];
                vertices[i++] = point[1] - eye[1];
                vertices[i++] = point[2] - eye[2];
                vertices[i++] = r;
                vertices[i++] = g;
                vertices[i++] = b;
            }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        gl.uniform3f(pipeline.offset, 0, 0, 0);
        gl.uniform1i(pipeline.textured, 0);
        gl.uniform1f(pipeline.positionScale, 1);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, pathVertexStride, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, pathVertexStride, pathVertexStride / 2);
        gl.depthMask(false);
        let first = 0;
        for (const { points } of paths) {
            if (points.length > 1)
                gl.drawArrays(gl.LINE_STRIP, first, points.length);
            first += points.length;
        }
        gl.drawArrays(gl.POINTS, 0, first);
        gl.depthMask(true);
    }
    drawSections(gl, pipeline, eye, meshes) {
        gl.uniform1f(pipeline.positionScale, terrain_js_1.VERTEX_POSITION_SCALE);
        gl.uniform1f(pipeline.uvScale, terrain_js_1.VERTEX_UV_SCALE);
        for (const { position, buffer, count } of meshes) {
            gl.uniform3f(pipeline.offset, position[0] * terrain_js_1.SECTION_SIZE - eye[0], position[1] * terrain_js_1.SECTION_SIZE - eye[1], position[2] * terrain_js_1.SECTION_SIZE - eye[2]);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.vertexAttribPointer(0, 3, gl.SHORT, false, terrain_js_1.VERTEX_STRIDE, 0);
            gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, terrain_js_1.VERTEX_STRIDE, 6);
            gl.vertexAttribPointer(2, 2, gl.UNSIGNED_BYTE, false, terrain_js_1.VERTEX_STRIDE, 9);
            gl.vertexAttribPointer(3, 2, gl.UNSIGNED_BYTE, false, terrain_js_1.VERTEX_STRIDE, 11);
            gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, false, terrain_js_1.VERTEX_STRIDE, 13);
            gl.drawArrays(gl.TRIANGLES, 0, count);
        }
    }
    // Sections are sorted far to near; quads inside one section are unsorted. Water faces against
    // water are culled by the mesher, so local overlaps are limited to a single surface layer.
    drawWater(gl, pipeline, eye) {
        const distance = ({ position }) => position.reduce((sum, value, axis) => sum + (value * terrain_js_1.SECTION_SIZE + terrain_js_1.SECTION_SIZE / 2 - eye[axis]) ** 2, 0);
        const sorted = [...this.waterMeshes.values()].sort((a, b) => distance(b) - distance(a));
        gl.uniform1i(pipeline.water, 1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.enableVertexAttribArray(4);
        this.drawSections(gl, pipeline, eye, sorted);
        gl.disableVertexAttribArray(4);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.uniform1i(pipeline.water, 0);
    }
    stopLiquidTimer() {
        if (this.liquidTimer === null)
            return;
        window.clearTimeout(this.liquidTimer);
        this.liquidTimer = null;
    }
    updateLiquidFrames(gl, pipeline, atlas, now) {
        this.liquidFrames.fill(255);
        let active = 0;
        if (atlas.animations) {
            for (const meshes of [this.meshes, this.waterMeshes])
                for (const mesh of meshes.values())
                    active |= mesh.liquids;
        }
        const ticks = Math.floor(now / 50);
        let nextTick = Infinity;
        for (const [i, sprite] of liquid_js_1.LIQUID_SPRITES.entries()) {
            const frames = atlas.animations?.[sprite];
            if (!(active & (1 << i)) || !frames?.length)
                continue;
            const { tile, remaining } = (0, liquid_js_1.liquidFrameAt)(frames, ticks);
            const base = frames[0][0];
            this.liquidFrames.set([base % atlas.columns, Math.floor(base / atlas.columns),
                tile % atlas.columns, Math.floor(tile / atlas.columns)], i * 4);
            nextTick = Math.min(nextTick, ticks + remaining);
        }
        gl.uniform4fv(pipeline.liquidFrames, this.liquidFrames);
        if (Number.isFinite(nextTick)) {
            this.liquidTimer = window.setTimeout(this.requestDraw, Math.max(1, nextTick * 50 - now));
        }
    }
    requestDraw = () => {
        if (!this.disposed && this.pipeline && this.frame === null)
            this.frame = requestAnimationFrame(this.draw);
    };
    draw = (now) => {
        this.frame = null;
        this.stopLiquidTimer();
        const { gl, pipeline, pose } = this;
        if (!gl || !pipeline || gl.isContextLost())
            return;
        for (const meshes of [this.meshes, this.waterMeshes]) {
            for (const [key, mesh] of meshes) {
                if (this.terrain.hasSection(key))
                    continue;
                gl.deleteBuffer(mesh.buffer);
                meshes.delete(key);
            }
        }
        for (const position of this.terrain.takeDirty()) {
            const key = (0, terrain_js_1.sectionKey)(position);
            for (const [meshes, waterOnly] of [[this.meshes, false], [this.waterMeshes, true]]) {
                const previous = meshes.get(key);
                if (previous) {
                    gl.deleteBuffer(previous.buffer);
                    meshes.delete(key);
                }
                const vertices = this.terrain.mesh(position, waterOnly);
                if (!vertices)
                    continue;
                const buffer = gl.createBuffer();
                if (!buffer) {
                    this.stopDrawing();
                    if (!gl.isContextLost())
                        this.onStatus?.("unavailable");
                    return;
                }
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
                let liquids = 0;
                if (this.atlas?.animations) {
                    for (let i = 13; i < vertices.length; i += terrain_js_1.VERTEX_STRIDE * 3) {
                        const material = vertices[i];
                        if (material >= liquid_js_1.FIRST_LIQUID_MATERIAL)
                            liquids |= 1 << ((material - liquid_js_1.FIRST_LIQUID_MATERIAL) % liquid_js_1.LIQUID_SPRITES.length);
                    }
                }
                meshes.set(key, { position, buffer, count: vertices.length / terrain_js_1.VERTEX_STRIDE, liquids });
            }
        }
        const scale = Math.min(window.devicePixelRatio, 2);
        const width = Math.max(1, Math.round(this.canvas.clientWidth * scale));
        const height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
        if (this.canvas.width !== width)
            this.canvas.width = width;
        if (this.canvas.height !== height)
            this.canvas.height = height;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (!pose || gl.drawingBufferHeight === 0) {
            this.setBreakingDrawn(false);
            return;
        }
        gl.useProgram(pipeline.program);
        const camera = (0, camera_js_1.cameraMatrix)(pose.look, gl.drawingBufferWidth / gl.drawingBufferHeight, pose.yaw);
        gl.uniformMatrix4fv(pipeline.camera, false, camera);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        const useTexture = this.textured && this.texture !== null && this.atlas !== null;
        if (useTexture && this.atlas) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.uniform1i(pipeline.atlas, 0);
            gl.uniform2f(pipeline.atlasSize, this.atlas.columns * atlas_js_1.TILE_SIZE, this.atlas.rows * atlas_js_1.TILE_SIZE);
            this.updateLiquidFrames(gl, pipeline, this.atlas, now);
        }
        gl.uniform1i(pipeline.textured, useTexture ? 1 : 0);
        gl.enableVertexAttribArray(2);
        gl.enableVertexAttribArray(3);
        gl.enableVertexAttribArray(4);
        this.drawSections(gl, pipeline, pose.eye, this.meshes.values());
        gl.disableVertexAttribArray(4);
        const drawn = useTexture && this.drawBreaking(gl, pipeline, pose.eye);
        if (this.pipeline)
            this.setBreakingDrawn(drawn);
        const entities = this.entities;
        if (entities?.animating) {
            entities.draw({ gl, camera, eye: pose.eye, atlas: useTexture ? this.atlas : null, atlasTexture: useTexture ? this.texture : null });
            gl.useProgram(pipeline.program);
            gl.activeTexture(gl.TEXTURE0);
            if (useTexture)
                gl.bindTexture(gl.TEXTURE_2D, this.texture);
            this.requestDraw();
        }
        if (useTexture && this.waterMeshes.size > 0)
            this.drawWater(gl, pipeline, pose.eye);
        gl.disableVertexAttribArray(2);
        gl.disableVertexAttribArray(3);
        if (useTexture)
            gl.bindTexture(gl.TEXTURE_2D, null);
        this.drawPaths(gl, pipeline, pose.eye);
        gl.disableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    };
}
exports.TerrainRenderer = TerrainRenderer;
  },
  "./viewer-control.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewerControl = void 0;
const chat_js_1 = require("./chat.js");
const control_js_1 = require("./control.js");
const input_js_1 = require("./input.js");
const inventory_js_1 = require("./inventory.js");
const ONE_SHOT_TIMEOUT_MS = 3000;
const ESCAPE_ECHO_MS = 100;
const KIND = { pause: 0, play: 1, inventory: 2, click: 3, close: 4, ret: 5, intervene: 6, resume: 7, restart: 8, chat: 9 };
const CHAT_NOTICE_MS = 4000;
const centi = (degrees, limit) => Math.max(-limit, Math.min(limit, Math.round(degrees * 100)));
function wrapDegrees(value) {
    return ((value + 540) % 360) - 180;
}
class ViewerControl {
    sink;
    now;
    input = new input_js_1.InputState();
    machine;
    info = null;
    queued = [];
    shot = null;
    sequence = 0;
    settle = 0;
    following = false;
    playSeq = 0;
    playAcked = false;
    yaw = 0;
    notice = "";
    denied = false;
    ending = "";
    echoUntil = 0;
    pendingPause = false;
    pauseSeq = 0;
    chatting = false;
    chatLocked = false;
    chatId = Math.floor(Date.now() / 1000);
    chatSending = false;
    chatSeed = "";
    chatNote = "";
    noticeUntil = 0;
    constructor(sink, now = () => performance.now()) {
        this.sink = sink;
        this.now = now;
        this.machine = new control_js_1.ControlMachine({
            requestLock: () => sink.lock(),
            exitLock: () => sink.unlock(),
            changed: (mode, previous) => {
                this.chatting = false;
                this.input.setUi(this.machine.ui, this.now());
                this.settle = Infinity;
                this.playSeq = 0;
                this.playAcked = false;
                const sameGrant = this.info?.grant === this.machine.grant;
                if (sameGrant && previous === "play" && (mode === "pause" || mode === "idle")) {
                    this.pendingPause = true;
                    this.pauseSeq = 0;
                }
                else if (mode === "inventory" || mode === "view")
                    this.pendingPause = false;
                if (mode === "play" || (previous === "inventory" && mode === "idle"))
                    this.notice = "";
                if (sameGrant && previous === "inventory" && (mode === "idle" || mode === "play") && !this.following)
                    this.queued.push(this.inventory ? [KIND.close, this.inventory.menu] : [KIND.close]);
                this.render();
            },
        });
    }
    get mode() {
        return this.machine.mode;
    }
    get inventory() {
        return this.info?.inventory ?? null;
    }
    clickPending() {
        return this.shot?.args[0] === KIND.click || this.queued.some(entry => entry[0] === KIND.click);
    }
    render() {
        const info = this.info;
        this.sink.state({
            mode: this.machine.mode,
            label: this.machine.label,
            canReturn: !!info && (0, inventory_js_1.canHandBack)(info.canReturn, this.inventory, this.clickPending()),
            canPlay: info?.canPlay !== false,
            canResume: !!info?.canResume && info.checkpoint === "parked",
            canRestart: !!info?.canRestart && info.checkpoint === "parked",
            checkpoint: info?.checkpoint ?? "none",
            notice: this.notice,
            denied: this.denied,
            chatOpen: this.chatting,
            chatSeed: this.chatSeed,
            chatNote: this.chatNote,
        });
    }
    reset(notice = "") {
        this.notice = notice;
        this.info = null;
        this.queued = [];
        this.shot = null;
        this.sequence = 0;
        this.settle = 0;
        this.denied = false;
        this.pendingPause = false;
        this.pauseSeq = 0;
        this.chatting = false;
        this.machine.setGrant(null);
        this.sink.inventory(null);
        this.sink.marker(null);
        this.render();
    }
    apply(batch) {
        if (batch.status !== "ready") {
            if (this.machine.grant !== null)
                this.reset();
            return;
        }
        this.yaw = batch.yaw;
        const control = batch.control;
        if (control === undefined)
            return;
        if (control === null) {
            if (this.machine.grant === null)
                return;
            this.reset(this.ending || "Control ended.");
            this.ending = "";
            return;
        }
        if (control.grant !== this.machine.grant) {
            this.queued = [];
            this.shot = null;
            this.sequence = 0;
            this.settle = 0;
            this.notice = "";
            this.denied = false;
            this.pendingPause = false;
            this.pauseSeq = 0;
            this.machine.setGrant(control.grant);
            this.settle = 0;
        }
        this.info = control;
        if (this.machine.mode === "inventory" && this.closable())
            this.notice = "";
        if (this.shot && control.ack >= this.shot.seq)
            this.shot = null;
        if (this.pauseSeq && control.ack >= this.pauseSeq) {
            this.pendingPause = false;
            this.pauseSeq = 0;
        }
        if (this.playSeq && control.ack >= this.playSeq && control.mode === "play")
            this.playAcked = true;
        if (control.ack >= this.settle) {
            this.following = true;
            this.machine.follow(control.mode);
            this.following = false;
        }
        if (control.marker !== undefined)
            this.sink.marker(control.marker);
        this.sink.inventory(this.machine.mode === "inventory" ? this.inventory : null);
        this.render();
    }
    outbound() {
        const grant = this.machine.grant;
        if (grant === null)
            return null;
        const now = this.now();
        if (this.shot && now - this.shot.sentAt > ONE_SHOT_TIMEOUT_MS)
            this.shot = null;
        if (!this.shot && this.queued.length) {
            const args = this.queued.shift();
            this.shot = { seq: ++this.sequence, args, sentAt: now };
        }
        if (this.shot)
            return { i: [grant, this.shot.seq, ...this.shot.args] };
        const seq = ++this.sequence;
        const mode = this.machine.mode;
        if (this.noticeUntil && now >= this.noticeUntil) {
            this.noticeUntil = 0;
            this.notice = "";
            this.render();
        }
        if (mode === "play" && this.chatting && this.playAcked)
            return { i: [grant, seq, KIND.chat] };
        if (mode === "play" && this.pendingPause) {
            this.pauseSeq ||= seq;
            return { i: [grant, seq, KIND.pause] };
        }
        if (this.settle === Infinity)
            this.settle = seq;
        if (mode === "pause" && this.pendingPause)
            this.pauseSeq ||= seq;
        if (mode === "play") {
            const frame = this.input.frame(now);
            if (!this.playAcked) {
                if (frame.iceToggle)
                    this.input.requeueIce();
                this.playSeq ||= seq;
                return { i: [grant, seq, KIND.play, 0, 0, 0, 0, -1] };
            }
            if (frame.iceToggle)
                frame.taps |= 8;
            const dyaw = frame.dyaw + (frame.snap ? this.snapDelta(frame.snap) : 0);
            return { i: [grant, seq, KIND.play, frame.keys, centi(dyaw, 18000), centi(frame.dpitch, 9000), frame.taps, frame.slot ?? -1] };
        }
        return { i: [grant, seq, mode === "inventory" ? KIND.inventory : KIND.pause] };
    }
    snapDelta(direction) {
        const heading = Math.round(this.yaw / 90) * 90;
        return wrapDegrees(heading + direction * 90 - this.yaw);
    }
    enqueue(...args) {
        this.queued.push(args);
        this.render();
    }
    intervene() {
        if (this.machine.grant === null || this.info?.canPlay === false)
            return;
        if (this.machine.mode === "idle" && this.machine.markIntervened())
            this.enqueue(KIND.intervene);
        this.machine.capture();
    }
    resumePlay() {
        if (this.info?.canPlay === false)
            return;
        this.machine.capture();
    }
    playWithoutCapture() {
        if (this.machine.grant === null || this.info?.canPlay === false)
            return;
        if (this.machine.markIntervened())
            this.enqueue(KIND.intervene);
        this.machine.playUnlocked();
    }
    lockChanged(locked) {
        if (locked)
            this.denied = false;
        const playing = this.machine.mode === "play";
        this.machine.lockChanged(locked);
        if (!locked && playing && this.machine.mode === "pause")
            this.echoUntil = this.now() + ESCAPE_ECHO_MS;
    }
    lockDenied() {
        const playing = this.machine.mode === "play";
        this.machine.lockDenied();
        if (playing)
            return;
        this.denied = true;
        this.notice = "The browser denied mouse capture. Try again.";
        this.render();
    }
    get chatOpen() {
        return this.chatting;
    }
    openChat(seed = "") {
        if (this.chatting || this.machine.grant === null || this.machine.mode !== "play" || this.info?.canPlay === false)
            return false;
        this.chatting = true;
        this.chatSeed = seed;
        this.chatNote = "";
        this.notice = "";
        this.input.setUi("menu", this.now());
        this.chatLocked = this.machine.suspendLock();
        this.render();
        return true;
    }
    closeChat() {
        if (!this.chatting)
            return;
        this.chatting = false;
        this.chatSeed = this.chatNote = "";
        this.input.setUi(this.machine.ui, this.now());
        if (this.chatLocked)
            this.machine.resumeLock();
        this.chatLocked = false;
        this.render();
    }
    submitChat(raw) {
        const message = (0, chat_js_1.outgoing)(raw);
        if (!message.ok) {
            if (message.reason === "")
                this.closeChat();
            return this.setChatNote(message.reason);
        }
        const grant = this.machine.grant;
        if (!this.chatting || grant === null || !this.sink.say)
            return this.setChatNote("Chat is unavailable.");
        if (this.info?.chatSupported === false)
            return this.setChatNote("This viewer build cannot send chat.");
        if (!this.info?.canChat)
            return this.setChatNote("Chat is still opening. Press Enter again.");
        if (this.chatSending)
            return this.setChatNote("Wait for the previous message to send.");
        this.chatSending = true;
        this.chatId = Math.min(this.chatId + 1, 0xFFFFFFFF);
        const command = message.text.startsWith("/");
        this.sink.say(grant, this.chatId, message.text).then(result => this.chatSent(grant, result, command), () => this.chatSent(grant, "failed", command));
        return this.setChatNote(command ? "Sending command\u2026" : "Sending\u2026");
    }
    setChatNote(note) {
        this.chatNote = note;
        if (this.chatting)
            this.render();
        return note;
    }
    chatSent(grant, result, command) {
        this.chatSending = false;
        if (this.machine.grant !== grant)
            return;
        if (result === "sent") {
            this.closeChat();
            return;
        }
        const what = command ? "Command" : "Message";
        const note = result === "limited" ? `${what} not sent: slow down and try again.`
            : result === "failed" ? `${what} may not have been delivered and was not retried. Check chat before sending again.`
                : `${what} not sent: chat is unavailable or the server connection changed.`;
        if (this.chatting) {
            this.setChatNote(note);
            return;
        }
        this.notice = note;
        this.noticeUntil = this.now() + CHAT_NOTICE_MS;
        this.render();
    }
    captureOnClick() {
        if (this.chatting)
            return true;
        if (!this.machine.captureOnClick)
            return false;
        this.machine.capture();
        return true;
    }
    returnToScript() {
        const info = this.info;
        if (!info || !(0, inventory_js_1.canHandBack)(info.canReturn, this.inventory, this.clickPending()))
            return;
        this.ending = "Control returned to the script.";
        this.enqueue(KIND.ret);
    }
    resumeScript() {
        if (this.info?.canResume && this.info.checkpoint === "parked")
            this.enqueue(KIND.resume);
    }
    restartScript() {
        if (this.info?.canRestart && this.info.checkpoint === "parked")
            this.enqueue(KIND.restart);
    }
    keyDown(code, repeat) {
        if (this.machine.grant === null)
            return false;
        if (this.chatting)
            return true;
        if (code === "KeyT" && !repeat && this.openChat())
            return true;
        if (code === "Escape" && repeat)
            return true;
        if (this.machine.mode === "inventory" && (code === "Escape" || code === "KeyE")) {
            if (!repeat)
                this.closeInventory();
            return true;
        }
        if (code === "Escape" && this.machine.mode === "pause") {
            if (this.now() >= this.echoUntil && this.info?.canPlay !== false)
                this.machine.key(code);
            return true;
        }
        if (!repeat && this.machine.key(code))
            return true;
        if (this.machine.mode !== "play")
            return false;
        this.input.keyDown(code, this.now(), repeat);
        return true;
    }
    closeInventory() {
        if (this.closable()) {
            this.machine.key("KeyE");
            return;
        }
        this.notice = "Your last inventory action is still being sent. Try closing again in a moment.";
        this.render();
    }
    closable() {
        const inv = this.inventory;
        return !this.clickPending() && (!inv || !inv.pending);
    }
    keyUp(code) {
        if (code === "Escape")
            this.echoUntil = 0;
        this.input.keyUp(code, this.now());
    }
    mouseDown(button) {
        this.input.mouseDown(button, this.now());
    }
    mouseUp(button) {
        this.input.mouseUp(button, this.now());
    }
    mouseMove(dx, dy) {
        this.input.mouseMove(dx, dy, this.now());
    }
    touchKeys(bits) {
        if (this.machine.mode === "play")
            this.input.touchKeys(bits, this.now());
    }
    touchAbort(bits) {
        this.input.touchAbort(bits);
    }
    touchLook(dx, dy) {
        if (this.machine.mode === "play")
            this.input.touchLook(dx, dy, this.now());
    }
    touchSlot(index) {
        if (this.machine.mode === "play" && index >= 0 && index < 9)
            this.input.keyDown(`Digit${index + 1}`, this.now());
    }
    focusLost() {
        this.input.clear(this.now());
        this.machine.focusLost();
    }
    inventoryClick(op, slot, button) {
        const inv = this.inventory;
        if (this.machine.mode !== "inventory" || !inv || this.clickPending())
            return;
        const click = (0, inventory_js_1.buildClick)(inv, op, slot, button);
        if (click)
            this.enqueue(KIND.click, click.menu, click.revision, click.slot, click.op, click.button);
    }
}
exports.ViewerControl = ViewerControl;
  },
  "./viewer-inventory.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryView = void 0;
const inventory_js_1 = require("./inventory.js");
const viewer_hud_js_1 = require("./viewer-hud.js");
function hue(item) {
    let hash = 0;
    for (const char of item)
        hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return hash;
}
function fill(element, slot, name, atlas) {
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
    element.toggleAttribute("data-no-icon", !(0, viewer_hud_js_1.drawItemIcon)(icon, atlas, slot.item));
    element.append(icon);
    const label = document.createElement("span");
    label.className = "item";
    label.textContent = (0, viewer_hud_js_1.itemLabel)(slot.item);
    element.append(label);
    if (slot.count > 1) {
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = String(slot.count);
        element.append(count);
    }
    element.setAttribute("aria-label", `${name}: ${(0, viewer_hud_js_1.itemLabel)(slot.item)} ×${slot.count}`);
}
function place(element, x, y, w, h) {
    element.style.setProperty("--x", String(x));
    element.style.setProperty("--y", String(y));
    element.style.setProperty("--cw", String(w));
    element.style.setProperty("--ch", String(h));
}
class InventoryView {
    root;
    cursor;
    hint;
    events;
    art;
    hovered = null;
    atlas = null;
    shown = null;
    touchOp = { op: "pickup", hotbar: 0 };
    touching = false;
    pointer = null;
    constructor(root, cursor, hint, events, art = key => `local-pack/gui/${key}.png`) {
        this.root = root;
        this.cursor = cursor;
        this.hint = hint;
        this.events = events;
        this.art = art;
        root.addEventListener("contextmenu", event => event.preventDefault());
        document.addEventListener?.("pointermove", event => this.track(event));
        document.addEventListener?.("pointerdown", event => {
            this.touching = event.pointerType === "touch";
            this.track(event);
        });
        document.documentElement?.addEventListener?.("pointerleave", () => this.track(null));
        globalThis.window?.addEventListener?.("resize", () => this.follow());
        root.addEventListener("mousedown", event => {
            this.track(event);
            const slot = this.slotOf(event.target);
            if (slot === null)
                return;
            event.preventDefault();
            if (this.touching && event.button === 0) {
                const { op, hotbar } = this.touchOp;
                this.events.click(op, slot, op === "swap" ? hotbar : op === "split" ? 1 : 0);
                return;
            }
            if (event.button !== 0 && event.button !== 2)
                return;
            const right = event.button === 2 ? 1 : 0;
            this.events.click(event.shiftKey ? "quick" : right ? "split" : "pickup", slot, right);
        });
        root.addEventListener("mouseover", event => { this.hovered = this.root.hidden ? null : this.slotOf(event.target); });
        root.addEventListener("mouseleave", () => { this.hovered = null; });
    }
    track(event) {
        const mouse = event && (event.pointerType === undefined || event.pointerType === "mouse" || event.pointerType === "pen");
        this.pointer = mouse && typeof event.clientX === "number" ? { x: event.clientX, y: event.clientY } : null;
        this.follow();
    }
    follow() {
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
    slotOf(target) {
        const element = target?.closest("[data-slot]");
        return element ? Number(element.dataset.slot) : null;
    }
    setTouchOp(op, hotbar) {
        this.touchOp = { op, hotbar };
    }
    hotbarSwap(hotbar) {
        if (this.hovered === null || this.root.hidden || !this.shown || this.hovered >= this.shown.slots.length)
            return;
        this.events.click("swap", this.hovered, hotbar);
    }
    setAtlas(atlas) {
        this.atlas = atlas;
        if (this.shown)
            this.show(this.shown);
    }
    hide() {
        this.shown = null;
        this.hovered = null;
        this.hint.hidden = true;
        this.root.hidden = true;
        this.cursor.hidden = true;
        this.follow();
        this.root.replaceChildren();
    }
    show(inv) {
        const shape = (0, inventory_js_1.geometry)(inv);
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
            if (art)
                stage.style.setProperty("--art", `url("${art}")`);
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
                place(section, entry.x, entry.y, entry.columns * inventory_js_1.CELL, Math.ceil(entry.slots.length / entry.columns) * inventory_js_1.CELL);
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
        if (inv.ready === false)
            this.hovered = null;
        this.root.classList.toggle("busy", inv.pending);
        this.hint.hidden = inv.ready !== false;
        this.hint.textContent = inv.layout === "player"
            ? "Waiting for the server to send your full inventory. Clicks are off until it arrives."
            : "This container has not finished loading, so clicks are off. Press E to close it, then open it again.";
        for (const cell of this.root.querySelectorAll("[data-slot]")) {
            const index = Number(cell.dataset.slot);
            fill(cell, inv.slots[index] ?? null, `Slot ${index}`, this.atlas);
        }
        fill(this.cursor, inv.cursor, "Carried", this.atlas);
        this.cursor.hidden = inv.cursor === null || inv.ready === false;
        this.follow();
        this.shown = inv;
    }
}
exports.InventoryView = InventoryView;
  },
  "./viewer-hud.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewerMenu = exports.ViewerTutorial = exports.ViewerHud = void 0;
exports.itemLabel = itemLabel;
exports.heldLabel = heldLabel;
exports.tutorialCue = tutorialCue;
exports.itemIconTile = itemIconTile;
exports.drawItemIcon = drawItemIcon;
exports.isMenuEscape = isMenuEscape;
const atlas_js_1 = require("./atlas.js");
function itemLabel(item) {
    return item.split("_").filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
}
function heldLabel(hud) {
    const slot = hud.slots[hud.selected];
    if (!slot)
        return "Empty hand";
    return slot.count > 1 ? `${itemLabel(slot.item)} ×${slot.count}` : itemLabel(slot.item);
}
class ViewerHud {
    sink;
    epoch = null;
    current = null;
    constructor(sink) {
        this.sink = sink;
    }
    reset() {
        this.epoch = null;
        if (this.current)
            this.sink.show(null);
        this.current = null;
    }
    apply(batch) {
        if (batch.status !== "ready" || batch.epoch !== this.epoch) {
            this.reset();
            if (batch.status !== "ready")
                return;
            this.epoch = batch.epoch;
        }
        if (!batch.hud)
            return;
        this.current = batch.hud;
        this.sink.show(batch.hud);
    }
}
exports.ViewerHud = ViewerHud;
const tutorialCues = {
    "tutorial-ready": { key: "ready", heading: "Welcome to the orchard", text: "Watch the bot get ready. It will head for the wheat field.", item: "wooden_hoe" },
    "tutorial-wheat": { key: "wheat", heading: "Harvest the wheat", text: "The bot breaks the ripe wheat, then replants it.", item: "wheat" },
    "tutorial-oak": { key: "oak", heading: "Chop the oak", text: "Next it chops the oak tree, working from its original base.", item: "oak_log" },
    "tutorial-descent": { key: "descent", heading: "Head underground", text: "The bot descends toward the copper vein.", item: "stone_pickaxe" },
    "tutorial-copper": { key: "copper", heading: "Mine the copper", text: "It breaks the copper ore.", item: "raw_copper" },
    "tutorial-return": { key: "return", heading: "Back to the orchard", text: "The ore is broken. The bot climbs back to the surface.", item: "copper_ingot" },
    "tutorial-done": { key: "done", heading: "Tutorial complete", text: "That is the loop: harvest and plant again, chop, mine, return.", item: "golden_apple" },
};
function tutorialCue(paths) {
    if (!paths)
        return null;
    for (const path of paths) {
        if (Object.hasOwn(tutorialCues, path.name))
            return tutorialCues[path.name];
    }
    return null;
}
class ViewerTutorial {
    sink;
    epoch = null;
    current = null;
    constructor(sink) {
        this.sink = sink;
    }
    reset() {
        this.epoch = null;
        this.set(null);
    }
    apply(batch) {
        if (batch.status !== "ready" || batch.epoch !== this.epoch) {
            this.reset();
            if (batch.status !== "ready")
                return;
            this.epoch = batch.epoch;
        }
        if (batch.paths === undefined)
            return;
        this.set(tutorialCue(batch.paths));
    }
    set(cue) {
        if (cue?.key === this.current?.key)
            return;
        this.current = cue;
        this.sink.show(cue);
    }
}
exports.ViewerTutorial = ViewerTutorial;
function itemIconTile(atlas, item) {
    if (!atlas || item === undefined)
        return undefined;
    const tile = atlas.itemIcons?.get(item);
    return tile !== undefined && tile >= 0 && tile < atlas.columns * atlas.rows ? tile : undefined;
}
function drawItemIcon(canvas, atlas, item) {
    const tile = itemIconTile(atlas, item);
    let drawn = false;
    const context = canvas.getContext("2d");
    if (context) {
        context.clearRect(0, 0, atlas_js_1.TILE_SIZE, atlas_js_1.TILE_SIZE);
        if (tile !== undefined && atlas) {
            context.imageSmoothingEnabled = false;
            try {
                context.drawImage(atlas.image, (tile % atlas.columns) * atlas_js_1.TILE_SIZE, Math.floor(tile / atlas.columns) * atlas_js_1.TILE_SIZE, atlas_js_1.TILE_SIZE, atlas_js_1.TILE_SIZE, 0, 0, atlas_js_1.TILE_SIZE, atlas_js_1.TILE_SIZE);
                drawn = true;
            }
            catch {
                context.clearRect(0, 0, atlas_js_1.TILE_SIZE, atlas_js_1.TILE_SIZE);
            }
        }
    }
    canvas.hidden = !drawn;
    return drawn;
}
class ViewerMenu {
    ready = false;
    open = false;
    get visible() {
        return !this.ready || this.open;
    }
    get available() {
        return this.ready;
    }
    update(status) {
        const ready = status === "ready";
        if (!ready || !this.ready)
            this.open = false;
        this.ready = ready;
    }
    toggle() {
        if (!this.ready)
            return false;
        this.open = !this.open;
        return true;
    }
}
exports.ViewerMenu = ViewerMenu;
function isMenuEscape(event) {
    return event.key === "Escape" && !event.repeat && !event.defaultPrevented && !event.isComposing
        && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}
  },
  "./chat.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewerChat = exports.MAX_CHAT_CHARS = exports.MAX_CHAT_LINES = void 0;
exports.cleanLine = cleanLine;
exports.outgoing = outgoing;
exports.MAX_CHAT_LINES = 8;
exports.MAX_CHAT_CHARS = 256;
const unsafe = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]", "g");
function cleanLine(text) {
    return text.replace(unsafe, " ").replace(/\s+/g, " ").trim().slice(0, exports.MAX_CHAT_CHARS);
}
function outgoing(raw) {
    const text = cleanLine(raw);
    if (text === "")
        return { ok: false, reason: "" };
    if (text.replace(/^\/+/, "").trim() === "")
        return text.startsWith("/") ? { ok: false, reason: "Type a command after the /." } : { ok: false, reason: "" };
    if (new TextEncoder().encode(text).length > exports.MAX_CHAT_CHARS)
        return { ok: false, reason: "Message is too long." };
    return { ok: true, text };
}
class ViewerChat {
    sink;
    epoch = null;
    chatEpoch = null;
    lastId = 0;
    lines = [];
    constructor(sink) {
        this.sink = sink;
    }
    reset() {
        this.epoch = this.chatEpoch = null;
        this.lastId = 0;
        if (this.lines.length)
            this.sink.show([]);
        this.lines = [];
    }
    apply(batch) {
        if (batch.status !== "ready" || batch.epoch !== this.epoch) {
            this.reset();
            if (batch.status !== "ready")
                return;
            this.epoch = batch.epoch;
        }
        const chat = batch.chat;
        if (!chat)
            return;
        if (chat.epoch !== this.chatEpoch) {
            this.chatEpoch = chat.epoch;
            this.lastId = 0;
            this.lines = [];
        }
        for (const [id, text] of chat.entries) {
            if (id <= this.lastId)
                continue;
            this.lastId = id;
            const line = cleanLine(text);
            if (line)
                this.lines.push(line);
        }
        this.lines = this.lines.slice(-exports.MAX_CHAT_LINES);
        this.sink.show(this.lines);
    }
}
exports.ViewerChat = ViewerChat;
  },
  "./touch.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TouchSurface = exports.STICK_RADIUS = void 0;
const input_js_1 = require("./input.js");
exports.STICK_RADIUS = 56;
const DEAD_ZONE = 0.3;
const AXIS_SECTOR = 0.38;
const TAP_MS = 60;
const HOLD_KEY = { attack: input_js_1.KEY.attack, use: input_js_1.KEY.use, jump: input_js_1.KEY.jump };
class TouchSurface {
    sink;
    stick = new Map();
    look = new Map();
    holds = new Map();
    taps = new Map();
    sprintOn = false;
    sneakOn = false;
    published = 0;
    constructor(sink) {
        this.sink = sink;
    }
    get sprint() {
        return this.sprintOn;
    }
    get sneak() {
        return this.sneakOn;
    }
    get stickOffset() {
        const first = this.stick.values().next().value;
        return first ? { x: first.dx, y: first.dy } : null;
    }
    get active() {
        return this.stick.size + this.look.size + this.holds.size > 0;
    }
    beginStick(id, x, y) {
        if (this.stick.size)
            return false;
        this.stick.set(id, { x, y, dx: 0, dy: 0 });
        return true;
    }
    beginLook(id, x, y) {
        if (this.look.size)
            return false;
        this.look.set(id, { x, y });
        return true;
    }
    beginHold(id, hold) {
        if (this.holds.has(id))
            return false;
        this.holds.set(id, hold);
        this.publish();
        return true;
    }
    move(id, x, y) {
        const stick = this.stick.get(id);
        if (stick) {
            let dx = x - stick.x;
            let dy = y - stick.y;
            const length = Math.hypot(dx, dy);
            if (length > exports.STICK_RADIUS) {
                dx = (dx / length) * exports.STICK_RADIUS;
                dy = (dy / length) * exports.STICK_RADIUS;
            }
            stick.dx = Number.isFinite(dx) ? dx : 0;
            stick.dy = Number.isFinite(dy) ? dy : 0;
            this.publish();
            return;
        }
        const look = this.look.get(id);
        if (look) {
            const dx = x - look.x;
            const dy = y - look.y;
            look.x = x;
            look.y = y;
            this.sink.look(dx, dy);
        }
    }
    end(id) {
        this.stick.delete(id);
        this.look.delete(id);
        this.holds.delete(id);
        this.publish();
    }
    toggleSprint() {
        this.sprintOn = !this.sprintOn;
        if (this.sprintOn)
            this.sneakOn = false;
        this.publish();
        return this.sprintOn;
    }
    toggleSneak() {
        this.sneakOn = !this.sneakOn;
        if (this.sneakOn)
            this.sprintOn = false;
        this.publish();
        return this.sneakOn;
    }
    tap(hold) {
        clearTimeout(this.taps.get(hold));
        this.taps.set(hold, setTimeout(() => {
            this.taps.delete(hold);
            this.publish();
        }, TAP_MS));
        this.publish();
    }
    lose(id) {
        const hold = this.holds.get(id);
        if (!this.stick.has(id) && !this.look.has(id) && hold === undefined)
            return;
        this.end(id);
        this.sprintOn = this.sneakOn = false;
        this.publish();
        if (hold)
            this.sink.abort(HOLD_KEY[hold]);
    }
    cancel() {
        this.stick.clear();
        this.look.clear();
        this.holds.clear();
        for (const timer of this.taps.values())
            clearTimeout(timer);
        this.taps.clear();
        this.sprintOn = this.sneakOn = false;
        this.publish();
        this.sink.abort(input_js_1.KEY.attack | input_js_1.KEY.use | input_js_1.KEY.jump);
    }
    bits() {
        let bits = 0;
        const stick = this.stick.values().next().value;
        if (stick) {
            const length = Math.hypot(stick.dx, stick.dy);
            if (length >= exports.STICK_RADIUS * DEAD_ZONE) {
                const nx = stick.dx / length;
                const ny = stick.dy / length;
                if (ny < -AXIS_SECTOR)
                    bits |= input_js_1.KEY.forward;
                if (ny > AXIS_SECTOR)
                    bits |= input_js_1.KEY.back;
                if (nx < -AXIS_SECTOR)
                    bits |= input_js_1.KEY.left;
                if (nx > AXIS_SECTOR)
                    bits |= input_js_1.KEY.right;
            }
        }
        for (const hold of this.holds.values())
            bits |= HOLD_KEY[hold];
        for (const hold of this.taps.keys())
            bits |= HOLD_KEY[hold];
        if (this.sprintOn)
            bits |= input_js_1.KEY.sprint;
        if (this.sneakOn)
            bits |= input_js_1.KEY.sneak;
        return bits;
    }
    publish() {
        const bits = this.bits();
        if (bits === this.published)
            return;
        this.published = bits;
        this.sink.keys(bits);
    }
}
exports.TouchSurface = TouchSurface;
  },
  "./viewer-terrain.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewerTerrain = void 0;
const terrain_js_1 = require("./terrain.js");
function inWindow(position, center) {
    return position.every((value, axis) => Math.abs(value - center[axis]) <= 2);
}
class ViewerTerrain {
    createRenderer;
    createEntities;
    renderer = null;
    palette = null;
    hasAir = false;
    epoch = null;
    center = null;
    eye = null;
    look = null;
    paths = [];
    marker = null;
    dirty = false;
    displayed = new Map();
    entities = null;
    constructor(createRenderer, createEntities) {
        this.createRenderer = createRenderer;
        this.createEntities = createEntities;
    }
    get sectionCount() {
        return this.displayed.size;
    }
    setBreaking(value) {
        this.renderer?.setBreaking(value);
    }
    reset() {
        if (this.epoch !== null)
            this.renderer?.clear();
        this.epoch = null;
        this.center = this.eye = this.look = null;
        this.hasAir = false;
        this.paths = [];
        this.marker = null;
        this.dirty = false;
        this.displayed.clear();
    }
    setMarker(point) {
        const same = point === this.marker || (point && this.marker && point.every((v, i) => v === this.marker[i]));
        if (same)
            return;
        this.marker = point;
        this.dirty = true;
        this.syncPaths();
    }
    syncPaths() {
        if (this.hasAir && this.dirty) {
            const marker = this.marker ? [{ name: "intervention", color: 0xFF4FD8, points: [this.marker] }] : [];
            this.renderer?.setPaths([...this.paths, ...marker]);
            this.dirty = false;
        }
    }
    apply(batch) {
        if (batch.status !== "ready" || batch.epoch !== this.epoch) {
            this.reset();
            if (batch.status !== "ready")
                return;
            this.epoch = batch.epoch;
        }
        if (batch.air) {
            const air = [...new Set(batch.air)].sort((a, b) => a - b);
            const palette = air.join(",");
            if (this.hasAir && this.palette !== palette)
                throw new Error("Air IDs changed without a world reset");
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
        if (batch.eye)
            this.eye = batch.eye;
        if (batch.look)
            this.look = batch.look;
        if (this.eye && this.look && this.hasAir)
            this.renderer?.setPose(this.eye, this.look, batch.yaw);
        if (batch.paths !== undefined) {
            this.paths = batch.paths;
            this.dirty = true;
        }
        this.syncPaths();
        if (batch.entities !== undefined)
            this.entities?.replaceAll(batch.entities);
        const { section } = batch;
        if (!section)
            return;
        if (!this.center || !this.renderer || !this.hasAir)
            throw new Error("Missing terrain metadata");
        if (!inWindow(section.position, this.center))
            return;
        const key = (0, terrain_js_1.sectionKey)(section.position);
        if (section.kind === "states") {
            this.renderer.replaceSection(section.position, section.states);
            this.displayed.set(key, section.position);
        }
        else {
            if (section.kind === "air")
                this.renderer.replaceSection(section.position, null);
            else
                this.renderer.removeSection(section.position);
            this.displayed.delete(key);
        }
    }
}
exports.ViewerTerrain = ViewerTerrain;
  },
  "./entity-glue.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLayerEntities = toLayerEntities;
exports.createEntityPackLoader = createEntityPackLoader;
exports.createEntitySink = createEntitySink;
const entity_geometry_js_1 = require("./entity-geometry.js");
const entity_layer_js_1 = require("./entity-layer.js");
const entity_skin_js_1 = require("./entity-skin.js");
const SPECIES = new Set(entity_geometry_js_1.SUPPORTED_KINDS);
function toLayerEntities(rows) {
    const out = [];
    for (const row of rows) {
        if (!SPECIES.has(row.species))
            continue;
        const entity = {
            id: row.id, kind: row.species, x: row.position[0], y: row.position[1], z: row.position[2], yaw: row.yaw, pitch: row.pitch,
        };
        if (row.species === "item") {
            if (!row.item)
                continue;
            entity.item = row.item.name;
            entity.count = row.item.count;
        }
        if (row.appearance) {
            entity.slim = row.appearance.model === "slim";
            if (/^[0-9a-f]{64}$/.test(row.appearance.key))
                entity.skin = row.appearance.key;
        }
        out.push(entity);
    }
    return out;
}
async function decodePng(png) {
    const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context)
            throw new Error("Canvas unavailable");
        context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
    }
    finally {
        bitmap.close();
    }
}
function createEntityPackLoader() {
    let pack = null;
    return () => pack ??= (0, entity_layer_js_1.loadEntityPack)({ fetch: (input, init) => fetch(input, init), createImageBitmap: (blob, options) => createImageBitmap(blob, options) })
        .catch(() => null);
}
function createEntitySink(renderer, pack) {
    const layer = new entity_layer_js_1.EntityLayer({
        skinSource: key => (0, entity_skin_js_1.loadLocalSkin)({ fetch: (input, init) => fetch(input, init), decode: decodePng }, key),
    });
    renderer.setEntityLayer(layer);
    void pack().then(loaded => { if (loaded)
        layer.setPack(loaded); });
    return { replaceAll: rows => layer.replaceAll(toLayerEntities(rows)) };
}
  },
  "./viewer-debug.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewerDebug = void 0;
const debug_format_js_1 = require("./debug-format.js");
const renderInterval = 250;
const fpsWindow = 1000;
class ViewerDebug {
    left;
    right;
    environment;
    open = false;
    epoch = null;
    protocol = null;
    info = null;
    feed = "detached";
    handle = null;
    windowStart = 0;
    frames = 0;
    lastFrame = 0;
    worst = 0;
    total = 0;
    fps = null;
    lastRender = -Infinity;
    gpuName;
    lastText = "";
    constructor(left, right, environment) {
        this.left = left;
        this.right = right;
        this.environment = environment;
    }
    get enabled() {
        return this.open;
    }
    toggle() {
        this.open = !this.open;
        this.left.parentElement.hidden = !this.open;
        if (this.open)
            this.start();
        else
            this.stop();
        return this.open;
    }
    requested() {
        return this.open;
    }
    setStatus(status) {
        this.feed = status;
        if (status !== "ready" && status !== "pack_mismatch")
            this.clearData();
        this.render(true);
    }
    reset() {
        this.clearData();
        this.render(true);
    }
    apply(batch) {
        if (batch.status !== "ready" || batch.epoch !== this.epoch) {
            this.clearData();
            if (batch.status === "pack_mismatch")
                this.protocol = batch.protocol;
            if (batch.status !== "ready")
                return;
            this.epoch = batch.epoch;
        }
        this.protocol = batch.protocol;
        if (batch.debug)
            this.info = batch.debug;
    }
    clearData() {
        this.epoch = null;
        this.protocol = null;
        this.info = null;
    }
    start() {
        this.windowStart = this.lastFrame = this.environment.now();
        this.frames = this.total = this.worst = 0;
        this.fps = null;
        this.lastRender = -Infinity;
        this.render(true);
        this.tick();
    }
    stop() {
        if (this.handle !== null)
            this.environment.cancel(this.handle);
        this.handle = null;
        this.lastText = "";
        this.left.replaceChildren();
        this.right.replaceChildren();
    }
    tick() {
        this.handle = this.environment.frame(() => {
            this.handle = null;
            if (!this.open)
                return;
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
    render(force) {
        if (!this.open)
            return;
        const now = this.environment.now();
        if (!force && now - this.lastRender < renderInterval)
            return;
        this.lastRender = now;
        if (this.gpuName === undefined && this.feed === "ready") {
            const name = this.environment.gpu();
            if (name !== null)
                this.gpuName = name;
        }
        const lines = (0, debug_format_js_1.formatDebug)({
            feed: this.feed,
            protocol: this.protocol,
            control: this.environment.control(),
            info: this.info,
            fps: this.fps,
            sections: this.environment.sections(),
            gpu: this.gpuName ?? null,
            viewport: this.environment.viewport(),
        });
        const text = JSON.stringify(lines);
        if (text === this.lastText)
            return;
        this.lastText = text;
        fill(this.left, lines.left);
        fill(this.right, lines.right);
    }
}
exports.ViewerDebug = ViewerDebug;
function fill(column, lines) {
    const document = column.ownerDocument;
    column.replaceChildren(...lines.map(line => {
        const row = document.createElement("div");
        row.className = line === "" ? "gap" : "line";
        row.textContent = line;
        return row;
    }));
}
  },
  "./pairing.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindPairingForm = bindPairingForm;
const storageKey = "rosegold-viewer.pairing-secret";
const secretPattern = /^[0-9a-f]{64}$/i;
function bindPairingForm(form, input, remember, attach, invalid) {
    function forget() {
        try {
            window.localStorage.removeItem(storageKey);
        }
        catch { }
    }
    function submit() {
        const secret = input.value.trim();
        input.value = "";
        if (secretPattern.test(secret))
            attach(secret.toLowerCase());
        else
            invalid();
    }
    form.addEventListener("submit", event => {
        event.preventDefault();
        submit();
    });
    remember.addEventListener("change", () => {
        if (!remember.checked)
            forget();
    });
    return {
        restore() {
            let saved;
            try {
                saved = window.localStorage.getItem(storageKey);
            }
            catch {
                return;
            }
            if (saved === null)
                return;
            if (!secretPattern.test(saved)) {
                forget();
                return;
            }
            input.value = saved;
            remember.checked = true;
            submit();
        },
        paired(secret) {
            if (!remember.checked)
                return;
            try {
                window.localStorage.setItem(storageKey, secret);
            }
            catch { }
        },
        rejected() {
            remember.checked = false;
            forget();
        },
    };
}
  },
  "./protocol.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.minecraftVersions = void 0;
exports.isProtocol = isProtocol;
exports.packMismatchLabel = packMismatchLabel;
exports.minecraftVersions = { 775: "26.1", 777: "26.3" };
function isProtocol(value) {
    return typeof value === "number" && Object.hasOwn(exports.minecraftVersions, value);
}
function packMismatchLabel(protocol, packProtocol) {
    const bot = exports.minecraftVersions[protocol];
    const pack = isProtocol(packProtocol) ? exports.minecraftVersions[packProtocol] : `protocol ${packProtocol}`;
    return `Texture pack is for ${pack}, bot is on ${bot}. Build a pack from the ${bot} client JAR.`;
}
  },
  "./liquid.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY = exports.BLOCKED = exports.FLOW_TOP_UV_BIAS = exports.FLOW_TOP_MATERIAL_OFFSET = exports.FIRST_LIQUID_MATERIAL = exports.LIQUID_SPRITES = void 0;
exports.liquidMaterial = liquidMaterial;
exports.liquidHeight = liquidHeight;
exports.liquidSurface = liquidSurface;
exports.liquidFrameAt = liquidFrameAt;
exports.LIQUID_SPRITES = ["waterStill", "waterFlow", "lavaStill", "lavaFlow"];
exports.FIRST_LIQUID_MATERIAL = 2;
exports.FLOW_TOP_MATERIAL_OFFSET = exports.LIQUID_SPRITES.length;
exports.FLOW_TOP_UV_BIAS = 1;
exports.BLOCKED = -1;
exports.EMPTY = 0;
const SOURCE_HEIGHT = 8 / 9;
const cardinal = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const topCorners = [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]];
function liquidMaterial(kind, flowing, rotated) {
    return exports.FIRST_LIQUID_MATERIAL + (kind === "lava" ? 2 : 0) + Number(flowing) + (rotated ? exports.FLOW_TOP_MATERIAL_OFFSET : 0);
}
function liquidHeight(level) {
    return level >= 8 ? SOURCE_HEIGHT : (8 - level) / 9;
}
function averageCorner(center, x, z, diagonal) {
    if (x === 1 || z === 1 || ((x > 0 || z > 0) && diagonal === 1))
        return 1;
    let sum = 0, weight = 0;
    for (const h of [center, x, z, (x > 0 || z > 0) ? diagonal : exports.BLOCKED]) {
        if (h < 0)
            continue;
        const w = h >= 0.8 ? 10 : 1;
        sum += h * w;
        weight += w;
    }
    return sum / weight;
}
function liquidSurface(level, sample) {
    const own = liquidHeight(level);
    const center = sample(0, 1, 0) > exports.EMPTY ? 1 : own;
    const cell = (dx, dz) => {
        const state = sample(dx, 0, dz);
        if (state <= exports.EMPTY)
            return state;
        return sample(dx, 1, dz) > exports.EMPTY ? 1 : liquidHeight(state - 1);
    };
    const west = center === 1 ? 1 : cell(-1, 0);
    const east = center === 1 ? 1 : cell(1, 0);
    const north = center === 1 ? 1 : cell(0, -1);
    const south = center === 1 ? 1 : cell(0, 1);
    const corner = (x, z, sideX, sideZ) => center === 1 ? 1 : averageCorner(center, sideX, sideZ, cell(x, z));
    const heights = [corner(-1, -1, west, north), corner(-1, 1, west, south),
        corner(1, 1, east, south), corner(1, -1, east, north)];
    let flowX = 0, flowZ = 0;
    for (const [dx, dz] of cardinal) {
        const adjacent = sample(dx, 0, dz);
        let drop = 0;
        if (adjacent > exports.EMPTY)
            drop = own - liquidHeight(adjacent - 1);
        else if (adjacent === exports.EMPTY) {
            const below = sample(dx, -1, dz);
            if (below > exports.EMPTY)
                drop = own + SOURCE_HEIGHT - liquidHeight(below - 1);
        }
        flowX += dx * drop;
        flowZ += dz * drop;
    }
    const length = Math.hypot(flowX, flowZ);
    if (length < 1e-6)
        return { heights, flowUv: undefined };
    const x = flowX / length, z = flowZ / length;
    const flowUv = topCorners.flatMap(([dx, dz]) => [
        exports.FLOW_TOP_UV_BIAS + 0.5 + z * dx - x * dz,
        exports.FLOW_TOP_UV_BIAS + 0.5 + x * dx + z * dz,
    ]);
    return { heights, flowUv };
}
function liquidFrameAt(frames, tick) {
    const duration = frames.reduce((total, [, ticks]) => total + ticks, 0);
    let offset = tick % duration;
    for (const [tile, ticks] of frames) {
        if (offset < ticks)
            return { tile, remaining: ticks - offset };
        offset -= ticks;
    }
    return { tile: frames[0][0], remaining: 1 };
}
  },
  "./wire.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SESSION_BYTES = exports.MAX_BATCH_BYTES = void 0;
exports.decodeLease = decodeLease;
exports.decodeBatch = decodeBatch;
exports.readBytes = readBytes;
const protocol_js_1 = require("./protocol.js");
const terrain_js_1 = require("./terrain.js");
exports.MAX_BATCH_BYTES = 16 * 1024;
exports.MAX_SESSION_BYTES = 256;
const maxEntities = 24;
const maxEntityAxis = 30_000_000;
const maxPaths = 8;
const maxInventorySlots = 160;
const maxPathPoints = 128;
const pathScale = 256;
const maxPathCoordinate = 30_000_000 * pathScale;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function invalid() {
    throw new Error("Invalid viewer reply");
}
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return invalid();
    return value;
}
function json(bytes) {
    return object(JSON.parse(utf8.decode(bytes)));
}
function unsigned(value, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
        return invalid();
    return value;
}
function vec3(value) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
        return invalid();
    return [value[0], value[1], value[2]];
}
function position(value) {
    const coordinates = vec3(value);
    if (!coordinates.every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647))
        return invalid();
    return coordinates;
}
function decodePaths(value) {
    if (!Array.isArray(value) || value.length > maxPaths)
        return invalid();
    const names = new Set();
    let total = 0;
    return value.map(entry => {
        const { name, color, points } = object(entry);
        if (typeof name !== "string" || name.length === 0 || name.length > 32 || /[^A-Za-z0-9_-]/.test(name) || names.has(name))
            return invalid();
        names.add(name);
        if (!Array.isArray(points) || points.length === 0 || (total += points.length) > maxPathPoints)
            return invalid();
        return {
            name,
            color: unsigned(color, 0xFFFFFF),
            points: points.map((point) => {
                const coordinates = vec3(point);
                if (!coordinates.every(n => Number.isSafeInteger(n) && Math.abs(n) <= maxPathCoordinate))
                    return invalid();
                return [coordinates[0] / pathScale, coordinates[1] / pathScale, coordinates[2] / pathScale];
            }),
        };
    });
}
function integer(value, min, max) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
        return invalid();
    return value;
}
function entityName(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 64 || /[^a-z0-9_]/.test(value))
        return invalid();
    return value;
}
function decodeEntities(value) {
    if (!Array.isArray(value) || value.length > maxEntities)
        return invalid();
    const ids = new Set();
    return value.map(entry => {
        const { id, position: point, species: rawSpecies, yaw, pitch, pose, item, appearance } = object(entry);
        const species = entityName(rawSpecies);
        const key = integer(id, 1, Number.MAX_SAFE_INTEGER);
        if (ids.has(key))
            return invalid();
        ids.add(key);
        const where = vec3(point);
        if (!where.every(axis => Math.abs(axis) <= maxEntityAxis))
            return invalid();
        if (typeof yaw !== "number" || !Number.isFinite(yaw) || yaw < 0 || yaw >= 360)
            return invalid();
        if (typeof pitch !== "number" || !Number.isFinite(pitch) || pitch < -180 || pitch >= 180)
            return invalid();
        const entity = { id: key, position: where, species, yaw, pitch, pose: unsigned(pose, 0xFFFFFFFF) };
        if (item !== undefined) {
            if (species !== "item")
                return invalid();
            const { name, count } = object(item);
            entity.item = { name: entityName(name), count: integer(count, 1, 999) };
        }
        if (appearance !== undefined) {
            if (species !== "player")
                return invalid();
            const { model, key } = object(appearance);
            if (model !== "classic" && model !== "slim")
                return invalid();
            if (typeof key !== "string" || (key !== `default-${model}` && (key.length !== 64 || /[^0-9a-f]/.test(key))))
                return invalid();
            entity.appearance = { model, key };
        }
        else if (species === "player") {
            return invalid();
        }
        return entity;
    });
}
function decodeHud(value) {
    const { health, food, selected, slots, mining, breaking, ice } = object(value);
    if (typeof health !== "number" || !Number.isFinite(health) || health < 0 || health > 2048)
        return invalid();
    if (!Array.isArray(slots) || slots.length !== 9)
        return invalid();
    const decoded = {
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
        }
        else {
            const target = object(breaking);
            decoded.breaking = { position: position(target.position), stage: integer(target.stage, 0, 9) };
        }
    }
    return decoded;
}
function stack(entry) {
    if (entry === null)
        return null;
    const { item, count } = object(entry);
    if (typeof item !== "string" || !/^[a-z0-9_]{1,64}$/.test(item))
        return invalid();
    return { item, count: integer(count, 1, 999) };
}
function pair(entry) {
    if (entry === null)
        return null;
    if (!Array.isArray(entry) || entry.length !== 2)
        return invalid();
    const [item, count] = entry;
    if (typeof item !== "string" || !/^[a-z0-9_]{1,64}$/.test(item))
        return invalid();
    return { item, count: integer(count, 1, 999) };
}
function flag(value) {
    if (value === undefined)
        return false;
    if (typeof value !== "boolean")
        return invalid();
    return value;
}
const maxDebugCoordinate = 30_000_000 * 4;
function registryId(value) {
    if (value === null)
        return null;
    if (typeof value !== "string" || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value) || value.length > 64)
        return invalid();
    return value;
}
function decodeDebug(value) {
    const { feet, rotation, dimension, time, target } = object(value);
    if (!Array.isArray(rotation) || rotation.length !== 2 || !rotation.every(Number.isFinite))
        return invalid();
    if (Math.abs(rotation[0]) > 1e7 || Math.abs(rotation[1]) > 90)
        return invalid();
    const position3 = vec3(feet);
    if (!position3.every(n => Math.abs(n) <= maxDebugCoordinate))
        return invalid();
    const name = registryId(dimension);
    if (name === null)
        return invalid();
    const decoded = {
        feet: position3,
        rotation: [rotation[0], rotation[1]],
        dimension: name,
        time: time === null ? null : integer(time, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        target: null,
    };
    if (target === null)
        return decoded;
    const hit = object(target);
    if (hit.kind === "entity") {
        decoded.target = { kind: "entity", id: registryId(hit.id) };
    }
    else if (hit.kind === "block") {
        const where = position(hit.position);
        let props = null;
        if (hit.props !== null) {
            const entries = Object.entries(object(hit.props));
            if (entries.length > 16)
                return invalid();
            props = Object.create(null);
            for (const [key, entry] of entries) {
                if (!/^[a-z0-9_]{1,32}$/.test(key) || typeof entry !== "string" || !/^[a-z0-9_]{1,32}$/.test(entry))
                    return invalid();
                props[key] = entry;
            }
        }
        decoded.target = { kind: "block", position: where, id: registryId(hit.id), props };
    }
    else {
        return invalid();
    }
    return decoded;
}
function decodeInventory(value) {
    if (value === null)
        return null;
    const { menu, revision, layout, slots, cursor, pending, ready } = object(value);
    if (typeof layout !== "string" || !/^[a-z0-9_]{1,32}$/.test(layout))
        return invalid();
    if (!Array.isArray(slots) || slots.length > maxInventorySlots || typeof pending !== "boolean")
        return invalid();
    return { menu: unsigned(menu, 0xFFFFFFFF), revision: unsigned(revision, 0xFFFFFFFF), layout, slots: slots.map(pair), cursor: pair(cursor), pending, ready: ready === undefined ? true : flag(ready) };
}
function decodeControl(value) {
    if (value === null)
        return null;
    const { grant, ack, mode, canPlay, canReturn, canResume, canRestart, canChat, chatSupported, checkpoint, marker, inventory } = object(value);
    if (mode !== "available" && mode !== "play" && mode !== "pause" && mode !== "inventory")
        return invalid();
    if (checkpoint !== undefined && checkpoint !== "none" && checkpoint !== "pending" && checkpoint !== "parked")
        return invalid();
    const control = {
        grant: unsigned(grant, 0xFFFFFFFF), ack: unsigned(ack, 0xFFFFFFFF), mode,
        canReturn: flag(canReturn), canPlay: canPlay === undefined ? true : flag(canPlay), canResume: flag(canResume), canRestart: flag(canRestart), canChat: flag(canChat), chatSupported: chatSupported === undefined ? true : flag(chatSupported), checkpoint: checkpoint ?? "none",
    };
    if (marker !== undefined)
        control.marker = marker === null ? null : vec3(marker);
    if (inventory !== undefined)
        control.inventory = decodeInventory(inventory);
    return control;
}
function decodeChat(value) {
    const { epoch, entries } = object(value);
    if (!Array.isArray(entries) || entries.length > 16)
        return invalid();
    return {
        epoch: unsigned(epoch, 0xFFFFFFFF),
        entries: entries.map((entry) => {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[1] !== "string" || entry[1].length > 2048)
                return invalid();
            return [unsigned(entry[0], 0xFFFFFFFF), entry[1]];
        }),
    };
}
function decodeLease(bytes) {
    const { lease } = json(bytes);
    if (typeof lease !== "string" || !/^(?:[0-9a-f]{2}){1,64}$/i.test(lease))
        return invalid();
    return lease;
}
function decodeBatch(bytes) {
    if (bytes.length < 2 || bytes.length > exports.MAX_BATCH_BYTES)
        return invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerEnd = 2 + view.getUint16(0, true);
    if (headerEnd > bytes.length)
        return invalid();
    const header = json(bytes.subarray(2, headerEnd));
    const status = header.status;
    if (status !== "waiting" && status !== "unsupported" && status !== "pack_mismatch" && status !== "ready")
        return invalid();
    const cursor = { epoch: unsigned(header.epoch), seq: unsigned(header.seq) };
    let batch;
    if (status === "ready") {
        const { protocol, yaw } = header;
        if (!(0, protocol_js_1.isProtocol)(protocol) || typeof yaw !== "number" || !Number.isFinite(yaw))
            return invalid();
        batch = { ...cursor, status, protocol, yaw };
        if (header.paths !== undefined)
            batch.paths = decodePaths(header.paths);
        if (header.entities !== undefined)
            batch.entities = decodeEntities(header.entities);
    }
    else if (status === "pack_mismatch") {
        const { protocol, packProtocol } = header;
        if (!(0, protocol_js_1.isProtocol)(protocol) || typeof packProtocol !== "number" || !Number.isFinite(packProtocol))
            return invalid();
        if (header.paths !== undefined || header.entities !== undefined)
            return invalid();
        batch = { ...cursor, status, protocol, packProtocol };
    }
    else {
        if (header.paths !== undefined || header.entities !== undefined)
            return invalid();
        batch = { ...cursor, status };
    }
    if (header.hud !== undefined) {
        if (status !== "ready")
            return invalid();
        batch.hud = decodeHud(header.hud);
    }
    if (header.debug !== undefined) {
        if (status !== "ready")
            return invalid();
        batch.debug = decodeDebug(header.debug);
    }
    if (header.control !== undefined) {
        if (status !== "ready")
            return invalid();
        batch.control = decodeControl(header.control);
    }
    if (header.chat !== undefined) {
        if (status !== "ready")
            return invalid();
        batch.chat = decodeChat(header.chat);
    }
    if (header.center !== undefined)
        batch.center = position(header.center);
    if (header.eye !== undefined)
        batch.eye = vec3(header.eye);
    if (header.look !== undefined) {
        batch.look = vec3(header.look);
        const length = Math.hypot(...batch.look);
        if (!Number.isFinite(length) || length === 0)
            return invalid();
    }
    if (header.air !== undefined) {
        if (!Array.isArray(header.air))
            return invalid();
        batch.air = header.air.map(id => unsigned(id, 65535));
    }
    if (header.section !== undefined) {
        if (status !== "ready")
            return invalid();
        const section = object(header.section);
        const where = position(section.position);
        if (section.kind === "states") {
            if (bytes.length - headerEnd !== terrain_js_1.SECTION_VOLUME * 2)
                return invalid();
            const states = new Uint16Array(terrain_js_1.SECTION_VOLUME);
            for (let i = 0; i < states.length; i++)
                states[i] = view.getUint16(headerEnd + i * 2, true);
            batch.section = { position: where, kind: "states", states };
            return batch;
        }
        if (section.kind !== "air" && section.kind !== "unloaded")
            return invalid();
        batch.section = { position: where, kind: section.kind };
    }
    if (bytes.length !== headerEnd)
        return invalid();
    return batch;
}
async function readBytes(response, limit) {
    const reader = response.body?.getReader();
    if (!reader)
        return invalid();
    const bytes = new Uint8Array(limit);
    let length = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                return bytes.subarray(0, length);
            if (length + value.length > limit) {
                await reader.cancel();
                return invalid();
            }
            bytes.set(value, length);
            length += value.length;
        }
    }
    finally {
        reader.releaseLock();
    }
}
  },
  "./camera.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unitLook = unitLook;
exports.cameraMatrix = cameraMatrix;
const f = 1 / Math.tan(Math.PI / 6);
const near = 0.05;
const far = 256;
const depth = (far + near) / (far - near);
const bias = -2 * far * near / (far - near);
function unitLook(look) {
    const length = Math.hypot(...look);
    if (look.length !== 3 || length === 0 || !Number.isFinite(length)) {
        throw new RangeError("Expected a finite, nonzero look vector");
    }
    return [look[0] / length, look[1] / length, look[2] / length];
}
function cameraMatrix([x, y, z], aspect, yaw) {
    const radians = (yaw % 360) * (Math.PI / 180);
    const rightX = -Math.cos(radians);
    const rightZ = -Math.sin(radians);
    const upX = -rightZ * y;
    const upY = rightZ * x - rightX * z;
    const upZ = rightX * y;
    return new Float32Array([
        rightX * f / aspect, upX * f, x * depth, x,
        0, upY * f, y * depth, y,
        rightZ * f / aspect, upZ * f, z * depth, z,
        0, 0, bias, 0,
    ]);
}
  },
  "./terrain.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Terrain = exports.CUBE_VERTICES = exports.MAX_MISSING_REPORTS = exports.NO_TILE_BYTE = exports.VERTEX_UV_SCALE = exports.VERTEX_POSITION_SCALE = exports.VERTEX_STRIDE = exports.SECTION_VOLUME = exports.SECTION_SIZE = void 0;
exports.faceUv = faceUv;
exports.describeMissingTexture = describeMissingTexture;
exports.fillCube = fillCube;
exports.sectionKey = sectionKey;
exports.cellIndex = cellIndex;
const block_models_js_1 = require("./block-models.js");
const liquid_js_1 = require("./liquid.js");
exports.SECTION_SIZE = 16;
exports.SECTION_VOLUME = exports.SECTION_SIZE ** 3;
exports.VERTEX_STRIDE = 14;
exports.VERTEX_POSITION_SCALE = 32;
exports.VERTEX_UV_SCALE = 32;
exports.NO_TILE_BYTE = 255;
const SECTION_MASK = exports.SECTION_SIZE - 1;
const faces = [
    { step: [1, 0, 0], corners: [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1] },
    { step: [-1, 0, 0], corners: [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0] },
    { step: [0, 1, 0], corners: [0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0] },
    { step: [0, -1, 0], corners: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1] },
    { step: [0, 0, 1], corners: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1] },
    { step: [0, 0, -1], corners: [0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0] },
];
const triangles = [0, 3, 6, 0, 6, 9];
const quadOrder = [0, 1, 2, 0, 2, 3];
const cubeOrder = quadOrder;
const doubleSidedOrder = [...quadOrder, 0, 2, 1, 0, 3, 2];
function uprightPlane(x1, z1, x2, z2) {
    return [x1, 0, z1, x1, 1, z1, x2, 1, z2, x2, 0, z2];
}
const cross = [uprightPlane(0, 0, 1, 1), uprightPlane(1, 0, 0, 1)];
const crossUv = [0, 1, 0, 0, 1, 0, 1, 1];
const palette = [
    [154, 161, 192], [111, 187, 139], [111, 121, 155], [215, 149, 105],
    [97, 191, 199], [238, 203, 134], [187, 143, 191], [202, 103, 114],
];
function stateColor(state) {
    if (state < palette.length)
        return palette[state];
    const hash = Math.imul(state, 0x9e3779b1);
    return [96 + (hash & 127), 96 + ((hash >>> 8) & 127), 96 + ((hash >>> 16) & 127)];
}
function faceUv(face, x, y, z) {
    switch (face) {
        case 0: return [1 - z, 1 - y];
        case 1: return [z, 1 - y];
        case 2: return [x, z];
        case 3: return [x, 1 - z];
        case 4: return [x, 1 - y];
        default: return [1 - x, 1 - y];
    }
}
const CUTOUT_MODELS = new Set(["leaves", "cross", "crop", "glass", "fence", "lantern", "torch", "rail", "composter"]);
exports.MAX_MISSING_REPORTS = 256;
function describeMissingTexture({ state, name, reason, faces }) {
    const detail = reason === "no-atlas-entry" ? "is unresolved in the built atlas" : `has faces ${faces.join(",")} unresolved in the built atlas`;
    return `Missing block texture: ${name ? `${name} ` : ""}state ${state} ${detail}; drawing a flat color`;
}
const MAX_CACHED_MODELS = 1024;
function offset(position, [dx, dy, dz]) {
    return [position[0] + dx, position[1] + dy, position[2] + dz];
}
function fillCube(out, origin, eye, tileX, tileY, solidAt) {
    let n = 0;
    for (let f = 0; f < faces.length; f++) {
        const { corners, step } = faces[f];
        if (solidAt(origin[0] + step[0], origin[1] + step[1], origin[2] + step[2]))
            continue;
        for (const i of triangles) {
            const [baseU, v] = faceUv(f, corners[i], corners[i + 1], corners[i + 2]);
            const u = f < 2 ? 1 - baseU : baseU;
            out[n++] = origin[0] + corners[i] - eye[0];
            out[n++] = origin[1] + corners[i + 1] - eye[1];
            out[n++] = origin[2] + corners[i + 2] - eye[2];
            out[n++] = 0;
            out[n++] = 0;
            out[n++] = 0;
            out[n++] = u;
            out[n++] = v;
            out[n++] = tileX;
            out[n++] = tileY;
        }
    }
    return n / 10;
}
exports.CUBE_VERTICES = faces.length * triangles.length;
function sectionKey(position) {
    return position.join(",");
}
function cellIndex(x, y, z) {
    return x + exports.SECTION_SIZE * (z + exports.SECTION_SIZE * y);
}
function boundaryChanged(previous, next, [dx, dy, dz]) {
    for (let y = dy > 0 ? SECTION_MASK : 0; y <= (dy < 0 ? 0 : SECTION_MASK); y++) {
        for (let z = dz > 0 ? SECTION_MASK : 0; z <= (dz < 0 ? 0 : SECTION_MASK); z++) {
            for (let x = dx > 0 ? SECTION_MASK : 0; x <= (dx < 0 ? 0 : SECTION_MASK); x++) {
                const i = cellIndex(x, y, z);
                if (previous[i] !== next[i])
                    return true;
            }
        }
    }
    return false;
}
class Terrain {
    quadSource;
    reportMissing;
    sections = new Map();
    dirty = new Map();
    air = new Set();
    quadCache = new Map();
    textures = null;
    reportedFor = null;
    reportedStates = new Uint8Array(65536);
    reportedUnknown = new Set();
    constructor(airStateIds, quadSource = block_models_js_1.modelQuads, reportMissing) {
        this.quadSource = quadSource;
        this.reportMissing = reportMissing;
        for (const id of airStateIds) {
            if (!Number.isInteger(id) || id < 0 || id > 65535)
                throw new RangeError("Invalid air state ID");
            this.air.add(id);
        }
    }
    replaceSection(position, states) {
        if (position.length !== 3 || position.some(value => !Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
            throw new RangeError("Expected signed 32-bit section coordinates");
        }
        if (states !== null && states.length !== exports.SECTION_VOLUME) {
            throw new RangeError(`Expected ${exports.SECTION_VOLUME} section states`);
        }
        const key = sectionKey(position);
        const previous = this.sections.get(key);
        if (previous && states?.every((state, i) => state === previous.states[i]))
            return false;
        const populated = states !== null && !states.every(id => this.air.has(id));
        if (!populated && !previous)
            return false;
        if (populated) {
            const storedPosition = previous?.position ?? [...position];
            this.sections.set(key, { position: storedPosition, states: states.slice() });
            this.dirty.set(key, storedPosition);
        }
        else {
            this.sections.delete(key);
            this.dirty.delete(key);
        }
        const markNeighbor = (step, diagonal = false) => {
            const key = sectionKey(offset(position, step));
            const neighbor = this.sections.get(key);
            if (neighbor && (!diagonal || !previous || !populated || boundaryChanged(previous.states, states, step))) {
                this.dirty.set(key, neighbor.position);
            }
        };
        for (const face of faces)
            markNeighbor(face.step);
        if (this.textures?.modelFor) {
            for (let dy = -1; dy <= 1; dy++)
                for (let dz = -1; dz <= 1; dz++)
                    for (let dx = -1; dx <= 1; dx++) {
                        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1)
                            markNeighbor([dx, dy, dz], true);
                    }
        }
        return true;
    }
    setTextures(source) {
        if (this.textures === source)
            return;
        this.textures = source;
        if (source && source !== this.reportedFor) {
            this.reportedFor = source;
            this.reportedStates.fill(0);
            this.reportedUnknown.clear();
        }
        this.quadCache.clear();
        this.markAllDirty();
    }
    clear() {
        this.sections.clear();
        this.dirty.clear();
    }
    markAllDirty() {
        for (const [key, { position }] of this.sections)
            this.dirty.set(key, position);
    }
    takeDirty() {
        const positions = [...this.dirty.values()];
        this.dirty.clear();
        return positions;
    }
    stateAt(x, y, z) {
        const section = this.sections.get(sectionKey([x >> 4, y >> 4, z >> 4]));
        return section?.states[cellIndex(x & SECTION_MASK, y & SECTION_MASK, z & SECTION_MASK)];
    }
    solidAt(x, y, z) {
        const state = this.stateAt(x, y, z);
        return state !== undefined && !this.air.has(state);
    }
    opaqueAt(x, y, z) {
        return this.isOpaque(this.stateAt(x, y, z));
    }
    isOpaque(state) {
        return state !== undefined && !this.air.has(state) && this.textures?.modelFor?.(state) === undefined;
    }
    hides(model, adjacent) {
        if (adjacent === undefined || this.air.has(adjacent))
            return false;
        const adjacentModel = this.textures?.modelFor?.(adjacent);
        if (adjacentModel === undefined)
            return true;
        return adjacentModel === model && (model === "glass" || model === "water" || model === "lava");
    }
    quadsFor(model, variant) {
        if (!Number.isFinite(variant))
            return this.quadSource(model, 0);
        const key = `${model}:${variant}`;
        let quads = this.quadCache.get(key);
        if (!quads) {
            quads = this.quadSource(model, variant);
            if (this.quadCache.size >= MAX_CACHED_MODELS)
                this.quadCache.clear();
            this.quadCache.set(key, quads);
        }
        return quads;
    }
    noteMissing(state, face) {
        const { textures } = this;
        if (!textures || !this.reportMissing || textures.invisibleFor?.(state))
            return;
        const tiles = textures.tilesFor(state);
        const reason = tiles ? "face-without-tile" : "no-atlas-entry";
        const bit = reason === "no-atlas-entry" ? 1 : 2;
        if (Number.isInteger(state) && state >= 0 && state < 65536 && textures.registered?.(state) !== false) {
            if (this.reportedStates[state] & bit)
                return;
            this.reportedStates[state] |= bit;
        }
        else {
            const key = `${state}:${reason}`;
            if (this.reportedUnknown.has(key) || this.reportedUnknown.size > exports.MAX_MISSING_REPORTS)
                return;
            this.reportedUnknown.add(key);
            if (this.reportedUnknown.size > exports.MAX_MISSING_REPORTS) {
                console.warn(`Missing block textures: more than ${exports.MAX_MISSING_REPORTS} unregistered state IDs; further reports suppressed`);
                return;
            }
        }
        const faces = tiles ? tiles.flatMap((tile, f) => tile < 0 ? [f] : []) : [];
        this.reportMissing({ state, name: textures.nameFor?.(state), reason, faces: faces.length ? faces : [face] });
    }
    hasSection(key) {
        return this.sections.has(key);
    }
    mesh(position, waterOnly = false) {
        const section = this.sections.get(sectionKey(position));
        if (!section)
            return null;
        const { states } = section;
        const neighbors = faces.map(face => this.sections.get(sectionKey(offset(position, face.step)))?.states);
        let bytes = new Uint8Array(1024 * exports.VERTEX_STRIDE);
        let view = new DataView(bytes.buffer);
        let length = 0;
        const columns = this.textures?.columns ?? 1;
        let current = -1;
        const adjacentAt = (x, y, z, f) => {
            const [dx, dy, dz] = faces[f].step;
            const nx = x + dx, ny = y + dy, nz = z + dz;
            const outside = nx < 0 || ny < 0 || nz < 0 || nx === exports.SECTION_SIZE || ny === exports.SECTION_SIZE || nz === exports.SECTION_SIZE;
            return outside
                ? neighbors[f]?.[cellIndex(nx & SECTION_MASK, ny & SECTION_MASK, nz & SECTION_MASK)]
                : states[cellIndex(nx, ny, nz)];
        };
        const liquidNeighbors = new Map();
        const liquidStateAt = (x, y, z) => {
            const dx = x >> 4, dy = y >> 4, dz = z >> 4;
            if ((dx | dy | dz) === 0)
                return states[cellIndex(x, y, z)];
            const key = dx + 3 * dy + 9 * dz;
            if (!liquidNeighbors.has(key)) {
                liquidNeighbors.set(key, this.sections.get(sectionKey(offset(position, [dx, dy, dz])))?.states);
            }
            return liquidNeighbors.get(key)?.[cellIndex(x & SECTION_MASK, y & SECTION_MASK, z & SECTION_MASK)];
        };
        const emit = (x, y, z, corners, uv, order, color, tile, material, face) => {
            if (length + order.length * exports.VERTEX_STRIDE > bytes.length) {
                const larger = new Uint8Array(bytes.length * 2);
                larger.set(bytes);
                bytes = larger;
                view = new DataView(bytes.buffer);
            }
            if (tile < 0)
                this.noteMissing(current, face);
            const tileX = tile < 0 ? exports.NO_TILE_BYTE : tile % columns;
            const tileY = tile < 0 ? exports.NO_TILE_BYTE : Math.floor(tile / columns);
            for (const index of order) {
                const cx = corners[index * 3], cy = corners[index * 3 + 1], cz = corners[index * 3 + 2];
                view.setInt16(length, Math.round((x + cx) * exports.VERTEX_POSITION_SCALE), true);
                view.setInt16(length + 2, Math.round((y + cy) * exports.VERTEX_POSITION_SCALE), true);
                view.setInt16(length + 4, Math.round((z + cz) * exports.VERTEX_POSITION_SCALE), true);
                bytes[length + 6] = color[0];
                bytes[length + 7] = color[1];
                bytes[length + 8] = color[2];
                const [u, v] = uv ? [uv[index * 2], uv[index * 2 + 1]] : faceUv(face, cx, cy, cz);
                bytes[length + 9] = Math.round(u * exports.VERTEX_UV_SCALE);
                bytes[length + 10] = Math.round(v * exports.VERTEX_UV_SCALE);
                bytes[length + 11] = tileX;
                bytes[length + 12] = tileY;
                bytes[length + 13] = material;
                length += exports.VERTEX_STRIDE;
            }
        };
        for (let y = 0; y < exports.SECTION_SIZE; y++) {
            for (let z = 0; z < exports.SECTION_SIZE; z++) {
                for (let x = 0; x < exports.SECTION_SIZE; x++) {
                    const state = states[cellIndex(x, y, z)];
                    if (this.air.has(state))
                        continue;
                    current = state;
                    const model = this.textures?.modelFor?.(state);
                    if ((model === "water") !== waterOnly)
                        continue;
                    const tiles = this.textures?.tilesFor(state);
                    const variant = this.textures?.variantFor?.(state) ?? 0;
                    const mesh = model === "mesh" ? this.textures?.meshes?.[variant] : undefined;
                    const material = Number(mesh?.cutout || (model !== undefined && CUTOUT_MODELS.has(model)));
                    if (model === "water" || model === "lava") {
                        const coveredTop = this.isOpaque(adjacentAt(x, y, z, 2));
                        const visible = faces.map((_, f) => !this.hides(model, adjacentAt(x, y, z, f)));
                        if (!coveredTop && !visible.some(Boolean))
                            continue;
                        const { heights, flowUv } = (0, liquid_js_1.liquidSurface)(variant, (dx, dy, dz) => {
                            const nearby = liquidStateAt(x + dx, y + dy, z + dz);
                            if (nearby === undefined || this.air.has(nearby))
                                return liquid_js_1.EMPTY;
                            return this.textures?.modelFor?.(nearby) === model ? (this.textures.variantFor?.(nearby) ?? 0) + 1 : liquid_js_1.BLOCKED;
                        });
                        if (coveredTop && heights.some(height => height < 1))
                            visible[2] = true;
                        const color = stateColor(state);
                        for (let f = 0; f < faces.length; f++) {
                            if (!visible[f])
                                continue;
                            const rotated = f === 2 && flowUv !== undefined;
                            const flowing = rotated || (f !== 2 && f !== 3);
                            const corners = faces[f].corners.map((value, i, coords) => {
                                if (i % 3 !== 1 || value === 0)
                                    return value;
                                const cx = coords[i - 1], cz = coords[i + 1];
                                return heights[cx === 0 ? cz : 3 - cz];
                            });
                            const tile = tiles?.[rotated ? 0 : f] ?? -1;
                            emit(x, y, z, corners, rotated ? flowUv : undefined, quadOrder, color, tile, (0, liquid_js_1.liquidMaterial)(model, flowing, rotated), f);
                        }
                        continue;
                    }
                    if (model === "cross") {
                        const color = stateColor(state);
                        for (const corners of cross) {
                            emit(x, y, z, corners, crossUv, doubleSidedOrder, color, tiles?.[0] ?? -1, material, 0);
                        }
                        continue;
                    }
                    if (model !== undefined && model !== "leaves" && model !== "glass" && (model !== "mesh" || mesh)) {
                        const color = stateColor(state);
                        for (const quad of mesh?.quads ?? this.quadsFor(model, variant)) {
                            if (quad.boundary !== undefined && this.hides(model, adjacentAt(x, y, z, quad.boundary)))
                                continue;
                            emit(x, y, z, quad.corners, quad.uv, quad.doubleSided ? doubleSidedOrder : quadOrder, color, tiles?.[quad.face] ?? -1, material, quad.face);
                        }
                        continue;
                    }
                    let color;
                    for (let f = 0; f < faces.length; f++) {
                        if (this.hides(model, adjacentAt(x, y, z, f)))
                            continue;
                        color ??= stateColor(state);
                        emit(x, y, z, faces[f].corners, undefined, cubeOrder, color, tiles?.[f] ?? -1, material, f);
                    }
                }
            }
        }
        return length ? bytes.subarray(0, length) : null;
    }
}
exports.Terrain = Terrain;
  },
  "./control.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ControlMachine = void 0;
class ControlMachine {
    env;
    mode = "view";
    grant = null;
    intervened = false;
    awaitingLock = false;
    resumed = false;
    locked = false;
    returnTo = null;
    pausedFrom = "keyboard";
    recapturable = false;
    clickCapture = false;
    constructor(env) {
        this.env = env;
    }
    get ui() {
        return this.mode === "play" ? "play" : this.mode === "inventory" ? "inventory" : "menu";
    }
    get captureOnClick() {
        return this.mode === "play" && this.recapturable && !this.locked;
    }
    get label() {
        return this.resumed ? "Resume play" : "Intervene";
    }
    set(mode) {
        if (mode === this.mode)
            return;
        const previous = this.mode;
        if (mode === "inventory") {
            if (previous === "play")
                this.returnTo = this.locked ? "locked" : "keyboard";
            else
                this.returnTo = null;
        }
        if (mode !== "play")
            this.recapturable = false;
        this.mode = mode;
        this.env.changed(mode, previous);
    }
    release(mode) {
        if (mode === "pause" && this.mode === "play")
            this.pausedFrom = this.locked ? "locked" : "keyboard";
        this.awaitingLock = false;
        this.set(mode);
        this.locked = false;
        this.env.exitLock();
    }
    closeInventory() {
        const back = this.returnTo;
        this.returnTo = null;
        if (this.grant === null || this.mode !== "inventory")
            return;
        if (!back) {
            this.release("idle");
            return;
        }
        this.resumePlay(back);
    }
    resumePlay(back) {
        this.awaitingLock = back === "locked";
        this.resumed = true;
        this.set("play");
        if (back === "locked") {
            this.recapturable = true;
            this.env.requestLock();
        }
    }
    setGrant(grant) {
        if (grant === this.grant)
            return;
        this.grant = grant;
        this.returnTo = null;
        this.resumed = false;
        this.intervened = false;
        if (grant === null)
            this.release("view");
        else
            this.release("idle");
    }
    capture() {
        if (this.grant === null || this.mode === "view")
            return;
        if (this.mode === "play" && (this.locked || !this.recapturable))
            return;
        this.clickCapture = this.mode === "play";
        this.awaitingLock = true;
        this.env.requestLock();
    }
    lockChanged(locked) {
        if (this.grant === null) {
            if (locked)
                this.env.exitLock();
            return;
        }
        if (locked) {
            if (!this.awaitingLock && this.mode !== "play") {
                this.env.exitLock();
                return;
            }
            this.awaitingLock = false;
            this.clickCapture = false;
            this.locked = true;
            this.recapturable = false;
            if (this.mode === "play")
                return;
            this.resumed = true;
            this.set("play");
        }
        else {
            const was = this.locked;
            this.locked = false;
            if (was && this.mode === "play") {
                this.pausedFrom = "locked";
                this.set("pause");
            }
        }
    }
    markIntervened() {
        if (this.intervened)
            return false;
        this.intervened = true;
        return true;
    }
    playUnlocked() {
        if (this.grant === null || (this.mode !== "idle" && this.mode !== "pause"))
            return;
        this.awaitingLock = false;
        this.resumed = true;
        this.set("play");
    }
    lockDenied() {
        this.awaitingLock = false;
        if (this.clickCapture)
            this.recapturable = false;
        this.clickCapture = false;
    }
    key(code) {
        if (this.grant === null)
            return false;
        if (code === "Escape") {
            if (this.mode === "play")
                this.release("pause");
            else if (this.mode === "inventory")
                this.closeInventory();
            else if (this.mode === "pause")
                this.resumePlay(this.pausedFrom);
            return true;
        }
        if (code === "KeyE") {
            if (this.mode === "play" || this.mode === "pause")
                this.release("inventory");
            else if (this.mode === "inventory")
                this.closeInventory();
            else
                return false;
            return true;
        }
        return false;
    }
    follow(host) {
        if (this.grant === null)
            return;
        if (host === "inventory") {
            if (this.mode !== "inventory")
                this.release("inventory");
        }
        else if (this.mode === "inventory") {
            const back = this.returnTo;
            this.returnTo = null;
            if (back)
                this.resumePlay(back);
            else
                this.release("idle");
        }
        else if (host !== "play" && this.mode === "play") {
            this.release("pause");
        }
    }
    suspendLock() {
        if (this.grant === null || this.mode !== "play")
            return false;
        const was = this.locked;
        this.locked = false;
        this.awaitingLock = false;
        this.recapturable = was;
        if (was)
            this.env.exitLock();
        return was;
    }
    resumeLock() {
        if (this.grant === null || this.mode !== "play" || this.locked)
            return;
        this.awaitingLock = true;
        this.recapturable = true;
        this.env.requestLock();
    }
    focusLost() {
        this.awaitingLock = false;
        this.clickCapture = false;
        if (this.mode === "play")
            this.release("pause");
    }
}
exports.ControlMachine = ControlMachine;
  },
  "./input.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputState = exports.MAX_FRAME_PITCH = exports.MAX_FRAME_YAW = exports.TOUCH_DEGREES_PER_PIXEL = exports.MOUSE_DEGREES_PER_PIXEL = exports.KEY = void 0;
exports.KEY = { forward: 1, back: 2, left: 4, right: 8, sneak: 16, jump: 32, attack: 64, use: 128, sprint: 256 };
exports.MOUSE_DEGREES_PER_PIXEL = 0.15;
exports.TOUCH_DEGREES_PER_PIXEL = 0.25;
exports.MAX_FRAME_YAW = 180;
exports.MAX_FRAME_PITCH = 45;
const MAX_EVENT_PIXELS = 400;
const YAW_RATE = 193;
const PITCH_RATE = 151;
const PRECISE_RATE = 40;
const movement = {
    KeyW: exports.KEY.forward, KeyS: exports.KEY.back, KeyA: exports.KEY.left, KeyD: exports.KEY.right, Space: exports.KEY.jump,
    ShiftLeft: exports.KEY.sneak, ShiftRight: exports.KEY.sneak, ControlLeft: exports.KEY.sprint, KeyR: exports.KEY.sprint, KeyQ: exports.KEY.sprint, KeyU: exports.KEY.attack, KeyI: exports.KEY.use,
};
const turning = new Set(["KeyH", "KeyL", "KeyJ", "KeyK"]);
function clamp(value, limit) {
    return Math.max(-limit, Math.min(limit, value));
}
class InputState {
    down = new Set();
    buttons = new Set();
    touch = 0;
    ui = "play";
    edges = new Map();
    dyaw = 0;
    dpitch = 0;
    snap = 0;
    slot = null;
    iceToggle = false;
    last = 0;
    mask() {
        let mask = 0;
        for (const code of this.down)
            mask |= movement[code] ?? 0;
        if (this.buttons.has(0))
            mask |= exports.KEY.attack;
        if (this.buttons.has(2))
            mask |= exports.KEY.use;
        mask |= this.touch;
        if (!(mask & exports.KEY.forward))
            mask &= ~exports.KEY.sprint;
        return mask;
    }
    advance(now) {
        const dt = Math.max(0, Math.min(250, now - this.last)) / 1000;
        this.last = now;
        if (dt === 0 || this.ui !== "play")
            return;
        const shift = this.down.has("ShiftLeft");
        const precise = this.down.has("KeyC");
        const yaw = precise ? PRECISE_RATE : YAW_RATE;
        const pitch = precise ? PRECISE_RATE : PITCH_RATE;
        if (!shift) {
            this.dyaw += ((this.down.has("KeyL") ? 1 : 0) - (this.down.has("KeyH") ? 1 : 0)) * yaw * dt;
        }
        this.dpitch += ((this.down.has("KeyJ") ? 1 : 0) - (this.down.has("KeyK") ? 1 : 0)) * pitch * dt;
    }
    pressing(before, after) {
        for (const action of [exports.KEY.jump, exports.KEY.attack, exports.KEY.use]) {
            if (!(before & action) && after & action)
                this.edges.set(action, (this.edges.get(action) ?? 0) + 1);
        }
    }
    setUi(ui, now) {
        this.advance(now);
        if (ui === this.ui)
            return;
        this.ui = ui;
        this.clear(now);
    }
    clear(now) {
        this.advance(now);
        this.down.clear();
        this.buttons.clear();
        this.touch = 0;
        this.edges.clear();
        this.dyaw = this.dpitch = 0;
        this.snap = 0;
        this.slot = null;
        this.iceToggle = false;
    }
    requeueIce() {
        if (this.ui === "play")
            this.iceToggle = true;
    }
    keyDown(code, now, repeat = false) {
        if (this.ui !== "play")
            return;
        this.advance(now);
        if (repeat || this.down.has(code))
            return;
        if (code === "Backspace") {
            this.iceToggle = !this.iceToggle;
            return;
        }
        const before = this.mask();
        if (turning.has(code) || code === "KeyC") {
            this.down.add(code);
            if ((code === "KeyH" || code === "KeyL") && this.down.has("ShiftLeft"))
                this.snap = code === "KeyH" ? -1 : 1;
            return;
        }
        const digit = /^Digit([1-9])$/.exec(code);
        if (digit) {
            this.slot = Number(digit[1]) - 1;
            return;
        }
        if (!(code in movement))
            return;
        this.down.add(code);
        this.pressing(before, this.mask());
    }
    keyUp(code, now) {
        if (this.ui !== "play")
            return;
        this.advance(now);
        this.down.delete(code);
    }
    mouseDown(button, now) {
        if (this.ui !== "play" || (button !== 0 && button !== 2))
            return;
        this.advance(now);
        const before = this.mask();
        this.buttons.add(button);
        this.pressing(before, this.mask());
    }
    mouseUp(button, now) {
        if (this.ui !== "play")
            return;
        this.advance(now);
        this.buttons.delete(button);
    }
    touchKeys(bits, now) {
        if (this.ui !== "play")
            return;
        this.advance(now);
        const before = this.mask();
        this.touch = bits;
        this.pressing(before, this.mask());
    }
    touchAbort(bits) {
        for (const action of [exports.KEY.jump, exports.KEY.attack, exports.KEY.use])
            if (bits & action)
                this.edges.delete(action);
    }
    touchLook(dx, dy, now) {
        if (this.ui !== "play")
            return;
        this.advance(now);
        if (!Number.isFinite(dx) || !Number.isFinite(dy))
            return;
        this.dyaw += clamp(dx, MAX_EVENT_PIXELS) * exports.TOUCH_DEGREES_PER_PIXEL;
        this.dpitch += clamp(dy, MAX_EVENT_PIXELS) * exports.TOUCH_DEGREES_PER_PIXEL;
    }
    mouseMove(dx, dy, now) {
        if (this.ui !== "play")
            return;
        this.advance(now);
        if (!Number.isFinite(dx) || !Number.isFinite(dy))
            return;
        this.dyaw += clamp(dx, MAX_EVENT_PIXELS) * exports.MOUSE_DEGREES_PER_PIXEL;
        this.dpitch += clamp(dy, MAX_EVENT_PIXELS) * exports.MOUSE_DEGREES_PER_PIXEL;
    }
    frame(now) {
        this.advance(now);
        const play = this.ui === "play";
        const mask = this.mask();
        let taps = 0;
        if (play) {
            const short = (action) => Math.max(0, (this.edges.get(action) ?? 0) - (mask & action ? 1 : 0)) > 0;
            if (short(exports.KEY.jump))
                taps |= 1;
            if (short(exports.KEY.attack))
                taps |= 2;
            if (short(exports.KEY.use))
                taps |= 4;
        }
        const frame = {
            keys: play ? mask : 0,
            taps,
            dyaw: clamp(this.dyaw, exports.MAX_FRAME_YAW),
            dpitch: clamp(this.dpitch, exports.MAX_FRAME_PITCH),
            snap: this.snap,
            slot: this.slot,
            iceToggle: play && this.iceToggle,
            ui: this.ui,
        };
        this.edges.clear();
        this.dyaw = this.dpitch = 0;
        this.snap = 0;
        this.slot = null;
        this.iceToggle = false;
        return frame;
    }
}
exports.InputState = InputState;
  },
  "./inventory.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CELL = void 0;
exports.geometry = geometry;
exports.layout = layout;
exports.buildClick = buildClick;
exports.canHandBack = canHandBack;
exports.CELL = 18;
const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const group = (label, area, slots, columns, x, y) => ({ label, area, slots, columns, x: x - 1, y: y - 1 });
const decor = (kind, x, y, w, h) => ({ kind, x, y, w, h });
function lower(top, y, x = 8) {
    return [group("Inventory", "inventory", range(top, 27), 9, x, y), group("Hotbar", "hotbar", range(top + 27, 9), 9, x, y + 58)];
}
function frame(art, width, height, top, lowerStart, y, extra = []) {
    return { art, width, height, groups: [...top, ...lower(lowerStart, y)], decor: extra };
}
function geometry(inv) {
    const count = inv.slots.length;
    switch (inv.layout) {
        case "player":
            if (count !== 46)
                return null;
            return {
                art: "inventory", width: 176, height: 166, decor: [decor("preview", 26, 8, 50, 75), decor("arrow", 134, 29, 16, 13)],
                groups: [
                    group("Crafting", "crafting", range(1, 4), 2, 98, 18),
                    group("Result", "result", [0], 1, 154, 28),
                    group("Armor", "armor", range(5, 4), 1, 8, 8),
                    group("Offhand", "offhand", [45], 1, 77, 62),
                    ...lower(9, 84),
                ],
            };
        case "crafting":
            if (count !== 46)
                return null;
            return frame("crafting_table", 176, 166, [group("Crafting", "crafting", range(1, 9), 3, 30, 17), group("Result", "result", [0], 1, 124, 35)], 10, 84, [decor("arrow", 90, 35, 22, 15)]);
        case "furnace":
            if (count !== 39)
                return null;
            return frame("furnace", 176, 166, [group("Input", "input", [0], 1, 56, 17), group("Fuel", "fuel", [1], 1, 56, 53), group("Output", "output", [2], 1, 116, 35)], 3, 84, [decor("flame", 56, 36, 14, 14), decor("arrow", 79, 34, 24, 17)]);
        case "hopper":
            if (count !== 41)
                return null;
            return frame("hopper", 176, 133, [group("Hopper", "container", range(0, 5), 5, 44, 20)], 5, 51);
        case "brewing":
            if (count !== 41)
                return null;
            return frame("brewing_stand", 176, 166, [
                group("Fuel", "fuel", [4], 1, 17, 17),
                group("Ingredient", "ingredient", [3], 1, 79, 17),
                group("Bottle 1", "bottle-1", [0], 1, 56, 51),
                group("Bottle 2", "bottle-2", [1], 1, 79, 58),
                group("Bottle 3", "bottle-3", [2], 1, 102, 51),
            ], 5, 84, [decor("fuel", 60, 44, 18, 4), decor("bubbles", 63, 14, 12, 29), decor("arrow", 97, 16, 9, 28)]);
        case "anvil":
            if (count !== 39)
                return null;
            return frame("anvil", 176, 166, [group("Left", "left", [0], 1, 27, 47), group("Right", "right", [1], 1, 76, 47), group("Result", "result", [2], 1, 134, 47)], 3, 84, [decor("name", 59, 20, 110, 16), decor("arrow", 99, 47, 22, 15)]);
        case "enchantment":
            if (count !== 38)
                return null;
            return frame("enchanting_table", 176, 166, [group("Item", "item", [0], 1, 15, 47), group("Lapis", "lapis", [1], 1, 35, 47)], 2, 84, [decor("offers", 60, 14, 108, 57)]);
        case "merchant":
            if (count !== 39)
                return null;
            return {
                art: "villager", width: 276, height: 166, decor: [decor("trades", 5, 17, 88, 140), decor("arrow", 186, 36, 22, 15)],
                groups: [group("Payment 1", "payment-1", [0], 1, 136, 37), group("Payment 2", "payment-2", [1], 1, 162, 37), group("Result", "result", [2], 1, 220, 37), ...lower(3, 84, 108)],
            };
        case "chest": {
            const top = count - 36;
            if (top < 9 || top > 54 || top % 9 !== 0)
                return null;
            const rows = top / 9;
            return frame(`chest_${rows}`, 176, 114 + 18 * rows, [group("Chest", "container", range(0, top), 9, 8, 18)], top, 18 * rows + 30);
        }
        default:
            return null;
    }
}
function layout(inv) {
    return geometry(inv)?.groups ?? null;
}
function buildClick(inv, op, slot, button) {
    if (inv.pending || inv.ready === false || !layout(inv) || !Number.isInteger(slot) || slot < 0 || slot >= inv.slots.length || slot > 127)
        return null;
    const base = { menu: inv.menu, revision: inv.revision, slot };
    switch (op) {
        case "pickup": return { ...base, op: 0, button: 0 };
        case "split": return { ...base, op: 0, button: 1 };
        case "quick": return { ...base, op: 1, button: button === 1 ? 1 : 0 };
        case "swap": return button >= 0 && button <= 8 ? { ...base, op: 2, button } : null;
    }
}
function canHandBack(canReturn, inv, clickPending) {
    return canReturn && !clickPending && (!inv || (inv.cursor === null && !inv.pending));
}
  },
  "./entity-geometry.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORTED_KINDS = void 0;
exports.modelParts = modelParts;
exports.poseRotations = poseRotations;
exports.shade = shade;
exports.emitModel = emitModel;
exports.SUPPORTED_KINDS = ["item", "cow", "sheep", "pig", "chicken", "villager", "player"];
const HALF_PI = Math.PI / 2;
const RAD = Math.PI / 180;
const quadruped = (head, body, legs, legBox) => [
    head,
    body,
    ...["right_hind", "left_hind", "right_front", "left_front"].map((name, i) => ({
        name: `${name}_leg`, pivot: [legs[i][0], legs[i][1], legs[i][2]], boxes: [legBox],
    })),
];
const leg4 = { u: 0, v: 16, x: -2, y: 0, z: -2, w: 4, h: 12, d: 4 };
const MODELS = {
    cow: quadruped({
        name: "head", pivot: [0, 4, -8], boxes: [
            { u: 0, v: 0, x: -4, y: -4, z: -6, w: 8, h: 8, d: 6 },
            { u: 22, v: 0, x: -5, y: -5, z: -5, w: 1, h: 3, d: 1 },
            { u: 22, v: 0, x: 4, y: -5, z: -5, w: 1, h: 3, d: 1 },
        ],
    }, {
        name: "body", pivot: [0, 5, 2], rot: [HALF_PI, 0, 0], boxes: [
            { u: 18, v: 4, x: -6, y: -10, z: -7, w: 12, h: 18, d: 10 },
            { u: 52, v: 0, x: -2, y: 2, z: -8, w: 4, h: 6, d: 1 },
        ],
    }, [[-4, 12, 7], [4, 12, 7], [-4, 12, -6], [4, 12, -6]], leg4),
    pig: quadruped({
        name: "head", pivot: [0, 12, -6], boxes: [
            { u: 0, v: 0, x: -4, y: -4, z: -8, w: 8, h: 8, d: 8 },
            { u: 16, v: 16, x: -2, y: 0, z: -9, w: 4, h: 3, d: 1 },
        ],
    }, { name: "body", pivot: [0, 11, 2], rot: [HALF_PI, 0, 0], boxes: [{ u: 28, v: 8, x: -5, y: -10, z: -7, w: 10, h: 16, d: 8 }] }, [[-3, 18, 7], [3, 18, 7], [-3, 18, -5], [3, 18, -5]], { ...leg4, h: 6 }),
    sheep: (() => {
        const parts = quadruped({ name: "head", pivot: [0, 6, -8], boxes: [{ u: 0, v: 0, x: -3, y: -4, z: -6, w: 6, h: 6, d: 8 }] }, { name: "body", pivot: [0, 5, 2], rot: [HALF_PI, 0, 0], boxes: [{ u: 28, v: 8, x: -4, y: -10, z: -7, w: 8, h: 16, d: 6 }] }, [[-3, 12, 7], [3, 12, 7], [-3, 12, -5], [3, 12, -5]], leg4);
        const wool = {
            head: { u: 0, v: 0, x: -3, y: -4, z: -4, w: 6, h: 6, d: 6, inflate: 0.6, tex: "wool" },
            body: { u: 28, v: 8, x: -4, y: -10, z: -7, w: 8, h: 16, d: 6, inflate: 1.75, tex: "wool" },
        };
        return parts.map(part => ({
            ...part,
            boxes: [...part.boxes, wool[part.name] ?? { u: 0, v: 16, x: -2, y: 0, z: -2, w: 4, h: 6, d: 4, inflate: 0.5, tex: "wool" }],
        }));
    })(),
    chicken: [
        {
            name: "head", pivot: [0, 15, -4], boxes: [
                { u: 0, v: 0, x: -2, y: -6, z: -2, w: 4, h: 6, d: 3 },
                { u: 14, v: 0, x: -2, y: -4, z: -4, w: 4, h: 2, d: 2 },
                { u: 14, v: 4, x: -1, y: -2, z: -3, w: 2, h: 2, d: 2 },
            ],
        },
        { name: "body", pivot: [0, 16, 0], rot: [HALF_PI, 0, 0], boxes: [{ u: 0, v: 9, x: -3, y: -4, z: -3, w: 6, h: 8, d: 6 }] },
        { name: "right_leg", pivot: [-2, 19, 1], boxes: [{ u: 26, v: 0, x: -1, y: 0, z: -3, w: 3, h: 5, d: 3 }] },
        { name: "left_leg", pivot: [1, 19, 1], boxes: [{ u: 26, v: 0, x: -1, y: 0, z: -3, w: 3, h: 5, d: 3 }] },
        { name: "right_wing", pivot: [-4, 13, 0], boxes: [{ u: 24, v: 13, x: 0, y: 0, z: -3, w: 1, h: 4, d: 6 }] },
        { name: "left_wing", pivot: [4, 13, 0], boxes: [{ u: 24, v: 13, x: -1, y: 0, z: -3, w: 1, h: 4, d: 6 }] },
    ],
    villager: [
        {
            name: "head", pivot: [0, 0, 0], boxes: [
                { u: 0, v: 0, x: -4, y: -10, z: -4, w: 8, h: 10, d: 8 },
                { u: 24, v: 0, x: -1, y: -3, z: -6, w: 2, h: 4, d: 2 },
            ],
        },
        {
            name: "body", pivot: [0, 0, 0], boxes: [
                { u: 16, v: 20, x: -4, y: 0, z: -3, w: 8, h: 12, d: 6 },
                { u: 0, v: 38, x: -4, y: 0, z: -3, w: 8, h: 20, d: 6, inflate: 0.5 },
            ],
        },
        {
            name: "arms", pivot: [0, 3, -1], rot: [-0.75, 0, 0], boxes: [
                { u: 44, v: 22, x: -8, y: -2, z: -2, w: 4, h: 8, d: 4 },
                { u: 44, v: 22, x: 4, y: -2, z: -2, w: 4, h: 8, d: 4 },
                { u: 40, v: 38, x: -4, y: 2, z: -2, w: 8, h: 4, d: 4 },
            ],
        },
        { name: "right_leg", pivot: [-2, 12, 0], boxes: [{ ...leg4, v: 22 }] },
        { name: "left_leg", pivot: [2, 12, 0], boxes: [{ ...leg4, v: 22 }] },
    ],
    player: [],
};
function playerParts(slim) {
    const arm = slim ? 3 : 4;
    const limb = (name, pivot, base, outer, x, w) => ({
        name, pivot, boxes: [
            { u: base[0], v: base[1], x, y: -2, z: -2, w, h: 12, d: 4 },
            { u: outer[0], v: outer[1], x, y: -2, z: -2, w, h: 12, d: 4, inflate: 0.25, outer: true },
        ],
    });
    const legBox = (name, pivot, base, outer) => ({
        name, pivot, boxes: [
            { u: base[0], v: base[1], x: -2, y: 0, z: -2, w: 4, h: 12, d: 4 },
            { u: outer[0], v: outer[1], x: -2, y: 0, z: -2, w: 4, h: 12, d: 4, inflate: 0.25, outer: true },
        ],
    });
    return [
        {
            name: "head", pivot: [0, 0, 0], boxes: [
                { u: 0, v: 0, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8 },
                { u: 32, v: 0, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8, inflate: 0.5, outer: true },
            ],
        },
        {
            name: "body", pivot: [0, 0, 0], boxes: [
                { u: 16, v: 16, x: -4, y: 0, z: -2, w: 8, h: 12, d: 4 },
                { u: 16, v: 32, x: -4, y: 0, z: -2, w: 8, h: 12, d: 4, inflate: 0.25, outer: true },
            ],
        },
        limb("right_arm", [-5, slim ? 2.5 : 2, 0], [40, 16], [40, 32], -3, arm),
        limb("left_arm", [5, slim ? 2.5 : 2, 0], [32, 48], [48, 48], -1, arm),
        legBox("right_leg", [-1.9, 12, 0], [0, 16], [0, 32]),
        legBox("left_leg", [1.9, 12, 0], [16, 48], [0, 48]),
    ];
}
function modelParts(kind, slim = false) {
    return kind === "player" ? playerParts(slim) : MODELS[kind];
}
function poseRotations(kind, pose) {
    const { swing, amount, headYaw, pitch } = pose;
    const phase = swing * 0.6662;
    const a = Math.cos(phase) * 1.4 * amount;
    const b = Math.cos(phase + Math.PI) * 1.4 * amount;
    const head = [pitch * RAD, headYaw * RAD, 0];
    switch (kind) {
        case "chicken":
            return { head, right_leg: [a, 0, 0], left_leg: [b, 0, 0] };
        case "villager":
            return { head, right_leg: [a * 0.5, 0, 0], left_leg: [b * 0.5, 0, 0] };
        case "player":
            return {
                head,
                right_arm: [Math.cos(phase + Math.PI) * amount, 0, 0],
                left_arm: [Math.cos(phase) * amount, 0, 0],
                right_leg: [a, 0, 0],
                left_leg: [b, 0, 0],
            };
        default:
            return { head, right_hind_leg: [a, 0, 0], left_hind_leg: [b, 0, 0], right_front_leg: [b, 0, 0], left_front_leg: [a, 0, 0] };
    }
}
const c = (n) => [(n >> 2) & 1, (n >> 1) & 1, n & 1];
const quad = (a, b, d, e) => [c(a), c(b), c(d), c(e)];
// Cuboid faces and texture rectangles as laid out by vanilla ModelPart.Cube; corner bits are x, y, z (1 = max).
const FACES = [
    { corners: quad(0b101, 0b001, 0b000, 0b100), uv: (u, v, w, _h, d) => [u + d, v, u + d + w, v + d] },
    { corners: quad(0b110, 0b010, 0b011, 0b111), uv: (u, v, w, _h, d) => [u + d + w, v + d, u + d + 2 * w, v] },
    { corners: quad(0b000, 0b001, 0b011, 0b010), uv: (u, v, _w, h, d) => [u, v + d, u + d, v + d + h] },
    { corners: quad(0b100, 0b000, 0b010, 0b110), uv: (u, v, w, h, d) => [u + d, v + d, u + d + w, v + d + h] },
    { corners: quad(0b101, 0b100, 0b110, 0b111), uv: (u, v, w, h, d) => [u + d + w, v + d, u + 2 * d + w, v + d + h] },
    { corners: quad(0b001, 0b101, 0b111, 0b011), uv: (u, v, w, h, d) => [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h] },
];
function shade(nx, ny, nz) {
    const light = 0.62 + 0.38 * (nx * 0.25 + ny * 0.85 + nz * 0.45);
    return Math.min(1, Math.max(0.55, light));
}
function rotateZYX(p, [rx, ry, rz]) {
    let [x, y, z] = p;
    if (rx) {
        const s = Math.sin(rx), k = Math.cos(rx);
        [y, z] = [y * k - z * s, y * s + z * k];
    }
    if (ry) {
        const s = Math.sin(ry), k = Math.cos(ry);
        [x, z] = [x * k + z * s, -x * s + z * k];
    }
    if (rz) {
        const s = Math.sin(rz), k = Math.cos(rz);
        [x, y] = [x * k - y * s, x * s + y * k];
    }
    p[0] = x;
    p[1] = y;
    p[2] = z;
}
function boxCenter(part, rot, box, place, sinYaw, cosYaw) {
    const scale = place.scale ?? 1;
    const p = [box.x + box.w / 2, box.y + box.h / 2, box.z + box.d / 2];
    rotateZYX(p, rot);
    const lx = -(p[0] + part.pivot[0]) / 16 * scale, ly = (1.501 - (p[1] + part.pivot[1]) / 16) * scale, lz = (p[2] + part.pivot[2]) / 16 * scale;
    return [place.x + lx * cosYaw + lz * sinYaw, place.y + ly, place.z - lx * sinYaw + lz * cosYaw];
}
function emitModel(kind, slim, pose, place, rects, sinks, wool = [1, 1, 1]) {
    const rotations = poseRotations(kind, pose);
    const scale = place.scale ?? 1;
    const yaw = (180 - place.yaw) * RAD;
    const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw);
    const world = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const model = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const part of modelParts(kind, slim)) {
        const base = part.rot ?? [0, 0, 0];
        const extra = rotations[part.name] ?? [0, 0, 0];
        const rot = [base[0] + extra[0], base[1] + extra[1], base[2] + extra[2]];
        for (const box of part.boxes) {
            const texture = box.tex ?? "main";
            const rect = rects[texture];
            const sink = (box.outer ? sinks.outer : sinks.solid)(texture);
            if (!rect || !sink)
                continue;
            const g = box.inflate ?? 0;
            const min = [box.x - g, box.y - g, box.z - g], max = [box.x + box.w + g, box.y + box.h + g, box.z + box.d + g];
            const tint = texture === "wool" ? wool : place.tint ?? [1, 1, 1];
            for (const face of FACES) {
                face.corners.forEach(([cx, cy, cz], i) => {
                    const p = model[i];
                    p[0] = cx ? max[0] : min[0];
                    p[1] = cy ? max[1] : min[1];
                    p[2] = cz ? max[2] : min[2];
                    rotateZYX(p, rot);
                    p[0] += part.pivot[0];
                    p[1] += part.pivot[1];
                    p[2] += part.pivot[2];
                    const lx = -p[0] / 16 * scale, ly = (1.501 - p[1] / 16) * scale, lz = p[2] / 16 * scale;
                    const w = world[i];
                    w[0] = place.x + lx * cosYaw + lz * sinYaw;
                    w[1] = place.y + ly;
                    w[2] = place.z - lx * sinYaw + lz * cosYaw;
                });
                const [ax, ay, az] = [world[1][0] - world[0][0], world[1][1] - world[0][1], world[1][2] - world[0][2]];
                const [bx, by, bz] = [world[2][0] - world[1][0], world[2][1] - world[1][1], world[2][2] - world[1][2]];
                const center = boxCenter(part, rot, box, place, sinYaw, cosYaw);
                let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
                const length = Math.hypot(nx, ny, nz) || 1;
                nx /= length;
                ny /= length;
                nz /= length;
                if (nx * (world[0][0] - center[0]) + ny * (world[0][1] - center[1]) + nz * (world[0][2] - center[2]) < 0) {
                    nx = -nx;
                    ny = -ny;
                    nz = -nz;
                }
                const light = shade(nx, ny, nz);
                const [left, top, right, bottom] = face.uv(box.u, box.v, box.w, box.h, box.d);
                const ox = rect.x, oy = rect.y;
                const uvs = [[right, top], [left, top], [left, bottom], [right, bottom]];
                for (const i of [0, 1, 2, 0, 2, 3]) {
                    const [u, v] = uvs[i];
                    sink.push(world[i][0], world[i][1], world[i][2], ox + u, oy + v, light * tint[0], light * tint[1], light * tint[2]);
                }
            }
        }
    }
}
  },
  "./entity-layer.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EntityLayer = exports.DYE_COLORS = exports.MAX_CUSTOM_SKINS = void 0;
exports.parsePack = parsePack;
exports.loadEntityPack = loadEntityPack;
const atlas_js_1 = require("./atlas.js");
const entity_geometry_js_1 = require("./entity-geometry.js");
const entity_skin_js_1 = require("./entity-skin.js");
const entity_state_js_1 = require("./entity-state.js");
exports.MAX_CUSTOM_SKINS = 32;
const MAX_FAILED_SKINS = 64;
const MAX_PENDING_SKINS = 8;
const PLAYER_SCALE = 0.9375;
const FLOATS = 8;
const STRIDE = FLOATS * Float32Array.BYTES_PER_ELEMENT;
exports.DYE_COLORS = [
    0xF9FFFE, 0xF9801D, 0xC74EBD, 0x3AB3DA, 0xFED83D, 0x80C71F, 0xF38BAA, 0x474F52,
    0x9D9D97, 0x169C9C, 0x8932B8, 0x3C44AA, 0x835432, 0x5E7C16, 0xB02E26, 0x1D1D21,
];
async function bounded(response, limit) {
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit)
        throw new Error("Entity pack file too large");
    return bytes;
}
function parsePack(value) {
    const root = value;
    if (!root || typeof root !== "object")
        throw new Error("Invalid entity pack");
    const { width, height, textures } = root;
    const dim = (n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1024;
    if (!dim(width) || !dim(height) || !textures || typeof textures !== "object" || Array.isArray(textures))
        throw new Error("Invalid entity pack");
    const rects = new Map();
    for (const [name, rect] of Object.entries(textures)) {
        if (!/^[a-z0-9_]{1,32}$/.test(name) || !Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isInteger))
            throw new Error("Invalid entity pack texture");
        const [x, y, w, h] = rect;
        if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height)
            throw new Error("Entity pack texture out of bounds");
        rects.set(name, { x, y, w, h });
    }
    return { width, height, rects };
}
async function loadEntityPack(deps, base = "/local-pack/") {
    const init = { method: "GET", credentials: "omit", cache: "no-store", redirect: "error" };
    const [json, png] = await Promise.all([
        deps.fetch(`${base}entities.json`, init).then(r => bounded(r, 16 * 1024)),
        deps.fetch(`${base}entities.png`, init).then(r => bounded(r, 512 * 1024)),
    ]);
    const { width, height, rects } = parsePack(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)));
    const image = await deps.createImageBitmap(new Blob([png], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    if (image.width !== width || image.height !== height) {
        image.close?.();
        throw new Error("Entity pack image does not match its manifest");
    }
    return { image, width, height, rects };
}
const vertexSource = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec3 a_color;
uniform mat4 u_camera;
uniform vec2 u_texSize;
out vec2 v_uv;
out vec3 v_color;
void main() {
  gl_Position = u_camera * vec4(a_position, 1.0);
  v_uv = a_uv / u_texSize;
  v_color = a_color;
}`;
const fragmentSource = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec3 v_color;
uniform sampler2D u_tex;
uniform float u_cut;
out vec4 color;
void main() {
  if (v_uv.x < 0.0) {
    color = vec4(v_color, 1.0);
    return;
  }
  vec4 s = texture(u_tex, v_uv);
  if (s.a < u_cut) discard;
  color = vec4(s.rgb * v_color, s.a < 0.999 ? s.a : 1.0);
}`;
class Builder {
    data = new Float32Array(1024 * FLOATS);
    length = 0;
    push(x, y, z, u, v, r, g, b) {
        if (this.length + FLOATS > this.data.length) {
            const grown = new Float32Array(this.data.length * 2);
            grown.set(this.data);
            this.data = grown;
        }
        this.data.set([x, y, z, u, v, r, g, b], this.length);
        this.length += FLOATS;
    }
}
function hash(id) {
    return (Math.imul(id >>> 0 ^ 0x27d4eb2f, 0x165667b1) >>> 0) / 4294967296;
}
const NO_UV = [-1, -1];
const CUBE_FACES = [
    [[1, 1, 1], [0, 0, -1], [0, -1, 0], [1, 0, 0]],
    [[0, 1, 0], [0, 0, 1], [0, -1, 0], [-1, 0, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0]],
    [[0, 1, 1], [1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[1, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, -1]],
];
function tileOrigin(atlas, tile) {
    if (!Number.isInteger(tile) || tile < 0 || tile >= atlas.columns * atlas.rows)
        return null;
    return [(tile % atlas.columns) * atlas_js_1.TILE_SIZE, Math.floor(tile / atlas.columns) * atlas_js_1.TILE_SIZE];
}
class EntityLayer {
    store;
    clock;
    skinSource;
    requestDraw;
    gl = null;
    pipeline = null;
    pack = null;
    packTexture = null;
    skins = new Map();
    pending = new Set();
    failed = new Set();
    generation = 0;
    stats = { entities: 0, vertices: 0, skipped: 0 };
    constructor(options = {}) {
        this.clock = options.clock ?? (() => performance.now());
        this.store = new entity_state_js_1.EntityStore(this.clock);
        this.skinSource = options.skinSource;
        this.requestDraw = options.requestDraw ?? (() => { });
    }
    // The renderer supplies its coalesced frame request so spawns, removals, skins and packs wake an idle scene.
    setRequestDraw(request) {
        this.requestDraw = request ?? (() => { });
    }
    get animating() {
        return this.store.size > 0;
    }
    get lastDraw() {
        return this.stats;
    }
    get entityCount() {
        return this.store.size;
    }
    get skinCount() {
        return this.skins.size;
    }
    hasGpuResources() {
        return this.pipeline !== null || this.packTexture !== null || [...this.skins.values()].some(skin => skin.texture !== null);
    }
    replaceAll(list) {
        this.store.replaceAll(list);
        this.requestDraw();
    }
    upsert(list) {
        this.store.upsert(list);
        this.requestDraw();
    }
    remove(ids) {
        this.store.remove(ids);
        this.requestDraw();
    }
    setPack(pack) {
        this.deleteTexture(this.packTexture);
        this.packTexture = null;
        this.pack = pack;
        this.requestDraw();
    }
    setSkin(key, pixels) {
        if (!/^[0-9a-f-]{1,64}$/.test(key))
            return;
        const normalized = pixels instanceof Uint8Array ? (pixels.length === entity_skin_js_1.SKIN_SIZE * entity_skin_js_1.SKIN_SIZE * 4 ? pixels : null) : (0, entity_skin_js_1.normalizeSkin)(pixels);
        if (!normalized)
            return;
        this.dropSkin(key);
        this.skins.set(key, { pixels: normalized, texture: null });
        const name = key;
        if (this.skins.size > exports.MAX_CUSTOM_SKINS) {
            const visible = this.store.skinKeys();
            const order = [...this.skins.keys()];
            for (const key of [...order.filter(k => !visible.has(k)), ...order.filter(k => visible.has(k))]) {
                if (this.skins.size <= exports.MAX_CUSTOM_SKINS)
                    break;
                if (key !== name)
                    this.dropSkin(key);
            }
        }
        this.requestDraw();
    }
    dropSkin(key) {
        const skin = this.skins.get(key);
        if (skin)
            this.deleteTexture(skin.texture);
        this.skins.delete(key);
    }
    // Epoch reset or world change: forget entities and cached skins, keep the shared pack and pipeline.
    clear() {
        this.generation++;
        this.store.clear();
        for (const key of [...this.skins.keys()])
            this.dropSkin(key);
        this.pending.clear();
        this.failed.clear();
        this.stats = { entities: 0, vertices: 0, skipped: 0 };
    }
    attach(gl) {
        this.release();
        this.gl = gl;
        const pipeline = this.makePipeline(gl);
        this.pipeline = pipeline;
    }
    // The context is gone: its objects died with it, so only forget them.
    lose() {
        this.pipeline = null;
        this.packTexture = null;
        for (const skin of this.skins.values())
            skin.texture = null;
        this.gl = null;
    }
    release() {
        const { gl, pipeline } = this;
        if (gl && !gl.isContextLost()) {
            if (pipeline) {
                gl.deleteBuffer(pipeline.buffer);
                gl.deleteVertexArray(pipeline.vao);
                gl.deleteProgram(pipeline.program);
            }
            this.deleteTexture(this.packTexture);
            for (const skin of this.skins.values())
                this.deleteTexture(skin.texture);
        }
        this.lose();
    }
    dispose() {
        this.clear();
        this.release();
        this.pack = null;
    }
    deleteTexture(texture) {
        if (texture && this.gl && !this.gl.isContextLost())
            this.gl.deleteTexture(texture);
    }
    makePipeline(gl) {
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            if (!shader)
                return null;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                return shader;
            gl.deleteShader(shader);
            return null;
        };
        const vertex = compile(gl.VERTEX_SHADER, vertexSource);
        const fragment = vertex && compile(gl.FRAGMENT_SHADER, fragmentSource);
        const program = vertex && fragment ? gl.createProgram() : null;
        if (program && vertex && fragment) {
            gl.attachShader(program, vertex);
            gl.attachShader(program, fragment);
            gl.linkProgram(program);
        }
        if (vertex)
            gl.deleteShader(vertex);
        if (fragment)
            gl.deleteShader(fragment);
        if (!program)
            return null;
        const vao = gl.createVertexArray();
        const buffer = gl.createBuffer();
        const camera = gl.getUniformLocation(program, "u_camera");
        const texSize = gl.getUniformLocation(program, "u_texSize");
        const tex = gl.getUniformLocation(program, "u_tex");
        const cut = gl.getUniformLocation(program, "u_cut");
        if (!gl.getProgramParameter(program, gl.LINK_STATUS) || !vao || !buffer || !camera || !texSize || !tex || !cut) {
            gl.deleteProgram(program);
            if (vao)
                gl.deleteVertexArray(vao);
            if (buffer)
                gl.deleteBuffer(buffer);
            return null;
        }
        return { program, vao, buffer, camera, texSize, tex, cut };
    }
    upload(gl, upload) {
        const texture = gl.createTexture();
        if (!texture)
            return null;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        upload();
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (gl.getError() !== gl.NO_ERROR) {
            gl.deleteTexture(texture);
            return null;
        }
        return texture;
    }
    packGpu(gl) {
        const { pack } = this;
        if (!pack)
            return null;
        this.packTexture ??= this.upload(gl, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pack.image));
        return this.packTexture;
    }
    skinGpu(gl, key) {
        const skin = this.skins.get(key);
        if (!skin)
            return null;
        skin.texture ??= this.upload(gl, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, entity_skin_js_1.SKIN_SIZE, entity_skin_js_1.SKIN_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, skin.pixels));
        return skin.texture;
    }
    markFailed(key) {
        this.failed.add(key);
        if (this.failed.size > MAX_FAILED_SKINS)
            this.failed.delete(this.failed.values().next().value);
    }
    requestSkin(key) {
        const source = this.skinSource;
        if (!source || this.pending.has(key) || this.failed.has(key) || this.skins.has(key) || this.pending.size >= MAX_PENDING_SKINS)
            return;
        this.pending.add(key);
        const generation = this.generation;
        void source(key).then(result => {
            if (generation !== this.generation)
                return;
            this.pending.delete(key);
            if (result)
                this.setSkin(key, result);
            else
                this.markFailed(key);
        }, () => {
            if (generation !== this.generation)
                return;
            this.pending.delete(key);
            this.markFailed(key);
        });
    }
    draw(context) {
        const { gl, pipeline } = this;
        if (!gl || !pipeline || gl !== context.gl || gl.isContextLost())
            return;
        const entities = this.store.sample();
        if (entities.length === 0) {
            this.stats = { entities: 0, vertices: 0, skipped: 0 };
            return;
        }
        const groups = new Map();
        const group = (key, size) => {
            let found = groups.get(key);
            if (!found)
                groups.set(key, found = { key, size, solid: new Builder(), outer: new Builder() });
            return found;
        };
        let skipped = 0;
        for (const entity of entities) {
            if (!this.emit(entity, context, group))
                skipped++;
        }
        let vertices = 0;
        const ranges = [];
        for (const outer of [false, true]) {
            for (const g of groups.values()) {
                const builder = outer ? g.outer : g.solid;
                if (builder.length === 0)
                    continue;
                ranges.push({ group: g, outer, first: vertices, count: builder.length / FLOATS });
                vertices += builder.length / FLOATS;
            }
        }
        this.stats = { entities: entities.length, vertices, skipped };
        if (vertices === 0)
            return;
        const all = new Float32Array(vertices * FLOATS);
        let offset = 0;
        for (const { group: g, outer } of ranges) {
            const builder = outer ? g.outer : g.solid;
            all.set(builder.data.subarray(0, builder.length), offset);
            offset += builder.length;
        }
        gl.useProgram(pipeline.program);
        gl.bindVertexArray(pipeline.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, pipeline.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, all, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 3 * 4);
        gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE, 5 * 4);
        gl.uniformMatrix4fv(pipeline.camera, false, context.camera);
        gl.uniform1i(pipeline.tex, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        let blending = false;
        for (const { group: g, outer, first, count } of ranges) {
            const texture = g.key === "atlas" ? context.atlasTexture : g.key === "pack" ? this.packGpu(gl) : this.skinGpu(gl, g.key.slice(5));
            if (!texture)
                continue;
            if (outer !== blending) {
                blending = outer;
                if (outer) {
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    gl.depthMask(false);
                }
            }
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform2f(pipeline.texSize, g.size[0], g.size[1]);
            gl.uniform1f(pipeline.cut, outer ? 0.02 : 0.5);
            gl.drawArrays(gl.TRIANGLES, first, count);
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.disableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    emit(entity, context, group) {
        const { eye } = context;
        if (entity.kind === "item")
            return this.emitItem(entity, context, group);
        const { pack } = this;
        if (!pack)
            return false;
        const kind = entity.kind;
        const packSize = [pack.width, pack.height];
        const rects = { main: undefined, wool: undefined };
        let target = group("pack", packSize);
        let slim = false;
        if (kind === "player") {
            const name = (0, entity_skin_js_1.defaultSkinName)(entity.id, entity.slim);
            slim = entity.slim ?? name.startsWith("slim_");
            let custom = null;
            const cached = entity.skin ? this.skins.get(entity.skin) : undefined;
            if (entity.skin && cached) {
                custom = entity.skin;
                this.skins.delete(entity.skin);
                this.skins.set(entity.skin, cached);
            }
            else if (entity.skin) {
                this.requestSkin(entity.skin);
            }
            if (custom) {
                target = group(`skin:${custom}`, [entity_skin_js_1.SKIN_SIZE, entity_skin_js_1.SKIN_SIZE]);
                rects.main = { x: 0, y: 0, w: entity_skin_js_1.SKIN_SIZE, h: entity_skin_js_1.SKIN_SIZE };
            }
            else {
                rects.main = pack.rects.get(name);
            }
        }
        else {
            rects.main = pack.rects.get(kind);
            if (kind === "sheep")
                rects.wool = pack.rects.get("sheep_wool");
        }
        if (!rects.main)
            return false;
        const dye = exports.DYE_COLORS[entity.color ?? 0] ?? exports.DYE_COLORS[0];
        const wool = [(dye >> 16 & 255) / 255, (dye >> 8 & 255) / 255, (dye & 255) / 255];
        const headYaw = Math.max(-75, Math.min(75, (((entity.headYaw - entity.yaw) % 360) + 540) % 360 - 180));
        const sinks = {
            solid: (name) => name === "wool" ? group("pack", packSize).solid : target.solid,
            outer: () => target.outer,
        };
        (0, entity_geometry_js_1.emitModel)(kind, slim, { swing: entity.swing, amount: entity.amount, headYaw, pitch: entity.pitch }, { x: entity.x - eye[0], y: entity.y - eye[1], z: entity.z - eye[2], yaw: entity.yaw, scale: kind === "player" ? PLAYER_SCALE : 1 }, rects, sinks, wool);
        return true;
    }
    emitItem(entity, context, group) {
        const { eye } = context;
        const atlas = context.atlasTexture ? context.atlas : null;
        if (!entity.item)
            return false;
        const faces = atlas?.itemBlocks?.get(entity.item);
        const sprite = faces || !atlas ? undefined : atlas.itemIcons?.get(entity.item);
        // A neutral grey cube keeps spawn, motion and removal visible for stacks the atlas has no icon for.
        const unknown = !faces && sprite === undefined;
        const pack = this.pack;
        const target = (atlas ? group("atlas", [atlas.columns * atlas_js_1.TILE_SIZE, atlas.rows * atlas_js_1.TILE_SIZE]) : pack ? group("pack", [pack.width, pack.height]) : null)?.solid;
        if (!target)
            return false;
        const bobOffset = hash(entity.id) * Math.PI * 2;
        const bob = Math.sin(entity.age / 10 + bobOffset) * 0.1 + 0.1;
        const spin = entity.age / 20 + bobOffset;
        const sin = Math.sin(spin), cos = Math.cos(spin);
        const copies = Math.min(5, entity.count <= 1 ? 1 : entity.count <= 16 ? 2 : entity.count <= 32 ? 3 : entity.count <= 48 ? 4 : 5);
        for (let copy = 0; copy < copies; copy++) {
            const dx = copy === 0 ? 0 : (hash(entity.id * 7 + copy) - 0.5) * 0.2;
            const dz = copy === 0 ? 0 : (hash(entity.id * 13 + copy) - 0.5) * 0.2;
            const dy = copy * 0.012;
            const cx = entity.x - eye[0] + dx, cz = entity.z - eye[2] + dz;
            const place = (lx, ly, lz) => [cx + lx * cos + lz * sin, entity.y - eye[1] + bob + dy + ly, cz - lx * sin + lz * cos];
            if (faces || unknown) {
                const half = unknown ? 0.1 : 0.125;
                CUBE_FACES.forEach(([origin, du, dv, normal], f) => {
                    const origin0 = unknown ? NO_UV : tileOrigin(atlas, faces[f]);
                    if (!origin0)
                        return;
                    const light = (0, entity_geometry_js_1.shade)(normal[0] * cos + normal[2] * sin, normal[1], -normal[0] * sin + normal[2] * cos) * (unknown ? 0.7 : 1);
                    const corner = (a, b) => place((origin[0] + du[0] * a + dv[0] * b - 0.5) * 2 * half, (origin[1] + du[1] * a + dv[1] * b) * 2 * half, (origin[2] + du[2] * a + dv[2] * b - 0.5) * 2 * half);
                    const quad = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
                    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
                    for (const i of [0, 1, 2, 0, 2, 3]) {
                        target.push(quad[i][0], quad[i][1], quad[i][2], unknown ? -1 : origin0[0] + uv[i][0] * atlas_js_1.TILE_SIZE, origin0[1] + uv[i][1] * atlas_js_1.TILE_SIZE, light, light, light);
                    }
                });
            }
            else {
                const origin = tileOrigin(atlas, sprite);
                if (!origin)
                    return false;
                const half = 0.25;
                const quad = [place(-half, 0.5, 0), place(half, 0.5, 0), place(half, 0, 0), place(-half, 0, 0)];
                const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
                for (const i of [0, 1, 2, 0, 2, 3]) {
                    target.push(quad[i][0], quad[i][1], quad[i][2], origin[0] + uv[i][0] * atlas_js_1.TILE_SIZE, origin[1] + uv[i][1] * atlas_js_1.TILE_SIZE, 1, 1, 1);
                }
            }
        }
        return true;
    }
}
exports.EntityLayer = EntityLayer;
  },
  "./entity-skin.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SKINS = exports.MAX_SKIN_BYTES = exports.SKIN_SIZE = void 0;
exports.defaultSkinName = defaultSkinName;
exports.normalizeSkin = normalizeSkin;
exports.skinPath = skinPath;
exports.loadLocalSkin = loadLocalSkin;
exports.SKIN_SIZE = 64;
exports.MAX_SKIN_BYTES = 32 * 1024;
exports.DEFAULT_SKINS = ["steve", "alex", "ari", "efe", "kai", "makena", "noor", "sunny", "zuri"];
const KEY = /^[0-9a-f-]{1,64}$/;
function defaultSkinName(id, slim) {
    const hash = Math.imul(id >>> 0 ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    const wide = slim === undefined ? hash % 2 === 0 : !slim;
    return `${wide ? "wide" : "slim"}_${exports.DEFAULT_SKINS[(hash >>> 1) % exports.DEFAULT_SKINS.length]}`;
}
function copyRect(px, x, y, dx, dy, w, h) {
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            const from = ((y + j) * exports.SKIN_SIZE + x + i) * 4;
            const to = ((y + dy + j) * exports.SKIN_SIZE + (x + dx + w - 1 - i)) * 4;
            px.copyWithin(to, from, from + 4);
        }
    }
}
function opaque(px, x0, y0, x1, y1) {
    for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
            px[(y * exports.SKIN_SIZE + x) * 4 + 3] = 255;
}
const LEGACY_LIMBS = [
    [4, 16, 16, 4, 4], [8, 16, 16, 4, 4], [0, 20, 24, 4, 12], [4, 20, 16, 4, 12], [8, 20, 8, 4, 12], [12, 20, 16, 4, 12],
    [44, 16, -8, 4, 4], [48, 16, -8, 4, 4], [40, 20, 0, 4, 12], [44, 20, -8, 4, 12], [48, 20, -16, 4, 12], [52, 20, -8, 4, 12],
];
// Returns a 64x64 RGBA copy with legacy limbs mirrored and base-layer alpha forced opaque, or null for unsupported sizes.
function normalizeSkin(skin) {
    const { width, height, data } = skin;
    if (width !== exports.SKIN_SIZE || (height !== exports.SKIN_SIZE && height !== 32) || data.length !== width * height * 4)
        return null;
    const px = new Uint8Array(exports.SKIN_SIZE * exports.SKIN_SIZE * 4);
    px.set(data);
    if (height === 32)
        for (const [x, y, dx, w, h] of LEGACY_LIMBS)
            copyRect(px, x, y, dx, 32, w, h);
    opaque(px, 0, 0, 32, 16);
    opaque(px, 0, 16, 64, 32);
    opaque(px, 16, 48, 48, 64);
    return px;
}
function skinPath(key) {
    return KEY.test(key) ? `/local-pack/skins/${key}.png` : null;
}
// Same-origin local files only; a skin key never selects a remote host.
async function loadLocalSkin(deps, key) {
    const path = skinPath(key);
    if (!path)
        return null;
    const response = await deps.fetch(path, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", mode: "same-origin" });
    if (!response.ok) {
        await response.body?.cancel();
        return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > exports.MAX_SKIN_BYTES || bytes.length < 24)
        return null;
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!signature.every((b, i) => bytes[i] === b) || view.getUint32(12) !== 0x49484452)
        return null;
    if (view.getUint32(16) !== exports.SKIN_SIZE || (view.getUint32(20) !== exports.SKIN_SIZE && view.getUint32(20) !== 32))
        return null;
    return normalizeSkin(await deps.decode(bytes));
}
  },
  "./debug-format.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.floorDiv = floorDiv;
exports.localCoordinate = localCoordinate;
exports.fixed = fixed;
exports.wrapDegrees = wrapDegrees;
exports.facing = facing;
exports.formatDebug = formatDebug;
const protocol_js_1 = require("./protocol.js");
const unavailable = "n/a";
function floorDiv(value, size) {
    return Math.floor(value / size);
}
function localCoordinate(value) {
    return ((value % 16) + 16) % 16;
}
function fixed(value, digits) {
    const scale = 10 ** digits;
    return (Math.round(value * scale) / scale + 0).toFixed(digits);
}
function wrapDegrees(value) {
    const wrapped = ((value % 360) + 360) % 360;
    return wrapped >= 180 ? wrapped - 360 : wrapped;
}
function facing(yaw) {
    const radians = yaw * Math.PI / 180;
    const x = -Math.sin(radians);
    const z = Math.cos(radians);
    if (Math.abs(x) > Math.abs(z))
        return x > 0 ? "east (Towards positive X)" : "west (Towards negative X)";
    return z >= 0 ? "south (Towards positive Z)" : "north (Towards negative Z)";
}
function worldTime(time) {
    const day = Math.floor(time / 24000);
    const tick = ((time % 24000) + 24000) % 24000;
    return `World time: ${tick} (day ${day})`;
}
function formatDebug(view) {
    const protocol = view.protocol;
    const left = [protocol ? `Minecraft ${protocol_js_1.minecraftVersions[protocol]} (protocol ${protocol})` : "Minecraft: " + unavailable];
    left.push(view.fps
        ? `${view.fps.fps} fps (avg ${fixed(view.fps.average, 1)} ms, worst ${fixed(view.fps.worst, 1)} ms)`
        : "fps: measuring");
    const info = view.info;
    if (info) {
        const [x, y, z] = info.feet;
        const block = [Math.floor(x), Math.floor(y), Math.floor(z)];
        left.push("");
        left.push(`XYZ: ${fixed(x, 3)} / ${fixed(y, 3)} / ${fixed(z, 3)}`);
        left.push(`Block: ${block.join(" ")}`);
        left.push(`Chunk: ${block.map(localCoordinate).join(" ")} in ${block.map(n => floorDiv(n, 16)).join(" ")}`);
    }
    else {
        left.push("", "XYZ: " + unavailable, "Block: " + unavailable, "Chunk: " + unavailable);
    }
    left.push(info
        ? `Facing: ${facing(info.rotation[0])} (${fixed(wrapDegrees(info.rotation[0]), 1)} / ${fixed(info.rotation[1], 1)})`
        : "Facing: " + unavailable);
    left.push("Biome: " + unavailable);
    left.push(`Dimension: ${info ? info.dimension : unavailable}`);
    left.push(info?.time != null ? worldTime(info.time) : "World time: " + unavailable);
    const right = [`Viewer: ${view.feed}, control ${view.control}`];
    right.push(`WebGL: ${view.gpu ?? unavailable}`);
    right.push(view.viewport
        ? `Display: ${view.viewport.width}x${view.viewport.height} (${fixed(view.viewport.ratio, 2)}x)`
        : "Display: " + unavailable);
    right.push(view.sections === null ? "Sections: " + unavailable : `Sections: ${view.sections} meshed`);
    const target = info?.target;
    if (target?.kind === "block") {
        right.push("", `Targeted Block: ${target.position.join(", ")}`, target.id ?? "unknown block");
        if (target.props)
            for (const [key, value] of Object.entries(target.props))
                right.push(`${key}: ${value}`);
    }
    else if (target?.kind === "entity") {
        right.push("", "Targeted Entity", target.id ?? "unknown entity");
    }
    else if (info) {
        right.push("", "Targeted Block: none");
    }
    return { left, right };
}
  },
  "./block-models.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelQuads = modelQuads;
const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const clockwise = [4, 5, 2, 3, 1, 0];
function projectedUv(face, [x, y, z]) {
    switch (face) {
        case 0: return [16 - z, 16 - y];
        case 1: return [z, 16 - y];
        case 2: return [x, z];
        case 3: return [x, 16 - z];
        case 4: return [x, 16 - y];
        default: return [16 - x, 16 - y];
    }
}
function plane(face, [x, y, z], [X, Y, Z], rect, tile = face) {
    const faceCorners = [
        [[X, Y, Z], [X, y, Z], [X, y, z], [X, Y, z]],
        [[x, Y, z], [x, y, z], [x, y, Z], [x, Y, Z]],
        [[x, Y, z], [x, Y, Z], [X, Y, Z], [X, Y, z]],
        [[x, y, Z], [x, y, z], [X, y, z], [X, y, Z]],
        [[x, Y, Z], [x, y, Z], [X, y, Z], [X, Y, Z]],
        [[X, Y, z], [X, y, z], [x, y, z], [x, Y, z]],
    ];
    const corners = faceCorners[face];
    const uv = rect ? [rect[0], rect[1], rect[0], rect[3], rect[2], rect[3], rect[2], rect[1]]
        : corners.flatMap(point => projectedUv(face, point));
    const axis = face >> 1;
    const boundary = corners[0][axis] === (face % 2 ? 0 : 16) ? face : undefined;
    return { corners: corners.flat().map(value => value / 16), uv: uv.map(value => value / 16), face: tile, boundary };
}
function rotate(quad, turns) {
    for (let turn = 0; turn < turns; turn++) {
        const corners = [...quad.corners];
        for (let i = 0; i < corners.length; i += 3) {
            [corners[i], corners[i + 2]] = [1 - corners[i + 2], corners[i]];
        }
        const boundary = quad.boundary === undefined ? undefined : clockwise[quad.boundary];
        quad = { ...quad, corners, face: clockwise[quad.face], boundary };
    }
    return quad;
}
function crop() {
    const result = [];
    const forward = [0, 0, 15, 16];
    const reverse = [15, 0, 0, 16];
    for (const at of [3, 13, 8]) {
        result.push(plane(1, [at, -1, 0.5], [at, 15, 15.5], at === 3 ? forward : reverse));
        result.push(plane(0, [at, -1, 0.5], [at, 15, 15.5], at === 3 ? reverse : forward));
    }
    for (const at of [3, 13, 8]) {
        result.push(plane(5, [0.5, -1, at], [15.5, 15, at], at === 3 ? forward : reverse));
        result.push(plane(4, [0.5, -1, at], [15.5, 15, at], at === 3 ? reverse : forward));
    }
    return result;
}
function fence(connections) {
    const result = directions.map((_, face) => plane(face, [6, 0, 6], [10, 16, 10], face === 2 || face === 3 ? [4, 0, 8, 4] : [0, 0, 4, 16]));
    for (let turn = 0; turn < 4; turn++) {
        if ((connections & (1 << turn)) === 0)
            continue;
        for (const [y, v, u] of [[12, 0, 4], [6, 3, 6]]) {
            const from = [7, y, 0], to = [9, y + 3, 6];
            const northSlat = [
                plane(0, from, to, [14, v, 8, v + 3]), plane(1, from, to, [8, v, 14, v + 3]),
                plane(2, from, to, [u, 4, u + 2, 10]), plane(3, from, to, [u, 10, u + 2, 4]),
                plane(5, from, to, [14, v, 16, v + 3]),
            ];
            result.push(...northSlat.map(quad => rotate(quad, turn)));
        }
    }
    return result;
}
function composter(level) {
    const fill = level === 0 ? 2 : Math.min(2 * level + 1, 15);
    return [
        plane(0, [0, 0, 0], [16, 16, 16]), plane(1, [0, 0, 0], [16, 16, 16], undefined, 0),
        plane(4, [0, 0, 0], [16, 16, 16]), plane(5, [0, 0, 0], [16, 16, 16]),
        plane(3, [0, 0, 0], [16, 16, 16]),
        plane(2, [0, 0, 0], [2, 16, 16]), plane(2, [14, 0, 0], [16, 16, 16]),
        plane(2, [2, 0, 0], [14, 16, 2]), plane(2, [2, 0, 14], [14, 16, 16]),
        plane(0, [2, fill, 2], [2, 16, 14]), plane(1, [14, fill, 2], [14, 16, 14], undefined, 0),
        plane(4, [2, fill, 2], [14, 16, 2]), plane(5, [2, fill, 14], [14, 16, 14]),
        plane(2, [2, fill, 2], [14, fill, 14], undefined, level === 0 ? 3 : 1),
    ];
}
function lantern(hanging) {
    const result = directions.map((_, face) => plane(face, [5, hanging, 5], [11, 7 + hanging, 11], face === 2 || face === 3 ? [0, 9, 6, 15] : [0, 2, 6, 9]));
    const cap = [0, 1, 2, 4, 5].map(face => plane(face, [6, 7 + hanging, 6], [10, 9 + hanging, 10], face === 2 ? [1, 10, 5, 14] : [1, 0, 5, 2]));
    const a0 = hanging ? 11 : 9, a1 = hanging ? 15 : 11;
    const b0 = hanging ? 10 : 9, b1 = hanging ? 16 : 11;
    const aV = hanging ? 5 : 3, bV = hanging ? 6 : 10;
    const handle = [
        plane(4, [6.5, a0, 8], [9.5, a1, 8], [11, 1, 14, aV]),
        plane(5, [6.5, a0, 8], [9.5, a1, 8], [14, 1, 11, aV]),
        plane(0, [8, b0, 6.5], [8, b1, 9.5], [11, bV, 14, 12]),
        plane(1, [8, b0, 6.5], [8, b1, 9.5], [14, bV, 11, 12]),
    ].map(quad => {
        const corners = [...quad.corners];
        for (let i = 0; i < corners.length; i += 3) {
            const x = Math.sign(corners[i] - 0.5), z = Math.sign(corners[i + 2] - 0.5);
            corners[i] = (8 + x + z) / 16;
            corners[i + 2] = (8 - x + z) / 16;
        }
        return { ...quad, corners };
    });
    return [...result, ...cap, ...handle];
}
function torch() {
    return directions.map((_, face) => plane(face, [7, 0, 7], [9, 10, 9], face === 2 ? [7, 6, 9, 8] : face === 3 ? [7, 13, 9, 15] : [7, 6, 9, 16]));
}
const railTurns = [0, 1, 1, 3, 0, 2, 0, 1, 2, 3];
function rail(shape) {
    const base = plane(2, [0, 0.5, 0], [16, 0.5, 16]);
    const corners = [...base.corners];
    if (shape >= 2 && shape <= 5) {
        for (let i = 0; i < corners.length; i += 3)
            corners[i + 1] += 1 - corners[i + 2];
    }
    return [rotate({ ...base, corners, doubleSided: true }, railTurns[shape])];
}
function stairs(variant) {
    const facing = variant % 4, slabY = (variant >> 2) % 2, shape = variant >> 3;
    const occupied = (x, y, z) => {
        if (x < 0 || x > 1 || y < 0 || y > 1 || z < 0 || z > 1)
            return false;
        if (y === slabY)
            return true;
        const forward = [z === 0, z === 1, x === 0, x === 1][facing];
        const left = [x === 0, x === 1, z === 1, z === 0][facing];
        switch (shape) {
            case 1: return forward || left;
            case 2: return forward || !left;
            case 3: return forward && left;
            case 4: return forward && !left;
            default: return forward;
        }
    };
    const result = [];
    for (let x = 0; x < 2; x++)
        for (let y = 0; y < 2; y++)
            for (let z = 0; z < 2; z++) {
                if (!occupied(x, y, z))
                    continue;
                directions.forEach(([dx, dy, dz], face) => {
                    if (!occupied(x + dx, y + dy, z + dz)) {
                        result.push(plane(face, [8 * x, 8 * y, 8 * z], [8 * (x + 1), 8 * (y + 1), 8 * (z + 1)]));
                    }
                });
            }
    return result;
}
const models = new Map([
    ["crop", [crop()]],
    ["fence", Array.from({ length: 16 }, (_, i) => fence(i))],
    ["composter", Array.from({ length: 9 }, (_, i) => composter(i))],
    ["lantern", [lantern(0), lantern(1)]],
    ["torch", [torch()]],
    ["rail", railTurns.map((_, i) => rail(i))],
    ["stairs", Array.from({ length: 40 }, (_, i) => stairs(i))],
]);
const empty = [];
function modelQuads(model, variant) {
    return Number.isInteger(variant) ? models.get(model)?.[variant] ?? empty : empty;
}
  },
  "./entity-state.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EntityStore = exports.SNAP_DISTANCE = exports.INTERPOLATION_MS = exports.MAX_ENTITIES = void 0;
exports.sanitizeEntity = sanitizeEntity;
const entity_geometry_js_1 = require("./entity-geometry.js");
exports.MAX_ENTITIES = 256;
exports.INTERPOLATION_MS = 100;
exports.SNAP_DISTANCE = 8;
const MAX_COORDINATE = 30_000_000;
const TICK_MS = 50;
function finite(value, limit) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}
function sanitizeEntity(value) {
    if (!value || typeof value !== "object")
        return null;
    const e = value;
    const { id, kind } = e;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0)
        return null;
    if (typeof kind !== "string" || !entity_geometry_js_1.SUPPORTED_KINDS.includes(kind))
        return null;
    if (!finite(e.x, MAX_COORDINATE) || !finite(e.y, MAX_COORDINATE) || !finite(e.z, MAX_COORDINATE))
        return null;
    if (!finite(e.yaw, 1e6) || !finite(e.pitch, 1e6))
        return null;
    const clean = { id, kind: kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: Math.max(-90, Math.min(90, e.pitch)) };
    if (e.headYaw !== undefined) {
        if (!finite(e.headYaw, 1e6))
            return null;
        clean.headYaw = e.headYaw;
    }
    if (kind === "item") {
        if (typeof e.item !== "string" || !/^[a-z0-9_]{1,64}$/.test(e.item))
            return null;
        const count = e.count ?? 1;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 999)
            return null;
        clean.item = e.item;
        clean.count = count;
    }
    if (e.color !== undefined) {
        if (typeof e.color !== "number" || !Number.isInteger(e.color) || e.color < 0 || e.color > 15)
            return null;
        clean.color = e.color;
    }
    if (e.skin !== undefined) {
        if (typeof e.skin !== "string" || !/^[0-9a-f-]{1,64}$/.test(e.skin))
            return null;
        clean.skin = e.skin;
    }
    if (e.slim !== undefined) {
        if (typeof e.slim !== "boolean")
            return null;
        clean.slim = e.slim;
    }
    return clean;
}
function wrap(degrees) {
    const r = ((degrees + 180) % 360 + 360) % 360 - 180;
    return r;
}
function lerpAngle(a, b, t) {
    return a + wrap(b - a) * t;
}
function poseOf(state) {
    return { x: state.x, y: state.y, z: state.z, yaw: state.yaw, pitch: state.pitch, headYaw: state.headYaw ?? state.yaw };
}
class EntityStore {
    clock;
    entities = new Map();
    constructor(clock = () => performance.now()) {
        this.clock = clock;
    }
    get size() {
        return this.entities.size;
    }
    clear() {
        this.entities.clear();
    }
    ids() {
        return [...this.entities.keys()];
    }
    remove(ids) {
        for (const id of ids)
            this.entities.delete(id);
    }
    // Lifetime belongs to the feed: a full snapshot replaces the set, and an epoch reset or detach clears it.
    replaceAll(list) {
        const states = [];
        const seen = new Set();
        for (const raw of list) {
            const state = sanitizeEntity(raw);
            if (state && !seen.has(state.id)) {
                seen.add(state.id);
                states.push(state);
            }
        }
        for (const id of [...this.entities.keys()])
            if (!seen.has(id))
                this.entities.delete(id);
        this.apply(states);
    }
    upsert(list) {
        const states = [];
        for (const raw of list) {
            const state = sanitizeEntity(raw);
            if (state)
                states.push(state);
        }
        this.apply(states);
    }
    skinKeys() {
        const keys = new Set();
        for (const { state } of this.entities.values())
            if (state.skin)
                keys.add(state.skin);
        return keys;
    }
    apply(states) {
        const now = this.clock();
        for (const state of states) {
            const existing = this.entities.get(state.id);
            if (!existing && this.entities.size >= exports.MAX_ENTITIES)
                continue;
            const target = poseOf(state);
            if (!existing) {
                this.entities.set(state.id, { state, from: target, to: target, start: now, born: now, last: null, lastSample: now, swing: 0, amount: 0 });
                continue;
            }
            const shown = this.pose(existing, now);
            const jump = Math.hypot(target.x - shown.x, target.y - shown.y, target.z - shown.z);
            existing.from = state.kind !== existing.state.kind || jump > exports.SNAP_DISTANCE ? target : shown;
            if (existing.from === target)
                existing.last = null;
            existing.to = target;
            existing.start = now;
            existing.state = state;
        }
    }
    pose(entity, now) {
        const t = Math.max(0, Math.min(1, (now - entity.start) / exports.INTERPOLATION_MS));
        const { from, to } = entity;
        return {
            x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t,
            yaw: lerpAngle(from.yaw, to.yaw, t), pitch: from.pitch + (to.pitch - from.pitch) * t, headYaw: lerpAngle(from.headYaw, to.headYaw, t),
        };
    }
    sample() {
        const now = this.clock();
        const out = [];
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
exports.EntityStore = EntityStore;
  },
};
const loaded = new Map();
function require(name) {
  if (!loaded.has(name)) {
    const exports = {};
    loaded.set(name, exports);
    modules[name](require, exports);
  }
  return loaded.get(name);
}
require("./viewer.js");
})();
