# Terrain renderer

Open `dist/fixture.html` directly in a WebGL2 browser to see synthetic terrain and a path through it. It needs no server or network access. The terrain colors are assigned by state ID, fullbright, and every non-air state is drawn as a solid cube.

## Viewer page

The loopback host serves `dist/index.html`, `dist/viewer.css`, and `dist/viewer-bundle.js`. These 3 files are independent of the fixture. Open the viewer URL and paste the separate pairing secret. Detach stops polling and clears the scene; the lease expires on the host.

The page keeps the secret and lease in memory. It limits pull requests to one at a time, polls more slowly while hidden, and resets the scene after a world change or a bad reply. A 204 pull leaves the current scene and cursor intact.

## Renderer API

Import `TerrainRenderer` from `dist/renderer.js` and serve `terrain.js` and `camera.js` beside it. The fixture bundle is separate. Size the canvas in CSS independently of its pixel dimensions; the renderer sizes the drawing buffer.

```ts
const renderer = new TerrainRenderer(canvas, { airStateIds, onStatus });
renderer.replaceSection([sx, sy, sz], states);
renderer.setPaths([{ name: "route", color: 0x54F4FF, points: [[2.5, 3, 4.5], [5.5, 3, 8.5]] }]);
renderer.setPose([eyeX, eyeY, eyeZ], [lookX, lookY, lookZ], yawDegrees);
```

- Pass all air state IDs for the negotiated protocol, or normalize them to one ID before passing sections. Every other state, including fluids, occludes neighboring voxel faces.
- Section coordinates are signed 32-bit section indices. `states` is a `Uint16Array` of 4,096 states indexed by `x + 16 * z + 256 * y`. The renderer keeps its own copy. `null`, all-air data, and `removeSection(position)` all erase existing geometry. Unloaded neighbors leave the shared face exposed.
- `setPaths` replaces all paths. Points use world coordinates, and the color is a packed RGB integer. Each point gets a waypoint marker, and terrain can hide both the lines and markers. Pass `[]` to remove the paths.
- Pose uses world-space Minecraft eye coordinates, a nonzero forward vector, and finite Minecraft yaw in degrees. `clear()` drops the scene and pose, so set a fresh pose after a world reset. `dispose()` also releases GPU objects and listeners.
- `onStatus` first reports the state during construction. It reports `unavailable` if WebGL2 cannot start, `lost` on context loss, and `ready` on recovery. The renderer keeps the latest scene and pose during context loss. Feed/session changes belong to the caller.

## Build

From `web/`, rebuild after changing TypeScript or the fixture:

```sh
npm ci
npm run build
npm test
npm run check:dist
```

Keep `dist/` in the repository. Using the generated files does not require Node or npm.
