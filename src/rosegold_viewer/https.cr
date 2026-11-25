require "openssl"
require "socket"

module RosegoldViewer
  class HTTPS
    private DNS_LABEL = /\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\z/

    getter bind_address : String
    getter origin : String
    getter authority : String
    getter port : Int32

    def initialize(*, @bind_address : String, @origin : String, @certificate_chain : String, @private_key : String)
      unless private_ipv4?(@bind_address)
        raise ArgumentError.new("Viewer HTTPS requires a specific private, shared, or loopback IPv4 bind address")
      end

      match = /\Ahttps:\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?\z/.match(@origin)
      unless match && canonical_host?(match[1])
        raise ArgumentError.new("Viewer HTTPS requires a canonical https://host[:port] origin")
      end
      explicit_port = match[2]?.try(&.to_i)
      if explicit_port && (explicit_port == 443 || explicit_port > 65535)
        raise ArgumentError.new("Viewer HTTPS port must be 1–65535; omit the port for 443")
      end
      @port = explicit_port || 443
      @authority = @origin.lchop("https://")
    end

    protected def context : OpenSSL::SSL::Context::Server
      OpenSSL::SSL::Context::Server.new.tap do |context|
        context.certificate_chain = @certificate_chain
        context.private_key = @private_key
      end
    end

    private def canonical_ipv4?(address : String) : Bool
      Socket::IPAddress.valid_v4?(address) && Socket::IPAddress.new(address, 0).address == address
    end

    private def private_ipv4?(address : String) : Bool
      return false unless canonical_ipv4?(address)
      a, b, _, _ = address.split('.').map(&.to_i)
      a == 10 || a == 127 || (a == 172 && (16..31).includes?(b)) || (a == 192 && b == 168) || (a == 100 && (64..127).includes?(b))
    end

    private def canonical_host?(host : String) : Bool
      return true if canonical_ipv4?(host)
      labels = host.split('.')
      host.bytesize <= 253 && !labels.last.matches?(/\A(?:[0-9]+|0x[0-9a-f]*)\z/) &&
        labels.all?(&.matches?(DNS_LABEL))
    end
  end
end
