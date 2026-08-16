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
            const own=(o,k)=>{try{return o&&o[k]!==undefined?o[k]:null}catch(_){return null}};
            const field=(id)=>{const e=document.getElementById(id);return e?{
              id:e.id,name:e.name||'',value:e.value||'',
              onchange:e.getAttribute('onchange')||'',onblur:e.getAttribute('onblur')||''
            }:null};
            const project=USER_PROJECT&&USER_PROJECT.project;
            const details=project&&project.projectDetails;
            const building=project&&project.buildingDetails;
            return {
              location:String(location.href),
              ProjectActionType:typeof ProjectAction,
              ProjectActionKeys:typeof ProjectAction==='undefined'?[]:safeKeys(ProjectAction),
              ProjectServiceType:typeof ProjectService,
              ProjectServiceKeys:typeof ProjectService==='undefined'?[]:safeKeys(ProjectService),
              userProjectKeys:safeKeys(USER_PROJECT),
              projectKeys:safeKeys(project),
              projectDetailsKeys:safeKeys(details),
              buildingDetailsKeys:safeKeys(building),
              projectTitle:own(project,'projectTitle'),
              projectAddress:own(project,'projectAddress'),
              projectCity:own(project,'projectCity'),
              projectState:own(project,'projectState'),
              projectZipCode:own(project,'projectZipCode'),
              fields:['projectTitle','projectAddress','projectCity','projectState','projectZipCode'].map(field),
              updateProjectSource:typeof ProjectAction!=='undefined'&&ProjectAction.updateProject?String(ProjectAction.updateProject).slice(0,1200):'',
              getProjectSource:typeof ProjectAction!=='undefined'&&ProjectAction.getProject?String(ProjectAction.getProject).slice(0,1200):''
            };
            """
        )
        print("REVEX_COMCHECK_PROJECT_API=" + json.dumps(probe, sort_keys=True))
        return 0
    finally:
        driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
