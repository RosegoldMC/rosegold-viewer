require "./spec_helper"

describe RosegoldViewer::Pack do
  it "serves only the fixed pack files" do
    with_temp_dir do |dir|
      File.write(File.join(dir, "atlas.png"), png_bytes)
      File.write(File.join(dir, "atlas.json"), %({"a":1}))
      Dir.mkdir(File.join(dir, "gui"))
      File.write(File.join(dir, "gui/hotbar.png"), png_bytes)
      File.write(File.join(dir, "gui/other.png"), png_bytes)
      File.write(File.join(dir, "secret.txt"), "x")

      pack = RosegoldViewer::Pack.new(dir)
      pack["atlas.png"]?.not_nil!.content_type.should eq "image/png"
      pack["atlas.json"]?.not_nil!.content_type.should eq "application/json"
      pack["gui/hotbar.png"]?.should_not be_nil
      pack["gui/other.png"]?.should be_nil
      pack["secret.txt"]?.should be_nil
      pack["../atlas.png"]?.should be_nil
      pack["entities.png"]?.should be_nil
    end
  end

  it "skips symlinks, malformed, and oversized files" do
    with_temp_dir do |dir|
      outside = File.join(dir, "outside.png")
      File.write(outside, png_bytes)
      pack_dir = File.join(dir, "pack")
      Dir.mkdir(pack_dir)
      File.symlink(outside, File.join(pack_dir, "atlas.png"))
      File.write(File.join(pack_dir, "entities.png"), "not a png")
      File.write(File.join(pack_dir, "atlas.json"), "{broken")
      File.write(File.join(pack_dir, "entities.json"), " " * (4 * 1024 * 1024 + 1))
      Dir.mkdir(File.join(dir, "elsewhere"))
      File.write(File.join(dir, "elsewhere/hotbar.png"), png_bytes)
      File.symlink(File.join(dir, "elsewhere"), File.join(pack_dir, "gui"))

      pack = RosegoldViewer::Pack.new(pack_dir)
      pack.empty?.should be_true
    end
  end

  it "rejects a missing directory" do
    expect_raises(ArgumentError) { RosegoldViewer::Pack.new("/nonexistent/rosegold-viewer-pack") }
  end
end
