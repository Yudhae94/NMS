<#
  NMS Online — nyalakan server + Cloudflare Tunnel lalu sinkronkan URL tunnel
  ke Worker Cloudflare secara otomatis.

  Pakai:  powershell -ExecutionPolicy Bypass -File scripts\online.ps1

  Semua output disimpan ke logs\online-*.log
#>
[CmdletBinding()]
param(
  [switch]$NoPoller,
  [switch]$NoDeploy
)

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$logs   = Join-Path $root 'logs'
$cf     = Join-Path $env:USERPROFILE '.cloudflared\cloudflared.exe'
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'

New-Item -ItemType Directory -Force -Path $logs | Out-Null
Set-Location $root

function Say($m) { Write-Host "[$(Get-Date -Format HH:mm:ss)] $m" -ForegroundColor Cyan }

# ---------- 1. server NMS ----------
$port = 3000
$up = $false
try { (Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 4) | Out-Null; $up = $true } catch {}

if ($up) {
  Say "Server NMS sudah jalan di port $port."
} else {
  Say "Menyalakan server NMS..."
  Start-Process -FilePath 'node' -ArgumentList 'server.js' `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs "server-$stamp.log") `
    -RedirectStandardError  (Join-Path $logs "server-$stamp.err.log") | Out-Null
  Start-Sleep -Seconds 4
  try { (Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 6) | Out-Null; Say "Server NMS aktif." }
  catch { throw "Gagal menyalakan server NMS. Lihat logs\server-$stamp.err.log" }
}

# ---------- 2. poller ----------
if (-not $NoPoller) {
  $poller = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object { $_.CommandLine -match 'poller\.js' }
  if ($poller) { Say "Poller sudah berjalan (PID $($poller.ProcessId))." }
  else {
    Say "Menyalakan poller..."
    Start-Process -FilePath 'node' -ArgumentList 'poller.js' `
      -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logs "poller-$stamp.log") `
      -RedirectStandardError  (Join-Path $logs "poller-$stamp.err.log") | Out-Null
    Say "Poller aktif."
  }
}

# ---------- 3. tunnel ----------
if (-not (Test-Path $cf)) { throw "cloudflared tidak ditemukan di $cf" }

Say "Menyalakan Cloudflare Tunnel..."
$err = Join-Path $logs "tunnel-$stamp.err.log"
Start-Process -FilePath $cf -ArgumentList 'tunnel','--url',"http://localhost:$port",'--no-autoupdate' `
  -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logs "tunnel-$stamp.log") `
  -RedirectStandardError  $err | Out-Null

$url = $null
for ($i = 0; $i -lt 30 -and -not $url; $i++) {
  Start-Sleep -Seconds 2
  $m = Select-String -Path $err -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
       Select-Object -First 1
  if ($m) { $url = [regex]::Match($m.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value }
}
if (-not $url) { throw "Tunnel tidak menghasilkan URL. Lihat $err" }
Say "Tunnel URL: $url"

# ---------- 4. sinkronkan Worker ----------
$cfg = Join-Path $root 'wrangler.jsonc'
$json = (Get-Content $cfg -Raw) -replace '//.*?$', '' | Where-Object { $_ }
$text = Get-Content $cfg -Raw
$new  = [regex]::Replace($text, '("ORIGIN_URL"\s*:\s*")[^"]*(")', "`${1}$url`${2}")
if ($new -ne $text) { Set-Content -Path $cfg -Value $new -Encoding UTF8; Say "wrangler.jsonc diperbarui -> $url" }

if (-not $NoDeploy) {
  Say "Deploy worker..."
  $env:CLOUDFLARE_ACCOUNT_ID = '46a7e66eb030b0befd1af1bb01d061bd'
  npx --yes wrangler@latest deploy 2>&1 | Tee-Object -FilePath (Join-Path $logs "deploy-$stamp.log") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Deploy worker gagal. Lihat logs\deploy-$stamp.log" }
  Say "Worker ter-deploy."
}

Write-Host ''
Write-Host '  NMS ONLINE — siap diakses:' -ForegroundColor Green
Write-Host "   https://nms-monitoring.yudhaekapratamay.workers.dev" -ForegroundColor White
Write-Host "   $url" -ForegroundColor DarkGray
Write-Host ''
