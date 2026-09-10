$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$url = "http://127.0.0.1:$port/"
Write-Host "VRoid 2.14 Accessory Converter"
Write-Host "Local shell: $url"
Write-Host "No local 3D toolchain is installed or started."
Write-Host "Press Ctrl+C to stop this localhost shell."
Start-Process $url

$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8';
  '.json'='application/json; charset=utf-8'; '.txt'='text/plain; charset=utf-8'; '.svg'='image/svg+xml';
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.ico'='image/x-icon'
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
      if ($parts.Count -lt 2 -or $parts[0] -ne 'GET') {
        $body = [Text.Encoding]::UTF8.GetBytes('Method not allowed')
        $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 405 Method Not Allowed`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
        $stream.Write($head,0,$head.Length); $stream.Write($body,0,$body.Length); continue
      }
      $rawPath = [Uri]::UnescapeDataString(($parts[1].Split('?')[0]))
      if ($rawPath -eq '/' -or [string]::IsNullOrWhiteSpace($rawPath)) { $rawPath = '/index.html' }
      $relative = $rawPath.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
      $file = [IO.Path]::GetFullPath((Join-Path $root $relative))
      if (-not $file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $body = [Text.Encoding]::UTF8.GetBytes('Not found')
        $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 404 Not Found`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
        $stream.Write($head,0,$head.Length); $stream.Write($body,0,$body.Length); continue
      }
      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
      $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n")
      $stream.Write($head,0,$head.Length); $stream.Write($bytes,0,$bytes.Length)
    } catch {
      Write-Warning $_.Exception.Message
    } finally {
      if ($client) { $client.Close() }
    }
  }
} finally {
  $listener.Stop()
}
