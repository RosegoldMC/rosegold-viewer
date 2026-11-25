import { cameraMatrix, unitLook, type Vec3 } from "./camera.js";
import type { EntityLayer } from "./entity-layer.js";
import type { Atlas } from "./atlas.js";
import { BREAK_STAGES, TILE_SIZE } from "./atlas.js";
import { FIRST_LIQUID_MATERIAL, FLOW_TOP_MATERIAL_OFFSET, LIQUID_SPRITES, liquidFrameAt } from "./liquid.js";
import { CUBE_VERTICES, describeMissingTexture, SECTION_SIZE, Terrain, VERTEX_POSITION_SCALE, VERTEX_STRIDE, VERTEX_UV_SCALE, fillCube, sectionKey, type SectionPosition } from "./terrain.js";

export type { SectionPosition, Vec3 };
export type RendererStatus = "ready" | "unavailable" | "lost";

export interface PathOverlay {
  readonly name: string;
  readonly color: number;
  readonly points: readonly Vec3[];
}

export interface BreakingBlock {
  readonly position: readonly [number, number, number];
  readonly stage: number;
}

export interface RendererOptions {
  airStateIds: Iterable<number>;
  onStatus?: (status: RendererStatus) => void;
  onTextureStatus?: (textured: boolean) => void;
  onBreakingDrawn?: (drawn: boolean) => void;
}

interface Pipeline {
  program: WebGLProgram;
  camera: WebGLUniformLocation;
  offset: WebGLUniformLocation;
  textured: WebGLUniformLocation;
  atlasSize: WebGLUniformLocation;
  atlas: WebGLUniformLocation;
  overlay: WebGLUniformLocation;
  positionScale: WebGLUniformLocation;
  uvScale: WebGLUniformLocation;
  water: WebGLUniformLocation;
  liquidFrames: WebGLUniformLocation;
}

interface Mesh {
  position: SectionPosition;
  buffer: WebGLBuffer;
  count: number;
  liquids: number;
}

const breakVertexStride = 10 * Float32Array.BYTES_PER_ELEMENT;
const pathVertexStride = 6 * Float32Array.BYTES_PER_ELEMENT;

const vertexSource = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
layout(location = 2) in vec2 a_corner;
layout(location = 3) in vec2 a_tile;
layout(location = 4) in float a_material;
uniform mat4 u_camera;
uniform vec3 u_offset;
uniform float u_positionScale;
uniform float u_uvScale;
out vec3 v_color;
out vec2 v_local;
flat out vec2 v_tile;
flat out float v_material;
void main() {
  gl_Position = u_camera * vec4(a_position / u_positionScale + u_offset, 1.0);
  gl_PointSize = 7.0;
  v_color = a_color;
  v_local = a_corner / u_uvScale * ${TILE_SIZE}.0;
  v_tile = a_tile;
  v_material = a_material;
}`;

const fragmentSource = `#version 300 es
precision mediump float;
in vec3 v_color;
in vec2 v_local;
flat in vec2 v_tile;
flat in float v_material;
uniform bool u_textured;
uniform bool u_water;
uniform bool u_overlay;
uniform vec2 u_atlasSize;
uniform sampler2D u_atlas;
uniform vec4 u_liquidFrames[${LIQUID_SPRITES.length}];
out vec4 color;
void main() {
  if (u_overlay) {
    if (!u_textured || v_tile.x > 254.5) discard;
    vec2 crack = v_tile * ${TILE_SIZE}.0 + clamp(v_local, 0.5, ${TILE_SIZE - 0.5}0);
    vec4 stage = texture(u_atlas, crack / u_atlasSize);
    if (stage.a < 0.004) discard;
    color = stage;
    return;
  }
  if (u_textured && v_tile.x < 254.5) {
    vec2 tile = v_tile;
    vec2 local = v_local;
    if (v_material >= ${FIRST_LIQUID_MATERIAL}.0) {
      int sprite = int(v_material) - ${FIRST_LIQUID_MATERIAL};
      if (sprite >= ${FLOW_TOP_MATERIAL_OFFSET}) {
        sprite -= ${FLOW_TOP_MATERIAL_OFFSET};
        local = fract(local / ${TILE_SIZE}.0) * ${TILE_SIZE}.0;
      }
      vec4 frame = u_liquidFrames[sprite];
      if (all(equal(frame.xy, v_tile))) tile = frame.zw;
    }
    vec2 texel = tile * ${TILE_SIZE}.0 + clamp(local, 0.5, ${TILE_SIZE - 0.5}0);
    vec4 sampled = texture(u_atlas, texel / u_atlasSize);
    if (u_water) {
      if (sampled.a < 0.004) discard;
      color = vec4(sampled.rgb * vec3(0.247, 0.463, 0.894), sampled.a);
      return;
    }
    if (sampled.a < 0.5) {
      if (v_material == 1.0) discard;
      color = vec4(v_color, 1.0);
      return;
    }
    color = vec4(sampled.rgb, 1.0);
    return;
  }
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
    const textured = gl.getUniformLocation(program, "u_textured");
    const atlasSize = gl.getUniformLocation(program, "u_atlasSize");
    const atlas = gl.getUniformLocation(program, "u_atlas");
    const overlay = gl.getUniformLocation(program, "u_overlay");
    const positionScale = gl.getUniformLocation(program, "u_positionScale");
    const uvScale = gl.getUniformLocation(program, "u_uvScale");
    const water = gl.getUniformLocation(program, "u_water");
    const liquidFrames = gl.getUniformLocation(program, "u_liquidFrames[0]");
    if (camera && offset && textured && atlasSize && atlas && overlay && positionScale && uvScale && water && liquidFrames) {
      return { program, camera, offset, textured, atlasSize, atlas, overlay, positionScale, uvScale, water, liquidFrames };
    }
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
  private readonly waterMeshes = new Map<string, Mesh>();
  private readonly resizeObserver: ResizeObserver;
  private pipeline: Pipeline | null = null;
  private pose: { eye: Vec3; look: Vec3; yaw: number } | null = null;
  private entities: EntityLayer | null = null;
  private paths: PathOverlay[] = [];
  private pathVertices = new Float32Array(0);
  private pathBuffer: WebGLBuffer | null = null;
  private breaking: { position: [number, number, number]; stage: number } | null = null;
  private breakBuffer: WebGLBuffer | null = null;
  private readonly breakVertices = new Float32Array(CUBE_VERTICES * 10);
  private atlas: Atlas | null = null;
  private texture: WebGLTexture | null = null;
  private textured = false;
  private readonly liquidFrames = new Float32Array(LIQUID_SPRITES.length * 4);
  private liquidTimer: number | null = null;
  private frame: number | null = null;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement, options: RendererOptions) {
    this.terrain = new Terrain(options.airStateIds, undefined, missing => console.warn(describeMissingTexture(missing)));
    this.onStatus = options.onStatus;
    this.onTextureStatus = options.onTextureStatus;
    this.onBreakingDrawn = options.onBreakingDrawn;
    this.gl = openContext(canvas);
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.initialize);
    this.resizeObserver = new ResizeObserver(this.requestDraw);
    this.resizeObserver.observe(canvas);
    window.addEventListener("resize", this.requestDraw);
    this.initialize();
  }

  private readonly onStatus: RendererOptions["onStatus"];
  private readonly onTextureStatus: RendererOptions["onTextureStatus"];
  private readonly onBreakingDrawn: RendererOptions["onBreakingDrawn"];
  private breakingDrawn = false;

  private setBreakingDrawn(value: boolean): void {
    if (this.breakingDrawn === value) return;
    this.breakingDrawn = value;
    this.onBreakingDrawn?.(value);
  }

  setAtlas(atlas: Atlas | null): void {
    if (this.disposed) return;
    this.atlas = atlas;
    if (this.pipeline) this.uploadAtlas();
  }

  private uploadAtlas(): void {
    const { gl, atlas } = this;
    this.releaseTexture();
    this.releaseBreakBuffer();
    if (!gl || gl.isContextLost() || !atlas) return this.setTextured(false);
    const texture = gl.createTexture();
    if (!texture) return this.setTextured(false);
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Texture upload failed");
    } catch {
      gl.deleteTexture(texture);
      return this.setTextured(false);
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    this.texture = texture;
    this.setTextured(true);
  }

  private releaseTexture(): void {
    if (this.texture && this.gl && !this.gl.isContextLost()) this.gl.deleteTexture(this.texture);
    this.texture = null;
  }

  private setTextured(value: boolean): void {
    this.terrain.setTextures(value ? this.atlas : null);
    if (this.textured !== value) {
      this.textured = value;
      this.onTextureStatus?.(value);
    }
    this.requestDraw();
  }

  replaceSection(position: SectionPosition, states: Uint16Array | null): void {
    if (!this.disposed && this.terrain.replaceSection(position, states)) this.requestDraw();
  }

  removeSection(position: SectionPosition): void {
    this.replaceSection(position, null);
  }

  setEntityLayer(layer: EntityLayer | null): void {
    if (this.disposed || layer === this.entities) return;
    this.entities?.release();
    this.entities?.setRequestDraw(null);
    this.entities = layer;
    layer?.setRequestDraw(this.requestDraw);
    if (layer && this.pipeline && this.gl) layer.attach(this.gl);
    this.requestDraw();
  }

  setPaths(paths: readonly PathOverlay[]): void {
    if (this.disposed) return;
    this.paths = paths.map(path => ({ ...path, points: path.points.map((p): Vec3 => [p[0], p[1], p[2]]) }));
    const count = this.paths.reduce((sum, path) => sum + path.points.length, 0);
    this.pathVertices = new Float32Array(count * 6);
    this.requestDraw();
  }

  setBreaking(value: BreakingBlock | null): void {
    if (this.disposed) return;
    if (value === null) {
      if (this.breaking === null) return;
      this.breaking = null;
      this.setBreakingDrawn(false);
      this.requestDraw();
      return;
    }
    const { position, stage } = value;
    if (position.length !== 3 || !position.every(Number.isSafeInteger)) throw new RangeError("Expected integer block coordinates");
    if (!Number.isInteger(stage) || stage < 0 || stage >= BREAK_STAGES) throw new RangeError("Expected a break stage from 0 to 9");
    const current = this.breaking;
    if (current?.stage === stage && position.every((v, i) => v === current.position[i])) return;
    this.breaking = { position: [position[0], position[1], position[2]], stage };
    this.requestDraw();
  }

  clear(): void {
    this.stopLiquidTimer();
    this.pose = null;
    this.breaking = null;
    this.setBreakingDrawn(false);
    this.paths = [];
    this.pathVertices = new Float32Array(0);
    this.terrain.clear();
    this.entities?.clear();
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
    this.entities?.dispose();
    this.entities?.setRequestDraw(null);
    this.entities = null;
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
    if (this.atlas) this.uploadAtlas();
    this.entities?.attach(gl);
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
    this.stopLiquidTimer();
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.setBreakingDrawn(false);
    this.releaseBuffers();
    this.releaseTexture();
    this.entities?.release();
    this.terrain.setTextures(null);
    if (this.textured) {
      this.textured = false;
      this.onTextureStatus?.(false);
    }
    if (this.pipeline && this.gl && !this.gl.isContextLost()) {
      this.gl.useProgram(null);
      this.gl.deleteProgram(this.pipeline.program);
    }
    this.pipeline = null;
  }

  private releaseBuffers(): void {
    if (this.gl && !this.gl.isContextLost()) {
      for (const mesh of this.meshes.values()) this.gl.deleteBuffer(mesh.buffer);
      for (const mesh of this.waterMeshes.values()) this.gl.deleteBuffer(mesh.buffer);
      if (this.pathBuffer) this.gl.deleteBuffer(this.pathBuffer);
    }
    this.meshes.clear();
    this.waterMeshes.clear();
    this.pathBuffer = null;
    this.releaseBreakBuffer();
  }

  private releaseBreakBuffer(): void {
    if (this.breakBuffer && this.gl && !this.gl.isContextLost()) this.gl.deleteBuffer(this.breakBuffer);
    this.breakBuffer = null;
  }

  private drawBreaking(gl: WebGL2RenderingContext, pipeline: Pipeline, eye: Vec3): boolean {
    const { breaking, atlas } = this;
    if (!breaking || !atlas) return false;
    const [x, y, z] = breaking.position;
    const tile = atlas.breakStages?.[breaking.stage];
    if (tile === undefined || !Number.isInteger(tile) || tile < 0 || tile >= atlas.columns * atlas.rows) return false;
    if (!this.terrain.opaqueAt(x, y, z)) return false;
    this.breakBuffer ??= gl.createBuffer();
    if (!this.breakBuffer) {
      this.stopDrawing();
      if (!gl.isContextLost()) this.onStatus?.("unavailable");
      return false;
    }

    const count = fillCube(this.breakVertices, [x, y, z], eye, tile % atlas.columns, Math.floor(tile / atlas.columns),
      (nx, ny, nz) => this.terrain.opaqueAt(nx, ny, nz));
    if (count === 0) return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.breakBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.breakVertices.subarray(0, count * 10), gl.DYNAMIC_DRAW);
    gl.uniform3f(pipeline.offset, 0, 0, 0);
    gl.uniform1f(pipeline.positionScale, 1);
    gl.uniform1f(pipeline.uvScale, 1);
    gl.uniform1i(pipeline.overlay, 1);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, breakVertexStride, 0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, breakVertexStride, 3 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, breakVertexStride, 6 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, breakVertexStride, 8 * Float32Array.BYTES_PER_ELEMENT);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthFunc(gl.LESS);
    gl.uniform1i(pipeline.overlay, 0);
    return true;
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
    gl.uniform1i(pipeline.textured, 0);
    gl.uniform1f(pipeline.positionScale, 1);
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

  private drawSections(gl: WebGL2RenderingContext, pipeline: Pipeline, eye: Vec3, meshes: Iterable<Mesh>): void {
    gl.uniform1f(pipeline.positionScale, VERTEX_POSITION_SCALE);
    gl.uniform1f(pipeline.uvScale, VERTEX_UV_SCALE);
    for (const { position, buffer, count } of meshes) {
      gl.uniform3f(pipeline.offset,
        position[0] * SECTION_SIZE - eye[0],
        position[1] * SECTION_SIZE - eye[1],
        position[2] * SECTION_SIZE - eye[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.vertexAttribPointer(0, 3, gl.SHORT, false, VERTEX_STRIDE, 0);
      gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE, 6);
      gl.vertexAttribPointer(2, 2, gl.UNSIGNED_BYTE, false, VERTEX_STRIDE, 9);
      gl.vertexAttribPointer(3, 2, gl.UNSIGNED_BYTE, false, VERTEX_STRIDE, 11);
      gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, false, VERTEX_STRIDE, 13);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    }
  }

  // Sections are sorted far to near; quads inside one section are unsorted. Water faces against
  // water are culled by the mesher, so local overlaps are limited to a single surface layer.
  private drawWater(gl: WebGL2RenderingContext, pipeline: Pipeline, eye: Vec3): void {
    const distance = ({ position }: Mesh): number =>
      position.reduce((sum, value, axis) => sum + (value * SECTION_SIZE + SECTION_SIZE / 2 - eye[axis]) ** 2, 0);
    const sorted = [...this.waterMeshes.values()].sort((a, b) => distance(b) - distance(a));
    gl.uniform1i(pipeline.water, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enableVertexAttribArray(4);
    this.drawSections(gl, pipeline, eye, sorted);
    gl.disableVertexAttribArray(4);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1i(pipeline.water, 0);
  }

  private stopLiquidTimer(): void {
    if (this.liquidTimer === null) return;
    window.clearTimeout(this.liquidTimer);
    this.liquidTimer = null;
  }

  private updateLiquidFrames(gl: WebGL2RenderingContext, pipeline: Pipeline, atlas: Atlas, now: number): void {
    this.liquidFrames.fill(255);
    let active = 0;
    if (atlas.animations) {
      for (const meshes of [this.meshes, this.waterMeshes]) for (const mesh of meshes.values()) active |= mesh.liquids;
    }
    const ticks = Math.floor(now / 50);
    let nextTick = Infinity;
    for (const [i, sprite] of LIQUID_SPRITES.entries()) {
      const frames = atlas.animations?.[sprite];
      if (!(active & (1 << i)) || !frames?.length) continue;
      const { tile, remaining } = liquidFrameAt(frames, ticks);
      const base = frames[0][0];
      this.liquidFrames.set([base % atlas.columns, Math.floor(base / atlas.columns),
        tile % atlas.columns, Math.floor(tile / atlas.columns)], i * 4);
      nextTick = Math.min(nextTick, ticks + remaining);
    }
    gl.uniform4fv(pipeline.liquidFrames, this.liquidFrames);
    if (Number.isFinite(nextTick)) {
      this.liquidTimer = window.setTimeout(this.requestDraw, Math.max(1, nextTick * 50 - now));
    }
  }

  private requestDraw = (): void => {
    if (!this.disposed && this.pipeline && this.frame === null) this.frame = requestAnimationFrame(this.draw);
  };

  private draw = (now: number): void => {
    this.frame = null;
    this.stopLiquidTimer();
    const { gl, pipeline, pose } = this;
    if (!gl || !pipeline || gl.isContextLost()) return;

    for (const meshes of [this.meshes, this.waterMeshes]) {
      for (const [key, mesh] of meshes) {
        if (this.terrain.hasSection(key)) continue;
        gl.deleteBuffer(mesh.buffer);
        meshes.delete(key);
      }
    }

    for (const position of this.terrain.takeDirty()) {
      const key = sectionKey(position);
      for (const [meshes, waterOnly] of [[this.meshes, false], [this.waterMeshes, true]] as const) {
        const previous = meshes.get(key);
        if (previous) {
          gl.deleteBuffer(previous.buffer);
          meshes.delete(key);
        }
        const vertices = this.terrain.mesh(position, waterOnly);
        if (!vertices) continue;
        const buffer = gl.createBuffer();
        if (!buffer) {
          this.stopDrawing();
          if (!gl.isContextLost()) this.onStatus?.("unavailable");
          return;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        let liquids = 0;
        if (this.atlas?.animations) {
          for (let i = 13; i < vertices.length; i += VERTEX_STRIDE * 3) {
            const material = vertices[i];
            if (material >= FIRST_LIQUID_MATERIAL) liquids |= 1 << ((material - FIRST_LIQUID_MATERIAL) % LIQUID_SPRITES.length);
          }
        }
        meshes.set(key, { position, buffer, count: vertices.length / VERTEX_STRIDE, liquids });
      }
    }

    const scale = Math.min(window.devicePixelRatio, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!pose || gl.drawingBufferHeight === 0) {
      this.setBreakingDrawn(false);
      return;
    }

    gl.useProgram(pipeline.program);
    const camera = cameraMatrix(pose.look, gl.drawingBufferWidth / gl.drawingBufferHeight, pose.yaw);
    gl.uniformMatrix4fv(pipeline.camera, false, camera);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    const useTexture = this.textured && this.texture !== null && this.atlas !== null;
    if (useTexture && this.atlas) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(pipeline.atlas, 0);
      gl.uniform2f(pipeline.atlasSize, this.atlas.columns * TILE_SIZE, this.atlas.rows * TILE_SIZE);
      this.updateLiquidFrames(gl, pipeline, this.atlas, now);
    }
    gl.uniform1i(pipeline.textured, useTexture ? 1 : 0);
    gl.enableVertexAttribArray(2);
    gl.enableVertexAttribArray(3);
    gl.enableVertexAttribArray(4);
    this.drawSections(gl, pipeline, pose.eye, this.meshes.values());
    gl.disableVertexAttribArray(4);
    const drawn = useTexture && this.drawBreaking(gl, pipeline, pose.eye);
    if (this.pipeline) this.setBreakingDrawn(drawn);
    const entities = this.entities;
    if (entities?.animating) {
      entities.draw({ gl, camera, eye: pose.eye, atlas: useTexture ? this.atlas : null, atlasTexture: useTexture ? this.texture : null });
      gl.useProgram(pipeline.program);
      gl.activeTexture(gl.TEXTURE0);
      if (useTexture) gl.bindTexture(gl.TEXTURE_2D, this.texture);
      this.requestDraw();
    }
    if (useTexture && this.waterMeshes.size > 0) this.drawWater(gl, pipeline, pose.eye);
    gl.disableVertexAttribArray(2);
    gl.disableVertexAttribArray(3);
    if (useTexture) gl.bindTexture(gl.TEXTURE_2D, null);
    this.drawPaths(gl, pipeline, pose.eye);
    gl.disableVertexAttribArray(0);
    gl.disableVertexAttribArray(1);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  };
}
