param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-energy-worker",
  [string]$GitHubRepository = "nvberegovykh/LIBER-Creative",
  [string]$ReleaseModelPath = "",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Root = (Resolve-Path $PSScriptRoot).Path
$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$ReleaseTag = "0.8.19-r49"
$Build = "20260813r49"
$PublisherOrchestration = "20260814r49-full-downstream-v1"
$GbxmlEvidenceProducerSha256 = "f9b48ebce0b98c134f81b8e174c8fb0e576186c2200290c5d1ccb0ea8e6af214"
$CanonicalSourceCommit = "7c450801e1515af649c7f4ad4bfc4b45f32c59c8"
$CanonicalSourceRef = "local/revex-r49-cloud-worker-runtime-closure"
$CanonicalSourceArchiveName = "REVEX_R49_SOURCE_7c450801e1515af649c7f4ad4bfc4b45f32c59c8.zip"
$CanonicalSourceArchiveSha256 = "7c450801e1515af649c7f4ad4bfc4b45f32c59c867446dae61037e159709fa50"
$CanonicalSourceArchiveSize = 52810258L
$CanonicalSourceArchive = Join-Path $Root $CanonicalSourceArchiveName
$StageRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX-R49-Publish\$RunId"
$CanonicalSourceRoot = Join-Path $StageRoot "canonical-source"
$StageSource = Join-Path $StageRoot "source"
$StageFunctions = Join-Path $StageSource "server\firebase-functions"
$StageRules = Join-Path $StageRoot "live-rules-gate"
$StagePayload = Join-Path $StageRoot "addin-payload"
$RepoRoot = Join-Path $StageRoot "LIBER-Creative"
$InstalledRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\App"
$BackupRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\App.before-r49.$RunId"
$AddinPath = Join-Path $env:APPDATA "Autodesk\Revit\Addins\2026\LIBER.REVEX.addin"
$RevitDir = "C:\Program Files\Autodesk\Revit 2026"
$RevitExe = Join-Path $RevitDir "Revit.exe"
$LiveUrl = "https://liberpict.com/liber-apps/apps/revex/index.html"
$LogPath = Join-Path $Root "PUBLISH_REVEX_R49.$RunId.log"
$LatestLogPath = Join-Path $Root "PUBLISH_REVEX_R49.latest.log"
$PreflightLatestPath = Join-Path $Root "REVEX-R49-PREFLIGHT.latest.json"
$PreflightStagePath = Join-Path $StageRoot "REVEX-R49-PREFLIGHT.json"
$CompanionSimulationReport = Join-Path $StageRoot "REVEX-R49-COMPANION-SIMULATION.json"
$ReleaseEvidenceRoot = Join-Path $StageRoot "real-revit-evidence"
$ReleaseEvidenceResult = Join-Path $ReleaseEvidenceRoot "REVEX-RELEASE-EVIDENCE-RESULT.json"
$ReleaseEnergyRoot = Join-Path $StageRoot "real-project-energy"
$ReleaseAcceptancePath = Join-Path $StageRoot "REVEX-R49-REAL-PROJECT-ACCEPTANCE.json"
$BuildBinlog = Join-Path $StageRoot "REVEX-R49-BUILD.binlog"
$CredentialRotationMarker = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\r49-firebase-cli-credential-rotated.marker"
$Preflight = [ordered]@{
  schema = "liber.revex.release-preflight.v1"
  build = $Build
  release = $ReleaseTag
  runId = $RunId
  status = "STARTED"
  stage = "LOCAL_RELEASE_GATE"
  startedAt = [DateTime]::UtcNow.ToString("o")
  finishedAt = $null
  safety = [ordered]@{
    revitWrites = $false
    githubMutations = $false
    cloudMutations = $false
    officialComcheckProjectTransmission = $false
  }
  checkpoints = @()
}
$script:BrokerTokenCreatorGrantActive = $false
$script:BrokerTokenCreatorGcloud = ""
$script:BrokerTokenCreatorSa = ""
$script:BrokerTokenCreatorMember = ""
$script:BrokerTokenCreatorRole = "roles/iam.serviceAccountTokenCreator"

[IO.File]::WriteAllText($LogPath, "", [Text.UTF8Encoding]::new($false))
try { [IO.File]::WriteAllText($LatestLogPath, "", [Text.UTF8Encoding]::new($false)) } catch { }

function Write-Log {
  param([Parameter(ValueFromPipeline=$true)][AllowNull()][object]$Message, [ConsoleColor]$Color = [ConsoleColor]::Gray)
  process {
    $line = if ($null -eq $Message) { "" } else { [string]$Message }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    try { Add-Content -LiteralPath $LatestLogPath -Value $line -Encoding UTF8 } catch { }
    Write-Host $line -ForegroundColor $Color
  }
}

function Write-Step([string]$Message) { Write-Log ">> $Message" DarkCyan }

function Protect-DeploymentLogs {
  $paths = @($LogPath, $LatestLogPath)
  try {
    $paths += @(Get-ChildItem -LiteralPath $Root -File -Filter "PUBLISH_REVEX_R49*.log" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  } catch { }
  foreach ($path in @($paths | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    $content = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    $content = [regex]::Replace($content, '("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]*(")', '$1<REDACTED>$2', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $content = [regex]::Replace($content, 'ya29\.[A-Za-z0-9._-]+', '<REDACTED_ACCESS_TOKEN>')
    $content = [regex]::Replace($content, '1//[A-Za-z0-9._-]+', '<REDACTED_REFRESH_TOKEN>')
    [IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))
  }
}

function Get-FirebaseRefreshTokenForRotation([string]$Firebase) {
  $state = Invoke-SecretCaptured "Read current Firebase CLI credential in-memory for secure rotation" $Firebase @("login:list", "--json") -AllowFailure
  if ($state.ExitCode -ne 0 -or -not $state.Text.Trim()) {
    throw "Firebase CLI credential rotation could not read the current local login state. No cloud mutation was attempted."
  }
  try { $payload = $state.Text | ConvertFrom-Json } catch {
    throw "Firebase CLI credential rotation could not parse the local login state. No credential material was logged."
  }
  $accounts = if ($payload.PSObject.Properties.Name -contains "result") { @($payload.result) } else { @($payload) }
  $tokens = @($accounts | ForEach-Object {
    if ($null -ne $_.tokens -and -not [string]::IsNullOrWhiteSpace([string]$_.tokens.refresh_token)) { [string]$_.tokens.refresh_token }
  } | Sort-Object -Unique)
  if ($tokens.Count -eq 0) {
    throw "Firebase CLI has no cached refresh token to rotate. Run Firebase login once, then rerun this publisher."
  }
  if ($tokens.Count -gt 1) {
    throw "Multiple Firebase CLI credentials are cached; refusing to revoke unrelated accounts automatically. Keep only the REVEX publisher account signed in, then rerun."
  }
  return [string]$tokens[0]
}

function Revoke-GoogleOAuthToken([string]$Token) {
  Write-Step "Revoke the Firebase CLI credential exposed by the prior r49 diagnostic log"
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "https://oauth2.googleapis.com/revoke" -ContentType "application/x-www-form-urlencoded" -Body @{ token = $Token } -TimeoutSec 30
    if ([int]$response.StatusCode -ne 200) { throw "unexpected status" }
    return "REVOKED"
  } catch {
    $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
    $body = ""
    try {
      $stream = $_.Exception.Response.GetResponseStream()
      if ($null -ne $stream) {
        $reader = New-Object IO.StreamReader($stream)
        try { $body = $reader.ReadToEnd() } finally { $reader.Dispose(); $stream.Dispose() }
      }
    } catch { }
    if ($status -eq 400 -and $body -match 'invalid_token') { return "ALREADY_REVOKED" }
    throw "Firebase credential revocation failed at the Google OAuth endpoint (HTTP $status). Sensitive credential material was not logged."
  }
}

function Save-PreflightReport {
  $json = $script:Preflight | ConvertTo-Json -Depth 30
  [IO.File]::WriteAllText($PreflightLatestPath, $json, [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $StageRoot -PathType Container) {
    [IO.File]::WriteAllText($PreflightStagePath, $json, [Text.UTF8Encoding]::new($false))
  }
}

function Add-PreflightCheckpoint([string]$Name, [object]$Detail) {
  $script:Preflight.checkpoints += [ordered]@{
    name = $Name
    status = "PASSED"
    at = [DateTime]::UtcNow.ToString("o")
    detail = $Detail
  }
  Save-PreflightReport
}

function Resolve-Executable([string[]]$Names) {
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  return $null
}

function Refresh-ToolPath {
  $paths = @(
    "$env:ProgramFiles\Git\cmd", "$env:ProgramFiles\GitHub CLI", "$env:ProgramFiles\dotnet",
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin",
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin",
    "$env:ProgramFiles\nodejs", "$env:APPDATA\npm",
    "$env:LOCALAPPDATA\Programs\Python\Python312", "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  try {
    $paths += @(Get-ChildItem -LiteralPath "$env:ProgramFiles\Eclipse Adoptium" -Directory -Filter "jdk-21*" -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "bin" } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Container })
  } catch { }
  foreach ($path in $paths) {
    if (($env:Path -split ';') -notcontains $path) { $env:Path += ";$path" }
  }
}

function Invoke-Native {
  param(
    [Parameter(Mandatory=$true)][string]$Step,
    [Parameter(Mandatory=$true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = ""
  )
  Write-Step $Step
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command @Arguments 2>&1 | ForEach-Object { Write-Log ([string]$_) }
    $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $oldPreference
    if ($WorkingDirectory) { Pop-Location }
  }
  if ($code -ne 0) { throw "$Step failed with exit code $code." }
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory=$true)][string]$Step,
    [Parameter(Mandatory=$true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = "",
    [switch]$AllowFailure
  )
  Write-Step $Step
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $lines = @()
  try {
    & $Command @Arguments 2>&1 | ForEach-Object { $lines += [string]$_; Write-Log ([string]$_) }
    $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $oldPreference
    if ($WorkingDirectory) { Pop-Location }
  }
  if ($code -ne 0 -and -not $AllowFailure) { throw "$Step failed with exit code $code." }
  return [pscustomobject]@{ ExitCode = $code; Text = ($lines -join [Environment]::NewLine); Lines = $lines }
}

function Invoke-NpmAuditGate {
  param(
    [Parameter(Mandatory=$true)][string]$Step,
    [Parameter(Mandatory=$true)][string]$Npm,
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [Parameter(Mandatory=$true)][string]$WorkingDirectory,
    [Parameter(Mandatory=$true)][string]$PinnedLockSha256,
    [Parameter(Mandatory=$true)][string]$PriorVerifiedAt,
    [Parameter(Mandatory=$true)][string]$PriorVerifiedLog
  )
  $lockPath = Join-Path $WorkingDirectory "package-lock.json"
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    throw "$Step cannot run because package-lock.json is missing: $lockPath"
  }
  $lockHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($lockHash -ne $PinnedLockSha256) {
    throw "$Step refused the dependency tree because package-lock.json drifted. Expected $PinnedLockSha256; actual $lockHash"
  }

  $lastTransient = ""
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $result = Invoke-Captured "$Step (attempt $attempt/5)" $Npm $Arguments -WorkingDirectory $WorkingDirectory -AllowFailure
    if ($result.ExitCode -eq 0) {
      Write-Log "$Step passed online for pinned lockfile $lockHash." Green
      return
    }

    $text = [string]$result.Text
    $isTransient = $text -match '(?i)(503|502|504|429|Service Unavailable|Too Many Requests|audit endpoint returned an error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|network request to .* failed)'
    if (-not $isTransient) {
      throw "$Step failed with exit code $($result.ExitCode). The audit service responded and publication remains blocked; inspect the audit findings above."
    }

    $lastTransient = ($text -replace '[\r\n]+',' ').Trim()
    if ($lastTransient.Length -gt 500) { $lastTransient = $lastTransient.Substring(0,500) + '...' }
    if ($attempt -lt 5) {
      $delay = 5 * $attempt
      Write-Log "npm advisory service transient failure detected; retrying in $delay seconds without changing dependency bytes." Yellow
      Start-Sleep -Seconds $delay
    }
  }

  $finalHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($finalHash -ne $PinnedLockSha256) {
    throw "$Step cannot use the prior audit attestation because package-lock.json changed during retry."
  }
  Write-Log "npm advisory service remained unavailable after bounded retries. Accepting the prior successful online audit only because the exact pinned package-lock SHA is unchanged ($finalHash); prior verification: $PriorVerifiedAt in $PriorVerifiedLog." Yellow
  Add-PreflightCheckpoint "NPM_AUDIT_TRANSIENT_FALLBACK" ([ordered]@{
    step = $Step
    packageLockSha256 = $finalHash
    transientFailure = $lastTransient
    retries = 5
    priorOnlineAuditVerifiedAt = $PriorVerifiedAt
    priorOnlineAuditLog = $PriorVerifiedLog
    dependencyBytesUnchanged = $true
    vulnerabilitiesBypassed = $false
  })
}

function Invoke-SecretCaptured {
  param(
    [Parameter(Mandatory=$true)][string]$Step,
    [Parameter(Mandatory=$true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = "",
    [switch]$AllowFailure
  )
  Write-Step $Step
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $lines = @()
  try {
    & $Command @Arguments 2>&1 | ForEach-Object { $lines += [string]$_ }
    $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $oldPreference
    if ($WorkingDirectory) { Pop-Location }
  }
  if ($code -ne 0 -and -not $AllowFailure) { throw "$Step failed with exit code $code. Sensitive output was intentionally not logged." }
  return [pscustomobject]@{ ExitCode = $code; Text = ($lines -join [Environment]::NewLine); Lines = $lines }
}

function Invoke-InteractiveNoLog {
  param(
    [Parameter(Mandatory=$true)][string]$Step,
    [Parameter(Mandatory=$true)][string]$Command,
    [string[]]$Arguments = @()
  )
  Write-Step $Step
  & $Command @Arguments
  $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  if ($code -ne 0) { throw "$Step failed with exit code $code. Authentication output was intentionally not logged." }
}

function Install-WingetPackage([string]$Id, [string]$Label) {
  $winget = Resolve-Executable @("winget.exe", "winget")
  if (-not $winget) { throw "$Label is required and WinGet is unavailable." }
  Invoke-Native "Install $Label" $winget @("install", "--exact", "--id", $Id, "--accept-package-agreements", "--accept-source-agreements", "--silent")
  Refresh-ToolPath
}

function Assert-SourceHash([string]$RelativePath, [string]$Expected) {
  $path = Join-Path $Root $RelativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required r49 source is missing: $RelativePath" }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "Stale or partial r49 source: $RelativePath`nExpected $Expected`nActual   $actual" }
}

function Get-CanonicalSourceRelativePath([string]$RelativePath) {
  $normalized = $RelativePath.Replace("\", "/")
  $localCompanionPrefix = "src/Live-Companion/"
  if ($normalized.StartsWith($localCompanionPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    return "docs/liber-apps/apps/revex/" + $normalized.Substring($localCompanionPrefix.Length)
  }
  return $normalized
}

function Get-Utf8CrLfText([string]$Path) {
  $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  return $text.Replace("`r`n", "`n").Replace("`r", "`n").Replace("`n", "`r`n")
}

function Get-Utf8TextSha256([string]$Text) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
}

function Install-CanonicalSourceFile([string]$CanonicalPath, [string]$TargetPath, [string]$ExpectedHash, [bool]$NormalizeUtf8CrLf) {
  $targetDirectory = Split-Path -Parent $TargetPath
  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  $temporaryPath = "$TargetPath.revex-r49-repair-$RunId.tmp"
  $backupPath = "$TargetPath.revex-r49-before-repair-$RunId.bak"
  if ($NormalizeUtf8CrLf) {
    [IO.File]::WriteAllText($temporaryPath, (Get-Utf8CrLfText $CanonicalPath), [Text.UTF8Encoding]::new($false))
  } else {
    Copy-Item -LiteralPath $CanonicalPath -Destination $temporaryPath -Force
  }
  $temporaryHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($temporaryHash -ne $ExpectedHash) {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    throw "Canonical r49 repair copy failed integrity verification: $TargetPath"
  }

  try {
    if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
      try {
        [IO.File]::Replace($temporaryPath, $TargetPath, $backupPath, $true)
      } catch {
        if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
          Copy-Item -LiteralPath $TargetPath -Destination $backupPath -Force
        }
        Move-Item -LiteralPath $temporaryPath -Destination $TargetPath -Force
      }
    } else {
      [IO.File]::Move($temporaryPath, $TargetPath)
    }
    $installedHash = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($installedHash -ne $ExpectedHash) { throw "Installed source hash is $installedHash" }
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  } catch {
    $failure = $_.Exception.Message
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      Copy-Item -LiteralPath $backupPath -Destination $TargetPath -Force
    }
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    throw "Atomic r49 source repair failed for $TargetPath. The prior file was preserved. $failure"
  }
}

function Wait-ForCanonicalSourceArchive {
  Write-Step "Wait for the immutable r49 archive to finish Google Drive hydration"
  $deadline = [DateTime]::UtcNow.AddMinutes(10)
  $lastState = ""
  do {
    $state = "missing"
    if (Test-Path -LiteralPath $CanonicalSourceArchive -PathType Leaf) {
      try {
        $size = (Get-Item -LiteralPath $CanonicalSourceArchive).Length
        $state = "size=$size/$CanonicalSourceArchiveSize"
        if ($size -eq $CanonicalSourceArchiveSize) {
          $hash = (Get-FileHash -LiteralPath $CanonicalSourceArchive -Algorithm SHA256).Hash.ToLowerInvariant()
          $state = "size=$size; sha256=$hash"
          if ($hash -eq $CanonicalSourceArchiveSha256) {
            Write-Log "Immutable source archive is fully hydrated and hash-verified ($size bytes)." Green
            return $hash
          }
        }
      } catch {
        $state = "Drive hydration pending: $($_.Exception.Message)"
      }
    }
    if ($state -ne $lastState) {
      Write-Log "Waiting for Drive source archive: $state" Yellow
      $lastState = $state
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds 5
  } while ($true)
  throw "The immutable r49 archive did not finish Drive sync within 10 minutes: $CanonicalSourceArchive`nExpected size $CanonicalSourceArchiveSize and SHA-256 $CanonicalSourceArchiveSha256`nLast state: $lastState"
}

function Restore-HashLockedSource([System.Collections.IDictionary]$Expected) {
  Write-Step "Restore the complete r49 source set from its immutable local candidate archive"
  New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
  if (Test-Path -LiteralPath $CanonicalSourceRoot) {
    throw "The isolated canonical-source directory already exists unexpectedly: $CanonicalSourceRoot"
  }
  $archiveHash = Wait-ForCanonicalSourceArchive
  Expand-Archive -LiteralPath $CanonicalSourceArchive -DestinationPath $CanonicalSourceRoot

  $repaired = @()
  $localRepairFailures = @()
  $lineEndingNormalizations = @()
  foreach ($entry in $Expected.GetEnumerator()) {
    $relativePath = [string]$entry.Key
    $expectedHash = [string]$entry.Value
    $canonicalRelativePath = Get-CanonicalSourceRelativePath $relativePath
    $canonicalPath = Join-Path $CanonicalSourceRoot ($canonicalRelativePath.Replace("/", "\"))
    if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
      throw "Immutable candidate $CanonicalSourceCommit is missing required source: $canonicalRelativePath. No unverified replacement was accepted."
    }
    $canonicalHash = (Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $normalizeUtf8CrLf = $false
    if ($canonicalHash -ne $expectedHash -and $canonicalRelativePath -match '^src/Liber\.Revex\.Revit/Engineering/Energy/References/79_WINTHROP_APPROVED_(BASELINE|PROPOSED)\.osm$') {
      $normalizedHash = Get-Utf8TextSha256 (Get-Utf8CrLfText $canonicalPath)
      if ($normalizedHash -eq $expectedHash) {
        $canonicalHash = $normalizedHash
        $normalizeUtf8CrLf = $true
        $lineEndingNormalizations += $relativePath
      }
    }
    if ($canonicalHash -ne $expectedHash) {
      throw "Immutable candidate integrity mismatch: $canonicalRelativePath`nExpected $expectedHash`nCanonical $canonicalHash`nNo unverified replacement was accepted."
    }

    $targetPath = Join-Path $Root $relativePath
    $localHash = if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
      (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { "<missing>" }
    if ($localHash -ne $expectedHash) {
      try {
        Install-CanonicalSourceFile $canonicalPath $targetPath $expectedHash $normalizeUtf8CrLf
        $repaired += $relativePath
        Write-Log "Restored hash-locked source: $relativePath ($localHash -> $expectedHash)" Yellow
      } catch {
        $localRepairFailures += $relativePath
        Write-Log "Drive mirror remained stale for $relativePath; the publisher will use the verified immutable source stage instead. $($_.Exception.Message)" Yellow
      }
    }
  }

  $remainingLocalDrift = @()
  foreach ($entry in $Expected.GetEnumerator()) {
    $localPath = Join-Path $Root ([string]$entry.Key)
    $localHash = if (Test-Path -LiteralPath $localPath -PathType Leaf) {
      (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { "<missing>" }
    if ($localHash -ne [string]$entry.Value) { $remainingLocalDrift += [string]$entry.Key }
  }
  Write-Log "All $($Expected.Count) locked inputs were independently verified against immutable candidate $CanonicalSourceCommit; live Drive source files are not used for build or publication." Green
  Add-PreflightCheckpoint "CANONICAL_SOURCE_RESTORE" ([ordered]@{
    canonicalCommit = $CanonicalSourceCommit
    canonicalRef = $CanonicalSourceRef
    canonicalArchive = $CanonicalSourceArchiveName
    canonicalArchiveSha256 = $archiveHash
    lockedFileCount = $Expected.Count
    repairedFileCount = $repaired.Count
    repairedFiles = @($repaired)
    localRepairFailureCount = $localRepairFailures.Count
    localRepairFailures = @($localRepairFailures)
    remainingLocalDriveDrift = @($remainingLocalDrift)
    deterministicCrLfFiles = @($lineEndingNormalizations)
    canonicalFullSetVerification = $true
    preliminaryGitHubPushRequired = $false
    localDriveFilesExcludedFromBuild = $true
  })
}

function New-IsolatedCanonicalSourceStage([System.Collections.IDictionary]$Expected) {
  Write-Step "Create the immutable r49 build and QA source stage"
  New-Item -ItemType Directory -Path $StageSource -Force | Out-Null
  Copy-SourceTree (Join-Path $CanonicalSourceRoot "src\Liber.Revex.Revit") (Join-Path $StageSource "src\Liber.Revex.Revit")
  Copy-SourceTree (Join-Path $CanonicalSourceRoot "docs\liber-apps\apps\revex") (Join-Path $StageSource "src\Live-Companion")
  Copy-SourceTree (Join-Path $CanonicalSourceRoot "server\revex-energy-worker") (Join-Path $StageSource "server\revex-energy-worker")
  Copy-SourceTree (Join-Path $CanonicalSourceRoot "server\firebase-functions") (Join-Path $StageSource "server\firebase-functions")
  Copy-Item -LiteralPath (Join-Path $Root "PUBLISH_REVEX_R49.ps1") -Destination (Join-Path $StageSource "PUBLISH_REVEX_R49.ps1") -Force

  foreach ($entry in $Expected.GetEnumerator()) {
    $relativePath = [string]$entry.Key
    $expectedHash = [string]$entry.Value
    $canonicalRelativePath = Get-CanonicalSourceRelativePath $relativePath
    $canonicalPath = Join-Path $CanonicalSourceRoot ($canonicalRelativePath.Replace("/", "\"))
    $stagePath = Join-Path $StageSource $relativePath
    $normalizeUtf8CrLf = $canonicalRelativePath -match '^src/Liber\.Revex\.Revit/Engineering/Energy/References/79_WINTHROP_APPROVED_(BASELINE|PROPOSED)\.osm$'
    $stageHash = if (Test-Path -LiteralPath $stagePath -PathType Leaf) {
      (Get-FileHash -LiteralPath $stagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { "<missing>" }
    if ($stageHash -ne $expectedHash) {
      Install-CanonicalSourceFile $canonicalPath $stagePath $expectedHash $normalizeUtf8CrLf
    }
    $finalStageHash = (Get-FileHash -LiteralPath $stagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($finalStageHash -ne $expectedHash) {
      throw "Immutable source-stage hash mismatch: $relativePath`nExpected $expectedHash`nActual   $finalStageHash"
    }
  }
  Write-Log "Immutable build/QA stage contains the exact full source tree and all $($Expected.Count) hash-locked files." Green
  Add-PreflightCheckpoint "IMMUTABLE_SOURCE_STAGE" ([ordered]@{
    canonicalCommit = $CanonicalSourceCommit
    lockedFileCount = $Expected.Count
    fullRevitSourceTree = $true
    fullCompanionSourceTree = $true
    fullWorkerAndBrokerSourceTrees = $true
    independentOfDriveAfterCreation = $true
  })
}

function Assert-ReleaseBundleClosure([string]$SourceRoot) {
  Write-Step "Verify gbXML engine identity and downstream deployment dependency closure"
  $graphPath = Join-Path $SourceRoot "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn"
  $pythonPath = Join-Path $SourceRoot "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py"
  $servicePath = Join-Path $SourceRoot "src\Liber.Revex.Revit\Services\GbxmlEngineeringService.cs"
  $workflowPath = Join-Path $SourceRoot ".github\workflows\revex-r27-0819-engineering-release.yml"
  $dockerPath = Join-Path $SourceRoot "server\revex-energy-worker\Dockerfile"
  $cloudBuildPath = Join-Path $SourceRoot "server\revex-energy-worker\cloudbuild.yaml"
  $brokerPath = Join-Path $SourceRoot "server\firebase-functions\index.js"
  $workerPath = Join-Path $SourceRoot "server\revex-energy-worker\app.py"
  $workerVerifierPath = Join-Path $SourceRoot "server\revex-energy-worker\verify_revex_r49_worker.py"
  $acceptancePath = Join-Path $SourceRoot "server\revex-energy-worker\run_revex_r49_release_acceptance.py"
  $pipelinePath = Join-Path $SourceRoot "src\Liber.Revex.Revit\Engineering\Energy\revex_energy_pipeline.py"
  $geometryRequirementsPath = Join-Path $SourceRoot "src\Liber.Revex.Revit\Engineering\Energy\GeometryCo\requirements.txt"
  foreach ($required in @($graphPath,$pythonPath,$servicePath,$workflowPath,$dockerPath,$cloudBuildPath,$brokerPath,$workerPath,$workerVerifierPath,$acceptancePath,$pipelinePath,$geometryRequirementsPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Release dependency closure is missing: $required" }
  }
  $graph = Get-Content -LiteralPath $graphPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $pythonNodes = @($graph.Nodes | Where-Object { [string]$_.NodeType -eq "PythonScriptNode" })
  if ($pythonNodes.Count -ne 1) { throw "gbXML Dynamo graph must contain exactly one embedded Python engine (found $($pythonNodes.Count))." }
  if (@($pythonNodes[0].Inputs).Count -ne 8) { throw "gbXML Dynamo graph must expose exactly eight inputs." }
  $embedded = ([string]$pythonNodes[0].Code).Replace("`r`n","`n").Replace("`r","`n")
  $external = ([IO.File]::ReadAllText($pythonPath, [Text.Encoding]::UTF8)).Replace("`r`n","`n").Replace("`r","`n")
  if ($embedded -ne $external) { throw "gbXML Dynamo embedded Python and external Python are not byte-equivalent after newline normalization." }
  $versionMatch = [regex]::Match($external, 'TOOL_VERSION\s*=\s*"([^"]+)"')
  if (-not $versionMatch.Success) { throw "gbXML Python engine has no TOOL_VERSION." }
  $engineVersion = $versionMatch.Groups[1].Value
  $service = [IO.File]::ReadAllText($servicePath, [Text.Encoding]::UTF8)
  if (-not $service.Contains("EngineVersion = `"$engineVersion`"")) { throw "GbxmlEngineeringService EngineVersion does not match the bundled Python/Dynamo engine ($engineVersion)." }
  $producerMaterial = ((Get-FileHash -LiteralPath $pythonPath -Algorithm SHA256).Hash.ToLowerInvariant()) + "`n" + ((Get-FileHash -LiteralPath $graphPath -Algorithm SHA256).Hash.ToLowerInvariant()) + "`n" + ((Get-FileHash -LiteralPath $servicePath -Algorithm SHA256).Hash.ToLowerInvariant())
  $producerDigest = Get-Utf8TextSha256 $producerMaterial
  if ($producerDigest -ne $GbxmlEvidenceProducerSha256) { throw "gbXML evidence producer bundle digest is stale: expected $GbxmlEvidenceProducerSha256; actual $producerDigest" }
  $workflow = [IO.File]::ReadAllText($workflowPath, [Text.Encoding]::UTF8)
  $docker = [IO.File]::ReadAllText($dockerPath, [Text.Encoding]::UTF8)
  $cloudBuild = [IO.File]::ReadAllText($cloudBuildPath, [Text.Encoding]::UTF8)
  $broker = [IO.File]::ReadAllText($brokerPath, [Text.Encoding]::UTF8)
  $worker = [IO.File]::ReadAllText($workerPath, [Text.Encoding]::UTF8)
  $workerVerifier = [IO.File]::ReadAllText($workerVerifierPath, [Text.Encoding]::UTF8)
  $acceptance = [IO.File]::ReadAllText($acceptancePath, [Text.Encoding]::UTF8)
  $pipeline = [IO.File]::ReadAllText($pipelinePath, [Text.Encoding]::UTF8)
  $geometryRequirements = [IO.File]::ReadAllText($geometryRequirementsPath, [Text.Encoding]::UTF8)
  if (-not $workflow.Contains("REVEX r49 final gate") -or -not $workflow.Contains("GeometryCo/requirements.txt") -or -not $workflow.Contains("verify-revex-r49-live-comcheck.py")) { throw "GitHub final gate does not exercise the complete GeometryCo and live clean-COMcheck dependency set." }
  if (-not $docker.Contains("/opt/revex/energy/GeometryCo/requirements.txt")) { throw "Cloud worker image does not install GeometryCo runtime dependencies." }
  if (-not $workerVerifier.Contains("run_revex_r49_release_acceptance.py")) { throw "Managed worker verifier no longer exercises the real-project release-acceptance module." }
  if (-not $docker.Contains("COPY server/revex-energy-worker/run_revex_r49_release_acceptance.py /opt/revex/server/run_revex_r49_release_acceptance.py")) { throw "Cloud worker image omits run_revex_r49_release_acceptance.py required by worker QA." }
  if (-not $docker.Contains("python3 -m py_compile /opt/revex/server/app.py /opt/revex/server/run_revex_r49_release_acceptance.py /opt/revex/server/verify_revex_r49_worker.py")) { throw "Cloud worker image lacks the early server-module runtime-closure compile gate." }
  if (-not $cloudBuild.Contains("timeout: 1800s")) { throw "Cloud Build does not reserve enough time for the pinned OpenStudio image and full worker QA." }
  if (-not $broker.Contains("REVEX_SOURCE_CANDIDATE") -or -not $broker.Contains("sourceCandidate")) { throw "Firebase broker is not candidate-bound against stale r49 Energy result reuse." }
  if (-not $worker.Contains("COMCHECK_SEMANTIC_VERSION") -or -not $worker.Contains("scheduleNamesAuthoritative") -or -not $worker.Contains("_narrow_comcheck_schedule_agent")) { throw "Managed worker does not include the schedule-name-independent COMcheck semantic agent." }
  if (-not $acceptance.Contains("semanticPassRerun") -or -not $acceptance.Contains("enrich_comcheck_schedule_facts")) { throw "Real-project acceptance cannot reuse immutable raw page facts while rerunning current COMcheck semantics." }
  if (-not $acceptance.Contains("require_review_eligible_comparison") -or -not $acceptance.Contains("UNBENCHMARKED_DIFFERENT_COHORT")) { throw "Real-project acceptance does not distinguish a valid different geometry cohort from a matching-cohort regression." }
  if (-not $pipeline.Contains("comcheckSemantic") -or -not $pipeline.Contains("scheduleSemanticVersion")) { throw "COMcheck serializer is not bound to consolidated schedule-semantic facts." }
  if (-not $geometryRequirements.Contains('onnxruntime==1.23.2; platform_system != "Windows" and python_version < "3.11"') -or -not $geometryRequirements.Contains('onnxruntime==1.24.4; platform_system != "Windows" and python_version >= "3.11"')) { throw "GeometryCo runtime dependencies do not preserve the Linux Python 3.10/3.11+ ONNX Runtime compatibility split required by the Ubuntu 22.04 cloud worker." }
  Add-PreflightCheckpoint "RELEASE_DEPENDENCY_CLOSURE" ([ordered]@{
    gbxmlEngineVersion = $engineVersion
    gbxmlEmbeddedExternalMatch = $true
    gbxmlInputCount = 8
    gbxmlProducerBundleSha256 = $producerDigest
    githubGeometryCoRuntime = $true
    cloudWorkerGeometryCoRuntime = $true
    cloudBuildTimeoutSeconds = 1800
    sourceCandidateBoundWorkerAndBroker = $true
    comcheckScheduleSemanticAgent = $true
    scheduleNamesAuthoritative = $false
    partialPageScanReuseWithSemanticRerun = $true
    cloudWorkerPython310OnnxRuntimeCompatible = $true
    cloudWorkerAcceptanceModulePackaged = $true
    cloudWorkerServerModuleCompileGate = $true
  })
  Write-Log "gbXML graph/Python/C# identity and downstream worker/GitHub/broker dependency closure passed before real Revit acceptance." Green
}

function Copy-SourceTree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $sourcePath = (Resolve-Path $Source).Path.TrimEnd('\')
  foreach ($file in Get-ChildItem -LiteralPath $sourcePath -Recurse -File) {
    $relative = $file.FullName.Substring($sourcePath.Length).TrimStart('\')
    if ($relative -match '(^|\\)(bin|obj|node_modules|__pycache__|\.pytest_cache)(\\|$)' -or $relative -match '\.pyc$') { continue }
    $target = Join-Path $Destination $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
}

function Add-ProjectRole([string]$Gcloud, [string]$Member, [string]$Role, [string]$Label) {
  Invoke-Native $Label $Gcloud @("projects", "add-iam-policy-binding", $ProjectId, "--member=$Member", "--role=$Role", "--quiet")
}

function Add-ServiceAccountUser([string]$Gcloud, [string]$Account, [string]$Member, [string]$Label) {
  Invoke-Native $Label $Gcloud @("iam", "service-accounts", "add-iam-policy-binding", $Account, "--project=$ProjectId", "--member=$Member", "--role=roles/iam.serviceAccountUser", "--quiet")
}

function Ensure-ServiceAccount([string]$Gcloud, [string]$Email, [string]$DisplayName) {
  $probe = Invoke-Captured "Verify service identity $Email" $Gcloud @("iam", "service-accounts", "describe", $Email, "--project=$ProjectId", "--format=value(email)") -AllowFailure
  if ($probe.ExitCode -eq 0) { return }
  $accountId = $Email.Split('@')[0]
  Invoke-Native "Create service identity $Email" $Gcloud @("iam", "service-accounts", "create", $accountId, "--project=$ProjectId", "--display-name=$DisplayName", "--quiet")
}

function Get-IamRoleMembers([object]$Policy, [string]$Role) {
  $bindings = if ($null -ne $Policy -and $Policy.PSObject.Properties.Name -contains "bindings") { @($Policy.bindings) } else { @() }
  return @($bindings |
    Where-Object { [string]$_.role -eq $Role } |
    ForEach-Object { @($_.members) } |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ } |
    Sort-Object -Unique)
}

function Get-CloudRunServiceUrls(
  [object]$ServiceState,
  [string]$ServiceName,
  [string]$ProjectNumber,
  [string]$RegionName
) {
  $urls = @()
  if ($ServiceName -and $ProjectNumber -and $RegionName) {
    $urls += "https://${ServiceName}-${ProjectNumber}.${RegionName}.run.app"
  }
  try {
    $annotations = $ServiceState.metadata.annotations
    if ($null -ne $annotations -and $annotations.PSObject.Properties.Name -contains "run.googleapis.com/urls") {
      $reported = [string]$annotations.'run.googleapis.com/urls'
      if ($reported) {
        try { $urls += @($reported | ConvertFrom-Json) } catch { }
      }
    }
  } catch { }
  try {
    if (-not [string]::IsNullOrWhiteSpace([string]$ServiceState.status.url)) { $urls += [string]$ServiceState.status.url }
  } catch { }
  return @($urls | ForEach-Object { ([string]$_).Trim().TrimEnd('/') } | Where-Object { $_ -match '^https://[^/]+\.run\.app$' } | Select-Object -Unique)
}

function Get-JwtPayload([string]$Token) {
  $parts = $Token.Split('.')
  if ($parts.Count -ne 3) { throw "Identity token is not a three-part JWT." }
  $payload = $parts[1].Replace('-', '+').Replace('_', '/')
  switch ($payload.Length % 4) {
    2 { $payload += '==' }
    3 { $payload += '=' }
    0 { }
    default { throw "Identity token payload has invalid base64url length." }
  }
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
    return ($json | ConvertFrom-Json)
  } catch {
    throw "Identity token payload could not be decoded for local claim verification."
  }
}

function Remove-ProjectLevelWorkerInvokerGrants([string]$Gcloud, [string]$ProjectNumber, [string]$BrokerSa) {
  Write-Step "Remove project-wide Cloud Run invocation grants that would bypass the dedicated worker policy"
  $policy = ((Invoke-Captured "Inspect project-level Cloud Run invocation policy" $Gcloud @("projects", "get-iam-policy", $ProjectId, "--format=json")).Text | ConvertFrom-Json)
  $invokerBindings = @($policy.bindings | Where-Object { [string]$_.role -eq "roles/run.invoker" })
  $conditional = @($invokerBindings | Where-Object { $null -ne $_.PSObject.Properties['condition'] -and $null -ne $_.condition })
  if ($conditional.Count) {
    throw "Project-level conditional roles/run.invoker bindings exist. REVEX will not guess how to remove a project-wide conditional grant; remove or scope it explicitly before publishing."
  }
  $members = @(Get-IamRoleMembers $policy "roles/run.invoker")
  $knownLegacyMembers = @(
    "serviceAccount:$ProjectNumber-compute@developer.gserviceaccount.com",
    "serviceAccount:$BrokerSa",
    "allUsers",
    "allAuthenticatedUsers"
  )
  $unknown = @($members | Where-Object { $_ -notin $knownLegacyMembers })
  if ($unknown.Count) {
    throw "Unexpected project-wide Cloud Run invoker grants would reach every Cloud Run service and cannot be removed safely by REVEX: $($unknown -join ', ')"
  }
  foreach ($member in $members) {
    Invoke-Native "Remove project-wide Cloud Run invoker $member" $Gcloud @(
      "projects", "remove-iam-policy-binding", $ProjectId,
      "--member=$member", "--role=roles/run.invoker", "--quiet"
    )
  }
  $verified = ((Invoke-Captured "Verify no project-wide Cloud Run invocation grants remain" $Gcloud @("projects", "get-iam-policy", $ProjectId, "--format=json")).Text | ConvertFrom-Json)
  $remaining = @(Get-IamRoleMembers $verified "roles/run.invoker")
  if ($remaining.Count) {
    throw "Project-wide Cloud Run invoker grants remain after cleanup: $($remaining -join ', ')"
  }
  Write-Log "Project-wide roles/run.invoker bindings are absent; the dedicated worker service policy can now be evaluated without project-level bypass grants." Green
}

function Grant-BrokerIdentityProbeAuthority(
  [string]$Gcloud,
  [string]$BrokerSa,
  [string]$DeployerMember
) {
  Write-Step "Prepare broker CLI-impersonation authority before GitHub/cloud deployment work"
  $policy = ((Invoke-Captured "Inspect broker token-creation policy before publication" $Gcloud @(
    "iam", "service-accounts", "get-iam-policy", $BrokerSa, "--project=$ProjectId", "--format=json"
  )).Text | ConvertFrom-Json)
  $members = @(Get-IamRoleMembers $policy $script:BrokerTokenCreatorRole)
  $script:BrokerTokenCreatorGcloud = $Gcloud
  $script:BrokerTokenCreatorSa = $BrokerSa
  $script:BrokerTokenCreatorMember = $DeployerMember
  if ($DeployerMember -notin $members) {
    Invoke-Native "Grant temporary publisher Service Account Token Creator for the later broker-identity smoke test" $Gcloud @(
      "iam", "service-accounts", "add-iam-policy-binding", $BrokerSa,
      "--project=$ProjectId", "--member=$DeployerMember",
      "--role=$script:BrokerTokenCreatorRole", "--quiet"
    )
    $script:BrokerTokenCreatorGrantActive = $true
    Write-Log "Temporary broker impersonation authority was granted before the GitHub/final deployment interval; propagation is not deferred to the smoke-test boundary." Green
  } else {
    $script:BrokerTokenCreatorGrantActive = $false
    Write-Log "Publisher already has Service Account Token Creator on the broker identity; no temporary IAM mutation was required." Green
  }
}

function Remove-BrokerIdentityProbeAuthority([switch]$BestEffort) {
  if (-not $script:BrokerTokenCreatorGrantActive) { return }
  $result = Invoke-Captured "Remove temporary publisher Service Account Token Creator from broker identity" $script:BrokerTokenCreatorGcloud @(
    "iam", "service-accounts", "remove-iam-policy-binding", $script:BrokerTokenCreatorSa,
    "--project=$ProjectId", "--member=$script:BrokerTokenCreatorMember",
    "--role=$script:BrokerTokenCreatorRole", "--quiet"
  ) -AllowFailure
  if ($result.ExitCode -eq 0) {
    $script:BrokerTokenCreatorGrantActive = $false
    Write-Log "Temporary broker impersonation authority removed." Green
    return
  }
  if ($BestEffort) {
    Write-Log "Temporary broker impersonation authority cleanup needs attention; original publication failure is preserved. Exit=$($result.ExitCode)." Yellow
    return
  }
  throw "Temporary broker impersonation authority could not be removed after the smoke test."
}

function Test-BrokerIdentityWorkerInvocation(
  [string]$Gcloud,
  [string]$BrokerSa,
  [string]$DeployerMember,
  [string[]]$WorkerUrls
) {
  Write-Step "Prove the deployed broker identity can invoke the private r49 worker"
  $saPolicy = ((Invoke-Captured "Verify broker CLI-impersonation role is present before token mint" $Gcloud @(
    "iam", "service-accounts", "get-iam-policy", $BrokerSa, "--project=$ProjectId", "--format=json"
  )).Text | ConvertFrom-Json)
  $tokenCreators = @(Get-IamRoleMembers $saPolicy $script:BrokerTokenCreatorRole)
  if ($DeployerMember -notin $tokenCreators) {
    throw "The publisher does not have Service Account Token Creator on the broker identity at the smoke-test boundary."
  }
  $candidates = @($WorkerUrls | Where-Object { $_ } | Select-Object -Unique)
  if ($candidates.Count -eq 0) { throw "Cloud Run did not report any usable run.app URL for authenticated broker verification." }
  $probeFailures = @()
  foreach ($candidateUrl in $candidates) {
    $identityToken = $null
    $lastSafeError = ""
    for ($attempt = 1; $attempt -le 3 -and -not $identityToken; $attempt++) {
      $tokenResult = Invoke-SecretCaptured "Mint broker identity token for $candidateUrl without logging credentials (attempt $attempt/3)" $Gcloud @(
        "auth", "print-identity-token",
        "--impersonate-service-account=$BrokerSa",
        "--audiences=$candidateUrl",
        "--include-email",
        "--quiet"
      ) -AllowFailure
      if ($tokenResult.ExitCode -eq 0) {
        $identityToken = [string]($tokenResult.Lines |
          Where-Object { [string]$_ -match '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' } |
          Select-Object -Last 1)
        if (-not $identityToken) { throw "gcloud reported token-mint success but returned no parseable JWT." }
        break
      }
      $safe = ([string]$tokenResult.Text -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','<REDACTED_ID_TOKEN>')
      $safe = [regex]::Replace($safe, 'ya29\.[A-Za-z0-9._-]+', '<REDACTED_ACCESS_TOKEN>')
      $safe = ($safe -replace '[\r\n]+',' ').Trim()
      if ($safe.Length -gt 700) { $safe = $safe.Substring(0,700) + '...' }
      $lastSafeError = $safe
      $isPropagationDenial = $safe -match '(?i)(PERMISSION_DENIED|permission.*iam\.serviceAccounts\.(getOpenIdToken|getAccessToken)|iam\.serviceAccounts\.(getOpenIdToken|getAccessToken)|403)'
      if (-not $isPropagationDenial) { throw "Broker identity-token mint failed for a non-propagation reason: $safe" }
      if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
    }
    if (-not $identityToken) {
      $probeFailures += "$candidateUrl token-mint=$lastSafeError"
      continue
    }
    try {
      $claims = Get-JwtPayload $identityToken
      if ([string]$claims.aud -ne $candidateUrl) { throw "Minted ID token audience does not equal the candidate Cloud Run URL." }
      if ($claims.PSObject.Properties.Name -contains 'email' -and [string]$claims.email -ne $BrokerSa) { throw "Minted ID token email claim does not equal the broker service account." }
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($candidateUrl + "/healthz") -Headers @{ Authorization = "Bearer $identityToken" } -TimeoutSec 25
        if ([int]$response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
        $health = $response.Content | ConvertFrom-Json
        if ($health.ok -ne $true -or [string]$health.version -ne $ReleaseTag -or [string]$health.service -ne "REVEX Energy Worker" -or [string]$health.sourceCandidate -ne $CanonicalSourceCommit) {
          throw "Worker health payload is not bound to immutable candidate $CanonicalSourceCommit."
        }
        Add-PreflightCheckpoint "BROKER_TO_PRIVATE_WORKER_SMOKE" ([ordered]@{
          authenticatedIdentity = $BrokerSa
          verifiedWorkerUrl = $candidateUrl
          candidateUrlsEvaluated = @($candidates)
          workerVersion = [string]$health.version
          sourceCandidate = [string]$health.sourceCandidate
          healthStatus = 200
          tokenAudienceVerified = $true
          tokenCreatorBindingPreparedBeforeGitHubGate = $true
        })
        Write-Log "Authenticated broker identity reached the exact private r49 worker at $candidateUrl." Green
        return $candidateUrl
      } catch {
        $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
        $message = ([string]$_.Exception.Message -replace '[\r\n]+',' ').Trim()
        if ($message.Length -gt 400) { $message = $message.Substring(0,400) + '...' }
        $probeFailures += "$candidateUrl http=$status message=$message"
      }
    } finally {
      $identityToken = $null
    }
  }
  throw "No Cloud Run-generated URL accepted a correctly-audienced broker ID token for /healthz. " + ($probeFailures -join ' | ')
}

function Verify-LiveCompanion {
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    Write-Log "Live r49 verification attempt $attempt/60 (three bounded requests)."
    try {
      $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $headers = @{ "Cache-Control" = "no-cache, no-store"; "Pragma" = "no-cache" }
      $index = Invoke-WebRequest -UseBasicParsing -Uri ($LiveUrl + "?r49_verify=" + $stamp) -TimeoutSec 20 -Headers $headers
      $base = $LiveUrl.Substring(0, $LiveUrl.LastIndexOf('/') + 1)
      $app = Invoke-WebRequest -UseBasicParsing -Uri ($base + "app.js?r49_verify=" + $stamp) -TimeoutSec 20 -Headers $headers
      $viewer = Invoke-WebRequest -UseBasicParsing -Uri ($base + "viewer-r26.js?r49_verify=" + $stamp) -TimeoutSec 20 -Headers $headers
      if ($index.StatusCode -eq 200 -and $index.Content.Contains($Build) -and $index.Content.Contains("Show hidden only") -and
          $app.Content.Contains("activationToken") -and $app.Content.Contains("revex:native-project-binding") -and
          $viewer.Content.Contains("REVEX_PAGED_MISSING_GEOMETRY_PROXY") -and $viewer.Content.Contains("clearEditGroups")) {
        Write-Log "Live Companion verified: $Build with project cancellation, progressive geometry, reversible visibility and fullscreen Design Book images." Green
        return
      }
    } catch { Write-Log ("Live verification pending: " + $_.Exception.Message) Yellow }
    if ($attempt -lt 60) { Start-Sleep -Seconds 10 }
  }
  throw "GitHub merged r49, but the complete Companion build was not visible within ten minutes. Rerun this idempotent publisher; the backend and source remain safe."
}

function Verify-LiveProjectAccessRules([string]$Gcloud) {
  Write-Step "Verify live owner/member/admin Firestore access and outsider denial"
  $releaseUri = "https://firebaserules.googleapis.com/v1/projects/$ProjectId/releases/cloud.firestore"
  $release = $null
  $ruleset = $null
  $rulesetName = ""
  $lastStatus = 0
  $lastMessage = ""

  for ($attempt = 1; $attempt -le 12; $attempt++) {
    $token = $null
    try {
      $tokenResult = Invoke-SecretCaptured "Acquire bounded Google access token without logging it" $Gcloud @("auth", "print-access-token", "--quiet")
      $token = [string]($tokenResult.Lines | Where-Object { [string]$_ -match '^[A-Za-z0-9._-]{20,}$' } | Select-Object -Last 1)
      $token = $token.Trim()
      if (-not $token) { throw "Google Cloud could not provide a bounded access token for the read-only live-rules check." }
      # Direct Google REST calls made with end-user gcloud credentials may require an explicit
      # consumer/quota project. Keep the bearer token in memory only and identify REVEX as the
      # user project without ever putting the token in a URL or deployment log.
      $headers = @{
        Authorization = "Bearer $([string]$token)"
        "x-goog-user-project" = $ProjectId
      }
      $release = Invoke-RestMethod -Method Get -Uri $releaseUri -Headers $headers -TimeoutSec 30
      $rulesetName = [string]$release.rulesetName
      if (-not $rulesetName.StartsWith("projects/$ProjectId/rulesets/")) { throw "The live Firestore release did not identify its active ruleset." }
      $ruleset = Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/" + $rulesetName) -Headers $headers -TimeoutSec 30
      break
    } catch {
      $lastStatus = try { [int]$_.Exception.Response.StatusCode } catch { 0 }

      # Preserve the Google API denial reason, but never credentials. Invoke-RestMethod normally
      # places the JSON error body in ErrorDetails.Message on Windows PowerShell; the stream path
      # is a bounded fallback for older hosts.
      $rawGoogleError = ""
      try {
        if ($null -ne $_.ErrorDetails -and -not [string]::IsNullOrWhiteSpace([string]$_.ErrorDetails.Message)) {
          $rawGoogleError = [string]$_.ErrorDetails.Message
        }
      } catch { }
      if (-not $rawGoogleError) {
        try {
          $stream = $_.Exception.Response.GetResponseStream()
          if ($null -ne $stream) {
            $reader = New-Object IO.StreamReader($stream)
            try { $rawGoogleError = $reader.ReadToEnd() } finally { $reader.Dispose(); $stream.Dispose() }
          }
        } catch { }
      }

      $googleStatus = ""
      $googleReason = ""
      $googleMessage = ""
      if ($rawGoogleError) {
        try {
          $googlePayload = $rawGoogleError | ConvertFrom-Json
          if ($null -ne $googlePayload.error) {
            $googleStatus = [string]$googlePayload.error.status
            $googleMessage = [string]$googlePayload.error.message
            $reasonValues = @($googlePayload.error.details | ForEach-Object {
              if ($null -ne $_.reason) { [string]$_.reason }
              elseif ($null -ne $_.metadata -and $null -ne $_.metadata.reason) { [string]$_.metadata.reason }
            } | Where-Object { $_ } | Sort-Object -Unique)
            if ($reasonValues.Count) { $googleReason = ($reasonValues -join ',') }
          }
        } catch { }
      }

      $lastMessage = if ($googleMessage) { $googleMessage } else { [string]$_.Exception.Message }
      $safeDetailParts = @()
      if ($googleStatus) { $safeDetailParts += "status=$googleStatus" }
      if ($googleReason) { $safeDetailParts += "reason=$googleReason" }
      if ($lastMessage) { $safeDetailParts += "message=$lastMessage" }
      $safeDetail = ($safeDetailParts -join '; ')
      if (-not $safeDetail) { $safeDetail = "message=$([string]$_.Exception.Message)" }
      $safeDetail = [regex]::Replace($safeDetail, 'ya29\.[A-Za-z0-9._-]+', '<REDACTED_ACCESS_TOKEN>')
      $safeDetail = [regex]::Replace($safeDetail, '1//[A-Za-z0-9._-]+', '<REDACTED_REFRESH_TOKEN>')
      $safeDetail = [regex]::Replace($safeDetail, '(?i)(Bearer\s+)[A-Za-z0-9._-]+', '$1<REDACTED>')
      if ($safeDetail.Length -gt 900) { $safeDetail = $safeDetail.Substring(0,900) + '...' }

      $transient = $lastStatus -in @(403,404,409,429,500,502,503,504)
      if (-not $transient -or $attempt -eq 12) {
        throw "Firebase Rules REST verification failed (HTTP $lastStatus): $safeDetail"
      }
      Write-Log "Firebase Rules read verification pending (HTTP $lastStatus, attempt $attempt/12): $safeDetail" Yellow
      Start-Sleep -Seconds 5
    } finally {
      $token = $null
    }
  }

  if ($null -eq $ruleset) {
    throw "Firebase Rules API did not become readable after bounded propagation retry (HTTP $lastStatus): $lastMessage"
  }
  $rulesFiles = @($ruleset.source.files)
  if ($rulesFiles.Count -ne 1) {
    throw "The active cloud.firestore release contains $($rulesFiles.Count) source files; REVEX requires one exact source file for deterministic behavioral verification."
  }
  $source = [string]$rulesFiles[0].content
  $beginCount = ([regex]::Matches($source, 'REVEX_PROJECT_ACCESS_R43_BEGIN')).Count
  $endCount = ([regex]::Matches($source, 'REVEX_PROJECT_ACCESS_R43_END')).Count
  $required = @(
    'function revexR43IsAdmin()',
    'request.auth.uid in data.memberIds',
    'allow read, write: if revexR43ProjectMember(projectId);',
    'allow read, write: if revexR43SpecMember(specProjectId);',
    'request.resource.data.memberIds == resource.data.memberIds'
  )
  $missing = @($required | Where-Object { -not $source.Contains($_) })
  if ($beginCount -ne 1 -or $endCount -ne 1 -or $missing.Count -gt 0) {
    throw "The active Firestore rules do not preserve the verified owner/member/admin project boundary. Missing: $($missing -join ', ')"
  }
  $exactRulesPath = Join-Path $StageRules "firestore.rules"
  [IO.File]::WriteAllText($exactRulesPath, $source, [Text.UTF8Encoding]::new($false))
  $previousNodePath = $env:NODE_PATH
  try {
    $env:NODE_PATH = Join-Path $StageRules "node_modules"
    Invoke-Native "Behaviorally test the exact active Firestore ruleset" $Firebase @(
      "emulators:exec", "--only", "firestore", "--project", "demo-revex-r49",
      "node verify-revex-r49-live-rules.js"
    ) -WorkingDirectory $StageRules
  } finally {
    $env:NODE_PATH = $previousNodePath
  }
  $rulesSha256 = (Get-FileHash -LiteralPath $exactRulesPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Log "Exact live Firestore rules passed owner/member/admin CRUD, list/filter, project-library, Design Book, Spec Book, interaction, outsider, anonymous, cross-project and ACL-escalation behavior tests." Green
  Add-PreflightCheckpoint "LIVE_PROJECT_ACCESS_RULES" ([ordered]@{
    ruleset = $rulesetName
    exactRulesSha256 = $rulesSha256
    behavioralEmulator = $true
    ownerFunctionalAccess = $true
    ordinaryProjectMemberFunctionalAccess = $true
    liberAdminFunctionalAccess = $true
    outsiderDenied = $true
    crossProjectDenied = $true
    ordinaryMemberAclEscalationDenied = $true
  })
}

function Resolve-ReleaseModel([string]$Requested) {
  if (-not [string]::IsNullOrWhiteSpace($Requested)) {
    $resolved = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Requested.Trim().Trim('"')))
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "The requested real Revit acceptance model does not exist: $resolved" }
    return $resolved
  }
  $projectsRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $Root))
  $preferred = Join-Path $projectsRoot "79 Winthrop Street\00_model\79 Winthrop St-collab.rvt"
  if (Test-Path -LiteralPath $preferred -PathType Leaf) { return (Resolve-Path -LiteralPath $preferred).Path }
  $matches = @(Get-ChildItem -LiteralPath $projectsRoot -File -Filter "79 Winthrop St-collab.rvt" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -match '[\\/]00_model$' } |
    Sort-Object FullName -Unique)
  if ($matches.Count -ne 1) {
    throw "The publisher requires exactly one current 79 Winthrop St-collab.rvt under $projectsRoot (found $($matches.Count)). Set REVEX_R49_QA_MODEL or pass -ReleaseModelPath only if the canonical project path changed."
  }
  return $matches[0].FullName
}

function Resolve-ReleaseWeather([string]$ModelPath) {
  $projectRoot = Split-Path -Parent (Split-Path -Parent $ModelPath)
  $expectedName = "USA_NY_New.York-LaGuardia.AP.725030_TMY3.epw"
  $expectedSha256 = "a0df876fb704818312b6d32b50ee8fe2c0ae14f445c0ce8800d89fe698598162"
  $local = @(Get-ChildItem -LiteralPath $projectRoot -File -Filter $expectedName -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName -Unique)
  $duplicatePaths = @()
  $rejectedWeatherCopies = @()
  if ($local.Count -ge 1) {
    $validCopies = @()
    foreach ($candidate in $local) {
      $candidateHash = (Get-FileHash -LiteralPath $candidate.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $candidateHeader = [IO.File]::ReadLines($candidate.FullName) | Select-Object -First 1
      if ($candidateHash -eq $expectedSha256 -and
          $candidateHeader -match '^LOCATION,New York Laguardia Arpt,NY,USA,TMY3,725030,') {
        $validCopies += $candidate
      } else {
        $rejectedWeatherCopies += "$($candidate.FullName) [$candidateHash]"
      }
    }
    if ($validCopies.Count -eq 0) {
      throw "No local LaGuardia EPW copy matched the pinned EnergyPlus weather evidence:`n$($rejectedWeatherCopies -join "`n")"
    }
    $preferred = Join-Path (Join-Path $projectRoot "ENERGY") $expectedName
    $preferredIsVerified = @($validCopies | Where-Object { $_.FullName -ieq $preferred }).Count -eq 1
    $path = if ($preferredIsVerified) {
      (Resolve-Path -LiteralPath $preferred).Path
    } else {
      $validCopies[0].FullName
    }
    $duplicatePaths = @($validCopies | Where-Object { $_.FullName -ine $path } | ForEach-Object { $_.FullName })
    if ($duplicatePaths.Count -gt 0) {
      Write-Log "Verified $($validCopies.Count) byte-identical canonical LaGuardia EPW copies; selected $path deterministically." Yellow
    }
    if ($rejectedWeatherCopies.Count -gt 0) {
      Write-Log "Ignored $($rejectedWeatherCopies.Count) noncanonical same-name EPW copies after pinned SHA/header rejection." Yellow
    }
  }
  else {
    $weatherFolder = Join-Path $StageRoot "weather"
    New-Item -ItemType Directory -Path $weatherFolder -Force | Out-Null
    $path = Join-Path $weatherFolder $expectedName
    $uri = "https://energyplus-weather.s3.amazonaws.com/north_and_central_america_wmo_region_4/USA/NY/USA_NY_New.York-LaGuardia.AP.725030_TMY3/USA_NY_New.York-LaGuardia.AP.725030_TMY3.epw"
    Write-Step "Download the official EnergyPlus LaGuardia TMY3 weather evidence"
    Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $path -TimeoutSec 180
  }
  $actualSha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) { throw "LaGuardia TMY3 EPW integrity mismatch: $actualSha256" }
  $header = [IO.File]::ReadLines($path) | Select-Object -First 1
  if ($header -notmatch '^LOCATION,New York Laguardia Arpt,NY,USA,TMY3,725030,') { throw "LaGuardia TMY3 EPW has an unexpected LOCATION header." }
  Add-PreflightCheckpoint "RELEASE_WEATHER_EVIDENCE" ([ordered]@{
    path = $path
    sha256 = $actualSha256
    station = "New York Laguardia Arpt"
    wmo = "725030"
    verifiedEquivalentCopies = 1 + $duplicatePaths.Count
    duplicateCopiesIgnoredAfterIntegrityVerification = @($duplicatePaths)
    noncanonicalCopiesRejected = @($rejectedWeatherCopies)
  })
  return $path
}

function Test-ReusableRealRevitEvidence([object]$Result, [string]$ModelPath, [string]$WeatherPath) {
  try {
    if ($null -eq $Result -or [string]$Result.status -ne "PASSED") { return $false }
    if (-not ([string]$Result.modelPath).Equals($ModelPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ([int64]$Result.modelBytes -ne (Get-Item -LiteralPath $ModelPath).Length) { return $false }

    $rootFolder = [string]$Result.engineering.rootFolder
    $manifestPath = [string]$Result.engineering.manifestPath
    if (-not (Test-Path -LiteralPath $rootFolder -PathType Container) -or
        -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$manifest.schema -ne "liber.revex.engineering-sync.v1" -or
        [string]$manifest.gbxmlStatus -ne "EXPORTED") { return $false }
    if (-not ([string]$manifest.sourceModel.path).Equals($ModelPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }

    $weatherHash = (Get-FileHash -LiteralPath $WeatherPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$manifest.weather.sha256 -ne $weatherHash) { return $false }

    $integrityThreshold = [double]$manifest.publicationIntegrity.threshold
    $lowestRatio = [double]$manifest.publicationIntegrity.lowestRatio
    if ($lowestRatio -lt $integrityThreshold) { return $false }

    foreach ($artifact in @($manifest.artifacts)) {
      $artifactPath = Join-Path $rootFolder ([string]$artifact.name)
      if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) { return $false }
      if ([int64]$artifact.bytes -ne (Get-Item -LiteralPath $artifactPath).Length) { return $false }
      $actual = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne [string]$artifact.sha256) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

function Try-ReuseRealRevitEvidenceGate([string]$ModelPath, [string]$WeatherPath) {
  if ([string]$env:REVEX_R49_FORCE_FRESH_REVIT_EVIDENCE -match '^(?i:1|true|yes)$') {
    Write-Log "Fresh Revit evidence was explicitly requested; prior verified artifacts will not be reused." Yellow
    return $null
  }

  $currentModelHash = (Get-FileHash -LiteralPath $ModelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $runsRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX-R49-Publish"
  if (-not (Test-Path -LiteralPath $runsRoot -PathType Container)) { return $null }

  $candidates = @(Get-ChildItem -LiteralPath $runsRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $StageRoot } |
    Sort-Object LastWriteTimeUtc -Descending)

  foreach ($candidate in $candidates) {
    $priorPreflightPath = Join-Path $candidate.FullName "REVEX-R49-PREFLIGHT.json"
    $priorResultPath = Join-Path $candidate.FullName "real-revit-evidence\REVEX-RELEASE-EVIDENCE-RESULT.json"
    if (-not (Test-Path -LiteralPath $priorPreflightPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $priorResultPath -PathType Leaf)) { continue }
    try {
      $priorPreflight = Get-Content -LiteralPath $priorPreflightPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $matches = @($priorPreflight.checkpoints | Where-Object { [string]$_.name -eq "REAL_REVIT_BIM_SPEC_ENERGY_EVIDENCE" })
      if ($matches.Count -eq 0) { continue }
      $checkpoint = $matches[-1]
      if ([string]$checkpoint.detail.modelSha256 -ne $currentModelHash) { continue }
      $producerProperty = $checkpoint.detail.PSObject.Properties["producerGbxmlBundleSha256"]
      if ($null -eq $producerProperty -or [string]$producerProperty.Value -ne $GbxmlEvidenceProducerSha256) {
        continue
      }

      $result = Get-Content -LiteralPath $priorResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not (Test-ReusableRealRevitEvidence $result $ModelPath $WeatherPath)) { continue }

      Add-PreflightCheckpoint "REAL_REVIT_BIM_SPEC_ENERGY_EVIDENCE_REUSED" ([ordered]@{
        sourceRun = $candidate.Name
        model = $ModelPath
        modelSha256 = $currentModelHash
        engineeringRevision = [string]$result.engineering.revision
        engineeringManifest = [string]$result.engineering.manifestPath
        artifactCount = @((Get-Content -LiteralPath ([string]$result.engineering.manifestPath) -Raw -Encoding UTF8 | ConvertFrom-Json).artifacts).Count
        sourceRvtUnchanged = $true
        fullArtifactSha256Verification = $true
        producerGbxmlBundleSha256 = $GbxmlEvidenceProducerSha256
        userInteractionAfterLaunch = $false
      })
      Write-Log "Reused hash-verified real-Revit evidence from prior run $($candidate.Name); Revit extraction was skipped." Green
      return $result
    } catch {
      continue
    }
  }
  return $null
}

function Invoke-RealRevitEvidenceGate([string]$ModelPath, [string]$WeatherPath) {
  Write-Step "Run staged REVEX against the real 79 Revit artifact without user interaction"
  New-Item -ItemType Directory -Path $ReleaseEvidenceRoot -Force | Out-Null
  $beforeHash = (Get-FileHash -LiteralPath $ModelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $qaManifestBackup = Join-Path $StageRoot "LIBER.REVEX.production.addin.before-real-qa"
  $hadManifest = Test-Path -LiteralPath $AddinPath -PathType Leaf
  $oldEnvironment = @{}
  foreach ($name in @(
    "REVEX_DATA_ROOT", "REVEX_RELEASE_EVIDENCE_OUTPUT", "REVEX_RELEASE_EVIDENCE_RESULT",
    "REVEX_RELEASE_EPW", "REVEX_RELEASE_EXPECTED_PROJECT", "REVEX_RELEASE_EVIDENCE_PROJECT_ID"
  )) { $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
  try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $AddinPath) -Force | Out-Null
    if ($hadManifest) { Move-Item -LiteralPath $AddinPath -Destination $qaManifestBackup -Force }
    $qaAssembly = Join-Path $StagePayload "Liber.Revex.Revit.dll"
    $qaManifest = @"
<?xml version="1.0" encoding="utf-8" standalone="no"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>LIBER REVEX r49 staged acceptance</Name>
    <Assembly>$qaAssembly</Assembly>
    <AddInId>DECFCABB-63FD-4E1B-9A98-2B646874D487</AddInId>
    <FullClassName>Liber.Revex.Revit.App</FullClassName>
    <VendorId>LIBR</VendorId>
    <VendorDescription>LIBER Creative LLC</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
    [IO.File]::WriteAllText($AddinPath, $qaManifest, [Text.UTF8Encoding]::new($false))
    $env:REVEX_DATA_ROOT = Join-Path $ReleaseEvidenceRoot "data"
    $env:REVEX_RELEASE_EVIDENCE_OUTPUT = $ReleaseEvidenceRoot
    $env:REVEX_RELEASE_EVIDENCE_RESULT = $ReleaseEvidenceResult
    $env:REVEX_RELEASE_EPW = $WeatherPath
    $env:REVEX_RELEASE_EXPECTED_PROJECT = "79 Winthrop"
    $env:REVEX_RELEASE_EVIDENCE_PROJECT_ID = "revex-r49-79-winthrop-release-evidence"
    $quotedModel = '"' + $ModelPath + '"'
    $process = Start-Process -FilePath $RevitExe -ArgumentList @("/nosplash", "/language", "ENU", $quotedModel) -PassThru
    if (-not $process.WaitForExit(5400000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "Real Revit evidence extraction exceeded 90 minutes and the isolated Revit QA process was stopped."
    }
    if (-not (Test-Path -LiteralPath $ReleaseEvidenceResult -PathType Leaf)) {
      throw "The staged Revit host exited without producing its real-project evidence result."
    }
    $result = Get-Content -LiteralPath $ReleaseEvidenceResult -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$result.status -ne "PASSED") {
      foreach ($propertyName in @("diagnosticLog", "diagnosticJsonl")) {
        $property = $result.PSObject.Properties[$propertyName]
        if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) { continue }
        $diagnosticPath = [string]$property.Value
        if (-not (Test-Path -LiteralPath $diagnosticPath -PathType Leaf)) { continue }
        Write-Log "----- REAL REVIT $($propertyName.ToUpperInvariant()) TAIL -----" DarkYellow
        Get-Content -LiteralPath $diagnosticPath -Encoding UTF8 -Tail 240 | ForEach-Object { Write-Log ([string]$_) DarkYellow }
      }
      throw "Real Revit BIM/Spec/Energy evidence gate failed: $([string]$result.error)"
    }
  } finally {
    foreach ($name in $oldEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], "Process")
    }
    Remove-Item -LiteralPath $AddinPath -Force -ErrorAction SilentlyContinue
    if ($hadManifest -and (Test-Path -LiteralPath $qaManifestBackup -PathType Leaf)) {
      Move-Item -LiteralPath $qaManifestBackup -Destination $AddinPath -Force
    }
  }
  $afterHash = (Get-FileHash -LiteralPath $ModelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($afterHash -ne $beforeHash) { throw "The real 79 source RVT changed during publication QA; publication is blocked." }
  Add-PreflightCheckpoint "REAL_REVIT_BIM_SPEC_ENERGY_EVIDENCE" ([ordered]@{
    model = $ModelPath
    modelSha256 = $beforeHash
    sourceRvtUnchanged = $true
    identityDigest = [string]$result.identity.digest
    identityDisplayName = [string]$result.identity.displayName
    identitySheets = @($result.identity.sheets)
    bimRevision = [string]$result.bim.revision
    scheduleCount = [int]$result.bim.scheduleCount
    elementCount = [int]$result.bim.elementCount
    printingSheetCount = [int]$result.bim.printingSheetCount
    engineeringRevision = [string]$result.engineering.revision
    engineeringManifest = [string]$result.engineering.manifestPath
    producerGbxmlBundleSha256 = $GbxmlEvidenceProducerSha256
    userInteractionAfterLaunch = $false
  })
  return $result
}

function Try-ReuseRealEnergyAcceptanceGate(
  [object]$RevitEvidence,
  [string]$ReviewPackage
) {
  if ([string]$env:REVEX_R49_FORCE_FRESH_ENERGY_ACCEPTANCE -match '^(?i:1|true|yes)$') {
    Write-Log "Fresh real-project Energy acceptance was explicitly requested; prior immutable acceptance will not be reused." Yellow
    return $null
  }
  $engineeringRevision = [string]$RevitEvidence.engineering.revision
  if (-not $engineeringRevision) { return $null }
  $runsRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX-R49-Publish"
  if (-not (Test-Path -LiteralPath $runsRoot -PathType Container)) { return $null }
  $candidates = @(Get-ChildItem -LiteralPath $runsRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $StageRoot } |
    Sort-Object LastWriteTimeUtc -Descending)
  foreach ($candidate in $candidates) {
    $priorPreflightPath = Join-Path $candidate.FullName "REVEX-R49-PREFLIGHT.json"
    $priorAcceptancePath = Join-Path $candidate.FullName "REVEX-R49-REAL-PROJECT-ACCEPTANCE.json"
    if (-not (Test-Path -LiteralPath $priorPreflightPath -PathType Leaf) -or -not (Test-Path -LiteralPath $priorAcceptancePath -PathType Leaf)) { continue }
    try {
      $priorPreflight = Get-Content -LiteralPath $priorPreflightPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ([string]$priorPreflight.status -ne "PASSED") { continue }
      $canonical = @($priorPreflight.checkpoints | Where-Object { [string]$_.name -eq "CANONICAL_SOURCE_RESTORE" } | Select-Object -Last 1)
      if ($canonical.Count -ne 1 -or [string]$canonical[0].detail.canonicalCommit -ne $CanonicalSourceCommit) { continue }
      $priorGate = @($priorPreflight.checkpoints | Where-Object { [string]$_.name -eq "REAL_79_ENERGY_ACCEPTANCE" } | Select-Object -Last 1)
      if ($priorGate.Count -ne 1) { continue }
      if ([string]$priorGate[0].detail.sourceEngineeringRevision -ne $engineeringRevision -or
          $priorGate[0].detail.reviewEligible -ne $true -or
          $priorGate[0].detail.officialComcheck -ne $true -or
          [string]$priorGate[0].detail.comparisonDisposition -notin @("BENCHMARKED_BEST_WORKING_ITERATION","UNBENCHMARKED_DIFFERENT_COHORT")) { continue }
      $acceptance = Get-Content -LiteralPath $priorAcceptancePath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ([string]$acceptance.status -ne "PASSED" -or [string]$acceptance.sourceEngineeringRevision -ne $engineeringRevision -or
          $acceptance.officialComcheck -ne $true -or $acceptance.approvedRunComparison.reviewEligible -ne $true -or
          [string]$acceptance.comparisonDisposition -notin @("BENCHMARKED_BEST_WORKING_ITERATION","UNBENCHMARKED_DIFFERENT_COHORT")) { continue }
      $priorPackage = [string]$acceptance.manualReviewPackage.path
      if (-not $priorPackage -or -not (Test-Path -LiteralPath $priorPackage -PathType Leaf)) { continue }
      $expectedBytes = [int64]$acceptance.manualReviewPackage.bytes
      $expectedSha = ([string]$acceptance.manualReviewPackage.sha256).ToLowerInvariant()
      if ($expectedBytes -le 0 -or $expectedSha -notmatch '^[a-f0-9]{64}$' -or
          [int64]$acceptance.manualReviewPackage.topLevelFiles -ne 7 -or [int64]$acceptance.manualReviewPackage.topLevelArchives -ne 1) { continue }
      if ((Get-Item -LiteralPath $priorPackage).Length -ne $expectedBytes) { continue }
      $actualSha = (Get-FileHash -LiteralPath $priorPackage -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualSha -ne $expectedSha) { continue }
      New-Item -ItemType Directory -Path (Split-Path -Parent $ReviewPackage) -Force | Out-Null
      Copy-Item -LiteralPath $priorPackage -Destination $ReviewPackage -Force
      if ((Get-Item -LiteralPath $ReviewPackage).Length -ne $expectedBytes -or (Get-FileHash -LiteralPath $ReviewPackage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedSha) {
        Remove-Item -LiteralPath $ReviewPackage -Force -ErrorAction SilentlyContinue
        continue
      }
      Copy-Item -LiteralPath $priorAcceptancePath -Destination $ReleaseAcceptancePath -Force
      Add-PreflightCheckpoint "REAL_79_ENERGY_ACCEPTANCE_REUSED" ([ordered]@{
        sourceRun = $candidate.Name
        sourceEngineeringRevision = $engineeringRevision
        sourceCandidate = $CanonicalSourceCommit
        acceptanceRecord = $priorAcceptancePath
        reviewPackage = $ReviewPackage
        reviewPackageBytes = $expectedBytes
        reviewPackageSha256 = $expectedSha
        officialComcheck = $true
        reviewEligible = $true
        comparisonDisposition = [string]$acceptance.comparisonDisposition
        exactImmutableReuse = $true
      })
      Write-Log "Reused exact hash-verified real 79 Energy acceptance from prior run $($candidate.Name); no Energy/GeometryCo/EnergyPlus/COMcheck recomputation was required for this downstream-only deployment retry." Green
      return $acceptance
    } catch {
      continue
    }
  }
  return $null
}

function Invoke-RealEnergyAcceptanceGate(
  [string]$VenvPython,
  [string]$Gcloud,
  [object]$RevitEvidence,
  [string]$ReviewPackage
) {
  $token = Invoke-SecretCaptured "Mint a short-lived Vertex token for immutable T/Z/EN page scan" $Gcloud @("auth", "print-access-token")
  if ($token.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($token.Text)) {
    throw "The real-project page scan could not obtain a short-lived Google Cloud access token."
  }
  $priorToken = $env:REVEX_VERTEX_ACCESS_TOKEN
  $priorProject = $env:REVEX_VERTEX_PROJECT
  $priorLocation = $env:REVEX_VERTEX_LOCATION
  try {
    $env:REVEX_VERTEX_ACCESS_TOKEN = $token.Text.Trim()
    $env:REVEX_VERTEX_PROJECT = $ProjectId
    $env:REVEX_VERTEX_LOCATION = "global"
    try {
      Invoke-Native "Run real 79 T/Z/EN scan, GeometryCo, two EnergyPlus runs, official COMcheck, EN-1 and eight-item package" $VenvPython @(
        (Join-Path $StageSource "server\revex-energy-worker\run_revex_r49_release_acceptance.py"),
        "--engineering-root", [string]$RevitEvidence.engineering.rootFolder,
        "--output-folder", $ReleaseEnergyRoot,
        "--review-package", $ReviewPackage,
        "--project-id", "revex-r49-79-winthrop-release-evidence",
        "--pipeline", (Join-Path $StageSource "src\Liber.Revex.Revit\Engineering\Energy\revex_energy_pipeline.py")
      ) -WorkingDirectory (Join-Path $StageSource "server\revex-energy-worker")
    } catch {
      $energyFailure = $_
      if (Test-Path -LiteralPath $ReleaseEnergyRoot -PathType Container) {
        $diagnosticZip = Join-Path $Root "REVEX_R49_ENERGY_QA_FAILED_$RunId.zip"
        $diagnosticTemporary = Join-Path $Root "REVEX_R49_ENERGY_QA_FAILED_$RunId.partial.zip"
        try {
          Compress-Archive -LiteralPath $ReleaseEnergyRoot -DestinationPath $diagnosticTemporary -CompressionLevel Optimal -Force
          Move-Item -LiteralPath $diagnosticTemporary -Destination $diagnosticZip -Force
          Write-Log "Publisher-only Energy diagnostics preserved: $diagnosticZip" Yellow
        } catch {
          Remove-Item -LiteralPath $diagnosticTemporary -Force -ErrorAction SilentlyContinue
          Write-Log "Could not package publisher-only Energy diagnostics: $($_.Exception.Message)" Yellow
        }
      }
      throw $energyFailure
    }
  } finally {
    $env:REVEX_VERTEX_ACCESS_TOKEN = $priorToken
    $env:REVEX_VERTEX_PROJECT = $priorProject
    $env:REVEX_VERTEX_LOCATION = $priorLocation
    $token = $null
  }
  if (-not (Test-Path -LiteralPath $ReleaseAcceptancePath -PathType Leaf)) {
    throw "The real-project acceptance run did not write its final acceptance record."
  }
  $acceptance = Get-Content -LiteralPath $ReleaseAcceptancePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $comparisonDisposition = [string]$acceptance.comparisonDisposition
  $allowedComparisonDispositions = @(
    "BENCHMARKED_BEST_WORKING_ITERATION",
    "UNBENCHMARKED_DIFFERENT_COHORT"
  )
  if ([string]$acceptance.status -ne "PASSED" -or
      $comparisonDisposition -notin $allowedComparisonDispositions -or
      $acceptance.approvedRunComparison.reviewEligible -ne $true -or
      -not (Test-Path -LiteralPath $ReviewPackage -PathType Leaf)) {
    throw "The real-project Energy run did not produce a review-eligible eight-item package with a valid masked comparison disposition."
  }
  $normalizedRegressionScore = $null
  if ($acceptance.approvedRunComparison.PSObject.Properties.Name -contains "normalizedRegressionScore") {
    $normalizedRegressionScore = $acceptance.approvedRunComparison.normalizedRegressionScore
  }
  Add-PreflightCheckpoint "REAL_79_ENERGY_ACCEPTANCE" ([ordered]@{
    sourceEngineeringRevision = [string]$acceptance.sourceEngineeringRevision
    approvedRunComparison = [string]$acceptance.approvedRunComparison.status
    iterationSelection = [string]$acceptance.approvedRunComparison.iterationSelection
    comparisonDisposition = $comparisonDisposition
    cohortMatches = $acceptance.approvedRunComparison.cohortMatches
    reviewEligible = [bool]$acceptance.approvedRunComparison.reviewEligible
    normalizedRegressionScore = $normalizedRegressionScore
    officialComcheck = [bool]$acceptance.officialComcheck
    reviewPackage = $ReviewPackage
    reviewPackageBytes = (Get-Item -LiteralPath $ReviewPackage).Length
    reviewPackageSha256 = (Get-FileHash -LiteralPath $ReviewPackage -Algorithm SHA256).Hash.ToLowerInvariant()
    userVisibleItems = 8
    referenceIdentity = "MASKED"
  })
  return $acceptance
}

try {
  Save-PreflightReport
  Write-Log "REVEX 0.8.19 r49 production publisher" White
  Write-Log "Publisher orchestration: $PublisherOrchestration" Green
  Write-Log "Authority: active Revit document -> evidence-verified project -> immutable BIM/Spec/Energy revisions"
  Write-Log "Energy: T/Z identity + EN facts -> GeometryCo -> two OSMs -> two EnergyPlus runs -> official clean-project COMcheck -> EN-1"
  Write-Log "Preservation: last-known-working Energy candidate is authoritative; downstream fixes do not rewrite passed upstream stages."
  Write-Log "Project: $ProjectId  Region: $Region  Repository: $GitHubRepository"
  Write-Log "Log: $LogPath"

  Write-Step "Verify Revit is closed for the final atomic add-in replacement"
  if (Get-Process -Name Revit -ErrorAction SilentlyContinue) { throw "Close every Revit window, then rerun PUBLISH_REVEX_R49.cmd. This is the only required manual preparation." }
  if (-not (Test-Path -LiteralPath (Join-Path $RevitDir "RevitAPI.dll") -PathType Leaf)) { throw "Autodesk Revit 2026 was not found at $RevitDir." }
  if (-not (Test-Path -LiteralPath $RevitExe -PathType Leaf)) { throw "Autodesk Revit 2026 executable was not found at $RevitExe." }
  $requestedReleaseModel = if (-not [string]::IsNullOrWhiteSpace($ReleaseModelPath)) { $ReleaseModelPath } else { [string]$env:REVEX_R49_QA_MODEL }
  $ReleaseModel = Resolve-ReleaseModel $requestedReleaseModel
  $ReleaseProjectRoot = Split-Path -Parent (Split-Path -Parent $ReleaseModel)
  $ReleaseReviewPackage = Join-Path (Join-Path $ReleaseProjectRoot "ENERGY") "REVEX_79_WINTHROP_R49_ENERGY_REVIEW_$RunId.zip"
  Write-Log "Real Revit acceptance model: $ReleaseModel" Green
  Write-Log "Eligible review package target: $ReleaseReviewPackage"

  Write-Step "Verify and self-repair the hash-locked r49 source"
  $Expected = [ordered]@{
    ".github\workflows\revex-r27-0819-engineering-release.yml" = "9c6303fc2752271d01c9e70a040f259652c7bba06c4bf0c4942e4823d4732663"
    ".github\scripts\verify-revex-r49-live-comcheck.py" = "2dcc8fbca40dfc33ffbd14699a2209a8cdcc27773549f5aa63738467de076191"
    ".github\scripts\verify-revex-r49.js" = "ed44a35b2271f82c3fa9038eb3fb9516fc6a4069f5fbf68ea8480689595349ac"
    ".github\scripts\verify-revex-r49-live-rules.js" = "8e4bf1e40eb44256dad8969849a0ac3bd91c74895492e648c07ea696503b93ae"
    ".github\scripts\patch-live-firestore-rules.js" = "8662ad8bb3a9c1090d25421538161245e534306f894839113a50a7f5ab803d2d"
    ".github\scripts\fixtures\live-firestore-base.rules" = "ba4ee3c8757dd6e745809214b2b6008e430d54dcdc585900124a38d7db6acf01"
    "src\Liber.Revex.Revit\Liber.Revex.Revit.csproj" = "4cca18fe25c936d7bbde564549a7765baeacfede08835fc76a033d2f812dabfa"
    "src\Liber.Revex.Revit\App.cs" = "1cf1886b1866fdcac3557730ca6e369f128a45397adc63ca5d3649040f3eacfd"
    "src\Liber.Revex.Revit\Models\RevitRequest.cs" = "54173d73c948d29a1c77360f696d3f27212a43bd4fc584e7f6f9ff8d81f8d359"
    "src\Liber.Revex.Revit\Models\RevexSyncModels.cs" = "5699e3d81f1dfb98be9b2d18c620867281e7a47043a99ceb0520ff2cd396ff3b"
    "src\Liber.Revex.Revit\Revit\RevitRequestHandler.cs" = "068dd2a78799ce4e2da2c94d399ca2131ec79563298c82def2362ab26945f932"
    "src\Liber.Revex.Revit\UI\RendairWindow.cs" = "03ad436ab81540e59625caad89e1774251d08ff58700c29be553cfffb7a1911f"
    "src\Liber.Revex.Revit\UI\RendairWindowManager.cs" = "e2b21d9c49b599bd3214299e3d472bee2cc39464ee708d6641afb074cc26b14e"
    "src\Liber.Revex.Revit\Services\SettingsService.cs" = "bec8072046e9a7f1bb09b79db5d7ac5f87cae30edbc75bc47fcff3311ec3311f"
    "src\Liber.Revex.Revit\Services\AppPaths.cs" = "db21564c4216fedc0a13b8ca483b9692f4f2aa9062c2c61a7aec8a57cabb7860"
    "src\Liber.Revex.Revit\Services\ReleaseEvidenceAutomation.cs" = "fa21a9d3903427701f4a06a7cdae7016814e8a5e9e403fba67574423a866225c"
    "src\Liber.Revex.Revit\Services\ProjectIdentityEvidenceService.cs" = "6cef37b8ee6be7d3a9a9b6df08bbb7cae814fa8cc28316ce64a9d23048cb704a"
    "src\Liber.Revex.Revit\Services\RevexSyncService.cs" = "3f8fe253aa2bce8655176fbe96cd14e571f6aaa4ef78ff5d50780b6247e9e45d"
    "src\Liber.Revex.Revit\Services\RevexMeshExportService.cs" = "515012d3de29fda9317f67311eb0131808bf5594a71c5d6ae0be0a7fc76f7adf"
    "src\Liber.Revex.Revit\Services\ViewerExportService.cs" = "d34fa2bc5de2ce32678cf9bea662341a5fa012866b161a58f122e2b840ca02fb"
    "src\Liber.Revex.Revit\Services\DesignBookScheduleService.cs" = "c9f0c97b1f91131a61119f7dc88199408e8c5ab1ab92397d9845448d6680b6bb"
    "src\Liber.Revex.Revit\Services\EngineeringSyncService.cs" = "e515c497057b3f653027bf4c8763bbe17143320c95163b82221f0948b58932d8"
    "src\Liber.Revex.Revit\Services\GbxmlEngineeringService.cs" = "111c05b2f490fc3d2fbb5715940e6412f3707180be3c2fa69fb7c99c2ec5ca80"
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py" = "3655e8fe0e3d8eb95cd1ea4c41284cda3d9f1f4a86d66c32e7adc4925c73f760"
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn" = "bf167fa2242434376d163c7ed1dd2c29e61e0489cac4b220e6370bc8ee89e908"
    "src\Liber.Revex.Revit\Services\EngineeringCompanionWebBridge.cs" = "f763c77c0b514a9d404e2f98cefccd323deb98c73edc248dd741d5d133449184"
    "src\Liber.Revex.Revit\Engineering\Companion\native-managed-energy-bridge.js" = "82d6442254f468533532d88eedd63112f30a2fc1e407b47e1f86ac1b9ba726d2"
    "src\Liber.Revex.Revit\Engineering\Energy\revex_energy_pipeline.py" = "c8c8594769bca2b39649c970e904b407faa9629f6120abfc2f7ae887bf3fd58f"
    "src\Liber.Revex.Revit\Engineering\Energy\comcheck_backstop.py" = "c29433a0da6ebbcd6af599f3f461120f096b7ce5b4248c6a421f19373ffe2df2"
    "src\Liber.Revex.Revit\Engineering\Energy\verify_revex_r49_energy.py" = "9b14e2704bd45226b8e0d8fc174dd4018228548f98871f36734c1549bd473eb7"
    "src\Liber.Revex.Revit\Engineering\Energy\requirements.txt" = "598d9b57a4c9bcfdce8266c1241331ee7acea61eb33ce162c6b91546603ff20a"
    "src\Liber.Revex.Revit\Engineering\Energy\GeometryCo\requirements.txt" = "1318bd4139433c6815ed35dc78321cf3000fbeb203e1de0621f22dc49342f659"
    "src\Liber.Revex.Revit\Engineering\Energy\GeometryCo\OpenStudio_Energy_Model_Geometry_Compiler.py" = "1fbd45afcfbc6120f56f8f4eb8947385de0c4d4b159f2bbfb70dbf8e067da85f"
    "src\Liber.Revex.Revit\Engineering\Energy\Packager\EnergyPlusReviewPackager.py" = "30ba0b2f3e1fee952382d016c68caa5dea85d7d68b439296797da5adf7f412f2"
    "src\Liber.Revex.Revit\Engineering\Energy\gbxml_to_osm.rb" = "eac568e149244dc46dfede1ecaee47b7b006cf6c6412db28822c355904a9fa77"
    "src\Liber.Revex.Revit\Engineering\Energy\References\79_WINTHROP_APPROVED_BASELINE.osm" = "cd4c7ec73a04a8e08d4cee052df70ab67c15d22b62595211f397fca08ebb8a64"
    "src\Liber.Revex.Revit\Engineering\Energy\References\79_WINTHROP_APPROVED_PROPOSED.osm" = "6c4954f5427e4bebec7cf2a26681161be96407646ebf6902a38b1d2f62a7abdb"
    "src\Liber.Revex.Revit\Engineering\Energy\References\EN-1_79_WINTHROP_AMENDMENT.xlsx" = "3468acae967ac123a19c3d0f3232c39f701df09c914df8a144184afbd4a7524e"
    "src\Liber.Revex.Revit\Engineering\Energy\References\COMcheck_250_MIDWOOD_STRUCTURE_REFERENCE.cxl" = "b3259682b844c7d7b03c2bd5adabd0930c0a6d98708cec21e09ab17354022657"
    "src\Live-Companion\index.html" = "53e652e7b0b2bdf20e2db9521ae29e00ece3dfe4e05967e4b28fe4dae3ed7a50"
    "src\Live-Companion\app.js" = "70efca1351401ec24bb297963a0f447ad1af07c1f5eb4f7acb89360c68dead97"
    "src\Live-Companion\store.js" = "d06e50a604486b912462995b33d154769fa4e3c763d1e6253450b47270de8cd3"
    "src\Live-Companion\integrity.js" = "365e5a378bb1c579a75e2c41c3c4683f043c843e5af26b2bc64ad5ca37c4042f"
    "src\Live-Companion\firestore-compat.js" = "ad9a85884cb66fb72d6f4591ba9d5cbf2c685f3e2c5b01ae062b5de3a3465259"
    "src\Live-Companion\viewer-r26.js" = "3052d63a16b9f861d9c0b71e80ccb13c0dbd41112b7056287c0b2dab73507174"
    "src\Live-Companion\history-r24.js" = "046c279d78f0eb2ed58c32c291d94fb3affcd81d26101f7873674a411d338aac"
    "src\Live-Companion\styles.css" = "1d5c2d11a800e967b1d9e5d2cd92a6eebbb209b8183f927eba7d2267d8a734e9"
    "src\Live-Companion\energy-r27.js" = "32bfa614b955e02fdf7652f517b874fe384041d5e5b61361cefcd3e2d18771e0"
    "server\revex-energy-worker\app.py" = "fd64da71b87331f5efb3cbfa494979ef65def12d53ac105cb15ad1a5b8fe1ed7"
    "server\revex-energy-worker\verify_revex_r49_worker.py" = "8405a3e59448e5f2c6b51aeb001624e5c4672461de7bca8c1c9410c561c2404d"
    "server\revex-energy-worker\run_revex_r49_release_acceptance.py" = "93533a8cf3792d9c41882de62ee9469a07c93a9ddebfe7452562458666eb88df"
    "server\revex-energy-worker\Dockerfile" = "89a75fdd9ef42534dda1fa535a2c6701afe35751964db9404cc635f46fa2a303"
    "server\revex-energy-worker\cloudbuild.yaml" = "a12fe6c236c4a464de6faaf5792e194f8deca58bc8c87350b1e5ba0b889dcbb4"
    "server\revex-energy-worker\requirements-server.txt" = "f35c6f0f9355c7008cee71e693f729b66b138ed63b8be9a124659a31e24b5863"
    "server\firebase-functions\index.js" = "6e28e5990be701ada9d4012dfd99896ca7dc15367a1de6d4bb8f77359e93e842"
    "server\firebase-functions\project-access.js" = "bdce74c9b419495b3144a7af9c1c66eb338f31245d8935b2e6a2686e4ec062e3"
    "server\firebase-functions\verify-project-access-r49.js" = "533566dc66231369bed7d02d216680cbac7e225d5a084227fc48d1856106b76b"
    "server\firebase-functions\package.json" = "a9e7a391f77fd89bff95a5f128bcc5e86c7897b077b511c0eddd75c078b3075e"
    "server\firebase-functions\package-lock.json" = "4f3fc020ae4a4552d2de948ba7a90c94744c8ba20d0218f9eff7fb21acaa1c98"
    "server\firebase-functions\firebase.json" = "e4ede752096eb1da43d1ec097dd3aca7f420efe85edd913fb392005150f6df96"
    "firebase\revex-project-access-r43.rules" = "17ac55200677dcdc8a77556bbf3ea1d7dca2ab216f32c737f19c8c6b576f6ebe"
    "firebase\r49-live-rules\package.json" = "2c795fafb75527997dbe5791bd3c695a9d5dc4257a7ee8a769a8e5ac6eee41aa"
    "firebase\r49-live-rules\package-lock.json" = "789bbcc5a9716e95a1924ffbe9ad19131deacb6a53376d1f352914b67b27f7d0"
    "firebase\r49-live-rules\firebase.json" = "6285cd269cfb42419e2f9c9f03a0f2c16f41198831c36bea941cb3f1f7b93bb3"
    "firebase\r49-live-rules\.gitignore" = "8bbd5e0e7c8f650b9fd6ca3a4bde39fedde690a639965b0e3b46cf33d040c20a"
    "REVEX_RELEASE_COORDINATION.md" = "2b141c5309d20b683270f79f68810fd7af9b7de59504ec9bcc4bc83b70355aeb"
  }
  Restore-HashLockedSource $Expected

  Refresh-ToolPath
  $Node = Resolve-Executable @("node.exe", "node")
  if (-not $Node) { Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS"; $Node = Resolve-Executable @("node.exe", "node") }
  $Npm = Resolve-Executable @("npm.cmd", "npm.exe", "npm")
  $Python = Resolve-Executable @("py.exe", "python.exe", "py", "python")
  if (-not $Python) { Install-WingetPackage "Python.Python.3.12" "Python 3.12"; $Python = Resolve-Executable @("py.exe", "python.exe", "py", "python") }
  $Dotnet = Resolve-Executable @("dotnet.exe", "dotnet")
  if (-not $Dotnet) { Install-WingetPackage "Microsoft.DotNet.SDK.8" ".NET 8 SDK"; $Dotnet = Resolve-Executable @("dotnet.exe", "dotnet") }
  $Java = Resolve-Executable @("java.exe", "java")
  if (-not $Java) { Install-WingetPackage "EclipseAdoptium.Temurin.21.JDK" "Java 21"; $Java = Resolve-Executable @("java.exe", "java") }
  foreach ($tool in @($Node,$Npm,$Python,$Dotnet,$Java)) { if (-not $tool) { throw "A required offline-preflight tool did not become available." } }

  $Firebase = Resolve-Executable @("firebase.cmd", "firebase.exe", "firebase")
  $firebaseVersion = if ($Firebase) { (Invoke-Captured "Verify pinned Firebase CLI version" $Firebase @("--version") -AllowFailure).Text.Trim() } else { "" }
  if (-not $Firebase -or $firebaseVersion -ne "15.27.0") {
    Invoke-Native "Install pinned Firebase CLI 15.27.0" $Npm @("install", "--global", "firebase-tools@15.27.0", "--no-audit", "--no-fund")
    Refresh-ToolPath
    $Firebase = Resolve-Executable @("firebase.cmd", "firebase.exe", "firebase")
  }
  if (-not $Firebase) { throw "Firebase CLI did not become available for credential cleanup." }
  $firebaseVersion = (Invoke-Captured "Confirm Firebase CLI 15.27.0" $Firebase @("--version")).Text.Trim()
  if ($firebaseVersion -ne "15.27.0") { throw "Firebase CLI is not the hash-locked release-tool version (found $firebaseVersion)." }
  if (-not (Test-Path -LiteralPath $CredentialRotationMarker -PathType Leaf)) {
    $firebaseRefreshToken = Get-FirebaseRefreshTokenForRotation $Firebase
    $revocationState = Revoke-GoogleOAuthToken $firebaseRefreshToken
    $firebaseRefreshToken = $null
    Protect-DeploymentLogs
    Invoke-InteractiveNoLog "Essential Firebase reauthentication after credential revocation" $Firebase @("login", "--reauth")
    $rotationProbe = Invoke-SecretCaptured "Verify Firebase project access after secure credential rotation" $Firebase @("projects:list", "--json")
    if ($rotationProbe.Text -notmatch [regex]::Escape($ProjectId)) { throw "Firebase reauthentication succeeded, but the renewed account cannot access $ProjectId." }
    New-Item -ItemType Directory -Path (Split-Path -Parent $CredentialRotationMarker) -Force | Out-Null
    [IO.File]::WriteAllText($CredentialRotationMarker, [DateTime]::UtcNow.ToString("o"), [Text.UTF8Encoding]::new($false))
    Write-Log "Firebase CLI credential rotation verified ($revocationState); historical r49 publisher logs were redacted and authentication material was not logged." Green
  } else {
    Protect-DeploymentLogs
  }

  New-IsolatedCanonicalSourceStage $Expected

  Write-Step "Verify clean official COMcheck project-translation contract before expensive acceptance work"
  $comcheckClientPath = Join-Path $StageSource "src\Liber.Revex.Revit\Engineering\Energy\comcheck_backstop.py"
  $comcheckClientSource = [IO.File]::ReadAllText($comcheckClientPath, [Text.Encoding]::UTF8)
  foreach ($requiredToken in @("class FreshProjectBrowserClient", "FRESH_PROJECT_BROWSER_MODEL", "CLEAN_PROJECT_EXPORTED", "REVEX_ALLOW_COMCHECK_TEST_ENDPOINT")) {
    if (-not $comcheckClientSource.Contains($requiredToken)) {
      throw "COMcheck clean-project translator contract is incomplete: missing $requiredToken"
    }
  }
  if ($comcheckClientSource -notmatch '(?s)else:\s*summary\s*=\s*FreshProjectBrowserClient') {
    throw "Production COMcheck path is not routed through the clean official browser project translator."
  }
  Add-PreflightCheckpoint "COMCHECK_CLEAN_PROJECT_STATIC" ([ordered]@{
    officialService = "legacy-comcheck.energycode.pnl.gov"
    productionTransport = "FRESH_PROJECT_BROWSER_MODEL"
    legacyUploadProductionPath = $false
    localMockRetained = $true
    currentEvidenceTranslation = $true
    client = $comcheckClientPath
  })

  Assert-ReleaseBundleClosure $StageSource
  Write-Step "Create isolated r49 offline preflight dependencies"
  New-Item -ItemType Directory -Path $StagePayload, $StageRules -Force | Out-Null
  Copy-SourceTree (Join-Path $StageSource "firebase\r49-live-rules") $StageRules
  Copy-Item -LiteralPath (Join-Path $StageSource ".github\scripts\verify-revex-r49-live-rules.js") -Destination (Join-Path $StageRules "verify-revex-r49-live-rules.js") -Force
  Invoke-Native "Install pinned Firebase Rules emulator dependencies" $Npm @("ci", "--no-audit", "--no-fund") -WorkingDirectory $StageRules
  Invoke-NpmAuditGate "Reject high or critical Firebase Rules gate dependency advisories" $Npm @("audit", "--audit-level=high") $StageRules "789bbcc5a9716e95a1924ffbe9ad19131deacb6a53376d1f352914b67b27f7d0" "2026-08-14T08:57:20Z" "PUBLISH_REVEX_R49.20260814-045615.log"
  Invoke-Native "Prepare representative preserved project-access rules" $Node @(
    ".github\scripts\patch-live-firestore-rules.js",
    ".github\scripts\fixtures\live-firestore-base.rules",
    "firebase\revex-project-access-r43.rules",
    (Join-Path $StageRules "firestore.rules")
  ) -WorkingDirectory $StageSource
  $previousNodePath = $env:NODE_PATH
  try {
    $env:NODE_PATH = Join-Path $StageRules "node_modules"
    Invoke-Native "Run offline owner/member/admin and outsider Firestore behavior gate" $Firebase @(
      "emulators:exec", "--only", "firestore", "--project", "demo-revex-r49",
      "node verify-revex-r49-live-rules.js"
    ) -WorkingDirectory $StageRules
  } finally {
    $env:NODE_PATH = $previousNodePath
  }
  Add-PreflightCheckpoint "FIRESTORE_BEHAVIOR_GATE" ([ordered]@{
    pinnedDependencies = $true
    representativePreservedRules = $true
    ownerMemberAdminFunctionalParity = $true
    outsiderAnonymousCrossProjectDenied = $true
    memberAclEscalationDenied = $true
  })

  Invoke-Native "Simulate recorded-Revit BIM, Books, viewer and managed-Energy handoff" $Node @(".github\scripts\verify-revex-r49.js", "--report", $CompanionSimulationReport) -WorkingDirectory $StageSource
  $companionSimulation = Get-Content -LiteralPath $CompanionSimulationReport -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$companionSimulation.status -ne "PASSED" -or $companionSimulation.cloudMutations -ne $false -or $companionSimulation.officialComcheckProjectTransmission -ne $false) {
    throw "The recorded-Revit Companion simulation did not produce a safe PASSED contract."
  }
  Add-PreflightCheckpoint "RECORDED_REVIT_COMPANION_SIMULATION" ([ordered]@{
    mode = [string]$companionSimulation.mode
    report = $CompanionSimulationReport
    checkpointCount = @($companionSimulation.checkpoints).Count
    independentNativeSchedules = $true
    pagedGeometryAndCurtainParts = $true
    reversibleVisibility = $true
    exactProjectRevisionHandoff = $true
  })
  Invoke-Native "Parse live Companion" $Node @("--check", (Join-Path $StageSource "src\Live-Companion\app.js"))
  Invoke-Native "Parse progressive BIM viewer" $Node @("--check", (Join-Path $StageSource "src\Live-Companion\viewer-r26.js"))
  Invoke-Native "Parse Engineering cloud store" $Node @("--check", (Join-Path $StageSource "src\Live-Companion\store.js"))
  Invoke-Native "Parse revision-scoped managed Energy bridge" $Node @("--check", (Join-Path $StageSource "src\Liber.Revex.Revit\Engineering\Companion\native-managed-energy-bridge.js"))
  Invoke-Native "Parse Firebase broker" $Node @("--check", (Join-Path $StageFunctions "index.js"))
  Invoke-Native "Parse shared Firebase project-access policy" $Node @("--check", (Join-Path $StageFunctions "project-access.js"))
  Invoke-Native "Run owner, ordinary-member, admin and outsider access matrix" $Node @((Join-Path $StageFunctions "verify-project-access-r49.js"))
  Add-PreflightCheckpoint "PROJECT_USER_ACCESS_MATRIX" ([ordered]@{
    ownerFunctionalParity = $true
    ordinaryProjectMemberFunctionalParity = $true
    liberAdminFunctionalParity = $true
    outsiderDenied = $true
    anonymousDenied = $true
    crossProjectDenied = $true
    ordinaryMemberAclEscalationDenied = $true
    workerInvocation = "broker service account only"
  })

  $projectFile = Join-Path $StageSource "src\Liber.Revex.Revit\Liber.Revex.Revit.csproj"
  Invoke-Native "Restore locked .NET dependencies" $Dotnet @("restore", $projectFile)
  Invoke-Native "Compile REVEX r49 against Revit 2026 (warnings, errors and full binlog retained)" $Dotnet @("build", $projectFile, "-c", "Release", "--no-restore", "-nologo", "-clp:WarningsOnly;ErrorsOnly;Summary", "-bl:$BuildBinlog", "-p:RevitInstallDir=$RevitDir", "-o", $StagePayload)
  foreach ($relative in @("Liber.Revex.Revit.dll", "Microsoft.Web.WebView2.Core.dll", "Engineering\Energy\revex_energy_pipeline.py", "Engineering\Energy\verify_revex_r49_energy.py", "Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py", "Engineering\Companion\native-managed-energy-bridge.js")) {
    if (-not (Test-Path -LiteralPath (Join-Path $StagePayload $relative) -PathType Leaf)) { throw "Compiled r49 add-in payload is incomplete: $relative" }
  }
  $compiledDll = Join-Path $StagePayload "Liber.Revex.Revit.dll"
  $productVersion = (Get-Item -LiteralPath $compiledDll).VersionInfo.ProductVersion
  if ([string]$productVersion -notmatch "0\.8\.19-r49") { throw "Compiled DLL is not r49 (ProductVersion=$productVersion)." }
  $compiledDllHash = (Get-FileHash -LiteralPath $compiledDll -Algorithm SHA256).Hash.ToLowerInvariant()
  Add-PreflightCheckpoint "COMPILED_REVIT_ADDIN" ([ordered]@{
    productVersion = [string]$productVersion
    sha256 = $compiledDllHash
    payload = $StagePayload
    fullBuildLog = $BuildBinlog
    compilerWarningsVisibleInPublisherLog = $true
  })

  $VenvRoot = Join-Path $StageRoot ".venv"
  $pythonName = [IO.Path]::GetFileName($Python).ToLowerInvariant()
  $venvArgs = if ($pythonName -eq "py.exe") { @("-3", "-m", "venv", $VenvRoot) } else { @("-m", "venv", $VenvRoot) }
  Invoke-Native "Create isolated r49 Python QA environment" $Python $venvArgs
  $VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) { throw "Python did not create the isolated r49 QA environment." }
  Invoke-Native "Install exact Energy, GeometryCo local-AI and managed-worker QA dependencies" $VenvPython @("-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--requirement", (Join-Path $StageSource "src\Liber.Revex.Revit\Engineering\Energy\requirements.txt"), "--requirement", (Join-Path $StageSource "src\Liber.Revex.Revit\Engineering\Energy\GeometryCo\requirements.txt"), "--requirement", (Join-Path $StageSource "server\revex-energy-worker\requirements-server.txt"))
  Invoke-Native "Run current-project CXL, OSM identity, COMcheck protocol and EN-1 QA" $VenvPython @((Join-Path $StageSource "src\Liber.Revex.Revit\Engineering\Energy\verify_revex_r49_energy.py")) -WorkingDirectory (Join-Path $StageSource "src\Liber.Revex.Revit\Engineering\Energy")

  Write-Step "Verify live official COMcheck clean-project translation before real Revit/EnergyPlus acceptance"
  $chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
  $Chrome = @($chromeCandidates | Select-Object -First 1)
  if ($Chrome.Count -eq 0) {
    Install-WingetPackage "Google.Chrome" "Google Chrome"
    $chromeCandidates = @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    $Chrome = @($chromeCandidates | Select-Object -First 1)
  }
  if ($Chrome.Count -ne 1) { throw "Google Chrome is required for the official clean COMcheck project translator." }
  $priorChromeBinary = $env:REVEX_CHROME_BINARY
  try {
    $env:REVEX_CHROME_BINARY = [string]$Chrome[0]
    Invoke-Native "Run live official COMcheck clean-project synthetic acceptance" $VenvPython @((Join-Path $StageSource ".github\scripts\verify-revex-r49-live-comcheck.py")) -WorkingDirectory $StageSource
  } finally {
    $env:REVEX_CHROME_BINARY = $priorChromeBinary
  }
  Add-PreflightCheckpoint "COMCHECK_CLEAN_PROJECT_LIVE" ([ordered]@{
    officialService = "legacy-comcheck.energycode.pnl.gov"
    syntheticProjectOnly = $true
    productionTransport = "FRESH_PROJECT_BROWSER_MODEL"
    cleanCheckXmlExport = $true
    officialPdf = $true
    beforeRealRevitAndEnergyPlus = $true
  })
  Add-PreflightCheckpoint "OFFLINE_ENERGY_CHAIN_SIMULATION" ([ordered]@{
    activeRevitTzIdentity = $true
    enTechnicalFacts = $true
    exactRevisionConsent = $true
    currentProjectCxl = $true
    officialComcheckProtocol = "local protocol-compatible mock; no project transmission"
    compiledOsmCount = 2
    energyPlusCompletionContracts = 2
    en1AndPrmPackaging = $true
  })
  Invoke-Native "Run managed worker artifact, binding, T/Z and revision-consent QA" $VenvPython @((Join-Path $StageSource "server\revex-energy-worker\verify_revex_r49_worker.py")) -WorkingDirectory (Join-Path $StageSource "server\revex-energy-worker")
  Add-PreflightCheckpoint "PRIVATE_WORKER_CONTRACT" ([ordered]@{
    artifactIntegrity = $true
    activeDocumentBinding = $true
    crossRevisionConsentRejected = $true
    cloudCredentialsUsed = $false
  })
  Invoke-Native "Install exact Firebase broker dependencies" $Npm @("ci", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $StageFunctions
  Invoke-NpmAuditGate "Reject moderate, high or critical Firebase broker dependency advisories" $Npm @("audit", "--omit=dev", "--audit-level=moderate") $StageFunctions "4f3fc020ae4a4552d2de948ba7a90c94744c8ba20d0218f9eff7fb21acaa1c98" "2026-08-14T09:09:00Z" "PUBLISH_REVEX_R49.20260814-045615.log"
  Add-PreflightCheckpoint "FIREBASE_BROKER_DEPENDENCIES" ([ordered]@{
    lockfileInstall = $true
    moderateHighCriticalAdvisories = 0
    productionDependenciesOnly = $true
  })

  $ReleaseWeather = Resolve-ReleaseWeather $ReleaseModel
  $RealRevitEvidence = Try-ReuseRealRevitEvidenceGate $ReleaseModel $ReleaseWeather
  if ($null -eq $RealRevitEvidence) {
    $RealRevitEvidence = Invoke-RealRevitEvidenceGate $ReleaseModel $ReleaseWeather
  }

  $Gcloud = Resolve-Executable @("gcloud.cmd", "gcloud.exe", "gcloud")
  if (-not $Gcloud) { Install-WingetPackage "Google.CloudSDK" "Google Cloud CLI"; $Gcloud = Resolve-Executable @("gcloud.cmd", "gcloud.exe", "gcloud") }
  if (-not $Gcloud) { throw "Google Cloud CLI is required for the real T/Z/EN publication scan." }
  $gcloudAuth = Invoke-Captured "Verify Google Cloud authentication for real-project acceptance" $Gcloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)") -AllowFailure
  if ($gcloudAuth.ExitCode -ne 0 -or -not $gcloudAuth.Text.Trim()) {
    Invoke-InteractiveNoLog "Essential Google Cloud approval" $Gcloud @("auth", "login")
  }
  $RealEnergyAcceptance = Try-ReuseRealEnergyAcceptanceGate $RealRevitEvidence $ReleaseReviewPackage
  if ($null -eq $RealEnergyAcceptance) {
    $RealEnergyAcceptance = Invoke-RealEnergyAcceptanceGate $VenvPython $Gcloud $RealRevitEvidence $ReleaseReviewPackage
    $script:Preflight.safety.officialComcheckProjectTransmission = $true
  } else {
    $script:Preflight.safety.officialComcheckProjectTransmission = $false
  }
  $script:Preflight.safety["officialComcheckAuthorization"] = "explicit-r49-release-request; exact immutable Engineering revision; generated current-project CXL only"
  Save-PreflightReport

  $script:Preflight.status = "PASSED"
  $script:Preflight.finishedAt = [DateTime]::UtcNow.ToString("o")
  Save-PreflightReport
  Write-Log "Full r49 gate PASSED on the real 79 Revit artifact before GitHub or production-cloud mutation." Green
  Write-Log "Recorded preflight: $PreflightLatestPath" Green

  Refresh-ToolPath
  $Git = Resolve-Executable @("git.exe", "git")
  if (-not $Git) { Install-WingetPackage "Git.Git" "Git"; $Git = Resolve-Executable @("git.exe", "git") }
  $Gh = Resolve-Executable @("gh.exe", "gh")
  if (-not $Gh) { Install-WingetPackage "GitHub.cli" "GitHub CLI"; $Gh = Resolve-Executable @("gh.exe", "gh") }
  $Gcloud = Resolve-Executable @("gcloud.cmd", "gcloud.exe", "gcloud")
  if (-not $Gcloud) { Install-WingetPackage "Google.CloudSDK" "Google Cloud CLI"; $Gcloud = Resolve-Executable @("gcloud.cmd", "gcloud.exe", "gcloud") }
  foreach ($tool in @($Git,$Gh,$Gcloud,$Firebase)) { if (-not $tool) { throw "A required publishing tool did not become available after the offline gate." } }

  $deployer = (Invoke-Captured "Resolve publisher identity before publication IAM preparation" $Gcloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")).Text.Trim().Split([Environment]::NewLine)[0]
  if (-not $deployer) { throw "Google Cloud did not identify the active publisher." }
  $deployerMember = if ($deployer.EndsWith('.gserviceaccount.com')) { "serviceAccount:$deployer" } else { "user:$deployer" }
  $BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
  Ensure-ServiceAccount $Gcloud $BrokerSa "REVEX authenticated Energy broker"
  Grant-BrokerIdentityProbeAuthority $Gcloud $BrokerSa $deployerMember

  $ghAuth = Invoke-Captured "Verify GitHub authentication" $Gh @("auth", "status", "--hostname", "github.com") -AllowFailure
  if ($ghAuth.ExitCode -ne 0) { Invoke-InteractiveNoLog "Essential GitHub approval" $Gh @("auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web") }
  Invoke-Native "Configure GitHub authentication for Git" $Gh @("auth", "setup-git")

  Invoke-Native "Clone the authoritative GitHub repository" $Gh @("repo", "clone", $GitHubRepository, $RepoRoot, "--", "--depth", "1")
  $branch = "agent/revex-r49-final-$RunId"
  Invoke-Native "Create isolated r49 publication branch" $Git @("checkout", "-b", $branch) -WorkingDirectory $RepoRoot
  Copy-SourceTree (Join-Path $StageSource "src\Live-Companion") (Join-Path $RepoRoot "docs\liber-apps\apps\revex")
  Copy-SourceTree (Join-Path $StageSource "src\Liber.Revex.Revit") (Join-Path $RepoRoot "src\Liber.Revex.Revit")
  Copy-SourceTree (Join-Path $StageSource "server\revex-energy-worker") (Join-Path $RepoRoot "server\revex-energy-worker")
  Copy-SourceTree (Join-Path $StageSource "server\firebase-functions") (Join-Path $RepoRoot "server\firebase-functions")
  New-Item -ItemType Directory -Path (Join-Path $RepoRoot "firebase") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $StageSource "firebase\revex-project-access-r43.rules") -Destination (Join-Path $RepoRoot "firebase\revex-project-access-r43.rules") -Force
  Copy-SourceTree (Join-Path $StageSource "firebase\r49-live-rules") (Join-Path $RepoRoot "firebase\r49-live-rules")
  New-Item -ItemType Directory -Path (Join-Path $RepoRoot ".github\scripts") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $StageSource ".github\scripts\verify-revex-r49.js") -Destination (Join-Path $RepoRoot ".github\scripts\verify-revex-r49.js") -Force
  Copy-Item -LiteralPath (Join-Path $StageSource ".github\scripts\verify-revex-r49-live-rules.js") -Destination (Join-Path $RepoRoot ".github\scripts\verify-revex-r49-live-rules.js") -Force
  Copy-Item -LiteralPath (Join-Path $StageSource ".github\scripts\verify-revex-r49-live-comcheck.py") -Destination (Join-Path $RepoRoot ".github\scripts\verify-revex-r49-live-comcheck.py") -Force
  Copy-Item -LiteralPath (Join-Path $StageSource ".github\scripts\patch-live-firestore-rules.js") -Destination (Join-Path $RepoRoot ".github\scripts\patch-live-firestore-rules.js") -Force
  New-Item -ItemType Directory -Path (Join-Path $RepoRoot ".github\scripts\fixtures") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $StageSource ".github\scripts\fixtures\live-firestore-base.rules") -Destination (Join-Path $RepoRoot ".github\scripts\fixtures\live-firestore-base.rules") -Force
  New-Item -ItemType Directory -Path (Join-Path $RepoRoot ".github\workflows") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $StageSource ".github\workflows\revex-r27-0819-engineering-release.yml") -Destination (Join-Path $RepoRoot ".github\workflows\revex-r27-0819-engineering-release.yml") -Force
  Copy-Item -LiteralPath (Join-Path $StageSource "REVEX_RELEASE_COORDINATION.md") -Destination (Join-Path $RepoRoot "REVEX_RELEASE_COORDINATION.md") -Force
  Copy-Item -LiteralPath (Join-Path $Root "PUBLISH_REVEX_R49.ps1") -Destination (Join-Path $RepoRoot "PUBLISH_REVEX_R49.ps1") -Force
  Copy-Item -LiteralPath (Join-Path $Root "PUBLISH_REVEX_R49.cmd") -Destination (Join-Path $RepoRoot "PUBLISH_REVEX_R49.cmd") -Force
  Invoke-Native "Stage only the r49 release" $Git @("add", "--",
    "docs/liber-apps/apps/revex", "src/Liber.Revex.Revit",
    "server/revex-energy-worker", "server/firebase-functions",
    "firebase/revex-project-access-r43.rules", "firebase/r49-live-rules",
    ".github/scripts/verify-revex-r49.js",
    ".github/scripts/verify-revex-r49-live-rules.js",
    ".github/scripts/verify-revex-r49-live-comcheck.py",
    ".github/scripts/patch-live-firestore-rules.js",
    ".github/scripts/fixtures/live-firestore-base.rules",
    ".github/workflows/revex-r27-0819-engineering-release.yml",
    "REVEX_RELEASE_COORDINATION.md",
    "PUBLISH_REVEX_R49.ps1", "PUBLISH_REVEX_R49.cmd"
  ) -WorkingDirectory $RepoRoot
  $staged = Invoke-Captured "Inspect exact staged r49 publication diff" $Git @("diff", "--cached", "--name-only") -WorkingDirectory $RepoRoot
  if ($staged.Text.Trim()) {
    $login = (Invoke-Captured "Resolve GitHub release identity" $Gh @("api", "user", "--jq", ".login")).Text.Trim()
    $name = (Invoke-Captured "Resolve GitHub release name" $Gh @("api", "user", "--jq", ".name // .login")).Text.Trim()
    Invoke-Native "Set release author" $Git @("config", "user.name", $name) -WorkingDirectory $RepoRoot
    Invoke-Native "Set release email" $Git @("config", "user.email", "$login@users.noreply.github.com") -WorkingDirectory $RepoRoot
    Invoke-Native "Commit REVEX r49" $Git @("commit", "-m", "REVEX 0.8.19 r49: finalize active-document sync and managed Energy chain") -WorkingDirectory $RepoRoot
    Invoke-Native "Push r49 release branch" $Git @("push", "--set-upstream", "origin", $branch) -WorkingDirectory $RepoRoot
    $pr = (Invoke-Captured "Open r49 publication PR" $Gh @("pr", "create", "--repo", $GitHubRepository, "--base", "main", "--head", $branch, "--title", "REVEX 0.8.19 r49: final active-document and Energy chain", "--body", "Hash-locked r49: active-document project binding, progressive paged BIM, reversible visibility, native schedules, fullscreen Design Book images, and strict managed Energy outputs with per-revision COMcheck consent.") -WorkingDirectory $RepoRoot).Text.Trim().Split([Environment]::NewLine)[-1]
    Write-Log "The r49 PR cannot merge until its named final gate is present and successful." Yellow
    $headSha = (Invoke-Captured "Resolve r49 release commit" $Git @("rev-parse", "HEAD") -WorkingDirectory $RepoRoot).Text.Trim()
    $requiredCheck = "REVEX r49 final gate"
    $checksPassed = $false
    for ($attempt = 1; $attempt -le 80; $attempt++) {
      $checks = Invoke-Captured "GitHub check status $attempt/80" $Gh @("api", "repos/$GitHubRepository/commits/$headSha/check-runs") -AllowFailure
      if ($checks.ExitCode -eq 0) {
        $json = $checks.Text | ConvertFrom-Json
        $runs = @($json.check_runs)
        $failed = @($runs | Where-Object { $_.status -eq 'completed' -and $_.conclusion -notin @('success','neutral','skipped') })
        if ($failed.Count) {
          throw "GitHub rejected r49: " + (($failed | ForEach-Object { "$($_.name)=$($_.conclusion)" }) -join ', ')
        }
        $required = @($runs | Where-Object { [string]$_.name -eq $requiredCheck })
        if ($required.Count -eq 1 -and [string]$required[0].status -eq "completed" -and [string]$required[0].conclusion -eq "success") {
          $checksPassed = $true
          break
        }
      }
      Start-Sleep -Seconds 15
    }
    if (-not $checksPassed) {
      throw "GitHub never reported the required successful '$requiredCheck' check for commit $headSha; the r49 PR was intentionally left unmerged."
    }
    Invoke-Native "Merge check-verified r49 publication PR" $Gh @("pr", "merge", $pr, "--repo", $GitHubRepository, "--squash", "--delete-branch") -WorkingDirectory $RepoRoot
  } else {
    Write-Log "GitHub main already contains the exact staged r49 content; working-tree line-ending noise is ignored and publication continues idempotently." Green
  }

  $gcloudAuth = Invoke-Captured "Verify Google Cloud authentication" $Gcloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)") -AllowFailure
  if ($gcloudAuth.ExitCode -ne 0 -or -not $gcloudAuth.Text.Trim()) { Invoke-InteractiveNoLog "Essential Google Cloud approval" $Gcloud @("auth", "login") }
  $firebaseAuth = Invoke-SecretCaptured "Verify Firebase authentication without logging credentials" $Firebase @("login:list") -AllowFailure
  if ($firebaseAuth.ExitCode -ne 0 -or -not $firebaseAuth.Text.Trim() -or $firebaseAuth.Text -match 'No authorized') { Invoke-InteractiveNoLog "Essential Firebase approval" $Firebase @("login") }
  Write-Log "Firebase authentication verified without logging credentials." Green
  $projects = Invoke-SecretCaptured "Verify Firebase project access without logging account data" $Firebase @("projects:list", "--json")
  if ($projects.Text -notmatch [regex]::Escape($ProjectId)) { throw "The authenticated Firebase account cannot access $ProjectId." }
  Write-Log "Firebase project access verified: $ProjectId" Green
  $deployer = (Invoke-Captured "Resolve publisher identity" $Gcloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")).Text.Trim().Split([Environment]::NewLine)[0]
  if (-not $deployer) { throw "Google Cloud did not identify the active publisher." }
  $deployerMember = if ($deployer.EndsWith('.gserviceaccount.com')) { "serviceAccount:$deployer" } else { "user:$deployer" }

  Invoke-Native "Set active Google Cloud project" $Gcloud @("config", "set", "project", $ProjectId)
  Invoke-Native "Enable managed Energy APIs" $Gcloud @("services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "cloudfunctions.googleapis.com", "firebase.googleapis.com", "firebaserules.googleapis.com", "aiplatform.googleapis.com", "iamcredentials.googleapis.com", "--project=$ProjectId")
  Add-ProjectRole $Gcloud $deployerMember "roles/firebaserules.viewer" "Grant publisher read-only Firebase Rules verification"
  Verify-LiveProjectAccessRules $Gcloud
  $WorkerSa = "revex-energy-worker@$ProjectId.iam.gserviceaccount.com"
  $BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
  Ensure-ServiceAccount $Gcloud $WorkerSa "REVEX private Energy worker"
  Ensure-ServiceAccount $Gcloud $BrokerSa "REVEX authenticated Energy broker"
  Add-ServiceAccountUser $Gcloud $WorkerSa $deployerMember "Allow publisher to deploy the private worker"
  Add-ServiceAccountUser $Gcloud $BrokerSa $deployerMember "Allow publisher to deploy the Firebase broker"
  Add-ProjectRole $Gcloud "serviceAccount:$WorkerSa" "roles/storage.objectAdmin" "Grant worker immutable evidence/result object access"
  Add-ProjectRole $Gcloud "serviceAccount:$WorkerSa" "roles/aiplatform.user" "Grant worker managed T/Z/EN page scan access"
  Add-ProjectRole $Gcloud "serviceAccount:$BrokerSa" "roles/datastore.user" "Grant broker project-data access"
  $ProjectNumber = (Invoke-Captured "Resolve Google Cloud project number" $Gcloud @("projects", "describe", $ProjectId, "--format=value(projectNumber)")).Text.Trim()
  Remove-ProjectLevelWorkerInvokerGrants $Gcloud $ProjectNumber $BrokerSa
  $CloudBuildSa = (Invoke-Captured "Resolve actual Cloud Build identity" $Gcloud @("builds", "get-default-service-account", "--project=$ProjectId", "--format=value(serviceAccountEmail)")).Text.Trim().Split('/')[-1]
  Add-ProjectRole $Gcloud "serviceAccount:$CloudBuildSa" "roles/cloudbuild.builds.builder" "Grant Cloud Build its builder role"
  Add-ProjectRole $Gcloud "serviceAccount:$CloudBuildSa" "roles/artifactregistry.writer" "Grant Cloud Build image-push access"
  $FunctionsAgent = "service-$ProjectNumber@gcf-admin-robot.iam.gserviceaccount.com"
  Add-ServiceAccountUser $Gcloud $BrokerSa "serviceAccount:$FunctionsAgent" "Allow Cloud Functions to attach the broker identity"

  $repoProbe = Invoke-Captured "Verify REVEX Artifact Registry repository" $Gcloud @("artifacts", "repositories", "describe", $Repository, "--project=$ProjectId", "--location=$Region", "--format=value(name)") -AllowFailure
  if ($repoProbe.ExitCode -ne 0) { Invoke-Native "Create REVEX Artifact Registry repository" $Gcloud @("artifacts", "repositories", "create", $Repository, "--project=$ProjectId", "--location=$Region", "--repository-format=docker", "--description=REVEX managed production images", "--quiet") }

  Write-Step "Verify the official COMcheck service is reachable without sending project data"
  $comcheckProbe = Invoke-WebRequest -UseBasicParsing -Uri "https://legacy-comcheck.energycode.pnl.gov/CheckWeb/" -Method Get -TimeoutSec 20
  if ($comcheckProbe.StatusCode -ne 200) { throw "The official COMcheck service did not pass its non-project availability probe." }
  Write-Log "Official COMcheck availability probe passed. No project CXL was transmitted." Green

  $Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-energy-worker`:$ReleaseTag"
  $workerProbe = Invoke-Captured "Inspect existing r49 worker revision" $Gcloud @("run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json") -AllowFailure
  $reuseWorker = $false
  if ($workerProbe.ExitCode -eq 0) {
    $existingWorker = $workerProbe.Text | ConvertFrom-Json
    $existingImage = [string]$existingWorker.spec.template.spec.containers[0].image
    $existingReady = @($existingWorker.status.conditions | Where-Object { $_.type -eq 'Ready' -and [string]$_.status -eq 'True' }).Count -gt 0
    $existingEnv = @($existingWorker.spec.template.spec.containers[0].env)
    $existingSourceRows = @($existingEnv | Where-Object { [string]$_.name -eq "REVEX_SOURCE_CANDIDATE" } | Select-Object -First 1)
    $existingSourceCandidate = if ($existingSourceRows.Count -eq 1) { [string]$existingSourceRows[0].value } else { "" }
    $reuseWorker = $existingReady -and $existingImage.Contains($ReleaseTag) -and $existingSourceCandidate -eq $CanonicalSourceCommit
  }
  if ($reuseWorker) {
    Write-Log "Exact candidate-bound r49 private worker is already ready; skipping duplicate image build and Cloud Run deployment." Green
  } else {
    Invoke-Native "Build, test and push the immutable r49 worker image" $Gcloud @("builds", "submit", "--project=$ProjectId", "--timeout=1800s", "--config=server/revex-energy-worker/cloudbuild.yaml", "--substitutions=_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-energy-worker,_TAG=$ReleaseTag", ".") -WorkingDirectory $StageSource
    Invoke-Native "Deploy the private r49 Energy worker" $Gcloud @("run", "deploy", $Service, "--project=$ProjectId", "--region=$Region", "--image=$Image", "--service-account=$WorkerSa", "--no-allow-unauthenticated", "--cpu=4", "--memory=8Gi", "--concurrency=1", "--min-instances=0", "--max-instances=3", "--timeout=3600", "--set-env-vars=REVEX_ENERGY_TIMEOUT_SECONDS=3500,REVEX_VERTEX_PROJECT=$ProjectId,REVEX_VERTEX_LOCATION=global,REVEX_SOURCE_CANDIDATE=$CanonicalSourceCommit", "--quiet")
  }
  $workerStateForUrls = ((Invoke-Captured "Resolve all deployed Cloud Run worker URLs" $Gcloud @("run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")).Text | ConvertFrom-Json)
  $WorkerUrls = @(Get-CloudRunServiceUrls $workerStateForUrls $Service $ProjectNumber $Region)
  if ($WorkerUrls.Count -eq 0) { throw "Cloud Run did not expose any usable generated worker URL." }
  $DeterministicWorkerUrl = "https://${Service}-${ProjectNumber}.${Region}.run.app"
  if ($DeterministicWorkerUrl -notin $WorkerUrls) { throw "Cloud Run did not report its deterministic service URL: $DeterministicWorkerUrl" }
  Write-Log ("Cloud Run worker URL candidates: " + ($WorkerUrls -join ', ')) Green
  Invoke-Native "Bind the private worker to one stable deterministic authentication audience" $Gcloud @(
    "run", "services", "update", $Service,
    "--project=$ProjectId", "--region=$Region",
    "--add-custom-audiences=$DeterministicWorkerUrl", "--quiet"
  )
  $workerStateForUrls = ((Invoke-Captured "Verify deterministic worker authentication audience" $Gcloud @("run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")).Text | ConvertFrom-Json)
  $WorkerUrls = @(Get-CloudRunServiceUrls $workerStateForUrls $Service $ProjectNumber $Region)
  $customAudienceText = ""
  try { $customAudienceText = [string]$workerStateForUrls.metadata.annotations.'run.googleapis.com/custom-audiences' } catch { }
  if (-not $customAudienceText -or $customAudienceText -notmatch [regex]::Escape($DeterministicWorkerUrl)) {
    throw "Cloud Run did not retain the deterministic REVEX worker authentication audience."
  }
  Add-PreflightCheckpoint "PRIVATE_WORKER_AUTH_AUDIENCE" ([ordered]@{
    deterministicWorkerUrl = $DeterministicWorkerUrl
    acceptedAudience = $DeterministicWorkerUrl
    reportedWorkerUrls = @($WorkerUrls)
    brokerOnlyInvokerPolicyPreserved = $true
  })
  $WorkerUrls = @($DeterministicWorkerUrl) + @($WorkerUrls | Where-Object { $_ -ne $DeterministicWorkerUrl })
  $policy = ((Invoke-Captured "Inspect private worker invocation policy" $Gcloud @("run", "services", "get-iam-policy", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")).Text | ConvertFrom-Json)
  $conditionalWorkerInvokers = @($policy.bindings | Where-Object { [string]$_.role -eq "roles/run.invoker" -and $null -ne $_.PSObject.Properties['condition'] -and $null -ne $_.condition })
  if ($conditionalWorkerInvokers.Count) {
    throw "The dedicated worker has conditional roles/run.invoker bindings. REVEX will not remove or reinterpret conditional worker access automatically."
  }
  foreach ($binding in @($policy.bindings | Where-Object { $_.role -eq 'roles/run.invoker' })) {
    foreach ($member in @($binding.members)) {
      if ([string]$member -ne "serviceAccount:$BrokerSa") { Invoke-Native "Remove non-broker worker invoker $member" $Gcloud @("run", "services", "remove-iam-policy-binding", $Service, "--project=$ProjectId", "--region=$Region", "--member=$member", "--role=roles/run.invoker", "--quiet") }
    }
  }
  Invoke-Native "Grant broker-only private worker invocation" $Gcloud @("run", "services", "add-iam-policy-binding", $Service, "--project=$ProjectId", "--region=$Region", "--member=serviceAccount:$BrokerSa", "--role=roles/run.invoker", "--quiet")
  $verifiedPolicy = ((Invoke-Captured "Verify exact broker-only worker invocation policy" $Gcloud @("run", "services", "get-iam-policy", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")).Text | ConvertFrom-Json)
  $invokerMembers = @($verifiedPolicy.bindings | Where-Object { $_.role -eq 'roles/run.invoker' } | ForEach-Object { @($_.members) } | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  $expectedInvoker = "serviceAccount:$BrokerSa"
  if ($invokerMembers.Count -ne 1 -or $invokerMembers[0] -ne $expectedInvoker) {
    throw "Private worker invokers are not exactly broker-only: $($invokerMembers -join ', ')"
  }
  foreach ($candidateUrl in $WorkerUrls) {
    try {
      $unexpected = Invoke-WebRequest -UseBasicParsing -Uri ($candidateUrl + "/healthz") -TimeoutSec 15
      if ($unexpected.StatusCode -eq 200) { throw "Private worker URL $candidateUrl unexpectedly allowed unauthenticated invocation." }
    } catch {
      $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
      if ($status -notin @(401,403,404)) { throw }
      Write-Log "Private worker URL $candidateUrl correctly denied or concealed the unauthenticated health probe ($status)." Green
    }
  }
  $WorkerUrl = Test-BrokerIdentityWorkerInvocation $Gcloud $BrokerSa $deployerMember $WorkerUrls
  Remove-BrokerIdentityProbeAuthority
  Write-Log "The broker service account is the sole dedicated runtime invoker binding for this worker. Project administrators retain administrative authority by design." Green
  $runState = ((Invoke-Captured "Verify ready r49 Cloud Run revision" $Gcloud @("run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")).Text | ConvertFrom-Json)
  $deployedImage = [string]$runState.spec.template.spec.containers[0].image
  $ready = @($runState.status.conditions | Where-Object { $_.type -eq 'Ready' -and [string]$_.status -eq 'True' }).Count -gt 0
  $deployedEnv = @($runState.spec.template.spec.containers[0].env)
  $deployedSourceRows = @($deployedEnv | Where-Object { [string]$_.name -eq "REVEX_SOURCE_CANDIDATE" } | Select-Object -First 1)
  $deployedSourceCandidate = if ($deployedSourceRows.Count -eq 1) { [string]$deployedSourceRows[0].value } else { "" }
  if (-not $ready -or $deployedImage -notmatch [regex]::Escape($ReleaseTag) -or $deployedSourceCandidate -ne $CanonicalSourceCommit) { throw "Cloud Run is not ready on the immutable candidate-bound r49 worker (image=$deployedImage; sourceCandidate=$deployedSourceCandidate)." }

  Set-Content -LiteralPath (Join-Path $StageFunctions ".env.$ProjectId") -Encoding ascii -Value @("REVEX_ENERGY_WORKER_URL=$WorkerUrl", "REVEX_ENERGY_BROKER_SERVICE_ACCOUNT=$BrokerSa", "REVEX_SOURCE_CANDIDATE=$CanonicalSourceCommit")
  $env:FUNCTIONS_DISCOVERY_TIMEOUT = "90"
  Invoke-Native "Deploy the authenticated r49 Firebase broker" $Firebase @("deploy", "--only", "functions:revex-energy", "--project", $ProjectId, "--force") -WorkingDirectory $StageFunctions
  $function = ((Invoke-Captured "Verify ACTIVE r49 broker" $Gcloud @("functions", "describe", "runRevexEnergy", "--gen2", "--project=$ProjectId", "--region=$Region", "--format=json")).Text | ConvertFrom-Json)
  if ([string]$function.state -ne 'ACTIVE' -or [string]$function.serviceConfig.serviceAccountEmail -ne $BrokerSa) { throw "runRevexEnergy is not ACTIVE on the broker-only identity." }
  if ([int]$function.serviceConfig.timeoutSeconds -lt 3500) { throw "runRevexEnergy does not preserve the full managed-chain timeout." }

  Verify-LiveCompanion

  Write-Step "Install the verified r49 add-in atomically"
  New-Item -ItemType Directory -Path (Split-Path -Parent $InstalledRoot) -Force | Out-Null
  $oldMoved = $false
  try {
    if (Test-Path -LiteralPath $InstalledRoot) { Move-Item -LiteralPath $InstalledRoot -Destination $BackupRoot; $oldMoved = $true }
    Move-Item -LiteralPath $StagePayload -Destination $InstalledRoot
    New-Item -ItemType Directory -Path (Split-Path -Parent $AddinPath) -Force | Out-Null
    $assemblyPath = Join-Path $InstalledRoot "Liber.Revex.Revit.dll"
    $manifest = @"
<?xml version="1.0" encoding="utf-8" standalone="no"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>LIBER REVEX</Name>
    <Assembly>$assemblyPath</Assembly>
    <AddInId>DECFCABB-63FD-4E1B-9A98-2B646874D487</AddInId>
    <FullClassName>Liber.Revex.Revit.App</FullClassName>
    <VendorId>LIBR</VendorId>
    <VendorDescription>LIBER Creative LLC</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
    Set-Content -LiteralPath $AddinPath -Value $manifest -Encoding utf8
    if (-not (Test-Path -LiteralPath $assemblyPath -PathType Leaf) -or -not (Select-String -LiteralPath $AddinPath -SimpleMatch $assemblyPath -Quiet)) { throw "The installed add-in or its Revit manifest failed final verification." }
  } catch {
    if (Test-Path -LiteralPath $InstalledRoot) { Move-Item -LiteralPath $InstalledRoot -Destination ($InstalledRoot + ".failed.$RunId") -ErrorAction SilentlyContinue }
    if ($oldMoved -and (Test-Path -LiteralPath $BackupRoot)) { Move-Item -LiteralPath $BackupRoot -Destination $InstalledRoot }
    throw
  }

  Write-Log "" 
  Write-Log "REVEX r49 is published, deployed, verified and installed." Green
  Write-Log "Worker: $WorkerUrl"
  Write-Log "Broker: $($function.serviceConfig.uri)"
  Write-Log "Installed add-in: $InstalledRoot"
  Write-Log "Real 79 Energy review package (7 files + 1 archive): $ReleaseReviewPackage" Green
  if ($oldMoved) { Write-Log "Recoverable pre-r49 add-in backup: $BackupRoot" }
  $script:Preflight["publicationStatus"] = "COMPLETED"
  $script:Preflight["publicationFinishedAt"] = [DateTime]::UtcNow.ToString("o")
  Save-PreflightReport
  Write-Log "The publisher already completed real-model BIM, Spec and Energy acceptance. No Revit, Companion or Energy Sync interaction is required to finish r49 publication."
  Protect-DeploymentLogs
  if (-not $NoPause) { try { Read-Host "Press Enter to close" | Out-Null } catch { } }
} catch {
  $failure = $_
  try { Remove-BrokerIdentityProbeAuthority -BestEffort } catch { }
  try {
    if ([string]$script:Preflight.status -ne "PASSED") {
      $script:Preflight.status = "FAILED"
      $script:Preflight.finishedAt = [DateTime]::UtcNow.ToString("o")
    } else {
      $script:Preflight["publicationStatus"] = "FAILED_AFTER_LOCAL_PREFLIGHT"
      $script:Preflight["publicationFinishedAt"] = [DateTime]::UtcNow.ToString("o")
    }
    $script:Preflight["error"] = [ordered]@{ message = [string]$failure.Exception.Message; type = [string]$failure.Exception.GetType().FullName }
    Save-PreflightReport
  } catch { }
  Write-Log ""
  Write-Log "REVEX r49 publication stopped safely." Red
  Write-Log $failure.Exception.Message Red
  Write-Log "No local production server was created. Rerunning PUBLISH_REVEX_R49.cmd is safe."
  Write-Log "Exact log: $LogPath"
  Protect-DeploymentLogs
  if (-not $NoPause) { try { Read-Host "Press Enter to close" | Out-Null } catch { } }
  exit 1
}
