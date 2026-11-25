# Working on Rosegold Viewer

This shard mounts a web viewer on a Rosegold bot. The bot owns the Minecraft connection and can run without a browser. Keep examples independent of any particular world, server, or script. Pairing starts read-only. Treat the browser lease, the script's grant, and the current PLAY session as separate lifetimes when handling input.

`src/rosegold_viewer/` contains the Crystal host, browser feed and native input adapter. The textured renderer lives in `web/src/`. Changes to feed records usually need changes in both `feed.cr` and `web/src/wire.ts`. Keep examples on the shard's public API, not on internal feed records.

Work on frontend source, then rebuild `web/dist` with `npm ci` and `npm run build` from `web/`. Include the regenerated files with the source change: the Crystal compiler embeds them in the host. Rebuild the bot binary before testing browser changes. Node is not required to run the compiled bot.

Keep local resource packs, client jars, pairing files, skins, world saves, and private server configuration out of git. Test pack loading with synthetic inputs. For release media, use an original scene and artwork cleared for that use. `docs/history/early-prototype/` documents the earlier solid-color renderer; new screenshots must show the current textured shard installed in a separate consumer bot.

Run `crystal tool format --check src spec examples` and `crystal spec` after backend changes. Verify that a fresh consumer can mount the viewer without a sibling checkout or `shard.override.yml`. A passing build does not establish that the browser renders terrain or that manual handback resumes the script; exercise both in a local gameplay test when changing those paths.
