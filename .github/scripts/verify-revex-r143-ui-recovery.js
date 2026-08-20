'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const index=read('docs/liber-apps/apps/revex/index.html');
const app=read('docs/liber-apps/apps/revex/app.js');
const final=read('docs/liber-apps/apps/revex/mobile-final-r122.js');
const safe=read('docs/liber-apps/apps/revex/mobile-safe-r133.js');
const sheet=read('docs/liber-apps/apps/revex/mobile-sheet-r142.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const native=read('src/Liber.Revex.Revit/UI/RendairWindow.cs');
const has=(text,needle,label)=>assert.ok(text.includes(needle),`${label}: missing ${needle}`);

assert.equal((index.match(/role="tab"/g)||[]).length,7,'seven semantic module tabs');
assert.equal((index.match(/class="revex-r110-tab-icon"/g)||[]).length,7,'seven visible SVG icon hosts');
assert.equal((index.match(/role="tabpanel"/g)||[]).length,7,'seven labeled tab panels');
has(index,'aria-label="Search BIM elements, rooms, or materials"','BIM search accessible name');
has(app,"['ArrowLeft', 'ArrowRight', 'Home', 'End']",'tab keyboard navigation');
has(app,"button.setAttribute('aria-selected', String(active))",'tab selection state');
for(const [name,text] of [['r122',final],['r133',safe]]){
  assert.ok(!/\.main-nav \.revex-tabs button\{[^}]*font-size:0/.test(text),`${name} must not hide tab content with font-size:0`);
  has(text,'height:44px!important;min-height:44px!important',`${name} 44px tab targets`);
  has(text,'.revex-r110-tab-icon svg',`${name} static SVG icon contract`);
}
has(final,'grid-template-columns:repeat(4,minmax(44px,1fr))','r122 two-row accessible viewer toolbar');
has(safe,'grid-template-columns:repeat(4,minmax(44px,1fr))','r133 two-row accessible viewer toolbar');
assert.ok(!safe.includes('setInterval('),'mobile-safe must not poll');
has(safe,'ResizeObserver','bounded resize observation');
has(safe,"addEventListener?.('change',schedule)",'media-query change events');
assert.ok(!sheet.includes('replaceChildren('),'sheet must not reparent via replaceChildren');
assert.ok(!sheet.includes('appendChild(pane.node)'),'sheet must not reparent authoritative nodes');
has(sheet,'nodesStayInOriginalModule:true','non-reparenting ownership contract');
has(sheet,'#revex-r126-issues-button{bottom:calc(var(--revex-r142-sheet-bar)','Issues button clearance');
has(sheet,'revex-r142-walk-active','Walk/sheet mutual exclusion');
for(const file of ['mobile-final-r122.js','mobile-safe-r133.js','mobile-sheet-r142.js'])has(ui,`${file}?v=20260820r143-ui-recovery1`,`${file} cache key`);
has(native,'new WrapPanel','wrapping native navigation');
has(native,'MinWidth = 720','minimum centered WebView column');
has(native,'_diagnosticsPanel.Visibility = Visibility.Collapsed','diagnostics collapsed by default');
has(native,'SetDiagnosticsVisible','diagnostics toggle');
assert.ok(!native.includes('root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(370) })'),'diagnostics must not reserve a fixed root column');

// Execute the responsive owner in a small DOM to prove the class follows bounded signals.
const nodes=new Map();
const classes=new Set();
const classList={toggle(name,on){on?classes.add(name):classes.delete(name);},contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)};
let width=900,coarse=true;
const document={
  readyState:'complete',body:{classList},head:{appendChild(node){nodes.set(node.id,node);}},
  getElementById:id=>nodes.get(id)||null,createElement:()=>({id:'',textContent:''}),
  querySelector:selector=>selector==='.app-shell'?{}:null,querySelectorAll:()=>[]
};
const window={document,visualViewport:{addEventListener(){}},addEventListener(){},dispatchEvent(){},requestAnimationFrame(fn){fn();},
  matchMedia(query){return {matches:query.includes('max-width:860')?width<=860:query.includes('max-width:1024')?width<=1024:query.includes('pointer:coarse')?coarse:false,addEventListener(){}};}};
const context={window,document,navigator:{maxTouchPoints:0},CustomEvent:function(type,init){this.type=type;this.detail=init?.detail;},ResizeObserver:function(){this.observe=()=>{};},setTimeout:fn=>fn(),setInterval(){throw new Error('polling invoked');}};
vm.runInNewContext(safe,context,{filename:'mobile-safe-r133.js'});
assert.ok(classes.has('revex-mobile-touch'),'900px coarse pointer activates touch layout');
width=1100;window.__revexMobileSafeR133.refresh();
assert.ok(!classes.has('revex-mobile-touch'),'wide viewport leaves touch layout');
width=800;coarse=false;window.__revexMobileSafeR133.refresh();
assert.ok(classes.has('revex-mobile-touch'),'phone viewport activates touch layout');

console.log(JSON.stringify({REVEX_R143_UI_RECOVERY:'PASSED',tabs:7,touchTargets:44,polling:false,reparenting:false,nativeWebViewMinWidth:720,diagnosticsDefault:'collapsed'}));
