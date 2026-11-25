import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

const { InputState, KEY } = requireModule("./input.js");
const { TouchSurface, STICK_RADIUS } = requireModule("./touch.js");
const { ViewerControl } = requireModule("./viewer-control.js");

function rig() {
  const input = new InputState();
  let now = 0;
  const surface = new TouchSurface({ keys: bits => input.touchKeys(bits, now), look: (dx, dy) => input.touchLook(dx, dy, now), abort: bits => input.touchAbort(bits) });
  return { input, surface, frame: () => input.frame((now += 50)), advance: ms => { now += ms; } };
}

test("left stick maps direction past the dead zone onto movement keys", () => {
  const { surface, frame } = rig();
  surface.beginStick(1, 100, 300);
  surface.move(1, 105, 295);
  assert.equal(frame().keys, 0);
  surface.move(1, 100, 300 - STICK_RADIUS);
  assert.equal(frame().keys, KEY.forward);
  surface.move(1, 100 + STICK_RADIUS, 300 - STICK_RADIUS);
  assert.equal(frame().keys, KEY.forward | KEY.right);
  surface.move(1, 100 - 500, 300 + 500);
  assert.equal(frame().keys, KEY.back | KEY.left);
  surface.end(1);
  assert.equal(frame().keys, 0);
});

test("a second finger cannot take the stick or the look zone", () => {
  const { surface } = rig();
  assert.ok(surface.beginStick(1, 0, 0));
  assert.ok(!surface.beginStick(2, 0, 0));
  assert.ok(surface.beginLook(3, 0, 0));
  assert.ok(!surface.beginLook(4, 0, 0));
});

test("right drag turns by touch sensitivity, needs no lock, and ignores other fingers", () => {
  const { surface, frame } = rig();
  surface.beginLook(5, 300, 200);
  surface.move(5, 340, 190);
  surface.move(9, 0, 0);
  const f = frame();
  assert.equal(f.dyaw, 10);
  assert.equal(f.dpitch, -2.5);
  assert.equal(frame().dyaw, 0);
});

test("attack, use and jump hold with a tap edge; sprint and sneak latch and exclude each other", async () => {
  const { surface, frame } = rig();
  surface.beginHold(1, "attack");
  assert.equal(frame().keys, KEY.attack);
  surface.end(1);
  assert.equal(frame().taps & 2, 0);
  surface.beginHold(2, "use");
  surface.end(2);
  assert.equal(frame().taps & 4, 4);
  surface.tap("jump");
  assert.equal(frame().keys & KEY.jump, KEY.jump);
  await delay(100);
  assert.equal(frame().keys & KEY.jump, 0);
  surface.beginStick(3, 0, 0);
  surface.move(3, 0, -STICK_RADIUS);
  assert.ok(surface.toggleSprint());
  assert.equal(frame().keys, KEY.forward | KEY.sprint);
  assert.ok(surface.toggleSneak());
  assert.ok(!surface.sprint);
  assert.equal(frame().keys, KEY.forward | KEY.sneak);
});

test("sprint latch does nothing without forward", () => {
  const { surface, frame } = rig();
  surface.toggleSprint();
  assert.equal(frame().keys, 0);
});

test("cancel drops every pointer, latch and queued tap", () => {
  const { surface, frame } = rig();
  surface.beginStick(1, 0, 0);
  surface.move(1, 0, -STICK_RADIUS);
  surface.beginHold(2, "attack");
  surface.beginLook(3, 0, 0);
  surface.toggleSneak();
  assert.notEqual(frame().keys, 0);
  surface.cancel();
  assert.equal(frame().keys, 0);
  assert.ok(!surface.active && !surface.sneak);
  surface.move(3, 50, 50);
  assert.equal(frame().dyaw, 0);
});

test("input state ignores touch outside play and a ui change clears held touch keys", () => {
  const { input, surface, frame } = rig();
  surface.beginHold(1, "use");
  assert.equal(frame().keys, KEY.use);
  input.setUi("menu", 1000);
  assert.equal(frame().keys, 0);
  input.touchKeys(KEY.forward, 1100);
  input.setUi("play", 1200);
  assert.equal(input.frame(1300).keys, 0);
});

function viewerControl() {
  let time = 0;
  const vc = new ViewerControl({ state() {}, lock() { throw new Error("touch must not lock"); }, unlock() {}, inventory() {}, marker() {} }, () => time);
  const feed = control => vc.apply({ epoch: 1, seq: 1, status: "ready", yaw: 0, control });
  return { vc, feed };
}

function play() {
  const rigged = viewerControl();
  const { vc, feed } = rigged;
  feed({ grant: 7, ack: 0, mode: "available" });
  vc.playWithoutCapture();
  assert.equal(vc.mode, "play");
  assert.equal(vc.outbound().i[2], 6);
  feed({ grant: 7, ack: 1, mode: "available" });
  const neutral = vc.outbound().i;
  assert.deepEqual(neutral.slice(2), [1, 0, 0, 0, 0, -1]);
  feed({ grant: 7, ack: neutral[1], mode: "play" });
  return rigged;
}

test("touch play starts without pointer lock and sends touch keys, look and hotbar slot", () => {
  const { vc } = play();
  vc.touchKeys(KEY.forward);
  vc.touchLook(40, 0);
  vc.touchSlot(4);
  const [, , kind, keys, dyaw, , , slot] = vc.outbound().i;
  assert.deepEqual([kind, keys, dyaw, slot], [1, KEY.forward, 1000, 4]);
});

test("pause, chat and focus loss drop touch input; touch is ignored outside play", () => {
  const { vc, feed } = play();
  vc.touchKeys(KEY.forward);
  assert.equal(vc.outbound().i[3], KEY.forward);
  vc.focusLost();
  assert.equal(vc.mode, "pause");
  vc.touchKeys(KEY.forward);
  vc.touchLook(10, 10);
  vc.playWithoutCapture();
  const first = vc.outbound().i;
  feed({ grant: 7, ack: first[1], mode: "play" });
  const resumed = vc.outbound().i;
  assert.equal(resumed[2], 1);
  assert.deepEqual(resumed.slice(3, 5), [0, 0]);
  feed({ grant: 7, ack: 60, mode: "play", canChat: true });
  vc.touchKeys(KEY.forward);
  assert.ok(vc.openChat("/"));
  vc.touchKeys(KEY.forward);
  vc.closeChat();
  assert.equal(vc.outbound().i[3], 0);
});

test("a contact lost before sampling sends no tap; an ordinary release still taps", () => {
  const { surface, frame } = rig();
  surface.beginHold(1, "attack");
  surface.lose(1);
  assert.equal(frame().taps, 0);
  surface.beginHold(2, "attack");
  surface.end(2);
  surface.lose(2);
  assert.equal(frame().taps & 2, 2);
});

test("losing one contact keeps other held contacts and drops latches", () => {
  const { surface, frame } = rig();
  surface.beginStick(1, 0, 0);
  surface.move(1, 0, -STICK_RADIUS);
  surface.beginHold(2, "use");
  surface.beginHold(3, "attack");
  surface.toggleSneak();
  surface.lose(3);
  assert.equal(frame().keys, KEY.forward | KEY.use);
  surface.lose(99);
  assert.equal(frame().keys, KEY.forward | KEY.use);
});

test("global cancel discards unsent taps", () => {
  const { surface, frame } = rig();
  surface.beginHold(1, "jump");
  surface.end(1);
  surface.cancel();
  assert.equal(frame().taps, 0);
});

test("a new grant does not inherit the previous grant's pending pause or held input", () => {
  const { vc, feed } = play();
  vc.keyDown("KeyW", false);
  vc.touchKeys(KEY.attack | KEY.jump);
  feed({ grant: 8, ack: 0, mode: "available" });
  vc.playWithoutCapture();
  assert.deepEqual(vc.outbound().i, [8, 1, 6]);
  feed({ grant: 8, ack: 1, mode: "available" });
  assert.deepEqual(vc.outbound().i, [8, 2, 1, 0, 0, 0, 0, -1]);
  feed({ grant: 8, ack: 2, mode: "play" });
  assert.deepEqual(vc.outbound().i, [8, 3, 1, 0, 0, 0, 0, -1]);
});

test("replacing a grant from inventory queues no close for the old menu", () => {
  const { vc, feed } = viewerControl();
  const inv = { menu: 12, pending: false };
  feed({ grant: 7, ack: 0, mode: "inventory", inventory: inv });
  assert.equal(vc.mode, "inventory");
  feed({ grant: 8, ack: 0, mode: "available" });
  assert.deepEqual(vc.outbound().i, [8, 1, 0]);
});
