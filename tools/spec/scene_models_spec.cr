require "spec"
require "../scene_models"

private def mesh_quad(index : Int32) : PackBuilder::SceneModels::Quad
  z = index / 1024.0
  {[0.0, 0.5, z, 1.0, 0.5, z, 1.0, 0.0, z, 0.0, 0.0, z],
   [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0], 0, nil}
end

describe PackBuilder::SceneModels::Table do
  it "does not admit partial quads or reserve textures for a mesh above the quad limit" do
    table = PackBuilder::SceneModels::Table.new
    limit = PackBuilder::SceneModels::MAX_QUADS
    (0...limit - 1).each_slice(PackBuilder::SceneModels::MAX_FACES) do |indices|
      table.add?(false, indices.map { |index| mesh_quad(index) }) { true }.should_not be_nil
    end
    count = table.variants.size
    table.add?(false, [mesh_quad(limit - 1), mesh_quad(limit)]) { raise "reserved rejected mesh" }.should be_nil
    table.quads.size.should eq limit - 1
    table.variants.size.should eq count
    table.add?(false, [mesh_quad(limit - 1)]) { false }.should be_nil
    table.quads.size.should eq limit - 1
    table.variants.size.should eq count
    table.add?(false, [mesh_quad(limit - 1)]) { true }.should eq count
    table.quads.size.should eq limit
  end

  it "keeps existing variants and their bindings when no variant slots remain" do
    table = PackBuilder::SceneModels::Table.new
    limit = PackBuilder::SceneModels::MAX_VARIANTS
    limit.times { |index| table.add?(false, [mesh_quad(index)]) { true }.should eq index }
    table.add?(false, [mesh_quad(limit)]) { raise "reserved rejected mesh" }.should be_nil
    table.quads.size.should eq limit
    table.variants.size.should eq limit
    table.add?(false, [mesh_quad(0)]) { true }.should eq 0
  end
end
