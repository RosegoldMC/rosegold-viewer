import assert from "node:assert/strict";
import test from "node:test";
import { TerrainRenderer } from "../dist/renderer.js";

function fakeCanvas(t) {
  const frames = new Map(), uploads = [], draws = [], deleted = [], enabled = new Set();
  let nextFrame = 0, depthWrite = true, lost = false, bound;
  const gl = {
    drawingBufferWidth: 320, drawingBufferHeight: 240,
    COLOR_BUFFER_BIT: 1, DEPTH_BUFFER_BIT: 2,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    getShaderParameter: () => true, getProgramParameter: () => true, getUniformLocation: () => ({}),
    isContextLost: () => lost,
    enable: cap => enabled.add(cap),
    bindBuffer: (_, buffer) => { bound = buffer; },
    deleteBuffer: buffer => deleted.push(buffer),
    bufferData: (_, data) => uploads.push({ buffer: bound, data: data.slice() }),
    depthMask: value => { depthWrite = value; },
    drawArrays: (mode, first, count) => draws.push([mode, first, count, enabled.has(gl.DEPTH_TEST), depthWrite]),
  };
  for (const name of "VERTEX_SHADER FRAGMENT_SHADER COMPILE_STATUS LINK_STATUS CULL_FACE DEPTH_TEST ARRAY_BUFFER STATIC_DRAW DYNAMIC_DRAW UNSIGNED_BYTE FLOAT TRIANGLES LINE_STRIP POINTS".split(" ")) gl[name] = name;
  for (const name of "shaderSource compileShader deleteShader attachShader linkProgram detachShader deleteProgram useProgram clearColor clear viewport uniformMatrix4fv uniform3f enableVertexAttribArray disableVertexAttribArray vertexAttribPointer".split(" ")) gl[name] = () => {};
  const window = Object.assign(new EventTarget(), { devicePixelRatio: 1 });
  const globals = {
    window,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  const canvas = Object.assign(new EventTarget(), { clientWidth: 320, clientHeight: 240, getContext: () => gl });
  return {
    canvas, uploads, deleted, frames,
    setLost(value) {
      lost = value;
      canvas.dispatchEvent(new Event(value ? "webglcontextlost" : "webglcontextrestored", { cancelable: true }));
    },
    draw() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback());
      assert.equal(depthWrite, true, "restores writes for subsequent terrain and depth clears");
      assert.equal(bound, null);
      return draws.splice(0);
    },
  };
}

test("deletes evicted terrain buffers and rebuilds sections loaded again", t => {
  const scene = fakeCanvas(t);
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0] });
  const position = [0, 0, 0];
  const states = new Uint16Array(4096);
  states[0] = 1;
  renderer.setPose([2, 2, 2], [0, 0, 1], 0);
  renderer.replaceSection(position, states);
  assert.deepEqual(scene.draw(), [["TRIANGLES", 0, 36, true, true]]);
  const previous = scene.uploads[0].buffer;

  renderer.removeSection(position);
  assert.equal(scene.frames.size, 1);
  assert.deepEqual(scene.draw(), []);
  assert.deepEqual(scene.deleted, [previous]);
  assert.equal(scene.uploads.length, 1);

  renderer.replaceSection(position, states);
  assert.deepEqual(scene.draw(), [["TRIANGLES", 0, 36, true, true]]);
  assert.equal(scene.uploads.length, 2);
  assert.notEqual(scene.uploads[1].buffer, previous);
  renderer.dispose();
});

test("draws detached eye-relative paths after terrain, preserves them on context restore, and releases them", t => {
  const scene = fakeCanvas(t);
  const statuses = [];
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0], onStatus: status => statuses.push(status) });
  const states = new Uint16Array(4096);
  states[0] = 1;
  renderer.replaceSection([1_874_999, 0, 0], states);
  const x = 29_999_984.5;
  renderer.setPose([x, 2, 1], [0, 0, 1], 0);
  const points = [[x + 1 / 256, 2, 4], [x + 2 / 256, 2, 6]];
  const paths = [{ name: "route", color: 0xFF00FF, points }, { name: "marker", color: 0x00FF00, points: [[x, 3, 5]] }];
  renderer.setPaths(paths);
  points[0][0] = 0;
  paths.pop();

  const modes = [
    ["TRIANGLES", 0, 36, true, true],
    ["LINE_STRIP", 0, 2, true, false],
    ["POINTS", 0, 3, true, false],
  ];
  assert.deepEqual(scene.draw(), modes);
  const initial = scene.uploads.at(-1);
  assert.deepEqual([...initial.data], [1 / 256, 0, 3, 1, 0, 1, 2 / 256, 0, 5, 1, 0, 1, 0, 1, 4, 0, 1, 0]);

  scene.setLost(true);
  renderer.setPose([x + 1 / 256, 2, 1], [0, 0, 1], 0);
  assert.equal(scene.frames.size, 0);
  scene.setLost(false);
  assert.deepEqual(statuses, ["ready", "lost", "ready"]);
  assert.deepEqual(scene.draw(), modes);
  const restored = scene.uploads.at(-1);
  assert.notEqual(restored.buffer, initial.buffer);
  assert.equal(restored.data[0], 0);
  assert.equal(restored.data[6], 1 / 256);

  renderer.setPaths([]);
  assert.deepEqual(scene.draw(), [modes[0]]);
  renderer.setPaths(paths);
  assert.equal(scene.draw().at(-1)[0], "POINTS");
  renderer.clear();
  assert.ok(scene.deleted.includes(restored.buffer));
  renderer.setPose([x, 2, 1], [0, 0, 1], 0);
  assert.deepEqual(scene.draw(), []);

  renderer.setPaths(paths);
  scene.draw();
  const last = scene.uploads.at(-1).buffer;
  renderer.dispose();
  assert.ok(scene.deleted.includes(last));
  assert.equal(scene.frames.size, 0);
});
