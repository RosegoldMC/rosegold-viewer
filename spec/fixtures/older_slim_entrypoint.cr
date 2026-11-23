require "rosegold/26.2"
require "../../src/rosegold-viewer"

host = RosegoldViewer::Host.new
host.bind(Rosegold::Bot.new("127.0.0.1"))
host.enable
host.disable
