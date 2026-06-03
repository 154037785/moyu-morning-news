param(
  [Parameter(Mandatory = $true)]
  [string]$Hostname,

  [string]$TunnelName = "moyu-news",
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ConfigDir = Join-Path $ProjectRoot ".cloudflared"
$ConfigPath = Join-Path $ConfigDir "config.yml"

$Cloudflared = "cloudflared"
if (-not (Get-Command $Cloudflared -ErrorAction SilentlyContinue)) {
  if (Test-Path "C:\tmp\cloudflared.exe") {
    $Cloudflared = "C:\tmp\cloudflared.exe"
  } else {
    throw "cloudflared not found. Install it or put cloudflared.exe at C:\tmp\cloudflared.exe."
  }
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

Write-Host "Step 1/4: Checking Cloudflare login..."
try {
  & $Cloudflared tunnel list | Out-Null
} catch {
  Write-Host "Cloudflare login is required. A browser window or login URL will appear."
  & $Cloudflared tunnel login
}

Write-Host "Step 2/4: Creating or reusing tunnel '$TunnelName'..."
$TunnelListJson = & $Cloudflared tunnel list --output json
$Tunnels = $TunnelListJson | ConvertFrom-Json
$Tunnel = $Tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1

if (-not $Tunnel) {
  & $Cloudflared tunnel create $TunnelName
  $TunnelListJson = & $Cloudflared tunnel list --output json
  $Tunnels = $TunnelListJson | ConvertFrom-Json
  $Tunnel = $Tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
}

if (-not $Tunnel) {
  throw "Unable to find tunnel '$TunnelName' after creation."
}

$TunnelId = $Tunnel.id
$CredentialsFile = Join-Path $env:USERPROFILE ".cloudflared\$TunnelId.json"

if (-not (Test-Path $CredentialsFile)) {
  throw "Tunnel credentials not found: $CredentialsFile"
}

Write-Host "Step 3/4: Writing tunnel config..."
@"
tunnel: $TunnelId
credentials-file: $CredentialsFile

ingress:
  - hostname: $Hostname
    service: http://localhost:$Port
  - service: http_status:404
"@ | Set-Content -Encoding UTF8 -Path $ConfigPath

Write-Host "Step 4/4: Binding DNS route $Hostname -> $TunnelName..."
& $Cloudflared tunnel route dns $TunnelName $Hostname

Write-Host ""
Write-Host "Permanent tunnel configured."
Write-Host "Hostname: https://$Hostname"
Write-Host "Config: $ConfigPath"
Write-Host ""
Write-Host "Start it with:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\start-permanent-site.ps1"
