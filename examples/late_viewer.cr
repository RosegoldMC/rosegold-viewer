require "rosegold/26.3"
require "../src/rosegold-viewer"

port = ARGV[0]?.try(&.to_i) || 25565
host = RosegoldViewer::Host.new
offline = {uuid: "00000000-0000-0000-0000-000000000000", username: "viewer_example"}
ticks = 0
viewer_enabled = false

begin
  Rosegold::Bot.run("127.0.0.1", port: port, offline: offline) do |bot|
    host.bind(bot)
    while bot.connected?
      bot.wait_tick
      ticks += 1
      case ticks
      when 1
        heading = bot.look.with_pitch(0_f32)
        forward = heading.to_vec3
        right = heading.with_yaw(heading.yaw - 90).to_vec3
        start = bot.location.up(0.25) + forward * 2
        turn = start + forward * 2
        host.draw_path("example", [start, turn, turn + right])
        bot.look = heading.down(25)
      when 100
        if STDOUT.tty?
          if pairing = host.enable
            viewer_enabled = true
            puts "Open #{pairing.url} in your browser."
            puts "Pairing secret: #{pairing.secret}"
          end
        else
          puts "Viewer skipped: stdout is not a terminal."
        end
      when 700
        if viewer_enabled
          host.disable
          puts "Viewer disabled."
        end
      end
      puts "Bot ticks: #{ticks}" if ticks.divisible_by?(100)
    end
  end
ensure
  host.disable
end
