{% unless @top_level.has_constant?("Rosegold") %}
  {% raise "Require \"rosegold/26.3\" or \"rosegold\" before \"rosegold-viewer\"" %}
{% end %}

require "./rosegold_viewer/loopback_host"
require "./rosegold_viewer/feed"
require "./rosegold_viewer/pack"
require "./rosegold_viewer/host"

module RosegoldViewer
  # Binds a viewer to *bot* and returns it disabled; call `Host#enable` to start serving and hand
  # the returned pairing to the person who should open it. Call `Host#bind` again after each
  # reconnect that yields a new bot.
  def self.mount(bot : Rosegold::Bot, *, pack_directory : String? = nil, https : HTTPS? = nil, lease_timeout : Time::Span = 15.seconds) : Host
    Host.new(lease_timeout, https: https, pack_directory: pack_directory).tap(&.bind(bot))
  end
end
