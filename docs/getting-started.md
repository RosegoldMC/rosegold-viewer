---
title: Getting started
description: Add Rosegold Viewer to a Crystal bot, build a local texture pack, and open the viewer.
---

# Getting started

You need Crystal 1.17 or newer and a Rosegold bot for Minecraft Java 26.1 or 26.3. The viewer runs inside that bot process, so there's nothing else to deploy.

## 1. Add the shard

In your bot's `shard.yml`:

```yaml
dependencies:
  rosegold-viewer:
    github: RosegoldMC/rosegold-viewer
    version: ~> 0.3.0
```

Then run `shards install`.

## 2. Build a texture pack

The viewer draws from a pack you prepare locally. Use your own Minecraft Java 26.1.x (26.1 through 26.1.2) or 26.3 client JAR from the launcher's `versions` folder, such as `versions/26.1.2/26.1.2.jar` or `versions/26.3/26.3.jar`. The pack must match the bot's connection version. The shard doesn't redistribute textures.

```sh
crystal run lib/rosegold-viewer/tools/build-pack.cr -- /path/to/26.3.jar ./viewer-pack
export VIEWER_PACK="$PWD/viewer-pack"
```

To override textures with a resource pack, add `--resource-pack /path/to/resource-pack.zip`. Choose a new output directory, because the builder won't overwrite an existing pack. `VIEWER_PACK` must point at that directory, not at a ZIP file.

The builder needs `pkg-config` and libpng development files (`libpng-dev` on Debian or Ubuntu, `libpng` with Homebrew). See the [pack builder notes](https://github.com/RosegoldMC/rosegold-viewer/blob/main/tools/README.md#build-a-local-viewer-pack) for what it converts and what falls back. Without a pack the viewer still runs, untextured.

## 3. Mount it on your bot

Require Rosegold first, then the shard:

For 26.1, use `require "rosegold/26.1"` or keep your existing `require "rosegold"`.

```crystal
require "rosegold/26.3"
require "rosegold-viewer"

viewer = RosegoldViewer::Host.new(pack_directory: ENV["VIEWER_PACK"])
begin
  if STDOUT.tty? && (pairing = viewer.enable)
    puts "Viewer: #{pairing.url}"
    puts "Pairing secret: #{pairing.secret}"
  end

  Rosegold::Bot.run("localhost", on_session: ->(bot : Rosegold::Bot) { viewer.bind(bot) }) do |bot|
    bot.wait_ticks 1_200
  end
ensure
  viewer.disable
end
```

Keep one host outside `Bot.run` and bind each new session to it, so the viewer survives reconnects. If you already have a single `bot`, `RosegoldViewer.mount(bot, pack_directory: ENV["VIEWER_PACK"])` returns a bound host that you start with `viewer.enable`.

The example prints the pairing details only on an interactive terminal, so the secret doesn't end up in a log. You can also call `viewer.enable` later in the script. The host listens on loopback by default.

## 4. Open it

Open the printed URL and enter the separate pairing secret. A read-only browser can come and go without interrupting the bot.

- To use it from a phone, [set up private HTTPS](private-access.html).
- To let someone take over the bot, allow it per session, then see [Watching and taking control](controls.html):

```crystal
on_session: ->(bot : Rosegold::Bot) do
  viewer.bind(bot)
  bot.client.intervention.permitted = true
end
```

The repository's `examples/minimal_bot.cr` is a runnable version of this page.
