#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import revex_geometryco_source_condition as resolver


def row(new_handle: str, new_space: str, old_handle: str, old_space: str, *, ambiguous: bool, family: str | None, profile: dict, score: float = 0.96) -> dict:
    return {
        "new_handle": new_handle,
        "new_space": new_space,
        "old_handle": old_handle,
        "old_space": old_space,
        "ambiguous": ambiguous,
        "score": score,
        "source_match_score": score,
        "architectural_label_confidence": 0.99 if family else None,
        "conditioning_family": family,
        "profile": profile,
    }


def main() -> int:
    assert resolver.core.MINIMUM_MAPPING_CONFIDENCE == 0.75
    assert resolver._condition_family("HeatedAndCooled") == "occupied_or_accessory"
    assert resolver._condition_family("Unconditioned") == "unconditioned_core"
    assert resolver._condition_family("") is None

    baseline_profile = {"thermal_zone": "OS:ThermalZone:Residential Baseline", "space_type": "OS:SpaceType:Multifamily"}
    proposed_profile = {"thermal_zone": "OS:ThermalZone:Residential Proposed", "space_type": "OS:SpaceType:Multifamily"}

    handles = ["{00000000-0000-0000-0000-000000000001}", "{00000000-0000-0000-0000-000000000002}"]
    resolved_handles = [
        "{00000000-0000-0000-0000-000000000101}",
        "{00000000-0000-0000-0000-000000000102}",
        "{00000000-0000-0000-0000-000000000103}",
    ]
    baseline_rows = [
        row(resolved_handles[i], f"ROOM {i+1}", f"{{10000000-0000-0000-0000-00000000010{i+1}}}", f"BASE ROOM {i+1}", ambiguous=False, family="occupied_or_accessory", profile=baseline_profile)
        for i in range(3)
    ]
    proposed_rows = [
        row(resolved_handles[i], f"ROOM {i+1}", f"{{20000000-0000-0000-0000-00000000010{i+1}}}", f"PROP ROOM {i+1}", ambiguous=False, family="occupied_or_accessory", profile=proposed_profile)
        for i in range(3)
    ]
    baseline_ambiguous = [
        row(handles[i], f"AUTO GAP {i+1}", f"{{30000000-0000-0000-0000-00000000000{i+1}}}", f"UNKNOWN {i+1}", ambiguous=True, family=None, profile={}, score=0.40)
        for i in range(2)
    ]
    proposed_ambiguous = [
        row(handles[i], f"AUTO GAP {i+1}", f"{{40000000-0000-0000-0000-00000000000{i+1}}}", f"UNKNOWN {i+1}", ambiguous=True, family=None, profile={}, score=0.40)
        for i in range(2)
    ]

    preflight = {
        "mapping": {
            "baseline": {"rows": baseline_rows + baseline_ambiguous, "ambiguous": baseline_ambiguous, "ambiguous_count": 2},
            "proposed": {"rows": proposed_rows + proposed_ambiguous, "ambiguous": proposed_ambiguous, "ambiguous_count": 2},
        }
    }

    all_handles = resolved_handles + handles
    spaces = [SimpleNamespace(handle=h, obj_type="OS:Space", name=f"SPACE {index}") for index, h in enumerate(all_handles, start=1)]
    model = SimpleNamespace(
        by_type={"OS:Space": spaces},
        by_handle={space.handle: space for space in spaces},
    )
    properties = {
        h: {"gbXMLId": f"sp-{index}"}
        for index, h in enumerate(all_handles, start=1)
    }

    with tempfile.TemporaryDirectory(prefix="revex-r91-source-condition-") as temp:
        root = Path(temp)
        outdir = root / "02_COMPILED_MODELS"
        source = root / "00_SOURCE_EVIDENCE" / "revit-energy.xml"
        source.parent.mkdir(parents=True)
        source.write_text(
            """<?xml version="1.0" encoding="UTF-8"?>
<gbXML xmlns="http://www.gbxml.org/schema">
  <Campus id="campus"><Building id="building">
    <Space id="sp-1" conditionType="HeatedAndCooled"><Name>ROOM 1</Name></Space>
    <Space id="sp-2" conditionType="HeatedAndCooled"><Name>ROOM 2</Name></Space>
    <Space id="sp-3" conditionType="HeatedAndCooled"><Name>ROOM 3</Name></Space>
    <Space id="sp-4" conditionType="HeatedAndCooled"><Name>AUTO GAP 1</Name></Space>
    <Space id="sp-5" conditionType="HeatedAndCooled"><Name>AUTO GAP 2</Name></Space>
  </Building></Campus>
</gbXML>
""",
            encoding="utf-8",
        )

        original_preflight = resolver.core.preflight_pair
        original_parse = resolver.core.parse_osm
        original_props = resolver.core.additional_properties
        original_candidates = resolver._source_xml_candidates
        try:
            resolver.core.preflight_pair = lambda *args, **kwargs: preflight
            resolver.core.parse_osm = lambda *args, **kwargs: model
            resolver.core.additional_properties = lambda *args, **kwargs: properties
            resolver._source_xml_candidates = lambda _outdir: [source]
            config, audit = resolver._resolve_ambiguous_from_source(
                root / "geometry.osm", root / "baseline.osm", root / "proposed.osm", outdir, {}
            )
        finally:
            resolver.core.preflight_pair = original_preflight
            resolver.core.parse_osm = original_parse
            resolver.core.additional_properties = original_props
            resolver._source_xml_candidates = original_candidates

        assert audit is not None
        assert audit["resolvedCount"] == 2
        assert audit["preflightAmbiguous"] == {"baseline": 2, "proposed": 2}
        assert audit["minimumMappingConfidence"] == 0.75
        assert audit["allowAmbiguous"] is False
        assert len(config["baseline"]["space_overrides"]) == 2
        assert len(config["proposed"]["space_overrides"]) == 2
        assert all(value["reason"] == "authoritative_gbxml_conditionType_plus_template_profile_consensus" for value in config["baseline"]["space_overrides"].values())
        assert all(value["match_old"].startswith("{10000000-") for value in config["baseline"]["space_overrides"].values())
        assert all(value["match_old"].startswith("{20000000-") for value in config["proposed"]["space_overrides"].values())
        assert all(item["conditioningFamily"] == "occupied_or_accessory" for item in audit["rows"])

    # Consensus below the unchanged 75% threshold must still stop.
    weak = {
        "rows": [
            row("a", "A", "old-a", "A", ambiguous=False, family="occupied_or_accessory", profile={"zone": "1"}),
            row("b", "B", "old-b", "B", ambiguous=False, family="occupied_or_accessory", profile={"zone": "2"}),
            row("c", "C", "old-c", "C", ambiguous=False, family="occupied_or_accessory", profile={"zone": "3"}),
            row("d", "D", "old-d", "D", ambiguous=False, family="occupied_or_accessory", profile={"zone": "1"}),
        ]
    }
    try:
        resolver._dominant_reference(weak, "occupied_or_accessory")
        raise AssertionError("Weak template consensus was accepted")
    except resolver.core.CompileError:
        pass

    print(json.dumps({
        "REVEX_GEOMETRYCO_SOURCE_CONDITION_R91": "PASSED",
        "minimumMappingConfidence": resolver.core.MINIMUM_MAPPING_CONFIDENCE,
        "allowAmbiguous": False,
        "sourceIdentityRequired": True,
        "explicitConditionTypeRequired": True,
        "templateConsensusRequired": True,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
