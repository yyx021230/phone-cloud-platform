# PROPOSED only. Existing SSH user, local CIM reads; no setters or native tasks.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function SafeText($value) {
    $clean = ([string]$value) -replace '[\x00-\x1f\x7f]', ''
    if ($clean.Length -gt 120) { return $clean.Substring(0, 120) }
    return $clean
}
try {
    $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem -Property Version,BuildNumber,OSArchitecture,LastBootUpTime
    $systemInfo = Get-CimInstance -ClassName Win32_ComputerSystem -Property Manufacturer,Model,HypervisorPresent,NumberOfLogicalProcessors
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    [ordered]@{
        scope = 'readonly-os-and-virtualization-hints'
        atUtc = [DateTime]::UtcNow.ToString('o')
        isSystem = ($identity.User.Value -eq 'S-1-5-18')
        version = (SafeText $osInfo.Version)
        build = (SafeText $osInfo.BuildNumber)
        architecture = (SafeText $osInfo.OSArchitecture)
        observedLastBootWallUtc = $osInfo.LastBootUpTime.ToUniversalTime().ToString('o')
        manufacturer = (SafeText $systemInfo.Manufacturer)
        model = (SafeText $systemInfo.Model)
        hypervisorPresent = $systemInfo.HypervisorPresent
        logicalProcessors = $systemInfo.NumberOfLogicalProcessors
        physicalOrVmProven = $false
        clockAuthorityProven = $false
        nativeExecutionPermitted = $false
    } | ConvertTo-Json -Depth 4 -Compress
} catch {
    [ordered]@{ scope = 'readonly-metadata'; status = 'unconfirmed'
        errorId = (SafeText $_.FullyQualifiedErrorId)
        clockAuthorityProven = $false; nativeExecutionPermitted = $false
    } | ConvertTo-Json -Compress
}
