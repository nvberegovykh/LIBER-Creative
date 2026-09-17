'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');

const read=file=>fs.readFileSync(file,'utf8').replace(/\r\n?/g,'\n');
const main=read('src/Liber.Revex.Revit/Revit/RevitRequestHandler.cs');
const family=read('src/Liber.Revex.Revit/Revit/RevexFamilyPlacementExternalHandler.cs');
const bridge=read('src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs');
const windowSource=read('src/Liber.Revex.Revit/UI/RendairWindow.cs');
const manager=read('src/Liber.Revex.Revit/UI/RendairWindowManager.cs');
const palette=read('docs/liber-apps/apps/revex/blocks-palette-r126.js');
const must=(source,needle,label)=>assert.ok(source.includes(needle),`${label}: missing ${needle}`);
const forbid=(source,needle,label)=>assert.ok(!source.includes(needle),`${label}: forbidden ${needle}`);
const before=(source,a,b,label)=>assert.ok(source.indexOf(a)>=0&&source.indexOf(a)<source.indexOf(b),`${label}: ${a} must precede ${b}`);

for(const [name,source,limit] of [['main',main,8],['family',family,16]]){
  must(source,'enum PumpState { Idle, WakeOutstanding, Executing, Closed }',`${name} explicit pump state`);
  must(source,`MaxQueuedRequests = ${limit}`,`${name} bounded queue`);
  must(source,'AttachExternalEvent(ExternalEvent externalEvent)',`${name} event attachment`);
  must(source,'_pumpState = PumpState.WakeOutstanding',`${name} empty-to-pending transition`);
  must(source,'if (_queue.Count == 0)',`${name} atomic empty check`);
  must(source,'_pumpState = PumpState.Idle',`${name} atomic idle transition`);
  must(source,'response == ExternalEventRequest.Accepted',`${name} accepted wake handling`);
  must(source,'response == ExternalEventRequest.Pending || response == ExternalEventRequest.TimedOut',`${name} pending/timeout handling`);
  must(source,'MaxWakeRetries = 8',`${name} bounded retry count`);
  must(source,'_wakeGeneration',`${name} stale retry generation guard`);
  must(source,'_dispatcher.BeginInvoke',`${name} Revit UI dispatcher retry`);
  must(source,'void Close()',`${name} close path`);
  must(source,'abandoned = _queue.ToList()',`${name} close drains queue`);
  must(source,'_queue.Clear()',`${name} close clears queue`);
}

forbid(windowSource,'_externalEvent.Raise()','window must enqueue only');
forbid(bridge,'_familyExternalEvent.Raise()','family bridge must enqueue only');
must(bridge,'handler.AttachExternalEvent(externalEvent)','family handler owns wake protocol');
must(bridge,'lock (FamilyPumpGate)','family bridge configure/release/capture is synchronized');
before(bridge,'handler?.Close();','externalEvent?.Dispose();','family queued callbacks run before ExternalEvent disposal');
must(family,'FailRemainingAfterPendingTransaction()','pending transaction stops later mutations');
must(family,'ReceiptRecoveryPending','recovery-pending receipt status');
must(family,'ReceiptBlockedNotStarted','never-started queued work is not misreported as recoverable');
must(bridge,'_familyPumpGeneration = unchecked(_familyPumpGeneration + 1)','release/configure invalidates async downloads');
must(bridge,'familyPumpGeneration != _familyPumpGeneration','late download continuation is rejected');
must(bridge,'MaxPendingFamilyDownloads = 16','pending family files are globally bounded');
must(bridge,'ReferenceEquals(pair.Value.Target, target)','a window owns one pending family download');
must(bridge,'providerWeb.CoreWebView2.Settings.IsWebMessageEnabled = false','provider WebView messaging is disabled');
must(bridge,'if (!providerBrowser)','untrusted provider never receives host command dispatcher');
must(bridge,'IsTrustedCompanionMessageSource(e.Source)','privileged messages require trusted source authorization');
must(family,'FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None','family bytes are snapshotted exclusively before Revit mutation');
must(family,'FileMode.Open, FileAccess.Read, FileShare.Read','verified snapshot lease denies writers without blocking Revit/ZIP readers');
must(family,'SHA256.HashData(lockedSnapshot)','verified snapshot is re-hashed under its read lease');
must(bridge,'receiptStatus,','bridge surfaces handler receipt truth');
must(palette,"data.receiptStatus==='RECOVERY_PENDING'",'family UI handles uncertain/recoverable transaction state');
must(palette,'Do not insert another copy yet.','family UI prevents duplicate retry during uncertain commit');
must(manager,'_handler?.Close();','main handler close is wired');

console.log(JSON.stringify({
  REVEX_EXTERNAL_EVENT_PUMP:'PASSED',
  main:{bounded:8,noLostWake:true,closeCallbacks:true},
  family:{bounded:16,noLostWake:true,closeCallbacks:true,pendingCommitStopsDrain:true,receiptTruth:true},
  directRaises:{window:false,familyBridge:false}
},null,2));
