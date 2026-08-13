require 'openstudio'

if ARGV.length != 2
  STDERR.puts 'Usage: openstudio gbxml_to_osm.rb INPUT.xml OUTPUT.osm'
  exit 2
end

input = OpenStudio::Path.new(File.expand_path(ARGV[0]))
output = OpenStudio::Path.new(File.expand_path(ARGV[1]))
translator = OpenStudio::GbXML::GbXMLReverseTranslator.new
model_optional = translator.loadModel(input)

unless model_optional.is_initialized
  STDERR.puts "OpenStudio could not reverse-translate #{input}."
  exit 3
end

model = model_optional.get
unless model.save(output, true)
  STDERR.puts "OpenStudio could not save #{output}."
  exit 4
end

puts "REVEX_GEOMETRY_OSM=#{output}"
puts "REVEX_SPACES=#{model.getSpaces.size}"
puts "REVEX_SURFACES=#{model.getSurfaces.size}"
puts "REVEX_SUBSURFACES=#{model.getSubSurfaces.size}"
