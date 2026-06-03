param(
  [string]$TaskName = "MoyuMorningNewsPermanentSite"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StartScript = Join-Path $ProjectRoot "scripts\start-permanent-site.ps1"

if (-not (Test-Path $StartScript)) {
  throw "Missing start script: $StartScript"
}

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Principal $Principal -Description "Start Moyu Morning News website and Cloudflare named tunnel."

Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
Write-Host "Startup task installed: $TaskName"
