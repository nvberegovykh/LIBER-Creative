'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');

// A normal Windows git clone may materialize tracked text as CRLF while Actions
// checkout keeps LF. Verify source semantics, not checkout line-ending policy.
const read=(file)=>fs.readFileSync(file,'utf8').replace(/\r\n?/g,'\n');
const palette=read('docs/liber-apps/apps/revex/blocks-palette-r126.js');
const bridge=read('src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs');
const placement=read('src/Liber.Revex.Revit/Services/FamilyPlacementService.cs');
const handler=read('src/Liber.Revex.Revit/Revit/RevexFamilyPlacementExternalHandler.cs');
const receipts=read('src/Liber.Revex.Revit/Services/FamilyMutationReceiptService.cs');
const nativeWindow=read('src/Liber.Revex.Revit/UI/RendairWindow.cs');
const sync=read('src/Liber.Revex.Revit/Services/RevexSyncService.cs');
const syncDocs=read('docs/liber-apps/apps/revex/sync-docs-r24.js');

const must=(text,needle,label)=>assert.ok(text.includes(needle),`${label}: missing ${needle}`);
const forbid=(text,needle,label)=>assert.ok(!text.includes(needle),`${label}: forbidden ${needle}`);
const ordered=(text,needles,label)=>{
  let cursor=-1;
  for(const needle of needles){
    const next=text.indexOf(needle,cursor+1);
    assert.ok(next>cursor,`${label}: ${needle} is missing or out of order`);
    cursor=next;
  }
};

must(palette,"BUILD='20260820r145-blocks-family3'",'current family recovery build');
must(palette,"placementDistanceFt:3",'Walk placement distance contract');
must(palette,"viewer.camera.position.clone().addScaledVector(dir,3)",'3 ft target from active Walk camera');
must(palette,"return{x:target.x,y:-target.z,z:target.y",'Three-to-Revit coordinate inverse');
must(palette,"type:'liber:revex-family-place-r126'",'Companion placement command');
must(palette,"type:'liber:revex-family-transform-r126'",'Companion transform command');
must(palette,"button.hidden=false",'always discoverable family action');
must(palette,"baseSourceRevision",'base source revision command binding');
must(palette,"documentFingerprint",'document fingerprint command binding');
must(palette,"uniqueId:active.uniqueId",'UniqueId-first transform command');
must(palette,"data-family-insert",'explicit Insert confirmation');
must(palette,"revex:walk-mode-changed",'event-driven Walk state binding');
forbid(palette,"type:'liber:revex-integration-arm',provider:'blocks'",'main REVEX WebView must not remain armed as a Blocks download target');
must(palette,"else{pendingCommand=null;pendingToken='';pendingDownload=null}",'failed one-shot placement must clear its dead download token');
must(palette,'Download the family again before retrying.','failed placement must explain the required fresh download');
forbid(palette,'setInterval(','family flow must not poll');
forbid(palette,'backdrop-filter','family panel must use a solid surface');
forbid(palette,'gradient','family panel must not use gradients');

must(bridge,'PendingFamilies[token] = new PendingFamily(path, suggested, info.Length, sha256, DateTime.UtcNow, target);','opaque hashed local family token store');
must(bridge,'type = "liber:revex-integration-family-r126"','browser family handoff event');
must(bridge,'type = "liber:revex-integration-family-r126"','browser handoff uses the family result lane');
must(bridge,'token,','browser handoff contains the opaque token');
must(bridge,'name = suggested,','browser handoff contains provider metadata');
must(bridge,'bytes = info.Length','browser handoff contains bounded size metadata');
must(bridge,'new FamilyPlacementService.PlacementRequest(pending.Path, x, y, z, rotation, levelName, levelElevation)','Revit-side token resolution');
must(bridge,'RevexFamilyPlacementExternalHandler','Revit ExternalEvent handler');
forbid(bridge,'_familyExternalEvent.Raise();','bridge must not race the family ExternalEvent pump');
must(bridge,'handler.AttachExternalEvent(externalEvent)','family handler owns ExternalEvent wake scheduling');
must(bridge,'MaxPendingFamilyDownloads = 16','pending family downloads are bounded');
must(bridge,'familyPumpGeneration != _familyPumpGeneration','late downloads cannot survive window release');
must(bridge,'providerWeb.CoreWebView2.Settings.IsWebMessageEnabled = false','provider cannot send privileged host messages');
must(bridge,'IsTrustedCompanionMessageSource(e.Source)','privileged integration messages require an authorized sender origin');
must(bridge,'_trustedCompanionSource = trustedSource','trusted Companion origin is fixed for the window lifetime');
must(nativeWindow,'RevexWebIntegrationBridge.IsTrustedCompanionMessageSource(e.Source)','all native Companion messages require an authorized sender origin');
must(handler,'MaxQueuedRequests = 16','bounded family ExternalEvent queue');
must(handler,'enum PumpState { Idle, WakeOutstanding, Executing, Closed }','explicit no-lost-wakeup family pump');
must(handler,'response == ExternalEventRequest.Pending || response == ExternalEventRequest.TimedOut','bounded Pending/TimedOut retry path');
must(handler,'abandoned = _queue.ToList()','close drains family callbacks');
must(bridge,'PendingFamilies.TryRemove(token, out PendingFamily? pending)','one-shot token consumption before placement');
must(bridge,'ReadMutationContext(root, "blocks"','bound placement command envelope');
must(bridge,'ReadMutationContext(root, "revex"','bound transform command envelope');
must(bridge,'liber:revex-family-mutations-ack','immutable source revision receipt acknowledgement');
must(bridge,'PostFamilyFailureAsync(','pre-queue family failure must use the structured family result lane');
must(bridge,'type = "liber:revex-family-placement-r126",\n            ok = false,\n            action,\n            commandId,\n            correlationId,\n            projectId,\n            baseSourceRevision,\n            documentFingerprint','structured failure must echo the exact family command envelope');

must(placement,'double targetZ = double.IsFinite(request.Z) ? request.Z : level.Elevation;','exact Walk Z preservation');
must(placement,'XYZ point = new(request.X, request.Y, targetZ);','exact Walk target point');
must(placement,'TryNearestFacePlacement(doc, symbol, point)','face-host fallback');
must(placement,'doc.Create.NewFamilyInstance(reference, projection.XYZPoint, referenceDirection, symbol)','face-reference Revit placement');
must(placement,'TryNearestHostedPlacement(doc, symbol, level, point)','bounded element-host fallback');
must(placement,'MaxHostDistanceFt = 8.0','host search bound');
must(placement,'ComputeReferences = true','host face reference geometry');
must(placement,'MaxZipEntries = 2048','ZIP entry bound');
must(placement,'MaxExpandedZipBytes = 512L * 1024L * 1024L','ZIP expansion bound');
must(placement,'destination.StartsWith(root, StringComparison.OrdinalIgnoreCase)','ZIP path containment');
must(placement,'OrderByDescending(candidate => candidate.Length)','deterministic RFA selection by verified content size');
must(placement,'unsupported placement type','unsupported family fail-closed');
must(placement,'doc.GetElement(request.UniqueId.Trim()) as FamilyInstance','UniqueId-first Revit resolution');
must(placement,'request.ElementIdHint is long compatibilityId','same-document numeric compatibility fallback');
const placeTransaction=placement.slice(placement.indexOf('internal PlacementResult Place('),placement.indexOf('internal PlacementResult Transform('));
const transformTransaction=placement.slice(placement.indexOf('internal PlacementResult Transform('),placement.indexOf('private static string ResolveFamilyPath'));
ordered(placeTransaction,['doc.Regenerate();','PlacementResult preparedResult = Snapshot','recordCommittedWitness(preparedResult);','CommitExact(tx);','committedResult = preparedResult;'],'place snapshot/witness/commit ordering');
ordered(transformTransaction,['doc.Regenerate();','PlacementResult preparedResult = Snapshot','recordCommittedWitness(preparedResult);','CommitExact(tx);','committedResult = preparedResult;'],'transform snapshot/witness/commit ordering');
must(placement,'status = transaction.Commit();','exact top-level Revit commit result');
must(placement,'if (status != TransactionStatus.Committed)','only exact Committed is accepted');
must(placement,'observed == TransactionStatus.RolledBack ? TransactionStatus.RolledBack : TransactionStatus.Pending','uncertain commit retains recovery state');
must(placement,'RecoveryPending => Status != TransactionStatus.RolledBack','only confirmed rollback permits receipt cancellation');
forbid(placement,'ZipFile.ExtractToDirectory(path, extractedFolder)','unbounded ZIP extraction');

must(handler,'CentralModelBindingService.ResolveDocumentFingerprint(doc)','active document fingerprint validation');
must(handler,'SettingsService.ResolveProjectBinding(doc, candidate: null, allowRebind: false)','active project binding validation');
must(handler,'FamilyMutationReceiptService.Reserve','idempotent pre-mutation intent');
must(handler,'FamilyMutationReceiptService.Complete','post-transaction result receipt');
must(handler,'FamilyMutationReceiptService.AssertTransformOrigin','transform linked to placement receipt');
ordered(handler,['FamilyMutationReceiptService.RecoverBeforeMutation(','FamilyMutationReceiptService.Reserve(','_service.Place('],'recover before any new mutation');
must(handler,'FamilyMutationReceiptService.PrepareForCommit','flushed prepared receipt before model witness');
must(handler,'FamilyMutationReceiptService.RecordCommittedWitness(doc, prepared)','same-transaction model witness');
must(handler,'Recovered already-committed REVEX family command from its model witness','interrupted post-commit retry is success');
must(handler,'if (reserved && !ex.RecoveryPending)','pending Revit failure handling preserves prepared state');
must(handler,'ReceiptRecoveryPending','receipt promotion and uncertain commit truth is surfaced');
must(handler,'ReceiptBlockedNotStarted','never-started work is surfaced distinctly from an uncertain commit');
must(handler,'FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None','family mutation creates its unexposed snapshot exclusively');
must(handler,'FileMode.Open, FileAccess.Read, FileShare.Read','family mutation reopens a reader-compatible write-denying snapshot lease');
must(handler,'SHA256.HashData(lockedSnapshot)','snapshot is re-hashed after its write-denying lease opens');
must(placement,'FileStream directLock = new(path, FileMode.Open, FileAccess.Read, FileShare.Read)','direct RFA remains write-locked through Revit loading');
must(placement,'FileStream familyLock = new(family.Path, FileMode.Open, FileAccess.Read, FileShare.Read)','ZIP-extracted RFA remains write-locked through Revit loading');
must(placement,'SHA256.HashData(familyLock)','ZIP-extracted RFA is verified after its write-denying lease opens');
must(handler,'item.Placement with { Path = verifiedAsset!.Path }','Revit loads the verified snapshot instead of the provider temp path');
must(bridge,'receiptStatus,','bridge forwards receipt status instead of hardcoding completion');
must(palette,"data.receiptStatus==='RECOVERY_PENDING'",'UI prevents duplicate insertion while commit/recovery is uncertain');
must(palette,"data.receiptStatus==='ATTACHED_TO_IMMUTABLE_SOURCE_REVISION'",'UI recognizes already-acknowledged terminal receipt truth');
must(receipts,'COMPLETED_PENDING_SOURCE_SYNC','durable pending-source-sync status');
must(receipts,'ATTACHED_TO_IMMUTABLE_SOURCE_REVISION','durable acknowledged status');
must(receipts,'internal sealed record RecoveredMutation','recovery returns exact result and receipt state');
must(receipts,'Build the authoritative result before local promotion','committed witness survives local cache-promotion failure');
must(receipts,'Never return a mutable local result as authority','validated model witness always owns recovered result truth');
forbid(receipts,'return local.Clone()','mutable local receipt must never override the Revit witness');
must(receipts,'duplicate execution was blocked','duplicate command rejection');
must(receipts,'not linked to the bound REVEX placement receipt','arbitrary family transform rejection');
must(receipts,'liber.revex.family-mutation-receipt.v2','v2 two-phase receipt schema');
must(receipts,'liber.revex.family-mutation-receipt.v1','v1 completed backward compatibility');
must(receipts,'PREPARED_AWAITING_REVIT_COMMIT','pre-commit durable state');
must(receipts,'RevitDataStorage = Autodesk.Revit.DB.ExtensibleStorage.DataStorage','correct Revit DataStorage namespace');
must(receipts,'new("5f9629a0-dbd1-46ea-bf5c-a6bbcfb44761")','fixed witness schema GUID');
must(receipts,'WitnessVendorId = "LIBR"','fixed add-in vendor boundary');
must(receipts,'FieldIdentityDigest = "IdentityDigest"','canonical request identity witness');
must(receipts,'MutationIdentityDigest(context, operation, request)','altered replay binding');
must(receipts,'RevitDataStorage.Create(doc)','per-command model witness');
must(receipts,'storage.SetEntity(entity)','witness stored in Revit transaction');
must(receipts,'Model evidence is authoritative and reconstructs a deleted local folder.','sync recovery without local folder');
must(receipts,'immutable source sync was blocked','conflicting evidence fails closed');
must(receipts,'ambiguous v1 intent','legacy ambiguous intent fails closed');
const acknowledge=receipts.slice(receipts.indexOf('internal static void Acknowledge('),receipts.indexOf('private static MutationWitness? ExactWitness'));
assert.ok(acknowledge.indexOf('WriteNewAtomic(acknowledged, amended);')<acknowledge.lastIndexOf('File.Delete(pending);'),'acknowledged receipt must publish before pending delete');
forbid(acknowledge,'File.Move(pending, acknowledged','acknowledgement must not mutate/move pending first');
must(sync,'liber.revex.source-mutations.v1','receipt embedded in source package');
must(sync,'FamilyMutationReceiptService.CompletedForSync(\n                doc,','source sync reconciles model witnesses');
must(syncDocs,"kind:'bim-family'",'family mutation history event');
must(syncDocs,"id:`family_${docId(commandId)}`",'idempotent family history id');
must(syncDocs,"type:'liber:revex-family-mutations-ack'",'ack only after source publication/history');

console.log(JSON.stringify({
  REVEX_R135_BLOCKS_PLACEMENT:'PASSED',
  lineEndingInvariant:true,
  walkPlacementFt:3,
  exactWalkZ:true,
  opaqueToken:true,
  externalEvent:true,
  faceHostFallback:true,
  elementHostFallback:true,
  hostRadiusFt:8,
  boundedZip:true,
  unsupportedFamiliesFailClosed:true,
  boundCommandEnvelope:true,
  uniqueIdFirst:true,
  durableReceiptV2:true,
  inTransactionModelWitness:true,
  alteredReplayBlocked:true,
  acknowledgedFirst:true,
  immutableRevisionHistory:true
}));
