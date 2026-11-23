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

const { decodeBatch, decodeLease, readBytes } = requireModule("./wire.js");
const { ViewerFeed } = requireModule("./feed.js");
const { ViewerTerrain } = requireModule("./viewer-terrain.js");
const { ViewerHud, heldLabel, itemLabel } = requireModule("./viewer-hud.js");
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const header = { epoch: 7, seq: 5, status: "ready", yaw: 0 };
const origin = [0, 0, 0];
const states = new Uint16Array(4096);
states[1] = 65534;

function batchBytes(data, states = []) {
  const json = encode(data);
  const bytes = new Uint8Array(2 + json.length + states.length * 2);
  bytes.set(json, 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, json.length, true);
  states.forEach((id, i) => view.setUint16(2 + json.length + i * 2, id, true));
  return bytes;
}

test("decodes unsigned little-endian states and signed section positions", () => {
  const position = [-25, -3, 19];
  const data = { ...header, center: position, eye: [0.5, -3, 22.5], look: [0, 0, 1], air: [0, 14, 65535] };
  const bytes = batchBytes({ ...data, section: { position, kind: "states" } }, states);
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes, 1);
  assert.deepEqual(decodeBatch(padded.subarray(1)), { ...data, section: { position, kind: "states", states } });
  for (const kind of ["air", "unloaded"]) {
    const bodyless = { ...data, section: { position, kind } };
    assert.deepEqual(decodeBatch(batchBytes(bodyless)), bodyless);
    assert.throws(() => decodeBatch(batchBytes(bodyless, [0])));
  }
});

const route = { name: "A-route_1", color: 0x1234EF, points: [[1, -257, 512], [-7_680_000_000, 0, 7_680_000_000]] };
const decodedRoute = { ...route, points: [[1 / 256, -257 / 256, 2], [-30_000_000, 0, 30_000_000]] };

test("decodes paths independently or beside terrain, preserving clear and omission", () => {
  assert.deepEqual(decodeBatch(batchBytes(header)), header);
  assert.deepEqual(decodeBatch(batchBytes({ ...header, paths: [] })), { ...header, paths: [] });
  assert.deepEqual(decodeBatch(batchBytes({ ...header, paths: [route] })), { ...header, paths: [decodedRoute] });

  const paths = Array.from({ length: 8 }, (_, i) => ({
    name: `${"a".repeat(31)}${i}`,
    color: i === 0 ? 0 : 0xFFFFFF,
    points: Array(16).fill(route.points[1]),
  }));
  const section = { position: origin, kind: "states" };
  const decoded = decodeBatch(batchBytes({ ...header, paths, section }, states));
  assert.deepEqual(decoded.paths, paths.map(path => ({ ...path, points: Array(16).fill(decodedRoute.points[1]) })));
  assert.deepEqual(decoded.section, { ...section, states });
});

test("rejects malformed or oversized path snapshots", () => {
  const invalidPaths = [
    null, {}, [null], [route, route], Array.from({ length: 9 }, (_, i) => ({ ...route, name: `r${i}` })),
    [route, { ...route, name: "overflow", points: Array(127).fill(origin) }],
    ...["", "a".repeat(33), "route\n", "route\r", "route ", "á", "two words", 1, null]
      .map(name => [{ ...route, name }]),
    ...[-1, 0x1000000, 1.25, "1", null].map(color => [{ ...route, color }]),
    ...[[], null, "123", [origin, [0, 1]], [[0, 1, 2, 3]], [[0, 1, "2"]], [[0, 1, null]],
      [[0, 1, 1 / 256]], [[0, 1, 7_680_000_001]], [[0, -7_680_000_001, 1]], [[2 ** 53, 0, 0]]]
      .map(points => [{ ...route, points }]),
  ];
  for (const paths of invalidPaths) assert.throws(() => decodeBatch(batchBytes({ ...header, paths })), /Invalid viewer reply/);
  for (const status of ["waiting", "unsupported"]) {
    assert.throws(() => decodeBatch(batchBytes({ ...header, status, paths: [] })), /Invalid viewer reply/);
  }
  assert.throws(() => decodeBatch(batchBytes({ ...header, paths: [route], extra: "x".repeat(16384) })), /Invalid viewer reply/);
});

test("rejects malformed viewer messages and bounds response reads", async () => {
  assert.equal(decodeLease(encode({ lease: "aa44" })), "aa44");
  assert.throws(() => decodeLease(encode({ lease: "bad\nlease" })));
  const data = { ...header, section: { position: origin, kind: "states" } };
  const valid = batchBytes(data, states);
  for (const bytes of [valid.subarray(0, valid.length - 1), new Uint8Array([255, 255]), new Uint8Array(16385)]) {
    assert.throws(() => decodeBatch(bytes));
  }
  for (const invalid of [
    { epoch: -1 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { look: [0, 0, 0] }, { status: "bogus" },
    { eye: [0, "4", 5] }, { center: [0, 2147483648, 5] }, { air: [65536] },
    { yaw: undefined }, { yaw: Infinity }, { yaw: "180" },
    { status: "waiting", section: { position: origin, kind: "air" } },
  ]) assert.throws(() => decodeBatch(batchBytes({ ...header, ...invalid })));
  await assert.rejects(readBytes(new Response(new Uint8Array(9)), 8));
});

test("prunes sections on recenter and clears the visible window on epoch change", () => {
  const drawn = new Map();
  const released = [];
  let pose = null;
  let creations = 0;
  const terrain = new ViewerTerrain(() => {
    creations++;
    return {
      replaceSection(position, update) {
        if (update) drawn.set(position.join(","), update);
        else { drawn.delete(position.join(",")); released.push("air"); }
      },
      removeSection(position) { drawn.delete(position.join(",")); released.push("unloaded"); },
      clear() { drawn.clear(); pose = null; },
      setPose(eye, look, yaw) { pose = { eye, look, yaw }; },
      dispose() {},
    };
  });
  const metadata = { center: origin, air: [0, 40001], eye: [0, 1, 0], look: [0, 0, -1], yaw: 180 };
  const update = { position: [-2, 1, 0], kind: "states", states };
  terrain.apply({ ...header, ...metadata, section: update });
  assert.deepEqual(pose, { eye: metadata.eye, look: metadata.look, yaw: metadata.yaw });
  assert.equal(drawn.size, 1);
  terrain.apply({ ...header, center: [1, 0, 0], section: update });
  assert.equal(drawn.size, 0, "ignores updates to pruned sections");
  terrain.apply({ ...header, center: origin, section: update });
  terrain.apply({ ...header, section: { ...update, kind: "air" } });
  assert.equal(drawn.size, 0);
  terrain.apply({ ...header, section: update });
  terrain.apply({ ...header, section: { ...update, kind: "unloaded" } });
  assert.deepEqual(released, ["unloaded", "air", "unloaded"]);
  terrain.apply({ ...header, section: update });
  terrain.apply({ ...header, epoch: 8 });
  assert.equal(pose, null);
  assert.equal(drawn.size, 0);
  terrain.apply({ ...header, ...metadata, air: [40001, 0], epoch: 8, section: update });
  assert.equal(creations, 1);
  assert.equal(drawn.get("-2,1,0"), states);
});

test("keeps paths across pose and section frames but clears them on world or status changes", () => {
  let visible = [];
  const terrain = new ViewerTerrain(() => ({
    replaceSection() {}, setPose() {}, dispose() {},
    setPaths(paths) { visible = paths; },
    clear() { visible = []; },
  }));
  terrain.apply({ ...header, paths: [decodedRoute] });
  assert.deepEqual(visible, [], "waits for renderer metadata");
  terrain.apply({ ...header, air: [0], center: origin });
  assert.deepEqual(visible, [decodedRoute]);
  terrain.apply({ ...header, eye: [0, 1, 0], look: [0, 0, 1] });
  terrain.apply({ ...header, section: { position: origin, kind: "states", states } });
  assert.deepEqual(visible, [decodedRoute]);
  const replacement = { ...decodedRoute, name: "new" };
  terrain.apply({ ...header, paths: [replacement] });
  assert.deepEqual(visible, [replacement], "replaces the full snapshot");
  terrain.apply({ ...header, paths: [] });
  assert.deepEqual(visible, []);

  for (const reset of [{ epoch: 8 }, { status: "waiting" }, { status: "unsupported" }]) {
    terrain.apply({ ...header, air: [0], paths: [decodedRoute] });
    assert.deepEqual(visible, [decodedRoute]);
    terrain.apply({ ...header, ...reset });
    assert.deepEqual(visible, []);
  }
  terrain.apply({ ...header, paths: [decodedRoute] });
  terrain.apply({ ...header, epoch: 8, air: [0] });
  assert.deepEqual(visible, [], "drops a pending snapshot at reset too");
});

function probe(t, terrain) {
  const sent = [];
  const applied = [];
  const statuses = [];
  let resets = 0;
  const feed = new ViewerFeed({
    apply(batch) { applied.push(batch); terrain?.apply(batch); },
    reset() { resets++; terrain?.reset(); },
    status(status) { statuses.push(status); },
  }, (path, options) => new Promise(resolve => sent.push({ path, options, resolve, start: performance.now() })));
  t.after(() => {
    feed.detach();
    sent.forEach(request => request.resolve(new Response(null, { status: 403 })));
  });
  return { sent, applied, statuses, feed, resets: () => resets };
}

async function until(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "timed out waiting for viewer request");
    await delay(5);
  }
}

test("detaching aborts pending pairing and retires stale responses before starting another", async t => {
  const { sent, feed } = probe(t);
  const first = "ab".repeat(32), second = "00".repeat(32);
  feed.attach(first);
  await until(() => sent.length === 1);
  feed.detach();
  assert.equal(sent[0].options.signal.aborted, true);
  feed.attach(second);
  await delay(70);
  assert.equal(sent.length, 1);
  sent[0].resolve(Response.json({ lease: "aaaa" }));
  await until(() => sent.length === 2);
  assert.equal(sent[1].path, "/session");
  assert.equal(sent[1].options.headers.Authorization, `Bearer ${second}`);
  assert.equal(sent[1].options.body, undefined);
  assert.equal(sent[1].options.redirect, "error");
  assert.equal(sent[1].options.credentials, "omit");
});

test("detaching clears visible paths", async t => {
  let visible = [];
  const terrain = new ViewerTerrain(() => ({
    setPaths(paths) { visible = paths; },
    clear() { visible = []; },
  }));
  const { feed, sent } = probe(t, terrain);
  feed.attach("12".repeat(32));
  await until(() => sent.length === 1);
  sent[0].resolve(Response.json({ lease: "abcd" }));
  await until(() => sent.length === 2);
  sent[1].resolve(new Response(batchBytes({ ...header, air: [0], paths: [route] })));
  await until(() => visible.length === 1);
  assert.deepEqual(visible, [decodedRoute]);
  feed.detach();
  assert.deepEqual(visible, []);
});

test("acknowledges applied batches, backs off on 429, then resyncs after an invalid reply", async t => {
  const { sent, feed, applied, statuses, resets } = probe(t);
  feed.attach("12".repeat(32));
  await until(() => sent.length === 1);
  sent[0].resolve(Response.json({ lease: "abcd" }));
  await until(() => sent.length === 2);
  assert.equal(sent[1].path, "/next");
  assert.equal(sent[1].options.headers.Authorization, "Bearer abcd");
  assert.deepEqual(JSON.parse(sent[1].options.body), { epoch: 0, seq: 0 });
  assert.ok(sent[1].start - sent[0].start >= 50);
  sent[1].resolve(new Response(batchBytes(header)));
  await until(() => sent.length === 3);
  assert.deepEqual(applied, [header]);
  assert.deepEqual(JSON.parse(sent[2].options.body), { epoch: 7, seq: 5 });

  const limitedAt = performance.now();
  sent[2].resolve(new Response(null, { status: 429, headers: { "Retry-After": "0" } }));
  await until(() => sent.length === 4);
  assert.ok(sent[3].start - limitedAt >= 240);
  assert.ok(statuses.includes("rate-limited"));
  assert.deepEqual(JSON.parse(sent[3].options.body), { epoch: 7, seq: 5 });

  const resetsBefore = resets();
  sent[3].resolve(new Response(null, { status: 204 }));
  await until(() => sent.length === 5);
  assert.equal(statuses.at(-1), "ready");
  assert.equal(resets(), resetsBefore);
  assert.deepEqual(JSON.parse(sent[4].options.body), { epoch: 7, seq: 5 });

  sent[4].resolve(new Response("invalid frame"));
  await until(() => sent.length === 6);
  assert.equal(resets(), resetsBefore + 1);
  assert.deepEqual(JSON.parse(sent[5].options.body), { epoch: 0, seq: 0 });
  const replacement = { ...header, epoch: 8, seq: 1 };
  sent[5].resolve(new Response(batchBytes(replacement)));
  await until(() => sent.length === 7);
  assert.deepEqual(applied, [header, replacement]);
  sent[6].resolve(new Response(null, { status: 403 }));
  await until(() => statuses.at(-1) === "expired");
  await delay(70);
  assert.equal(sent.length, 7);
});

const hud = {
  health: 18.5, food: 20, selected: 2, mining: 40,
  slots: [null, { item: "stone", count: 64 }, { item: "diamond_pickaxe", count: 1 }, null, null, null, null, null, { item: "a".repeat(64), count: 999 }],
};

test("decodes a full HUD snapshot beside terrain and accepts boundaries", () => {
  assert.deepEqual(decodeBatch(batchBytes({ ...header, hud })), { ...header, hud });
  assert.equal(decodeBatch(batchBytes(header)).hud, undefined);
  const edge = { health: 0, food: 0, selected: 8, mining: null, slots: Array(9).fill({ item: "a_0", count: 1 }) };
  assert.deepEqual(decodeBatch(batchBytes({ ...header, hud: edge })).hud, edge);
  for (const patch of [{ health: 2048, mining: 99 }, { health: 0.5, mining: 0 }]) {
    assert.deepEqual(decodeBatch(batchBytes({ ...header, hud: { ...hud, ...patch } })).hud, { ...hud, ...patch });
  }
});

test("rejects malformed HUD snapshots and HUDs on non-ready frames", () => {
  const slot = { item: "stone", count: 1 };
  const bad = [
    null, [], "hud", { ...hud, health: -1 }, { ...hud, health: 2048.5 }, { ...hud, health: "20" }, { ...hud, health: null },
    ...[-1, 21, 1.5, "5", null].map(food => ({ ...hud, food })),
    ...[-1, 9, 0.5, "1", null].map(selected => ({ ...hud, selected })),
    ...[-1, 100, 1.5, "5", undefined].map(mining => ({ ...hud, mining })),
    { ...hud, slots: hud.slots.slice(1) }, { ...hud, slots: [...hud.slots, null] }, { ...hud, slots: null }, { ...hud, slots: {} },
    ...[0, 1000, 1.5, "1", null].map(count => ({ ...hud, slots: [{ ...slot, count }, ...hud.slots.slice(1)] })),
    ...["", "Stone", "minecraft:stone", "a-b", "é", "a".repeat(65), "stone\n", 1, null].map(item => ({ ...hud, slots: [{ ...slot, item }, ...hud.slots.slice(1)] })),
  ];
  for (const value of bad) assert.throws(() => decodeBatch(batchBytes({ ...header, hud: value })), /Invalid viewer reply/);
  for (const status of ["waiting", "unsupported"]) {
    assert.throws(() => decodeBatch(batchBytes({ ...header, status, hud })), /Invalid viewer reply/);
  }
});

test("keeps the HUD across omitted frames and clears it on epoch, status, and reset", () => {
  const shown = [];
  const view = new ViewerHud({ show: value => shown.push(value) });
  view.apply({ ...header });
  assert.deepEqual(shown, [], "nothing to show before a snapshot");
  view.apply({ ...header, hud });
  view.apply({ ...header, seq: 6 });
  assert.deepEqual(shown, [hud]);
  const next = { ...hud, selected: 1, mining: null };
  view.apply({ ...header, seq: 7, hud: next });
  assert.deepEqual(shown, [hud, next]);
  view.apply({ ...header, epoch: 8 });
  assert.deepEqual(shown.at(-1), null);
  view.apply({ ...header, epoch: 8, hud });
  view.apply({ ...header, epoch: 8, status: "waiting" });
  assert.equal(shown.at(-1), null);
  view.apply({ ...header, epoch: 8, hud });
  view.reset();
  assert.equal(shown.at(-1), null);
  const count = shown.length;
  view.reset();
  assert.equal(shown.length, count);
});

test("labels held items for humans", () => {
  assert.equal(itemLabel("diamond_pickaxe"), "Diamond Pickaxe");
  assert.equal(heldLabel(hud), "Diamond Pickaxe");
  assert.equal(heldLabel({ ...hud, selected: 1 }), "Stone ×64");
  assert.equal(heldLabel({ ...hud, selected: 0 }), "Empty hand");
});

test("detaching clears the HUD", async t => {
  const shown = [];
  const view = new ViewerHud({ show: value => shown.push(value) });
  const { feed, sent } = probe(t, view);
  feed.attach("12".repeat(32));
  await until(() => sent.length === 1);
  sent[0].resolve(Response.json({ lease: "abcd" }));
  await until(() => sent.length === 2);
  sent[1].resolve(new Response(batchBytes({ ...header, hud })));
  await until(() => shown.length === 1);
  feed.detach();
  assert.equal(shown.at(-1), null);
});
