require "./spec_helper"
require "compress/zlib"
require "digest/crc32"
require "digest/sha256"

private def chunk(type : String, data : Bytes) : Bytes
  io = IO::Memory.new
  io.write_bytes(data.size.to_u32, IO::ByteFormat::BigEndian)
  body = IO::Memory.new
  body << type
  body.write(data)
  io.write(body.to_slice)
  io.write_bytes(Digest::CRC32.checksum(body.to_slice), IO::ByteFormat::BigEndian)
  io.to_slice
end

private def skin_png(text : Bool = false) : Bytes
  header = IO::Memory.new
  header.write_bytes(64_u32, IO::ByteFormat::BigEndian)
  header.write_bytes(64_u32, IO::ByteFormat::BigEndian)
  header.write(Bytes[8, 6, 0, 0, 0])
  raw = IO::Memory.new
  64.times { raw.write_byte(0_u8); raw.write(Bytes.new(64 * 4, 7_u8)) }
  compressed = IO::Memory.new
  Compress::Zlib::Writer.open(compressed) { |zlib| zlib.write(raw.to_slice) }
  out = IO::Memory.new
  out.write(PNG_HEADER)
  out.write(chunk("IHDR", header.to_slice))
  out.write(chunk("tEXt", "k\0v".to_slice)) if text
  out.write(chunk("IDAT", compressed.to_slice))
  out.write(chunk("IEND", Bytes.empty))
  out.to_slice
end

private def get(url : String, path : String) : HTTP::Client::Response
  HTTP::Client.get(url + path)
end

describe RosegoldViewer::Host do
  it "serves pack files from the supplied directory and nothing else" do
    with_temp_dir do |dir|
      File.write(File.join(dir, "atlas.png"), png_bytes)
      File.write(File.join(dir, "notes.txt"), "private")
      host = RosegoldViewer::Host.new(pack_directory: dir)
      pairing = host.enable.not_nil!
      begin
        get(pairing.url, "/local-pack/atlas.png").status_code.should eq 200
        get(pairing.url, "/local-pack/notes.txt").status_code.should eq 404
        get(pairing.url, "/local-pack/entities.png").status_code.should eq 404
        get(pairing.url, "/local-pack/gui/..%2Fatlas.png").status_code.should eq 404
        get(pairing.url, "/").status_code.should eq 200
      ensure
        host.disable
      end
    end
  end

  it "answers pack requests as not found without a pack" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    begin
      get(pairing.url, "/local-pack/atlas.png").status_code.should eq 404
    ensure
      host.disable
    end
  end

  it "requires the pairing secret for sessions" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    begin
      origin = HTTP::Headers{"Origin" => pairing.url}
      HTTP::Client.post(pairing.url + "/session", origin).status_code.should eq 401
      origin["Authorization"] = "Bearer #{pairing.secret}"
      response = HTTP::Client.post(pairing.url + "/session", origin)
      response.status_code.should eq 200
    ensure
      host.disable
    end
  end

  it "does not print the pairing secret" do
    host = RosegoldViewer::Host.new
    pairing = host.enable.not_nil!
    begin
      pairing.inspect.should_not contain pairing.secret
    ensure
      host.disable
    end
  end
end

describe RosegoldViewer::HTTPS do
  it "requires a private IPv4 bind address and a canonical origin" do
    expect_raises(ArgumentError) { RosegoldViewer::HTTPS.new(bind_address: "8.8.8.8", origin: "https://example.test", certificate_chain: "", private_key: "") }
    expect_raises(ArgumentError) { RosegoldViewer::HTTPS.new(bind_address: "127.0.0.1", origin: "http://example.test", certificate_chain: "", private_key: "") }
    expect_raises(ArgumentError) { RosegoldViewer::HTTPS.new(bind_address: "127.0.0.1", origin: "https://example.test:443", certificate_chain: "", private_key: "") }
    https = RosegoldViewer::HTTPS.new(bind_address: "10.0.0.2", origin: "https://viewer.example.test:8443", certificate_chain: "", private_key: "")
    https.port.should eq 8443
  end
end

describe "player skins" do
  it "accepts only a bounded local PNG skin and never fetches" do
    with_temp_dir do |dir|
      host = RosegoldViewer::Host.new
      uuid = UUID.random
      host.set_player_skin(uuid, "https://example.test/skin.png").should be_false
      host.set_player_skin(uuid, File.join(dir, "missing.png")).should be_false
      File.write(File.join(dir, "bad.png"), png_bytes(100))
      host.set_player_skin(uuid, File.join(dir, "bad.png")).should be_false

      raw = skin_png(text: true)
      File.write(File.join(dir, "skin.png"), raw)
      host.set_player_skin(uuid, File.join(dir, "skin.png")).should be_true
      stripped = skin_png
      pairing = host.enable.not_nil!
      begin
        HTTP::Client.get("#{pairing.url}/local-pack/skins/#{Digest::SHA256.hexdigest(stripped)}.png").body.to_slice.should eq stripped
        HTTP::Client.get("#{pairing.url}/local-pack/skins/#{Digest::SHA256.hexdigest(raw)}.png").status_code.should eq 404
      ensure
        host.disable
      end
    end
  end
end
