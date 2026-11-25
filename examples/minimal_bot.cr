require "rosegold/26.3"
require "../src/rosegold-viewer"

# Usage: crystal run examples/minimal_bot.cr [-- --intervene]
# Set VIEWER_PACK to a locally built pack directory for textures; without it the viewer is untextured.
# The viewer starts only on an interactive terminal, and --intervene lets its operator take over the script.
intervene = ARGV.includes?("--intervene")
viewer = RosegoldViewer::Host.new(pack_directory: ENV["VIEWER_PACK"]?)

if STDOUT.tty? && (pairing = viewer.enable)
  puts "Viewer: #{pairing.url}"
  puts "Secret: #{pairing.secret}"
end

begin
  session = ->(bot : Rosegold::Bot) do
    viewer.bind(bot)
    bot.client.intervention.permitted = true if intervene
  end

  Rosegold::Bot.run("localhost", on_session: session) do |bot|
    bot.wait_ticks 20 * 60 * 60
  end
ensure
  viewer.disable
end
