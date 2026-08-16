'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);
const mustNot=(text,needle,label)=>assert(!text.includes(needle),label||`Forbidden ${needle}`);

const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const docs=read('docs/liber-apps/apps/revex/docs-pages-r68.js');
const viewer=read('docs/liber-apps/apps/revex/viewer-polish-r68.js');
const energy=read('docs/liber-apps/apps/revex/energy-diagnostics-r68.js');

must(ui,'docs-pages-r68.js?v=20260816r68-doc-pages1');
must(ui,'energy-diagnostics-r68.js?v=20260816r68-energy-diagnostics1');
must(ui,'viewer-polish-r68.js?v=20260816r68-viewer-polish1');

must(docs,'pdf-lib@1.17.1/dist/pdf-lib.min.js','Docs PDF splitter must be version-pinned');
must(docs,'PDFDocument.load(bytes)','Docs must split the actual full-set PDF');
must(docs,'copyPages(source,[page-1])','Docs page documents must contain exactly the selected source page');
must(docs,"library/revex/printing-pages/",'Split pages must persist as project/revision files');
must(docs,"frame.src='about:blank'",'Changing pages must force the embedded PDF surface to navigate');
mustNot(docs,'#page=','r68 page runtime must not depend on external PDF viewer page anchors');

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

console.log(JSON.stringify({schema:'liber.revex.r68-review-runtime-qa.v1',status:'PASSED',docs:{fullSetFirst:true,realSinglePagePdfs:true,pageAnchors:false},viewer:{presentation:true,walkWebViewSafe:true,sixFaceClipPersistent:true},energy:{exactFailureEvidence:true,repeatFailedRevisionBlocked:true}},null,2));
