#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import json
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
ENERGY = ROOT / "src" / "Liber.Revex.Revit" / "Engineering" / "Energy"
sys.path.insert(0, str(ENERGY))

from comcheck_backstop import FreshProjectBrowserClient, DEFAULT_BASE_URL


def main() -> int:
    client = FreshProjectBrowserClient(DEFAULT_BASE_URL, lambda *args, **kwargs: None, timeout_seconds=90)
    driver = client._start_driver()
    try:
        driver.get(urllib.parse.urljoin(client.base_url, "index.html"))
        client._wait(
            lambda d: d.execute_script("return typeof USER_PROJECT!=='undefined'&&USER_PROJECT!==null"),
            "COMcheck USER_PROJECT did not initialize.",
        )
        probe = driver.execute_script(
            """
            const safeKeys=v=>{try{return v?Object.keys(v):[]}catch(_){return []}};
            const describe=v=>{try{return {
              type:typeof v,
              ctor:v&&v.constructor&&v.constructor.name||'',
              keys:safeKeys(v),
              value:v&&typeof v==='object'&&'value' in v?v.value:v,
              json:(()=>{try{return JSON.stringify(v)}catch(_){return ''}})()
            }}catch(_){return {type:'error'}}};
            const field=(id)=>{const e=document.getElementById(id);return e?{
              id:e.id,name:e.name||'',value:e.value||'',
              onchange:e.getAttribute('onchange')||'',onblur:e.getAttribute('onblur')||''
            }:null};
            const project=USER_PROJECT&&USER_PROJECT.project;
            const details=project&&project.projectDetails;
            const building=project&&project.buildingDetails;
            const detailSnapshot={};
            for(const key of safeKeys(details))detailSnapshot[key]=describe(details[key]);
            return {
              location:String(location.href),
              ProjectActionType:typeof ProjectAction,
              ProjectActionKeys:typeof ProjectAction==='undefined'?[]:safeKeys(ProjectAction),
              ProjectServiceType:typeof ProjectService,
              ProjectServiceKeys:typeof ProjectService==='undefined'?[]:safeKeys(ProjectService),
              userProjectKeys:safeKeys(USER_PROJECT),
              projectKeys:safeKeys(project),
              projectDetailsKeys:safeKeys(details),
              projectDetails:detailSnapshot,
              buildingDetailsKeys:safeKeys(building),
              projectName:describe(USER_PROJECT&&USER_PROJECT.projectName),
              fields:['projectTitle','projectAddress','projectCity','projectState','projectZipCode'].map(field),
              saveProjectType:typeof ProjectService!=='undefined'&&ProjectService.saveProject?typeof ProjectService.saveProject:'undefined',
              saveProjectLength:typeof ProjectService!=='undefined'&&ProjectService.saveProject?ProjectService.saveProject.length:null,
              saveProjectSource:typeof ProjectService!=='undefined'&&ProjectService.saveProject?String(ProjectService.saveProject).slice(0,1800):'',
              getCurrentProjectLength:typeof ProjectService!=='undefined'&&ProjectService.getCurrentProject?ProjectService.getCurrentProject.length:null,
              getCurrentProjectSource:typeof ProjectService!=='undefined'&&ProjectService.getCurrentProject?String(ProjectService.getCurrentProject).slice(0,1800):'',
              globalSaveProjectType:typeof saveProject,
              globalSaveProjectSource:typeof saveProject==='function'?String(saveProject).slice(0,1800):'',
              globalSaveType:typeof save,
              globalSaveSource:typeof save==='function'?String(save).slice(0,1800):''
            };
            """
        )
        print("REVEX_COMCHECK_PROJECT_API=" + json.dumps(probe, sort_keys=True))
        return 0
    finally:
        driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
