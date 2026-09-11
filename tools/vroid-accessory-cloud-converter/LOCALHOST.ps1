$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$rawBase = 'https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/vroid-accessory-cloud-converter/tools/vroid-accessory-cloud-converter'
$cacheRoot = Join-Path ([IO.Path]::GetTempPath()) ('LIBER_VRoid214_' + [Guid]::NewGuid().ToString('N'))
$serveRoot = $sourceRoot

Write-Host 'VRoid 2.14 Accessory Converter'
Write-Host 'Refreshing the tiny public UI mirror from GitHub...'

try {
  New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  $headers = @{ 'User-Agent' = 'LIBER-VRoid214-Localhost' }
  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri ($rawBase + '/index.html?v=' + $stamp) -OutFile (Join-Path $cacheRoot 'index.html')
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri ($rawBase + '/VERSION.txt?v=' + $stamp) -OutFile (Join-Path $cacheRoot 'VERSION.txt')
  $html = [IO.File]::ReadAllText((Join-Path $cacheRoot 'index.html'))
  if ($html.Length -lt 5000 -or $html -notmatch 'VRoid 2\.14 Accessory Converter') {
    throw 'Downloaded public UI did not pass the local integrity sanity check.'
  }
  $serveRoot = $cacheRoot
  Write-Host 'UI authority: live public GitHub branch mirror'
  try {
    $v = [IO.File]::ReadAllText((Join-Path $cacheRoot 'VERSION.txt')).Trim()
    if ($v) { Write-Host ($v -split "`r?`n")[0] }
  } catch {}
} catch {
  Write-Warning ('Could not refresh the public branch; using bundled offline fallback. ' + $_.Exception.Message)
  $serveRoot = $sourceRoot
}

$serveRoot = [IO.Path]::GetFullPath($serveRoot)
$servePrefix = $serveRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$url = "http://127.0.0.1:$port/"
Write-Host "Local shell: $url"
Write-Host 'No local 3D toolchain is installed or started.'
Write-Host 'The local mirror cache is deleted when this shell exits.'
Write-Host 'Press Ctrl+C to stop this localhost shell.'
Start-Process $url

$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8';
  '.json'='application/json; charset=utf-8'; '.txt'='text/plain; charset=utf-8'; '.svg'='image/svg+xml';
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.ico'='image/x-icon'
}

function Send-Response($stream, [int]$status, [string]$reason, [byte[]]$body, [string]$contentType = 'text/plain; charset=utf-8', [bool]$headOnly = $false) {
  if ($null -eq $body) { $body = [byte[]]::new(0) }
  $headers = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status $reason`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n")
  $stream.Write($headers, 0, $headers.Length)
  if (-not $headOnly -and $body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
      $request = $reader.ReadLine()
      if (-not $request) { continue }
      while (($line = $reader.ReadLine()) -ne '') { if ($null -eq $line) { break } }

      $parts = $request.Split(' ')
      if ($parts.Count -lt 2) {
        Send-Response $stream 400 'Bad Request' ([Text.Encoding]::UTF8.GetBytes('Bad request'))
        continue
      }

      $method = $parts[0].ToUpperInvariant()
      $target = $parts[1]
      $headOnly = $method -eq 'HEAD'
      if ($method -ne 'GET' -and -not $headOnly) {
        Send-Response $stream 405 'Method Not Allowed' ([Text.Encoding]::UTF8.GetBytes('Method not allowed'))
        continue
      }

      # Browsers normally send origin-form (/), but local proxies/security software may
      # forward absolute-form (http://127.0.0.1:PORT/). Normalize both before routing.
      $pathPart = $target
      if ($target -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        try { $pathPart = ([Uri]$target).AbsolutePath } catch { $pathPart = '/' }
      } else {
        $pathPart = ($target -split '\?', 2)[0]
      }
      try { $rawPath = [Uri]::UnescapeDataString($pathPart) } catch { $rawPath = '/' }
      if ([string]::IsNullOrWhiteSpace($rawPath) -or $rawPath -eq '/') { $rawPath = '/index.html' }

      $relative = $rawPath.TrimStart('/','\').Replace('/', [IO.Path]::DirectorySeparatorChar).Replace('\', [IO.Path]::DirectorySeparatorChar)
      $file = [IO.Path]::GetFullPath((Join-Path $serveRoot $relative))
      if (-not $file.StartsWith($servePrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Write-Host ("404 local route: target='{0}' normalized='{1}'" -f $target, $rawPath)
        Send-Response $stream 404 'Not Found' ([Text.Encoding]::UTF8.GetBytes('Not found')) 'text/plain; charset=utf-8' $headOnly
        continue
      }

      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
      $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      Send-Response $stream 200 'OK' $bytes $type $headOnly
    } catch {
      Write-Warning $_.Exception.Message
    } finally {
      if ($client) { $client.Close() }
    }
  }
} finally {
  $listener.Stop()
  if ($cacheRoot -and (Test-Path -LiteralPath $cacheRoot)) {
    Remove-Item -LiteralPath $cacheRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
