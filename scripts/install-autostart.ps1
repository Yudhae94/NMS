<#
  Pasang autostart NMS untuk Windows:
    1. shortcut di folder Startup  -> nyalakan tiap user login
    2. Scheduled Task saat start  -> nyalakan otomatis tanpa login

  Pakai:
    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
#>
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Continue'
$root    = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-all.ps1'
$lnkDir   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$lnk      = Join-Path $lnkDir 'NMS Monitoring.lnk'
$taskName = 'NMS Monitoring Autostart'

if ($Uninstall) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host 'Shortcut Startup dihapus.' }
  $shOld = Join-Path $lnkDir 'nms-autostart.cmd'
  if (Test-Path $shOld) { Remove-Item $shOld -Force; Write-Host 'Startup script cmd dihapus.' }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'NmsMonitoring' -Force -ErrorAction SilentlyContinue
  Write-Host 'Scheduled Task & Registry Run dihapus.'
  return
}

if (-not (Test-Path $launcher)) { throw "Launcher tidak ditemukan: $launcher" }
New-Item -ItemType Directory -Force -Path $lnkDir | Out-Null

# ---- 1. shortcut Startup (pakai cmd.exe agar tidak butuh file .vbs tambahan) ----
$sh = Join-Path $lnkDir 'nms-autostart.cmd'
@"
@echo off
cd /d "%~dp0"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$launcher"
"@ | Set-Content -Path $sh -Encoding ASCII
Write-Host "Startup script dibuat: $sh"

# ---- 2. Scheduled Task saat start (butuh hak admin) ----
$taskOk = $false
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings | Out-Null
  $taskOk = $true
  Write-Host "Scheduled Task '$taskName' terpasang (jalan saat start)."
} catch {
  Write-Host ("Scheduled Task tidak dipasang (butuh hak admin): " + $_.Exception.Message)
}

# ---- 3. Registry Run (cadangan, jalan saat login, tanpa admin) ----
try {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name 'NmsMonitoring' `
    -Value ('powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"') `
    -PropertyType String -Force | Out-Null
  Write-Host 'Registry Run HKCU\...\Run\NmsMonitoring terpasang (jalan saat login).'
} catch {
  Write-Host ('Gagal memasang Registry Run: ' + $_.Exception.Message)
}

Write-Host ''
Write-Host '  AUTOSTART NMS AKTIF' -ForegroundColor Green
Write-Host '   Log : logs\watchdog.log'
Write-Host '   URL : https://nms-monitoring.yudhaekapratamay.workers.dev'
if (-not $taskOk) {
  Write-Host '   Catatan: Scheduled Task butuh admin. Shortcut Startup + Registry Run sudah aktif.' -ForegroundColor Yellow
}