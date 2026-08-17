'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const handler=read('src/Liber.Revex.Revit/Revit/RevitRequestHandler.cs');
const windowHost=read('src/Liber.Revex.Revit/UI/RendairWindow.cs');
const energyHost=read('src/Liber.Revex.Revit/Services/EngineeringCompanionWebBridge.cs');

const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);
const forbid=(text,needle,label)=>assert(!text.includes(needle),label||`Forbidden ${needle}`);

const enqueueStart=handler.indexOf('public void Enqueue(RevitRequest request)');
const executeStart=handler.indexOf('public void Execute(UIApplication app)');
assert(enqueueStart>=0&&executeStart>enqueueStart,'Could not isolate Revit request enqueue path.');
const enqueue=handler.slice(enqueueStart,executeStart);
must(enqueue,'if (request.Kind == RevitRequestKind.ResolveActiveProjectBinding)','read-only project probe must be identified before queueing');
must(enqueue,'READ_ONLY_BINDING_PROBE_QUEUED','startup probe must be explicitly diagnosed as read-only');
must(enqueue,'_queue.Enqueue(request);','read-only active-document probe must reach the Revit API context');
forbid(enqueue,'request.Callback(RevitRequestResult.Fail(','startup binding lookup must not be rejected in the UI before checking the active document');
forbid(enqueue,'IMPLICIT_ACTION_BLOCKED','obsolete blanket implicit-action block must not return');

const probeStart=handler.indexOf('else if (request.Kind == RevitRequestKind.ResolveActiveProjectBinding)');
const nextElse=handler.indexOf('\n            else\n            {',probeStart+1);
assert(probeStart>=0&&nextElse>probeStart,'Could not isolate read-only active-document binding probe.');
const probe=handler.slice(probeStart,nextElse);
must(probe,'SettingsService.ResolveProjectBinding(uidoc.Document, candidate: null, allowRebind: false)','probe must resolve only an existing binding from the active Revit document');
must(probe,'RevitRequestResult.Bound(','probe must return the verified active-document binding');
must(probe,'revitWrites=false','probe diagnostic must explicitly state that it performs no Revit writes');
for(const forbidden of ['Transaction','SyncProject(','RunGbxmlEngineering(','CaptureCurrent(','CaptureBatch(','GbxmlEngineeringService','RevexSyncService'])
  forbid(probe,forbidden,`read-only startup probe must not execute ${forbidden}`);

const requiresStart=handler.indexOf('bool requiresProjectBinding =');
const resolveStart=handler.indexOf('RevexProjectBinding? resolvedBinding',requiresStart);
const bindingBlock=handler.slice(requiresStart,resolveStart);
forbid(bindingBlock,'RevitRequestKind.ResolveActiveProjectBinding','read-only lookup must stay separate from explicit sync execution');
must(bindingBlock,'RevitRequestKind.SyncRevexProject','explicit BIM sync must still verify binding');
must(bindingBlock,'RevitRequestKind.GbxmlEngineering','explicit Engineering sync must still verify binding');

must(windowHost,'Loaded += async (_, _) =>','window startup path must remain inspectable');
must(windowHost,'ResolveActiveDocumentProjectBinding();','startup must recover the active document binding after WebView initialization');
must(windowHost,'MakeButton("SYNC BIM + BOOKS"','explicit BIM sync button must remain');
must(windowHost,'MakeButton("SYNC ENGINEERING"','explicit Engineering sync button must remain');

const ensureStart=energyHost.indexOf('public static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeAsync');
const coreStart=energyHost.indexOf('private static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeCoreAsync');
assert(ensureStart>=0&&coreStart>ensureStart,'Could not isolate managed Energy bridge initialization.');
const ensure=energyHost.slice(ensureStart,coreStart);
forbid(ensure,'TryResumeLatestEngineeringRevisionAsync','opening/reloading the bridge must never resume Energy');
must(ensure,'return await EnsureManagedEnergyBridgeCoreAsync(web);','Energy bridge initialization must remain initialization-only');

console.log(JSON.stringify({
  schema:'liber.revex.r106-read-only-entry.v1',status:'PASSED',
  entry:{readOnlyActiveDocumentBinding:true,revitMutation:false,projectAutoCreation:false,autoEnergyResume:false},
  explicitActions:{bimSync:true,engineeringSync:true,newOrReboundProjectStillExplicit:true,bindingVerificationInsideExplicitActions:true}
},null,2));
