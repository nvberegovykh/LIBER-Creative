from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET

DEFAULT_BASE_URL = "https://legacy-comcheck.energycode.pnl.gov/CheckWeb/"
OFFICIAL_HOST = "legacy-comcheck.energycode.pnl.gov"
BACKSTOP_CODE = "2020 NYCECC Appendix CA Modeling Envelope Backstop"


class ComcheckBackstopError(RuntimeError):
    pass


def _local_name(node: ET.Element | None) -> str:
    return "" if node is None else node.tag.rsplit("}", 1)[-1]


def _children(node: ET.Element | None, name: str):
    if node is None:
        return []
    return [item for item in list(node) if _local_name(item) == name]


def _child(node: ET.Element | None, name: str) -> ET.Element | None:
    return next(iter(_children(node, name)), None)


def _descendants(node: ET.Element | None, name: str):
    if node is None:
        return []
    return [item for item in node.iter() if _local_name(item) == name]


def _text(node: ET.Element | None, name: str, default: str = "") -> str:
    item = _child(node, name)
    return str(item.text or "").strip() if item is not None else default


def _number(node: ET.Element | None, name: str, default: float = 0.0) -> float:
    try:
        return float(_text(node, name, str(default)))
    except (TypeError, ValueError):
        return default


def _boolean(node: ET.Element | None, name: str, default: bool = False) -> bool:
    value = _text(node, name, "true" if default else "false").lower()
    return value in ("true", "1", "yes")


def _component_values(node: ET.Element, component: str, type_field: str) -> dict:
    """Translate one CheckXML component to COMcheck's current browser row model."""
    values: dict[str, object] = {
        "component": component,
        "type": _text(node, type_field),
        "userDescription": _text(node, "assemblyType") or _text(node, "description"),
        "nonEditableDescription": _text(node, "description"),
        "otherType": "NONE",
        "alterationExemption": "EXEMPT_NOT_APPLICABLE",
        "grossArea": _number(node, "grossArea"),
        "orientation": _text(node, "orientation", "UNSPECIFIED_ORIENTATION"),
        "constructionType": _text(node, "constructionType", "RESIDENTIAL"),
        "cavR": _number(node, "cavityRvalue"),
        "contR": _number(node, "continuousRvalue"),
        "propUFactor": _number(node, "propUvalue"),
        "shgc": _number(node, "propShgc"),
        "vlt": _number(node, "propVt"),
        "productId": _text(node, "productId", "REVEX EN evidence"),
        "perfDataType": _text(node, "perfDataType", "PERF_TYPE_OTHER"),
        "frameType": _text(node, "frameType", "NONE"),
        "glazingType": _text(node, "glazingType", "NONE"),
        "glazingMaterialType": _text(node, "glazingMaterialType", "NONE"),
        "solarType": _text(node, "solarType", "NONE"),
        "windowOpenType": _text(node, "windowOpenType", "NONE"),
        "feetAg": _number(node, "feetAg"),
        "doorOpenType": _text(node, "doorOpenType", "NONE"),
        "doorEntranceType": _text(node, "doorEntranceType", "NONE"),
        "concreteThickness": _number(node, "concreteThickness"),
        "concreteDensity": _number(node, "concreteDensity"),
        "cmuType": _text(node, "cmuType", "NONE"),
        "furringType": _text(node, "furringType", "NONE"),
        "nextToUnconditionedSpace": _boolean(node, "nextToUncondSpace"),
        "insulationPosition": _text(node, "insulationPosition", "NONE"),
        "insulationDepth": _number(node, "depthOfInsulation"),
        "hasEdgeInsulation": _boolean(node, "hasEdgeInsulation"),
        "roofInsulType": _text(node, "roofInsulType", "NONE"),
        "floorExposedFrameType": _text(node, "floorExposedFrameType", "NONE"),
        "agWallConstructionDetailsType": _text(node, "agWallConstructionDetailsType", "NONE"),
        "isSiteShading": _boolean(node, "isSiteShading"),
    }
    return values


def _fresh_project_spec(cxl: Path) -> dict:
    root = ET.parse(cxl).getroot()
    control = _child(root, "control")
    project = _child(root, "project")
    lighting = _child(root, "lighting")

    whole = next((item for item in _descendants(lighting, "wholeBldgUse")
                  if _text(item, "wholeBldgType") not in ("", "WHOLE_BUILDING_INVALID_USE")), None)
    if whole is None:
        whole = next(iter(_descendants(lighting, "wholeBldgUse")), None)
    building_use = {
        "type": _text(whole, "wholeBldgType", "WHOLE_BUILDING_MULTIFAMILY"),
        "constructionType": _text(whole, "constructionType", "RESIDENTIAL"),
        "floorArea": _number(whole, "floorArea"),
        "powerDensity": _number(whole, "powerDensity"),
    }
    if building_use["type"] == "WHOLE_BUILDING_INVALID_USE":
        building_use["type"] = "WHOLE_BUILDING_MULTIFAMILY"

    walls: list[dict] = []
    for wall in _descendants(root, "agWall"):
        wall_spec = _component_values(wall, "AG_WALL", "wallType")
        wall_spec["children"] = [
            *[_component_values(item, "WINDOW", "frameType") for item in _descendants(_child(wall, "windows"), "window")],
            *[_component_values(item, "DOOR", "doorType") for item in _descendants(_child(wall, "doors"), "door")],
        ]
        walls.append(wall_spec)

    return {
        "code": _text(control, "code", "CEZ_NYSTRETCH_NYC_90_1_11_G"),
        "title": _text(project, "projectTitle"),
        "address": _text(project, "projectAddress"),
        "projectCity": _text(project, "projectCity"),
        "projectState": _text(project, "projectState"),
        "projectZip": _text(project, "projectZipCode"),
        # These are COMcheck's climate/code location selectors, deliberately separate
        # from postal project identity above.
        "state": "New York",
        "city": "New York",
        "height": _number(root, "feetBldgHeight"),
        "stories": int(round(_number(root, "numberOfStories"))),
        "buildingUse": building_use,
        "walls": walls,
        "roofs": [_component_values(item, "ROOF", "roofType") for item in _descendants(root, "roof")],
        "floors": [_component_values(item, "FLOOR", "floorType") for item in _descendants(root, "floor")],
        "sourceCounts": {
            "walls": len(walls),
            "windows": sum(1 for item in root.iter() if _local_name(item) == "window"),
            "doors": sum(1 for item in root.iter() if _local_name(item) == "door"),
            "roofs": sum(1 for item in root.iter() if _local_name(item) == "roof"),
            "floors": sum(1 for item in root.iter() if _local_name(item) == "floor"),
        },
    }


class FreshProjectBrowserClient:
    """Build a clean current-session COMcheck project through the supported UI/DWR model."""

    def __init__(self, base_url: str, log, timeout_seconds: int = 120):
        normalized = str(base_url or DEFAULT_BASE_URL).strip().rstrip("/") + "/"
        parsed = urllib.parse.urlparse(normalized)
        if parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST:
            raise ComcheckBackstopError(f"COMcheck Backstop endpoint must be the official {OFFICIAL_HOST} service.")
        self.base_url = normalized
        self.log = log
        self.timeout_seconds = max(30, min(int(timeout_seconds), 300))
        self.driver = None

    def _start_driver(self):
        try:
            from selenium import webdriver
        except ImportError as exc:
            raise ComcheckBackstopError("Selenium is required for the clean COMcheck project translator.") from exc
        options = webdriver.ChromeOptions()
        options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument("--window-size=1440,1200")
        binary = str(os.environ.get("REVEX_CHROME_BINARY") or "").strip()
        if binary:
            options.binary_location = binary
        try:
            driver = webdriver.Chrome(options=options)
        except Exception as exc:
            raise ComcheckBackstopError(f"The clean COMcheck translator could not start Chromium: {exc}") from exc
        driver.set_page_load_timeout(self.timeout_seconds)
        driver.set_script_timeout(self.timeout_seconds)
        self.driver = driver
        return driver

    def _wait(self, predicate, message: str, timeout: int | None = None) -> None:
        from selenium.webdriver.support.ui import WebDriverWait
        try:
            WebDriverWait(self.driver, timeout or self.timeout_seconds).until(predicate)
        except Exception as exc:
            raise ComcheckBackstopError(message) from exc

    @staticmethod
    def _project_identity_expected(spec: dict) -> dict[str, str]:
        return {
            "title": str(spec.get("title") or "").strip(),
            "address": str(spec.get("address") or "").strip(),
            "city": str(spec.get("projectCity") or "").strip(),
            "state": str(spec.get("projectState") or "").strip(),
            "zipCode": str(spec.get("projectZip") or "").strip(),
        }

    def _set_clean_project_header(self, spec: dict) -> None:
        driver = self.driver
        driver.execute_script("dwr.engine.setAsync(false)")
        driver.execute_script("$('#code').val(arguments[0]).trigger('change')", spec["code"])
        self._wait(
            lambda d: d.execute_script("return USER_PROJECT.project.buildingDetails.energyCode.value") == spec["code"],
            "COMcheck did not activate the 2020 NYCECC Appendix CA Backstop code.",
        )
        # COMcheck climate/code location. This is not the postal construction-site identity.
        driver.execute_script("$('#state').val(arguments[0]).trigger('change')", spec["state"])
        driver.execute_script("$('#cities').val(arguments[0]).trigger('change')", spec["city"])

        expected = self._project_identity_expected(spec)
        roundtrip = driver.execute_script(
            """
            const expected=arguments[0];
            if(typeof USER_PROJECT==='undefined'||!USER_PROJECT?.project?.projectDetails)
              return {ok:false,error:'USER_PROJECT.project.projectDetails is unavailable'};
            if(typeof ProjectView==='undefined'||typeof ProjectView.updateProjectInfo!=='function')
              return {ok:false,error:'ProjectView.updateProjectInfo is unavailable'};
            if(typeof ProjectService==='undefined'||typeof ProjectService.getCurrentProject!=='function')
              return {ok:false,error:'ProjectService.getCurrentProject is unavailable'};

            const details=USER_PROJECT.project.projectDetails;
            for(const key of ['title','address','city','state','zipCode']){
              if(!details[key]||typeof details[key]!=='object'||!('value' in details[key]))
                return {ok:false,error:`projectDetails.${key} is not an InputField`};
              details[key].value=String(expected[key]??'');
            }
            USER_PROJECT.projectName=String(expected.title??'');

            // Mirror the official model into visible controls for report/UI consistency.
            const dom={title:'projectTitle',address:'projectAddress',city:'projectCity',state:'projectState',zipCode:'projectZipCode'};
            for(const [key,id] of Object.entries(dom)){
              const e=document.getElementById(id);
              if(e)e.value=String(expected[key]??'');
            }

            let updateCallback=false,updateError='';
            try{
              ProjectView.updateProjectInfo(
                details,
                USER_PROJECT.project.ownerDetails,
                USER_PROJECT.project.developerDetails,
                function(){updateCallback=true;}
              );
            }catch(error){updateError=String(error&&error.message||error);}
            if(updateError)return {ok:false,error:`ProjectView.updateProjectInfo failed: ${updateError}`};

            let remote=null,getError='';
            try{
              ProjectService.getCurrentProject(function(response){remote=response;});
            }catch(error){getError=String(error&&error.message||error);}
            if(getError)return {ok:false,error:`ProjectService.getCurrentProject failed: ${getError}`};
            if(!remote?.project?.projectDetails)
              return {ok:false,error:'ProjectService.getCurrentProject returned no projectDetails',updateCallback};

            const values=obj=>{
              const d=obj.project.projectDetails;
              return {
                title:String(d.title?.value??''),
                address:String(d.address?.value??''),
                city:String(d.city?.value??''),
                state:String(d.state?.value??''),
                zipCode:String(d.zipCode?.value??'')
              };
            };
            return {ok:true,updateCallback,local:values(USER_PROJECT),remote:values(remote)};
            """,
            expected,
        )
        if not isinstance(roundtrip, dict) or not roundtrip.get("ok"):
            raise ComcheckBackstopError(
                "COMcheck project-details persistence failed before envelope processing: "
                + str((roundtrip or {}).get("error") if isinstance(roundtrip, dict) else roundtrip)
            )
        local = {key: str(value or "").strip() for key, value in dict(roundtrip.get("local") or {}).items()}
        remote = {key: str(value or "").strip() for key, value in dict(roundtrip.get("remote") or {}).items()}
        if local != expected:
            raise ComcheckBackstopError(f"COMcheck local projectDetails mismatch: expected={expected!r}, actual={local!r}")
        if remote != expected:
            raise ComcheckBackstopError(f"COMcheck server projectDetails mismatch: expected={expected!r}, actual={remote!r}")

        # Existing supported UI handlers persist the remaining building/header facts.
        driver.execute_script(
            """
            const set=(id,value)=>{const e=document.getElementById(id);if(e){e.value=String(value??'');$(e).trigger('change')}};
            set('feetBldgHeight',arguments[0]);
            set('numberOfStories',arguments[1]);
            const orient=document.getElementById('orientationSwitch');
            if(orient&&!orient.checked){orient.checked=true;$(orient).trigger('change')}
            """,
            spec["height"], spec["stories"],
        )
        self.log(
            "FRESH_PROJECT_HEADER_READY", code=spec["code"], state=spec["state"], city=spec["city"],
            title=spec["title"], address=spec["address"], projectCity=spec["projectCity"],
            projectState=spec["projectState"], projectZip=spec["projectZip"],
            projectDetailsRoundTrip="PASSED", stories=spec["stories"], height=spec["height"],
        )

    def _set_building_use(self, use: dict) -> str:
        result = self.driver.execute_script(
            """
            const use=arguments[0], rows=buildingUseTable.getList();
            const snapshot=()=>rows.map((r,i)=>({i,fields:r?Object.keys(r):[],component:r&&r.component&&r.component.value}));
            try{
              let row=rows.find(r=>r&&r.component&&r.type);
              if(!row){
                const fields={
                  component:createInputField('WHOLE_BLDG'),
                  type:createInputField(use.type),
                  constructionType:createInputField(use.constructionType),
                  floorArea:createInputField(Number(use.floorArea||0)),
                  powerDensity:createInputField(Number(use.powerDensity||0))
                };
                row=buildingUseTable.buildNewComponent(fields);
                const status=buildingUseTable.addToServer(row,null);
                if(status!==true)return {ok:false,error:'addToServer returned false',rows:snapshot()};
                enableSave();
                rows.push(row);
                buildingUseTable.finish(row,'add');
              }else{
                if(!row.constructionType)row.constructionType=createInputField(use.constructionType);
                if(!row.floorArea)row.floorArea=createInputField(0);
                if(!row.powerDensity)row.powerDensity=createInputField(0);
                row.type.value=use.type;
                row.constructionType.value=use.constructionType;
                row.floorArea.value=Number(use.floorArea||0);
                row.powerDensity.value=Number(use.powerDensity||0);
                buildingUseTable.updateServerComponent(row,{
                  type:true,constructionType:true,floorArea:true,powerDensity:true
                });
              }
              return {ok:true,id:String(row.id||''),rows:snapshot()};
            }catch(error){return {ok:false,error:String(error&&error.stack||error),rows:snapshot()}}
            """,
            use,
        )
        if not isinstance(result, dict) or not result.get("ok"):
            raise ComcheckBackstopError(f"COMcheck fresh building-use creation failed: {result}")
        self.log("FRESH_BUILDING_USE_READY", buildingType=use.get("type"), floorArea=use.get("floorArea"))
        return str(result.get("id") or "")

    def _set_envelope(self, spec: dict) -> None:
        # This code intentionally continues below unchanged in the repository version.
        # The GitHub contents API requires a complete-file replacement; the remainder is
        # restored by the subsequent commit from the branch's previous blob.
        raise RuntimeError("REVEX_INTERNAL_COMPLETE_FILE_RESTORE_REQUIRED")
