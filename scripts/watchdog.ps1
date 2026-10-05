<#
  NMS Watchdog - penjaga server + tunnel + sinkronisasi Worker.

  Dijalankan ber perpetual. Tiap 60 detik:
    1. pastikan server NMS (port 3000) hidup
    2. pastikan cloudflared tunnel hidup dan merespons
    3. bila URL tunnel berubah (quick tunnel ganti URL tiap restart)
       maka perbarui ORIGIN_URL di wrangler.jsonc lalu deploy worker

  Pakai:  powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1

  CATATAN: file ini harus bebas karakter non-ASCII. PowerShell membaca
  .ps1 tanpa BOM sebagai ANSI sehingga karakter Unicode merusak parsing.
#>
[CmdletBinding()]
param(
  [int]$IntervalSec = 60,
  [switch]$NoDeploy
)

$ErrorActionPreference = 'Continue'
$root    = Split-Path -Parent $PSScriptRoot
$logs    = Join-Path $root 'logs'
$cf      = Join-Path $env:USERPROFILE '.cloudflared\cloudflared.exe'
$port    = 3000
$urlFile = Join-Path $logs 'tunnel-url.txt'
$cfg     = Join-Path $root 'wrangler.jsonc'

New-Item -ItemType Directory -Force -Path $logs | Out-Null
Set-Location $root

function Say($m) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m
  Write-Host $line
  Add-Content -Path (Join-Path $logs 'watchdog.log') -Value $line
}

Say ('Watchdog NMS mulai. interval=' + $IntervalSec + ' deploy=' + (-not $NoDeploy))

function Get-TunnelProc {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match ('localhost:' + $port) }
}

function Get-ServerProc {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'server\.js' }
}

function Start-ServerNms {
  if (Get-ServerProc) { return }
  Say 'Menyalakan server NMS...'
  Start-Process -FilePath 'node' -ArgumentList 'server.js' `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'server-wd.log') `
    -RedirectStandardError  (Join-Path $logs 'server-wd.err.log') | Out-Null
  Start-Sleep -Seconds 5
}

function Start-TunnelNms {
  if (-not (Test-Path $cf)) { Say ('cloudflared tidak ditemukan: ' + $cf); return $null }
  if (Get-TunnelProc) { return $null }
  Say 'Menyalakan Cloudflare Tunnel...'
  $err = Join-Path $logs 'tunnel-wd.err.log'
  if (Test-Path $err) { Remove-Item $err -Force -ErrorAction SilentlyContinue }
  Start-Process -FilePath $cf -ArgumentList 'tunnel','--no-autoupdate','--url',('http://localhost:' + $port) `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'tunnel-wd.log') `
    -RedirectStandardError  $err | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $err) {
      $m = Select-String -Path $err -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
           Select-Object -First 1
      if ($m) {
        $u = [regex]::Match($m.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value
        Set-Content -Path $urlFile -Value $u -Encoding ASCII
        Say ('Tunnel aktif: ' + $u)
        return $u
      }
    }
  }
  Say 'Tunnel tidak menghasilkan URL (lihat logs\tunnel-wd.err.log)'
  return $null
}

function Sync-Worker($url) {
  if (-not (Test-Path $cfg)) { return }
  $text = Get-Content $cfg -Raw
  if ($text -match [regex]::Escape($url)) { return }
  # Ganti hanya nilai ORIGIN_URL. Pakai MatchEvaluator agar string '$1'
  # tidak ditafsirkan sebagai regex group (itulah yang sempat menghapus isi file).
  $pattern = '("ORIGIN_URL"\s*:\s*")[^"]*(")'
  $new = [regex]::Replace($text, $pattern, { param($m) $m.Groups[1].Value + $url + $m.Groups[2].Value })
  if (-not $new -or $new.Trim().Length -lt 50) {
    Say 'Update ORIGIN_URL dibatalkan (hasil regex tidak valid).'
    return
  }
  if ($new -ne $text) {
    [System.IO.File]::WriteAllText($cfg, $new, (New-Object System.Text.UTF8Encoding($false)))
    Say ('wrangler.jsonc diperbarui -> ' + $url)
    git add wrangler.jsonc 2>&1 | Out-Null
    git commit -m ('chore(online): sinkron ORIGIN_URL tunnel (' + $url + ')') 2>&1 | Out-Null
  }
  if ($NoDeploy) { return }
  Say 'Deploy worker ke Cloudflare...'
  npx --yes wrangler@latest deploy 2>&1 | Out-File -FilePath (Join-Path $logs 'deploy-wd.log') -Encoding UTF8
  if ($LASTEXITCODE -eq 0) { Say 'Worker ter-deploy.' }
  else { Say 'Deploy worker GAGAL (lihat logs\deploy-wd.log)' }
}

$lastUrl = $null
if (Test-Path $urlFile) { $lastUrl = (Get-Content $urlFile -Raw).Trim() }

while ($true) {
  $alive = $false
  try { (Invoke-WebRequest ('http://localhost:' + $port + '/api/health') -UseBasicParsing -TimeoutSec 6) | Out-Null; $alive = $true } catch {}
  if (-not $alive) { Start-ServerNms }

  $url = $null
  if (Test-Path $urlFile) { $url = (Get-Content $urlFile -Raw).Trim() }
  $tunnelProc = Get-TunnelProc

  if (-not $tunnelProc) {
    Say 'Tunnel tidak berjalan - menyalakan ulang...'
    $url = Start-TunnelNms
  } elseif ($url) {
    $ok = $false
    try { (Invoke-WebRequest ($url + '/api/health') -UseBasicParsing -TimeoutSec 15) | Out-Null; $ok = $true } catch {}
    if (-not $ok) {
      Say ('Tunnel hidup tapi tidak merespons (' + $url + ') - menyalakan ulang...')
      Get-TunnelProc | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
      Start-Sleep -Seconds 3
      $url = Start-TunnelNms
    }
  } else {
    $url = Start-TunnelNms
  }

  if ($url -and $url -ne $lastUrl) {
    Say ('URL tunnel berubah: ' + $lastUrl + ' -> ' + $url)
    Sync-Worker $url
    $lastUrl = $url
  }

  Start-Sleep -Seconds $IntervalSec
}