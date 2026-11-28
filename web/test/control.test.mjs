import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { compile } from "../scripts/compile.mjs";

const modules = new Map();
function requireModule(name) {
  if (!modules.has(name)) {
    const exports = {};
    modules.set(name, exports);
    runInThisContext(`(require, exports) => {\n${compile(name.slice(2, -3), true)}\n}`)(requireModule, exports);
  }
  return modules.get(name);
}

const { InputState, HotbarWheel, wheelHotbar, KEY } = requireModule("./input.js");
const { ControlMachine } = requireModule("./control.js");
const { buildClick, canHandBack, layout } = requireModule("./inventory.js");
const { ViewerControl } = requireModule("./viewer-control.js");
const { decodeBatch } = requireModule("./wire.js");

function machine() {
  const calls = [];
  const m = new ControlMachine({ requestLock: () => calls.push("lock"), exitLock: () => calls.push("unlock"), changed: () => {} });
  return { m, calls };
}

test("pairing never captures; grant needs a click and a lock event", () => {
  const { m, calls } = machine();
  assert.equal(m.mode, "view");
  m.capture();
  assert.deepEqual(calls, []);
  m.setGrant(1);
  assert.equal(m.mode, "idle");
  m.lockChanged(true);
  assert.equal(m.mode, "idle");
  m.capture();
  assert.deepEqual(calls.filter(c => c === "lock").length, 1);
  m.lockChanged(true);
  assert.equal(m.mode, "play");
  assert.equal(m.label, "Resume play");
  assert.equal(machine().m.label, "Intervene");
});

test("denied capture stays unlocked and retry works; stale lock events ignored", () => {
  const { m } = machine();
  m.setGrant(1);
  m.capture();
  m.lockDenied();
  m.lockChanged(true);
  assert.equal(m.mode, "idle");
  m.capture();
  m.lockChanged(true);
  assert.equal(m.mode, "play");
});

test("pointer lock lost without Escape pauses; E opens inventory and closes straight back to play", () => {
  const { m, calls } = machine();
  m.setGrant(1);
  m.capture();
  m.lockChanged(true);
  m.lockChanged(false);
  assert.equal(m.mode, "pause");
  m.capture();
  m.lockChanged(true);
  assert.equal(m.key("KeyE"), true);
  assert.equal(m.mode, "inventory");
  m.lockChanged(false);
  assert.equal(m.mode, "inventory");
  const locks = calls.filter(c => c === "lock").length;
  m.key("KeyE");
  assert.equal(m.mode, "play");
  assert.equal(calls.filter(c => c === "lock").length, locks + 1);
  m.lockChanged(true);
  m.key("KeyE");
  m.key("Escape");
  assert.equal(m.mode, "play");
  m.lockChanged(true);
  m.key("Escape");
  assert.equal(m.mode, "pause");
});

test("a late lock success after the grant was replaced is released, not kept", () => {
  const { m, calls } = machine();
  m.setGrant(1);
  m.capture();
  m.setGrant(2);
  const unlocks = calls.filter(c => c === "unlock").length;
  m.lockChanged(true);
  assert.equal(m.mode, "idle");
  assert.equal(calls.filter(c => c === "unlock").length, unlocks + 1);
});

test("inventory opened from pause or idle closes to idle, never play", () => {
  const { m } = machine();
  m.setGrant(1);
  m.capture();
  m.lockChanged(true);
  m.lockChanged(false);
  m.key("KeyE");
  m.key("Escape");
  assert.equal(m.mode, "idle");
});

test("a stale unlock event after a quick E-close does not pause; denied recapture leaves keyboard play that recaptures on click", () => {
  const { m, calls } = machine();
  m.setGrant(1);
  m.capture();
  m.lockChanged(true);
  m.key("KeyE");
  m.key("KeyE");
  assert.equal(m.mode, "play");
  m.lockChanged(false);
  assert.equal(m.mode, "play");
  m.lockDenied();
  assert.equal(m.captureOnClick, true);
  m.capture();
  assert.equal(calls.filter(c => c === "lock").length, 3);
  m.lockChanged(true);
  assert.equal(m.captureOnClick, false);
  m.lockChanged(false);
  assert.equal(m.mode, "pause");
});

test("keyboard-only play returns to keyboard play without requesting a lock", () => {
  const { m, calls } = machine();
  m.setGrant(1);
  m.playUnlocked();
  m.key("KeyE");
  m.key("KeyE");
  assert.equal(m.mode, "play");
  assert.equal(calls.filter(c => c === "lock").length, 0);
  assert.equal(m.captureOnClick, false);
  m.setGrant(null);
  assert.equal(m.mode, "view");
});

test("revoking releases the pointer and drops to view", () => {
  const { m, calls } = machine();
  m.setGrant(1);
  m.capture();
  m.lockChanged(true);
  m.setGrant(null);
  assert.equal(m.mode, "view");
  assert.equal(calls.at(-1), "unlock");
});

test("short taps survive between frames; holds report no extra tap", () => {
  const s = new InputState();
  s.mouseDown(0, 0);
  s.mouseUp(0, 5);
  assert.deepEqual([s.frame(10).taps, s.frame(20).keys & KEY.attack], [2, 0]);
  s.mouseDown(0, 30);
  const held = s.frame(40);
  assert.equal(held.keys & KEY.attack, KEY.attack);
  assert.equal(held.taps, 0);
  assert.equal(s.frame(50).taps, 0);
  s.mouseUp(0, 60);
  assert.equal(s.frame(70).keys & KEY.attack, 0);
});

test("aliases share an action until both release", () => {
  const s = new InputState();
  s.keyDown("KeyU", 0);
  s.mouseDown(0, 1);
  assert.equal(s.frame(2).taps, 0);
  s.keyUp("KeyU", 3);
  assert.equal(s.frame(4).keys & KEY.attack, KEY.attack);
  s.mouseUp(0, 5);
  assert.equal(s.frame(6).keys & KEY.attack, 0);
});

test("keyboard turning follows elapsed time and C is precise; Shift+H snaps once", () => {
  const s = new InputState();
  s.frame(0);
  s.keyDown("KeyL", 0);
  const turn = s.frame(100);
  assert.ok(Math.abs(turn.dyaw - 19.3) < 1e-9);
  s.keyUp("KeyL", 100);
  s.keyDown("KeyC", 100);
  s.keyDown("KeyJ", 100);
  assert.ok(Math.abs(s.frame(200).dpitch - 4) < 1e-9);
  s.clear(200);
  s.keyDown("ShiftLeft", 300);
  s.keyDown("KeyH", 300);
  assert.equal(s.frame(300).snap, -1);
  assert.equal(s.frame(310).snap, 0);
  assert.equal(s.frame(400).dyaw, 0);
});

test("mouse deltas are capped; blur clears; non-play ignores input; fresh press needed", () => {
  const s = new InputState();
  s.mouseMove(1e9, -1e9, 0);
  const f = s.frame(1);
  assert.equal(f.dyaw, 60);
  assert.equal(f.dpitch, -45);
  s.keyDown("KeyW", 2);
  s.clear(3);
  assert.equal(s.frame(4).keys, 0);
  s.setUi("menu", 5);
  s.keyDown("KeyW", 6);
  s.mouseDown(0, 6);
  assert.deepEqual([s.frame(7).keys, s.frame(7).ui], [0, "menu"]);
  s.setUi("play", 8);
  assert.equal(s.frame(9).keys, 0);
  s.keyDown("Digit4", 10);
  assert.equal(s.frame(11).slot, 3);
  assert.equal(s.frame(12).slot, null);
});

const inv = (extra = {}) => ({ menu: 5, revision: 3, layout: "player", slots: Array(46).fill(null), cursor: null, pending: false, ...extra });

test("click builder maps operations, rejects stale shapes, and gates handback", () => {
  const snap = inv();
  assert.deepEqual(buildClick(snap, "pickup", 9, 0), { menu: 5, revision: 3, slot: 9, op: 0, button: 0 });
  assert.deepEqual(buildClick(snap, "split", 9, 1), { menu: 5, revision: 3, slot: 9, op: 0, button: 1 });
  assert.equal(buildClick(snap, "quick", 9, 1).op, 1);
  assert.equal(buildClick(snap, "swap", 9, 4).button, 4);
  assert.equal(buildClick(snap, "swap", 9, 9), null);
  assert.equal(buildClick(snap, "pickup", 46, 0), null);
  assert.equal(buildClick(inv({ pending: true }), "pickup", 1, 0), null);
  assert.equal(buildClick(inv({ layout: "unsupported", slots: [] }), "pickup", 0, 0), null);
  assert.equal(canHandBack(true, snap, false), true);
  assert.equal(canHandBack(true, snap, true), false);
  assert.equal(canHandBack(false, snap, false), false);
  assert.equal(canHandBack(true, inv({ cursor: { item: "stone", count: 1 } }), false), false);
  assert.equal(canHandBack(true, inv({ pending: true }), false), false);
});

test("layouts cover player and container menus", () => {
  assert.equal(layout(inv()).flatMap(g => g.slots).length, 46);
  const chest = inv({ layout: "chest", slots: Array(63).fill(null) });
  assert.deepEqual(layout(chest).map(g => g.slots.length), [27, 27, 9]);
  assert.equal(layout(inv({ layout: "chest", slots: Array(10).fill(null) })), null);
  const table = layout(inv({ layout: "crafting", slots: Array(46).fill(null) }));
  assert.deepEqual(table.map(g => [g.area, g.columns, g.slots[0], g.slots.at(-1)]), [["crafting", 3, 1, 9], ["result", 1, 0, 0], ["inventory", 9, 10, 36], ["hotbar", 9, 37, 45]]);
  assert.equal(table.flatMap(g => g.slots).length, 46);
  assert.equal(layout(inv({ layout: "crafting", slots: Array(10).fill(null) })), null);
  assert.deepEqual(layout(inv()).map(g => g.area), ["crafting", "result", "armor", "offhand", "inventory", "hotbar"]);
  const ready = inv({ layout: "crafting", slots: Array(46).fill(null), pending: false });
  assert.deepEqual(buildClick(ready, "pickup", 0, 0), { menu: 5, revision: 3, slot: 0, op: 0, button: 0 });
  assert.deepEqual(buildClick(ready, "quick", 0, 0), { menu: 5, revision: 3, slot: 0, op: 1, button: 0 });
  assert.deepEqual(buildClick(ready, "pickup", 45, 0), { menu: 5, revision: 3, slot: 45, op: 0, button: 0 });
  assert.equal(buildClick(ready, "pickup", 46, 0), null);
  assert.equal(layout(inv({ layout: "unsupported", slots: [] })), null);
});

function bytes(data) {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const out = new Uint8Array(2 + json.length);
  out.set(json, 2);
  new DataView(out.buffer).setUint16(0, json.length, true);
  return out;
}

const base = { epoch: 1, seq: 1, status: "ready", protocol: 777, yaw: 0 };
const ctl = (extra = {}) => ({ grant: 7, ack: 0, mode: "available", ...extra });

test("decodes control and inventory; null clears; rejects malformed", () => {
  const wireInv = { menu: 5, revision: 3, layout: "player", slots: [null, ["stone", 2]], cursor: ["dirt", 1], pending: false };
  const batch = decodeBatch(bytes({ ...base, control: ctl({ canReturn: true, checkpoint: "parked", canRestart: true, marker: [1.5, 64, -2], inventory: wireInv }) }));
  assert.equal(batch.control.canReturn, true);
  assert.equal(batch.control.canResume, false);
  assert.deepEqual(batch.control.marker, [1.5, 64, -2]);
  assert.deepEqual(batch.control.inventory.slots[1], { item: "stone", count: 2 });
  assert.equal(decodeBatch(bytes({ ...base, control: null })).control, null);
  assert.equal(decodeBatch(bytes(base)).control, undefined);
  assert.throws(() => decodeBatch(bytes({ ...base, control: ctl({ mode: "x" }) })));
  assert.throws(() => decodeBatch(bytes({ ...base, control: ctl({ checkpoint: "later" }) })));
  assert.throws(() => decodeBatch(bytes({ ...base, control: ctl({ inventory: { ...wireInv, slots: [{ item: "stone", count: 1 }] } }) })));
  assert.throws(() => decodeBatch(bytes({ ...base, control: ctl({ inventory: { ...wireInv, slots: Array(161).fill(null) } }) })));
  assert.throws(() => decodeBatch(bytes({ epoch: 1, seq: 1, status: "waiting", control: null })));
});

function viewerControl() {
  const log = { states: [], locks: 0, unlocks: 0, markers: [] };
  let time = 0;
  const vc = new ViewerControl({
    state: view => log.states.push(view), lock: () => log.locks++, unlock: () => log.unlocks++,
    inventory() {}, marker: point => log.markers.push(point),
  }, () => time);
  const feed = control => vc.apply({ ...base, control });
  return { vc, log, feed, tick: ms => { time += ms; } };
}

test("grant starts neutral; Intervene sends once before lock, play starts only after lock confirms", () => {
  const { vc, log, feed } = viewerControl();
  assert.equal(vc.outbound(), null);
  feed(ctl());
  assert.deepEqual(vc.outbound().i, [7, 1, 0]);
  vc.intervene();
  assert.equal(log.locks, 1);
  assert.deepEqual(vc.outbound().i, [7, 2, 6]);
  assert.deepEqual(vc.outbound().i, [7, 2, 6]);
  feed(ctl({ ack: 2 }));
  assert.deepEqual(vc.outbound().i, [7, 3, 0]);
  vc.intervene();
  assert.deepEqual(vc.outbound().i, [7, 4, 0]);
  vc.lockChanged(true);
  vc.keyDown("KeyW", false);
  assert.deepEqual(vc.outbound().i, [7, 5, 1, 0, 0, 0, 0, -1]);
  assert.deepEqual(vc.outbound().i, [7, 6, 1, 0, 0, 0, 0, -1]);
  feed(ctl({ ack: 4, mode: "play" }));
  assert.equal(vc.outbound().i[3], 0);
  feed(ctl({ ack: 5, mode: "play" }));
  assert.equal(vc.outbound().i[3], 1);
});

function enter(vc, feed) {
  feed(ctl());
  vc.intervene();
  assert.deepEqual(vc.outbound().i, [7, 1, 6]);
  feed(ctl({ ack: 1 }));
  vc.lockChanged(true);
}

test("lock loss pauses and sends no intervene or restart; host follow waits for ack", () => {
  const { vc, log, feed } = viewerControl();
  enter(vc, feed);
  feed(ctl({ ack: 0, mode: "available" }));
  assert.equal(vc.mode, "play");
  vc.lockChanged(false);
  assert.equal(vc.mode, "pause");
  assert.deepEqual([vc.outbound().i[2], vc.outbound().i[2]], [0, 0]);
  assert.ok(!log.states.some(s => s.canRestart));
});

test("E opens inventory; click retries same seq until acked; E closes with kind 4", () => {
  const { vc, feed } = viewerControl();
  const open = { menu: 5, revision: 3, layout: "player", slots: Array(46).fill(null), cursor: null, pending: false };
  enter(vc, feed);
  vc.outbound();
  vc.keyDown("KeyE", false);
  assert.equal(vc.outbound().i[2], 2);
  feed(ctl({ ack: 3, mode: "inventory", inventory: open }));
  vc.inventoryClick("split", 9, 1);
  const sent = vc.outbound().i;
  assert.deepEqual(sent.slice(2), [3, 5, 3, 9, 0, 1]);
  assert.deepEqual(vc.outbound().i, sent);
  vc.inventoryClick("pickup", 10, 0);
  feed(ctl({ ack: sent[1], mode: "inventory", inventory: open }));
  assert.equal(vc.outbound().i[2], 2);
  vc.keyDown("KeyE", false);
  assert.equal(vc.outbound().i[2], 4);
  assert.equal(vc.outbound().i[2], 4);
});

test("stale-grant acks are ignored; control null ends control with a notice", () => {
  const { vc, log, feed } = viewerControl();
  feed(ctl({ checkpoint: "parked", canResume: true, canRestart: true, canReturn: true }));
  vc.restartScript();
  assert.deepEqual(vc.outbound().i, [7, 1, 8]);
  feed(ctl({ grant: 8, ack: 1 }));
  assert.deepEqual(vc.outbound().i, [8, 1, 0]);
  feed(null);
  assert.equal(vc.outbound(), null);
  assert.equal(log.states.at(-1).mode, "view");
  assert.equal(log.states.at(-1).notice, "Control ended.");
  assert.equal(log.markers.at(-1), null);
});

test("restart and resume are unavailable unless parked and supported", () => {
  const { vc, feed } = viewerControl();
  feed(ctl({ checkpoint: "pending", canRestart: true, canResume: true }));
  vc.restartScript();
  vc.resumeScript();
  assert.deepEqual(vc.outbound().i, [7, 1, 0]);
});

test("snap turns to the adjacent cardinal heading", () => {
  const { vc, feed } = viewerControl();
  vc.apply({ ...base, yaw: 100, control: ctl() });
  vc.intervene();
  vc.outbound();
  vc.apply({ ...base, yaw: 100, control: ctl({ ack: 1 }) });
  vc.lockChanged(true);
  assert.equal(vc.outbound().i[3], 0);
  vc.apply({ ...base, yaw: 100, control: ctl({ ack: 5, mode: "play" }) });
  vc.keyDown("ShiftLeft", false);
  vc.keyDown("KeyL", false);
  assert.equal(vc.outbound().i[4], 8000);
  assert.equal(vc.outbound().i[4], 0);
});

test("repeated control null keeps the end notice", () => {
  const { vc, log, feed } = viewerControl();
  feed(ctl({ canReturn: true }));
  vc.returnToScript();
  feed(null);
  feed(null);
  assert.equal(log.states.at(-1).notice, "Control returned to the script.");
});

test("E and Esc close an inventory holding a cursor stack without a click, but not while a click is unconfirmed", () => {
  const { vc, log, feed } = viewerControl();
  const wire = { menu: 5, revision: 3, layout: "player", slots: Array(46).fill(null), cursor: ["stone", 1], pending: false };
  enter(vc, feed);
  vc.outbound();
  vc.keyDown("KeyE", false);
  vc.outbound();
  feed(ctl({ ack: 3, mode: "inventory", inventory: { ...wire, pending: true } }));
  vc.keyDown("KeyE", false);
  assert.equal(vc.mode, "inventory");
  assert.match(log.states.at(-1).notice, /still being sent/);
  feed(ctl({ ack: 3, mode: "inventory", inventory: wire }));
  assert.equal(vc.keyDown("Escape", false), true);
  assert.equal(vc.mode, "play");
  assert.equal(vc.outbound().i[2], 4);
});

function openInventory() {
  const ctx = viewerControl();
  const wire = { menu: 5, revision: 3, layout: "player", slots: Array(46).fill(null), cursor: null, pending: false };
  enter(ctx.vc, ctx.feed);
  ctx.vc.outbound();
  ctx.vc.keyDown("KeyE", false);
  ctx.vc.outbound();
  ctx.feed(ctl({ ack: 3, mode: "inventory", inventory: wire }));
  return ctx;
}

test("Esc and E close the inventory straight back to play: one close, no pause, no Resume click", () => {
  for (const code of ["KeyE", "Escape"]) {
    const { vc, log, feed } = openInventory();
    const locks = log.locks;
    assert.equal(vc.keyDown(code, false), true);
    assert.equal(vc.mode, "play");
    assert.equal(log.locks, locks + 1);
    assert.equal(vc.keyDown(code, true), true);
    vc.keyDown("KeyW", false);
    const first = vc.outbound().i;
    assert.equal(first[2], 4);
    assert.equal(vc.outbound().i[1], first[1]);
    feed(ctl({ ack: first[1], mode: "pause" }));
    const hold = vc.outbound().i;
    assert.deepEqual(hold.slice(2), [1, 0, 0, 0, 0, -1]);
    feed(ctl({ ack: hold[1], mode: "play" }));
    assert.equal(vc.mode, "play");
    vc.keyDown("KeyW", false);
    assert.equal(vc.outbound().i[3] & KEY.forward, KEY.forward);
    vc.lockChanged(true);
    vc.lockChanged(false);
    assert.equal(vc.mode, "pause");
  }
});

test("the close shot carries the menu identity captured when Esc or E was pressed", () => {
  const { vc, feed } = openInventory();
  vc.keyDown("Escape", false);
  feed(ctl({ ack: 3, mode: "inventory", inventory: { menu: 9, revision: 4, layout: "player", slots: Array(46).fill(null), cursor: null, pending: false } }));
  assert.deepEqual(vc.outbound().i.slice(2), [4, 5]);
  assert.deepEqual(golden.close.slice(2), [4, 1]);
});

test("a stale unlock from entering the inventory does not pause after a quick close", () => {
  const { vc } = openInventory();
  vc.keyDown("Escape", false);
  vc.lockChanged(false);
  assert.equal(vc.mode, "play");
});

test("a refused recapture keeps keyboard play, no menu or notice, and a click recaptures", () => {
  const { vc, log } = openInventory();
  vc.keyDown("Escape", false);
  vc.lockDenied();
  assert.equal(vc.mode, "play");
  assert.equal(log.states.at(-1).notice, "");
  assert.equal(log.states.at(-1).denied, false);
  const locks = log.locks;
  assert.equal(vc.captureOnClick(), true);
  assert.equal(log.locks, locks + 1);
  vc.lockChanged(true);
  assert.equal(vc.captureOnClick(), false);
});

test("a denied click recapture stops swallowing clicks", () => {
  const { vc } = openInventory();
  vc.keyDown("Escape", false);
  vc.lockDenied();
  vc.captureOnClick();
  vc.lockDenied();
  assert.equal(vc.captureOnClick(), false);
});

test("held keys and buttons from before the inventory do not survive the close", () => {
  const { vc } = openInventory();
  vc.mouseDown(0);
  vc.keyDown("Escape", false);
  vc.keyUp("Escape");
  const first = vc.outbound().i;
  assert.equal(first[2], 4);
  assert.equal(vc.outbound().i[1], first[1]);
});

test("a held Esc is consumed after closing; a fresh press then pauses", () => {
  const { vc, feed } = openInventory();
  vc.keyDown("Escape", false);
  assert.equal(vc.keyDown("Escape", true), true);
  assert.equal(vc.keyDown("Escape", true), true);
  assert.equal(vc.mode, "play");
  vc.lockChanged(true);
  vc.keyUp("Escape");
  assert.equal(vc.keyDown("Escape", false), true);
  assert.equal(vc.mode, "pause");
});

test("closing a keyboard-only inventory restores keyboard play without a lock request", () => {
  const { vc, log, feed } = viewerControl();
  const wire = { menu: 5, revision: 3, layout: "player", slots: Array(46).fill(null), cursor: null, pending: false };
  feed(ctl());
  vc.playWithoutCapture();
  vc.outbound();
  vc.keyDown("KeyE", false);
  vc.outbound();
  feed(ctl({ ack: 3, mode: "inventory", inventory: wire }));
  assert.equal(vc.mode, "inventory");
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "play");
  assert.equal(log.locks, 0);
  assert.equal(vc.captureOnClick(), false);
});

test("observation or revoked control is never turned into play by the close", () => {
  const { vc, feed } = openInventory();
  feed(null);
  assert.equal(vc.mode, "view");
  assert.equal(vc.keyDown("Escape", false), false);
  assert.equal(vc.mode, "view");
});

test("Esc with a click in flight keeps the inventory open with a notice", () => {
  const { vc, log, feed } = openInventory();
  vc.inventoryClick("pickup", 9, 0);
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "inventory");
  assert.match(log.states.at(-1).notice, /still being sent/);
  assert.equal(vc.outbound().i[2], 3);
});

test("lock confirming before any frame is sent survives the intervene ack", () => {
  const { vc, feed } = viewerControl();
  feed(ctl());
  vc.intervene();
  vc.lockChanged(true);
  assert.deepEqual(vc.outbound().i, [7, 1, 6]);
  feed(ctl({ ack: 1, mode: "available" }));
  assert.equal(vc.mode, "play");
  assert.deepEqual(vc.outbound().i, [7, 2, 1, 0, 0, 0, 0, -1]);
  feed(ctl({ ack: 2, mode: "play" }));
  assert.equal(vc.mode, "play");
});

test("denied capture offers explicit keyboard-only play; nothing is enabled without it", () => {
  const { vc, log, feed } = viewerControl();
  feed(ctl());
  vc.intervene();
  vc.lockDenied();
  assert.equal(log.states.at(-1).denied, true);
  assert.equal(vc.mode, "idle");
  vc.keyDown("KeyW", false);
  vc.playWithoutCapture();
  assert.equal(vc.mode, "play");
  assert.equal(log.states.at(-1).notice, "");
  vc.outbound();
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "pause");
});

test("E in pause reopens the inventory with kind 2", () => {
  const { vc, feed } = viewerControl();
  enter(vc, feed);
  vc.outbound();
  vc.lockChanged(false);
  assert.equal(vc.mode, "pause");
  vc.keyDown("KeyE", false);
  assert.equal(vc.mode, "inventory");
  assert.equal(vc.outbound().i[2], 2);
});

test("canPlay false blocks capture and play but leaves inventory reachable; absent means allowed", () => {
  const { vc, log, feed } = viewerControl();
  enter(vc, feed);
  vc.lockChanged(false);
  const locks = log.locks;
  feed(ctl({ ack: 1, mode: "pause", canPlay: false }));
  assert.equal(log.states.at(-1).canPlay, false);
  vc.resumePlay();
  vc.intervene();
  assert.equal(log.locks, locks);
  assert.equal(vc.outbound().i[2], 0);
  vc.keyDown("KeyE", false);
  assert.equal(vc.mode, "inventory");
  feed(ctl({ mode: "available" }));
  assert.equal(log.states.at(-1).canPlay, true);
});

const golden = JSON.parse(readFileSync(new URL("../../spec/fixtures/manual_inventory_wire.json", import.meta.url), "utf8"));

test("shared golden wire: emits the host's open and click arrays and decodes its pending header", () => {
  const { vc, feed } = viewerControl();
  const pending = decodeBatch(bytes({ ...base, control: golden.pending })).control;
  assert.equal(pending.inventory.pending, true);
  assert.equal(pending.canPlay, false);
  assert.deepEqual(pending.inventory.slots[36], { item: "stone", count: 5 });
  const settled = { ...golden.pending, ack: 1, canReturn: true, inventory: { ...golden.pending.inventory, pending: false } };
  feed({ ...settled, ack: 0 });
  assert.deepEqual(vc.outbound().i, golden.open);
  feed(settled);
  vc.inventoryClick("split", 36, 1);
  assert.deepEqual(vc.outbound().i, golden.click);
  feed(golden.pending);
  vc.returnToScript();
  assert.deepEqual(vc.outbound().i[2], 3);
});

test("inventory ready defaults true; ready:false disables clicks but E still closes when empty", () => {
  const wire = { menu: 5, revision: 3, layout: "player", slots: Array(46).fill(null), cursor: null, pending: false };
  assert.equal(decodeBatch(bytes({ ...base, control: ctl({ mode: "inventory", inventory: wire }) })).control.inventory.ready, true);
  assert.equal(decodeBatch(bytes({ ...base, control: ctl({ mode: "inventory", inventory: { ...wire, ready: false } }) })).control.inventory.ready, false);
  assert.throws(() => decodeBatch(bytes({ ...base, control: ctl({ mode: "inventory", inventory: { ...wire, ready: 1 } }) })));
  const { vc, feed } = viewerControl();
  enter(vc, feed);
  vc.outbound();
  vc.keyDown("KeyE", false);
  vc.outbound();
  feed(ctl({ ack: 3, mode: "inventory", inventory: { ...wire, ready: false } }));
  vc.inventoryClick("pickup", 9, 0);
  assert.equal(vc.outbound().i[2], 2);
  vc.keyDown("KeyE", false);
  assert.equal(vc.mode, "play");
  assert.equal(vc.outbound().i[2], 4);
});

function playing() {
  const ctx = viewerControl();
  enter(ctx.vc, ctx.feed);
  ctx.feed(ctl({ ack: 1, mode: "play" }));
  ctx.vc.outbound();
  ctx.feed(ctl({ ack: 2, mode: "play" }));
  return ctx;
}

test("Backspace in play sends one toggle tap per press, ignores repeat, and is consumed", () => {
  const { vc } = playing();
  assert.equal(vc.keyDown("Backspace", false), true);
  assert.equal(vc.keyDown("Backspace", true), true);
  assert.equal(vc.outbound().i[6] & 8, 8);
  assert.equal(vc.outbound().i[6] & 8, 0);
  vc.keyDown("Backspace", false);
  vc.keyUp("Backspace");
  vc.keyDown("Backspace", false);
  assert.equal(vc.outbound().i[6] & 8, 0);
});

test("Backspace is not consumed or sent outside play, and focus loss drops a pending toggle", () => {
  const idle = viewerControl();
  idle.feed(ctl());
  assert.equal(idle.vc.keyDown("Backspace", false), false);
  const { vc } = playing();
  vc.keyDown("Backspace", false);
  vc.focusLost();
  assert.equal(vc.mode, "pause");
  assert.equal(vc.outbound().i[2], 0);
});

test("Backspace leaves held movement keys untouched", () => {
  const { vc } = playing();
  vc.keyDown("KeyW", false);
  vc.keyDown("Backspace", false);
  const sent = vc.outbound().i;
  assert.equal(sent[3] & KEY.forward, KEY.forward);
  assert.equal(sent[6] & 8, 8);
  assert.equal(vc.outbound().i[3] & KEY.forward, KEY.forward);
});

test("Left Ctrl, R, or Q sprints only while forward is held; releasing stops it", () => {
  for (const sprintKey of ["ControlLeft", "KeyR", "KeyQ"]) {
    const s = new InputState();
    s.keyDown(sprintKey, 0);
    assert.equal(s.frame(1).keys & KEY.sprint, 0);
    s.keyDown("KeyW", 2);
    assert.equal(s.frame(3).keys, KEY.forward | KEY.sprint);
    s.keyDown("ShiftLeft", 4);
    assert.equal(s.frame(5).keys & KEY.sneak, KEY.sneak);
    s.keyUp("ShiftLeft", 6);
    s.keyUp(sprintKey, 7);
    assert.equal(s.frame(8).keys, KEY.forward);
    s.keyDown(sprintKey, 9);
    s.keyUp("KeyW", 10);
    assert.equal(s.frame(11).keys, 0);
  }
});

test("sprint does not latch across blur or menu changes", () => {
  const s = new InputState();
  s.keyDown("KeyW", 0);
  s.keyDown("ControlLeft", 1);
  s.clear(2);
  assert.equal(s.frame(3).keys, 0);
  s.keyDown("KeyW", 4);
  s.keyDown("ControlLeft", 5);
  s.setUi("inventory", 6);
  s.setUi("play", 7);
  assert.equal(s.frame(8).keys, 0);
  s.setUi("menu", 9);
  s.keyDown("ControlLeft", 10);
  assert.equal(s.frame(11).keys, 0);
});

test("the viewer sends the sprint bit and focus loss clears it", () => {
  const { vc } = playing();
  vc.keyDown("KeyW", false);
  vc.keyDown("ControlLeft", false);
  assert.equal(vc.outbound().i[3], KEY.forward | KEY.sprint);
  vc.keyUp("ControlLeft");
  assert.equal(vc.outbound().i[3], KEY.forward);
  vc.keyDown("KeyR", false);
  assert.equal(vc.outbound().i[3], KEY.forward | KEY.sprint);
  vc.keyUp("KeyR");
  vc.keyDown("KeyQ", false);
  assert.equal(vc.outbound().i[3], KEY.forward | KEY.sprint);
  vc.focusLost();
  assert.equal(vc.mode, "pause");
  assert.equal(vc.outbound().i[2], 0);
});

test("a second distinct Esc from the pause menu resumes locked play, once, with a recapture request", () => {
  const { vc, log, feed, tick } = viewerControl();
  enter(vc, feed);
  vc.lockChanged(false);
  assert.equal(vc.mode, "pause");
  tick(200);
  const locks = log.locks;
  assert.equal(vc.keyDown("Escape", false), true);
  assert.equal(vc.mode, "play");
  assert.equal(log.locks, locks + 1);
  assert.equal(vc.keyDown("Escape", true), true);
  assert.equal(vc.mode, "play");
  vc.lockChanged(true);
  vc.keyUp("Escape");
  assert.equal(vc.captureOnClick(), false);
  assert.equal(vc.mode, "play");
});

test("the same Esc press that lost pointer lock does not also unpause, but a fresh press does", () => {
  const { vc, feed, tick } = viewerControl();
  enter(vc, feed);
  vc.lockChanged(false);
  tick(5);
  assert.equal(vc.keyDown("Escape", false), true);
  assert.equal(vc.mode, "pause");
  assert.equal(vc.keyDown("Escape", true), true);
  vc.keyUp("Escape");
  assert.equal(vc.mode, "pause");
  assert.equal(vc.keyDown("Escape", false), true);
  assert.equal(vc.mode, "play");
});

test("a held Esc never pauses and unpauses; keydown-first Esc pauses once and ignores repeats", () => {
  const { vc, feed, tick } = viewerControl();
  enter(vc, feed);
  assert.equal(vc.keyDown("Escape", false), true);
  assert.equal(vc.mode, "pause");
  vc.lockChanged(false);
  tick(500);
  for (let i = 0; i < 20; i++) assert.equal(vc.keyDown("Escape", true), true);
  assert.equal(vc.mode, "pause");
  vc.keyUp("Escape");
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "play");
});

test("Esc from a keyboard pause resumes keyboard play without requesting capture; a denied recapture still plays and a click recaptures without attacking", () => {
  const { vc, log, feed, tick } = viewerControl();
  feed(ctl());
  vc.playWithoutCapture();
  assert.equal(vc.mode, "play");
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "pause");
  tick(200);
  let locks = log.locks;
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "play");
  assert.equal(log.locks, locks);
  assert.equal(vc.captureOnClick(), false);

  const other = viewerControl();
  enter(other.vc, other.feed);
  other.vc.lockChanged(false);
  other.tick(200);
  other.vc.keyDown("Escape", false);
  other.vc.lockDenied();
  assert.equal(other.vc.mode, "play");
  assert.equal(other.vc.captureOnClick(), true);
  other.vc.keyDown("KeyW", false);
  assert.equal(other.vc.mode, "play");
});

test("Esc unpauses only when play is allowed; blur pauses but never auto-resumes", () => {
  const { vc, feed, tick } = viewerControl();
  feed(ctl());
  vc.playWithoutCapture();
  vc.focusLost();
  assert.equal(vc.mode, "pause");
  feed(ctl({ canPlay: false }));
  tick(200);
  assert.equal(vc.keyDown("Escape", false), true);
  assert.equal(vc.mode, "pause");
  feed(ctl());
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "play");
});

test("Esc resumes locked play after a stale host pause echo and the grant ending clears it", () => {
  const { vc, log, feed, tick } = viewerControl();
  enter(vc, feed);
  vc.outbound();
  feed(ctl({ ack: 2, mode: "play" }));
  vc.lockChanged(false);
  tick(200);
  vc.outbound();
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "play");
  feed(ctl({ ack: 2, mode: "pause" }));
  assert.equal(vc.mode, "play");
  const next = vc.outbound().i;
  feed(ctl({ ack: next[1], mode: "play" }));
  assert.equal(vc.mode, "play");
  feed(null);
  assert.equal(vc.keyDown("Escape", false), false);
  assert.equal(log.states.at(-1).mode, "view");
});

test("a server-dismissed container opened from play returns to play with a single recapture and no close shot", () => {
  const { vc, log, feed } = openInventory();
  const locks = log.locks;
  feed(ctl({ ack: 99, mode: "play" }));
  assert.equal(vc.mode, "play");
  assert.equal(log.locks, locks + 1);
  assert.notEqual(vc.outbound().i[2], 4);
});

test("sprint order and alias overlap: W first, and one alias releasing keeps the other", () => {
  const s = new InputState();
  s.keyDown("KeyW", 0);
  s.keyDown("ControlLeft", 1);
  s.keyDown("KeyR", 2);
  s.keyUp("ControlLeft", 3);
  assert.equal(s.frame(4).keys, KEY.forward | KEY.sprint);
  s.keyUp("KeyR", 5);
  assert.equal(s.frame(6).keys, KEY.forward);
  s.keyDown("KeyR", 7);
  s.keyDown("ControlLeft", 8);
  s.keyUp("KeyR", 9);
  assert.equal(s.frame(10).keys, KEY.forward | KEY.sprint);
  s.keyUp("ControlLeft", 11);
  assert.equal(s.frame(12).keys, KEY.forward);
  s.keyDown("ControlLeft", 13);
  s.keyDown("Space", 14);
  s.keyDown("ShiftLeft", 15);
  s.keyDown("KeyS", 16);
  s.keyDown("KeyA", 17);
  s.keyDown("KeyD", 18);
  s.mouseDown(0, 19);
  s.mouseDown(2, 20);
  assert.equal(s.frame(21).keys, 511);
});

test("blur drops a pending pointer capture so a delayed lock success cannot enter play", () => {
  for (const from of ["idle", "pause"]) {
    const { vc, log, feed, tick } = viewerControl();
    if (from === "idle") {
      feed(ctl());
      vc.intervene();
    } else {
      enter(vc, feed);
      vc.lockChanged(false);
      tick(200);
      vc.resumePlay();
    }
    vc.focusLost();
    const unlocks = log.unlocks;
    vc.lockChanged(true);
    assert.equal(vc.mode, from);
    assert.equal(log.unlocks, unlocks + 1);
  }
});

test("a fast Esc pause then Esc resume still sends a native Pause until it is acknowledged", () => {
  const { vc, feed, tick } = viewerControl();
  enter(vc, feed);
  vc.outbound();
  feed(ctl({ ack: 2, mode: "play" }));
  vc.lockChanged(false);
  tick(200);
  vc.keyDown("Escape", false);
  assert.equal(vc.mode, "play");
  const first = vc.outbound().i;
  assert.equal(first[2], 0);
  assert.equal(vc.outbound().i[2], 0);
  feed(ctl({ ack: first[1], mode: "pause" }));
  assert.equal(vc.mode, "play");
  const hold = vc.outbound().i;
  assert.deepEqual(hold.slice(2), [1, 0, 0, 0, 0, -1]);
  feed(ctl({ ack: hold[1], mode: "play" }));
  assert.equal(vc.mode, "play");
  vc.lockChanged(true);
  assert.equal(vc.outbound().i[2], 1);
});

test("Backspace pressed before the host acknowledges play is kept for the first live frame", () => {
  const { vc, feed } = viewerControl();
  enter(vc, feed);
  vc.keyDown("Backspace", false);
  const hold = vc.outbound().i;
  assert.deepEqual(hold.slice(2), [1, 0, 0, 0, 0, -1]);
  feed(ctl({ ack: hold[1], mode: "play" }));
  const live = vc.outbound().i;
  assert.equal(live[2], 1);
  assert.equal(live[6] & 8, 8);
  assert.equal(vc.outbound().i[6] & 8, 0);
});

test("hotbar wheel steps, wraps, and accumulates small pixel deltas", () => {
  const w = new HotbarWheel();
  assert.equal(w.select(100, 0, 2, 0), 3);
  assert.equal(w.select(-100, 0, 3, 500), 2);
  w.reset();
  assert.equal(w.select(-100, 0, 0, 1000), 8);
  assert.equal(w.select(100, 0, 8, 1500), 0);
  assert.equal(w.select(40, 0, 0, 2000), null);
  assert.equal(w.select(40, 0, 0, 2050), null);
  assert.equal(w.select(40, 0, 0, 2100), 1);
  assert.equal(w.select(40, 0, 1, 3000), null);
  assert.equal(w.select(-40, 0, 1, 3010), null);
  assert.equal(w.select(Infinity, 0, 3, 4000), null);
  assert.equal(w.select(100, 0, -1, 4010), null);
  assert.equal(w.select(900, 0, 3, 4020), 4);
});

test("hotbar wheel notches accumulate across gaps and stale leftovers expire", () => {
  const w = new HotbarWheel();
  assert.equal(w.select(50, 0, 0, 0), null);
  assert.equal(w.select(50, 0, 0, 300), 1);
  assert.equal(w.select(50, 0, 1, 600), null);
  assert.equal(w.select(50, 0, 1, 5000), null);
  assert.equal(w.select(50, 0, 1, 5300), 2);
  let selected = 0;
  const lines = new HotbarWheel();
  for (let i = 0; i < 7; i++) {
    const to = lines.select(3, 1, selected, i * 10);
    assert.equal(to, (selected + 1) % 9);
    selected = to;
  }
  const notch = new HotbarWheel();
  selected = 0;
  for (let i = 0; i < 6; i++) selected = notch.select(120, 0, selected, i * 400);
  assert.equal(selected, 6);
});

test("hotbar wheel trusts the HUD once it changes, bridging only an unechoed request", () => {
  const w = new HotbarWheel();
  assert.equal(w.select(100, 0, 0, 0), 1);
  assert.equal(w.select(100, 0, 0, 10), 2);
  assert.equal(w.select(100, 0, 1, 20), 2);
  assert.equal(w.select(100, 0, 2, 30), 3);
  w.reset();
  w.note(0, 7, 0);
  assert.equal(w.select(100, 0, 0, 10), 8);
  w.reset();
  assert.equal(w.select(100, 0, 0, 0), 1);
  assert.equal(w.select(100, 0, 0, 2000), 1);
  assert.equal(w.select(100, 0, 6, 2010), 7);
});

function wheelRig() {
  const rig = playRig();
  const wheel = new HotbarWheel();
  const sent = [];
  const fire = (deltaY, over = {}) => {
    let prevented = false;
    wheelHotbar({ ctrlKey: false, deltaY, deltaMode: 0, preventDefault() { prevented = true; }, ...over }, {
      captured: rig.vc.mode === "play", ready: rig.vc.playReady, selected: rig.selected, now: 0, wheel,
      choose: slot => { sent.push(slot); rig.vc.touchSlot(slot); },
    });
    return prevented;
  };
  return { ...rig, wheel, sent, fire };
}

function playRig() {
  const { vc, feed, tick } = viewerControl();
  feed(ctl({ ack: 0 }));
  vc.playWithoutCapture();
  return { vc, feed, tick, selected: 0 };
}

test("wheel during the play handshake is ignored and never queues a lost slot", () => {
  const r = wheelRig();
  assert.equal(r.vc.mode, "play");
  assert.equal(r.vc.playReady, false);
  assert.equal(r.fire(100), true);
  assert.deepEqual(r.sent, []);
  assert.equal(r.vc.outbound().i[2], 6);
  r.feed(ctl({ ack: 1 }));
  const first = r.vc.outbound().i;
  assert.equal(first.at(-1), -1);
  assert.equal(r.fire(100), true);
  assert.deepEqual(r.sent, []);
  r.feed(ctl({ ack: first[1], mode: "play" }));
  assert.equal(r.vc.playReady, true);
  assert.equal(r.fire(100), true);
  assert.deepEqual(r.sent, [1]);
  assert.equal(r.vc.outbound().i.at(-1), 1);
});

test("wheel always blocks browser zoom while captured but never selects with Ctrl or chat", () => {
  const r = wheelRig();
  r.vc.outbound();
  r.feed(ctl({ ack: 1 }));
  const first = r.vc.outbound().i;
  r.feed(ctl({ ack: first[1], mode: "play" }));
  assert.equal(r.fire(100, { ctrlKey: true }), true);
  assert.deepEqual(r.sent, []);
  r.vc.openChat();
  assert.equal(r.vc.playReady, false);
  assert.equal(r.fire(100), true);
  assert.deepEqual(r.sent, []);
  r.vc.closeChat();
  r.vc.reset();
  assert.equal(r.fire(100), false);
});

test("closing chat requires a fresh neutral play frame before the wheel counts", () => {
  const r = wheelRig();
  const host = { mode: "available", focused: false, ack: 0, applied: [] };
  const send = i => {
    const [, seq, kind, , , , , slot] = i;
    host.ack = seq;
    if (kind === 6) host.mode = "available";
    else if (kind === 1) {
      const neutral = i.slice(3, 7).every(v => v === 0) && slot === -1;
      if (host.focused && !neutral) return;
      if (host.mode !== "play" && !neutral) return;
      host.focused = false;
      host.mode = "play";
      if (slot >= 0) host.applied.push(slot);
    } else if (kind === 9) host.focused = true;
    r.feed(ctl({ ack: host.ack, mode: host.mode === "play" ? "play" : "available" }));
  };
  for (let n = 0; n < 3; n++) send(r.vc.outbound().i);
  assert.equal(r.vc.playReady, true);
  assert.equal(r.vc.openChat(), true);
  send(r.vc.outbound().i);
  assert.equal(host.focused, true);
  r.vc.closeChat();
  assert.equal(r.vc.playReady, false);
  assert.equal(r.fire(100), true);
  assert.deepEqual(r.sent, []);
  const neutral = r.vc.outbound().i;
  assert.deepEqual(neutral.slice(2), [1, 0, 0, 0, 0, -1]);
  send(neutral);
  assert.equal(host.focused, false);
  assert.equal(r.vc.playReady, true);
  r.fire(100);
  assert.deepEqual(r.sent, [1]);
  send(r.vc.outbound().i);
  assert.deepEqual(host.applied, [1]);
});

test("chat opened and closed before any focus frame keeps the play handshake", () => {
  const r = wheelRig();
  r.vc.outbound();
  r.feed(ctl({ ack: 1 }));
  const first = r.vc.outbound().i;
  r.feed(ctl({ ack: first[1], mode: "play" }));
  assert.equal(r.vc.openChat(), true);
  r.vc.closeChat();
  assert.equal(r.vc.playReady, true);
  r.fire(100);
  assert.deepEqual(r.sent, [1]);
  const frame = r.vc.outbound().i;
  assert.equal(frame[1], first[1] + 1);
  assert.equal(frame[2], 1);
  assert.equal(frame.at(-1), 1);
});
