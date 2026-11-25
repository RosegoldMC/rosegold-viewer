import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../scripts/load-for-test.mjs";

const { TerrainRenderer } = load("renderer");

function fakeCanvas(t) {
  const frames = new Map(), uploads = [], draws = [], deleted = [], enabled = new Set();
  const uniforms = [], offsets = [], blends = [], pointers = [], attribs = new Set(), scales = [], sources = [];
  const liquidFrames = [], timers = new Map();
  let nextTimer = 0;
  let nextFrame = 0, depthWrite = true, lost = false, bound, depthFunc = "LESS";
  const gl = {
    drawingBufferWidth: 320, drawingBufferHeight: 240,
    COLOR_BUFFER_BIT: 1, DEPTH_BUFFER_BIT: 2,
    createShader: () => ({}), shaderSource: (_, source) => sources.push(source), uniform1f: (location, value) => { if (location === "u_positionScale") scales.push(value); }, createProgram: () => ({}), createBuffer: () => ({}),
    getShaderParameter: () => true, getProgramParameter: () => true, getUniformLocation: (_, name) => name,
    isContextLost: () => lost,
    enable: cap => enabled.add(cap), disable: cap => enabled.delete(cap),
    depthFunc: f => { depthFunc = f; }, polygonOffset: () => {}, blendFunc: (...args) => blends.push(args),
    bindBuffer: (_, buffer) => { bound = buffer; },
    deleteBuffer: buffer => deleted.push(buffer),
    bufferData: (_, data) => uploads.push({ buffer: bound, data: data.slice() }),
    depthMask: value => { depthWrite = value; },
    createTexture: () => ({}), deleteTexture: () => {}, getError: () => 0, NO_ERROR: 0,
    uniform1i: (_, value) => uniforms.push(value),
    vertexAttribPointer: (index, size, type, normalized, stride, offset) => pointers.push([index, size, stride, offset, type, normalized]),
    enableVertexAttribArray: index => attribs.add(index),
    disableVertexAttribArray: index => attribs.delete(index),
    drawArrays: (mode, first, count) => draws.push([mode, first, count, enabled.has(gl.DEPTH_TEST), depthWrite, mode === "TRIANGLES" ? uniforms.at(-1) : uniforms.at(-1), attribs.has(2), enabled.has("BLEND"), depthFunc, enabled.has("POLYGON_OFFSET_FILL"), scales.at(-1)]),
  };
  for (const name of "TEXTURE_2D TEXTURE0 RGBA UNSIGNED_BYTE NEAREST CLAMP_TO_EDGE TEXTURE_MIN_FILTER TEXTURE_MAG_FILTER TEXTURE_WRAP_S TEXTURE_WRAP_T UNPACK_FLIP_Y_WEBGL UNPACK_PREMULTIPLY_ALPHA_WEBGL VERTEX_SHADER FRAGMENT_SHADER COMPILE_STATUS LINK_STATUS CULL_FACE DEPTH_TEST ARRAY_BUFFER STATIC_DRAW DYNAMIC_DRAW UNSIGNED_BYTE FLOAT SHORT TRIANGLES LINE_STRIP POINTS BLEND POLYGON_OFFSET_FILL LEQUAL LESS SRC_ALPHA ONE_MINUS_SRC_ALPHA".split(" ")) gl[name] = name;
  for (const name of "activeTexture bindTexture pixelStorei texImage2D texParameteri compileShader deleteShader attachShader linkProgram detachShader deleteProgram useProgram clearColor clear viewport uniformMatrix4fv".split(" ")) gl[name] = () => {};
  gl.uniform2f = () => {};
  gl.uniform3f = (_, x, y, z) => offsets.push([x, y, z]);
  gl.uniform4fv = (name, frames) => { if (name === "u_liquidFrames[0]") liquidFrames.push([...frames]); };
  const window = Object.assign(new EventTarget(), {
    devicePixelRatio: 1,
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  });
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
    canvas, uploads, deleted, offsets, blends, enabledAttribs: () => attribs, enabledCaps: () => enabled, get depthWrite() { return depthWrite; }, scales, sources, get depthFunc() { return depthFunc; }, frames, uniforms, pointers, liquidFrames, timers,
    setLost(value) {
      lost = value;
      canvas.dispatchEvent(new Event(value ? "webglcontextlost" : "webglcontextrestored", { cancelable: true }));
    },
    draw(now = 0) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(now));
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
  assert.deepEqual(scene.draw().map(d => d.slice(0, 5)), [["TRIANGLES", 0, 36, true, true]]);
  const previous = scene.uploads[0].buffer;

  renderer.removeSection(position);
  assert.equal(scene.frames.size, 1);
  assert.deepEqual(scene.draw(), []);
  assert.deepEqual(scene.deleted, [previous]);
  assert.equal(scene.uploads.length, 1);

  renderer.replaceSection(position, states);
  assert.deepEqual(scene.draw().map(d => d.slice(0, 5)), [["TRIANGLES", 0, 36, true, true]]);
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
  assert.deepEqual(scene.draw().map(d => d.slice(0, 5)), modes);
  const initial = scene.uploads.at(-1);
  assert.deepEqual([...initial.data], [1 / 256, 0, 3, 1, 0, 1, 2 / 256, 0, 5, 1, 0, 1, 0, 1, 4, 0, 1, 0]);

  scene.setLost(true);
  renderer.setPose([x + 1 / 256, 2, 1], [0, 0, 1], 0);
  assert.equal(scene.frames.size, 0);
  scene.setLost(false);
  assert.deepEqual(statuses, ["ready", "lost", "ready"]);
  assert.deepEqual(scene.draw().map(d => d.slice(0, 5)), modes);
  const restored = scene.uploads.at(-1);
  assert.notEqual(restored.buffer, initial.buffer);
  assert.equal(restored.data[0], 0);
  assert.equal(restored.data[6], 1 / 256);

  renderer.setPaths([]);
  assert.deepEqual(scene.draw().map(d => d.slice(0, 5)), [modes[0]]);
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

test("textured mode is reported only after upload; overlays stay untextured; context restore re-uploads", t => {
  const scene = fakeCanvas(t);
  const flags = [];
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0], onTextureStatus: v => flags.push(v) });
  const states = new Uint16Array(4096);
  states[0] = 1;
  const atlas = { image: {}, columns: 2, rows: 1, tilesFor: state => state === 1 ? [0, 1, -1, -1, 0, 1] : undefined };
  renderer.setPose([2, 2, 2], [0, 0, 1], 0);
  renderer.replaceSection([0, 0, 0], states);
  renderer.setPaths([{ name: "p", color: 0xffffff, points: [[1, 1, 1], [2, 2, 2]] }]);
  assert.deepEqual(flags, []);
  renderer.setAtlas(atlas);
  assert.deepEqual(flags, [true]);
  const draws = scene.draw();
  assert.equal(draws[0][5], 1);
  assert.equal(draws[1][5], 0, "path overlay is untextured");
  assert.equal(scene.pointers.some(([index]) => index >= 2), true);
  const texturedMesh = scene.uploads.find(u => u.data.length === 504).data;
  assert.deepEqual([...texturedMesh.subarray(11, 13)], [0, 0]);
  scene.setLost(true);
  assert.deepEqual(flags, [true, false]);
  scene.setLost(false);
  assert.deepEqual(flags, [true, false, true]);
  renderer.dispose();
});

test("draws texture-pack crack overlay only for a present solid block with a valid stage", t => {
  const scene = fakeCanvas(t);
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0] });
  const states = new Uint16Array(4096);
  states[0] = 1;
  const stages = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const atlas = { image: {}, columns: 5, rows: 2, breakStages: stages, tilesFor: () => [0, 0, 0, 0, 0, 0] };
  const x = 100_000_000.5;
  renderer.setPose([2, 2, 2], [0, 0, 1], 0);
  renderer.replaceSection([0, 0, 0], states);
  const overlays = () => scene.draw().filter(d => d[7] === true);

  renderer.setBreaking({ position: [0, 0, 0], stage: 3 });
  assert.deepEqual(overlays(), [], "untextured keeps fallback");
  renderer.setAtlas(atlas);
  let draws = scene.draw();
  assert.equal(draws.length, 2);
  assert.deepEqual(draws[1].slice(0, 5), ["TRIANGLES", 0, 36, true, false]);
  assert.equal(draws[1][8], "LEQUAL");
  assert.equal(draws[1][9], true);
  assert.equal(scene.depthFunc, "LESS", "depth func restored");
  const upload = scene.uploads.at(-1).data;
  assert.equal(upload.length, 360);
  assert.deepEqual([...upload.subarray(0, 3)], [-1, -2, -2]);
  assert.deepEqual([upload[8], upload[9]], [3, 0]);
  const buffer = scene.uploads.at(-1).buffer;

  renderer.setBreaking({ position: [0, 0, 0], stage: 9 });
  scene.draw();
  assert.deepEqual([scene.uploads.at(-1).data[8], scene.uploads.at(-1).data[9]], [4, 1], "stage switch");
  assert.equal(scene.uploads.at(-1).buffer, buffer);
  renderer.setBreaking({ position: [5, 0, 0], stage: 9 });
  assert.equal(overlays().length, 0, "no solid cell");
  renderer.setBreaking({ position: [0, 0, 0], stage: 1 });
  assert.equal(overlays().length, 1);
  renderer.setBreaking(null);
  assert.equal(overlays().length, 0);
  assert.throws(() => renderer.setBreaking({ position: [0.5, 0, 0], stage: 0 }), RangeError);
  assert.throws(() => renderer.setBreaking({ position: [0, 0, 0], stage: 10 }), RangeError);

  renderer.setBreaking({ position: [0, 0, 0], stage: 1 });
  renderer.setAtlas({ ...atlas, breakStages: undefined });
  assert.ok(scene.deleted.includes(buffer), "released on texture replacement");
  assert.equal(overlays().length, 0, "missing stages silent");
  renderer.setAtlas(atlas);
  scene.setLost(true);
  scene.setLost(false);
  assert.equal(overlays().length, 1, "target survives context restore");
  renderer.clear();
  renderer.replaceSection([0, 0, 0], states);
  renderer.setPose([2, 2, 2], [0, 0, 1], 0);
  assert.equal(overlays().length, 0, "clear resets target");
  renderer.dispose();
});

test("reports whether the pack crack overlay is actually drawn", t => {
  const scene = fakeCanvas(t);
  const seen = [];
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0], onBreakingDrawn: v => seen.push(v) });
  const states = new Uint16Array(4096);
  states[0] = 1;
  const atlas = { image: {}, columns: 5, rows: 2, breakStages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], tilesFor: () => [0, 0, 0, 0, 0, 0] };
  renderer.setBreaking({ position: [0, 0, 0], stage: 1 });
  renderer.setAtlas(atlas);
  assert.deepEqual(seen, [], "nothing reported before a draw");
  renderer.replaceSection([0, 0, 0], states);
  renderer.setPose([2, 2, 2], [0, 0, 1], 0);
  scene.draw();
  assert.deepEqual(seen, [true]);
  renderer.setBreaking({ position: [7, 0, 0], stage: 1 });
  scene.draw();
  assert.deepEqual(seen, [true, false], "skipped target");
  renderer.setBreaking({ position: [0, 0, 0], stage: 1 });
  scene.draw();
  scene.setLost(true);
  assert.deepEqual(seen, [true, false, true, false], "loss clears");
  scene.setLost(false);
  scene.draw();
  assert.equal(seen.at(-1), true);
  renderer.setAtlas({ ...atlas, breakStages: undefined });
  scene.draw();
  assert.equal(seen.at(-1), false, "missing stages");
  renderer.setAtlas(atlas);
  scene.draw();
  renderer.dispose();
  assert.equal(seen.at(-1), false);
});

test("crack overlay omits faces shared with solid neighbors and reports false when fully enclosed", t => {
  const scene = fakeCanvas(t);
  const seen = [];
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0], onBreakingDrawn: v => seen.push(v) });
  const index = (x, y, z) => x + 16 * (z + 16 * y);
  const states = new Uint16Array(4096);
  states[index(1, 1, 1)] = 1;
  states[index(2, 1, 1)] = 1;
  const atlas = { image: {}, columns: 5, rows: 2, breakStages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], tilesFor: () => [0, 0, 0, 0, 0, 0] };
  renderer.setPose([1.5, 1.5, 1.5], [1, 0, 0], 0);
  renderer.replaceSection([0, 0, 0], states);
  renderer.setAtlas(atlas);
  renderer.setBreaking({ position: [1, 1, 1], stage: 2 });
  const draws = scene.draw().filter(d => d[7] === true);
  assert.equal(draws[0][2], 30);
  assert.equal(scene.uploads.at(-1).data.length, 300);
  assert.deepEqual(seen, [true]);

  for (const [x, y, z] of [[0, 1, 1], [1, 0, 1], [1, 2, 1], [1, 1, 0], [1, 1, 2]]) states[index(x, y, z)] = 1;
  renderer.replaceSection([0, 0, 0], states);
  assert.equal(scene.draw().filter(d => d[7] === true).length, 0);
  assert.deepEqual(seen, [true, false]);
  renderer.dispose();
});

test("terrain positions divide by the packed scale; breaking overlay and paths stay unscaled", t => {
  const scene = fakeCanvas(t);
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0] });
  const states = new Uint16Array(4096);
  states[0] = 1;
  renderer.setPose([2, 2, 2], [0, 0, 1], 0);
  renderer.replaceSection([0, 0, 0], states);
  renderer.setAtlas({ image: {}, columns: 5, rows: 2, breakStages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], tilesFor: () => [0, 0, 0, 0, 0, 0] });
  renderer.setBreaking({ position: [0, 0, 0], stage: 1 });
  renderer.setPaths([{ name: "p", color: 0xffffff, points: [[1, 1, 1], [2, 2, 2]] }]);
  const draws = scene.draw();
  assert.deepEqual(draws.map(d => [d[0], d[7], d[10]]), [
    ["TRIANGLES", false, 32], ["TRIANGLES", true, 1], ["LINE_STRIP", false, 1], ["POINTS", false, 1],
  ]);
  const [vertex] = scene.sources;
  assert.match(vertex, /uniform float u_positionScale;/);
  assert.match(vertex, /a_position \/ u_positionScale \+ u_offset/);
  renderer.dispose();
});

test("cutout terrain discards transparent texels, legacy tiles fall back to solid color; overlay branch stays", t => {
  const scene = fakeCanvas(t);
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0] });
  const fragment = scene.sources[1];
  const terrainBranch = fragment.slice(fragment.indexOf("if (u_textured && v_tile.x < 254.5)"));
  assert.match(terrainBranch, /if \(sampled\.a < 0\.5\) \{\s+if \(v_material == 1\.0\) discard;\s+color = vec4\(v_color, 1\.0\);\s+return;\s+\}\s+color = vec4\(sampled\.rgb, 1\.0\);\s+return;\s+\}\s+color = vec4\(v_color, 1\.0\);/);
  assert.match(terrainBranch, /if \(u_water\) \{\s+if \(sampled\.a < 0\.004\) discard;\s+color = vec4\(sampled\.rgb \* vec3\(0\.247, 0\.463, 0\.894\), sampled\.a\);/);
  assert.match(fragment, /if \(!u_textured \|\| v_tile\.x > 254\.5\) discard;[\s\S]*if \(stage\.a < 0\.004\) discard;/);
  renderer.dispose();
});

test("crack overlay needs an opaque target and ignores non-opaque neighbors", t => {
  const scene = fakeCanvas(t);
  const seen = [];
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0], onBreakingDrawn: v => seen.push(v) });
  const index = (x, y, z) => x + 16 * (z + 16 * y);
  const states = new Uint16Array(4096);
  states[index(1, 1, 1)] = 1;
  states[index(2, 1, 1)] = 2;
  const models = { 1: undefined, 2: "leaves" };
  const atlas = { image: {}, columns: 5, rows: 2, breakStages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], tilesFor: () => [0, 0, 0, 0, 0, 0], modelFor: s => models[s] };
  renderer.setPose([1.5, 1.5, 1.5], [1, 0, 0], 0);
  renderer.replaceSection([0, 0, 0], states);
  renderer.setAtlas(atlas);
  renderer.setBreaking({ position: [1, 1, 1], stage: 2 });
  assert.equal(scene.draw().find(d => d[7] === true)[2], 36, "leaves neighbor does not hide the face");
  renderer.setBreaking({ position: [2, 1, 1], stage: 2 });
  assert.equal(scene.draw().filter(d => d[7] === true).length, 0, "leaves target gets no cube overlay");
  assert.equal(seen.at(-1), false);
  renderer.dispose();
});

test("terrain uses packed 14-byte short vertices with a cutout attribute that overlays and paths never see", t => {
  const scene = fakeCanvas(t);
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0] });
  const states = new Uint16Array(4096);
  states[0] = 1;
  renderer.setPose([2, 2, 2], [0, 0, 1], 0);
  renderer.replaceSection([0, 0, 0], states);
  renderer.setAtlas({ image: {}, columns: 5, rows: 2, breakStages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], tilesFor: () => [0, 0, 0, 0, 0, 0] });
  renderer.setBreaking({ position: [0, 0, 0], stage: 1 });
  renderer.setPaths([{ name: "p", color: 0xffffff, points: [[1, 1, 1], [2, 2, 2]] }]);
  scene.draw();
  const terrain = scene.pointers.slice(0, 5);
  assert.deepEqual(terrain, [
    [0, 3, 14, 0, "SHORT", false], [1, 3, 14, 6, "UNSIGNED_BYTE", true], [2, 2, 14, 9, "UNSIGNED_BYTE", false],
    [3, 2, 14, 11, "UNSIGNED_BYTE", false], [4, 1, 14, 13, "UNSIGNED_BYTE", false],
  ]);
  const later = scene.pointers.slice(5);
  assert.ok(later.every(([index, , stride]) => index !== 4 && stride !== 14), "break and path vertices stay float");
  assert.equal(scene.enabledAttribs().has(4), false, "cutout attribute is disabled after the frame");
  renderer.dispose();
});

test("water is a second blended pass: back to front, depth tested, no depth writes, state restored", t => {
  const scene = fakeCanvas(t);
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0] });
  const solid = new Uint16Array(4096), wet = new Uint16Array(4096);
  solid[0] = 1;
  wet[0] = 2;
  const atlas = {
    image: {}, columns: 5, rows: 2, breakStages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], tilesFor: () => [0, 0, 0, 0, 0, 0],
    modelFor: state => state === 2 ? "water" : undefined,
  };
  renderer.setPose([8, 8, 8], [0, 0, 1], 0);
  renderer.replaceSection([0, 0, 0], solid);
  renderer.replaceSection([0, 0, 3], wet);
  renderer.replaceSection([0, 0, 1], wet);
  renderer.setAtlas(atlas);
  renderer.setBreaking({ position: [0, 0, 0], stage: 2 });
  renderer.setPaths([{ name: "p", color: 0xffffff, points: [[1, 1, 1], [2, 2, 2]] }]);
  const draws = scene.draw();
  const kinds = draws.map(d => [d[0], d[3], d[4], d[7]]);
  assert.deepEqual(kinds, [
    ["TRIANGLES", true, true, false],
    ["TRIANGLES", true, false, true],
    ["TRIANGLES", true, false, true],
    ["TRIANGLES", true, false, true],
    ["LINE_STRIP", true, false, false],
    ["POINTS", true, false, false],
  ]);
  assert.equal(draws[1][8], "LEQUAL", "crack overlay precedes water");
  assert.equal(draws[2][5], 1);
  assert.equal(draws[2][2], draws[3][2]);
  assert.deepEqual(scene.offsets.map(o => o[2]), [-8, 0, 40, 8, 0], "far water section draws before the near one");
  assert.deepEqual(scene.blends.at(-1), ["SRC_ALPHA", "ONE_MINUS_SRC_ALPHA"]);
  assert.equal(scene.depthWrite, true);
  assert.equal(scene.enabledCaps().has("BLEND"), false);

  renderer.replaceSection([0, 0, 3], null);
  scene.draw();
  assert.ok(scene.deleted.length >= 1, "evicted water buffer is deleted");
  scene.setLost(true);
  scene.setLost(false);
  assert.equal(scene.draw().filter(d => d[7] === true && d[4] === false).length, 2, "crack and remaining water survive context restore");
  renderer.dispose();
  assert.ok(scene.deleted.length >= 4);
});

test("water draws nothing without textures or water models", t => {
  const scene = fakeCanvas(t);
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0] });
  const wet = new Uint16Array(4096);
  wet[0] = 2;
  renderer.setPose([8, 8, 8], [0, 0, 1], 0);
  renderer.replaceSection([0, 0, 0], wet);
  assert.deepEqual(scene.draw().map(d => d.slice(0, 2)), [["TRIANGLES", 0]]);
  renderer.dispose();
});

test("animates pack water and lava tiles without reuploading meshes; lava writes depth", t => {
  const scene = fakeCanvas(t);
  const renderer = new TerrainRenderer(scene.canvas, { airStateIds: [0] });
  const states = new Uint16Array(4096);
  states[0] = 2;
  states[4] = 3;
  renderer.setPose([8, 8, 8], [0, 0, 1], 0);
  renderer.setAtlas({
    image: {}, columns: 4, rows: 2,
    modelFor: state => state === 2 ? "water" : state === 3 ? "lava" : undefined,
    tilesFor: state => state === 2 ? [1, 1, 0, 0, 1, 1] : [3, 3, 2, 2, 3, 3],
    animations: { waterStill: [[0, 2], [4, 1]], waterFlow: [[1, 1], [5, 3]], lavaStill: [[2, 3], [6, 2]], lavaFlow: [[3, 4], [7, 1]] },
  });
  renderer.replaceSection([0, 0, 0], states);
  const draws = scene.draw(0);
  assert.deepEqual(draws.map(d => [d[4], d[7]]), [[true, false], [false, true]], "lava opaque, water blended");
  assert.deepEqual(scene.liquidFrames.at(-1), [0, 0, 0, 0, 1, 0, 1, 0, 2, 0, 2, 0, 3, 0, 3, 0]);
  assert.equal(scene.timers.size, 1);
  assert.equal([...scene.timers.values()][0].delay, 50);
  const uploads = scene.uploads.length;
  [...scene.timers.values()][0].callback();
  scene.draw(151);
  assert.deepEqual(scene.liquidFrames.at(-1), [0, 0, 0, 0, 1, 0, 1, 1, 2, 0, 2, 1, 3, 0, 3, 0]);
  assert.equal(scene.uploads.length, uploads);
  scene.setLost(true);
  assert.equal(scene.timers.size, 0);
  scene.setLost(false);
  scene.draw(200);
  assert.deepEqual(scene.liquidFrames.at(-1).slice(12), [3, 0, 3, 1]);
  renderer.removeSection([0, 0, 0]);
  scene.draw(201);
  assert.equal(scene.timers.size, 0);
  renderer.dispose();
});
