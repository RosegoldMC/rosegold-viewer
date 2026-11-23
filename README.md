# Rosegold Viewer

Add a local browser view to a Rosegold bot. It shows the terrain the bot has loaded on Minecraft Java 26.3, with solid cubes and fullbright colors. The bot can start headless and keep running when you close the tab or disable the viewer.

## Run the example

Use Crystal 1.19.1 and a local Minecraft 26.3 server in offline mode. Pass its port if it differs from 25565.

```sh
shards install
crystal run examples/late_viewer.cr
```

The example draws a short path in front of the bot and looks down at it before opening the viewer. With stdout connected to a terminal, it prints a URL and a separate pairing secret after 100 bot ticks. Open the URL in a WebGL2 browser, then paste the secret into the page. The example shuts off the viewer after another 600 ticks and keeps printing bot ticks. Only run it in a terminal where you're comfortable displaying the secret. If you redirect stdout or pipe it through `tee`, the bot stays headless and does not print a secret.

## Use it in a bot

Add `rosegold-viewer` to your shards. Require `rosegold/26.3` first (or `rosegold` for the full build), then `rosegold-viewer`. Create a `RosegoldViewer::Host` outside `Bot.run` and call `host.bind(bot)` each time `Bot.run` yields. When you want to view, `host.enable` returns the URL and secret, or `nil` if the listener couldn't start. Call `host.disable` when you're done. Keep these calls on the bot's scheduler thread.

The viewer listens on `127.0.0.1`. A new pairing replaces the previous tab, and inactive tabs expire. Keep the secret local and out of logs. Re-enabling after disable creates a new URL and secret. Check your server's rules before using the viewer; access to the bot's world state does not imply permission to display it. The CivMC facade does not import this companion.

## Draw paths and waypoints

A bound, spawned bot can draw before a browser pairs:

```crystal
start = bot.location.up(0.25)
host.draw_path("route", [start, start.east(2)], color: 0x39e4ff_u32)
host.draw_path("waypoint", [start.north(2)])
host.clear_path("route")
```

Use `Rosegold::Vec3i` or `Rosegold::Vec3d` points. Each point gets a marker, and consecutive points are connected. Raise points slightly if they sit exactly on the floor, where terrain can hide them. Drawing with the same name replaces the path. An empty list removes it.

Names take 1 to 32 ASCII letters, digits, underscores, or hyphens. Colors are 24-bit RGB. Coordinates must be within ±30 million blocks on each axis. The viewer keeps up to 8 paths and 128 points total. `draw_path` returns `false` if the bot is not ready or the path is invalid, leaving existing paths alone.

Paths survive browser re-pairing in the same world. They clear when the bot respawns, changes worlds or disconnects, when you bind again, or when you disable the viewer.

## Development

The browser bundle is embedded in the Crystal program. Node and npm are only needed to work on the frontend:

```sh
cd web
npm ci
npm run build
npm run check:dist
npm test
```

Include the matching `web/dist` files when changing the frontend.
