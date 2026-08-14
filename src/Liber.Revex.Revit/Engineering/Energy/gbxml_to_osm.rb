require 'openstudio'

if ARGV.length != 2
  STDERR.puts 'Usage: openstudio gbxml_to_osm.rb INPUT.xml OUTPUT.osm'
  exit 2
end

def revex_normalize_name(value)
  value.to_s.downcase.gsub(/[^a-z0-9]+/, '')
end

def revex_unclassified_space?(space)
  name = revex_normalize_name(space.nameString)
  name.empty? || name.include?('autounclassified') || name.include?('unclassified')
end

def revex_vertical_role(space)
  name = revex_normalize_name(space.nameString)
  return ['mechshaft', 'mechanical_shaft'] if name.include?('mechanicalshaft') || name.include?('mechshaft') || name.include?('serviceshaft')
  return ['elevator', 'elevator'] if name.include?('elevator') || name.include?('lift')
  nil
end

def revex_surface_area(surface)
  surface.grossArea.to_f
rescue StandardError
  0.0
end

def revex_infer_vertical_context!(model)
  inferred = []

  model.getSpaces.each do |space|
    next unless revex_unclassified_space?(space)

    role_area = Hash.new(0.0)
    role_labels = {}
    total_vertical_interface = 0.0

    space.surfaces.each do |surface|
      next unless ['Floor', 'RoofCeiling'].include?(surface.surfaceType.to_s)

      adjacent = surface.adjacentSurface
      next unless adjacent.is_initialized

      mate = adjacent.get
      adjacent_space = mate.space
      next unless adjacent_space.is_initialized

      area = revex_surface_area(surface)
      next unless area > 1.0e-8

      total_vertical_interface += area
      neighbor = adjacent_space.get
      role = revex_vertical_role(neighbor)
      next unless role

      token, label = role
      role_area[token] += area
      role_labels[token] = label
    end

    next unless total_vertical_interface > 1.0e-8
    next if role_area.empty?

    winner, winner_area = role_area.max_by { |_role, area| area }
    second_area = role_area.reject { |role, _area| role == winner }.values.max || 0.0
    interface_fraction = winner_area / total_vertical_interface

    floor_area = space.floorArea.to_f
    footprint_fraction = floor_area > 1.0e-8 ? [winner_area / floor_area, 1.0].min : interface_fraction
    dominance_gap = (winner_area - second_area) / total_vertical_interface

    # Only annotate otherwise-unclassified spaces when one known vertical role
    # dominates both the reciprocal horizontal interface and the target footprint.
    # This gathers context automatically without weakening GeometryCo's 75% gate.
    next unless interface_fraction >= 0.90
    next unless footprint_fraction >= 0.85
    next unless dominance_gap >= 0.15

    original = space.nameString
    context_token = "revexctx#{winner}"
    next if revex_normalize_name(original).include?(context_token)

    space.setName("#{original} #{context_token}")
    inferred << {
      name: original,
      role: role_labels[winner] || winner,
      interface_fraction: interface_fraction,
      footprint_fraction: footprint_fraction
    }
  end

  inferred
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
revex_context = revex_infer_vertical_context!(model)

unless model.save(output, true)
  STDERR.puts "OpenStudio could not save #{output}."
  exit 4
end

revex_context.each do |row|
  puts format(
    'REVEX_CONTEXT_INFERRED=%s|%s|interface=%.3f|footprint=%.3f',
    row[:name], row[:role], row[:interface_fraction], row[:footprint_fraction]
  )
end
puts "REVEX_CONTEXT_INFERRED_COUNT=#{revex_context.length}"
puts "REVEX_GEOMETRY_OSM=#{output}"
puts "REVEX_SPACES=#{model.getSpaces.size}"
puts "REVEX_SURFACES=#{model.getSurfaces.size}"
puts "REVEX_SUBSURFACES=#{model.getSubSurfaces.size}"
