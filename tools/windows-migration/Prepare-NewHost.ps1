param(
  [Parameter(Mandatory=$true)][string]$Bundle,
  [string]$StageDirectory = ''
)
# Verify first. Optional staging NEVER restores keys, registers tasks or starts services.
$ErrorActionPreference = 'Stop'
$bundleRoot = (Resolve-Path -LiteralPath $Bundle).Path
$baseline = Get-Content -LiteralPath (Join-Path $bundleRoot 'RELOCATION_BASELINE.json') -Raw | ConvertFrom-Json
if ($env:COMPUTERNAME -ieq $baseline.sourceComputer) { throw 'Run on the NEW host, not the source computer.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') { throw 'The archived native dependencies require an AMD64 Windows host.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use an elevated PowerShell window.' }
$manifest = Get-Content -LiteralPath (Join-Path $bundleRoot 'PACKAGE_MANIFEST.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest.files.PSObject.Properties) {
  if ($entry.Name -match '(^/|\\|:|(^|/)\.\.?(/|$))') { throw 'Unsafe package path.' }
  $file = Get-Item -LiteralPath (Join-Path $bundleRoot $entry.Name)
  if ($file.Length -ne $entry.Value.bytes) { throw 'Package size mismatch.' }
  if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ine $entry.Value.sha256) { throw 'Package hash mismatch.' }
}
$d = Get-PSDrive -Name D -ErrorAction SilentlyContinue
$ocrReady = $false
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $ocr = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $ocrReady = @($ocr::AvailableRecognizerLanguages | Where-Object LanguageTag -eq 'zh-Hans-CN').Count -gt 0
} catch { $ocrReady = $false }
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 5037 -ErrorAction SilentlyContinue)
$task = Get-ScheduledTask -TaskName 'PhoneCloud Windows Agent' -ErrorAction SilentlyContinue
[ordered]@{packageHashes='passed';dDrivePresent=($null -ne $d);dDriveFreeBytes=$d.Free;nativeChineseOcr=$ocrReady;adbListenerAlreadyPresent=($listeners.Count -gt 0);agentTaskAlreadyPresent=($null -ne $task);activated=$false} | ConvertTo-Json
if (-not $StageDirectory) { return }
if ($null -eq $d -or $d.Free -lt 20GB) { throw 'Provide D: with at least 20 GiB free before staging.' }
if ($listeners.Count -gt 0 -or $null -ne $task) { throw 'Existing ADB/Agent detected. Inspect it; do not overwrite or stop it.' }
$stage = [IO.Path]::GetFullPath($StageDirectory).TrimEnd('\')
if ($stage -ieq 'D:\PhoneCloud' -or $stage.StartsWith('D:\PhoneCloud\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Use a separate staging directory, not the live runtime.' }
if (Test-Path -LiteralPath $stage) { throw 'Staging destination must not exist.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $bundleRoot 'windows-runtime-and-data.zip'))
try {
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $zip.Entries) {
    if ($entry.FullName -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or -not $seen.Add($entry.FullName)) { throw 'Unsafe archive member.' }
    if (($entry.ExternalAttributes -band 0xF0000000) -eq 0xA0000000) { throw 'Archive symlinks are not accepted.' }
  }
  New-Item -ItemType Directory -Path $stage | Out-Null
  & icacls.exe $stage /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict staging permissions.' }
  foreach ($entry in $zip.Entries) {
    # C/ contains authorized key backups: deliberately leave them inside the archive.
    if (-not $entry.FullName.StartsWith('D/PhoneCloud/')) { continue }
    if ($entry.FullName -match '/agent/data/agent-instance\.lock') { continue }
    $target = Join-Path $stage $entry.FullName.Replace('/','\')
    if (-not ([IO.Path]::GetFullPath($target)).StartsWith($stage+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive escaped staging root.' }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$false)
  }
  'Staged only. No keys restored, no Agent task registered, no ADB or Agent started. Final delta and explicit cutover are required.' | Set-Content -LiteralPath (Join-Path $stage 'NOT_ACTIVATED.txt') -Encoding UTF8
} finally { $zip.Dispose() }
Write-Output 'Staging completed. Read CUTOVER_RUNBOOK.txt before doing anything else.'
