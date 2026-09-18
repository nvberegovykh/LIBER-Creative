param(
  [ValidateSet('AUDIT','APPLY')][string]$Mode = 'AUDIT',
  [string]$ProjectId = 'liber-apps-cca20',
  [string]$Domain = 'liberpict.com'
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Docs = Join-Path $Root 'docs'
$PublicManifestPath = Join-Path $Docs 'ai\public-manifest.json'
$Api = 'https://firebasehosting.googleapis.com/v1beta1'
$Timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$EvidenceDir = Join-Path $Root ("evidence\OBSERVER_PUBLIC_FIREBASE_$Timestamp")
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$Log = Join-Path $EvidenceDir 'run.log'

function Say([string]$Text) {
  $line = "[$((Get-Date).ToUniversalTime().ToString('o'))] $Text"
  $line | Tee-Object -FilePath $Log -Append
}

function Require-Command([string[]]$Names) {
  foreach ($n in $Names) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  throw "Required command not found: $($Names -join ', ')"
}

function Firebase-Headers() {
  if (-not $script:AccessToken) { throw 'Firebase access token is not initialized.' }
  return @{
    Authorization = "Bearer $script:AccessToken"
    'x-goog-user-project' = $ProjectId
  }
}

function Invoke-Json([string]$Method,[string]$Uri,$Body=$null) {
  $headers = Firebase-Headers
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers
  }
  $json = $Body | ConvertTo-Json -Depth 30 -Compress
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $json
}

function Wait-Operation($Operation) {
  $op = $Operation
  for ($i=0; $i -lt 120; $i++) {
    $hasDone = @($op.PSObject.Properties.Name) -contains 'done'
    if ($hasDone -and $op.done -eq $true) {
      $hasError = @($op.PSObject.Properties.Name) -contains 'error'
      if ($hasError -and $null -ne $op.error) { throw "Firebase Hosting operation failed: $($op.error | ConvertTo-Json -Depth 20 -Compress)" }
      return $op
    }
    $hasName = @($op.PSObject.Properties.Name) -contains 'name'
    if (-not $hasName) { throw 'Long-running operation returned no name.' }
    $name = [string]$op.name
    if (-not $name) { throw 'Long-running operation returned an empty name.' }
    Start-Sleep -Seconds 1
    $op = Invoke-Json GET "$Api/$name"
  }
  throw 'Timed out waiting for Firebase Hosting operation.'
}

function Get-FinalizedVersionState([string]$VersionName) {
  for ($i=0; $i -lt 20; $i++) {
    $v = Invoke-Json GET "$Api/$VersionName"
    if ([string]$v.status -eq 'FINALIZED') {
      return $v
    }
    Start-Sleep -Seconds 1
  }
  throw "Version did not report FINALIZED within 20 seconds: $VersionName"
}

function Get-GzipPayload([string]$Path) {
  $raw = [IO.File]::ReadAllBytes($Path)
  $ms = New-Object IO.MemoryStream
  try {
    $gz = New-Object IO.Compression.GZipStream($ms,[IO.Compression.CompressionLevel]::Optimal,$true)
    try { $gz.Write($raw,0,$raw.Length) } finally { $gz.Dispose() }
    $bytes = $ms.ToArray()
  } finally { $ms.Dispose() }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hashBytes = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
  $hash = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
  [pscustomobject]@{ Path=$Path; Bytes=$bytes; Hash=$hash; RawBytes=$raw.Length; GzipBytes=$bytes.Length }
}

function Test-CounterUrl([string]$BaseUrl) {
  $base = $BaseUrl.TrimEnd('/')
  $counter = "$base/observer-ai.html?gate=$Timestamp"
  $discovery = "$base/liber-ai.json?gate=$Timestamp"
  $guide = "$base/observer-ai-guide.json?gate=$Timestamp"
  $r = Invoke-WebRequest -UseBasicParsing -Uri $counter -MaximumRedirection 5 -TimeoutSec 30
  if ($r.StatusCode -ne 200) { throw "Counter gate returned HTTP $($r.StatusCode): $counter" }
  if ($r.Content -notmatch '<title>LIBER / REVEX AI Counter</title>' -or $r.Content -notmatch 'Take one AI session package') {
    throw "Counter gate returned wrong body: $counter"
  }
  $d = Invoke-WebRequest -UseBasicParsing -Uri $discovery -MaximumRedirection 5 -TimeoutSec 30
  if ($d.StatusCode -ne 200 -or $d.Content -notmatch 'observer') { throw "Discovery gate failed: $discovery" }
  $g = Invoke-WebRequest -UseBasicParsing -Uri $guide -MaximumRedirection 5 -TimeoutSec 30
  if ($g.StatusCode -ne 200 -or $g.Content -notmatch 'Observer') { throw "Guide gate failed: $guide" }
  $continuation = Invoke-WebRequest -UseBasicParsing -Uri "$base/ai/continue.json?gate=$Timestamp" -MaximumRedirection 5 -TimeoutSec 30
  if ($continuation.StatusCode -ne 200 -or $continuation.Content -notmatch '"workMode"\s*:\s*false' -or $continuation.Content -notmatch '"pairAI"\s*:\s*false' -or $continuation.Content -notmatch 'declined or unavailable Work handoff') { throw "Public continuation routing gate failed." }
  $handoff = Invoke-WebRequest -UseBasicParsing -Uri "$base/ai/cases/meadowview-palladian-r1.json?gate=$Timestamp" -MaximumRedirection 5 -TimeoutSec 30
  if ($handoff.StatusCode -ne 200 -or $handoff.Content -notmatch 'meadowview.palladian.front-entry.20260918' -or $handoff.Content -notmatch '"requiresWorkMode"\s*:\s*false') { throw "Scoped handoff gate failed." }
  $dependency = Invoke-WebRequest -UseBasicParsing -Uri "$base/ai/runtime/dependency-graph-r1.js?gate=$Timestamp" -MaximumRedirection 5 -TimeoutSec 30
  if ($dependency.StatusCode -ne 200 -or $dependency.Content -notmatch '20260918r1-dependency-graph') { throw "Dependency runtime gate failed." }
  $vector = Invoke-WebRequest -UseBasicParsing -Uri "$base/ai/cases/meadowview-palladian-r1.svg?gate=$Timestamp" -MaximumRedirection 5 -TimeoutSec 30
  if ($vector.StatusCode -ne 200 -or $vector.Content -notmatch 'center axis = reference / symmetry line') { throw "Vector reference gate failed." }
  Say "Gate PASS: $counter + public-continuation + scoped object-paper/dependency assets"
}

$GCloud = Require-Command @('gcloud.cmd','gcloud.exe','gcloud')
Say "Mode=$Mode Project=$ProjectId Domain=$Domain"
Say 'Obtaining short-lived access token from the existing gcloud login.'
$script:AccessToken = (& $GCloud auth print-access-token 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $script:AccessToken) { throw 'gcloud auth print-access-token failed. Run gcloud auth login, then retry.' }

# Resolve the exact Firebase Hosting site that owns the custom domain.
$sitesResponse = Invoke-Json GET "$Api/projects/$ProjectId/sites?pageSize=40"
$sites = @($sitesResponse.sites)
if ($sites.Count -lt 1) { throw "No Firebase Hosting sites found in $ProjectId." }
$DomainMatches = [System.Collections.Generic.List[object]]::new()
foreach ($site in $sites) {
  $siteId = ([string]$site.name -split '/')[-1]
  try {
    $domains = Invoke-Json GET "$Api/projects/$ProjectId/sites/$siteId/customDomains?pageSize=40"
    foreach ($cd in @($domains.customDomains)) {
      $cdName = [string]$cd.name
      $expectedSuffix = "/customDomains/$Domain"
      if ($cdName.EndsWith($expectedSuffix,[System.StringComparison]::OrdinalIgnoreCase)) {
        $DomainMatches.Add([pscustomobject]@{ SiteId=$siteId; Domain=$cd })
      }
    }
  } catch {
    Say "Custom-domain inventory warning for ${siteId}: $($_.Exception.Message)"
  }
}
if ($DomainMatches.Count -ne 1) { throw "Expected exactly one Firebase Hosting site owning $Domain; found $($DomainMatches.Count). Refusing to mutate hosting." }
$SiteId = [string]$DomainMatches[0].SiteId
$CustomDomain = $DomainMatches[0].Domain
Say "Resolved $Domain -> Firebase Hosting site $SiteId; hostState=$($CustomDomain.hostState); ownershipState=$($CustomDomain.ownershipState)"
if ([string]$CustomDomain.hostState -and [string]$CustomDomain.hostState -ne 'HOST_ACTIVE') { throw "Custom domain is not HOST_ACTIVE: $($CustomDomain.hostState)" }

# Capture the live source version. This is the rollback anchor and clone source.
$live = Invoke-Json GET "$Api/sites/$SiteId/channels/live"
$SourceVersion = [string]$live.release.version.name
if (-not $SourceVersion) { throw 'Live channel has no current version.' }
$SourceVersionObject = Invoke-Json GET "$Api/$SourceVersion"
if ([string]$SourceVersionObject.status -ne 'FINALIZED') { throw "Live source version is not FINALIZED: $($SourceVersionObject.status)" }
$baseline = [ordered]@{
  project=$ProjectId; domain=$Domain; site=$SiteId; liveUrl=$live.url; sourceVersion=$SourceVersion;
  sourceFileCount=$SourceVersionObject.fileCount; sourceBytes=$SourceVersionObject.versionBytes;
  sourceFinalizeTime=$SourceVersionObject.finalizeTime; capturedAt=(Get-Date).ToUniversalTime().ToString('o')
}
$baseline | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $EvidenceDir 'baseline.json') -Encoding UTF8
Say "Rollback anchor: $SourceVersion files=$($SourceVersionObject.fileCount) bytes=$($SourceVersionObject.versionBytes)"

# Public AI files come from one checked-in manifest. Everything else is inherited
# from the current live version by the Firebase Hosting clone.
if (-not (Test-Path -LiteralPath $PublicManifestPath -PathType Leaf)) { throw "Public AI manifest missing: $PublicManifestPath" }
$PublicManifest = Get-Content -LiteralPath $PublicManifestPath -Raw | ConvertFrom-Json
if ([string]$PublicManifest.schema -ne 'liber.ai.public-manifest.v1') { throw "Unexpected public AI manifest schema: $($PublicManifest.schema)" }
$Assets = @($PublicManifest.assets)
if ($Assets.Count -lt 1) { throw 'Public AI manifest contains no assets.' }

$Patch = [ordered]@{}
foreach ($asset in $Assets) {
  $publicPath = ([string]$asset.publicPath).Trim()
  $sourceRelative = ([string]$asset.source).Trim()
  if (-not $publicPath.StartsWith('/')) { throw "Public path must start with /: $publicPath" }
  if (-not $sourceRelative.StartsWith('docs/')) { throw "Public source must stay inside docs/: $sourceRelative" }
  $sourcePath = Join-Path $Root ($sourceRelative -replace '/', [IO.Path]::DirectorySeparatorChar)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $fullSource = [IO.Path]::GetFullPath($sourcePath)
  if (-not $fullSource.StartsWith($fullRoot,[System.StringComparison]::OrdinalIgnoreCase)) { throw "Public source escaped repository root: $sourceRelative" }
  if (-not (Test-Path -LiteralPath $fullSource -PathType Leaf)) { throw "Patch source missing: $sourceRelative" }
  if ($Patch.Contains($publicPath)) { throw "Duplicate public path in manifest: $publicPath" }
  $Patch[$publicPath] = $fullSource
}
if (-not $Patch.Contains('/ai/index.html') -or -not $Patch.Contains('/ai/guide.json') -or -not $Patch.Contains('/ai/cases/meadowview-palladian-r1.json')) {
  throw 'Public AI manifest is missing required counter/guide/handoff assets.'
}
Say "Public AI manifest loaded: $($Patch.Count) surgical overlay assets."
$manifest = [ordered]@{}
$payloadByHash = @{}
foreach ($kv in $Patch.GetEnumerator()) {
  $p = Get-GzipPayload $kv.Value
  $manifest[$kv.Key] = $p.Hash
  $payloadByHash[$p.Hash] = $p
  Say "Patch $($kv.Key) raw=$($p.RawBytes) gzip=$($p.GzipBytes) sha256=$($p.Hash)"
}
foreach ($path in @($manifest.Keys)) {
  if ([string]::IsNullOrWhiteSpace([string]$manifest[$path])) {
    throw "Patch manifest contains an empty hash (Firebase deletion marker): $path"
  }
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $EvidenceDir 'patch-manifest.json') -Encoding UTF8

# AUDIT intentionally stops before any Hosting mutation.
if ($Mode -eq 'AUDIT') {
  Say 'AUDIT PASS: exact Firebase site and rollback anchor resolved; patch payload is ready. No hosting state changed.'
  Say "Next: .\DEPLOY_OBSERVER_PUBLIC_FIREBASE_CURRENT.cmd APPLY"
  exit 0
}

$CloneVersion = $null
$PreviewChannelId = ('observer-public-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')).ToLowerInvariant()
$PreviewChannelCreated = $false
$LiveReleased = $false
try {
  Say "Cloning current live version $SourceVersion so all existing files/config remain intact."
  $cloneOp = Invoke-Json POST "$Api/sites/$SiteId/versions:clone" @{ sourceVersion=$SourceVersion; finalize=$false }
  $cloneDone = Wait-Operation $cloneOp
  if (-not (@($cloneDone.PSObject.Properties.Name) -contains 'response')) { throw 'Clone operation completed without a response.' }
  $CloneVersion = [string]$cloneDone.response.name
  if (-not $CloneVersion) { throw 'Clone operation completed without a version name.' }
  Say "Clone created: $CloneVersion"

  $populate = Invoke-Json POST "$Api/$CloneVersion`:populateFiles" @{ files=$manifest }
  $populateProps = @($populate.PSObject.Properties.Name)
  $required = @()
  if (($populateProps -contains 'uploadRequiredHashes') -and $null -ne $populate.uploadRequiredHashes) {
    $required = @($populate.uploadRequiredHashes)
  }
  Say "Firebase requires $($required.Count) payload upload(s)."
  $uploadBase = $null
  if ($required.Count -gt 0) {
    if (-not ($populateProps -contains 'uploadUrl')) { throw 'Firebase populateFiles requested uploads but returned no uploadUrl.' }
    $uploadBase = ([string]$populate.uploadUrl).TrimEnd('/')
    if (-not $uploadBase) { throw 'Firebase populateFiles returned an empty uploadUrl.' }
  }
  foreach ($hash in $required) {
    if (-not $payloadByHash.ContainsKey([string]$hash)) { throw "Firebase requested unknown payload hash $hash" }
    $tmp = Join-Path $EvidenceDir ("$hash.gz")
    [IO.File]::WriteAllBytes($tmp,$payloadByHash[[string]$hash].Bytes)
    $uploadUri = $uploadBase + '/' + $hash
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uploadUri -Headers (Firebase-Headers) -ContentType 'application/octet-stream' -InFile $tmp
    if ($resp.StatusCode -lt 200 -or $resp.StatusCode -ge 300) { throw "Upload failed for ${hash}: HTTP $($resp.StatusCode)" }
    Remove-Item -LiteralPath $tmp -Force
  }

  $finalPatch = Invoke-Json PATCH "$Api/$CloneVersion`?updateMask=status" @{ name=$CloneVersion; status='FINALIZED' }
  if ([string]$finalPatch.status -ne 'FINALIZED') { throw "Clone did not finalize: $($finalPatch.status)" }
  $final = Get-FinalizedVersionState $CloneVersion
  $finalProps = @($final.PSObject.Properties.Name)
  if ($finalProps -contains 'fileCount') {
    $finalFileCount = [int64]$final.fileCount
    $finalBytesText = if ($finalProps -contains 'versionBytes') { [string]$final.versionBytes } else { 'not-returned' }
    Say "Finalized patched clone: $CloneVersion files=$finalFileCount bytes=$finalBytesText"
    if ($finalFileCount -lt [int64]$SourceVersionObject.fileCount) { throw 'Patched clone contains fewer files than live source; refusing release.' }
  } else {
    Say "Finalized patched clone: $CloneVersion; Firebase omitted fileCount. Preservation remains gated by exact live-version clone + non-empty overlay manifest + preview verification."
  }

  # Preview first. The same finalized version is later released live only after this gate passes.
  $channel = Invoke-Json POST "$Api/sites/$SiteId/channels?channelId=$([uri]::EscapeDataString($PreviewChannelId))" @{ ttl='3600s'; retainedReleaseCount=2 }
  $PreviewChannelCreated = $true
  $previewReleaseUri = "$Api/sites/$SiteId/channels/$PreviewChannelId/releases?versionName=$([uri]::EscapeDataString($CloneVersion))"
  $null = Invoke-Json POST $previewReleaseUri @{ message="Observer public counter preview $Timestamp" }
  $preview = Invoke-Json GET "$Api/sites/$SiteId/channels/$PreviewChannelId"
  $PreviewUrl = [string]$preview.url
  if (-not $PreviewUrl) { throw 'Preview channel returned no URL.' }
  Say "Preview release: $PreviewUrl"
  Test-CounterUrl $PreviewUrl

  # Live cutover is one release pointer change; source version is retained as immediate rollback.
  Say "Preview passed. Releasing patched clone to live; rollback remains $SourceVersion."
  $liveReleaseUri = "$Api/sites/$SiteId/channels/live/releases?versionName=$([uri]::EscapeDataString($CloneVersion))"
  $null = Invoke-Json POST $liveReleaseUri @{ message="Observer public counter surgical patch $Timestamp" }
  $LiveReleased = $true
  Start-Sleep -Seconds 2
  Test-CounterUrl "https://$Domain"

  $after = Invoke-Json GET "$Api/sites/$SiteId/channels/live"
  $afterVersion = [string]$after.release.version.name
  if ($afterVersion -ne $CloneVersion) { throw "Live channel version mismatch after release: $afterVersion" }
  [ordered]@{ result='PASS'; sourceVersion=$SourceVersion; liveVersion=$afterVersion; previewUrl=$PreviewUrl; domain=$Domain; completedAt=(Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $EvidenceDir 'result.json') -Encoding UTF8
  Say "SUCCESS: https://$Domain/observer-ai.html is live from Firebase Hosting."
}
catch {
  Say "ERROR: $($_.Exception.Message)"
  if ($LiveReleased) {
    Say "Live verification failed after cutover. Rolling live channel back to $SourceVersion."
    try {
      $rollbackUri = "$Api/sites/$SiteId/channels/live/releases?versionName=$([uri]::EscapeDataString($SourceVersion))"
      $null = Invoke-Json POST $rollbackUri @{ message="Automatic rollback after Observer public counter verification failure $Timestamp" }
      Say 'ROLLBACK RELEASED.'
    } catch {
      Say "ROLLBACK ERROR: $($_.Exception.Message)"
    }
  }
  throw
}
finally {
  if ($PreviewChannelCreated) {
    try { Invoke-RestMethod -Method Delete -Uri "$Api/sites/$SiteId/channels/$PreviewChannelId" -Headers (Firebase-Headers) | Out-Null; Say "Preview channel removed: $PreviewChannelId" } catch { Say "Preview cleanup warning: $($_.Exception.Message)" }
  }
}