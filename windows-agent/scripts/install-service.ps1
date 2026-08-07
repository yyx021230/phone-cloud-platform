param(
  [string]$InstallDir = "C:\ztqc-phone-agent",
  [string]$ServiceName = "ZtqcPhoneWindowsAgent"
)

$ErrorActionPreference = "Stop"

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  throw "Node.js is required. Install Node.js 18+ before installing the service."
}

$scriptPath = Join-Path $InstallDir "src\index.mjs"
if (-not (Test-Path $scriptPath)) {
  throw "Agent script not found: $scriptPath"
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

$nodePath = $node.Source
$binPath = "`"$nodePath`" `"$scriptPath`""

New-Service -Name $ServiceName `
  -BinaryPathName $binPath `
  -DisplayName "ZTC Phone Windows Agent" `
  -Description "ADB manager for Phone Cloud Platform" `
  -StartupType Automatic

sc.exe failure $ServiceName reset= 86400 actions= restart/30000/restart/30000/restart/30000 | Out-Null
Start-Service -Name $ServiceName

Write-Host "Installed and started $ServiceName"
