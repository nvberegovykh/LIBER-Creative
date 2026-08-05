/* LIBER Specifications — CSI MasterFormat 2020 mask + SectionFormat skeleton
 * Pure data + classifier. No dependencies. Works standalone.
 */
(function (root) {
  'use strict';

  const DIVISIONS = [
    ['00', 'Procurement and Contracting Requirements'],
    ['01', 'General Requirements'],
    ['02', 'Existing Conditions'],
    ['03', 'Concrete'],
    ['04', 'Masonry'],
    ['05', 'Metals'],
    ['06', 'Wood, Plastics, and Composites'],
    ['07', 'Thermal and Moisture Protection'],
    ['08', 'Openings'],
    ['09', 'Finishes'],
    ['10', 'Specialties'],
    ['11', 'Equipment'],
    ['12', 'Furnishings'],
    ['13', 'Special Construction'],
    ['14', 'Conveying Equipment'],
    ['21', 'Fire Suppression'],
    ['22', 'Plumbing'],
    ['23', 'Heating, Ventilating, and Air Conditioning (HVAC)'],
    ['25', 'Integrated Automation'],
    ['26', 'Electrical'],
    ['27', 'Communications'],
    ['28', 'Electronic Safety and Security'],
    ['31', 'Earthwork'],
    ['32', 'Exterior Improvements'],
    ['33', 'Utilities'],
    ['34', 'Transportation'],
    ['35', 'Waterway and Marine Construction'],
    ['40', 'Process Interconnections'],
    ['41', 'Material Processing and Handling Equipment'],
    ['42', 'Process Heating, Cooling, and Drying Equipment'],
    ['43', 'Process Gas and Liquid Handling, Purification, and Storage Equipment'],
    ['44', 'Pollution and Waste Control Equipment'],
    ['45', 'Industry-Specific Manufacturing Equipment'],
    ['46', 'Water and Wastewater Equipment'],
    ['48', 'Electrical Power Generation']
  ].map(([number, title]) => ({ number, title }));

  // Curated Level-2/3 sections with keyword weights for auto-mapping.
  // [section number, title, keywords]
  const SECTIONS = [
    ['011000', 'Summary', ['summary', 'scope of work']],
    ['012100', 'Allowances', ['allowance']],
    ['013300', 'Submittal Procedures', ['submittal']],
    ['017700', 'Closeout Procedures', ['closeout', 'punch list']],
    ['024119', 'Selective Demolition', ['demo', 'demolition', 'removal']],
    ['033000', 'Cast-in-Place Concrete', ['concrete', 'slab', 'footing', 'foundation', 'grade beam', 'pier']],
    ['035416', 'Hydraulic Cement Underlayment', ['underlayment', 'self-level', 'levelling compound']],
    ['042000', 'Unit Masonry', ['masonry', 'brick', 'cmu', 'block', 'veneer', 'mortar']],
    ['051200', 'Structural Steel Framing', ['structural steel', 'steel beam', 'steel column', 'w-shape', 'hss']],
    ['054000', 'Cold-Formed Metal Framing', ['metal stud', 'cold-formed', 'cfmf', 'track']],
    ['055000', 'Metal Fabrications', ['metal fabrication', 'lintel', 'bollard', 'ladder', 'grating']],
    ['055213', 'Pipe and Tube Railings', ['railing', 'handrail', 'guardrail', 'guard rail', 'balustrade']],
    ['055100', 'Metal Stairs', ['metal stair', 'steel stair', 'stair pan']],
    ['061000', 'Rough Carpentry', ['rough carpentry', 'joist', 'sheathing', 'blocking', 'stud', 'framing', 'rafter', 'lvl', 'plywood']],
    ['062000', 'Finish Carpentry', ['trim', 'baseboard', 'base board', 'molding', 'moulding', 'casing', 'chair rail', 'wainscot']],
    ['064000', 'Architectural Woodwork', ['millwork', 'architectural woodwork', 'panelling', 'paneling', 'built-in']],
    ['072100', 'Thermal Insulation', ['insulation', 'batt', 'rigid board', 'spray foam', 'r-value']],
    ['072700', 'Air Barriers', ['air barrier', 'weather barrier', 'wrb', 'house wrap']],
    ['075000', 'Membrane Roofing', ['roofing', 'roof membrane', 'tpo', 'epdm', 'modified bitumen', 'shingle']],
    ['076000', 'Flashing and Sheet Metal', ['flashing', 'gutter', 'downspout', 'coping', 'drip edge']],
    ['078100', 'Applied Fireproofing', ['fireproofing', 'sfrm']],
    ['078400', 'Firestopping', ['firestop', 'fire stop', 'penetration seal']],
    ['079200', 'Joint Sealants', ['sealant', 'caulk', 'backer rod']],
    ['081113', 'Hollow Metal Doors and Frames', ['hollow metal', 'metal door', 'hm door', 'steel door', 'fire door']],
    ['081416', 'Flush Wood Doors', ['wood door', 'flush door', 'door leaf', 'interior door']],
    ['083113', 'Access Doors and Frames', ['access door', 'access panel', 'access hatch']],
    ['083600', 'Panel Doors', ['garage door', 'overhead door', 'sectional door', 'roll-up']],
    ['084313', 'Aluminum-Framed Storefronts', ['storefront', 'curtain wall', 'entrance']],
    ['085113', 'Aluminum Windows', ['aluminum window', 'window']],
    ['085200', 'Wood Windows', ['wood window']],
    ['087100', 'Door Hardware', ['hardware', 'hinge', 'lockset', 'closer', 'exit device', 'lever', 'cylinder', 'threshold']],
    ['088000', 'Glazing', ['glazing', 'glass', 'igu', 'tempered', 'laminated glass']],
    ['089000', 'Louvers and Vents', ['louver', 'vent', 'wall cap']],
    ['092900', 'Gypsum Board', ['gypsum', 'drywall', 'gwb', 'sheetrock', 'partition', 'wall type']],
    ['093000', 'Tiling', ['tile', 'tiling', 'ceramic', 'porcelain', 'mosaic', 'grout', 'stone floor']],
    ['095100', 'Acoustical Ceilings', ['ceiling', 'acoustic', 'act', 'ceiling tile']],
    ['096400', 'Wood Flooring', ['wood floor', 'hardwood', 'engineered wood', 'parquet', 'oak floor']],
    ['096500', 'Resilient Flooring', ['resilient', 'vinyl', 'lvt', 'lvp', 'linoleum', 'rubber floor', 'vct']],
    ['096800', 'Carpeting', ['carpet', 'broadloom', 'carpet tile']],
    ['097200', 'Wall Coverings', ['wall covering', 'wallcovering', 'wallpaper']],
    ['098400', 'Acoustic Room Components', ['acoustic panel', 'sound absorb']],
    ['099100', 'Painting', ['paint', 'primer', 'stain', 'finish schedule', 'color']],
    ['099600', 'High-Performance Coatings', ['coating', 'epoxy floor', 'intumescent']],
    ['102600', 'Wall and Door Protection', ['corner guard', 'wall protection', 'bumper']],
    ['102800', 'Toilet, Bath, and Laundry Accessories', ['accessory', 'accessories', 'towel bar', 'grab bar', 'robe hook', 'toilet paper', 'medicine cabinet']],
    ['102813', 'Toilet Accessories', ['toilet accessor']],
    ['104400', 'Fire Protection Specialties', ['extinguisher', 'fire cabinet', 'fire blanket']],
    ['105500', 'Postal Specialties', ['mailbox', 'mail box', 'postal']],
    ['105700', 'Wardrobe and Closet Specialties', ['closet', 'shelving', 'wardrobe', 'closet rod']],
    ['107300', 'Protective Covers', ['canopy', 'awning', 'trellis']],
    ['112300', 'Commercial Laundry and Dry Cleaning Equipment', ['commercial laundry']],
    ['113100', 'Residential Appliances', ['appliance', 'refrigerator', 'refridgerator', 'riefrigerator', 'range', 'cooktop', 'oven', 'dishwasher', 'microwave', 'range hood', 'hood', 'washer', 'dryer', 'w/d', 'freezer', 'wine cooler', 'disposal']],
    ['122000', 'Window Treatments', ['blind', 'shade', 'curtain', 'drapery', 'window treatment']],
    ['122400', 'Window Shades', ['roller shade', 'motorized shade']],
    ['123200', 'Manufactured Wood Casework', ['casework', 'cabinet', 'cabinetry', 'base cabinet', 'wall cabinet']],
    ['123530', 'Residential Casework', ['kitchen cabinet', 'vanity cabinet', 'residential casework']],
    ['123600', 'Countertops', ['countertop', 'counter top', 'quartz', 'slab top', 'backsplash']],
    ['124800', 'Rugs and Mats', ['rug', 'entrance mat', 'walk-off']],
    ['126100', 'Fixed Audience Seating', ['fixed seating']],
    ['129300', 'Site Furnishings', ['bench', 'planter', 'bike rack', 'trash receptacle']],
    ['142100', 'Electric Traction Elevators', ['traction elevator']],
    ['142400', 'Hydraulic Elevators', ['elevator', 'lift', 'hydraulic elevator', 'dumbwaiter']],
    ['211300', 'Fire-Suppression Sprinkler Systems', ['sprinkler', 'fire suppression', 'standpipe']],
    ['221116', 'Domestic Water Piping', ['water piping', 'domestic water', 'pex', 'copper pipe']],
    ['221316', 'Sanitary Waste and Vent Piping', ['waste', 'vent piping', 'sanitary', 'drain pipe']],
    ['223300', 'Electric Domestic Water Heaters', ['electric water heater']],
    ['223400', 'Fuel-Fired Domestic Water Heaters', ['water heater', 'hot water heater', 'boiler', 'indirect tank']],
    ['224000', 'Plumbing Fixtures', ['plumbing fixture', 'toilet', 'water closet', ' wc', 'lavatory', 'sink', 'faucet', 'bathtub', 'tub', 'shower', 'bidet', 'urinal', 'floor drain', 'hose bibb']],
    ['230593', 'Testing, Adjusting, and Balancing for HVAC', ['balancing', 'tab report']],
    ['233100', 'HVAC Ducts and Casings', ['duct', 'ductwork', 'plenum']],
    ['233400', 'HVAC Fans', ['exhaust fan', 'supply fan', 'erv', 'hrv', 'bath fan']],
    ['233700', 'Air Outlets and Inlets', ['diffuser', 'grille', 'register', 'air outlet']],
    ['235100', 'Breechings, Chimneys, and Stacks', ['chimney', 'flue', 'stack']],
    ['238100', 'Decentralized Unitary HVAC Equipment', ['heat pump', 'mini split', 'minisplit', 'fan coil', 'ptac', 'vrf', 'condenser', 'air handler', 'ahu', 'furnace', 'hvac']],
    ['238200', 'Convection Heating and Cooling Units', ['radiator', 'baseboard heater', 'convector', 'radiant']],
    ['251100', 'Integrated Automation Network Equipment', ['automation', 'bms', 'smart home']],
    ['262400', 'Switchboards and Panelboards', ['panelboard', 'panel board', 'electrical panel', 'switchboard', 'breaker', 'meter']],
    ['262726', 'Wiring Devices', ['wiring device', 'receptacle', 'outlet', 'switch', 'dimmer', 'usb outlet', 'device']],
    ['262813', 'Fuses', ['fuse']],
    ['263213', 'Engine Generators', ['generator']],
    ['265100', 'Interior Lighting', ['lighting', 'luminaire', 'light fixture', 'sconce', 'pendant', 'downlight', 'recessed light', 'chandelier', 'cove light', 'lamp', 'led strip']],
    ['265600', 'Exterior Lighting', ['exterior light', 'site light', 'bollard light', 'pole light', 'landscape light']],
    ['271500', 'Communications Horizontal Cabling', ['cat6', 'cat5', 'data cabling', 'ethernet', 'telecom']],
    ['275116', 'Public Address and Mass Notification Systems', ['intercom', 'public address', 'paging']],
    ['281300', 'Access Control', ['access control', 'card reader', 'fob', 'keypad entry']],
    ['282300', 'Video Surveillance', ['camera', 'cctv', 'surveillance', 'nvr']],
    ['283100', 'Fire Detection and Alarm', ['smoke detector', 'fire alarm', 'co detector', 'heat detector', 'pull station', 'strobe']],
    ['311000', 'Site Clearing', ['site clearing', 'grubbing']],
    ['312300', 'Excavation and Fill', ['excavation', 'backfill', 'fill', 'grading']],
    ['321216', 'Asphalt Paving', ['asphalt', 'bituminous paving']],
    ['321313', 'Concrete Paving', ['sidewalk', 'concrete paving', 'curb', 'driveway']],
    ['321400', 'Unit Paving', ['paver', 'unit paving', 'flagstone']],
    ['323100', 'Fences and Gates', ['fence', 'gate', 'railing site']],
    ['323300', 'Site Furnishings', ['site furnishing']],
    ['329200', 'Turf and Grasses', ['sod', 'turf', 'lawn', 'seeding']],
    ['329300', 'Plants', ['plant', 'tree', 'shrub', 'perennial', 'landscap', 'green roof']],
    ['334100', 'Storm Utility Drainage Piping', ['storm', 'catch basin', 'drywell']],
    ['486000', 'Solar Energy Electrical Power Generation Equipment', ['solar', 'pv panel', 'photovoltaic']]
  ].map(([number, title, keywords]) => ({
    number,
    title,
    division: number.slice(0, 2),
    keywords
  }));

  // Schedules that describe space/area data rather than products.
  const LOCATION_HINTS = ['room schedule', 'area schedule', 'space schedule', 'occupancy', 'gross area', 'zoning', 'sheet list', 'drawing list', 'revision'];

  const SECTIONFORMAT = [
    {
      id: 'part1', number: '1', title: 'GENERAL', articles: [
        ['1.1', 'SUMMARY'],
        ['1.2', 'REFERENCES'],
        ['1.3', 'ADMINISTRATIVE REQUIREMENTS'],
        ['1.4', 'ACTION SUBMITTALS'],
        ['1.5', 'QUALITY ASSURANCE'],
        ['1.6', 'DELIVERY, STORAGE, AND HANDLING'],
        ['1.7', 'FIELD CONDITIONS'],
        ['1.8', 'WARRANTY']
      ]
    },
    {
      id: 'part2', number: '2', title: 'PRODUCTS', articles: [
        ['2.1', 'MANUFACTURERS'],
        ['2.2', 'PERFORMANCE / DESIGN CRITERIA'],
        ['2.3', 'PRODUCTS — SCHEDULE OF ITEMS', { itemTable: true }],
        ['2.4', 'ACCESSORIES'],
        ['2.5', 'FABRICATION'],
        ['2.6', 'SOURCE QUALITY CONTROL']
      ]
    },
    {
      id: 'part3', number: '3', title: 'EXECUTION', articles: [
        ['3.1', 'EXAMINATION'],
        ['3.2', 'PREPARATION'],
        ['3.3', 'INSTALLATION'],
        ['3.4', 'FIELD QUALITY CONTROL'],
        ['3.5', 'CLEANING AND PROTECTION'],
        ['3.6', 'LOCATION SCHEDULE', { locationTable: true }]
      ]
    }
  ].map((p) => ({
    ...p,
    articles: p.articles.map(([number, title, opts]) => ({ number, title, ...(opts || {}) }))
  }));

  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[_\-–—]/g, ' ').replace(/\s+/g, ' ').trim();

  function fmt(num) {
    const n = String(num || '').replace(/\D/g, '').padEnd(6, '0').slice(0, 6);
    return n.slice(0, 2) + ' ' + n.slice(2, 4) + ' ' + n.slice(4, 6);
  }

  function divisionTitle(div) {
    const d = DIVISIONS.find((x) => x.number === String(div).padStart(2, '0'));
    return d ? d.title : 'Unassigned';
  }

  function isLocationSchedule(name) {
    const n = norm(name);
    return LOCATION_HINTS.some((h) => n.includes(h));
  }

  /** Score-based classification of arbitrary text to a MasterFormat section. */
  function classify(text, contextText) {
    const hay = norm(text) + ' ' + norm(contextText || '');
    let best = null;
    for (const s of SECTIONS) {
      let score = 0;
      for (const kw of s.keywords) {
        const k = norm(kw);
        if (!k) continue;
        if (hay.includes(k)) score += Math.min(6, k.length) + (norm(text).includes(k) ? 3 : 0);
      }
      if (score > 0 && (!best || score > best.score)) best = { section: s, score };
    }
    if (!best) return { number: null, title: null, division: null, confidence: 0, needsMapping: true };
    return {
      number: best.section.number,
      title: best.section.title,
      division: best.section.division,
      confidence: Math.min(1, best.score / 12),
      needsMapping: best.score < 6
    };
  }

  function search(term) {
    const t = norm(term);
    if (!t) return SECTIONS.slice(0, 40);
    return SECTIONS.filter((s) => norm(s.title).includes(t) || s.number.startsWith(t.replace(/\D/g, '')) || s.keywords.some((k) => norm(k).includes(t))).slice(0, 60);
  }

  root.MasterFormat = { DIVISIONS, SECTIONS, SECTIONFORMAT, classify, search, fmt, divisionTitle, isLocationSchedule, norm };
})(typeof window !== 'undefined' ? window : globalThis);
