import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../scripts/load-for-test.mjs";

const { ProtocolAtlas, loadAtlas, lookupInvisible, lookupModels, lookupNames, lookupTiles, lookupVariants, parseManifest } = load("atlas");

const manifest = { protocol: 777, tileSize: 16, columns: 2, rows: 1, blocks: [{ min: 5, max: 6, faces: [0, 1, -1, -1, 0, 1] }] };

test("parses and looks up state ranges, rejecting malformed manifests", () => {
  const tiles = lookupTiles(parseManifest(manifest));
  const { protocol: older, ...olderRest } = parseManifest({ ...manifest, protocol: 775 });
  const { protocol: current, ...currentRest } = parseManifest(manifest);
  assert.deepEqual([older, current], [775, 777]);
  assert.deepEqual(olderRest, currentRest);
  assert.deepEqual(tiles(6), [0, 1, -1, -1, 0, 1]);
  assert.equal(tiles(7), undefined);
  const wide = parseManifest({ ...manifest, columns: 38, rows: 32,
    blocks: [{ min: 5, max: 5, faces: Array(6).fill(1215) }] });
  assert.deepEqual(lookupTiles(wide)(5), Array(6).fill(1215));
  for (const bad of [{ ...manifest, protocol: 776 }, { ...manifest, columns: 39 }, { ...manifest, rows: 33 },
    { ...manifest, blocks: [{ min: 1, max: 1, faces: [2, 0, 0, 0, 0, 0] }] },
    { ...manifest, blocks: [{ min: 1, max: 4, faces: Array(6).fill(0) }, { min: 4, max: 5, faces: Array(6).fill(0) }] }]) {
    assert.throws(() => parseManifest(bad));
  }
});

function pngHeader(width, height) {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function deps({ json = manifest, png = pngHeader(32, 16), size = [32, 16], status = 200 } = {}) {
  return {
    fetch: async url => url.endsWith(".json") ? new Response(JSON.stringify(json), { status }) : new Response(png, { status }),
    createImageBitmap: async () => ({ width: size[0], height: size[1] }),
  };
}

test("loads atlas and rejects mismatched, oversized, or missing assets", async () => {
  const atlas = await loadAtlas(deps());
  assert.equal(atlas.columns, 2);
  assert.equal(atlas.protocol, 777);
  assert.equal((await loadAtlas(deps({ json: { ...manifest, protocol: 775 } }))).protocol, 775);
  await assert.rejects(loadAtlas(deps({ size: [16, 16] })));
  await assert.rejects(loadAtlas(deps({ png: new Uint8Array(1024 * 1024 + 1) })));
  await assert.rejects(loadAtlas(deps({ status: 404 })));
});

test("break stage tiles are optional and ignored unless ten valid tile ids", () => {
  const stages = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
  assert.deepEqual(parseManifest({ ...manifest, breakStages: stages }).breakStages, stages);
  assert.equal(parseManifest(manifest).breakStages, undefined);
  for (const bad of [stages.slice(1), [...stages.slice(1), 2], [...stages.slice(1), -1], [...stages.slice(1), 0.5], "x"]) {
    assert.equal(parseManifest({ ...manifest, breakStages: bad }).breakStages, undefined);
  }
});

test("oversized chunked PNG is cancelled mid-stream", async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(512 * 1024)); },
    cancel() { cancelled = true; },
  });
  const base = deps();
  await assert.rejects(loadAtlas({ ...base, fetch: async url => url.endsWith(".json") ? base.fetch(url) : new Response(body) }), /too large/);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4);
});

test("forged or non-PNG headers reject before decode", async () => {
  for (const png of [pngHeader(16, 16), pngHeader(32, 32), new Uint8Array(64), pngHeader(32, 16).slice(0, 20)]) {
    let decoded = false;
    const d = deps({ png });
    await assert.rejects(loadAtlas({ ...d, createImageBitmap: async () => { decoded = true; return { width: 32, height: 16 }; } }));
    assert.equal(decoded, false);
  }
});

test("item icons: strict names and in-range tiles, otherwise ignored without losing terrain", () => {
  const icons = { stick: 1, oak_planks: 0 };
  const parsed = parseManifest({ ...manifest, itemIcons: icons });
  assert.equal(parsed.itemIcons.get("stick"), 1);
  assert.equal(parseManifest(manifest).itemIcons, undefined);
  assert.equal(lookupTiles(parsed)(5)[1], 1);
  const many = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`i${i}`, 0]));
  for (const bad of [{ Stick: 0 }, { "a-b": 0 }, { "": 0 }, { ["a".repeat(65)]: 0 }, { stick: 2 }, { stick: -1 }, { stick: 0.5 }, { stick: "0" }, [0], "x", many]) {
    const result = parseManifest({ ...manifest, itemIcons: bad });
    assert.equal(result.itemIcons, undefined);
    assert.equal(result.ranges.length, 1);
  }
  const max = Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [`i${i}`, 1]));
  assert.equal(parseManifest({ ...manifest, itemIcons: max }).itemIcons.size, 1024);
  assert.equal(parseManifest({ ...manifest, columns: 32, rows: 32 }).columns, 32);
});

test("loaded atlas exposes item icons", async () => {
  const atlas = await loadAtlas(deps({ json: { ...manifest, itemIcons: { stick: 1 } } }));
  assert.equal(atlas.itemIcons.get("stick"), 1);
});

test("block models are optional, strictly parsed, and scoped to fully textured ranges", async () => {
  const block = (min, max, faces, model) => ({ min, max, faces, ...(model === undefined ? {} : { model }) });
  const full = [0, 0, 0, 0, 0, 0];
  const parsed = parseManifest({ ...manifest, blocks: [
    block(1, 2, full, "leaves"), block(3, 3, full, "cross"), block(4, 4, full, "crop"),
    block(5, 5, [0, 0, -1, 0, 0, 0], "cross"), block(6, 6, full),
  ] });
  const model = lookupModels(parsed);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 65535, 65536, -1, 1.5].map(model),
    [undefined, "leaves", "leaves", "cross", "crop", undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.equal(parseManifest(manifest).ranges[0].model, undefined);
  for (const bad of ["Leaves", "invalid_slab", "", null, 1, {}]) {
    assert.throws(() => parseManifest({ ...manifest, blocks: [block(1, 1, full, bad)] }), /model/);
  }
  const atlas = await loadAtlas(deps({ json: { ...manifest, blocks: [block(7, 8, [0, 1, 0, 1, 0, 1], "crop")] } }));
  assert.equal(atlas.modelFor(8), "crop");
  assert.equal(atlas.modelFor(9), undefined);
  assert.equal((await loadAtlas(deps())).modelFor(5), undefined);
});

test("orchard variants are model-bounded and default to zero without a textured model", async () => {
  const faces = [0, 0, 1, 0, 0, 0];
  const maxima = { leaves: 0, cross: 0, crop: 0, glass: 0, fence: 15, composter: 8, lantern: 1, rail: 9, stairs: 39, water: 15, lava: 15 };
  const blocks = Object.entries(maxima).map(([model, variant], i) => ({ min: i * 2, max: i * 2 + 1, faces, model, variant }));
  blocks.push({ min: 30, max: 30, faces, model: "stairs" });
  blocks.push({ min: 31, max: 31, faces: [0, -1, 1, 0, 0, 0], model: "fence", variant: 15 });
  const json = { ...manifest, blocks };
  const parsed = parseManifest(json);
  const variants = lookupVariants(parsed);
  const models = lookupModels(parsed);
  for (const { min, max, model, variant } of blocks.slice(0, -2)) {
    assert.equal(models(min), model);
    assert.equal(variants(min), variant);
    assert.equal(variants(max), variant);
    for (const bad of [-1, 0.5, "1", null, maxima[model] + 1]) {
      assert.throws(() => parseManifest({ ...manifest, blocks: [{ min, max, faces, model, variant: bad }] }), /variant/);
    }
  }
  for (const model of ["constructor", "__proto__"]) {
    assert.throws(() => parseManifest({ ...manifest, blocks: [{ min: 1, max: 1, faces, model }] }), /model/);
  }
  assert.throws(() => parseManifest({ ...manifest, blocks: [{ min: 1, max: 1, faces, variant: 1 }] }), /variant/);
  assert.equal(models(30), "stairs");
  assert.equal(models(31), undefined);
  for (const state of [30, 31, 32, 65536, -1, 1.5, NaN, "length"]) assert.equal(variants(state), 0);
  const atlas = await loadAtlas(deps({ json }));
  assert.equal(atlas.variantFor(17), 39);
  assert.equal(atlas.variantFor(31), 0);
  assert.equal((await loadAtlas(deps())).variantFor(5), 0);
});

test("registry names and invisible ranges are optional, additive and validated", () => {
  const registry = { max: 9, blocks: [[0, "air"], [1, "stone"], [4, "dirt"]] };
  const parsed = parseManifest({ ...manifest, registry, invisible: [[2, 3], [8, 9]] });
  const name = lookupNames(parsed.registry), invisible = lookupInvisible(parsed.invisible);
  assert.deepEqual([0, 1, 3, 4, 9, 10].map(name), ["minecraft:air", "minecraft:stone", "minecraft:stone", "minecraft:dirt", "minecraft:dirt", undefined]);
  assert.deepEqual([1, 2, 3, 4, 8, 9, 10].map(invisible), [false, true, true, false, true, true, false]);
  assert.equal(parseManifest(manifest).registry, undefined);
  assert.equal(lookupNames(undefined), undefined);
  assert.equal(parseManifest({ ...manifest, registry: { max: 9, blocks: [[1, "b"], [1, "c"]] } }).registry, undefined);
  assert.equal(parseManifest({ ...manifest, registry: { max: 1, blocks: [[0, "Bad Name"]] } }).registry, undefined);
  assert.equal(parseManifest({ ...manifest, invisible: [[3, 4], [4, 5]] }).invisible, undefined);
});

const quad = [[1, 0.75, 1, 1, 0.25, 1, 1, 0.25, 0, 1, 0.75, 0], [0, 0, 0, 1, 1, 1, 1, 0], 1, 0];
const meshPack = { ...manifest, models: { quads: [quad], variants: [[true, [0]], [false, []]] }, blocks: [
  { min: 7, max: 7, model: "mesh", variant: 0, faces: [-1, 1, -1, -1, -1, -1] },
  { min: 8, max: 8, model: "mesh", variant: 1, faces: Array(6).fill(-1) },
] };

test("loads local scene models alongside textures and preserves old pack terrain", async () => {
  const atlas = await loadAtlas(deps({ json: { ...meshPack, blocks: [...meshPack.blocks, ...manifest.blocks,
    { min: 9, max: 9, model: "wall", variant: 100, faces: Array(6).fill(0) },
  ] } }));
  assert.deepEqual(atlas.meshes, [
    { cutout: true, quads: [{ corners: quad[0], uv: quad[1], face: 1, boundary: 0 }] },
    { cutout: false, quads: [] },
  ]);
  assert.equal(atlas.modelFor(7), "mesh");
  assert.equal(atlas.variantFor(8), 1);
  assert.equal(atlas.tilesFor(9), undefined);
  assert.equal(atlas.modelFor(9), undefined);
  assert.deepEqual(atlas.tilesFor(5), manifest.blocks[0].faces);
});

test("rejects oversized or malformed local meshes and broken face bindings", () => {
  const invalid = [
    { ...meshPack, models: undefined },
    { ...meshPack, blocks: [{ ...meshPack.blocks[0], variant: undefined }] },
    { ...meshPack, blocks: [{ ...meshPack.blocks[0], faces: Array(6).fill(-1) }] },
    ...[
      { quads: Array(1025).fill(quad) },
      { quads: [[quad[0].slice(1), ...quad.slice(1)]] },
      { quads: [[[Infinity, ...quad[0].slice(1)], ...quad.slice(1)]] },
      { quads: [[quad[0], [NaN, ...quad[1].slice(1)], 1, 0]] },
      { quads: [[quad[0], quad[1], 6, 0]] },
      { quads: [[quad[0], quad[1], 1, 1]] },
      { variants: Array(257).fill([true, [0]]) },
      { variants: [[true, Array(49).fill(0)]] },
      { variants: [[true, [1]]] },
      { variants: [["true", [0]]] },
    ].map(bad => ({ ...meshPack, models: { ...meshPack.models, ...bad } })),
  ];
  for (const input of invalid) assert.throws(() => parseManifest(input), /atlas (mesh|quad)/);
});

test("re-pairing to another protocol in the same page refetches the atlas or falls back to untextured", async () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  let served = 777;
  const fetched = [];
  const shown = [];
  const atlas = new ProtocolAtlas(() => {
    fetched.push(served);
    return loadAtlas(served === null ? deps({ status: 404 }) : deps({ json: { ...manifest, protocol: served } }));
  }, loaded => shown.push(loaded?.protocol ?? null));
  await settle();
  assert.deepEqual(fetched, [777]);
  assert.deepEqual(shown, []);

  atlas.select(777);
  await settle();
  atlas.select(777);
  await settle();
  assert.deepEqual(fetched, [777]);
  assert.deepEqual(shown, [null, 777]);

  served = 775;
  atlas.select(775);
  await settle();
  assert.deepEqual(fetched, [777, 775]);
  assert.deepEqual(shown, [null, 777, null, 775]);

  served = null;
  atlas.select(777);
  await settle();
  assert.deepEqual(shown.slice(4), [null, null]);

  served = 777;
  atlas.select(775);
  await settle();
  assert.deepEqual(shown.slice(6), [null, null]);

  served = 775;
  atlas.select(777);
  atlas.select(775);
  await settle();
  assert.deepEqual(shown.slice(8), [null, null, 775]);
});
