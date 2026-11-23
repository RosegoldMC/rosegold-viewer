{% unless @top_level.has_constant?("Rosegold") %}
  {% raise "Require \"rosegold/26.3\" or \"rosegold\" before \"rosegold-viewer\"" %}
{% end %}

require "./rosegold_viewer/loopback_host"
require "./rosegold_viewer/feed"
require "./rosegold_viewer/host"
