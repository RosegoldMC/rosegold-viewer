import { cameraMatrix, unitLook, type Vec3 } from "./camera.js";
import { SECTION_SIZE, Terrain, VERTEX_STRIDE, sectionKey, type SectionPosition } from "./terrain.js";

export type { SectionPosition, Vec3 };
export type RendererStatus = "ready" | "unavailable" | "lost";

export interface PathOverlay {
  readonly name: string;
  readonly color: number;
  readonly points: readonly Vec3[];
}

export interface RendererOptions {
  airStateIds: Iterable<number>;
  onStatus?: (status: RendererStatus) => void;
}

interface Pipeline {
  program: WebGLProgram;
  camera: WebGLUniformLocation;
  offset: WebGLUniformLocation;
}

interface Mesh {
  position: SectionPosition;
  buffer: WebGLBuffer;
  count: number;
}

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

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function makePipeline(gl: WebGL2RenderingContext): Pipeline | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  if (!vertex) return null;
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
  if (!program) return null;
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const camera = gl.getUniformLocation(program, "u_camera");
    const offset = gl.getUniformLocation(program, "u_offset");
    if (camera && offset) return { program, camera, offset };
  }
  gl.deleteProgram(program);
  return null;
}

function openContext(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    return canvas.getContext("webgl2", { alpha: false });
  } catch {
    return null;
  }
}

export class TerrainRenderer {
  private readonly terrain: Terrain;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly meshes = new Map<string, Mesh>();
  private readonly resizeObserver: ResizeObserver;
  private pipeline: Pipeline | null = null;
  private pose: { eye: Vec3; look: Vec3; yaw: number } | null = null;
  private paths: PathOverlay[] = [];
  private pathVertices = new Float32Array(0);
  private pathBuffer: WebGLBuffer | null = null;
  private frame: number | null = null;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement, options: RendererOptions) {
    this.terrain = new Terrain(options.airStateIds);
    this.onStatus = options.onStatus;
    this.gl = openContext(canvas);
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.initialize);
    this.resizeObserver = new ResizeObserver(this.requestDraw);
    this.resizeObserver.observe(canvas);
    window.addEventListener("resize", this.requestDraw);
    this.initialize();
  }

  private readonly onStatus: RendererOptions["onStatus"];

  replaceSection(position: SectionPosition, states: Uint16Array | null): void {
    if (!this.disposed && this.terrain.replaceSection(position, states)) this.requestDraw();
  }

  removeSection(position: SectionPosition): void {
    this.replaceSection(position, null);
  }

  setPaths(paths: readonly PathOverlay[]): void {
    if (this.disposed) return;
    this.paths = paths.map(path => ({ ...path, points: path.points.map((p): Vec3 => [p[0], p[1], p[2]]) }));
    const count = this.paths.reduce((sum, path) => sum + path.points.length, 0);
    this.pathVertices = new Float32Array(count * 6);
    this.requestDraw();
  }

  clear(): void {
    this.pose = null;
    this.paths = [];
    this.pathVertices = new Float32Array(0);
    this.terrain.clear();
    this.releaseBuffers();
    if (this.gl && !this.gl.isContextLost()) this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
    this.requestDraw();
  }

  setPose(eye: Vec3, look: Vec3, yaw: number): void {
    if (this.disposed) return;
    if (eye.length !== 3 || !eye.every(Number.isFinite)) throw new RangeError("Expected a finite eye position");
    if (!Number.isFinite(yaw)) throw new RangeError("Expected a finite yaw");
    const direction = unitLook(look);
    const current = this.pose;
    if (current?.yaw === yaw && eye.every((value, i) => value === current.eye[i] && direction[i] === current.look[i])) return;
    this.pose = { eye: [...eye], look: direction, yaw };
    this.requestDraw();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.initialize);
    window.removeEventListener("resize", this.requestDraw);
    this.resizeObserver.disconnect();
    this.stopDrawing();
    this.clear();
  }

  private initialize = (): void => {
    if (this.disposed || this.pipeline) return;
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

  private onLost = (event: Event): void => {
    event.preventDefault();
    this.stopDrawing();
    this.onStatus?.("lost");
  };

  private stopDrawing(): void {
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

  private releaseBuffers(): void {
    if (this.gl && !this.gl.isContextLost()) {
      for (const mesh of this.meshes.values()) this.gl.deleteBuffer(mesh.buffer);
      if (this.pathBuffer) this.gl.deleteBuffer(this.pathBuffer);
    }
    this.meshes.clear();
    this.pathBuffer = null;
  }

  private drawPaths(gl: WebGL2RenderingContext, pipeline: Pipeline, eye: Vec3): void {
    const { paths, pathVertices: vertices } = this;
    if (!vertices.length) return;
    this.pathBuffer ??= gl.createBuffer();
    if (!this.pathBuffer) {
      this.stopDrawing();
      if (!gl.isContextLost()) this.onStatus?.("unavailable");
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
      if (points.length > 1) gl.drawArrays(gl.LINE_STRIP, first, points.length);
      first += points.length;
    }
    gl.drawArrays(gl.POINTS, 0, first);
    gl.depthMask(true);
  }

  private requestDraw = (): void => {
    if (!this.disposed && this.pipeline && this.frame === null) this.frame = requestAnimationFrame(this.draw);
  };

  private draw = (): void => {
    this.frame = null;
    const { gl, pipeline, pose } = this;
    if (!gl || !pipeline || gl.isContextLost()) return;

    for (const [key, mesh] of this.meshes) {
      if (this.terrain.hasSection(key)) continue;
      gl.deleteBuffer(mesh.buffer);
      this.meshes.delete(key);
    }

    for (const position of this.terrain.takeDirty()) {
      const key = sectionKey(position);
      const previous = this.meshes.get(key);
      if (previous) {
        gl.deleteBuffer(previous.buffer);
        this.meshes.delete(key);
      }
      const vertices = this.terrain.mesh(position);
      if (!vertices) continue;
      const buffer = gl.createBuffer();
      if (!buffer) {
        this.stopDrawing();
        if (!gl.isContextLost()) this.onStatus?.("unavailable");
        return;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      this.meshes.set(key, { position, buffer, count: vertices.length / VERTEX_STRIDE });
    }

    const scale = Math.min(window.devicePixelRatio, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!pose || gl.drawingBufferHeight === 0) return;

    gl.useProgram(pipeline.program);
    gl.uniformMatrix4fv(pipeline.camera, false, cameraMatrix(pose.look, gl.drawingBufferWidth / gl.drawingBufferHeight, pose.yaw));
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    for (const { position, buffer, count } of this.meshes.values()) {
      gl.uniform3f(pipeline.offset,
        position[0] * SECTION_SIZE - pose.eye[0],
        position[1] * SECTION_SIZE - pose.eye[1],
        position[2] * SECTION_SIZE - pose.eye[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.vertexAttribPointer(0, 3, gl.UNSIGNED_BYTE, false, VERTEX_STRIDE, 0);
      gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE, 3);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    }
    this.drawPaths(gl, pipeline, pose.eye);
    gl.disableVertexAttribArray(0);
    gl.disableVertexAttribArray(1);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  };
}
