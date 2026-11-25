import { SUPPORTED_KINDS } from "./entity-geometry.js";
import { EntityLayer, loadEntityPack, type EntityPack } from "./entity-layer.js";
import { loadLocalSkin, type SkinPixels } from "./entity-skin.js";
import type { EntitySnapshot } from "./wire.js";

const SPECIES = new Set<string>(SUPPORTED_KINDS);

export interface EntitySink {
  replaceAll(rows: readonly EntitySnapshot[]): void;
}

export function toLayerEntities(rows: readonly EntitySnapshot[]): unknown[] {
  const out: unknown[] = [];
  for (const row of rows) {
    if (!SPECIES.has(row.species)) continue;
    const entity: Record<string, unknown> = {
      id: row.id, kind: row.species, x: row.position[0], y: row.position[1], z: row.position[2], yaw: row.yaw, pitch: row.pitch,
    };
    if (row.species === "item") {
      if (!row.item) continue;
      entity.item = row.item.name;
      entity.count = row.item.count;
    }
    if (row.appearance) {
      entity.slim = row.appearance.model === "slim";
      if (/^[0-9a-f]{64}$/.test(row.appearance.key)) entity.skin = row.appearance.key;
    }
    out.push(entity);
  }
  return out;
}

async function decodePng(png: Uint8Array): Promise<SkinPixels> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally {
    bitmap.close();
  }
}

export function createEntityPackLoader(): () => Promise<EntityPack | null> {
  let pack: Promise<EntityPack | null> | null = null;
  return () => pack ??= loadEntityPack({ fetch: (input, init) => fetch(input, init), createImageBitmap: (blob, options) => createImageBitmap(blob, options) })
    .catch((): null => null);
}

export function createEntitySink(renderer: { setEntityLayer(layer: EntityLayer | null): void }, pack: () => Promise<EntityPack | null>): EntitySink {
  const layer = new EntityLayer({
    skinSource: key => loadLocalSkin({ fetch: (input, init) => fetch(input, init), decode: decodePng }, key),
  });
  renderer.setEntityLayer(layer);
  void pack().then(loaded => { if (loaded) layer.setPack(loaded); });
  return { replaceAll: rows => layer.replaceAll(toLayerEntities(rows)) };
}
