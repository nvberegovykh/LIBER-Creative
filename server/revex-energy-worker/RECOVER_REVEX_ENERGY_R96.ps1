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
$Work = Join-Path $env:TEMP ('revex-r96-worker-' + $SourceCandidate.Substring(0,12))

function Stage([string]$Text) { Write-Host "`n>> $Text" -ForegroundColor Cyan }
function Require([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required." }
  Write-Host "   $Name = $($cmd.Source)"
  return $cmd.Source
}
function InvokeNative([string]$Label, [string]$Exe, [string[]]$Arguments) {
  Stage $Label
  Write-Host "   $Exe $($Arguments -join ' ')" -ForegroundColor DarkGray
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ([int]$code -ne 0) { throw "$Label failed with exit code $code." }
}

try {
  Start-Transcript -Path $Log -Force | Out-Null
  Write-Host 'REVEX r96 Energy recovery - automatic project identity worker' -ForegroundColor White
  Write-Host "Exact production source: $SourceCandidate"
  Write-Host 'Scope: Energy worker only. No Revit export. No renderer. Existing broker preserved.'

  Stage 'Checking deployment dependencies'
  $Git = Require 'git'
  $GCloud = Require 'gcloud'

  # Do not duplicate gcloud auth parsing here. The production worker deploy script owns
  # its own validated auth check; this host only proves the native command can execute.
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $versionOutput = @(& $GCloud version 2>&1)
    $gcloudCode = $LASTEXITCODE
    if ($null -eq $gcloudCode) { $gcloudCode = 0 }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ([int]$gcloudCode -ne 0) { throw 'gcloud is installed but cannot execute.' }
  Write-Host "   gcloud executable check = PASS"

  Stage "Preparing exact source in $Work"
  if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  InvokeNative 'Initialize temporary Git worktree' $Git @('init',$Work)
  InvokeNative 'Attach LIBER-Creative origin' $Git @('-C',$Work,'remote','add','origin',$RepositoryUrl)
  InvokeNative 'Fetch exact merged r96 source' $Git @('-C',$Work,'fetch','--depth=1','origin',$SourceCandidate)
  InvokeNative 'Checkout exact merged r96 source' $Git @('-C',$Work,'checkout','--detach','FETCH_HEAD')

  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $Head = ((& $Git -C $Work rev-parse HEAD 2>&1) -join '').Trim()
    $gitCode = $LASTEXITCODE
    if ($null -eq $gitCode) { $gitCode = 0 }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ([int]$gitCode -ne 0 -or $Head -ne $SourceCandidate) {
    throw "Exact source verification failed. Expected $SourceCandidate, got $Head."
  }
  Write-Host "   verified HEAD = $Head" -ForegroundColor Green

  $Deploy = Join-Path $Work 'server\revex-energy-worker\DEPLOY_ENERGY_WORKER_ONLY_R69.ps1'
  if (-not (Test-Path -LiteralPath $Deploy -PathType Leaf)) { throw "Worker deployment script is missing: $Deploy" }

  InvokeNative 'Deploy exact r96 private Energy worker' 'powershell.exe' @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',$Deploy,
    '-ProjectId',$ProjectId,'-Region',$Region,'-Service',$Service,
    '-SourceCandidate',$SourceCandidate,'-NoPause'
  )

  Stage 'Verifying live worker source and readiness'
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $jsonLines = @(& $GCloud run services describe $Service "--project=$ProjectId" "--region=$Region" '--format=json' 2>&1)
    $verifyCode = $LASTEXITCODE
    if ($null -eq $verifyCode) { $verifyCode = 0 }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ([int]$verifyCode -ne 0) { throw 'Could not re-read deployed Cloud Run service.' }
  $run = (($jsonLines | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
  $ready = @($run.status.conditions | Where-Object { $_.type -eq 'Ready' } | Select-Object -First 1)
  if ($ready.Count -eq 0 -or [string]$ready[0].status -ne 'True') { throw 'Cloud Run did not report Ready=True.' }
  $liveSource = ''
  foreach ($container in @($run.spec.template.spec.containers)) {
    foreach ($envRow in @($container.env)) {
      if ([string]$envRow.name -eq 'REVEX_SOURCE_CANDIDATE') { $liveSource = [string]$envRow.value }
    }
  }
  if ($liveSource -ne $SourceCandidate) { throw "Live worker source mismatch. Expected $SourceCandidate, got $liveSource." }

  Write-Host '   Ready=True'
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
  if (Test-Path -LiteralPath $Work) {
    try { Remove-Item -LiteralPath $Work -Recurse -Force } catch {}
  }
  try { Stop-Transcript | Out-Null } catch {}
  try { Copy-Item -LiteralPath $Log -Destination $Latest -Force } catch {}
  Write-Host "Persistent log: $Latest"
}
exit $ExitCode
