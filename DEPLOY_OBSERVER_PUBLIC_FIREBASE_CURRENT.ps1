param(
  [ValidateSet('AUDIT','APPLY')][string]$Mode = 'AUDIT',
  [string]$ProjectId = 'liber-apps-cca20',
  [string]$Domain = 'liberpict.com'
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Docs = Join-Path $Root 'docs'
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

function Invoke-Json([string]$Method,[string]$Uri,$Body=$null) {
  $headers = @{ Authorization = "Bearer $script:AccessToken" }
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
  Say "Gate PASS: $counter"
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
$matches = @()
foreach ($site in $sites) {
  $siteId = ([string]$site.name -split '/')[-1]
  try {
    $domains = Invoke-Json GET "$Api/projects/$ProjectId/sites/$siteId/customDomains?pageSize=40"
    foreach ($cd in @($domains.customDomains)) {
      $cdName = [string]$cd.name
      if ($cdName -match "/customDomains/$([regex]::Escape($Domain))$") {
        $matches += [pscustomobject]@{ SiteId=$siteId; Domain=$cd }
      }
    }
  } catch {
    Say "Custom-domain inventory warning for ${siteId}: $($_.Exception.Message)"
  }
}
if ($matches.Count -ne 1) { throw "Expected exactly one Firebase Hosting site owning $Domain; found $($matches.Count). Refusing to mutate hosting." }
$SiteId = [string]$matches[0].SiteId
$CustomDomain = $matches[0].Domain
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

# Only these public Observer files are patched. Everything else is inherited from the live version.
$Patch = [ordered]@{
  '/observer-ai.html' = (Join-Path $Docs 'observer-ai.html')
  '/observer-ai-20260917.html' = (Join-Path $Docs 'observer-ai-20260917.html')
  '/ai.html' = (Join-Path $Docs 'ai.html')
  '/ai/index.html' = (Join-Path $Docs 'ai\index.html')
  '/ai/guide.json' = (Join-Path $Docs 'ai\guide.json')
  '/liber-ai.json' = (Join-Path $Docs 'liber-ai.json')
  '/observer-ai-guide.json' = (Join-Path $Docs 'observer-ai-guide.json')
  '/.well-known/liber-ai.json' = (Join-Path $Docs '.well-known\liber-ai.json')
}
foreach ($kv in $Patch.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath $kv.Value -PathType Leaf)) { throw "Patch source missing: $($kv.Value)" }
}
$manifest = [ordered]@{}
$payloadByHash = @{}
foreach ($kv in $Patch.GetEnumerator()) {
  $p = Get-GzipPayload $kv.Value
  $manifest[$kv.Key] = $p.Hash
  $payloadByHash[$p.Hash] = $p
  Say "Patch $($kv.Key) raw=$($p.RawBytes) gzip=$($p.GzipBytes) sha256=$($p.Hash)"
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
  $required = @($populate.uploadRequiredHashes)
  Say "Firebase requires $($required.Count) payload upload(s)."
  foreach ($hash in $required) {
    if (-not $payloadByHash.ContainsKey([string]$hash)) { throw "Firebase requested unknown payload hash $hash" }
    $tmp = Join-Path $EvidenceDir ("$hash.gz")
    [IO.File]::WriteAllBytes($tmp,$payloadByHash[[string]$hash].Bytes)
    $uploadUri = ([string]$populate.uploadUrl).TrimEnd('/') + '/' + $hash
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uploadUri -Headers @{ Authorization="Bearer $script:AccessToken" } -ContentType 'application/octet-stream' -InFile $tmp
    if ($resp.StatusCode -lt 200 -or $resp.StatusCode -ge 300) { throw "Upload failed for ${hash}: HTTP $($resp.StatusCode)" }
    Remove-Item -LiteralPath $tmp -Force
  }

  $final = Invoke-Json PATCH "$Api/$CloneVersion`?updateMask=status" @{ name=$CloneVersion; status='FINALIZED' }
  if ([string]$final.status -ne 'FINALIZED') { throw "Clone did not finalize: $($final.status)" }
  Say "Finalized patched clone: $CloneVersion files=$($final.fileCount)"
  if ([int64]$final.fileCount -lt [int64]$SourceVersionObject.fileCount) { throw 'Patched clone contains fewer files than live source; refusing release.' }

  # Preview first. The same finalized version is later released live only after this gate passes.
  $channel = Invoke-Json POST "$Api/sites/$SiteId/channels?channelId=$([uri]::EscapeDataString($PreviewChannelId))" @{ ttl='3600s'; retainedReleaseCount=2 }
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
  if ($PreviewChannelId) {
    try { Invoke-RestMethod -Method Delete -Uri "$Api/sites/$SiteId/channels/$PreviewChannelId" -Headers @{ Authorization="Bearer $script:AccessToken" } | Out-Null; Say "Preview channel removed: $PreviewChannelId" } catch { Say "Preview cleanup warning: $($_.Exception.Message)" }
  }
}
