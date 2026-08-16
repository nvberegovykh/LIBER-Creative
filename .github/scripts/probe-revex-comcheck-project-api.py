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
            lambda d: d.execute_script("return typeof USER_PROJECT!=='undefined'&&USER_PROJECT!==null&&typeof ProjectView!=='undefined'"),
            "COMcheck USER_PROJECT/ProjectView did not initialize.",
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
            const eventHandlers=(e)=>{
              if(!e||!window.jQuery||!jQuery._data)return {};
              try{
                const events=jQuery._data(e,'events')||{},out={};
                for(const [kind,rows] of Object.entries(events)){
                  out[kind]=(rows||[]).map(row=>String(row&&row.handler||'').slice(0,1800));
                }
                return out;
              }catch(_){return {error:String(_)}};
            };
            const field=(id)=>{const e=document.getElementById(id);return e?{
              id:e.id,name:e.name||'',value:e.value||'',
              onchange:e.getAttribute('onchange')||'',onblur:e.getAttribute('onblur')||'',
              events:eventHandlers(e)
            }:null};
            const project=USER_PROJECT&&USER_PROJECT.project;
            const details=project&&project.projectDetails;
            const building=project&&project.buildingDetails;
            const detailSnapshot={};
            for(const key of safeKeys(details))detailSnapshot[key]=describe(details[key]);
            const globals=safeKeys(window).filter(k=>/project|detail/i.test(k)).filter(k=>typeof window[k]==='function').slice(0,100);
            const globalSources={};
            for(const key of globals){try{globalSources[key]=String(window[key]).slice(0,1200)}catch(_){}}
            return {
              location:String(location.href),
              ProjectViewType:typeof ProjectView,
              ProjectViewKeys:typeof ProjectView==='undefined'?[]:safeKeys(ProjectView),
              updateProjectInfoType:typeof ProjectView!=='undefined'&&ProjectView.updateProjectInfo?typeof ProjectView.updateProjectInfo:'undefined',
              updateProjectInfoLength:typeof ProjectView!=='undefined'&&ProjectView.updateProjectInfo?ProjectView.updateProjectInfo.length:null,
              updateProjectInfoSource:typeof ProjectView!=='undefined'&&ProjectView.updateProjectInfo?String(ProjectView.updateProjectInfo).slice(0,2200):'',
              ProjectServiceType:typeof ProjectService,
              ProjectServiceKeys:typeof ProjectService==='undefined'?[]:safeKeys(ProjectService),
              userProjectKeys:safeKeys(USER_PROJECT),
              projectKeys:safeKeys(project),
              projectDetailsKeys:safeKeys(details),
              projectDetails:detailSnapshot,
              buildingDetailsKeys:safeKeys(building),
              projectName:describe(USER_PROJECT&&USER_PROJECT.projectName),
              fields:['projectTitle','projectAddress','projectCity','projectState','projectZipCode'].map(field),
              saveProjectLength:typeof ProjectService!=='undefined'&&ProjectService.saveProject?ProjectService.saveProject.length:null,
              saveProjectSource:typeof ProjectService!=='undefined'&&ProjectService.saveProject?String(ProjectService.saveProject).slice(0,1800):'',
              getCurrentProjectLength:typeof ProjectService!=='undefined'&&ProjectService.getCurrentProject?ProjectService.getCurrentProject.length:null,
              getCurrentProjectSource:typeof ProjectService!=='undefined'&&ProjectService.getCurrentProject?String(ProjectService.getCurrentProject).slice(0,1800):'',
              globalSaveProjectSource:typeof saveProject==='function'?String(saveProject).slice(0,2200):'',
              updateServerProjectDetailsSource:typeof updateServerProjectDetails==='function'?String(updateServerProjectDetails).slice(0,1800):'',
              updateDetailsSource:typeof updateDetails==='function'?String(updateDetails).slice(0,2200):'',
              globalProjectFunctions:globalSources,
              scripts:Array.from(document.scripts).map(s=>s.src).filter(Boolean)
            };
            """
        )
        print("REVEX_COMCHECK_PROJECT_API=" + json.dumps(probe, sort_keys=True))
        return 0
    finally:
        driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
