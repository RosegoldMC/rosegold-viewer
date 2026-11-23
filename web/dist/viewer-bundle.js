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
  "./wire.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SESSION_BYTES = exports.MAX_BATCH_BYTES = void 0;
exports.decodeLease = decodeLease;
exports.decodeBatch = decodeBatch;
exports.readBytes = readBytes;
const terrain_js_1 = require("./terrain.js");
exports.MAX_BATCH_BYTES = 16 * 1024;
exports.MAX_SESSION_BYTES = 256;
const maxPaths = 8;
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
    if (status !== "waiting" && status !== "unsupported" && status !== "ready")
        return invalid();
    const cursor = { epoch: unsigned(header.epoch), seq: unsigned(header.seq) };
    let batch;
    if (status === "ready") {
        const yaw = header.yaw;
        if (typeof yaw !== "number" || !Number.isFinite(yaw))
            return invalid();
        batch = { ...cursor, status, yaw };
        if (header.paths !== undefined)
            batch.paths = decodePaths(header.paths);
    }
    else {
        if (header.paths !== undefined)
            return invalid();
        batch = { ...cursor, status };
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
        try {
            const headers = { Authorization: `Bearer ${auth.token}` };
            if (!pairing)
                headers["Content-Type"] = "application/json";
            const result = await this.request(pairing ? "/session" : "/next", {
                method: "POST", headers, body: pairing ? undefined : JSON.stringify(this.cursor),
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
    renderer = null;
    palette = null;
    hasAir = false;
    epoch = null;
    center = null;
    eye = null;
    look = null;
    pendingPaths;
    displayed = new Map();
    constructor(createRenderer) {
        this.createRenderer = createRenderer;
    }
    reset() {
        if (this.epoch !== null)
            this.renderer?.clear();
        this.epoch = null;
        this.center = this.eye = this.look = null;
        this.hasAir = false;
        this.pendingPaths = undefined;
        this.displayed.clear();
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
        if (batch.paths !== undefined)
            this.pendingPaths = batch.paths;
        if (this.hasAir && this.pendingPaths !== undefined) {
            this.renderer?.setPaths(this.pendingPaths);
            this.pendingPaths = undefined;
        }
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
  "./viewer.js": (require, exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const feed_js_1 = require("./feed.js");
const renderer_js_1 = require("./renderer.js");
const viewer_terrain_js_1 = require("./viewer-terrain.js");
const canvas = document.querySelector("canvas");
const form = document.querySelector("form");
const input = document.querySelector("#secret");
const connect = document.querySelector("#connect");
const disconnect = document.querySelector("#disconnect");
const feedStatus = document.querySelector("#feed-status");
const rendererStatus = document.querySelector("#renderer-status");
const labels = {
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
const terrain = new viewer_terrain_js_1.ViewerTerrain(air => new renderer_js_1.TerrainRenderer(canvas, {
    airStateIds: air,
    onStatus(status) {
        rendererStatus.hidden = status === "ready";
        rendererStatus.value = status === "lost" ? "WebGL2 context lost. Waiting for recovery…" : "WebGL2 unavailable";
    },
}));
const feed = new feed_js_1.ViewerFeed({
    apply: batch => terrain.apply(batch),
    reset: () => terrain.reset(),
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
