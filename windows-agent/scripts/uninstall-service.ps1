param(
  [string]$ServiceName = "ZtqcPhoneWindowsAgent"
)

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
  Write-Host "Removed $ServiceName"
} else {
  Write-Host "$ServiceName is not installed"
}
