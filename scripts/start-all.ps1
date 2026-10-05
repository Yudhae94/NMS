<#
  NMS Launch - menyalakan server + poller + watchdog sekaligus (satu klik).
  Dipakai juga sebagai shortcut Startup Windows (scripts\install-autostart.ps1).

  Pakai:  powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
#>
$ErrorActionPreference = 'Continue'
$root  = Split-Path -Parent $PSScriptRoot
$logs  = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Set-Location $root

function Has-Proc($pattern, $name = 'node.exe') {
  (Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $pattern }) -ne $null
}

# 1. server NMS
if (Has-Proc 'server\.js') {
  Write-Host '[start-all] Server NMS sudah jalan.'
} else {
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'server-autostart.log') `
    -RedirectStandardError  (Join-Path $logs 'server-autostart.err.log') | Out-Null
  Write-Host '[start-all] Server NMS dinyalakan.'
}

# 2. poller
if (Has-Proc 'poller\.js') {
  Write-Host '[start-all] Poller sudah jalan.'
} else {
  Start-Process -FilePath 'node' -ArgumentList 'poller.js' -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'poller-autostart.log') `
    -RedirectStandardError  (Join-Path $logs 'poller-autostart.err.log') | Out-Null
  Write-Host '[start-all] Poller dinyalakan.'
}

# 3. watchdog (server + tunnel + sinkron worker)
if (Has-Proc 'watchdog\.ps1' 'powershell.exe') {
  Write-Host '[start-all] Watchdog sudah jalan.'
} else {
  Start-Process -FilePath 'powershell' `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', `
                  '-File', (Join-Path $PSScriptRoot 'watchdog.ps1') `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'watchdog-autostart.log') `
    -RedirectStandardError  (Join-Path $logs 'watchdog-autostart.err.log') | Out-Null
  Write-Host '[start-all] Watchdog dinyalakan (server + tunnel + auto-deploy).'
}

Start-Sleep -Seconds 6
Write-Host ''
Write-Host '  NMS ONLINE:' -ForegroundColor Green
Write-Host '   https://nms-monitoring.yudhaekapratamay.workers.dev' -ForegroundColor White
if (Test-Path (Join-Path $logs 'tunnel-url.txt')) {
  Write-Host ("   " + (Get-Content (Join-Path $logs 'tunnel-url.txt') -Raw).Trim()) -ForegroundColor DarkGray
}