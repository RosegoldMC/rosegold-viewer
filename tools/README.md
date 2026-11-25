# Build a local viewer pack

You'll need Crystal, libpng development files, and the Minecraft Java 26.3 client JAR (protocol 777). Look for `versions/26.3/26.3.jar` in your launcher's game folder. The server JAR doesn't have the textures. The builder reads the JAR as a ZIP and doesn't run Java or contact any servers.

Install `pkg-config` and `libpng-dev` on Debian or Ubuntu, or `pkg-config` and `libpng` with Homebrew on macOS. These are for the pack builder, not the viewer host. From a bot project that has this shard installed, run:

```sh
crystal run lib/rosegold-viewer/tools/build-pack.cr -- /path/to/versions/26.3/26.3.jar /path/to/new-pack
```

From this shard's own checkout, use `tools/build-pack.cr` instead.

To layer a resource pack over the vanilla art, add `--resource-pack /path/to/pack.zip`. The ZIP should contain `assets/minecraft/` at its root. Some older packs work; if `pack.mcmeta` declares a different resource format, expect a warning and check the result. Pack overlays and filters aren't supported. Missing or incompatible sprites can fall back to vanilla. Unsafe archive paths, oversized members, and malformed pack metadata stop the build.

Point the viewer's `pack_directory` at the output directory. It contains `atlas.json`, `atlas.png`, `entities.json`, `entities.png`, and `gui/*.png`. Choose a new directory whose parent exists and is on a local filesystem that supports hard links. Keep it out of git, just like the input JAR and ZIP. Regenerate older packs to restore the scene shapes; unrelated textures still work.

## What gets built

- Terrain: common shapes, crops, water and lava, and breaking overlays. Static opaque full cubes can resolve vanilla or pack blockstates and model inheritance. The cube resolver checks orientations and accepts weighted variants only when they yield the same pixels for a state. The builder also reads local model geometry and face textures for the supported slabs, wall, lily pad, campfire, hopper, and trapdoor. It uses the first weighted alternative for those shapes. If an overlay model is incomplete or exceeds the atlas budget, that state keeps its client JAR model and textures. Single chests use an approximation textured from the local chest sprite.
- Items: representative flat sprites from supported item models, plus block thumbnails and cube faces when available. Unhandled model features, item conditions, and item tints can differ from the game. The 1,216-tile atlas gives terrain priority, so some supported item icons won't fit. The builder prints coverage and omission counts.
- Entities: temperate cow, pig and chicken, sheep and its wool layers, plains villager without profession layers, and the default wide and slim player skins. These use the original UV layout and image sizes. Custom player skins aren't read from a resource pack.
- GUI: HUD icons and backgrounds for the supported inventories. Container textures are cropped to the menu size and stitched for different chest sizes.

This doesn't implement the full Minecraft resource-pack renderer. Unsupported blocks use the viewer's fallback; most multipart models, modded namespaces, and arbitrary entity models aren't converted. Most non-liquid animations use their first frame or aren't included. Input archives are bounded and never extracted. Images are checked before decoding and re-encoded without input metadata.

## Tests

```sh
crystal spec tools/spec
```

The tests generate their own images and ZIPs. They don't need a Minecraft installation or a resource pack.

`states-26.3.json` records protocol state IDs, property order, and opaque/invisible flags from the 26.3 client registry. It has no model selections or texture bindings. The builder writes those to your local `atlas.json` with the geometry it reads from your JAR and optional ZIP. The shard does not distribute that model data or artwork. Only serve a generated pack where you have permission to share its contents.
