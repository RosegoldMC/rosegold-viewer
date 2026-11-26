module RosegoldViewer
  def self.supports_protocol?(protocol : UInt32) : Bool
    {775_u32, 777_u32}.includes?(protocol) && Rosegold::Client::SUPPORTED_PROTOCOLS.includes?(protocol)
  end

  def self.pack_matches?(protocol : UInt32, pack_protocol : Float64?) : Bool
    pack_protocol.nil? || pack_protocol == protocol
  end
end
