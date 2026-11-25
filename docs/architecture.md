---
title: How the viewer works
---

# How the viewer works

The browser doesn't log into Minecraft. Your Crystal bot holds the game connection, and the viewer mounts on that bot. You can run the script without a browser, or enable the host later when something is worth watching.

## From a server update to a frame

Rosegold receives the server's packets and updates the bot's world. The shard's feed reads that state and sends terrain, entity and HUD updates to a paired browser. The TypeScript frontend uses bounded HTTP polling: `/session` pairs the browser and `/next` requests the next batch. No relay service or WebSocket server is required.

The browser builds geometry and draws it directly with WebGL 2. The terrain atlas supplies block faces and item icons. Separate entity textures and GUI sprites supply the animals and inventory UI. The host serves the prepared pack locally; no client JAR or resource-pack ZIP needs to be uploaded. The renderer supports selected block and entity models, not every feature of a vanilla client or every custom resource pack.

## Texture pack direction

Vanilla textures are the base layer. Prepare them from your local client JAR, then apply a resource-pack ZIP for the textures it replaces. Missing textures in the overlay use the vanilla base. The prepared assets belong to the viewer host, not the bot script.

Longer term, we'd like a pack picker where an operator can upload a resource-pack ZIP, switch packs, or go back to vanilla. oCd is a candidate for a ready-to-select preset. Bundling or hosting it depends on permission for the specific edition and port. Browser uploads and a built-in oCd pack aren't part of the current local import flow.

## Showing what the script intends to do

`viewer.draw_path("route", points)` draws the route supplied by your script. Reuse the name to replace it, pass one point for a marker, or call `viewer.clear_path("route")` to remove it. Drawing a route doesn't move the bot. The host accepts up to eight named paths and 128 points total.

For a known player, `viewer.set_player_skin(uuid, path, slim: true)` registers a local skin PNG. The host does not fetch a skin URL or look up a player account. Use a local file you're allowed to share with the people who can pair with your viewer.

## From a touch to a bot action

Pairing gives the browser a view, not permission to move. When the script permits intervention and the operator takes control, keyboard or touch input goes back through the host to Rosegold's native controls. The bot remains the player on the server. **Resume script** hands control back at the script's checkpoint; it doesn't log in a replacement bot.

## Build and runtime

Crystal and Shards build the host into the bot. Node and npm are frontend contributor tools: they compile TypeScript and rebuild the HTML, CSS, and JavaScript in `web/dist/`. The Crystal compiler embeds those three files, so changing frontend source requires rebuilding the bundle and then the bot. Preparing a texture pack is a separate local step; changing packs does not require rebuilding the JavaScript.
