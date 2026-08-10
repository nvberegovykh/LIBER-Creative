from pathlib import Path

root = Path('docs/liber-apps/apps/revex')
app = root / 'app.js'
s = app.read_text(encoding='utf-8')

# Remove the legacy Three.js engine completely; viewer-r21 is the sole viewport owner.
for line in (
    "import * as THREE from 'three';\n",
    "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n",
    "import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';\n",
):
    s = s.replace(line, '')
if 'class BimViewer {' in s:
    a = s.index('class BimViewer {')
    b = s.index('\nfunction showView(name) {', a)
    s = s[:a] + "// BIM rendering is owned exclusively by viewer-r21.js.\nlet viewer = null;\nfunction activeBimViewer(){ return window.__revexViewerR21Instance || viewer || null; }\n" + s[b:]
elif 'function activeBimViewer()' not in s:
    raise SystemExit('Expected BimViewer marker not found')

s = s.replace("if (name === 'bim') setTimeout(() => viewer?.resize(), 0);", "if (name === 'bim') setTimeout(() => activeBimViewer()?.resize?.(), 0);")
s = s.replace('viewer?.select(element, fit);', 'activeBimViewer()?.select?.(element, fit);')
s = s.replace("const element = issue?.anchorUniqueId ? viewer?.elementByUniqueId.get(String(issue.anchorUniqueId)) : viewer?.elementById.get(String(issue?.anchorElementId));", "const av=activeBimViewer();\n    const element=issue?.anchorUniqueId?av?.byUid?.get?.(String(issue.anchorUniqueId)):av?.byId?.get?.(String(issue?.anchorElementId));")
s = s.replace("if (!viewer?.renderer?.domElement) return '';\n    viewer.renderer.render(viewer.scene, viewer.camera);\n    return viewer.renderer.domElement.toDataURL('image/png');", "const av=activeBimViewer();\n    if(!av?.renderer?.domElement)return '';\n    av.renderer.render(av.scene,av.camera);\n    return av.renderer.domElement.toDataURL('image/png');")
s = s.replace("function renderAll() {\n  renderModelTree(); renderPins(); renderDesign(); renderDesignInspector(); renderSpec(); renderLibrary(); renderChatContext();\n}", "function renderAll() {\n  renderModelTree(); renderPins(); renderDesign(); renderDesignInspector(); renderLibrary(); renderChatContext();\n}")

# Make BIM usable as soon as state + viewer metadata arrive; hydrate books/issues/docs later.
marker = 'async function loadCloudState(cloudState, localPackage = null) {'
if marker in s and 'async function hydrateRevisionOverlays(' not in s:
    helper = r'''let revisionHydrationToken=0;
async function hydrateRevisionOverlays(cloudState,localPackage,revision){
  const token=++revisionHydrationToken;
  try{
    const [designData,edits,chapterEdits,issues,library]=await Promise.all([
      localPackage?.design||(cloudState?.designUrl?Store.fetchJson(cloudState.designUrl):Promise.resolve(null)),
      Store.listDesignEdits(state.projectId),Store.listChapterEdits(state.projectId),Store.listIssues(state.projectId),Store.listLibrary(state.projectId)
    ]);
    if(token!==revisionHydrationToken||state.loadingRevision!==revision)return;
    state.designData=designData;state.designEdits=new Map(edits.map(r=>[r.id,r]));state.chapterEdits=new Map(chapterEdits.map(r=>[r.id,r]));state.issues=issues;state.library=library;
    renderPins();renderDesign();renderDesignInspector();renderLibrary();activeBimViewer()?.requestRender?.();
    if(!$('#view-spec')?.hidden)renderSpec();
  }catch(error){console.warn('[REVEX] deferred revision overlays',error);}
}

'''
    s = s.replace(marker, helper + marker, 1)
if marker in s:
    a = s.index(marker)
    b = s.index('\nasync function activateProject(projectId) {', a)
    fast = r'''async function loadCloudState(cloudState,localPackage=null){
  state.cloudState=cloudState||null;
  if(!cloudState&&!localPackage){revisionHydrationToken++;state.viewerData=null;state.designData=null;state.designEdits=new Map();state.chapterEdits=new Map();state.issues=[];state.library=[];renderAll();setSync('No Revit sync yet','quiet');return;}
  const revision=localPackage?.revision||cloudState?.revision||'unknown';
  if(state.loadingRevision===revision&&!localPackage)return;
  state.loadingRevision=revision;setSync('Loading BIM revision…','busy');
  try{
    const viewerData=localPackage?.viewer||await Store.fetchJson(cloudState.viewerUrl);
    state.viewerData=viewerData;renderModelTree();renderPins();
    setSync(`${localPackage?.cloud===false?'Local preview':'Synced'} ${formatDate(localPackage?.syncedAt||cloudState.syncedAt)}`,localPackage?.cloud===false?'quiet':'good');
    const hydrate=()=>hydrateRevisionOverlays(cloudState,localPackage,revision);
    if('requestIdleCallback'in window)requestIdleCallback(hydrate,{timeout:700});else setTimeout(hydrate,0);
  }catch(error){console.error('[REVEX] load revision',error);setSync('Revision load failed','bad');toast(error.message,true);}
}
'''
    s = s[:a] + fast + s[b:]

if 'async function activateProject(projectId) {' in s:
    a = s.index('async function activateProject(projectId) {')
    b = s.index('\nasync function handleSyncFiles(files) {', a)
    activate = r'''async function activateProject(projectId){
  state.unsubscribe?.();state.unsubscribe=null;state.projectId=projectId||'';
  state.project=state.projects.find(r=>r.id===projectId)||(projectId?await Store.getProject(projectId):null);
  state.preferredSpecId=((params.get('projectId')===projectId&&params.get('specProjectId'))||state.project?.revexSpecProjectId||'');
  $('#project-select').value=state.projectId;notifyNativeProject();
  if(!projectId){state.preferredSpecId='';showView('bim');return;}
  showView(params.get('view')||'bim');setSync('Loading project…','busy');
  try{
    const cloudState=await Store.getState(projectId);await loadCloudState(cloudState);notifyNativeProject();
    state.unsubscribe=Store.subscribeState(projectId,next=>{if(next?.revision&&next.revision!==state.cloudState?.revision)loadCloudState(next);else if(next){state.cloudState=next;if(!$('#view-spec')?.hidden)renderSpec();}});
    Promise.all([Store.ensureSpecProject(projectId,state.preferredSpecId||state.project?.revexSpecProjectId,state.project),Store.listRenderJobs(projectId)]).then(([specId,jobs])=>{
      if(state.projectId!==projectId)return;state.preferredSpecId=specId||state.preferredSpecId||'';state.renderJobs=jobs||[];if(state.project)state.project.revexSpecProjectId=state.preferredSpecId;renderRenderHistory();notifyNativeProject();if(!$('#view-spec')?.hidden)renderSpec();
    }).catch(error=>console.warn('[REVEX] deferred project services',error));
    if(params.get('render')==='1')openRenderDialog();
  }catch(error){setSync('Project unavailable','bad');toast(error.message,true);}
}
'''
    s = s[:a] + activate + s[b:]

app.write_text(s, encoding='utf-8')

# No DOM rename/timing hack is needed after the old renderer is removed.
(root/'viewer-host-guard-r21.js').write_text(r'''(function(root){
'use strict';if(root.__revexViewerHostGuardR21)return;root.__revexViewerHostGuardR21=true;root.__revexExternalViewerR21=true;
const ready=()=>{const host=document.getElementById('viewer');if(!host)return false;root.__revexViewerHostR21=host;root.dispatchEvent(new CustomEvent('revex:viewer-host-ready'));return true;};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
console.log('[REVEX] viewer host guard 20260810r21',{singleRenderer:true,legacyRendererDisabled:true});
})(window);\n''',encoding='utf-8')

proj=root/'projection-integrity.js';t=proj.read_text(encoding='utf-8')
t=t.replace("const BUILD='20260810r19';","const BUILD='20260810r21';")
t=t.replace("const blockedCategories=/^(cameras?|views?|viewports?|sheets?|levels?|grids?|reference planes?|scope boxes?|project information|internal origin|survey point|project base point|sections?|elevations?|callouts?)$/i;","const blockedCategories=/^(cameras?|views?|viewports?|sheets?|levels?|grids?|reference planes?|scope boxes?|project information|internal origin|survey point|project base point|sections?|elevations?|callouts?|lines?|model lines?|detail lines?|sketch lines?|analytical nodes?|reference points?)$/i;")
proj.write_text(t,encoding='utf-8')

viewer=root/'viewer-r21.js';t=viewer.read_text(encoding='utf-8')
if 'const NON_MODEL=' not in t:
    palette="const PALETTE={walls:0xd6d2c8,doors:0x9f724f,windows:0x86b7cf,floors:0x9b968c,roofs:0x8e8884,ceilings:0xb8b3aa,stairs:0x9f927e,furniture:0x927f6f,casework:0x927358,'structural-columns':0x858b90,'structural-framing':0x858b90,'mechanical-equipment':0x6f8d8e,'lighting-fixtures':0xc6ae71,'plumbing-fixtures':0xaabac0,site:0x7c8d70,other:0x969a9e};"
    t=t.replace(palette,palette+"\nconst NON_MODEL=/^(cameras?|views?|viewports?|sheets?|levels?|grids?|reference planes?|scope boxes?|project information|internal origin|survey point|project base point|sections?|elevations?|callouts?|lines?|model lines?|detail lines?|sketch lines?|analytical nodes?|reference points?)$/i;\nconst usableRow=r=>!!(r?.bbox?.min&&r?.bbox?.max)&&!NON_MODEL.test(String(r.category||'').trim());")
t=t.replace('this.model=null;this.bounds=null;this.data=null;this.byId=new Map();this.helper=null;','this.model=null;this.bounds=null;this.data=null;this.byId=new Map();this.byUid=new Map();this.helper=null;')
t=t.replace("const data=await Store.fetchJson(state.viewerUrl);this.data=data;this.byId=new Map((data.elements||[]).map(r=>[String(r.id),r]));const target=this.metaBounds();","const source=await Store.fetchJson(state.viewerUrl),rows=(source?.elements||[]).filter(usableRow),data={...source,elements:rows};this.data=data;this.byId=new Map(rows.map(r=>[String(r.id),r]));this.byUid=new Map(rows.filter(r=>r.uniqueId).map(r=>[String(r.uniqueId),r]));const target=this.metaBounds();")
t=t.replace('camera|cameras|grid|grids|level|levels|reference plane|scope box|section marker|elevation marker)','camera|cameras|grid|grids|level|levels|reference plane|scope box|section marker|elevation marker|model line|detail line|sketch line|reference point)')
t=t.replace("console.log('[REVEX] viewer '+BUILD,{singleRenderer:true,fixedAxes:true,onDemand:true,walkSharedScene:true,materialIntent:true});","console.log('[REVEX] viewer '+BUILD,{singleRenderer:true,fixedAxes:true,onDemand:true,idleFramePersistent:true,walkSharedScene:true,materialIntent:true});")
viewer.write_text(t,encoding='utf-8')

# Assert the key regressions are actually gone before CI reaches node --check.
final=app.read_text(encoding='utf-8')
assert 'class BimViewer {' not in final
assert 'requestAnimationFrame(() => this.animate())' not in final
assert "import * as THREE" not in final
