param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-energy-worker",
  [string]$GitHubRepository = "nvberegovykh/LIBER-Creative",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Root = (Resolve-Path $PSScriptRoot).Path
$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$ReleaseTag = "0.8.19-r49"
$Build = "20260813r49"
$StageRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX-R49-Publish\$RunId"
$StageSource = Join-Path $StageRoot "source"
$StageFunctions = Join-Path $StageSource "server\firebase-functions"
$StageRules = Join-Path $StageRoot "live-rules-gate"
$StagePayload = Join-Path $StageRoot "addin-payload"
$RepoRoot = Join-Path $StageRoot "LIBER-Creative"
$InstalledRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\App"
$BackupRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\App.before-r49.$RunId"
$AddinPath = Join-Path $env:APPDATA "Autodesk\Revit\Addins\2026\LIBER.REVEX.addin"
$RevitDir = "C:\Program Files\Autodesk\Revit 2026"
$LiveUrl = "https://liberpict.com/liber-apps/apps/revex/index.html"
$LogPath = Join-Path $Root "PUBLISH_REVEX_R49.$RunId.log"
$LatestLogPath = Join-Path $Root "PUBLISH_REVEX_R49.latest.log"
$PreflightLatestPath = Join-Path $Root "REVEX-R49-PREFLIGHT.latest.json"
$PreflightStagePath = Join-Path $StageRoot "REVEX-R49-PREFLIGHT.json"
$CompanionSimulationReport = Join-Path $StageRoot "REVEX-R49-COMPANION-SIMULATION.json"
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

function Test-BrokerIdentityWorkerInvocation(
  [string]$Gcloud,
  [string]$BrokerSa,
  [string]$DeployerMember,
  [string]$WorkerUrl
) {
  Write-Step "Prove the deployed broker identity can invoke the private r49 worker"
  $saPolicy = ((Invoke-Captured "Inspect broker token-creation policy" $Gcloud @(
    "iam", "service-accounts", "get-iam-policy", $BrokerSa, "--project=$ProjectId", "--format=json"
  )).Text | ConvertFrom-Json)
  $oidcRole = "roles/iam.serviceAccountOpenIdTokenCreator"
  $tokenCreators = @(Get-IamRoleMembers $saPolicy $oidcRole)
  $temporaryGrant = $DeployerMember -notin $tokenCreators
  $identityToken = $null
  try {
    if ($temporaryGrant) {
      Invoke-Native "Grant temporary broker OIDC-token test authority" $Gcloud @(
        "iam", "service-accounts", "add-iam-policy-binding", $BrokerSa,
        "--project=$ProjectId", "--member=$DeployerMember",
        "--role=$oidcRole", "--quiet"
      )
    }
    for ($attempt = 1; $attempt -le 12 -and -not $identityToken; $attempt++) {
      $tokenResult = Invoke-SecretCaptured "Mint one bounded broker identity token without logging it (attempt $attempt/12)" $Gcloud @(
        "auth", "print-identity-token",
        "--impersonate-service-account=$BrokerSa",
        "--audiences=$WorkerUrl",
        "--include-email",
        "--quiet"
      ) -AllowFailure
      if ($tokenResult.ExitCode -eq 0) {
        $identityToken = [string]($tokenResult.Lines |
          Where-Object { [string]$_ -match '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' } |
          Select-Object -Last 1)
      }
      if (-not $identityToken -and $attempt -lt 12) {
        Write-Log "Broker OIDC-token authority is not effective yet; waiting five seconds before the bounded retry." DarkYellow
        Start-Sleep -Seconds 5
      }
    }
    if (-not $identityToken) { throw "Google Cloud did not mint the bounded broker identity token." }
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($WorkerUrl + "/healthz") -Headers @{ Authorization = "Bearer $identityToken" } -TimeoutSec 20
    if ([int]$response.StatusCode -ne 200) { throw "The broker identity health probe returned HTTP $($response.StatusCode)." }
    $health = $response.Content | ConvertFrom-Json
    if ($health.ok -ne $true -or [string]$health.version -ne $ReleaseTag -or [string]$health.service -ne "REVEX Energy Worker") {
      throw "The broker identity reached an unexpected worker payload."
    }
    Add-PreflightCheckpoint "BROKER_TO_PRIVATE_WORKER_SMOKE" ([ordered]@{
      authenticatedIdentity = $BrokerSa
      workerVersion = [string]$health.version
      healthStatus = 200
      temporaryOidcTokenCreatorGrantRemoved = $temporaryGrant
    })
    Write-Log "Authenticated broker-identity invocation succeeded against the exact private r49 worker." Green
  } finally {
    $identityToken = $null
    if ($temporaryGrant) {
      Invoke-Native "Remove temporary broker OIDC-token test authority" $Gcloud @(
        "iam", "service-accounts", "remove-iam-policy-binding", $BrokerSa,
        "--project=$ProjectId", "--member=$DeployerMember",
        "--role=$oidcRole", "--quiet"
      )
    }
  }
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

try {
  Save-PreflightReport
  Write-Log "REVEX 0.8.19 r49 production publisher" White
  Write-Log "Authority: active Revit document -> evidence-verified project -> immutable BIM/Spec/Energy revisions"
  Write-Log "Energy: T/Z identity + EN facts -> GeometryCo -> two OSMs -> two EnergyPlus runs -> official COMcheck -> EN-1"
  Write-Log "Project: $ProjectId  Region: $Region  Repository: $GitHubRepository"
  Write-Log "Log: $LogPath"

  Write-Step "Verify Revit is closed for the final atomic add-in replacement"
  if (Get-Process -Name Revit -ErrorAction SilentlyContinue) { throw "Close every Revit window, then rerun PUBLISH_REVEX_R49.cmd. This is the only required manual preparation." }
  if (-not (Test-Path -LiteralPath (Join-Path $RevitDir "RevitAPI.dll") -PathType Leaf)) { throw "Autodesk Revit 2026 was not found at $RevitDir." }

  Write-Step "Verify hash-locked r49 source"
  $Expected = [ordered]@{
    ".github\workflows\revex-r27-0819-engineering-release.yml" = "dcc4c02966b2fa3a83ebf567a7857b116841fe23662cca04b8bdda2818e89521"
    ".github\scripts\verify-revex-r49.js" = "22fdc385004e2352d4f6bb41731efa02376ad15c0c56d236a61b36f3dd0920bc"
    ".github\scripts\verify-revex-r49-live-rules.js" = "8e4bf1e40eb44256dad8969849a0ac3bd91c74895492e648c07ea696503b93ae"
    ".github\scripts\patch-live-firestore-rules.js" = "8662ad8bb3a9c1090d25421538161245e534306f894839113a50a7f5ab803d2d"
    ".github\scripts\fixtures\live-firestore-base.rules" = "ba4ee3c8757dd6e745809214b2b6008e430d54dcdc585900124a38d7db6acf01"
    "src\Liber.Revex.Revit\Liber.Revex.Revit.csproj" = "4cca18fe25c936d7bbde564549a7765baeacfede08835fc76a033d2f812dabfa"
    "src\Liber.Revex.Revit\App.cs" = "da962524e69247fdc48d73cc10cb9b8998f465df5f551b09ada35c989f38a276"
    "src\Liber.Revex.Revit\Models\RevitRequest.cs" = "54173d73c948d29a1c77360f696d3f27212a43bd4fc584e7f6f9ff8d81f8d359"
    "src\Liber.Revex.Revit\Models\RevexSyncModels.cs" = "5699e3d81f1dfb98be9b2d18c620867281e7a47043a99ceb0520ff2cd396ff3b"
    "src\Liber.Revex.Revit\Revit\RevitRequestHandler.cs" = "068dd2a78799ce4e2da2c94d399ca2131ec79563298c82def2362ab26945f932"
    "src\Liber.Revex.Revit\UI\RendairWindow.cs" = "03ad436ab81540e59625caad89e1774251d08ff58700c29be553cfffb7a1911f"
    "src\Liber.Revex.Revit\UI\RendairWindowManager.cs" = "e2b21d9c49b599bd3214299e3d472bee2cc39464ee708d6641afb074cc26b14e"
    "src\Liber.Revex.Revit\Services\SettingsService.cs" = "bec8072046e9a7f1bb09b79db5d7ac5f87cae30edbc75bc47fcff3311ec3311f"
    "src\Liber.Revex.Revit\Services\ProjectIdentityEvidenceService.cs" = "6cef37b8ee6be7d3a9a9b6df08bbb7cae814fa8cc28316ce64a9d23048cb704a"
    "src\Liber.Revex.Revit\Services\RevexSyncService.cs" = "3f8fe253aa2bce8655176fbe96cd14e571f6aaa4ef78ff5d50780b6247e9e45d"
    "src\Liber.Revex.Revit\Services\RevexMeshExportService.cs" = "a5759ee9e386fcd5b0459d9ec9aa3344ffc9b358deaef56fd3c3e77cd1f18024"
    "src\Liber.Revex.Revit\Services\ViewerExportService.cs" = "7712e5a610ae3421ce1c23bfddcb4de8f48c0ceedc89bb9854b059605e1de088"
    "src\Liber.Revex.Revit\Services\DesignBookScheduleService.cs" = "c9f0c97b1f91131a61119f7dc88199408e8c5ab1ab92397d9845448d6680b6bb"
    "src\Liber.Revex.Revit\Services\EngineeringSyncService.cs" = "bb6255c9a39e722d82c37ee46d0357a70cca6fd8e9886aa4bebb300bab20731e"
    "src\Liber.Revex.Revit\Services\GbxmlEngineeringService.cs" = "fdb9001818ca558b069bb49fb5dc39317a73554d3763a33ba4e404b5c8e3c3c6"
    "src\Liber.Revex.Revit\Services\EngineeringCompanionWebBridge.cs" = "f763c77c0b514a9d404e2f98cefccd323deb98c73edc248dd741d5d133449184"
    "src\Liber.Revex.Revit\Engineering\Companion\native-managed-energy-bridge.js" = "82d6442254f468533532d88eedd63112f30a2fc1e407b47e1f86ac1b9ba726d2"
    "src\Liber.Revex.Revit\Engineering\Energy\revex_energy_pipeline.py" = "5daa186c61cdff8913ae48eca52bfbafa158eb8e74045550bc894d5c5cd034b2"
    "src\Liber.Revex.Revit\Engineering\Energy\comcheck_backstop.py" = "ed817d0832f64fc9c1f6bfabc3bc79d010b4cd84d192884d41d494df77809d10"
    "src\Liber.Revex.Revit\Engineering\Energy\verify_revex_r49_energy.py" = "1ffcbf30b5511d3ea7017f79156ef9084af910d653c2da8f694f1acb8d507fe4"
    "src\Liber.Revex.Revit\Engineering\Energy\requirements.txt" = "e9dde285ed5fa05c6161325ccdd2906d9d9f6d6693979f1df9078c82eb98e673"
    "src\Liber.Revex.Revit\Engineering\Energy\GeometryCo\OpenStudio_Energy_Model_Geometry_Compiler.py" = "0152e06c447b36457fc973b2896d82b68596a03bdc855a519dbcd0bda253ee9f"
    "src\Liber.Revex.Revit\Engineering\Energy\Packager\EnergyPlusReviewPackager.py" = "30ba0b2f3e1fee952382d016c68caa5dea85d7d68b439296797da5adf7f412f2"
    "src\Liber.Revex.Revit\Engineering\Energy\gbxml_to_osm.rb" = "d8e5532f147fc71f76e4b0378737caacce6722dbc477687c9e0d0331a87e1c4c"
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
    "server\revex-energy-worker\app.py" = "c605b77f220bc854cef57c2cafaf116b54a61bcd4ec2873e3b93d595af1791bb"
    "server\revex-energy-worker\verify_revex_r49_worker.py" = "67e529c6537adb90edf68ca3f48d37f4c155b4d0fcadbfb9f455b0aafa07eeac"
    "server\revex-energy-worker\Dockerfile" = "391914808925175516845312d329b229af970c86e7fabc5d380ef33fa9594a86"
    "server\revex-energy-worker\cloudbuild.yaml" = "447f2e67bcc22cfb498a352d6d95ba9061f7c282df176464b492c3458130acc5"
    "server\revex-energy-worker\requirements-server.txt" = "f35c6f0f9355c7008cee71e693f729b66b138ed63b8be9a124659a31e24b5863"
    "server\firebase-functions\index.js" = "952e4b2eb4b081b10dd4ef254e3c7ac0033a6fdec960d9384d1e5c540c938865"
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
  }
  foreach ($entry in $Expected.GetEnumerator()) { Assert-SourceHash $entry.Key $entry.Value }

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

  Write-Step "Create isolated r49 offline preflight stage"
  New-Item -ItemType Directory -Path $StageSource, $StagePayload, $StageRules -Force | Out-Null
  Copy-SourceTree (Join-Path $Root "server\revex-energy-worker") (Join-Path $StageSource "server\revex-energy-worker")
  Copy-SourceTree (Join-Path $Root "server\firebase-functions") $StageFunctions
  Copy-SourceTree (Join-Path $Root "src\Liber.Revex.Revit\Engineering\Energy") (Join-Path $StageSource "src\Liber.Revex.Revit\Engineering\Energy")
  Copy-SourceTree (Join-Path $Root "firebase\r49-live-rules") $StageRules
  Copy-Item -LiteralPath (Join-Path $Root ".github\scripts\verify-revex-r49-live-rules.js") -Destination (Join-Path $StageRules "verify-revex-r49-live-rules.js") -Force
  Invoke-Native "Install pinned Firebase Rules emulator dependencies" $Npm @("ci", "--no-audit", "--no-fund") -WorkingDirectory $StageRules
  Invoke-Native "Reject high or critical Firebase Rules gate dependency advisories" $Npm @("audit", "--audit-level=high") -WorkingDirectory $StageRules
  Invoke-Native "Prepare representative preserved project-access rules" $Node @(
    ".github\scripts\patch-live-firestore-rules.js",
    ".github\scripts\fixtures\live-firestore-base.rules",
    "firebase\revex-project-access-r43.rules",
    (Join-Path $StageRules "firestore.rules")
  ) -WorkingDirectory $Root
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

  Invoke-Native "Simulate recorded-Revit BIM, Books, viewer and managed-Energy handoff" $Node @(".github\scripts\verify-revex-r49.js", "--report", $CompanionSimulationReport) -WorkingDirectory $Root
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
  Invoke-Native "Parse live Companion" $Node @("--check", (Join-Path $Root "src\Live-Companion\app.js"))
  Invoke-Native "Parse progressive BIM viewer" $Node @("--check", (Join-Path $Root "src\Live-Companion\viewer-r26.js"))
  Invoke-Native "Parse Engineering cloud store" $Node @("--check", (Join-Path $Root "src\Live-Companion\store.js"))
  Invoke-Native "Parse revision-scoped managed Energy bridge" $Node @("--check", (Join-Path $Root "src\Liber.Revex.Revit\Engineering\Companion\native-managed-energy-bridge.js"))
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

  $projectFile = Join-Path $Root "src\Liber.Revex.Revit\Liber.Revex.Revit.csproj"
  Invoke-Native "Restore locked .NET dependencies" $Dotnet @("restore", $projectFile)
  Invoke-Native "Compile REVEX r49 against Revit 2026 (warnings, errors and full binlog retained)" $Dotnet @("build", $projectFile, "-c", "Release", "--no-restore", "-nologo", "-clp:WarningsOnly;ErrorsOnly;Summary", "-bl:$BuildBinlog", "-p:RevitInstallDir=$RevitDir", "-o", $StagePayload)
  foreach ($relative in @("Liber.Revex.Revit.dll", "Microsoft.Web.WebView2.Core.dll", "Engineering\Energy\revex_energy_pipeline.py", "Engineering\Energy\verify_revex_r49_energy.py", "Engineering\Companion\native-managed-energy-bridge.js")) {
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
  Invoke-Native "Install exact Energy and managed-worker QA dependencies" $VenvPython @("-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--requirement", (Join-Path $Root "src\Liber.Revex.Revit\Engineering\Energy\requirements.txt"), "--requirement", (Join-Path $Root "server\revex-energy-worker\requirements-server.txt"))
  Invoke-Native "Run current-project CXL, OSM identity, COMcheck protocol and EN-1 QA" $VenvPython @((Join-Path $Root "src\Liber.Revex.Revit\Engineering\Energy\verify_revex_r49_energy.py")) -WorkingDirectory (Join-Path $Root "src\Liber.Revex.Revit\Engineering\Energy")
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
  Invoke-Native "Run managed worker artifact, binding, T/Z and revision-consent QA" $VenvPython @((Join-Path $Root "server\revex-energy-worker\verify_revex_r49_worker.py")) -WorkingDirectory (Join-Path $Root "server\revex-energy-worker")
  Add-PreflightCheckpoint "PRIVATE_WORKER_CONTRACT" ([ordered]@{
    artifactIntegrity = $true
    activeDocumentBinding = $true
    crossRevisionConsentRejected = $true
    cloudCredentialsUsed = $false
  })
  Invoke-Native "Install exact Firebase broker dependencies" $Npm @("ci", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $StageFunctions
  Invoke-Native "Reject moderate, high or critical Firebase broker dependency advisories" $Npm @("audit", "--omit=dev", "--audit-level=moderate") -WorkingDirectory $StageFunctions
  Add-PreflightCheckpoint "FIREBASE_BROKER_DEPENDENCIES" ([ordered]@{
    lockfileInstall = $true
    moderateHighCriticalAdvisories = 0
    productionDependenciesOnly = $true
  })

  $script:Preflight.status = "PASSED"
  $script:Preflight.finishedAt = [DateTime]::UtcNow.ToString("o")
  Save-PreflightReport
  Write-Log "Offline r49 release gate PASSED before GitHub or production-cloud mutation." Green
  Write-Log "Recorded preflight: $PreflightLatestPath" Green

  $Git = Resolve-Executable @("git.exe", "git")
  if (-not $Git) { Install-WingetPackage "Git.Git" "Git"; $Git = Resolve-Executable @("git.exe", "git") }
  $Gh = Resolve-Executable @("gh.exe", "gh")
  if (-not $Gh) { Install-WingetPackage "GitHub.cli" "GitHub CLI"; $Gh = Resolve-Executable @("gh.exe", "gh") }
  $Gcloud = Resolve-Executable @("gcloud.cmd", "gcloud.exe", "gcloud")
  if (-not $Gcloud) { Install-WingetPackage "Google.CloudSDK" "Google Cloud CLI"; $Gcloud = Resolve-Executable @("gcloud.cmd", "gcloud.exe", "gcloud") }
  foreach ($tool in @($Git,$Gh,$Gcloud,$Firebase)) { if (-not $tool) { throw "A required publishing tool did not become available after the offline gate." } }

  $ghAuth = Invoke-Captured "Verify GitHub authentication" $Gh @("auth", "status", "--hostname", "github.com") -AllowFailure
  if ($ghAuth.ExitCode -ne 0) { Invoke-InteractiveNoLog "Essential GitHub approval" $Gh @("auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web") }
  Invoke-Native "Configure GitHub authentication for Git" $Gh @("auth", "setup-git")

  Invoke-Native "Clone the authoritative GitHub repository" $Gh @("repo", "clone", $GitHubRepository, $RepoRoot, "--", "--depth", "1")
  $branch = "agent/revex-r49-final-$RunId"
  Invoke-Native "Create isolated r49 publication branch" $Git @("checkout", "-b", $branch) -WorkingDirectory $RepoRoot
  Copy-SourceTree (Join-Path $Root "src\Live-Companion") (Join-Path $RepoRoot "docs\liber-apps\apps\revex")
  Copy-SourceTree (Join-Path $Root "src\Liber.Revex.Revit") (Join-Path $RepoRoot "src\Liber.Revex.Revit")
  Copy-SourceTree (Join-Path $Root "server\revex-energy-worker") (Join-Path $RepoRoot "server\revex-energy-worker")
  Copy-SourceTree (Join-Path $Root "server\firebase-functions") (Join-Path $RepoRoot "server\firebase-functions")
  New-Item -ItemType Directory -Path (Join-Path $RepoRoot "firebase") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root "firebase\revex-project-access-r43.rules") -Destination (Join-Path $RepoRoot "firebase\revex-project-access-r43.rules") -Force
  Copy-SourceTree (Join-Path $Root "firebase\r49-live-rules") (Join-Path $RepoRoot "firebase\r49-live-rules")
  New-Item -ItemType Directory -Path (Join-Path $RepoRoot ".github\scripts") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root ".github\scripts\verify-revex-r49.js") -Destination (Join-Path $RepoRoot ".github\scripts\verify-revex-r49.js") -Force
  Copy-Item -LiteralPath (Join-Path $Root ".github\scripts\verify-revex-r49-live-rules.js") -Destination (Join-Path $RepoRoot ".github\scripts\verify-revex-r49-live-rules.js") -Force
  Copy-Item -LiteralPath (Join-Path $Root ".github\scripts\patch-live-firestore-rules.js") -Destination (Join-Path $RepoRoot ".github\scripts\patch-live-firestore-rules.js") -Force
  New-Item -ItemType Directory -Path (Join-Path $RepoRoot ".github\scripts\fixtures") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root ".github\scripts\fixtures\live-firestore-base.rules") -Destination (Join-Path $RepoRoot ".github\scripts\fixtures\live-firestore-base.rules") -Force
  New-Item -ItemType Directory -Path (Join-Path $RepoRoot ".github\workflows") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root ".github\workflows\revex-r27-0819-engineering-release.yml") -Destination (Join-Path $RepoRoot ".github\workflows\revex-r27-0819-engineering-release.yml") -Force
  Copy-Item -LiteralPath (Join-Path $Root "PUBLISH_REVEX_R49.ps1") -Destination (Join-Path $RepoRoot "PUBLISH_REVEX_R49.ps1") -Force
  Copy-Item -LiteralPath (Join-Path $Root "PUBLISH_REVEX_R49.cmd") -Destination (Join-Path $RepoRoot "PUBLISH_REVEX_R49.cmd") -Force
  Invoke-Native "Stage only the r49 release" $Git @("add", "--",
    "docs/liber-apps/apps/revex", "src/Liber.Revex.Revit",
    "server/revex-energy-worker", "server/firebase-functions",
    "firebase/revex-project-access-r43.rules", "firebase/r49-live-rules",
    ".github/scripts/verify-revex-r49.js",
    ".github/scripts/verify-revex-r49-live-rules.js",
    ".github/scripts/patch-live-firestore-rules.js",
    ".github/scripts/fixtures/live-firestore-base.rules",
    ".github/workflows/revex-r27-0819-engineering-release.yml",
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
    $reuseWorker = $existingReady -and $existingImage.Contains($ReleaseTag)
  }
  if ($reuseWorker) {
    Write-Log "Pinned r49 private worker is already ready; skipping duplicate image build and Cloud Run deployment." Green
  } else {
    Invoke-Native "Build, test and push the immutable r49 worker image" $Gcloud @("builds", "submit", "--project=$ProjectId", "--config=server/revex-energy-worker/cloudbuild.yaml", "--substitutions=_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-energy-worker,_TAG=$ReleaseTag", ".") -WorkingDirectory $StageSource
    Invoke-Native "Deploy the private r49 Energy worker" $Gcloud @("run", "deploy", $Service, "--project=$ProjectId", "--region=$Region", "--image=$Image", "--service-account=$WorkerSa", "--no-allow-unauthenticated", "--cpu=4", "--memory=8Gi", "--concurrency=1", "--min-instances=0", "--max-instances=3", "--timeout=3600", "--set-env-vars=REVEX_ENERGY_TIMEOUT_SECONDS=3500,REVEX_VERTEX_PROJECT=$ProjectId,REVEX_VERTEX_LOCATION=global", "--quiet")
  }
  $WorkerUrl = (Invoke-Captured "Resolve deployed worker URL" $Gcloud @("run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=value(status.url)")).Text.Trim()
  if (-not $WorkerUrl) { throw "Cloud Run did not expose the private r49 worker URL." }
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
  try {
    $unexpected = Invoke-WebRequest -UseBasicParsing -Uri ($WorkerUrl + "/healthz") -TimeoutSec 15
    if ($unexpected.StatusCode -eq 200) { throw "Private worker unexpectedly allowed unauthenticated invocation." }
  } catch {
    $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
    if ($status -notin @(401,403,404)) { throw }
    Write-Log "Private worker correctly denied or concealed the unauthenticated health probe ($status)." Green
  }
  Test-BrokerIdentityWorkerInvocation $Gcloud $BrokerSa $deployerMember $WorkerUrl
  Write-Log "The broker service account is the sole dedicated runtime invoker binding for this worker. Project administrators retain administrative authority by design." Green
  $runState = ((Invoke-Captured "Verify ready r49 Cloud Run revision" $Gcloud @("run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")).Text | ConvertFrom-Json)
  $deployedImage = [string]$runState.spec.template.spec.containers[0].image
  $ready = @($runState.status.conditions | Where-Object { $_.type -eq 'Ready' -and [string]$_.status -eq 'True' }).Count -gt 0
  if (-not $ready -or $deployedImage -notmatch [regex]::Escape($ReleaseTag)) { throw "Cloud Run is not ready on the immutable r49 image (image=$deployedImage)." }

  Set-Content -LiteralPath (Join-Path $StageFunctions ".env.$ProjectId") -Encoding ascii -Value @("REVEX_ENERGY_WORKER_URL=$WorkerUrl", "REVEX_ENERGY_BROKER_SERVICE_ACCOUNT=$BrokerSa")
  $env:FUNCTIONS_DISCOVERY_TIMEOUT = "90"
  Invoke-Native "Deploy the authenticated r49 Firebase broker" $Firebase @("deploy", "--only", "functions:revex-energy:runRevexEnergy", "--project", $ProjectId, "--force") -WorkingDirectory $StageFunctions
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
  if ($oldMoved) { Write-Log "Recoverable pre-r49 add-in backup: $BackupRoot" }
  $script:Preflight["publicationStatus"] = "COMPLETED"
  $script:Preflight["publicationFinishedAt"] = [DateTime]::UtcNow.ToString("o")
  Save-PreflightReport
  Write-Log "Reopen Revit 2026 and run each sync once from the intended active document. The only workflow approval is the modal current-revision COMcheck authorization; it cannot approve later revisions."
  Protect-DeploymentLogs
  if (-not $NoPause) { try { Read-Host "Press Enter to close" | Out-Null } catch { } }
} catch {
  $failure = $_
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
