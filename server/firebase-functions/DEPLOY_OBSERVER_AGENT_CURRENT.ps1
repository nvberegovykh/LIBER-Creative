param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$FunctionsDir = $PSScriptRoot
$Verifier = Join-Path $Root '.github\scripts\verify-revex-observer-agent-gate-r151.js'
$ObserverSaName = 'revex-observer-broker'
$ObserverSa = "$ObserverSaName@$ProjectId.iam.gserviceaccount.com"
$ExitCode = 1
$Functions = @(
  'issueRevexObserverAnonymousClaim',
  'issueRevexObserverPairCode',
  'claimRevexObserverAgentSession',
  'pullRevexObserverAgentRequests',
  'completeRevexObserverAgentRequest',
  'revexObserverMcp'
)

function Require-Command([string[]]$Names,[string]$Purpose){
  foreach($name in $Names){
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if($cmd){ return $cmd.Source }
  }
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}
function Invoke-Native([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory='',[switch]$Quiet){
  $previous = $ErrorActionPreference
  try{
    $ErrorActionPreference = 'Continue'
    if($WorkingDirectory){ Push-Location $WorkingDirectory }
    try{
      if($Quiet){ & $Command @Arguments *> $null }
      else { & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) } }
      $code = $LASTEXITCODE
      if($null -eq $code){ $code = 0 }
      return [int]$code
    } finally { if($WorkingDirectory){ Pop-Location } }
  } finally { $ErrorActionPreference = $previous }
}
function Capture-Native([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory=''){
  $previous = $ErrorActionPreference
  try{
    $ErrorActionPreference = 'Continue'
    if($WorkingDirectory){ Push-Location $WorkingDirectory }
    try{
      $lines = @(& $Command @Arguments 2>$null | ForEach-Object { [string]$_ })
      $code = $LASTEXITCODE
      if($null -eq $code){ $code = 0 }
      return [pscustomobject]@{ Code=[int]$code; Text=($lines -join "`n").Trim() }
    } finally { if($WorkingDirectory){ Pop-Location } }
  } finally { $ErrorActionPreference = $previous }
}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments,[string]$WorkingDirectory='',[switch]$Quiet){
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code = Invoke-Native $Command $Arguments $WorkingDirectory -Quiet:$Quiet
  if($code -ne 0){ throw "$Label failed with exit code $code." }
}
function Native-Ok([string]$Command,[string[]]$Arguments){ return (Invoke-Native $Command $Arguments -Quiet) -eq 0 }
function Member-ForAccount([string]$Account){
  if($Account -match '\.gserviceaccount\.com$'){ return "serviceAccount:$Account" }
  return "user:$Account"
}
function Ensure-ProjectRole([string]$GCloud,[string]$Role,[string]$Label){
  Require-Ok $Label $GCloud @('projects','add-iam-policy-binding',$ProjectId,'--member',"serviceAccount:$ObserverSa",'--role',$Role,'--quiet') '' -Quiet
}
function Get-Function([string]$GCloud,[string]$Name){
  $state = Capture-Native $GCloud @('functions','describe',$Name,'--gen2','--project',$ProjectId,'--region',$Region,'--format','json')
  if($state.Code -ne 0 -or -not $state.Text){ throw "$Name could not be read after deployment." }
  return ($state.Text | ConvertFrom-Json)
}
function Verify-Function([string]$GCloud,[string]$Name){
  $fn = Get-Function $GCloud $Name
  if([string]$fn.state -ne 'ACTIVE'){ throw "$Name is not ACTIVE after deployment (state=$($fn.state))." }
  if([string]$fn.buildConfig.runtime -ne 'nodejs22'){ throw "$Name runtime is not nodejs22." }
  if([string]$fn.serviceConfig.serviceAccountEmail -ne $ObserverSa){ throw "$Name runtime identity mismatch: $($fn.serviceConfig.serviceAccountEmail)" }
  if([string]$fn.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE -ne $SourceCandidate){ throw "$Name source SHA binding mismatch." }
  if(-not [string]$fn.serviceConfig.uri -and -not [string]$fn.url){ throw "$Name has no service URI." }
  return $fn
}
function Public-Url([object]$Fn){
  $url=[string]$Fn.url
  if(-not $url){$url=[string]$Fn.serviceConfig.uri}
  if(-not $url){throw 'Function has no HTTP URL.'}
  return $url
}
function Service-Name([object]$Fn){
  $service=[string]$Fn.serviceConfig.service
  if(-not $service){throw 'Function has no backing Cloud Run service.'}
  return ($service -split '/')[-1]
}
function Probe-PublicTransport([string]$Uri){
  try{
    $r=Invoke-WebRequest -Uri $Uri -Method Options -UseBasicParsing -TimeoutSec 30
    return ([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 500)
  }catch{
    $status='';try{$status=[int]$_.Exception.Response.StatusCode}catch{}
    return ($status -ne 401 -and $status -ne 403)
  }
}
function Ensure-PublicTransport([string]$GCloud,[string]$Name,[object]$Fn){
  $service=Service-Name $Fn
  $url=Public-Url $Fn
  Write-Host ">> Verify unauthenticated HTTP transport for $Name" -ForegroundColor DarkCyan
  $bind=Invoke-Native $GCloud @('run','services','add-iam-policy-binding',$service,'--project',$ProjectId,'--region',$Region,'--member','allUsers','--role','roles/run.invoker','--quiet') '' -Quiet
  if($bind -ne 0){
    Write-Host "allUsers binding was rejected for $service; trying Cloud Run no-invoker-IAM-check mode." -ForegroundColor Yellow
    Require-Ok "Disable invoker IAM check for $service" $GCloud @('run','services','update',$service,'--project',$ProjectId,'--region',$Region,'--no-invoker-iam-check','--quiet') '' -Quiet
  }
  if(-not(Probe-PublicTransport $url)){ throw "$Name still rejects unauthenticated HTTP transport after access configuration." }
  Write-Host "PASS: $Name HTTP transport reachable; application-level Observer/Firebase authorization remains enforced in the handler." -ForegroundColor Green
  return $url
}
function Http-Failure([object]$ErrorRecord){
  $status='';try{$status=[string][int]$ErrorRecord.Exception.Response.StatusCode}catch{}
  if($status){return "HTTP $status"}
  return [string]$ErrorRecord.Exception.Message
}
function Invoke-Json([string]$Label,[string]$Uri,[string]$Method,[object]$Body,[hashtable]$Headers=@{}){
  $json = if($null -eq $Body){ '{}' } else { $Body | ConvertTo-Json -Depth 12 -Compress }
  try{return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers -ContentType 'application/json' -Body $json -TimeoutSec 45}
  catch{throw "$Label failed at $Uri ($(Http-Failure $_))."}
}
function Smoke-PublicObserver([hashtable]$Uris){
  Write-Host '>> Smoke-test public claim -> short-lived session -> MCP bootstrap -> release' -ForegroundColor DarkCyan
  $claim = $null; $session = $null
  try{
    $claim = Invoke-Json 'Public anonymous claim' $Uris['issueRevexObserverAnonymousClaim'] 'POST' @{}
    if($claim.ok -ne $true -or -not [string]$claim.claimKey){ throw 'Public Observer counter did not issue a one-time claim.' }
    $session = Invoke-Json 'One-time claim exchange' $Uris['claimRevexObserverAgentSession'] 'POST' @{ claimKey=[string]$claim.claimKey }
    if($session.ok -ne $true -or -not [string]$session.accessToken){ throw 'Observer claim exchange did not return a session bearer.' }
    $headers = @{ Authorization = 'Bearer ' + [string]$session.accessToken }
    $init = Invoke-Json 'MCP initialize' $Uris['revexObserverMcp'] 'POST' @{ jsonrpc='2.0'; id=1; method='initialize'; params=@{ protocolVersion='2025-06-18'; capabilities=@{}; clientInfo=@{ name='REVEX deployment smoke'; version='1' } } } $headers
    if(-not $init.result -or [string]$init.result.serverInfo.name -ne 'LIBER REVEX Observer'){ throw 'Observer MCP initialize smoke test failed.' }
    $boot = Invoke-Json 'Observer bootstrap' $Uris['revexObserverMcp'] 'POST' @{ jsonrpc='2.0'; id=2; method='tools/call'; params=@{ name='observer_bootstrap'; arguments=@{} } } $headers
    if(-not $boot.result -or $boot.result.isError -eq $true){ throw 'Observer bootstrap smoke test failed.' }
    $release = Invoke-Json 'Observer release' $Uris['revexObserverMcp'] 'POST' @{ jsonrpc='2.0'; id=3; method='tools/call'; params=@{ name='observer_release'; arguments=@{} } } $headers
    if(-not $release.result -or $release.result.isError -eq $true){ throw 'Observer release smoke test failed.' }
    Write-Host 'PASS: anonymous counter + claim exchange + MCP bootstrap + release are live.' -ForegroundColor Green
  } finally {
    $claim = $null; $session = $null
  }
}

try{
  Write-Host 'REVEX Observer AI live deployment' -ForegroundColor Cyan
  Write-Host "Source: $SourceCandidate"
  Write-Host 'Scope: Observer AI broker functions only. Energy worker, renderer, Revit model, Storage rules, Firestore rules and project content are not redeployed.' -ForegroundColor Green

  foreach($required in @(
    (Join-Path $FunctionsDir 'observer-agent-broker.js'),
    (Join-Path $FunctionsDir 'main.js'),
    (Join-Path $FunctionsDir 'project-access.js'),
    (Join-Path $FunctionsDir 'package.json'),
    $Verifier
  )){ if(-not (Test-Path -LiteralPath $required -PathType Leaf)){ throw "Observer deployment source is incomplete: $required" } }

  $GCloud = Require-Command @('gcloud.cmd','gcloud.exe','gcloud') 'Google Cloud CLI'
  $Node = Require-Command @('node.exe','node') 'Node.js'
  $Npm = Require-Command @('npm.cmd','npm.exe','npm') 'npm'

  Require-Ok 'Syntax-check Observer broker' $Node @('--check',(Join-Path $FunctionsDir 'observer-agent-broker.js')) $Root
  Require-Ok 'Syntax-check Firebase composition' $Node @('--check',(Join-Path $FunctionsDir 'main.js')) $Root
  Require-Ok 'Verify public-counter / Pair AI contract' $Node @($Verifier) $Root

  Push-Location $FunctionsDir
  try{
    Require-Ok 'Install Observer broker dependencies' $Npm @('install','--ignore-scripts','--no-audit','--no-fund')
    $requiredExports = ($Functions | ForEach-Object { "'$($_)'" }) -join ','
    $preflight = "const m=require('./main.js');const r=[$requiredExports];const missing=r.filter(k=>typeof m[k]!=='function');if(missing.length){throw new Error('missing Observer exports: '+missing.join(','));}console.log('REVEX_OBSERVER_EXPORTS=PASSED '+r.join(','));"
    Require-Ok 'Static-load all Observer cloud exports' $Node @('-e',$preflight)
  } finally { Pop-Location }

  $auth = Capture-Native $GCloud @('auth','list','--filter','status:ACTIVE','--format','value(account)')
  $accounts = @($auth.Text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if($auth.Code -ne 0 -or $accounts.Count -eq 0){ throw "Google Cloud administrator sign-in is required. Run 'gcloud auth login' once, then rerun this Observer-only launcher." }
  $Deployer = $accounts[0]
  $DeployerMember = Member-ForAccount $Deployer

  Require-Ok 'Select LIBER Google Cloud project' $GCloud @('config','set','project',$ProjectId) '' -Quiet
  Require-Ok 'Enable Observer broker infrastructure APIs' $GCloud @('services','enable','cloudfunctions.googleapis.com','run.googleapis.com','cloudbuild.googleapis.com','artifactregistry.googleapis.com','firestore.googleapis.com','iam.googleapis.com','serviceusage.googleapis.com','--project',$ProjectId) '' -Quiet

  if(-not (Native-Ok $GCloud @('iam','service-accounts','describe',$ObserverSa,'--project',$ProjectId))){
    Require-Ok 'Create bounded REVEX Observer Broker identity' $GCloud @('iam','service-accounts','create',$ObserverSaName,'--display-name','REVEX Observer AI Broker','--project',$ProjectId,'--quiet') '' -Quiet
  }
  Require-Ok 'Allow current deployer to use Observer Broker identity' $GCloud @('iam','service-accounts','add-iam-policy-binding',$ObserverSa,'--project',$ProjectId,'--member',$DeployerMember,'--role','roles/iam.serviceAccountUser','--quiet') '' -Quiet
  Ensure-ProjectRole $GCloud 'roles/datastore.user' 'Grant Observer broker bounded Firestore access'
  Ensure-ProjectRole $GCloud 'roles/logging.logWriter' 'Grant Observer broker runtime logging access'

  $envs = "REVEX_SOURCE_CANDIDATE=$SourceCandidate"
  foreach($name in $Functions){
    Require-Ok "Deploy Observer function $name" $GCloud @(
      'functions','deploy',$name,'--gen2','--project',$ProjectId,'--region',$Region,
      '--runtime','nodejs22','--source',$FunctionsDir,'--entry-point',$name,'--trigger-http',
      '--allow-unauthenticated','--service-account',$ObserverSa,
      '--set-env-vars',$envs,'--memory','512MiB','--cpu','1','--timeout','60s',
      '--concurrency','20','--max-instances','4','--quiet'
    )
  }

  $Uris = @{}
  foreach($name in $Functions){
    $fn = Verify-Function $GCloud $name
    $Uris[$name] = Ensure-PublicTransport $GCloud $name $fn
    Write-Host "PASS: $name ACTIVE / nodejs22 / source-bound." -ForegroundColor Green
  }

  Smoke-PublicObserver $Uris

  Write-Host ''
  Write-Host 'PASS: REVEX Observer AI cloud edge is live.' -ForegroundColor Green
  Write-Host 'Public counter: https://liberpict.com/ai/'
  Write-Host 'Project authorization: open REVEX -> select project -> Pair AI -> give the short code to the AI session.'
  Write-Host 'No LIBER account is required to take the public AI session package.'
  $ExitCode = 0
} catch {
  Write-Host ''
  Write-Host "REVEX Observer AI deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'No Energy worker, renderer, Revit model, Storage rules, Firestore rules, or project content was intentionally changed by this controller.' -ForegroundColor Yellow
  $ExitCode = 1
} finally {
  if(-not $NoPause -and $Host.Name -match 'ConsoleHost'){
    Write-Host ''
    Write-Host 'Press Enter to close.'
    [void](Read-Host)
  }
}
exit $ExitCode
