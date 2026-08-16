$ErrorActionPreference = 'Stop'
$SourceCandidate = '6ffbbb9b36966f7e68d61969f54e06b498600f3a'
$RepositoryUrl = 'https://github.com/nvberegovykh/LIBER-Creative.git'
$ProjectId = 'liber-apps-cca20'
$Region = 'us-central1'
$Service = 'revex-energy-worker'
$LogRoot = Join-Path $env:LOCALAPPDATA 'LIBER\REVEX\Logs'
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Log = Join-Path $LogRoot "RECOVER_REVEX_ENERGY_R96.$Stamp.log"
$Latest = Join-Path $LogRoot 'RECOVER_REVEX_ENERGY_CURRENT.latest.log'
$ExitCode = 1
try {
  Start-Transcript -Path $Log -Force | Out-Null
  function Stage([string]$Text) { Write-Host "`n>> $Text" -ForegroundColor Cyan }
  function Require([string]$Name) {
    $c = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { throw "$Name is required." }
    Write-Host "   $Name = $($c.Source)"
    return $c.Source
  }
  function Native([string]$Label,[string]$Exe,[string[]]$Args) {
    Stage $Label
    $old = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $Exe @Args
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
    } finally { $ErrorActionPreference = $old }
    if ([int]$code -ne 0) { throw "$Label failed with exit code $code." }
  }

  Write-Host 'REVEX r96 Energy recovery - automatic project identity worker' -ForegroundColor White
  Write-Host "Exact production source: $SourceCandidate"
  Write-Host 'Scope: Energy worker only. No Revit export. No renderer. Existing broker preserved.'

  Stage 'Checking deployment dependencies and Google Cloud authentication'
  $Git = Require 'git'
  $GCloud = Require 'gcloud'
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $authArgs = @('auth','list','--filter=status:ACTIVE','--format=value(account)')
    $active = @(& $GCloud @authArgs) | Where-Object { $_ }
    $authCode = $LASTEXITCODE
    if ($null -eq $authCode) { $authCode = 0 }
  } finally { $ErrorActionPreference = $old }
  if ([int]$authCode -ne 0 -or $active.Count -eq 0) { throw "Google Cloud authentication is missing. Run 'gcloud auth login' once, then rerun this same file." }
  Write-Host "   gcloud account = $($active[0])"

  $Work = Join-Path $env:TEMP ('revex-r96-worker-' + $SourceCandidate.Substring(0,12))
  Stage "Preparing exact source in $Work"
  if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  Native 'Initialize temporary Git worktree' $Git @('-C',$Work,'init')
  Native 'Attach LIBER-Creative origin' $Git @('-C',$Work,'remote','add','origin',$RepositoryUrl)
  Native 'Fetch exact merged r96 source' $Git @('-C',$Work,'fetch','--depth=1','origin',$SourceCandidate)
  Native 'Checkout exact merged r96 source' $Git @('-C',$Work,'checkout','--detach','FETCH_HEAD')
  $Head = (& $Git -C $Work rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $Head -ne $SourceCandidate) { throw "Exact source verification failed. Expected $SourceCandidate, got $Head." }
  Write-Host "   verified HEAD = $Head" -ForegroundColor Green

  $Deploy = Join-Path $Work 'server\revex-energy-worker\DEPLOY_ENERGY_WORKER_ONLY_R69.ps1'
  if (-not (Test-Path -LiteralPath $Deploy -PathType Leaf)) { throw "Worker deployment script is missing: $Deploy" }
  Stage 'Deploying exact r96 private Energy worker'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Deploy -ProjectId $ProjectId -Region $Region -Service $Service -SourceCandidate $SourceCandidate -NoPause
  $deployCode = $LASTEXITCODE
  if ($null -eq $deployCode) { $deployCode = 0 }
  if ([int]$deployCode -ne 0) { throw "Exact worker deployment failed with exit code $deployCode." }

  Stage 'Verifying live worker source and readiness'
  $jsonText = (& $GCloud run services describe $Service --project=$ProjectId --region=$Region --format=json) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'Could not re-read deployed Cloud Run service.' }
  $run = $jsonText | ConvertFrom-Json
  $ready = @($run.status.conditions | Where-Object { $_.type -eq 'Ready' } | Select-Object -First 1)
  if ($ready.Count -eq 0 -or [string]$ready[0].status -ne 'True') { throw 'Cloud Run did not report Ready=True.' }
  $liveSource = ''
  foreach ($container in @($run.spec.template.spec.containers)) {
    foreach ($envRow in @($container.env)) {
      if ([string]$envRow.name -eq 'REVEX_SOURCE_CANDIDATE') { $liveSource = [string]$envRow.value }
    }
  }
  if ($liveSource -ne $SourceCandidate) { throw "Live worker source mismatch. Expected $SourceCandidate, got $liveSource." }

  Write-Host "   Ready=True"
  Write-Host "   REVEX_SOURCE_CANDIDATE=$liveSource"
  Write-Host "`nPASS: LIVE REVEX ENERGY WORKER IS EXACT r96." -ForegroundColor Green
  Write-Host 'Do NOT run SYNC ENGINEERING again. Reload Energy and retry eng_20260816T184350040Z.' -ForegroundColor Green
  $ExitCode = 0
} catch {
  Write-Host "`nREVEX r96 RECOVERY FAILED" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Log: $Log" -ForegroundColor Yellow
  $ExitCode = 1
} finally {
  try { Stop-Transcript | Out-Null } catch {}
  try { Copy-Item -LiteralPath $Log -Destination $Latest -Force } catch {}
  Write-Host "Persistent log: $Latest"
}
exit $ExitCode
