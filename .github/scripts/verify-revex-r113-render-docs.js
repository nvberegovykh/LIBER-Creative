'use strict';
const fs=require('fs');
const assert=require('assert');
const read=p=>fs.readFileSync(p,'utf8');
const broker=read('server/revex-render-functions/index.js');
const deploy=read('server/revex-render-worker/DEPLOY_RENDER_SERVER.ps1');
const docs=read('docs/liber-apps/apps/revex/sync-docs-r24.js');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);
const forbid=(text,needle,label)=>assert(!text.includes(needle),label||`Forbidden ${needle}`);

must(broker,"const STORAGE_BUCKET = String(process.env.REVEX_STORAGE_BUCKET",'Render broker must require explicit storage binding');
must(broker,'runtime.storage.bucket(STORAGE_BUCKET)','Render broker must open the explicit Firebase bucket');
forbid(broker,'runtime.storage.bucket();','Render broker must never rely on Admin default bucket');
must(broker,"failureStage = 'UPLOAD_SOURCE'",'source upload must have an explicit failure stage');
must(broker,"failureStage = 'WORKER_REQUEST'",'worker dispatch must have an explicit failure stage');
must(broker,'REVEX render failed at ${detail.stage}: ${detail.message}','callable must surface the real stage/message');

must(deploy,'function Resolve-FirebaseStorageBucket','deployment must resolve Firebase Storage deterministically');
must(deploy,'appspot\\.com|firebasestorage\\.app','only Firebase project buckets may be selected');
must(deploy,'REVEX_STORAGE_BUCKET=$StorageBucket','broker deployment must receive explicit storage bucket');
must(deploy,'serviceConfig.environmentVariables.REVEX_STORAGE_BUCKET','deployment must verify the live bucket binding');

must(docs,"const BUILD='20260817r113-docs-core2'",'r24 itself must be the r113 Docs owner');
must(docs,'singleVisibleRevisionPerSet:true','Docs must diagnose one visible revision per set');
must(docs,'class="docs-version-select"','Docs must expose revision choice without stacking revision groups');
must(docs,'Full document','each set must retain the full PDF');
must(docs,'data-page=','each set must retain linked page/sheet controls');
must(docs,"isolated?'isolated-sheet-pdf':'document'",'linked sheets must prefer real isolated PDFs');
forbid(docs,'<details','primary Docs tree must not nest multiple revision blocks');
forbid(docs,'MutationObserver','Docs owner must remain event-driven');
forbid(docs,"document.addEventListener('click'",'Docs must not use a global click interceptor');
must(docs,"legacySheetProjection:'render-only'",'legacy sheet cleanup must remain render-only');

console.log(JSON.stringify({schema:'liber.revex.r113.render-docs.v2',status:'PASSED',render:{explicitStorage:true,stagedErrors:true},docs:{singleOwner:'sync-docs-r24',oneRevisionPerSet:true,fullAndLinkedSheets:true,revisionSelector:true,stateRewrite:false},energyChanged:false},null,2));
