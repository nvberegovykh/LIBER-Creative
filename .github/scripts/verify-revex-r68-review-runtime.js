'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);
const mustNot=(text,needle,label)=>assert(!text.includes(needle),label||`Forbidden ${needle}`);

const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const app=read('docs/liber-apps/apps/revex/app.js');
const viewer=read('docs/liber-apps/apps/revex/viewer-polish-r68.js');
const energy=read('docs/liber-apps/apps/revex/energy-diagnostics-r68.js');

must(ui,'energy-diagnostics-r68.js?v=20260816r68-energy-diagnostics1');
must(ui,'viewer-polish-r68.js?v=20260816r68-viewer-polish1');
mustNot(ui,"loadScript('docs-pages-r68.js",'r75 must not load the main-thread full-PDF splitter');
must(app,"const url = page ? `${base}#page=${page}` : base;",'Docs sheet position must use the already-loaded source PDF page anchor');
must(app,"frame.src = url; frame.hidden = false",'Docs page selection must navigate the PDF surface directly');

must(viewer,'material.userData.revexR68BaseColor','Viewer polish must preserve source material colors before presentation adjustment');
must(viewer,'v.renderer.localClippingEnabled=true','Six-face clipping must explicitly remain enabled');
must(viewer,"if(!this.embedded){try{canvas?.requestPointerLock?.();}",'WebView walk must not require pointer lock');
must(viewer,"hasKey(this.keys,'KeyW','w')",'Walk must support both code-based and legacy key sets');
must(viewer,"typeof v.buildOutlineOverlay==='function'",'Viewer must reuse physical mesh outlines instead of box-only decoration');
mustNot(viewer,'scene.clear(','Presentation must never clear authoritative BIM geometry');

must(energy,'02_GEOMETRYCO\\.log','Exact GeometryCo failure log must be recognized');
must(energy,'await fetch(url,{cache:\'no-store\'})','Failure evidence must be read from the immutable result artifact');
must(energy,"button.disabled=true",'Same failed immutable revision must not be blindly re-authorized');
must(energy,'ENERGY_EXACT_FAILURE','Exact worker failure must enter REVEX diagnostics');

console.log(JSON.stringify({schema:'liber.revex.r75-review-runtime-qa.v1',status:'PASSED',docs:{sourcePdfOnce:true,nativePageAnchor:true,mainThreadSplit:false},viewer:{presentation:true,walkWebViewSafe:true,sixFaceClipPersistent:true},energy:{exactFailureEvidence:true,repeatFailedRevisionBlocked:true}},null,2));
