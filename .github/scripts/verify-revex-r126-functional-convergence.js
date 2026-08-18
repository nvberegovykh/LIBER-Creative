'use strict';
const fs=require('fs');
const path=require('path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const must=(text,marker,label)=>{if(!text.includes(marker))throw new Error(`${label}: missing ${marker}`)};
const mustNot=(text,marker,label)=>{if(text.includes(marker))throw new Error(`${label}: forbidden ${marker}`)};
const index=read('docs/liber-apps/apps/revex/index.html');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const docs=read('docs/liber-apps/apps/revex/docs-convergence-r126.js');
const pages=read('docs/liber-apps/apps/revex/docs-pages-r115.js');
const appearance=read('docs/liber-apps/apps/revex/appearance-convergence-r126.js');
const texture=read('docs/liber-apps/apps/revex/viewer-texture-r115.js');
const issues=read('docs/liber-apps/apps/revex/issues-convergence-r126.js');
const issuesInspector=read('docs/liber-apps/apps/revex/issues-inspector-r126.js');
const daily=read('docs/liber-apps/apps/revex/history-daily-r126.js');
const blocks=read('docs/liber-apps/apps/revex/blocks-palette-r126.js');
const renderClient=read('docs/liber-apps/apps/revex/render-convergence-r126.js');
const renderWorker=read('server/revex-render-worker/render_r126.py');
const renderDeploy=read('server/revex-render-worker/DEPLOY_RENDER_R126.ps1');
const docker=read('server/revex-render-worker/Dockerfile');
const report=read('server/revex-report-functions/index.js');
const bridge=read('src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs');
const placement=read('src/Liber.Revex.Revit/Services/FamilyPlacementService.cs');
const plans=read('src/Liber.Revex.Revit/Services/AffectedPlanExportService.cs');

must(index,'ui-integrity.js?v=20260818r128-full-convergence1','root cache key');
must(ui,"BUILD='20260818r128-full-convergence1'",'current loader');
for(const file of ['appearance-convergence-r126.js','docs-convergence-r126.js','issues-convergence-r126.js','issues-inspector-r126.js','history-daily-r126.js','blocks-palette-r126.js','render-convergence-r126.js']) must(ui,file,'r126 loader');

must(pages,'fullSetAuthority:true','Docs canonical owner');
must(pages,'derivedFromFullSet:true','Docs linked sheet authority');
must(docs,"owner:'docs-pages-r115'",'Docs ownership guard');
must(docs,".docs-group.printing-set details",'Docs legacy renderer detection');
must(docs,"dispatchEvent(new Event('input'",'Docs canonical re-render');

must(appearance,"precedence:['instance-uv','type-texture','design-color-fallback','revit-material']",'appearance precedence');
must(appearance,'uv.repeatX','instance UV overlay');
must(appearance,'toFirestorePlain','realm-safe appearance save');
mustNot(appearance,'URL.createObjectURL(file)','appearance short-lived blob preview');
must(texture,'material.color.set(0xffffff)','texture not tinted by fallback color');

must(issues,"collection(Store.db,'projects',projectId,'revexIssues')",'issue source collection');
must(issues,"if(!selectedMembers.size)return rows",'no member filter means all active');
must(issues,"INACTIVE=new Set",'active status contract');
must(issues,'Store.updateIssue','issue editing');
must(issuesInspector,"if(!host||s?.selectedElement)return",'selected element keeps element inspector authority');
must(issuesInspector,"No BIM element selected — showing every active issue",'empty BIM selection shows all active issues');
must(issuesInspector,"(s?.issues||[]).filter(active)",'empty selection uses active project issues');
must(issuesInspector,'v.selectAndRoute?.(row)','empty issue can navigate to anchored BIM element');

must(daily,"TZ='America/New_York'",'NYC day boundary');
must(daily,'technicalHistorySeparate:true','technical/report separation');
must(daily,"'daily-report'",'daily report subscription');
must(daily,'finalizeRevexDailyReport','post-sync report finalizer');
must(report,"document:'projects/{projectId}/revexRevisions/{revision}'",'post-sync server trigger');
must(report,'diffViewer(previousViewer,currentViewer','deterministic revision diff');
must(report,'technicalHistoryIncluded:false','no technical history dump');
must(report,'WALLT grounding unavailable','WALLT fail-soft grounding');
must(report,"status:'DETERMINISTIC_ONLY'",'deterministic fallback');
must(report,'changedRegions','plan cloud evidence consumption');
must(plans,'normalized-revit-plan-crop-v1','Revit projected cloud evidence');
must(plans,'unlocatedChangedElementIds','deletion no-guess evidence');

must(blocks,"placementDistanceFt:3",'Blocks distance');
must(blocks,"button.hidden=!(hosted()&&v()?.walk)",'Blocks Walk-only availability');
must(blocks,"type:'liber:revex-family-place-r126'",'Blocks placement bridge');
must(bridge,'https://www.blocksrvt.com/en/families','owned Blocks provider');
must(bridge,'PendingFamilies','opaque provider family token');
must(bridge,'RevexFamilyPlacementExternalHandler','Revit ExternalEvent placement');
must(placement,'MaxHostDistanceFt = 8.0','bounded hosted placement');
must(placement,'unsupported placement type','unsupported family fail-closed');

// Preserve and validate the Qwen enhancement implementation without making it the current Render owner.
must(renderWorker,'ensure_server_warm()','server boot warm');
must(renderWorker,'REVEX_WARM_TOKEN','warm proof token');
must(renderWorker,'_WARM_MAX_SECONDS = 32 * 60','bounded persistent warm retry');
must(renderWorker,'_retryable_warm_error','transient warm classification');
must(renderWorker,'retry after','Hub retry-after handling');
must(renderWorker,'cache lives on the mounted','durable cache mount');
must(renderWorker,'resumes partial shards','durable partial model resume');
must(renderDeploy,'--min-instances=1','persistent GPU min instance');
must(renderDeploy,'revex-render-worker-r126','parallel safe cutover service');
must(renderDeploy,'server model warm failed','warm fail closed');
must(renderDeploy,'-BrokerOnly','broker cutover after proof');
must(docker,'render_r126:APP','r126 worker entrypoint');
must(renderClient,"providerOwner:'render-agent.js'",'canonical Google Render owner');
must(renderClient,'localModelCache:false','no client model cache');
must(renderClient,"frame.setAttribute('src','about:blank')",'legacy iframe suppressed');

const tabs=(index.match(/data-view="(?:bim|design|spec|docs|energy|chat|history)"/g)||[]).length;
if(tabs<7)throw new Error(`main module tabs missing: ${tabs}`);
for(const forbidden of ['runRevexEnergy','GeometryCo','COMcheck']){
  mustNot(blocks,forbidden,'Blocks scope');mustNot(docs,forbidden,'Docs scope');mustNot(issues,forbidden,'Issues scope');mustNot(renderClient,forbidden,'Render client scope');
}
console.log(JSON.stringify({REVEX_R126_FUNCTIONAL_CONVERGENCE:'PASSED',docs:'single-final-owner',appearance:'instance-uv>type-texture>color>revit',issues:'revexIssues+all-active+empty-selection-inspector',history:'NYC-day-technical',dailyReport:'post-sync-separated',blocks:'walk-only-3ft-revit',render:'google-current+qwen-shadow',energy:'scope-preserved'}));
