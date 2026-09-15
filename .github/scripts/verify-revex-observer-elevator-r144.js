const fs=require('fs');
const read=p=>fs.readFileSync(p,'utf8');
const must=(s,n,m)=>{if(!s.includes(n))throw new Error(m+': '+n)};
const mustNot=(s,n,m)=>{if(s.includes(n))throw new Error(m+': '+n)};

const observer=read('docs/liber-apps/apps/revex/observer-focus-api-r143.js');
const elevator=read('docs/liber-apps/apps/revex/observer-elevator-r144.js');
const workshopJs=read('docs/liber-apps/apps/revex/observer-elevator-workshop-r146.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const service=read('src/Liber.Revex.Revit/Services/ObserverFamilyService.cs');
const handler=read('src/Liber.Revex.Revit/Revit/RevexObserverExternalHandler.cs');
const workshopService=read('src/Liber.Revex.Revit/Services/ElevatorWorkshopService.cs');
const workshopHandler=read('src/Liber.Revex.Revit/Revit/RevexElevatorWorkshopExternalHandler.cs');
const bridge=read('src/Liber.Revex.Revit/UI/RevexObserverBridge.cs');
const manager=read('src/Liber.Revex.Revit/UI/RendairWindowManager.cs');

must(observer,'mutationAvailable:false','observer core remains read-only');
must(observer,'createFocus','focus API must exist');
must(elevator,"target:'single right-aligned sliding elevator entrance'",'elevator target must be explicit');
must(elevator,"panelCount:1",'single-panel target must be explicit');
must(elevator,"slideDirection:'left'",'panel pocket direction must be explicit');
must(elevator,"liber:revex-observer-family-inspect-r144",'elevator lab must use native family observer');
must(elevator,"state:'S1'",'sequential Observer state must be recorded');
must(elevator,"strategy:'reuse-existing-opposite-side-panoramic-aperture'",'planner must reuse existing rear aperture before proposing a second cab cut');
must(elevator,'pocketAvailableFt','planner must measure the sliding-panel pocket');
must(elevator,"status:pocketMargin>=0?'READY_FOR_OPENING_PREVIEW':'BLOCKED_POCKET'",'planner must gate on real pocket capacity');
must(elevator,"'S3 retire only the rear glass filler; regenerate and observe'",'sequential plan must preserve intermediate states');
must(ui,"observer-focus-api-r143.js?v=20260915r144-elevator-lab1",'Observer runtime must be loaded');
must(ui,"observer-elevator-r144.js?v=20260915r145-elevator-plan1",'r145 elevator planner must be loaded');
must(ui,"observer-elevator-workshop-r146.js?v=20260915r146-workshop1",'r146 isolated workshop must be loaded');

must(service,'projectDocument.EditFamily(family)','deep family inspection must use Revit family document');
must(service,'familyDocument.Close(false)','family observation document must close without save');
mustNot(service,'new Transaction(','Observer family service must not create transactions');
mustNot(service,'.Save(','Observer family service must not save documents');
must(service,'GetDependentElements(null)','native dependency edges must be captured');
must(service,'manager.GetAssociatedFamilyParameter(p)','parameter associations must be captured');
must(service,'dimension.References','dimension references must be captured');
must(service,'instance.HostFace','project host face must be observed');

must(handler,'IExternalEventHandler','native observer must run in Revit ExternalEvent context');
must(handler,'_service.Inspect(document, item.Request)','ExternalEvent must delegate only to read-only observer service');
must(bridge,'liber:revex-observer-family-inspect-r144','WebView bridge inspection contract');
must(bridge,'liber:revex-observer-elevator-workshop-r146','WebView bridge workshop contract');
must(bridge,'PostWebMessageAsJson','WebView bridge must return structured results');
must(manager,'RevexObserverBridge.Configure();','Observer lifecycle must be configured');
must(manager,'RevexObserverBridge.Release();','Observer lifecycle must be released');

must(workshopJs,"action:'retire-rear-glass'",'browser workshop must expose only the bounded S3 action');
must(workshopJs,"state:'S3'",'browser workshop must journal the successful S3 state');
must(workshopJs,'glass.length!==1','browser workshop must require one proven glass filler');
must(workshopJs,'candidatePath:result.candidatePath','candidate artifact must be recorded in the focus');

must(workshopService,'projectDocument.EditFamily(family)','workshop must operate a detached family document');
must(workshopService,'SaveCopy(familyDocument, baselinePath)','workshop must preserve a pre-mutation baseline copy');
must(workshopService,'new Transaction(familyDocument, "LIBER:ELEVATOR:S3:RETIRE_REAR_GLASS")','workshop mutation must be one named native transaction');
must(workshopService,'deleted.Count != 1','workshop must reject cascading deletion');
must(workshopService,'tx.RollBack()','workshop must roll back rejected transitions');
must(workshopService,'familyDocument.Regenerate()','workshop must regenerate before acceptance');
must(workshopService,'VerifyS3(before, tentative, target.Id.Value)','workshop must validate invariants before commit');
must(workshopService,'SaveCopy(familyDocument, candidatePath)','workshop must materialize an isolated candidate');
must(workshopService,'familyDocument.Close(false)','workshop family document must close without loading into project');
mustNot(workshopService,'.LoadFamily(','workshop must never load the candidate into the active project');
mustNot(workshopService,'projectDocument.Delete(','workshop must never delete from the active project');
must(workshopService,'RequireSame("walls"','primary family wall scaffold must be preserved');
must(workshopService,'RequireSame("reference planes"','reference-plane scaffold must be preserved');
must(workshopService,'RequireSame("dimensions"','dimension scaffold must be preserved');
must(workshopService,'RequireSame("nested families"','nested family identities must be preserved');

must(workshopHandler,'IExternalEventHandler','workshop must run through Revit ExternalEvent');
must(workshopHandler,'_service.Execute(document, item.Request)','workshop handler must delegate to bounded workshop service');

console.log('REVEX_OBSERVER_ELEVATOR_R146=PASSED');
