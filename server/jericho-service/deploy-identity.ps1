param(
  [ValidatePattern('^[1-9][0-9]*$')][string]$KeyVersion = '1',
  [ValidatePattern('^[1-9][0-9]*$')][string]$WebhookVersion = '1'
)
$ErrorActionPreference = 'Stop'
$project = 'liber-apps-cca20'
$region = 'us-central1'
$runtime = 'jericho-channel@liber-apps-cca20.iam.gserviceaccount.com'
$source = $PSScriptRoot
function Invoke-Gcloud {
  & gcloud.cmd @args
  if ($LASTEXITCODE -ne 0) { throw 'Google Cloud setup failed. Enrollment remains closed.' }
}
# Values never enter the command line, source tree, or deployment output.
foreach ($name in @('JERICHO_STRIPE_KEY','JERICHO_STRIPE_WEBHOOK_SECRET')) {
  Invoke-Gcloud secrets describe $name --project=$project --format='value(name)'
  Invoke-Gcloud secrets add-iam-policy-binding $name --project=$project --member="serviceAccount:$runtime" --role=roles/secretmanager.secretAccessor --quiet
}
$bindings = "JERICHO_STRIPE_KEY=JERICHO_STRIPE_KEY:${KeyVersion},JERICHO_STRIPE_WEBHOOK_SECRET=JERICHO_STRIPE_WEBHOOK_SECRET:${WebhookVersion}"
Invoke-Gcloud functions deploy jerichoApi --gen2 --runtime=nodejs22 --region=$region --project=$project --source=$source --entry-point=jerichoApi --trigger-http --allow-unauthenticated --service-account=$runtime --memory=256Mi --max-instances=4 --timeout=60s --update-env-vars=JERICHO_IDENTITY_LIVE_ENABLED=false --set-secrets=$bindings --quiet
Invoke-Gcloud functions deploy jerichoMaintenance --gen2 --runtime=nodejs22 --region=$region --project=$project --source=$source --entry-point=jerichoMaintenance --trigger-http --no-allow-unauthenticated --service-account=$runtime --memory=256Mi --max-instances=1 --timeout=300s --update-env-vars=JERICHO_IDENTITY_LIVE_ENABLED=false --set-secrets=$bindings --quiet
$maintenance = Invoke-Gcloud functions describe jerichoMaintenance --gen2 --region=$region --project=$project --format='value(serviceConfig.uri)'
Invoke-Gcloud run services add-iam-policy-binding jerichomaintenance --region=$region --project=$project --member="serviceAccount:$runtime" --role=roles/run.invoker --quiet
$jobName = 'jericho-identity-redaction-daily'
$existing = Invoke-Gcloud scheduler jobs list --location=$region --project=$project --filter="name:$jobName" --format='value(name)'
$action = if ($existing) { 'update' } else { 'create' }
Invoke-Gcloud scheduler jobs $action http $jobName --location=$region --project=$project --schedule='0 9 * * *' --time-zone=Etc/UTC --uri=$maintenance --http-method=POST --oidc-service-account-email=$runtime --oidc-token-audience=$maintenance --attempt-deadline=300s --quiet
Invoke-Gcloud scheduler jobs run $jobName --location=$region --project=$project --quiet
Write-Output 'Identity credentials and daily cleanup connected. Public verification remains disabled pending Stripe review and a consenting live check.'
