require "spec"
require "file_utils"
require "../pack_assets"

include PackBuilder

A = {225_u8, 54_u8, 117_u8, 255_u8}
B = {66_u8, 204_u8, 90_u8, 255_u8}

def scratch(&)
  dir = File.join(Dir.tempdir, "pack-assets-spec-#{Process.pid}-#{Random.rand(1_000_000)}")
  Dir.mkdir_p(dir)
  begin
    yield dir
  ensure
    FileUtils.rm_rf(dir)
  end
end

def png_bytes(dir : String, image : Image) : Bytes
  path = File.join(dir, "#{Random.rand(1_000_000)}.png")
  image.write_png(path)
  File.read(path).to_slice
end

def chunk(kind : String, body : Bytes = Bytes.empty) : Bytes
  io = IO::Memory.new
  io.write_bytes(body.size.to_u32, IO::ByteFormat::BigEndian)
  io.write(kind.to_slice)
  io.write(body)
  io.write_bytes(Digest::CRC32.checksum(kind.to_slice.to_a.concat(body.to_a).map(&.to_u8).to_unsafe.to_slice(body.size + 4)), IO::ByteFormat::BigEndian)
  io.to_slice
end

def with_chunk(png : Bytes, kind : String, body : Bytes) : Bytes
  io = IO::Memory.new
  io.write(png[0, 33])
  io.write(chunk(kind, body))
  io.write(png[33..])
  io.to_slice
end

def write_zip(path : String, files : Array(Tuple(String, Bytes)), method = Compress::Zip::CompressionMethod::DEFLATED) : Nil
  File.open(path, "w") do |file|
    Compress::Zip::Writer.open(file) do |zip|
      files.each do |name, data|
        entry = Compress::Zip::Writer::Entry.new(name)
        entry.compression_method = method
        zip.add(entry) { |io| io.write(data) }
      end
    end
  end
end

def version_json(id = "26.3", protocol = 777) : Bytes
  %({"id":"#{id}","protocol_version":#{protocol}}).to_slice
end

def jar(dir : String, extra = [] of Tuple(String, Bytes), name = "client.jar") : String
  path = File.join(dir, name)
  write_zip(path, [{"version.json", version_json}, {ASSETS + "blockstates/stone.json", "{}".to_slice}] + extra)
  path
end

describe PackBuilder::Image do
  it "stores and bounds-checks pixels" do
    image = Image.new(2, 2, A)
    image.pixel(1, 1).should eq A
    image.set_pixel(0, 1, B)
    image.pixel(0, 1).should eq B
    image.pixels.size.should eq 16
    expect_raises(Error) { image.pixel(2, 0) }
    expect_raises(Error) { Image.new(0, 4) }
    Image.new(1, 1).pixel(0, 0).should eq({0_u8, 0_u8, 0_u8, 0_u8})
  end

  it "crops, with transparent overflow" do
    image = Image.new(2, 2, A)
    image.set_pixel(1, 1, B)
    crop = image.crop(1, 1, 2, 2)
    crop.pixel(0, 0).should eq B
    crop.pixel(1, 1).should eq({0_u8, 0_u8, 0_u8, 0_u8})
  end

  it "resizes by nearest neighbour" do
    image = Image.new(2, 1, A)
    image.set_pixel(1, 0, B)
    big = image.resize(4, 2)
    [0, 1].each { |x| big.pixel(x, 1).should eq A }
    [2, 3].each { |x| big.pixel(x, 0).should eq B }
    image.resize(1, 1).pixel(0, 0).should eq B
  end

  it "pastes with clipping" do
    base = Image.new(3, 3, A)
    base.paste(Image.new(2, 2, B), 2, -1)
    base.pixel(2, 0).should eq B
    base.pixel(1, 0).should eq A
    base.pixel(2, 1).should eq A
  end

  it "composites source-over" do
    base = Image.new(1, 1, {0_u8, 0_u8, 255_u8, 255_u8})
    base.composite(Image.new(1, 1, {255_u8, 0_u8, 0_u8, 128_u8}))
    r, _, b, a = base.pixel(0, 0)
    a.should eq 255
    r.should be_close(128, 1)
    b.should be_close(127, 1)
    clear = Image.new(1, 1)
    clear.composite(Image.new(1, 1, {10_u8, 20_u8, 30_u8, 40_u8}))
    clear.pixel(0, 0).should eq({10_u8, 20_u8, 30_u8, 40_u8})
    base.composite(Image.new(1, 1))
    base.pixel(0, 0).should eq({r, 0_u8, b, a})
  end

  it "reports alpha extrema" do
    image = Image.new(2, 1, {1_u8, 1_u8, 1_u8, 200_u8})
    image.set_pixel(0, 0, {1_u8, 1_u8, 1_u8, 7_u8})
    image.alpha_extrema.should eq({7_u8, 200_u8})
  end

  it "round-trips PNG files" do
    scratch do |dir|
      image = Image.new(3, 2, A)
      image.set_pixel(2, 1, {1_u8, 2_u8, 3_u8, 0_u8})
      decoded = PackBuilder.png(png_bytes(dir, image)).not_nil!
      decoded.width.should eq 3
      decoded.pixel(0, 0).should eq A
      decoded.pixel(2, 1)[3].should eq 0
    end
  end
end

describe "PackBuilder.png" do
  it "strips ancillary chunks and rejects unknown critical or malformed data" do
    scratch do |dir|
      data = png_bytes(dir, Image.new(2, 2, A))
      PackBuilder.png(with_chunk(data, "zTXt", Bytes[1, 2, 3])).not_nil!.pixel(1, 1).should eq A
      PackBuilder.png(with_chunk(data, "ABCD", Bytes[1])).should be_nil
      PackBuilder.png(data[0, data.size - 1]).should be_nil
      PackBuilder.png(data + Bytes[0]).should be_nil
      PackBuilder.png("not a png".to_slice).should be_nil
      PackBuilder.png(nil).should be_nil
      oversized = data.dup
      oversized[18] = 0xff
      PackBuilder.png(oversized).should be_nil
    end
  end
end

describe PackBuilder::Archive do
  it "lists entries and reads bytes and JSON" do
    scratch do |dir|
      archive = Archive.new(jar(dir))
      archive.entries.has_key?("version.json").should be_true
      archive.entries.keys.should contain(ASSETS + "blockstates/stone.json")
      archive.read("missing").should be_nil
      archive.object("version.json").not_nil!["id"].as_s.should eq "26.3"
      archive.read("version.json").should eq archive.read("version.json")
      archive.close
    end
  end

  it "rejects unsafe or duplicate member names" do
    scratch do |dir|
      ["../evil", "a/../b", "/abs", "a\\b", "c:x", "a//b", "bad\u0001"].each do |name|
        path = File.join(dir, "bad.zip")
        write_zip(path, [{name, "x".to_slice}])
        expect_raises(Error, /unsafe ZIP member/) { Archive.new(path) }
      end
      path = File.join(dir, "dup.zip")
      write_zip(path, [{"a", "x".to_slice}, {"a", "y".to_slice}])
      expect_raises(Error, /duplicate/) { Archive.new(path) }
    end
  end

  it "rejects symlink members" do
    scratch do |dir|
      path = File.join(dir, "link.zip")
      write_zip(path, [{"link", "target".to_slice}])
      bytes = File.read(path).to_slice.dup
      at = (0..bytes.size - 4).find! { |i| bytes[i, 4] == Bytes[0x50, 0x4b, 1, 2] }
      IO::ByteFormat::LittleEndian.encode(0o120777_u32 << 16, bytes[at + 38, 4])
      File.write(path, bytes)
      expect_raises(Error, /unsafe ZIP member/) { Archive.new(path) }
    end
  end

  it "rejects non-ZIP, missing, and truncated files" do
    scratch do |dir|
      path = File.join(dir, "x.zip")
      File.write(path, "plain text, not a zip")
      expect_raises(Error) { Archive.new(path) }
      expect_raises(Error) { Archive.new(File.join(dir, "nope.zip")) }
      good = jar(dir)
      File.write(path, File.read(good).to_slice[0, 40])
      expect_raises(Error) { Archive.new(path) }
    end
  end

  it "rejects oversized and empty assets on read" do
    scratch do |dir|
      path = File.join(dir, "big.zip")
      write_zip(path, [{"big.json", Bytes.new(300_000, 97_u8)}, {"empty.json", Bytes.empty}])
      archive = Archive.new(path)
      expect_raises(Error, /oversized/) { archive.read("big.json") }
      expect_raises(Error, /oversized/) { archive.read("empty.json") }
      archive.close
    end
  end

  it "reuses decoded pixels and caps aggregate decode work" do
    scratch do |dir|
      first, second = {ASSETS + "textures/block/a.png", ASSETS + "textures/block/b.png"}
      art = png_bytes(dir, Image.new(2, 2, A))
      archive = Archive.new(jar(dir, [{first, art}, {second, art}]), decode_budget: 16_i64)
      begin
        image = archive.image(first).not_nil!
        archive.image(first).not_nil!.same?(image).should be_true
        expect_raises(Error, /PNG decode budget/) { archive.image(second) }
        archive.image(first).not_nil!.pixel(0, 0).should eq A
      ensure
        archive.close
      end
    end
  end

  it "validates ZIP data spans without narrowing or adding untrusted lengths" do
    Archive.span_fits?(30_i64, 20_i64, 50_i64).should be_true
    Archive.span_fits?(30_i64, 21_i64, 50_i64).should be_false
    Archive.span_fits?(-1_i64, 10_i64, 50_i64).should be_false
    Archive.span_fits?(5_i64, -1_i64, 50_i64).should be_false
    Archive.span_fits?(UInt32::MAX.to_i64, 30_i64, 128_i64 << 20).should be_false
    Archive.span_fits?(Int64::MAX - 1, 2_i64, Int64::MAX).should be_false
  end

  it "rejects duplicate JSON keys and non-objects" do
    scratch do |dir|
      path = File.join(dir, "j.zip")
      write_zip(path, [{"dup.json", %({"a":1,"a":2}).to_slice}, {"list.json", "[1]".to_slice}, {"ok.json", %({"a":[1,2.5,{"b":null}]}).to_slice}, {"trail.json", "{} x".to_slice}])
      archive = Archive.new(path)
      expect_raises(Error, /invalid JSON/) { archive.object("dup.json") }
      expect_raises(Error, /JSON object/) { archive.object("list.json") }
      expect_raises(Error, /invalid JSON/) { archive.object("trail.json") }
      archive.object("ok.json").not_nil!["a"].as_a.size.should eq 3
      archive.close
    end
  end
end

describe PackBuilder::Layers do
  it "validates the client JAR" do
    scratch do |dir|
      wrong = File.join(dir, "wrong.jar")
      write_zip(wrong, [{"version.json", version_json("1.0", 1)}, {ASSETS + "blockstates/stone.json", "{}".to_slice}])
      expect_raises(Error, /26\.3/) { Layers.new(Archive.new(wrong)) }
      server = File.join(dir, "server.jar")
      write_zip(server, [{"version.json", version_json}])
      expect_raises(Error, /blockstate/) { Layers.new(Archive.new(server)) }
    end
  end

  it "maps known 26.1 patch JARs to the 26.1 release" do
    scratch do |dir|
      {"26.1.1", "26.1.2"}.each do |id|
        path = File.join(dir, "#{id}.jar")
        write_zip(path, [{"version.json", version_json(id, 775)}, {ASSETS + "blockstates/stone.json", "{}".to_slice}])
        layers = Layers.new(Archive.new(path))
        {layers.version, layers.protocol}.should eq({"26.1", 775})
      end
      {"26.1.3" => 775, "26.1.2" => 777}.each do |id, protocol|
        path = File.join(dir, "bad-#{id}-#{protocol}.jar")
        write_zip(path, [{"version.json", version_json(id, protocol)}, {ASSETS + "blockstates/stone.json", "{}".to_slice}])
        expect_raises(Error, /26\.1\.2/) { Layers.new(Archive.new(path)) }
      end
    end
  end

  it "falls back through layers and records skipped images" do
    scratch do |dir|
      base = png_bytes(dir, Image.new(16, 16, A))
      pack_png = png_bytes(dir, Image.new(16, 16, B))
      texture = ASSETS + "textures/block/x.png"
      client = Archive.new(jar(dir, [{texture, base}]))
      pack_path = File.join(dir, "pack.zip")
      write_zip(pack_path, [{texture, pack_png}, {ASSETS + "textures/block/bad.png", "junk".to_slice}, {ASSETS + "textures/block/bad.png.mcmeta", "{}".to_slice}])
      layers = Layers.new(client, Archive.new(pack_path, overlay: true))
      layers.image(texture).not_nil!.pixel(0, 0).should eq B
      layers.image(texture) { |image| image.pixel(0, 0) == A }.not_nil!.pixel(0, 0).should eq A
      layers.skipped.should contain({"resource pack", texture})
      layers.image(ASSETS + "textures/block/missing.png").should be_nil
      expect_raises(Error, /missing/) { layers.image(ASSETS + "textures/block/missing.png", required: true) }
      layers.image(ASSETS + "textures/block/bad.png").should be_nil
      layers.skipped.should contain({"resource pack", ASSETS + "textures/block/bad.png"})
    end
  end

  it "yields texture layers with metadata from the highest eligible layer" do
    scratch do |dir|
      texture = ASSETS + "textures/block/anim.png"
      art = png_bytes(dir, Image.new(16, 32, A))
      client = Archive.new(jar(dir, [{texture, art}, {texture + ".mcmeta", %({"animation":{"frametime":2}}).to_slice}]))
      pack_path = File.join(dir, "pack.zip")
      write_zip(pack_path, [{texture, png_bytes(dir, Image.new(16, 32, B))}, {texture + ".mcmeta", %({"animation":{}}).to_slice}])
      layers = Layers.new(client, Archive.new(pack_path, overlay: true))
      seen = [] of Tuple(Color, Bool, String)
      layers.texture_layers(texture) { |image, meta, layer| seen << {image.pixel(0, 0), meta["animation"].as_h.empty?, layer.label} }
      seen.should eq [{B, true, "resource pack"}, {A, false, "client JAR"}]
    end
  end

  it "tries the owning sprite metadata after a metadata-only override" do
    scratch do |dir|
      texture = ASSETS + "textures/block/anim.png"
      meta = texture + ".mcmeta"
      art = png_bytes(dir, Image.new(16, 16, A))
      client = Archive.new(jar(dir, [{texture, art}, {meta, %({"texture":{}}).to_slice}]))
      overlay_path = File.join(dir, "pack.zip")
      write_zip(overlay_path, [{meta, %({"animation":{}}).to_slice}])
      overlay = Archive.new(overlay_path, overlay: true)
      begin
        layers = Layers.new(client, overlay)
        seen = [] of Tuple(Color, Array(String), String)
        layers.texture_layers(texture) { |image, metadata, layer| seen << {image.pixel(0, 0), metadata.keys, layer.label} }
        seen.should eq [{A, ["animation"], "client JAR"}, {A, ["texture"], "client JAR"}]
      ensure
        overlay.close
        client.close
      end
    end
  end

  it "rejects unsupported pack metadata" do
    scratch do |dir|
      { %({"pack":{"pack_format":5}}) => nil, %({"overlays":{}}) => /overlays/, %({"nope":1}) => /pack object/,
       %({"pack":{"min_format":9,"max_format":3}}) => /inverted/, %({"pack":{"pack_format":true}}) => /invalid/ }.each do |meta, error|
        pack_path = File.join(dir, "pack.zip")
        write_zip(pack_path, [{ASSETS + "textures/a.png", "x".to_slice}, {"pack.mcmeta", meta.to_slice}])
        client = Archive.new(jar(dir))
        if error
          expect_raises(Error, error) { Layers.new(client, Archive.new(pack_path, overlay: true)) }
        else
          Layers.new(client, Archive.new(pack_path, overlay: true)).overlay.should_not be_nil
        end
      end
    end
  end
end
