param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Service = "revex-energy-worker"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$VertexProject = $ProjectId
$VertexLocation = "global"
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"

function Require-Command([string[]]$Names,[string]$Purpose) {
  foreach($name in $Names) {
    $cmd=Get-Command $name -ErrorAction SilentlyContinue|Select-Object -First 1
    if($cmd){return $cmd.Source}
  }
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}

function Invoke-Capture([string]$Command,[string[]]$Arguments) {
  $previous=$ErrorActionPreference
  try {
    $ErrorActionPreference="Continue"
    $lines=@(& $Command @Arguments 2>&1|ForEach-Object{[string]$_})
    $code=$LASTEXITCODE;if($null -eq $code){$code=0}
  } finally {$ErrorActionPreference=$previous}
  if([int]$code -ne 0){throw "Command failed with exit code ${code}: $Command $($Arguments -join ' ')"}
  return ($lines -join [Environment]::NewLine).Trim()
}

function Invoke-Checked([string]$Label,[string]$Command,[string[]]$Arguments) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $null=Invoke-Capture $Command $Arguments
}

function Read-Env([object]$State,[string]$Name) {
  foreach($row in @($State.spec.template.spec.containers[0].env)) {
    if([string]$row.name -eq $Name){return [string]$row.value}
  }
  return ""
}

try {
  Write-Host "REVEX r98 live Vertex binding repair" -ForegroundColor Cyan
  Write-Host "No image rebuild. No broker deployment. No Revit export. No renderer."
  Write-Host "Target Google Cloud project: $VertexProject  Vertex location: $VertexLocation"

  $GCloud=Require-Command @('gcloud.cmd','gcloud.exe','gcloud.ps1','gcloud') 'Google Cloud CLI'
  $auth=Invoke-Capture $GCloud @('auth','list','--filter=status:ACTIVE','--format=value(account)')
  if(-not $auth.Trim()){throw "Google Cloud administrator authentication is missing. Run 'gcloud auth login' once and rerun."}

  $beforeText=Invoke-Capture $GCloud @('run','services','describe',$Service,"--project=$ProjectId","--region=$Region",'--format=json')
  $before=$beforeText|ConvertFrom-Json
  $beforeReady=@($before.status.conditions|Where-Object{$_.type -eq 'Ready'}|Select-Object -First 1)
  if($beforeReady.Count -eq 0 -or [string]$beforeReady[0].status -ne 'True'){throw 'Existing Energy worker is not Ready; environment-only repair stopped.'}
  $beforeImage=[string]$before.spec.template.spec.containers[0].image
  $beforeSource=Read-Env $before 'REVEX_SOURCE_CANDIDATE'
  $beforeUrl=[string]$before.status.url
  $beforeSa=[string]$before.spec.template.spec.serviceAccountName
  if(-not $beforeImage -or -not $beforeUrl){throw 'Existing Energy worker has no immutable image/URL to preserve.'}

  Invoke-Checked 'Bind existing worker to its actual Google Cloud/Vertex project' $GCloud @(
    'run','services','update',$Service,"--project=$ProjectId","--region=$Region",
    '--update-env-vars',"REVEX_VERTEX_PROJECT=$VertexProject,REVEX_VERTEX_LOCATION=$VertexLocation",'--quiet'
  )

  $afterText=Invoke-Capture $GCloud @('run','services','describe',$Service,"--project=$ProjectId","--region=$Region",'--format=json')
  $after=$afterText|ConvertFrom-Json
  $afterReady=@($after.status.conditions|Where-Object{$_.type -eq 'Ready'}|Select-Object -First 1)
  if($afterReady.Count -eq 0 -or [string]$afterReady[0].status -ne 'True'){throw 'Energy worker did not become Ready after environment-only repair.'}
  $afterImage=[string]$after.spec.template.spec.containers[0].image
  $afterSource=Read-Env $after 'REVEX_SOURCE_CANDIDATE'
  $afterUrl=[string]$after.status.url
  $afterSa=[string]$after.spec.template.spec.serviceAccountName
  if($afterImage -ne $beforeImage){throw "Environment-only repair unexpectedly changed worker image: $beforeImage -> $afterImage"}
  if($afterSource -ne $beforeSource){throw "Environment-only repair unexpectedly changed REVEX source candidate: $beforeSource -> $afterSource"}
  if($afterUrl.TrimEnd('/') -ne $beforeUrl.TrimEnd('/')){throw "Environment-only repair unexpectedly changed worker service URL."}
  if($afterSa -ne $beforeSa){throw "Environment-only repair unexpectedly changed worker service account."}
  if((Read-Env $after 'REVEX_VERTEX_PROJECT') -ne $VertexProject){throw 'Live worker Vertex project verification failed.'}
  if((Read-Env $after 'REVEX_VERTEX_LOCATION') -ne $VertexLocation){throw 'Live worker Vertex location verification failed.'}

  $policyText=Invoke-Capture $GCloud @('run','services','get-iam-policy',$Service,"--project=$ProjectId","--region=$Region",'--format=json')
  $policy=$policyText|ConvertFrom-Json
  $invoker=@($policy.bindings|Where-Object{[string]$_.role -eq 'roles/run.invoker' -and @($_.members) -contains "serviceAccount:$BrokerSa"})
  if($invoker.Count -eq 0){throw 'Energy broker lost run.invoker access; repair refuses to declare PASS.'}

  Write-Host ''
  Write-Host 'PASS: existing Energy worker is bound to the correct Vertex Google Cloud project.' -ForegroundColor Green
  Write-Host "Worker image preserved: $afterImage"
  Write-Host "Worker source preserved: $afterSource"
  Write-Host "Worker URL preserved: $afterUrl"
  Write-Host "Vertex project: $(Read-Env $after 'REVEX_VERTEX_PROJECT')"
  Write-Host "Vertex location: $(Read-Env $after 'REVEX_VERTEX_LOCATION')"
  Write-Host 'The published Engineering revision remains reusable; do not Sync Engineering again.' -ForegroundColor Green
  exit 0
}
catch {
  Write-Host ''
  Write-Host "REVEX r98 Vertex binding repair failed safely: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
