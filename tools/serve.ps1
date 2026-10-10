# Простой локальный веб-сервер для просмотра сайта без установки программ.
# Запуск:  powershell -ExecutionPolicy Bypass -File tools\serve.ps1
# Затем откройте http://localhost:8790/public/
# Сервера Cloudflare здесь нет, поэтому сайт сам включит демо-режим.
param(
  [int]$Port = 8790,
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$ShotDir = ''
)

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'; '.ico' = 'image/x-icon'; '.md' = 'text/plain; charset=utf-8'
  '.sql'  = 'text/plain; charset=utf-8'; '.ged' = 'text/plain; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Server: http://localhost:$Port/public/   (root: $Root, stop: Ctrl+C)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      # для разработки: сохранение снимка страницы (POST /__shot?name=x, тело — data:image/png;base64,...)
      if ($ShotDir -and $req.HttpMethod -eq 'POST' -and $req.Url.AbsolutePath -eq '/__shot') {
        $reader = New-Object IO.StreamReader($req.InputStream)
        $body = $reader.ReadToEnd()
        $name = ($req.QueryString['name'] -replace '[^\w\-]', '')
        if (-not $name) { $name = 'shot' }
        $b64 = $body.Substring($body.IndexOf(',') + 1)
        New-Item -ItemType Directory -Force $ShotDir | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $ShotDir "$name.png"), [Convert]::FromBase64String($b64))
        $res.StatusCode = 204
        continue
      }
      $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
      if ($rel -eq '') { $res.Redirect("/public/"); $res.Close(); continue }
      $path = [IO.Path]::GetFullPath((Join-Path $Root $rel))
      if (-not $path.StartsWith([IO.Path]::GetFullPath($Root))) { $res.StatusCode = 403; $res.Close(); continue }
      if ((Test-Path $path -PathType Container)) {
        if (-not $rel.EndsWith('/')) { $res.Redirect("/$rel/"); $res.Close(); continue }
        $path = Join-Path $path 'index.html'
      }
      if (Test-Path $path -PathType Leaf) {
        $bytes = [IO.File]::ReadAllBytes($path)
        $ext = [IO.Path]::GetExtension($path).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-store')
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
        $msg = [Text.Encoding]::UTF8.GetBytes("Not found: $rel")
        $res.OutputStream.Write($msg, 0, $msg.Length)
      }
    } catch {
      try { $res.StatusCode = 500 } catch {}
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
