require "spec"
require "file_utils"
require "http/client"
require "rosegold/26.3"
require "../src/rosegold-viewer"

PNG_HEADER = Bytes[137, 80, 78, 71, 13, 10, 26, 10]

def png_bytes(extra : Int32 = 8) : Bytes
  bytes = Bytes.new(8 + extra, 1_u8)
  PNG_HEADER.copy_to(bytes)
  bytes
end

def with_temp_dir(&)
  path = File.join(Dir.tempdir, "rosegold-viewer-spec-#{Random::Secure.hex(6)}")
  Dir.mkdir_p(path)
  yield path
ensure
  FileUtils.rm_rf(path) if path
end
