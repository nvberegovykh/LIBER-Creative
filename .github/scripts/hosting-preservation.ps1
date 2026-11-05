# Shared by Hosting release controllers. Functions perform no writes.
function Get-HostingFileMap([string]$VersionName) {
  $files = @{}
  $pageToken = ''
  do {
    $uri = "$Api/$VersionName/files?pageSize=1000"
    if ($pageToken) { $uri += '&pageToken=' + [uri]::EscapeDataString($pageToken) }
    $page = Invoke-Json GET $uri
    if (@($page.PSObject.Properties.Name) -contains 'files') {
      foreach ($file in $page.files) {
        $name = [string]$file.path
        $hash = [string]$file.hash
        if (-not $name -or -not $hash -or $files.ContainsKey($name)) { throw 'Invalid or duplicate Hosting inventory entry.' }
        $files[$name] = $hash
      }
    }
    $pageToken = if (@($page.PSObject.Properties.Name) -contains 'nextPageToken') { [string]$page.nextPageToken } else { '' }
  } while ($pageToken)
  if ($files.Count -eq 0) { throw 'Empty Hosting inventory; refusing to infer preservation.' }
  return $files
}

function Assert-HostingPreserved([hashtable]$Before, [hashtable]$After, [hashtable]$Overlay) {
  $expected = @{}
  foreach ($key in $Before.Keys) { $expected[$key] = $Before[$key] }
  foreach ($key in $Overlay.Keys) {
    if (-not $Overlay[$key]) { throw "Empty overlay hash for $key" }
    $expected[$key] = $Overlay[$key]
  }
  foreach ($key in $expected.Keys) {
    if (-not $After.ContainsKey($key) -or $After[$key] -cne $expected[$key]) { throw "Hosting preservation failed for $key" }
  }
  if ($After.Count -ne $expected.Count) { throw 'Hosting candidate contains unreviewed paths.' }
}

function Assert-HostingLiveVersion([string]$Expected, [string]$Actual) {
  if (-not $Expected -or $Actual -cne $Expected) { throw 'Live Hosting changed during validation; rebuild from the new live version before releasing.' }
}
