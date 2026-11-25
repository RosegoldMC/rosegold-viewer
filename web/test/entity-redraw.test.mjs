import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../scripts/load-for-test.mjs";

const { createEntitySink } = load("entity-glue");
const { TerrainRenderer } = load("renderer");

function harness(t) {
  const frames = new Map(), draws = [];
  let next = 0;
  const numbers = { drawingBufferWidth: 320, drawingBufferHeight: 240 };
  const gl = new Proxy({}, {
    get(_, name) {
      if (name in numbers) return numbers[name];
      if (name === "isContextLost") return () => false;
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      if (name === "getError") return () => "NO_ERROR";
      if (name === "getShaderParameter" || name === "getProgramParameter") return () => true;
      if (name === "getUniformLocation") return (_p, n) => n;
      if (/^create/.test(name)) return () => ({});
      if (name === "drawArrays") return (...a) => draws.push(a);
      return () => {};
    },
  });
  const globals = {
    window: Object.assign(new EventTarget(), { devicePixelRatio: 1 }),
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: cb => { frames.set(++next, cb); return next; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  const canvas = Object.assign(new EventTarget(), { clientWidth: 320, clientHeight: 240, getContext: () => gl });
  const pump = () => { let n = 0; while (frames.size && n++ < 50) { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb()); } return n; };
  return { canvas, frames, draws, pump };
}

const pack = {
  image: {}, width: 64, height: 64,
  rects: new Map([["cow", { x: 0, y: 0, w: 64, h: 64 }]]),
};
const row = (id, x = 0) => ({ id, position: [x, 0, 3], species: "cow", yaw: 0, pitch: 0, pose: 0 });

test("a static scene wakes for the first entity, redraws empty on removal, then goes idle", async t => {
  const h = harness(t);
  const renderer = new TerrainRenderer(h.canvas, { airStateIds: [0] });
  const sink = createEntitySink(renderer, async () => pack);
  await new Promise(r => setTimeout(r, 0));
  renderer.setPose([0, 1, 0], [0, 0, 1], 0);
  h.pump();
  assert.equal(h.frames.size, 0, "empty scene is idle");
  h.draws.length = 0;

  sink.replaceAll([row(1)]);
  assert.equal(h.frames.size, 1, "entity-only batch schedules a frame with an unchanged camera");
  h.pump();
  assert.ok(h.draws.length > 0, "the cow was drawn");
  assert.equal(h.frames.size, 1, "animation loop continues while entities exist");

  sink.replaceAll([]);
  h.draws.length = 0;
  h.pump();
  assert.equal(h.draws.length, 0, "empty snapshot draws no entities");
  assert.equal(h.frames.size, 0, "idle again with nothing animating");

  sink.replaceAll([row(2)]);
  assert.equal(h.frames.size, 1, "wakes again after being idle");
  h.pump();
  sink.replaceAll([]);
  h.pump();
  assert.equal(h.frames.size, 0);
  renderer.dispose();
});
