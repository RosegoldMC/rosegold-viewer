import type { Atlas, FaceTiles } from "./atlas.js";
import { TILE_SIZE } from "./atlas.js";
import type { Vec3 } from "./camera.js";
import { emitModel, shade, type ModelKind, type Rect, type Sink, type TextureName } from "./entity-geometry.js";
import { defaultSkinName, normalizeSkin, SKIN_SIZE, type SkinPixels } from "./entity-skin.js";
import { EntityStore, type DrawnEntity } from "./entity-state.js";

export type { EntityState } from "./entity-state.js";

export const MAX_CUSTOM_SKINS = 32;
const MAX_FAILED_SKINS = 64;
const MAX_PENDING_SKINS = 8;
const PLAYER_SCALE = 0.9375;
const FLOATS = 8;
const STRIDE = FLOATS * Float32Array.BYTES_PER_ELEMENT;

export const DYE_COLORS = [
  0xF9FFFE, 0xF9801D, 0xC74EBD, 0x3AB3DA, 0xFED83D, 0x80C71F, 0xF38BAA, 0x474F52,
  0x9D9D97, 0x169C9C, 0x8932B8, 0x3C44AA, 0x835432, 0x5E7C16, 0xB02E26, 0x1D1D21,
] as const;

export interface EntityPack {
  readonly image: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly rects: ReadonlyMap<string, Rect>;
}

export interface EntityPackDeps {
  fetch: typeof fetch;
  createImageBitmap: (blob: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;
}

async function bounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error("Entity pack file too large");
  return bytes;
}

export function parsePack(value: unknown): { width: number; height: number; rects: Map<string, Rect> } {
  const root = value as Record<string, unknown> | null;
  if (!root || typeof root !== "object") throw new Error("Invalid entity pack");
  const { width, height, textures } = root;
  const dim = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1024;
  if (!dim(width) || !dim(height) || !textures || typeof textures !== "object" || Array.isArray(textures)) throw new Error("Invalid entity pack");
  const rects = new Map<string, Rect>();
  for (const [name, rect] of Object.entries(textures)) {
    if (!/^[a-z0-9_]{1,32}$/.test(name) || !Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isInteger)) throw new Error("Invalid entity pack texture");
    const [x, y, w, h] = rect as number[];
    if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) throw new Error("Entity pack texture out of bounds");
    rects.set(name, { x, y, w, h });
  }
  return { width, height, rects };
}

export async function loadEntityPack(deps: EntityPackDeps, base = "/local-pack/"): Promise<EntityPack> {
  const init: RequestInit = { method: "GET", credentials: "omit", cache: "no-store", redirect: "error" };
  const [json, png] = await Promise.all([
    deps.fetch(`${base}entities.json`, init).then(r => bounded(r, 16 * 1024)),
    deps.fetch(`${base}entities.png`, init).then(r => bounded(r, 512 * 1024)),
  ]);
  const { width, height, rects } = parsePack(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)));
  const image = await deps.createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  if (image.width !== width || image.height !== height) {
    image.close?.();
    throw new Error("Entity pack image does not match its manifest");
  }
  return { image, width, height, rects };
}

export interface DrawContext {
  gl: WebGL2RenderingContext;
  camera: Float32Array;
  eye: Vec3;
  atlas: Atlas | null;
  atlasTexture: WebGLTexture | null;
}

export interface EntityLayerOptions {
  skinSource?: (key: string) => Promise<SkinPixels | Uint8Array | null>;
  clock?: () => number;
  requestDraw?: () => void;
}

export interface DrawStats {
  entities: number;
  vertices: number;
  skipped: number;
}

const vertexSource = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec3 a_color;
uniform mat4 u_camera;
uniform vec2 u_texSize;
out vec2 v_uv;
out vec3 v_color;
void main() {
  gl_Position = u_camera * vec4(a_position, 1.0);
  v_uv = a_uv / u_texSize;
  v_color = a_color;
}`;

const fragmentSource = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec3 v_color;
uniform sampler2D u_tex;
uniform float u_cut;
out vec4 color;
void main() {
  if (v_uv.x < 0.0) {
    color = vec4(v_color, 1.0);
    return;
  }
  vec4 s = texture(u_tex, v_uv);
  if (s.a < u_cut) discard;
  color = vec4(s.rgb * v_color, s.a < 0.999 ? s.a : 1.0);
}`;

class Builder implements Sink {
  data = new Float32Array(1024 * FLOATS);
  length = 0;

  push(x: number, y: number, z: number, u: number, v: number, r: number, g: number, b: number): void {
    if (this.length + FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set([x, y, z, u, v, r, g, b], this.length);
    this.length += FLOATS;
  }
}

interface Group {
  key: string;
  size: readonly [number, number];
  solid: Builder;
  outer: Builder;
}

interface Pipeline {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  camera: WebGLUniformLocation;
  texSize: WebGLUniformLocation;
  tex: WebGLUniformLocation;
  cut: WebGLUniformLocation;
}

interface Skin {
  pixels: Uint8Array;
  texture: WebGLTexture | null;
}

function hash(id: number): number {
  return (Math.imul(id >>> 0 ^ 0x27d4eb2f, 0x165667b1) >>> 0) / 4294967296;
}

const NO_UV: readonly [number, number] = [-1, -1];

const CUBE_FACES: readonly (readonly [Vec3, Vec3, Vec3, Vec3])[] = [
  [[1, 1, 1], [0, 0, -1], [0, -1, 0], [1, 0, 0]],
  [[0, 1, 0], [0, 0, 1], [0, -1, 0], [-1, 0, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[0, 1, 1], [1, 0, 0], [0, -1, 0], [0, 0, 1]],
  [[1, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, -1]],
];

function tileOrigin(atlas: Atlas, tile: number): readonly [number, number] | null {
  if (!Number.isInteger(tile) || tile < 0 || tile >= atlas.columns * atlas.rows) return null;
  return [(tile % atlas.columns) * TILE_SIZE, Math.floor(tile / atlas.columns) * TILE_SIZE];
}

export class EntityLayer {
  private readonly store: EntityStore;
  private readonly clock: () => number;
  private readonly skinSource: EntityLayerOptions["skinSource"];
  private requestDraw: () => void;
  private gl: WebGL2RenderingContext | null = null;
  private pipeline: Pipeline | null = null;
  private pack: EntityPack | null = null;
  private packTexture: WebGLTexture | null = null;
  private readonly skins = new Map<string, Skin>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private generation = 0;
  private stats: DrawStats = { entities: 0, vertices: 0, skipped: 0 };

  constructor(options: EntityLayerOptions = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.store = new EntityStore(this.clock);
    this.skinSource = options.skinSource;
    this.requestDraw = options.requestDraw ?? (() => {});
  }

  // The renderer supplies its coalesced frame request so spawns, removals, skins and packs wake an idle scene.
  setRequestDraw(request: (() => void) | null): void {
    this.requestDraw = request ?? (() => {});
  }

  get animating(): boolean {
    return this.store.size > 0;
  }

  get lastDraw(): DrawStats {
    return this.stats;
  }

  get entityCount(): number {
    return this.store.size;
  }

  get skinCount(): number {
    return this.skins.size;
  }

  hasGpuResources(): boolean {
    return this.pipeline !== null || this.packTexture !== null || [...this.skins.values()].some(skin => skin.texture !== null);
  }

  replaceAll(list: readonly unknown[]): void {
    this.store.replaceAll(list);
    this.requestDraw();
  }

  upsert(list: readonly unknown[]): void {
    this.store.upsert(list);
    this.requestDraw();
  }

  remove(ids: Iterable<number>): void {
    this.store.remove(ids);
    this.requestDraw();
  }

  setPack(pack: EntityPack | null): void {
    this.deleteTexture(this.packTexture);
    this.packTexture = null;
    this.pack = pack;
    this.requestDraw();
  }

  setSkin(key: string, pixels: SkinPixels | Uint8Array): void {
    if (!/^[0-9a-f-]{1,64}$/.test(key)) return;
    const normalized = pixels instanceof Uint8Array ? (pixels.length === SKIN_SIZE * SKIN_SIZE * 4 ? pixels : null) : normalizeSkin(pixels);
    if (!normalized) return;
    this.dropSkin(key);
    this.skins.set(key, { pixels: normalized, texture: null });
    const name = key;
    if (this.skins.size > MAX_CUSTOM_SKINS) {
      const visible = this.store.skinKeys();
      const order = [...this.skins.keys()];
      for (const key of [...order.filter(k => !visible.has(k)), ...order.filter(k => visible.has(k))]) {
        if (this.skins.size <= MAX_CUSTOM_SKINS) break;
        if (key !== name) this.dropSkin(key);
      }
    }
    this.requestDraw();
  }

  private dropSkin(key: string): void {
    const skin = this.skins.get(key);
    if (skin) this.deleteTexture(skin.texture);
    this.skins.delete(key);
  }

  // Epoch reset or world change: forget entities and cached skins, keep the shared pack and pipeline.
  clear(): void {
    this.generation++;
    this.store.clear();
    for (const key of [...this.skins.keys()]) this.dropSkin(key);
    this.pending.clear();
    this.failed.clear();
    this.stats = { entities: 0, vertices: 0, skipped: 0 };
  }

  attach(gl: WebGL2RenderingContext): void {
    this.release();
    this.gl = gl;
    const pipeline = this.makePipeline(gl);
    this.pipeline = pipeline;
  }

  // The context is gone: its objects died with it, so only forget them.
  lose(): void {
    this.pipeline = null;
    this.packTexture = null;
    for (const skin of this.skins.values()) skin.texture = null;
    this.gl = null;
  }

  release(): void {
    const { gl, pipeline } = this;
    if (gl && !gl.isContextLost()) {
      if (pipeline) {
        gl.deleteBuffer(pipeline.buffer);
        gl.deleteVertexArray(pipeline.vao);
        gl.deleteProgram(pipeline.program);
      }
      this.deleteTexture(this.packTexture);
      for (const skin of this.skins.values()) this.deleteTexture(skin.texture);
    }
    this.lose();
  }

  dispose(): void {
    this.clear();
    this.release();
    this.pack = null;
  }

  private deleteTexture(texture: WebGLTexture | null): void {
    if (texture && this.gl && !this.gl.isContextLost()) this.gl.deleteTexture(texture);
  }

  private makePipeline(gl: WebGL2RenderingContext): Pipeline | null {
    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
      gl.deleteShader(shader);
      return null;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = vertex && compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = vertex && fragment ? gl.createProgram() : null;
    if (program && vertex && fragment) {
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
    }
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    if (!program) return null;
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    const camera = gl.getUniformLocation(program, "u_camera");
    const texSize = gl.getUniformLocation(program, "u_texSize");
    const tex = gl.getUniformLocation(program, "u_tex");
    const cut = gl.getUniformLocation(program, "u_cut");
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) || !vao || !buffer || !camera || !texSize || !tex || !cut) {
      gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      if (buffer) gl.deleteBuffer(buffer);
      return null;
    }
    return { program, vao, buffer, camera, texSize, tex, cut };
  }

  private upload(gl: WebGL2RenderingContext, upload: () => void): WebGLTexture | null {
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    upload();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      return null;
    }
    return texture;
  }

  private packGpu(gl: WebGL2RenderingContext): WebGLTexture | null {
    const { pack } = this;
    if (!pack) return null;
    this.packTexture ??= this.upload(gl, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pack.image));
    return this.packTexture;
  }

  private skinGpu(gl: WebGL2RenderingContext, key: string): WebGLTexture | null {
    const skin = this.skins.get(key);
    if (!skin) return null;
    skin.texture ??= this.upload(gl, () =>
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SKIN_SIZE, SKIN_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, skin.pixels));
    return skin.texture;
  }

  private markFailed(key: string): void {
    this.failed.add(key);
    if (this.failed.size > MAX_FAILED_SKINS) this.failed.delete(this.failed.values().next().value as string);
  }

  private requestSkin(key: string): void {
    const source = this.skinSource;
    if (!source || this.pending.has(key) || this.failed.has(key) || this.skins.has(key) || this.pending.size >= MAX_PENDING_SKINS) return;
    this.pending.add(key);
    const generation = this.generation;
    void source(key).then(result => {
      if (generation !== this.generation) return;
      this.pending.delete(key);
      if (result) this.setSkin(key, result);
      else this.markFailed(key);
    }, () => {
      if (generation !== this.generation) return;
      this.pending.delete(key);
      this.markFailed(key);
    });
  }

  draw(context: DrawContext): void {
    const { gl, pipeline } = this;
    if (!gl || !pipeline || gl !== context.gl || gl.isContextLost()) return;
    const entities = this.store.sample();
    if (entities.length === 0) {
      this.stats = { entities: 0, vertices: 0, skipped: 0 };
      return;
    }

    const groups = new Map<string, Group>();
    const group = (key: string, size: readonly [number, number]): Group => {
      let found = groups.get(key);
      if (!found) groups.set(key, found = { key, size, solid: new Builder(), outer: new Builder() });
      return found;
    };
    let skipped = 0;
    for (const entity of entities) {
      if (!this.emit(entity, context, group)) skipped++;
    }

    let vertices = 0;
    const ranges: { group: Group; outer: boolean; first: number; count: number }[] = [];
    for (const outer of [false, true]) {
      for (const g of groups.values()) {
        const builder = outer ? g.outer : g.solid;
        if (builder.length === 0) continue;
        ranges.push({ group: g, outer, first: vertices, count: builder.length / FLOATS });
        vertices += builder.length / FLOATS;
      }
    }
    this.stats = { entities: entities.length, vertices, skipped };
    if (vertices === 0) return;

    const all = new Float32Array(vertices * FLOATS);
    let offset = 0;
    for (const { group: g, outer } of ranges) {
      const builder = outer ? g.outer : g.solid;
      all.set(builder.data.subarray(0, builder.length), offset);
      offset += builder.length;
    }

    gl.useProgram(pipeline.program);
    gl.bindVertexArray(pipeline.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pipeline.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, all, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 3 * 4);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE, 5 * 4);
    gl.uniformMatrix4fv(pipeline.camera, false, context.camera);
    gl.uniform1i(pipeline.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    let blending = false;
    for (const { group: g, outer, first, count } of ranges) {
      const texture = g.key === "atlas" ? context.atlasTexture : g.key === "pack" ? this.packGpu(gl) : this.skinGpu(gl, g.key.slice(5));
      if (!texture) continue;
      if (outer !== blending) {
        blending = outer;
        if (outer) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform2f(pipeline.texSize, g.size[0], g.size[1]);
      gl.uniform1f(pipeline.cut, outer ? 0.02 : 0.5);
      gl.drawArrays(gl.TRIANGLES, first, count);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disableVertexAttribArray(0);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private emit(entity: DrawnEntity, context: DrawContext, group: (key: string, size: readonly [number, number]) => Group): boolean {
    const { eye } = context;
    if (entity.kind === "item") return this.emitItem(entity, context, group);
    const { pack } = this;
    if (!pack) return false;
    const kind = entity.kind as ModelKind;
    const packSize: readonly [number, number] = [pack.width, pack.height];
    const rects: Record<TextureName, Rect | undefined> = { main: undefined, wool: undefined };
    let target = group("pack", packSize);
    let slim = false;
    if (kind === "player") {
      const name = defaultSkinName(entity.id, entity.slim);
      slim = entity.slim ?? name.startsWith("slim_");
      let custom: string | null = null;
      const cached = entity.skin ? this.skins.get(entity.skin) : undefined;
      if (entity.skin && cached) {
        custom = entity.skin;
        this.skins.delete(entity.skin);
        this.skins.set(entity.skin, cached);
      } else if (entity.skin) {
        this.requestSkin(entity.skin);
      }
      if (custom) {
        target = group(`skin:${custom}`, [SKIN_SIZE, SKIN_SIZE]);
        rects.main = { x: 0, y: 0, w: SKIN_SIZE, h: SKIN_SIZE };
      } else {
        rects.main = pack.rects.get(name);
      }
    } else {
      rects.main = pack.rects.get(kind);
      if (kind === "sheep") rects.wool = pack.rects.get("sheep_wool");
    }
    if (!rects.main) return false;
    const dye = DYE_COLORS[entity.color ?? 0] ?? DYE_COLORS[0];
    const wool: [number, number, number] = [(dye >> 16 & 255) / 255, (dye >> 8 & 255) / 255, (dye & 255) / 255];
    const headYaw = Math.max(-75, Math.min(75, (((entity.headYaw - entity.yaw) % 360) + 540) % 360 - 180));
    const sinks = {
      solid: (name: TextureName) => name === "wool" ? group("pack", packSize).solid : target.solid,
      outer: () => target.outer,
    };
    emitModel(kind, slim,
      { swing: entity.swing, amount: entity.amount, headYaw, pitch: entity.pitch },
      { x: entity.x - eye[0], y: entity.y - eye[1], z: entity.z - eye[2], yaw: entity.yaw, scale: kind === "player" ? PLAYER_SCALE : 1 },
      rects, sinks, wool);
    return true;
  }

  private emitItem(entity: DrawnEntity, context: DrawContext, group: (key: string, size: readonly [number, number]) => Group): boolean {
    const { eye } = context;
    const atlas = context.atlasTexture ? context.atlas : null;
    if (!entity.item) return false;
    const faces: FaceTiles | undefined = atlas?.itemBlocks?.get(entity.item);
    const sprite = faces || !atlas ? undefined : atlas.itemIcons?.get(entity.item);
    // A neutral grey cube keeps spawn, motion and removal visible for stacks the atlas has no icon for.
    const unknown = !faces && sprite === undefined;
    const pack = this.pack;
    const target = (atlas ? group("atlas", [atlas.columns * TILE_SIZE, atlas.rows * TILE_SIZE]) : pack ? group("pack", [pack.width, pack.height]) : null)?.solid;
    if (!target) return false;
    const bobOffset = hash(entity.id) * Math.PI * 2;
    const bob = Math.sin(entity.age / 10 + bobOffset) * 0.1 + 0.1;
    const spin = entity.age / 20 + bobOffset;
    const sin = Math.sin(spin), cos = Math.cos(spin);
    const copies = Math.min(5, entity.count! <= 1 ? 1 : entity.count! <= 16 ? 2 : entity.count! <= 32 ? 3 : entity.count! <= 48 ? 4 : 5);
    for (let copy = 0; copy < copies; copy++) {
      const dx = copy === 0 ? 0 : (hash(entity.id * 7 + copy) - 0.5) * 0.2;
      const dz = copy === 0 ? 0 : (hash(entity.id * 13 + copy) - 0.5) * 0.2;
      const dy = copy * 0.012;
      const cx = entity.x - eye[0] + dx, cz = entity.z - eye[2] + dz;
      const place = (lx: number, ly: number, lz: number): [number, number, number] =>
        [cx + lx * cos + lz * sin, entity.y - eye[1] + bob + dy + ly, cz - lx * sin + lz * cos];
      if (faces || unknown) {
        const half = unknown ? 0.1 : 0.125;
        CUBE_FACES.forEach(([origin, du, dv, normal], f) => {
          const origin0 = unknown ? NO_UV : tileOrigin(atlas!, faces![f]);
          if (!origin0) return;
          const light = shade(normal[0] * cos + normal[2] * sin, normal[1], -normal[0] * sin + normal[2] * cos) * (unknown ? 0.7 : 1);
          const corner = (a: number, b: number): [number, number, number] => place(
            (origin[0] + du[0] * a + dv[0] * b - 0.5) * 2 * half,
            (origin[1] + du[1] * a + dv[1] * b) * 2 * half,
            (origin[2] + du[2] * a + dv[2] * b - 0.5) * 2 * half);
          const quad = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
          const uv = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
          for (const i of [0, 1, 2, 0, 2, 3]) {
            target.push(quad[i][0], quad[i][1], quad[i][2], unknown ? -1 : origin0[0] + uv[i][0] * TILE_SIZE, origin0[1] + uv[i][1] * TILE_SIZE, light, light, light);
          }
        });
      } else {
        const origin = tileOrigin(atlas!, sprite!);
        if (!origin) return false;
        const half = 0.25;
        const quad = [place(-half, 0.5, 0), place(half, 0.5, 0), place(half, 0, 0), place(-half, 0, 0)];
        const uv = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
        for (const i of [0, 1, 2, 0, 2, 3]) {
          target.push(quad[i][0], quad[i][1], quad[i][2], origin[0] + uv[i][0] * TILE_SIZE, origin[1] + uv[i][1] * TILE_SIZE, 1, 1, 1);
        }
      }
    }
    return true;
  }
}
