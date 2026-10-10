$ErrorActionPreference = "Stop"

$taskName = "PhoneCloud Windows Agent"
$agentFile = "D:\PhoneCloud\agent\src\index.mjs"
$candidateFile = "D:\PhoneCloud\staging\20260910-d067-resume-limit-auto-switch-v1\merged\src\index.mjs"
$backupFile = "D:\PhoneCloud\backups\20260910-before-d067-resume-limit-auto-switch-v1\src\index.mjs"
$adb = "D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe"

function Get-AgentProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -like "*D:\PhoneCloud\agent\src\index.mjs*"
    })
}

function Get-AdbCounts {
    $rows = & $adb devices
    [pscustomobject]@{
        Online = @($rows | Where-Object { $_ -match "\tdevice$" }).Count
        Unauthorized = @($rows | Where-Object { $_ -match "\tunauthorized$" }).Count
        Offline = @($rows | Where-Object { $_ -match "\toffline$" }).Count
    }
}

$expectedHash = (Get-FileHash $candidateFile -Algorithm SHA256).Hash
$before = Get-AdbCounts
try {
    Stop-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(25)
    while (@(Get-AgentProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    if (@(Get-AgentProcesses).Count -gt 0) { throw "agent_stop_timeout" }

    Copy-Item $candidateFile "$agentFile.d067-new" -Force
    Move-Item "$agentFile.d067-new" $agentFile -Force
    Start-ScheduledTask -TaskName $taskName

    $deadline = (Get-Date).AddSeconds(30)
    while ((@(Get-AgentProcesses).Count -ne 1 -or
            (Get-ScheduledTask -TaskName $taskName).State -ne "Running") -and
           (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    $processes = @(Get-AgentProcesses)
    if ($processes.Count -ne 1) { throw "agent_single_instance_failed" }
    if ((Get-FileHash $agentFile -Algorithm SHA256).Hash -ne $expectedHash) { throw "index_hash_mismatch" }
    Start-Sleep -Seconds 5
    $after = Get-AdbCounts
    Write-Output "deployment=SUCCESS pid=$($processes[0].ProcessId) before=$($before.Online)/$($before.Unauthorized)/$($before.Offline) after=$($after.Online)/$($after.Unauthorized)/$($after.Offline)"
    Write-Output "indexHash=$expectedHash"
} catch {
    $reason = $_.Exception.Message
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Copy-Item $backupFile "$agentFile.rollback" -Force
    Move-Item "$agentFile.rollback" $agentFile -Force
    Start-ScheduledTask -TaskName $taskName
    Write-Output "deployment=ROLLED_BACK reason=$reason"
    exit 1
}
