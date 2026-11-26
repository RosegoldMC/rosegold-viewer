import type { Vec3 } from "./renderer.js";
import type { DebugInfo } from "./wire.js";

import { minecraftVersions, type Protocol } from "./protocol.js";

export interface DebugView {
  readonly feed: string;
  readonly protocol: Protocol | null;
  readonly control: string;
  readonly info: DebugInfo | null;
  readonly fps: { readonly fps: number; readonly average: number; readonly worst: number } | null;
  readonly sections: number | null;
  readonly gpu: string | null;
  readonly viewport: { readonly width: number; readonly height: number; readonly ratio: number } | null;
}

export interface DebugLines {
  readonly left: string[];
  readonly right: string[];
}

const unavailable = "n/a";

export function floorDiv(value: number, size: number): number {
  return Math.floor(value / size);
}

export function localCoordinate(value: number): number {
  return ((value % 16) + 16) % 16;
}

export function fixed(value: number, digits: number): string {
  const scale = 10 ** digits;
  return (Math.round(value * scale) / scale + 0).toFixed(digits);
}

export function wrapDegrees(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped >= 180 ? wrapped - 360 : wrapped;
}

export function facing(yaw: number): string {
  const radians = yaw * Math.PI / 180;
  const x = -Math.sin(radians);
  const z = Math.cos(radians);
  if (Math.abs(x) > Math.abs(z)) return x > 0 ? "east (Towards positive X)" : "west (Towards negative X)";
  return z >= 0 ? "south (Towards positive Z)" : "north (Towards negative Z)";
}

function worldTime(time: number): string {
  const day = Math.floor(time / 24000);
  const tick = ((time % 24000) + 24000) % 24000;
  return `World time: ${tick} (day ${day})`;
}

export function formatDebug(view: DebugView): DebugLines {
  const protocol = view.protocol;
  const left = [protocol ? `Minecraft ${minecraftVersions[protocol]} (protocol ${protocol})` : "Minecraft: " + unavailable];
  left.push(view.fps
    ? `${view.fps.fps} fps (avg ${fixed(view.fps.average, 1)} ms, worst ${fixed(view.fps.worst, 1)} ms)`
    : "fps: measuring");
  const info = view.info;
  if (info) {
    const [x, y, z] = info.feet;
    const block = [Math.floor(x), Math.floor(y), Math.floor(z)] as const;
    left.push("");
    left.push(`XYZ: ${fixed(x, 3)} / ${fixed(y, 3)} / ${fixed(z, 3)}`);
    left.push(`Block: ${block.join(" ")}`);
    left.push(`Chunk: ${block.map(localCoordinate).join(" ")} in ${block.map(n => floorDiv(n, 16)).join(" ")}`);
  } else {
    left.push("", "XYZ: " + unavailable, "Block: " + unavailable, "Chunk: " + unavailable);
  }
  left.push(info
    ? `Facing: ${facing(info.rotation[0])} (${fixed(wrapDegrees(info.rotation[0]), 1)} / ${fixed(info.rotation[1], 1)})`
    : "Facing: " + unavailable);
  left.push("Biome: " + unavailable);
  left.push(`Dimension: ${info ? info.dimension : unavailable}`);
  left.push(info?.time != null ? worldTime(info.time) : "World time: " + unavailable);

  const right = [`Viewer: ${view.feed}, control ${view.control}`];
  right.push(`WebGL: ${view.gpu ?? unavailable}`);
  right.push(view.viewport
    ? `Display: ${view.viewport.width}x${view.viewport.height} (${fixed(view.viewport.ratio, 2)}x)`
    : "Display: " + unavailable);
  right.push(view.sections === null ? "Sections: " + unavailable : `Sections: ${view.sections} meshed`);

  const target = info?.target;
  if (target?.kind === "block") {
    right.push("", `Targeted Block: ${target.position.join(", ")}`, target.id ?? "unknown block");
    if (target.props) for (const [key, value] of Object.entries(target.props)) right.push(`${key}: ${value}`);
  } else if (target?.kind === "entity") {
    right.push("", "Targeted Entity", target.id ?? "unknown entity");
  } else if (info) {
    right.push("", "Targeted Block: none");
  }
  return { left, right };
}
