param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$ObserverSa = "revex-observer-broker@$ProjectId.iam.gserviceaccount.com"
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
  foreach($name in $Names){$cmd=Get-Command $name -ErrorAction SilentlyContinue|Select-Object -First 1;if($cmd){return $cmd.Source}}
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}
function Invoke-Native([string]$Command,[string[]]$Arguments,[switch]$Quiet){
  $previous=$ErrorActionPreference
  try{
    $ErrorActionPreference='Continue'
    if($Quiet){& $Command @Arguments *> $null}else{& $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)}}
    $code=$LASTEXITCODE;if($null-eq $code){$code=0};return [int]$code
  }finally{$ErrorActionPreference=$previous}
}
function Capture-Native([string]$Command,[string[]]$Arguments){
  $previous=$ErrorActionPreference
  try{
    $ErrorActionPreference='Continue'
    $lines=@(& $Command @Arguments 2>$null|ForEach-Object{[string]$_});$code=$LASTEXITCODE;if($null-eq $code){$code=0}
    return [pscustomobject]@{Code=[int]$code;Text=($lines-join "`n").Trim()}
  }finally{$ErrorActionPreference=$previous}
}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments,[switch]$Quiet){
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code=Invoke-Native $Command $Arguments -Quiet:$Quiet
  if($code-ne 0){throw "$Label failed with exit code $code."}
}
function Get-Function([string]$GCloud,[string]$Name){
  $state=Capture-Native $GCloud @('functions','describe',$Name,'--gen2','--project',$ProjectId,'--region',$Region,'--format','json')
  if($state.Code-ne 0-or-not $state.Text){throw "$Name is not deployed as a readable Gen2 function."}
  return ($state.Text|ConvertFrom-Json)
}
function Public-Url([object]$Fn){
  $url=[string]$Fn.url
  if(-not $url){$url=[string]$Fn.serviceConfig.uri}
  if(-not $url){throw 'Function has no public HTTP URL.'}
  return $url
}
function Service-Name([object]$Fn){
  $service=[string]$Fn.serviceConfig.service
  if(-not $service){throw 'Function has no backing Cloud Run service name.'}
  return ($service -split '/')[-1]
}
function Http-Failure([object]$ErrorRecord){
  $status=''
  try{$status=[string][int]$ErrorRecord.Exception.Response.StatusCode}catch{}
  if($status){return "HTTP $status"}
  return [string]$ErrorRecord.Exception.Message
}
function Invoke-Json([string]$Label,[string]$Uri,[string]$Method,[object]$Body,[hashtable]$Headers=@{}){
  $json=if($null-eq $Body){'{}'}else{$Body|ConvertTo-Json -Depth 12 -Compress}
  try{return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers -ContentType 'application/json' -Body $json -TimeoutSec 45}
  catch{throw "$Label failed at $Uri ($(Http-Failure $_))."}
}
function Probe-Transport([string]$Label,[string]$Uri){
  try{
    $r=Invoke-WebRequest -Uri $Uri -Method Options -UseBasicParsing -TimeoutSec 30
    if([int]$r.StatusCode -ge 200-and[int]$r.StatusCode-lt 500){return $true}
  }catch{
    $status='';try{$status=[int]$_.Exception.Response.StatusCode}catch{}
    if($status-ne 401-and$status-ne 403){return $true}
  }
  return $false
}
function Ensure-PublicTransport([string]$GCloud,[string]$Name,[object]$Fn){
  if([string]$Fn.state-ne 'ACTIVE'){throw "$Name is not ACTIVE."}
  if([string]$Fn.buildConfig.runtime-ne 'nodejs22'){throw "$Name runtime is not nodejs22."}
  if([string]$Fn.serviceConfig.serviceAccountEmail-ne $ObserverSa){throw "$Name runtime identity is not the bounded Observer broker identity."}
  $service=Service-Name $Fn
  $url=Public-Url $Fn

  Write-Host ">> Ensure unauthenticated HTTP transport for $Name" -ForegroundColor DarkCyan
  $bind=Invoke-Native $GCloud @('run','services','add-iam-policy-binding',$service,'--project',$ProjectId,'--region',$Region,'--member','allUsers','--role','roles/run.invoker','--quiet') -Quiet
  if($bind-ne 0){
    Write-Host "allUsers IAM binding was rejected for $service; trying Cloud Run's no-invoker-IAM-check mode." -ForegroundColor Yellow
    Require-Ok "Disable Cloud Run invoker IAM check for $service" $GCloud @('run','services','update',$service,'--project',$ProjectId,'--region',$Region,'--no-invoker-iam-check','--quiet') -Quiet
  }

  if(-not(Probe-Transport $Name $url)){
    throw "$Name still rejects unauthenticated HTTP transport after the public-access repair."
  }
  Write-Host "PASS: $Name transport is publicly reachable; application-level Observer/Firebase authorization remains in the handler." -ForegroundColor Green
  return $url
}
function Smoke-PublicObserver([hashtable]$Uris){
  Write-Host '>> Smoke-test public claim -> short-lived session -> MCP bootstrap -> release' -ForegroundColor DarkCyan
  $claim=$null;$session=$null
  try{
    $claim=Invoke-Json 'Public anonymous claim' $Uris['issueRevexObserverAnonymousClaim'] 'POST' @{}
    if($claim.ok-ne $true-or-not[string]$claim.claimKey){throw 'Public Observer counter did not issue a one-time claim.'}
    $session=Invoke-Json 'One-time claim exchange' $Uris['claimRevexObserverAgentSession'] 'POST' @{claimKey=[string]$claim.claimKey}
    if($session.ok-ne $true-or-not[string]$session.accessToken){throw 'Observer claim exchange did not return a session bearer.'}
    $headers=@{Authorization='Bearer '+[string]$session.accessToken}
    $init=Invoke-Json 'MCP initialize' $Uris['revexObserverMcp'] 'POST' @{jsonrpc='2.0';id=1;method='initialize';params=@{protocolVersion='2025-06-18';capabilities=@{};clientInfo=@{name='REVEX access repair smoke';version='1'}}} $headers
    if(-not$init.result-or[string]$init.result.serverInfo.name-ne'LIBER REVEX Observer'){throw 'Observer MCP initialize smoke test failed.'}
    $boot=Invoke-Json 'Observer bootstrap' $Uris['revexObserverMcp'] 'POST' @{jsonrpc='2.0';id=2;method='tools/call';params=@{name='observer_bootstrap';arguments=@{}}} $headers
    if(-not$boot.result-or$boot.result.isError-eq $true){throw 'Observer bootstrap smoke test failed.'}
    $release=Invoke-Json 'Observer release' $Uris['revexObserverMcp'] 'POST' @{jsonrpc='2.0';id=3;method='tools/call';params=@{name='observer_release';arguments=@{}}} $headers
    if(-not$release.result-or$release.result.isError-eq $true){throw 'Observer release smoke test failed.'}
    Write-Host 'PASS: anonymous claim + session + MCP bootstrap + release are live end to end.' -ForegroundColor Green
  }finally{$claim=$null;$session=$null}
}

try{
  Write-Host 'REVEX Observer AI public-transport repair' -ForegroundColor Cyan
  Write-Host 'Scope: invocation IAM + smoke test only. No function rebuild, Energy, Render, Revit, Firestore rules, Storage rules, or project content changes.' -ForegroundColor Green
  $GCloud=Require-Command @('gcloud.cmd','gcloud.exe','gcloud') 'Google Cloud CLI'
  $auth=Capture-Native $GCloud @('auth','list','--filter','status:ACTIVE','--format','value(account)')
  if($auth.Code-ne 0-or-not $auth.Text){throw "Google Cloud administrator sign-in is required. Run 'gcloud auth login' once, then rerun."}
  Require-Ok 'Select LIBER Google Cloud project' $GCloud @('config','set','project',$ProjectId) -Quiet

  $Uris=@{}
  foreach($name in $Functions){
    $fn=Get-Function $GCloud $name
    $Uris[$name]=Ensure-PublicTransport $GCloud $name $fn
  }
  Smoke-PublicObserver $Uris

  Write-Host ''
  Write-Host 'PASS: REVEX Observer AI public edge is reachable and the one-time session flow is healthy.' -ForegroundColor Green
  Write-Host 'Public counter: https://liberpict.com/ai/'
  Write-Host 'Project access remains separate: authorized REVEX project -> Pair AI -> one-time code -> observer_pair.'
  $ExitCode=0
}catch{
  Write-Host ''
  Write-Host "REVEX Observer AI public-transport repair stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'No function source, Energy worker, renderer, Revit model, Firestore rules, Storage rules, or project content was redeployed by this repair.' -ForegroundColor Yellow
  $ExitCode=1
}finally{
  if(-not$NoPause-and$Host.Name-match'ConsoleHost'){Write-Host '';Write-Host 'Press Enter to close.';[void](Read-Host)}
}
exit $ExitCode
