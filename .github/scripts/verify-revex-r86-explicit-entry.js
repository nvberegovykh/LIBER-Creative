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
must(enqueue,'if (request.Kind == RevitRequestKind.ResolveActiveProjectBinding)','implicit project probe must be intercepted before queueing');
must(enqueue,'no ExternalEvent work queued','implicit probe diagnostic must state zero Revit work');
must(enqueue,'request.Callback(RevitRequestResult.Fail(','legacy startup caller must receive an immediate UI-only response');
const blocked=enqueue.indexOf('if (request.Kind == RevitRequestKind.ResolveActiveProjectBinding)');
const queued=enqueue.indexOf('_queue.Enqueue(request);');
assert(blocked>=0&&queued>blocked,'implicit project probe must be rejected before _queue.Enqueue');

const requiresStart=handler.indexOf('bool requiresProjectBinding =');
const resolveStart=handler.indexOf('RevexProjectBinding? resolvedBinding',requiresStart);
const bindingBlock=handler.slice(requiresStart,resolveStart);
forbid(bindingBlock,'RevitRequestKind.ResolveActiveProjectBinding','automatic binding resolution must not be part of executable Revit work');
must(bindingBlock,'RevitRequestKind.SyncRevexProject','explicit BIM sync must still verify binding');
must(bindingBlock,'RevitRequestKind.GbxmlEngineering','explicit Engineering sync must still verify binding');

must(windowHost,'Loaded += async (_, _) =>','window startup path must remain inspectable');
must(windowHost,'ResolveActiveDocumentProjectBinding();','legacy caller is intentionally contained by the queue boundary');
must(windowHost,'MakeButton("SYNC BIM + BOOKS"','explicit BIM sync button must remain');
must(windowHost,'MakeButton("SYNC ENGINEERING"','explicit Engineering sync button must remain');

const ensureStart=energyHost.indexOf('public static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeAsync');
const coreStart=energyHost.indexOf('private static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeCoreAsync');
assert(ensureStart>=0&&coreStart>ensureStart,'Could not isolate managed Energy bridge initialization.');
const ensure=energyHost.slice(ensureStart,coreStart);
forbid(ensure,'TryResumeLatestEngineeringRevisionAsync','opening/reloading the bridge must never resume Energy');
must(ensure,'return await EnsureManagedEnergyBridgeCoreAsync(web);','Energy bridge initialization must remain initialization-only');

console.log(JSON.stringify({
  schema:'liber.revex.r86-explicit-entry.v1',status:'PASSED',
  entry:{revitQueueWork:false,projectProbeUiOnly:true,autoEnergyResume:false},
  explicitActions:{bimSync:true,engineeringSync:true,bindingVerificationInsideExplicitActions:true}
},null,2));
