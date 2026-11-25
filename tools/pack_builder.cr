require "file_utils"
require "option_parser"
require "./terrain"
require "./gui_entities"

module PackBuilder
  class Interrupted < Exception
  end

  def self.publish(staged : String, output : String, &checkpoint : ->)
    owned = {} of String => File::Info
    links = {} of String => File::Info
    begin
      {output, File.join(output, "gui")}.each do |directory|
        checkpoint.call
        Dir.mkdir(directory, 0o700)
        owned[directory] = File.info(directory, follow_symlinks: false)
      end
      paths = Dir.children(staged).reject("gui") + Dir.children(File.join(staged, "gui")).map { |name| File.join("gui", name) }
      paths.sort!.each do |name|
        checkpoint.call
        source = File.join(staged, name)
        target = File.join(output, name)
        identity = File.info(source, follow_symlinks: false)
        File.link(source, target)
        links[target] = identity
      end
      checkpoint.call
    rescue ex
      links.each do |path, identity|
        begin
          if File.info?(path, follow_symlinks: false).try(&.same_file?(identity))
            File.delete(path)
          end
        rescue File::Error
        end
      end
      owned.to_a.reverse_each do |path, identity|
        begin
          if File.info?(path, follow_symlinks: false).try(&.same_file?(identity))
            Dir.delete(path)
          end
        rescue File::Error
        end
      end
      raise ex
    end
  end

  def self.build(client : String, destination : String, resource_pack : String? = nil, &checkpoint : ->) : Nil
    output = File.expand_path(destination)
    parent = File.dirname(output)
    raise Error.new("output already exists; choose a new directory") if File.info?(output, follow_symlinks: false)
    raise Error.new("output parent must be an existing directory") unless Dir.exists?(parent)
    jar = Archive.new(client)
    begin
      overlay = Archive.new(resource_pack, overlay: true) if resource_pack
      assets = Layers.new(jar, overlay)
      candidate = File.tempname(".rosegold-pack-", nil, dir: parent)
      Dir.mkdir(candidate, 0o700)
      staged = candidate
      checkpoint.call
      Terrain.build(assets, staged)
      checkpoint.call
      GuiEntities.gui(assets, File.join(staged, "gui"))
      GuiEntities.entities(assets, staged)
      assets.skipped.to_a.sort!.first(12).each do |label, path|
        STDERR.puts "Warning: ignored unsupported #{label} image or metadata: #{path}"
      end
      if assets.skipped.size > 12
        STDERR.puts "Warning: #{assets.skipped.size - 12} more unsupported images or metadata files."
      end
      publish(staged, output, &checkpoint)
    ensure
      overlay.try(&.close)
      jar.close
      FileUtils.rm_r(staged) if staged
    end
    puts "Pack ready: #{output}"
  end

  def self.build(client : String, destination : String, resource_pack : String? = nil) : Nil
    build(client, destination, resource_pack) { }
  end

  def self.main(args : Array(String)) : Int32
    overlay = nil
    paths = [] of String
    help = false
    parser = OptionParser.new do |options|
      options.banner = "Usage: build-pack CLIENT_JAR NEW_PACK_DIR [--resource-pack ZIP]\nBuild a local Rosegold Viewer pack from a Minecraft Java #{VERSION} client JAR (protocol #{PROTOCOL})."
      options.on("--resource-pack ZIP", "Optional resource pack layered over vanilla") { |value| overlay = value }
      options.on("-h", "--help", "Show this help") { help = true }
      options.unknown_args { |before, after| paths = before + after }
    end
    parser.parse(args)
    if help
      puts parser
      return 0
    end
    if paths.size != 2
      STDERR.puts parser
      return 2
    end
    interrupted = Atomic(Bool).new(false)
    Signal::INT.trap { interrupted.set(true) }
    begin
      build(paths[0], paths[1], overlay) do
        Fiber.yield
        raise Interrupted.new if interrupted.get
      end
    ensure
      Signal::INT.reset
    end
    0
  rescue ex : Interrupted
    STDERR.puts "build-pack: interrupted"
    130
  rescue ex : OptionParser::Exception
    STDERR.puts "build-pack: #{ex.message}"
    2
  rescue ex : Error | IO::Error | Compress::Zip::Error
    STDERR.puts "build-pack: #{ex.message}"
    1
  end
end
