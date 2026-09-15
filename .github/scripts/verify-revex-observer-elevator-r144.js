const fs=require('fs');
const read=p=>fs.readFileSync(p,'utf8');
const must=(s,n,m)=>{if(!s.includes(n))throw new Error(m+': '+n)};
const mustNot=(s,n,m)=>{if(s.includes(n))throw new Error(m+': '+n)};

const observer=read('docs/liber-apps/apps/revex/observer-focus-api-r143.js');
const elevator=read('docs/liber-apps/apps/revex/observer-elevator-r144.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const service=read('src/Liber.Revex.Revit/Services/ObserverFamilyService.cs');
const handler=read('src/Liber.Revex.Revit/Revit/RevexObserverExternalHandler.cs');
const bridge=read('src/Liber.Revex.Revit/UI/RevexObserverBridge.cs');
const manager=read('src/Liber.Revex.Revit/UI/RendairWindowManager.cs');

must(observer,'mutationAvailable:false','observer remains read-only');
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
must(bridge,'liber:revex-observer-family-inspect-r144','WebView bridge request contract');
must(bridge,'PostWebMessageAsJson','WebView bridge must return structured inspection');
mustNot(bridge,'Transaction','Observer bridge must not mutate Revit');
must(manager,'RevexObserverBridge.Configure();','Observer lifecycle must be configured');
must(manager,'RevexObserverBridge.Release();','Observer lifecycle must be released');

console.log('REVEX_OBSERVER_ELEVATOR_R145=PASSED');
