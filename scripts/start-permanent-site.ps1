param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ConfigPath = Join-Path $ProjectRoot ".cloudflared\config.yml"

if (-not (Test-Path $ConfigPath)) {
  throw "Missing Cloudflare config: $ConfigPath. Run scripts\setup-cloudflare-named-tunnel.ps1 first."
}

$Cloudflared = "cloudflared"
if (-not (Get-Command $Cloudflared -ErrorAction SilentlyContinue)) {
  if (Test-Path "C:\tmp\cloudflared.exe") {
    $Cloudflared = "C:\tmp\cloudflared.exe"
  } else {
    throw "cloudflared not found. Install it or put cloudflared.exe at C:\tmp\cloudflared.exe."
  }
}

$DeepSeekKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
$DeepSeekModel = [Environment]::GetEnvironmentVariable("DEEPSEEK_MODEL", "User")

$NodeArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-Command",
  "`$env:PORT='$Port'; `$env:DEEPSEEK_API_KEY='$DeepSeekKey'; `$env:DEEPSEEK_MODEL='$DeepSeekModel'; Set-Location '$ProjectRoot'; node server.js"
)

Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList $NodeArgs
Start-Sleep -Seconds 3
Start-Process -WindowStyle Hidden -FilePath $Cloudflared -ArgumentList @("tunnel", "--config", $ConfigPath, "run")

Write-Host "Permanent site process started."
