$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'hosting-preservation.ps1')
$before = @{ '/revex.js'='revex-fixed'; '/observer.html'='observer-old' }
$overlay = @{ '/observer.html'='observer-new'; '/new.json'='new' }
$valid = @{ '/revex.js'='revex-fixed'; '/observer.html'='observer-new'; '/new.json'='new' }
Assert-HostingPreserved $before $valid $overlay
function Must-Reject([scriptblock]$Action) { $rejected=$false; try { & $Action } catch { $rejected=$true }; if(-not $rejected){throw 'Unsafe candidate was accepted.'} }
Must-Reject { Assert-HostingPreserved $before @{ '/removed-revex.js'='revex-fixed'; '/observer.html'='observer-new'; '/new.json'='new' } $overlay }
Must-Reject { Assert-HostingPreserved $before @{ '/revex.js'='stale'; '/observer.html'='observer-new'; '/new.json'='new' } $overlay }
Must-Reject { Assert-HostingPreserved $before $valid @{ '/observer.html'='wrong'; '/new.json'='new' } }
Must-Reject { Assert-HostingPreserved $before ($valid + @{ '/surprise'='x' }) $overlay }
Must-Reject { Assert-HostingPreserved $before $valid @{ '/revex.js'='' } }
Assert-HostingLiveVersion 'expected' 'expected'
Must-Reject { Assert-HostingLiveVersion 'expected' 'concurrent-release' }
$Api='https://example.invalid'
$script:pages=0
function Invoke-Json($Method,$Uri) { $script:pages++; if($script:pages -eq 1){return [pscustomobject]@{files=@([pscustomobject]@{path='/a';hash='1'});nextPageToken='second page'}}; if($Uri -notmatch 'pageToken=second%20page'){throw 'Pagination missing'}; return [pscustomobject]@{files=@([pscustomobject]@{path='/b';hash='2'})} }
$map=Get-HostingFileMap 'sites/test/versions/test'
if($map.Count -ne 2 -or $map['/b'] -ne '2' -or $script:pages -ne 2){throw 'Pagination failed'}
Write-Output 'PASS: overlay, missing file, stale file, wrong hash, unexpected path, deletion marker, concurrent release, and paginated inventory'
