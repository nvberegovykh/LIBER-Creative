#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "src/Liber.Revex.Revit/Engineering/Energy/comcheck_backstop.py"

text = TARGET.read_text(encoding="utf-8")
start_marker = "    def _set_clean_project_header(self, spec: dict) -> None:\n"
end_marker = "    def _set_building_use(self, use: dict) -> str:\n"
start = text.find(start_marker)
end = text.find(end_marker, start + len(start_marker))
assert start >= 0 and end > start, "Could not isolate FreshProjectBrowserClient._set_clean_project_header"
old = text[start:end]
assert "set('projectAddress',arguments[1])" in old, "Expected DOM-only projectAddress setter is absent"
assert "ProjectView.updateProjectInfo" not in old, "Project details method is already patched"
assert "ProjectService.getCurrentProject" not in old, "Project-details round-trip already exists"

new = r'''    @staticmethod
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
        # COMcheck climate/code location. This is a separate schema relation from the
        # postal construction-site identity written below.
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

            // Mirror the authoritative COMcheck model into the visible Project Details
            // controls. The model/DWR update below is the persistence owner.
            const dom={title:'projectTitle',address:'projectAddress',city:'projectCity',state:'projectState',zipCode:'projectZipCode'};
            for(const [key,id] of Object.entries(dom)){
              const e=document.getElementById(id);
              if(e)e.value=String(expected[key]??'');
            }

            let updateError='';
            try{
              ProjectView.updateProjectInfo(
                details,
                USER_PROJECT.project.ownerDetails,
                USER_PROJECT.project.developerDetails,
                function(){}
              );
            }catch(error){updateError=String(error&&error.message||error);}
            if(updateError)return {ok:false,error:`ProjectView.updateProjectInfo failed: ${updateError}`};

            // DWR is deliberately synchronous in this clean-project translator. Re-read
            // the official server model immediately; local DOM state is not proof.
            let remote=null,getError='';
            try{
              ProjectService.getCurrentProject(function(response){remote=response;});
            }catch(error){getError=String(error&&error.message||error);}
            if(getError)return {ok:false,error:`ProjectService.getCurrentProject failed: ${getError}`};
            if(!remote?.project?.projectDetails)
              return {ok:false,error:'ProjectService.getCurrentProject returned no projectDetails'};

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
            return {ok:true,local:values(USER_PROJECT),remote:values(remote)};
            """,
            expected,
        )
        if not isinstance(roundtrip, dict) or not roundtrip.get("ok"):
            detail = roundtrip.get("error") if isinstance(roundtrip, dict) else roundtrip
            raise ComcheckBackstopError(
                "COMcheck project-details persistence failed before envelope processing: " + str(detail)
            )
        local = {key: str(value or "").strip() for key, value in dict(roundtrip.get("local") or {}).items()}
        remote = {key: str(value or "").strip() for key, value in dict(roundtrip.get("remote") or {}).items()}
        if local != expected:
            raise ComcheckBackstopError(f"COMcheck local projectDetails mismatch: expected={expected!r}, actual={local!r}")
        if remote != expected:
            raise ComcheckBackstopError(f"COMcheck server projectDetails mismatch: expected={expected!r}, actual={remote!r}")

        # Building height/story/orientation already have supported main-screen handlers.
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

'''

patched = text[:start] + new + text[end:]
assert patched.count("def _set_clean_project_header") == 1
assert patched.count("ProjectView.updateProjectInfo") == 3  # availability check + call + failure label
assert "ProjectService.getCurrentProject" in patched
assert "250 MIDWOOD" not in patched.upper()
assert "79 WINTHROP" not in patched.upper()
TARGET.write_text(patched, encoding="utf-8")
print("PASS: surgically replaced COMcheck project-details persistence owner")
