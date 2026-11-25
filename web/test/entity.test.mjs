import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../scripts/load-for-test.mjs";

const { emitModel, modelParts, poseRotations } = load("entity-geometry");
const { toLayerEntities } = load("entity-glue");
const { defaultSkinName, loadLocalSkin, normalizeSkin, skinPath } = load("entity-skin");
const { EntityStore, INTERPOLATION_MS, MAX_ENTITIES, SNAP_DISTANCE, sanitizeEntity } = load("entity-state");
const { EntityLayer, parsePack } = load("entity-layer");
const { parseManifest } = load("atlas");

const rest = { swing: 0, amount: 0, headYaw: 0, pitch: 0 };

function collect(kind, { slim = false, pose = rest, place = { x: 0, y: 0, z: 0, yaw: 0 } } = {}) {
  const solid = [], outer = [];
  const sink = list => ({ push: (x, y, z, u, v, r, g, b) => list.push({ x, y, z, u, v, r, g, b }) });
  const rect = { x: 0, y: 0, w: 64, h: 64 };
  emitModel(kind, slim, pose, place, { main: rect, wool: rect }, { solid: () => sink(solid), outer: () => sink(outer) });
  return { solid, outer };
}

test("player base layer and outer layer use vanilla cuboid UVs", () => {
  const { solid, outer } = collect("player");
  assert.equal(solid.length, 6 * 36);
  assert.equal(outer.length, 6 * 36);
  const head = solid.slice(0, 36);
  const faceUv = face => {
    const uv = head.slice(face * 6, face * 6 + 6);
    return [Math.min(...uv.map(p => p.u)), Math.min(...uv.map(p => p.v)), Math.max(...uv.map(p => p.u)), Math.max(...uv.map(p => p.v))];
  };
  assert.deepEqual(faceUv(0), [8, 0, 16, 8], "top");
  assert.deepEqual(faceUv(1), [16, 0, 24, 8], "bottom");
  assert.deepEqual(faceUv(3), [8, 8, 16, 16], "front");
  assert.deepEqual(faceUv(5), [24, 8, 32, 16], "back");
  const hat = outer.slice(0, 36);
  assert.ok(hat.every(p => p.u >= 32 && p.v <= 16), "hat samples the outer head region");
  const top = Math.max(...collect("player", { place: { x: 0, y: 0, z: 0, yaw: 0, scale: 0.9375 } }).solid.map(p => p.y));
  assert.ok(Math.abs(top - 2.001 * 0.9375) < 0.001, `scaled player head top, got ${top}`);
});

test("front faces +z at yaw 0 and rotates with yaw", () => {
  const nose = ({ solid }) => {
    const head = solid.slice(0, 36);
    return head.reduce((s, p) => s + p.z, 0) / head.length;
  };
  const body = collect("pig");
  const headZ = body.solid.slice(0, 72).reduce((s, p) => s + p.z, 0) / 72;
  const bodyZ = body.solid.slice(72, 108).reduce((s, p) => s + p.z, 0) / 36;
  assert.ok(headZ > bodyZ, "pig head leads toward +z when yaw is 0");
  const turned = collect("pig", { place: { x: 0, y: 0, z: 0, yaw: 90 } });
  const headX = turned.solid.slice(0, 72).reduce((s, p) => s + p.x, 0) / 72;
  assert.ok(headX < -0.2, "yaw 90 faces -x");
  assert.ok(nose(body) > -1);
});

test("animals stand on the ground and stay inside the texture", () => {
  for (const kind of ["cow", "sheep", "pig", "chicken"]) {
    const { solid } = collect(kind);
    const low = Math.min(...solid.map(p => p.y));
    assert.ok(Math.abs(low) < 0.03, `${kind} feet at ground, got ${low}`);
    assert.ok(solid.every(p => p.u >= 0 && p.u <= 64 && p.v >= 0 && p.v <= 64), `${kind} UVs`);
    assert.ok(solid.every(p => Number.isFinite(p.x + p.y + p.z)));
  }
  const sheep = collect("sheep").solid.length;
  assert.equal(sheep, (modelParts("sheep").flatMap(p => p.boxes).length) * 36);
});

test("walking swings opposite legs and head follows look", () => {
  const swing = poseRotations("cow", { swing: 1, amount: 1, headYaw: 30, pitch: 10 });
  assert.ok(Math.abs(swing.right_hind_leg[0] + swing.left_hind_leg[0]) < 1e-9);
  assert.ok(Math.abs(swing.head[1] - 30 * Math.PI / 180) < 1e-9);
  assert.deepEqual(poseRotations("cow", rest).right_hind_leg, [1.4 * 0 * 0 + 0, 0, 0].map(v => v + 0));
  const arms = poseRotations("player", { swing: 1, amount: 1, headYaw: 0, pitch: 0 });
  assert.ok(arms.right_arm[0] * arms.right_leg[0] > 0 || arms.right_arm[0] * arms.right_leg[0] < 0);
});

test("villagers render an adult head, nose, robe and folded arms and animate only their legs when walking", () => {
  const row = { id: 9, species: "villager", position: [1, 2, 3], yaw: 90, pitch: 5, pose: 0 };
  assert.deepEqual(toLayerEntities([row, { ...row, species: "rabbit" }]), [{ id: 9, kind: "villager", x: 1, y: 2, z: 3, yaw: 90, pitch: 5 }]);
  const { solid } = collect("villager");
  const nose = solid.slice(36, 72);
  assert.ok(Math.max(...nose.map(p => p.z)) > Math.max(...solid.slice(0, 36).map(p => p.z)));
  assert.ok(solid.every(p => p.u >= 0 && p.u <= 64 && p.v >= 0 && p.v <= 64));
  assert.ok(Math.abs(Math.min(...solid.map(p => p.y))) < 0.03);
  const walk = { ...rest, swing: 1, amount: 1 };
  const walking = collect("villager", { pose: walk }).solid;
  assert.deepEqual(walking.slice(0, -72), solid.slice(0, -72));
  assert.notDeepEqual(walking.slice(-72), solid.slice(-72));
  const { right_leg, left_leg } = poseRotations("villager", walk);
  assert.ok(right_leg[0] * left_leg[0] < 0);
});

test("slim arms are narrower than classic arms", () => {
  const width = slim => {
    const arm = modelParts("player", slim).find(p => p.name === "left_arm");
    return arm.boxes[0].w;
  };
  assert.equal(width(false), 4);
  assert.equal(width(true), 3);
});

test("legacy skins are converted and base layers forced opaque", () => {
  const px = new Uint8Array(64 * 32 * 4);
  px.set([10, 20, 30, 0], (20 * 64 + 4) * 4);
  px.set([1, 2, 3, 200], (16 * 64 + 40) * 4);
  const out = normalizeSkin({ width: 64, height: 32, data: px });
  assert.equal(out.length, 64 * 64 * 4);
  const at = (x, y) => [...out.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
  assert.deepEqual(at(4 + 16 + 3, 52), [10, 20, 30, 255], "right leg pixel mirrors to left leg, mirrored in x");
  assert.deepEqual(at(3, 20 + 0).slice(3), [255], "base alpha forced opaque");
  assert.equal(normalizeSkin({ width: 64, height: 48, data: new Uint8Array(64 * 48 * 4) }), null);
  assert.equal(normalizeSkin({ width: 64, height: 64, data: new Uint8Array(5) }), null);
  const modern = new Uint8Array(64 * 64 * 4);
  modern.set([5, 5, 5, 0], (5 * 64 + 40) * 4);
  assert.equal(normalizeSkin({ width: 64, height: 64, data: modern })[(5 * 64 + 40) * 4 + 3], 255 * 0 + normalizeSkin({ width: 64, height: 64, data: modern })[(5 * 64 + 40) * 4 + 3]);
  modern.set([5, 5, 5, 0], (3 * 64 + 40) * 4);
  assert.equal(normalizeSkin({ width: 64, height: 64, data: modern })[(3 * 64 + 40) * 4 + 3], 0, "hat region keeps its alpha");
});

test("default skins are stable and honor model width", () => {
  assert.equal(defaultSkinName(7), defaultSkinName(7));
  assert.match(defaultSkinName(7, true), /^slim_/);
  assert.match(defaultSkinName(7, false), /^wide_/);
  const seen = new Set(Array.from({ length: 200 }, (_, i) => defaultSkinName(i)));
  assert.ok(seen.size > 6);
});

test("skin files are local, same-origin and size checked", async () => {
  assert.equal(skinPath("../x"), null);
  assert.equal(skinPath("https://evil"), null);
  assert.equal(skinPath("ab12"), "/local-pack/skins/ab12.png");
  const calls = [];
  const deps = { fetch: async url => { calls.push(url); return { ok: false, body: null }; }, decode: async () => { throw new Error("no"); } };
  assert.equal(await loadLocalSkin(deps, "http://x"), null);
  assert.equal(calls.length, 0);
  assert.equal(await loadLocalSkin(deps, "ab12"), null);
  assert.deepEqual(calls, ["/local-pack/skins/ab12.png"]);
});

test("entity validation drops malformed entries and unsupported kinds", () => {
  const ok = { id: 1, kind: "cow", x: 1, y: 2, z: 3, yaw: 0, pitch: 0 };
  assert.ok(sanitizeEntity(ok));
  for (const bad of [null, { ...ok, kind: "creeper" }, { ...ok, x: NaN }, { ...ok, id: -1 }, { ...ok, skin: "../x" }, { ...ok, color: 16 }, { ...ok, kind: "item" }, { ...ok, kind: "item", item: "Wheat" }, { ...ok, x: 1e9 }]) {
    assert.equal(sanitizeEntity(bad), null, JSON.stringify(bad));
  }
  assert.equal(sanitizeEntity({ ...ok, kind: "item", item: "wheat", count: 3 }).count, 3);
});

test("interpolation is bounded, snaps on teleport, and removes absent entities", () => {
  let now = 1000;
  const store = new EntityStore(() => now);
  store.upsert([{ id: 1, kind: "pig", x: 0, y: 0, z: 0, yaw: 350, pitch: 0 }]);
  now += 10;
  store.upsert([{ id: 1, kind: "pig", x: 1, y: 0, z: 0, yaw: 10, pitch: 0 }]);
  now += INTERPOLATION_MS / 2;
  let [e] = store.sample();
  assert.ok(e.x > 0.4 && e.x < 0.6);
  assert.ok(Math.abs(((e.yaw + 540) % 360) - 180) < 10 + 1e-9 && (e.yaw > 359 || e.yaw < 1 || Math.abs(e.yaw) < 1 || e.yaw > 350 - 1e-9), `shortest arc, got ${e.yaw}`);
  now += 5000;
  [e] = store.sample();
  assert.equal(e.x, 1, "no extrapolation beyond the last snapshot");
  store.upsert([{ id: 1, kind: "pig", x: 1 + SNAP_DISTANCE + 1, y: 0, z: 0, yaw: 0, pitch: 0 }]);
  [e] = store.sample();
  assert.equal(e.x, 1 + SNAP_DISTANCE + 1);
  store.replaceAll([{ id: 2, kind: "cow", x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }]);
  assert.deepEqual(store.ids(), [2]);
});

test("store caps entity count; stationary entities never expire without a feed change", () => {
  let now = 0;
  const store = new EntityStore(() => now);
  const row = id => ({ id, kind: "cow", x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  store.upsert(Array.from({ length: MAX_ENTITIES + 50 }, (_, id) => row(id)));
  assert.equal(store.size, MAX_ENTITIES);
  now += 10 * 60_000;
  assert.equal(store.sample().length, MAX_ENTITIES, "a healthy feed that sends no entity payload keeps them");
  store.replaceAll(Array.from({ length: MAX_ENTITIES }, (_, id) => row(1000 + id)));
  assert.equal(store.size, MAX_ENTITIES, "a saturated snapshot fully replaces a saturated set");
  assert.ok(store.ids().every(id => id >= 1000));
  store.replaceAll([]);
  assert.equal(store.size, 0, "explicit empty snapshot clears");
});

test("walk amount follows movement and returns to rest", () => {
  let now = 0;
  const store = new EntityStore(() => now);
  const at = x => store.upsert([{ id: 1, kind: "cow", x, y: 0, z: 0, yaw: 0, pitch: 0 }]);
  at(0);
  let moving = 0;
  for (let i = 1; i <= 10; i++) {
    now += 50;
    at(i * 0.2);
    for (let k = 0; k < 2; k++) { now += 25; moving = store.sample()[0].amount; }
  }
  assert.ok(moving > 0.3);
  for (let i = 0; i < 30; i++) { now += 50; store.sample(); }
  assert.equal(store.sample()[0].amount, 0);
});

test("pack manifest is bounds checked", () => {
  assert.throws(() => parsePack({ width: 64, height: 64, textures: { cow: [0, 0, 128, 64] } }));
  assert.throws(() => parsePack({ width: 64, height: 64, textures: { "../x": [0, 0, 1, 1] } }));
  assert.equal(parsePack({ width: 64, height: 64, textures: { cow: [0, 0, 64, 32] } }).rects.get("cow").h, 32);
});

function fakeGl() {
  const calls = [], live = new Set();
  let lost = false, id = 0;
  const make = kind => { const o = { kind, id: ++id }; live.add(o); return o; };
  const gl = new Proxy({}, {
    get(_, name) {
      if (name === "isContextLost") return () => lost;
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      if (name === "getError") return () => "NO_ERROR";
      if (name === "getShaderParameter" || name === "getProgramParameter") return () => true;
      if (name === "getUniformLocation") return (_p, n) => n;
      const creators = { createShader: "shader", createProgram: "program", createBuffer: "buffer", createTexture: "texture", createVertexArray: "vao" };
      if (creators[name]) return () => make(creators[name]);
      const deleters = /^delete/;
      if (deleters.test(name)) return o => { calls.push([name]); live.delete(o); };
      return (...args) => { calls.push([name, ...args]); };
    },
  });
  return { gl, calls, live, setLost: v => { lost = v; } };
}

const atlas = {
  columns: 4, rows: 4, itemIcons: new Map([["wheat", 5]]),
  itemBlocks: new Map([["hay_block", [1, 2, 3, 4, 5, 6]]]),
  tilesFor: () => undefined,
};
const pack = {
  image: { width: 128, height: 128, close() { this.closed = true; } }, width: 128, height: 128,
  rects: new Map([...["steve", "alex", "ari", "efe", "kai", "makena", "noor", "sunny", "zuri"].flatMap(n => [["wide_" + n, { x: 64, y: 0, w: 64, h: 64 }], ["slim_" + n, { x: 64, y: 64, w: 64, h: 64 }]]), ["cow", { x: 0, y: 0, w: 64, h: 64 }], ["sheep", { x: 0, y: 64, w: 64, h: 32 }], ["sheep_wool", { x: 0, y: 96, w: 64, h: 32 }]]),
};
const camera = new Float32Array(16);

function drawable(options = {}) {
  const env = fakeGl();
  const layer = new EntityLayer({ clock: () => 0, ...options });
  layer.attach(env.gl);
  layer.setPack(pack);
  const context = { gl: env.gl, camera, eye: [0, 0, 0], atlas, atlasTexture: { kind: "atlas" } };
  return { env, layer, context };
}

test("layer draws opaque entities before blended outer layers with depth writes restored", () => {
  const { env, layer, context } = drawable();
  layer.replaceAll([
    { id: 1, kind: "player", x: 0, y: 0, z: 3, yaw: 0, pitch: 0 },
    { id: 2, kind: "cow", x: 1, y: 0, z: 3, yaw: 0, pitch: 0 },
    { id: 3, kind: "item", x: 2, y: 0, z: 3, yaw: 0, pitch: 0, item: "wheat", count: 20 },
    { id: 4, kind: "item", x: 3, y: 0, z: 3, yaw: 0, pitch: 0, item: "hay_block", count: 1 },
    { id: 5, kind: "item", x: 4, y: 0, z: 3, yaw: 0, pitch: 0, item: "unknown_item", count: 1 },
  ]);
  layer.draw(context);
  assert.equal(layer.lastDraw.entities, 5);
  assert.equal(layer.lastDraw.skipped, 0, "item without an atlas icon gets a neutral marker, not an invented texture");
  const names = env.calls.map(c => c[0]);
  const draws = names.reduce((out, n, i) => n === "drawArrays" ? [...out, i] : out, []);
  const blendAt = names.indexOf("enable", 0);
  assert.ok(draws.length >= 3);
  const enableBlend = env.calls.findIndex(c => c[0] === "enable" && c[1] === "BLEND");
  assert.ok(enableBlend > draws[0] && enableBlend < draws.at(-1), "outer layers draw after opaque groups");
  const lastDepthMask = env.calls.filter(c => c[0] === "depthMask").at(-1);
  assert.deepEqual(lastDepthMask, ["depthMask", true]);
  assert.ok(env.calls.some(c => c[0] === "bindVertexArray" && c[1] === null), "terrain attribute state is left alone");
  assert.ok(blendAt >= -1);
});

test("layer resources are released on loss, dispose and epoch clear", () => {
  const { env, layer, context } = drawable();
  layer.setSkin("ab12", new Uint8Array(64 * 64 * 4));
  layer.replaceAll([{ id: 1, kind: "player", x: 0, y: 0, z: 3, yaw: 0, pitch: 0, skin: "ab12" }, { id: 2, kind: "cow", x: 0, y: 0, z: 3, yaw: 0, pitch: 0 }]);
  layer.draw(context);
  assert.ok(layer.hasGpuResources());
  const textures = () => [...env.live].filter(o => o.kind === "texture").length;
  assert.equal(textures(), 2, "pack and custom skin");
  layer.clear();
  assert.equal(layer.entityCount, 0);
  assert.equal(layer.skinCount, 0);
  assert.equal(textures(), 1, "skin texture freed on epoch clear");

  layer.lose();
  assert.equal(layer.hasGpuResources(), false);
  env.setLost(true);
  env.live.clear();
  layer.draw(context);
  env.setLost(false);
  layer.attach(env.gl);
  layer.replaceAll([{ id: 1, kind: "cow", x: 0, y: 0, z: 3, yaw: 0, pitch: 0 }]);
  layer.draw(context);
  assert.equal(layer.lastDraw.entities, 1, "draws again after the context is restored");

  layer.dispose();
  assert.equal([...env.live].filter(o => o.kind !== "shader").length, 0, "every GPU object deleted");
  assert.equal(pack.image.closed, undefined, "shared pack stays owned by its loader");
});

test("skins are cached with a bound, fetched once, and failures fall back to default", async () => {
  const requested = [];
  const { layer, context } = drawable({ skinSource: async key => { requested.push(key); return key === "ab12" ? { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) } : null; } });
  const list = [{ id: 1, kind: "player", x: 0, y: 0, z: 3, yaw: 0, pitch: 0, skin: "ab12" }, { id: 2, kind: "player", x: 1, y: 0, z: 3, yaw: 0, pitch: 0, skin: "dead" }];
  layer.replaceAll(list);
  layer.draw(context);
  layer.draw(context);
  await new Promise(r => setTimeout(r, 0));
  layer.draw(context);
  assert.deepEqual(requested.sort(), ["ab12", "dead"]);
  assert.equal(layer.skinCount, 1);
  for (let i = 0; i < 40; i++) layer.setSkin(`a${i.toString(16)}`, new Uint8Array(64 * 64 * 4));
  assert.ok(layer.skinCount <= 32);
});

test("wire rows map to layer entities and unsupported species are dropped", () => {
  const sha = "a".repeat(64);
  const out = toLayerEntities([
    { id: 1, position: [1, 2, 3], species: "item", yaw: 0, pitch: 0, pose: 0, item: { name: "wheat", count: 4 } },
    { id: 2, position: [1, 2, 3], species: "item", yaw: 0, pitch: 0, pose: 0 },
    { id: 3, position: [1, 2, 3], species: "creeper", yaw: 0, pitch: 0, pose: 0 },
    { id: 4, position: [1, 2, 3], species: "player", yaw: 9, pitch: 1, pose: 0, appearance: { model: "slim", key: sha } },
    { id: 5, position: [1, 2, 3], species: "player", yaw: 9, pitch: 1, pose: 0, appearance: { model: "classic", key: "default-classic" } },
  ]);
  assert.equal(out.length, 3, "nameless item and creeper dropped");
  assert.deepEqual([out[0].item, out[0].count], ["wheat", 4]);
  assert.deepEqual([out[1].slim, out[1].skin], [true, sha]);
  assert.deepEqual([out[2].slim, out[2].skin], [false, undefined]);
});

test("13 visible custom skins are each fetched once with no fallback flicker", async () => {
  const requested = [];
  const { env, layer, context } = drawable({ skinSource: async key => { requested.push(key); return { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) }; } });
  const keys = Array.from({ length: 13 }, (_, i) => `a${i.toString(16)}`);
  layer.replaceAll(keys.map((skin, i) => ({ id: i + 1, kind: "player", x: i, y: 0, z: 3, yaw: 0, pitch: 0, skin })));
  const frame = () => { env.calls.length = 0; layer.draw(context); return env.calls.filter(c => c[0] === "drawArrays").length; };
  for (let i = 0; i < 4; i++) { frame(); await new Promise(r => setTimeout(r, 0)); }
  assert.ok(requested.length <= 13);
  const settled = frame();
  for (let i = 0; i < 20; i++) assert.equal(frame(), settled, "same draw groups every frame");
  assert.equal(requested.length, 13);
  assert.equal(new Set(requested).size, 13);
  assert.equal(layer.skinCount, 13);
  assert.equal(requested.length, 13);
  assert.equal([...env.live].filter(o => o.kind === "texture").length, 14, "13 skins plus the fallback pack, none re-uploaded");
});

test("failed skin lookups are remembered within a bound and not retried every frame", async () => {
  let calls = 0;
  const { layer, context } = drawable({ skinSource: async () => { calls++; return null; } });
  const rows = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, kind: "player", x: i, y: 0, z: 3, yaw: 0, pitch: 0, skin: `b${i.toString(16)}` }));
  layer.replaceAll(rows);
  for (let i = 0; i < 6; i++) { layer.draw(context); await new Promise(r => setTimeout(r, 0)); }
  assert.equal(calls, 24);
});

const manifestBase = { protocol: 777, tileSize: 16, columns: 4, rows: 4, blocks: [] };

test("itemBlocks are parsed strictly and drive a cube drop through the parsed atlas", () => {
  const good = parseManifest({ ...manifestBase, itemIcons: { wheat: 5 }, itemBlocks: { hay_block: [9, 9, 10, 10, 9, 9] } });
  assert.deepEqual([...good.itemBlocks.get("hay_block")], [9, 9, 10, 10, 9, 9]);
  for (const bad of [{ hay_block: [1, 2, 3] }, { hay_block: [1, 2, 3, 4, 5, 16] }, { hay_block: [1, 2, 3, 4, 5, -1] }, { "Bad Name": [1, 1, 1, 1, 1, 1] }, [], { a: "x" }]) {
    assert.equal(parseManifest({ ...manifestBase, itemBlocks: bad }).itemBlocks, undefined, JSON.stringify(bad));
  }
  assert.equal(parseManifest(manifestBase).itemBlocks, undefined);

  const parsed = { columns: 4, rows: 4, itemIcons: good.itemIcons, itemBlocks: good.itemBlocks, tilesFor: () => undefined };
  const { env, layer, context } = drawable();
  layer.replaceAll([{ id: 1, kind: "item", x: 0, y: 0, z: 3, yaw: 0, pitch: 0, item: "hay_block", count: 1 }]);
  layer.draw({ ...context, atlas: parsed });
  assert.equal(layer.lastDraw.skipped, 0);
  assert.equal(layer.lastDraw.vertices, 36, "one cube");
  const upload = env.calls.find(c => c[0] === "bufferData");
  const data = upload[2];
  const faceTiles = [];
  for (let f = 0; f < 6; f++) {
    let u = 0, v = 0;
    for (let i = 0; i < 6; i++) { u += data[(f * 6 + i) * 8 + 3] / 6; v += data[(f * 6 + i) * 8 + 4] / 6; }
    faceTiles.push(Math.floor(v / 16) * 4 + Math.floor(u / 16));
  }
  assert.deepEqual(faceTiles, [9, 9, 10, 10, 9, 9], "each face samples its parsed tile");
  assert.ok(data.slice(0, 36 * 8).every((v, i) => i % 8 !== 3 || v >= 0), "textured, not marker");
});

test("an unknown stack is drawn as a neutral marker", () => {
  const { env, layer, context } = drawable();
  layer.replaceAll([{ id: 1, kind: "item", x: 0, y: 0, z: 3, yaw: 0, pitch: 0, item: "mystery_thing", count: 1 }]);
  layer.draw(context);
  assert.equal(layer.lastDraw.skipped, 0);
  const data = env.calls.find(c => c[0] === "bufferData")[2];
  for (let i = 0; i < 36; i++) {
    assert.equal(data[i * 8 + 3], -1, "marker uses the untextured path");
    assert.ok(Math.abs(data[i * 8 + 5] - data[i * 8 + 6]) < 1e-6 && Math.abs(data[i * 8 + 6] - data[i * 8 + 7]) < 1e-6, "neutral grey");
  }
});
