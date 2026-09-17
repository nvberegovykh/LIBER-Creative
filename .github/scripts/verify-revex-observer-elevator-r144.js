const fs=require('fs');
const read=p=>fs.readFileSync(p,'utf8');
const must=(s,n,m)=>{if(!s.includes(n))throw new Error(m+': '+n)};
const mustNot=(s,n,m)=>{if(s.includes(n))throw new Error(m+': '+n)};

const observer=read('docs/liber-apps/apps/revex/observer-focus-api-r143.js');
const elevator=read('docs/liber-apps/apps/revex/observer-elevator-r144.js');
const stopObserver=read('docs/liber-apps/apps/revex/observer-elevator-stops-r149.js');
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
must(elevator,"'S7 add the landing-side single panel per stop; verify stop visibility one stop at a time'",'planner must retain stop-by-stop landing intent');

must(stopObserver,"status:'READY_FOR_LANDING_STOPS'",'stop observer must publish a positive bounded state');
must(stopObserver,'sourceCount>=2','stop observer must require repeated source door evidence');
must(stopObserver,'/^visibility for \\d+ stops$/i','stop observer must read existing visibility-family semantics');
must(stopObserver,'gap<6||gap>25','stop observer must reject implausible vertical ladders');
must(stopObserver,'stopIndex:index+1','stop observer must return deterministic ordered stops');

must(ui,"observer-focus-api-r143.js?v=20260915r144-elevator-lab1",'Observer runtime must be loaded');
must(ui,"observer-elevator-r144.js?v=20260915r145-elevator-plan1",'r145 elevator planner must be loaded');
must(ui,"observer-elevator-stops-r149.js?v=20260915r149-stops1",'r149 native stop observer must be loaded');
must(ui,"observer-elevator-workshop-r146.js?v=20260915r150-workshop4",'r150 isolated workshop must be loaded');

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
must(bridge,'action is "infill-right-opening" or "build-right-frame" or "build-single-car-panel" or "build-landing-stop"','bridge must expose only current bounded geometry actions');
must(bridge,'ReadNullableDouble(root, "stopBaseZFt")','bridge must carry native stop elevation evidence');
must(bridge,'ReadNullableInt(root, "stopIndex")','bridge must carry ordered stop identity');
must(bridge,'ReadNullableString(root, "visibilityParameter")','bridge must carry source visibility semantics');
must(bridge,'PostWebMessageAsJson','WebView bridge must return structured results');
must(manager,'RevexObserverBridge.Configure();','Observer lifecycle must be configured');
must(manager,'RevexObserverBridge.Release();','Observer lifecycle must be released');

for(const action of ['retire-rear-glass','infill-right-opening','build-right-frame','build-single-car-panel','build-landing-stop'])
  must(workshopJs,`action:'${action}'`,`browser workshop must expose ${action}`);
for(const state of ['S3','S4','S5','S6','S7'])must(workshopJs,`state:'${state}'`,`browser workshop must journal ${state}`);
must(workshopJs,'for(const stop of stopPlan.stops)','S7 must execute one native stop at a time');
must(workshopJs,'sourceCandidatePath=result.candidatePath','each landing stop must continue from the preceding checkpoint');
must(workshopJs,'visibilityParameter:stop.visibilityParameter||null','S7 must pass source visibility semantics');
must(workshopJs,'proveS7','workshop must expose a complete S0-through-S7 proving path');

must(workshopService,'projectDocument.EditFamily(family)','S3 must operate a detached family document');
must(workshopService,'new Transaction(familyDocument, "LIBER:ELEVATOR:S3:RETIRE_REAR_GLASS")','S3 must be one named native transaction');
must(workshopService,'new Transaction(familyDocument, "LIBER:ELEVATOR:S4:INFILL_RIGHT_OPENING")','S4 must be one named native transaction');
must(workshopService,'new Transaction(familyDocument, "LIBER:ELEVATOR:S5:RIGHT_FRAME")','S5 must be one named native transaction');
must(workshopService,'new Transaction(familyDocument, "LIBER:ELEVATOR:S6:SINGLE_CAR_PANEL")','S6 must be one named native transaction');
must(workshopService,'new Transaction(familyDocument, $"LIBER:ELEVATOR:S7:LANDING_STOP_{stopIndex:D2}")','each S7 stop must be a separate named native transaction');
must(workshopService,'S3_REAR_GLASS_RETIRED.rfa','S3 checkpoint must be explicit');
must(workshopService,'S4_RIGHT_OPENING_INFILLED.rfa','S4 checkpoint must be explicit');
must(workshopService,'S5_RIGHT_FRAME.rfa','S5 checkpoint must be explicit');
must(workshopService,'S6_SINGLE_CAR_PANEL.rfa','S6 checkpoint must be explicit');
must(workshopService,'$"S7_STOP_{stopIndex:D2}.rfa"','S7 must checkpoint each stop independently');
must(workshopService,'stopIndex == 1 ? 1 : 4','stop 1 must reuse S5 frame; upper stops must add one panel plus three frame pieces');
must(workshopService,'ResolveLandingSeparation','S7 must derive landing/car plane separation from native parameters');
must(workshopService,'Right Elevator Door Offset','S7 must inspect the source elevator-door offset');
must(workshopService,'Right Lobby Door Offset','S7 must inspect the source lobby-door offset');
must(workshopService,'AssociateVisibility','S7 repeated geometry must bind existing family visibility parameters');
must(workshopService,'_Elevator Door Finish','landing panel must preserve source landing-door material semantics');
must(workshopService,'_Elevator Door Frame Finish','landing frames must preserve source frame material semantics');
must(workshopService,'expectedSource = stopIndex == 1','S7 must enforce sequential source artifacts');
must(workshopService,'VerifyAddedForms','every additive state must validate topology before acceptance');
must(workshopService,'SaveCopy(familyDocument, candidatePath)','each state must materialize an isolated candidate');
must(workshopService,'familyDocument.Close(false)','workshop family document must close without project reload');
mustNot(workshopService,'.LoadFamily(','workshop must never load the candidate into the active project');
mustNot(workshopService,'projectDocument.Delete(','workshop must never delete from the active project');
must(workshopService,'RequireSame(state, "walls"','primary family wall scaffold must be preserved');
must(workshopService,'RequireSame(state, "reference planes"','reference-plane scaffold must be preserved');
must(workshopService,'RequireSame(state, "dimensions"','dimension scaffold must be preserved');
must(workshopService,'RequireSame(state, "nested families"','nested family identities must be preserved');

must(workshopHandler,'IExternalEventHandler','workshop must run through Revit ExternalEvent');
must(workshopHandler,'_service.Execute(document, item.Request)','workshop handler must delegate to bounded workshop service');

console.log('REVEX_OBSERVER_ELEVATOR_R150=PASSED');
