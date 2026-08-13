# Run with: openstudio OpenStudio_Load_Check.rb "model.osm"
abort("Usage: openstudio OpenStudio_Load_Check.rb model.osm") if ARGV.empty?
path = OpenStudio::Path.new(File.expand_path(ARGV[0]))
optional_model = OpenStudio::Model::Model.load(path)
if optional_model.empty?
  warn "FAIL: OpenStudio could not load #{path}"
  exit 2
end
model = optional_model.get
puts "PASS: OpenStudio loaded #{path}"
puts "Objects: #{model.numObjects}"
puts "Spaces: #{model.getSpaces.size}"
puts "Surfaces: #{model.getSurfaces.size}"
puts "SubSurfaces: #{model.getSubSurfaces.size}"
puts "Thermal Zones: #{model.getThermalZones.size}"

def message_text(message)
  message.respond_to?(:logMessage) ? message.logMessage.to_s : message.to_s
end

translator = OpenStudio::EnergyPlus::ForwardTranslator.new
workspace = translator.translateModel(model)
errors = translator.errors.map { |message| message_text(message) }
warnings = translator.warnings.map { |message| message_text(message) }
puts "FT_ERROR_COUNT=#{errors.size}"
puts "FT_WARNING_COUNT=#{warnings.size}"
errors.each { |message| warn "FT_ERROR: #{message}" }
warnings.each { |message| puts "FT_WARNING: #{message}" }
blocked = errors.any? || warnings.any? { |message|
  message =~ /currently unable to translate/i ||
  message =~ /could not resolve matched construction conflicts/i ||
  message =~ /more vertices than allowed/i
}
if blocked
  warn "FAIL: Forward translation contains blocking geometry/construction errors"
  exit 3
end
idf_path = OpenStudio::Path.new(
  File.join(File.dirname(File.expand_path(ARGV[0])), "NATIVE_CHECK_TRANSLATED.idf")
)
unless workspace.save(idf_path, true)
  warn "FAIL: Could not save translated IDF"
  exit 4
end
puts "PASS: Forward translation completed without blocking errors"
puts "IDF_PATH=#{idf_path}"
