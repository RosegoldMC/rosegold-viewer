require "crypto/subtle"
require "json"
require "random/secure"
require "./pack"
require "./pull_request"

module RosegoldViewer
  class Host
    private Log  = ::Log.for(self)
    private HTML = {{ read_file((env("ROSEGOLD_VIEWER_DIST") || "#{__DIR__}/../../web/dist") + "/index.html") }}
    private JS   = {{ read_file((env("ROSEGOLD_VIEWER_DIST") || "#{__DIR__}/../../web/dist") + "/viewer-bundle.js") }}
    private CSS  = {{ read_file((env("ROSEGOLD_VIEWER_DIST") || "#{__DIR__}/../../web/dist") + "/viewer.css") }}
    private alias Request = LoopbackHost::Request
    private alias Reply = LoopbackHost::Reply

    record Pairing, url : String, secret : String do
      def inspect(io : IO) : Nil
        io << "RosegoldViewer::Host::Pairing(" << url << ')'
      end

      def pretty_print(pp : PrettyPrint) : Nil
        pp.text(inspect)
      end
    end

    private class Lease
      getter token : String = Random::Secure.hex(32)
      property expires_at : Time::Instant

      def initialize(@expires_at)
      end
    end

    private class Generation
      getter secret : String = Random::Secure.hex(32)
      getter stopped = Channel(Nil).new
      property pairing : Pairing?
      property lease : Lease?
    end

    @transport = LoopbackHost.new
    @feed = Feed.new
    @pack : Pack?
    @generation : Generation?

    # *pack_directory* is a locally supplied, already-built texture pack (see `Pack`); without it the
    # viewer serves untextured placeholders. *https* is required to expose the viewer beyond loopback.
    def initialize(@lease_timeout : Time::Span = 15.seconds, *, @https : HTTPS? = nil, pack_directory : String? = nil)
      @pack = pack_directory.try { |directory| Pack.new(directory) }
      raise ArgumentError.new("Lease timeout must be positive") unless @lease_timeout.positive?
    end

    def inspect(io : IO) : Nil
      to_s(io)
    end

    def pretty_print(pp : PrettyPrint) : Nil
      pp.text(inspect)
    end

    def bind(bot : Rosegold::Bot) : Nil
      @feed.bind(bot)
    end

    def set_player_skin(uuid : UUID, path : String, *, slim : Bool = false) : Bool
      @feed.set_player_skin(uuid, path, slim: slim)
    end

    # Draws or replaces a named path in the bound bot's world. One point draws a marker,
    # and an empty enumerable removes the path. Returns false if the bot is not ready or the path is invalid.
    def draw_path(name : String, points : Enumerable(T), *, color : UInt32 = 0x39e4ff_u32) : Bool forall T
      @feed.draw_path(name, points, color: color)
    end

    # Removes a named path from the bound bot's world.
    def clear_path(name : String) : Nil
      @feed.clear_path(name)
    end

    def enable : Pairing?
      if current = @generation
        return current.pairing if @transport.active?
        stop
      end

      @generation = generation = Generation.new
      url = @transport.enable(@https) { |request| respond(generation, request) }
      unless url
        stop
        return
      end

      pairing = generation.pairing = Pairing.new(url, generation.secret)
      @feed.control.enable
      spawn(name: "viewer lease", same_thread: true) { watch(generation) }
      pairing
    rescue
      stop
      Log.warn { "Could not enable the viewer" }
      nil
    end

    def disable : Nil
      @feed.clear_paths
    ensure
      stop
    end

    private def stop : Nil
      generation = @generation
      @generation = nil
      @feed.control.disable
      if generation
        generation.lease = nil
        generation.stopped.close
        @feed.detach
      end
    rescue
      Log.warn { "Could not detach the viewer feed" }
    ensure
      @transport.disable
    end

    private def watch(generation : Generation) : Nil
      interval = Math.min(@lease_timeout, 1.second)
      loop do
        select
        when generation.stopped.receive?
          return
        when timeout(interval)
        end
        return unless @generation.same?(generation)
        unless @transport.active?
          stop
          return
        end
        live_lease(generation)
      end
    end

    private def respond(generation : Generation, request : Request) : Reply
      return Reply.new(:service_unavailable) unless @generation.same?(generation)
      case {request.method, request.resource}
      when {"GET", "/"}
        Reply.new(body: HTML, content_type: "text/html; charset=utf-8")
      when {"GET", "/viewer-bundle.js"}
        Reply.new(body: JS, content_type: "text/javascript; charset=utf-8")
      when {"GET", "/viewer.css"}
        Reply.new(body: CSS, content_type: "text/css; charset=utf-8")
      when {"GET", /\A\/local-pack\/(?:atlas|entities)\.(?:png|json)\z|\A\/local-pack\/gui\/[a-z0-9_]+\.png\z/}
        asset = @pack.try &.[request.resource.lchop("/local-pack/")]?
        asset ? Reply.new(body: asset.bytes, content_type: asset.content_type) : Reply.new(:not_found)
      when {"POST", "/session"}
        pair(generation, request)
      when {"POST", "/next"}
        pull(generation, request)
      when {"POST", "/chat"}
        send_chat(generation, request)
      else
        if request.method == "GET" && (skin = /\A\/local-pack\/skins\/([0-9a-f]{64})\.png\z/.match(request.resource)) && (bytes = @feed.skin_asset(skin[1]))
          return Reply.new(body: bytes, content_type: "image/png")
        end
        Reply.new(:not_found)
      end
    end

    private def pair(generation : Generation, request : Request) : Reply
      return Reply.new(:unauthorized) unless authorized?(request, generation.secret)
      return Reply.new(:bad_request) unless request.body.empty?
      return Reply.new(:service_unavailable) unless @generation.same?(generation)

      lease = Lease.new(Time.instant + @lease_timeout)
      @feed.control.cancel if generation.lease
      generation.lease = nil
      @feed.attach(-> do
        @generation.same?(generation) && generation.lease.same?(lease) && @transport.active? && Time.instant < lease.expires_at
      end)
      return feed_error(generation) if @feed.failure

      generation.lease = lease
      Reply.new(body: {lease: lease.token}.to_json, content_type: "application/json")
    end

    private def pull(generation : Generation, request : Request) : Reply
      lease = live_lease(generation)
      return Reply.new(:unauthorized) unless lease && authorized?(request, lease.token)
      return Reply.new(:unsupported_media_type) unless exact_header?(request, "Content-Type", "application/json")
      body = request.body
      return Reply.new(:unauthorized) unless live_lease(generation).same?(lease)
      pull = PullRequest.read(body)
      return Reply.new(:bad_request) unless pull

      deadline = Time.instant + @lease_timeout
      batch = @feed.pull(pull.epoch, pull.sequence, pull.input, deadline, pull.debug)
      return feed_error(generation) if @feed.failure || (batch && batch.size > Feed::MAX_BATCH)
      return Reply.new(:unauthorized) unless live_lease(generation).same?(lease)

      lease.expires_at = Time.instant + @lease_timeout
      if batch
        Reply.new(body: batch, content_type: "application/octet-stream")
      else
        Reply.new(:no_content)
      end
    end

    private def send_chat(generation : Generation, request : Request) : Reply
      lease = live_lease(generation)
      return Reply.new(:unauthorized) unless lease && authorized?(request, lease.token)
      return Reply.new(:unsupported_media_type) unless exact_header?(request, "Content-Type", "application/json")
      body = request.body
      return Reply.new(:unauthorized) unless live_lease(generation).same?(lease)
      chat = ChatRequest.read(body)
      return Reply.new(:bad_request) unless chat

      Reply.new(@feed.send_chat(chat))
    end

    private def live_lease(generation : Generation) : Lease?
      return unless @generation.same?(generation)
      return unless lease = generation.lease
      if @feed.failure
        feed_error(generation)
      elsif lease.expires_at <= Time.instant
        revoke(generation)
      else
        return lease
      end
      nil
    end

    private def revoke(generation : Generation) : Nil
      generation.lease = nil
      @feed.detach
    end

    private def feed_error(generation : Generation) : Reply
      reason = @feed.failure.try(&.class.name) || "oversized batch"
      revoke(generation)
      Log.warn { "Viewer feed stopped (#{reason})" }
      Reply.new(:internal_server_error)
    end

    private def authorized?(request : Request, token : String) : Bool
      values = request.headers.get?("Authorization")
      !!(values && values.size == 1 && Crypto::Subtle.constant_time_compare(values.first, "Bearer #{token}"))
    end

    private def exact_header?(request : Request, name : String, value : String) : Bool
      values = request.headers.get?(name)
      !!(values && values.size == 1 && values.first == value)
    end
  end
end
