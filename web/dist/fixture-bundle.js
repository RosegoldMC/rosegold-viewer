(() => {
const modules = {
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
exports.Terrain = exports.VERTEX_STRIDE = exports.SECTION_VOLUME = exports.SECTION_SIZE = void 0;
exports.sectionKey = sectionKey;
exports.cellIndex = cellIndex;
exports.SECTION_SIZE = 16;
exports.SECTION_VOLUME = exports.SECTION_SIZE ** 3;
exports.VERTEX_STRIDE = 6;
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
function offset(position, [dx, dy, dz]) {
    return [position[0] + dx, position[1] + dy, position[2] + dz];
}
function sectionKey(position) {
    return position.join(",");
}
function cellIndex(x, y, z) {
    return x + exports.SECTION_SIZE * (z + exports.SECTION_SIZE * y);
}
class Terrain {
    sections = new Map();
    dirty = new Map();
    air = new Set();
    constructor(airStateIds) {
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
        for (const face of faces) {
            const neighborKey = sectionKey(offset(position, face.step));
            const neighbor = this.sections.get(neighborKey);
            if (neighbor)
                this.dirty.set(neighborKey, neighbor.position);
        }
        return true;
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
    hasSection(key) {
        return this.sections.has(key);
    }
    mesh(position) {
        const section = this.sections.get(sectionKey(position));
        if (!section)
            return null;
        const { states } = section;
        const neighbors = faces.map(face => this.sections.get(sectionKey(offset(position, face.step)))?.states);
        let vertices = new Uint8Array(1024);
        let length = 0;
        for (let y = 0; y < exports.SECTION_SIZE; y++) {
            for (let z = 0; z < exports.SECTION_SIZE; z++) {
                for (let x = 0; x < exports.SECTION_SIZE; x++) {
                    const state = states[cellIndex(x, y, z)];
                    if (this.air.has(state))
                        continue;
                    let color;
                    for (let f = 0; f < faces.length; f++) {
                        const { step: [dx, dy, dz], corners } = faces[f];
                        const nx = x + dx, ny = y + dy, nz = z + dz;
                        const outside = nx < 0 || ny < 0 || nz < 0 || nx === exports.SECTION_SIZE || ny === exports.SECTION_SIZE || nz === exports.SECTION_SIZE;
                        const adjacent = outside
                            ? neighbors[f]?.[cellIndex(nx & SECTION_MASK, ny & SECTION_MASK, nz & SECTION_MASK)]
                            : states[cellIndex(nx, ny, nz)];
                        if (adjacent !== undefined && !this.air.has(adjacent))
                            continue;
                        if (length + triangles.length * exports.VERTEX_STRIDE > vertices.length) {
                            const larger = new Uint8Array(vertices.length * 2);
                            larger.set(vertices);
                            vertices = larger;
                        }
                        color ??= stateColor(state);
                        for (const i of triangles) {
                            vertices[length++] = x + corners[i];
                            vertices[length++] = y + corners[i + 1];
                            vertices[length++] = z + corners[i + 2];
                            vertices[length++] = color[0];
                            vertices[length++] = color[1];
                            vertices[length++] = color[2];
                        }
                    }
                }
            }
        }
        return length ? vertices.subarray(0, length) : null;
    }
}
exports.Terrain = Terrain;
  },
  "./renderer.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerrainRenderer = void 0;
const camera_js_1 = require("./camera.js");
const terrain_js_1 = require("./terrain.js");
const pathVertexStride = 6 * Float32Array.BYTES_PER_ELEMENT;
const vertexSource = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
uniform mat4 u_camera;
uniform vec3 u_offset;
out vec3 v_color;
void main() {
  gl_Position = u_camera * vec4(a_position + u_offset, 1.0);
  gl_PointSize = 7.0;
  v_color = a_color;
}`;
const fragmentSource = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 color;
void main() {
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
        if (camera && offset)
            return { program, camera, offset };
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
    resizeObserver;
    pipeline = null;
    pose = null;
    paths = [];
    pathVertices = new Float32Array(0);
    pathBuffer = null;
    frame = null;
    disposed = false;
    constructor(canvas, options) {
        this.canvas = canvas;
        this.terrain = new terrain_js_1.Terrain(options.airStateIds);
        this.onStatus = options.onStatus;
        this.gl = openContext(canvas);
        canvas.addEventListener("webglcontextlost", this.onLost);
        canvas.addEventListener("webglcontextrestored", this.initialize);
        this.resizeObserver = new ResizeObserver(this.requestDraw);
        this.resizeObserver.observe(canvas);
        window.addEventListener("resize", this.requestDraw);
        this.initialize();
    }
    onStatus;
    replaceSection(position, states) {
        if (!this.disposed && this.terrain.replaceSection(position, states))
            this.requestDraw();
    }
    removeSection(position) {
        this.replaceSection(position, null);
    }
    setPaths(paths) {
        if (this.disposed)
            return;
        this.paths = paths.map(path => ({ ...path, points: path.points.map((p) => [p[0], p[1], p[2]]) }));
        const count = this.paths.reduce((sum, path) => sum + path.points.length, 0);
        this.pathVertices = new Float32Array(count * 6);
        this.requestDraw();
    }
    clear() {
        this.pose = null;
        this.paths = [];
        this.pathVertices = new Float32Array(0);
        this.terrain.clear();
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
        if (this.frame !== null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
        this.releaseBuffers();
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
            if (this.pathBuffer)
                this.gl.deleteBuffer(this.pathBuffer);
        }
        this.meshes.clear();
        this.pathBuffer = null;
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
    requestDraw = () => {
        if (!this.disposed && this.pipeline && this.frame === null)
            this.frame = requestAnimationFrame(this.draw);
    };
    draw = () => {
        this.frame = null;
        const { gl, pipeline, pose } = this;
        if (!gl || !pipeline || gl.isContextLost())
            return;
        for (const [key, mesh] of this.meshes) {
            if (this.terrain.hasSection(key))
                continue;
            gl.deleteBuffer(mesh.buffer);
            this.meshes.delete(key);
        }
        for (const position of this.terrain.takeDirty()) {
            const key = (0, terrain_js_1.sectionKey)(position);
            const previous = this.meshes.get(key);
            if (previous) {
                gl.deleteBuffer(previous.buffer);
                this.meshes.delete(key);
            }
            const vertices = this.terrain.mesh(position);
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
            this.meshes.set(key, { position, buffer, count: vertices.length / terrain_js_1.VERTEX_STRIDE });
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
        if (!pose || gl.drawingBufferHeight === 0)
            return;
        gl.useProgram(pipeline.program);
        gl.uniformMatrix4fv(pipeline.camera, false, (0, camera_js_1.cameraMatrix)(pose.look, gl.drawingBufferWidth / gl.drawingBufferHeight, pose.yaw));
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        for (const { position, buffer, count } of this.meshes.values()) {
            gl.uniform3f(pipeline.offset, position[0] * terrain_js_1.SECTION_SIZE - pose.eye[0], position[1] * terrain_js_1.SECTION_SIZE - pose.eye[1], position[2] * terrain_js_1.SECTION_SIZE - pose.eye[2]);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.vertexAttribPointer(0, 3, gl.UNSIGNED_BYTE, false, terrain_js_1.VERTEX_STRIDE, 0);
            gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, terrain_js_1.VERTEX_STRIDE, 3);
            gl.drawArrays(gl.TRIANGLES, 0, count);
        }
        this.drawPaths(gl, pipeline, pose.eye);
        gl.disableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    };
}
exports.TerrainRenderer = TerrainRenderer;
  },
  "./fixture.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const renderer_js_1 = require("./renderer.js");
const terrain_js_1 = require("./terrain.js");
const canvas = document.querySelector("canvas");
const status = document.querySelector("output");
const labels = {
    ready: "Fixture ready",
    lost: "WebGL2 context lost; waiting for recovery",
    unavailable: "WebGL2 unavailable",
};
function fixtureState(x, y, z) {
    const canyon = Math.abs(x + Math.floor(z / 4) - 4);
    const ridge = Math.floor(Math.min(27, canyon) / 3);
    const steps = Math.floor((z + 16) / 8);
    const top = -4 + ridge + steps;
    const archDistance = Math.abs(x + 2);
    if (z >= 18 && z <= 20 && archDistance <= 8 && y <= 10) {
        if (archDistance >= 6 || y >= 8)
            return y >= 8 ? 5 : 3;
    }
    if (x >= -14 && x <= -10 && z >= 29 && z <= 33 && y <= 15) {
        return y >= 14 ? 7 : 6;
    }
    if (x >= 16 && x <= 19 && z >= 8 && z <= 11 && y === top + 1)
        return 5;
    if (y > top)
        return 0;
    if (canyon <= 2 && y === top)
        return 4;
    if (y === top)
        return ridge >= 6 ? 3 : 1;
    return y >= top - 2 ? 3 : 2;
}
const renderer = new renderer_js_1.TerrainRenderer(canvas, {
    airStateIds: [0],
    onStatus(next) {
        status.value = labels[next];
        status.dataset.state = next;
    },
});
for (let sy = -1; sy <= 0; sy++) {
    for (let sz = -1; sz <= 2; sz++) {
        for (let sx = -2; sx <= 1; sx++) {
            const states = new Uint16Array(terrain_js_1.SECTION_VOLUME);
            for (let y = 0; y < terrain_js_1.SECTION_SIZE; y++) {
                for (let z = 0; z < terrain_js_1.SECTION_SIZE; z++) {
                    for (let x = 0; x < terrain_js_1.SECTION_SIZE; x++) {
                        states[(0, terrain_js_1.cellIndex)(x, y, z)] = fixtureState(x + sx * terrain_js_1.SECTION_SIZE, y + sy * terrain_js_1.SECTION_SIZE, z + sz * terrain_js_1.SECTION_SIZE);
                    }
                }
            }
            renderer.replaceSection([sx, sy, sz], states);
        }
    }
}
renderer.setPaths([{
        name: "canyon",
        color: 0x54F4FF,
        points: [[10.5, 6, 4.5], [7.5, 5, 8.5], [5.5, 5, 13.5], [3.5, 4, 17.5],
            [2.5, 4.5, 23.5], [0.5, 5.5, 29.5], [-4.5, 6.5, 35.5], [-8.5, 6.5, 40.5]],
    }]);
renderer.setPose([12.5, 17.5, -4.5], [-0.34, -0.35, 1], Math.atan2(0.34, 1) * 180 / Math.PI);
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
require("./fixture.js");
})();
