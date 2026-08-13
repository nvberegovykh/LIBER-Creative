OPENSTUDIO ENERGY MODEL GEOMETRY COMPILER v4.3.1
=================================================

PURPOSE
Replace the complete spaces/surfaces/openings/stories geometry in approved
Baseline and Proposed OpenStudio models while preserving each template's HVAC,
plant, schedules, loads, thermostats, controls, constructions, and simulation
setup.

The output contains the NEW geometry model's OS:Space objects. Old template
spaces are behavior sources only; they never replace the new spaces.

START
1. Extract this ZIP into a NEW folder.
2. Double-click GeometryCompiler.exe.
   Start Compiler.bat remains available as the transparent fallback.
3. On first run, allow the small Python runtime dependencies to install.
4. Select:
   - New Geometry + Spaces OSM
   - Approved Baseline OSM
   - Approved Proposed OSM
   - Output folder
5. Leave the local architectural agent and exact-version native validation on.
6. Click COMPILE BASELINE + PROPOSED.

LOCAL ARCHITECTURAL AGENT
- Runs entirely on the workstation. No space name, geometry, or template data
  is sent to an external AI service.
- Includes a pinned, quantized ONNX build of all-MiniLM-L6-v2.
- Uses DirectML/CUDA/OpenVINO/CoreML when an installed ONNX Runtime provider
  exposes it, otherwise uses CPU.
- Selects an approved template behavior PROFILE before selecting any old source
  space. Geometry can no longer turn an amenity into an unconditioned shaft.
- Gathers evidence in layers:
  1. Architectural space-name classification.
  2. Room-use examples learned from the approved template.
  3. Pretrained semantic similarity.
  4. Adjacent-space graph.
  5. Building level, floor-area scale, and exterior exposure.
  6. 3D overlap, elevation, centroid, volume, area, and shape.
  7. Template profile prior as the lightest fallback signal.
- The automatic confidence floor is hard-set to 75%; configuration cannot lower it.

REVIEW WINDOW
- Review Space Mappings remains available after every successful preflight.
- "USE ALL SUGGESTED" saves every visible >=75% assignment as an explicit
  override for both Baseline and Proposed.
- The button never accepts a row below 75%.
- The table distinguishes "New Model Space" from "Template Behavior Source" and
  shows the assigned template logic separately.

WINTHROP v4.3.1 RESULT
- 159/159 new spaces mapped in each model.
- 0 assignments below 75%; minimum confidence 90%.
- 133 spaces use the Residential/conditioned template profile.
- 26 spaces use the Unconditioned-core profile: the shaft/elevator/crawlspace
  architectural family.
- sp-219amenityspace uses Residential logic at 99% confidence and selects a
  residential coworking/amenity source, never a mechanical shaft.
- Baseline and Proposed retain the exact new OS:Space handle/name set.

GEOMETRY AND MODEL SAFETY
- Validates OSM field layout, handles, reciprocal surface/opening references,
  planarity, area, parent containment, and paired construction compatibility.
- Losslessly decomposes valid EnergyPlus-incompatible openings with >4 vertices.
- Losslessly decomposes non-convex shadow-casting surfaces, including surfaces
  with child openings, before native validation.
- Recombines adjacent repair triangles into exact convex triangles/quads so
  EnergyPlus cannot collapse a sub-centimeter needle triangle to two vertices.
- Preflights EnergyPlus's 0.01 m short-edge vertex cleanup and stops with the
  exact face name before native validation if fewer than three vertices remain.
- Requires zero non-convex casting surfaces after repair and serialized round-trip.
- Locks every schedule definition and every protected schedule reference.
- Uses only an exact SDK-version OpenStudio CLI.
- Runs Model::load, ForwardTranslator, and an EnergyPlus design-day smoke test.
- Commits Baseline and Proposed atomically only after both pass.

OUTPUTS
- BASELINE_UPDATED_GEOMETRY.osm
- PROPOSED_UPDATED_GEOMETRY.osm
- COMPILATION_AUDIT.html / .json
- VALIDATION_SUMMARY.txt
- SPACE_MAPPING_BASELINE.csv
- SPACE_MAPPING_PROPOSED.csv
- COMPILED_ENERGY_MODELS.zip
- Validate_Compiled_Models.bat

FAILURE OUTPUTS
If native validation fails, no final OSM pair is committed. A timestamped
FAILED_COMPILE folder retains the staged OSMs, full native logs, translated IDF,
EnergyPlus smoke-test files, interim report, and failure summary.

REQUIREMENTS
- Windows and Python 3.10+
- Shapely 2.1+
- NumPy 1.26+
- ONNX Runtime (DirectML on Windows, CPU fallback elsewhere)
- Matching OpenStudio CLI / EnergyPlus for native release validation

WINDOWS APPLICATION PACKAGING
- GeometryCompiler.exe is the signed-style GUI launcher for this source release.
  Keep it beside Start Compiler.bat and the Python source.
- GeometryCompiler.ico and GeometryCompiler_icon.png are the application assets.
- BUILD_STANDALONE_EXE.bat and GeometryCompiler_release.spec reproduce a
  self-contained PyInstaller EXE on a Windows build workstation.

MODEL NOTICE
See local_ai_model/MODEL_NOTICE.txt for the pinned model revision, provenance,
and Apache-2.0 license notice.
