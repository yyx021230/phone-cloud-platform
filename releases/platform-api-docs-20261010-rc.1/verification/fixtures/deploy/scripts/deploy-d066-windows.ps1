$ErrorActionPreference = "Stop"

$taskName = "PhoneCloud Windows Agent"
$agent = "D:\PhoneCloud\agent"
$release = "D:\PhoneCloud\staging\20260910-d066-poco-input-resilience-v1\merged"
$backup = "D:\PhoneCloud\backups\20260910-before-d066-poco-input-resilience-v1"
$adb = "D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe"

function Get-AdbCounts {
    $rows = & $adb devices
    [pscustomobject]@{
        Online = @($rows | Where-Object { $_ -match "\tdevice$" }).Count
        Unauthorized = @($rows | Where-Object { $_ -match "\tunauthorized$" }).Count
        Offline = @($rows | Where-Object { $_ -match "\toffline$" }).Count
    }
}

function Get-AgentProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -like "*D:\PhoneCloud\agent\src\index.mjs*"
    })
}

$before = Get-AdbCounts
$oldPids = @(Get-AgentProcesses).ProcessId
$candidateIndexHash = (Get-FileHash "$release\src\index.mjs" -Algorithm SHA256).Hash
$candidateScriptHash = (Get-FileHash "$release\scripts\alipay_name_lookup.py" -Algorithm SHA256).Hash

try {
    Stop-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(25)
    while (@(Get-AgentProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    if (@(Get-AgentProcesses).Count -gt 0) {
        throw "agent_stop_timeout"
    }

    Copy-Item "$release\src\index.mjs" "$agent\src\index.mjs.d066-new" -Force
    Copy-Item "$release\scripts\alipay_name_lookup.py" "$agent\scripts\alipay_name_lookup.py.d066-new" -Force
    Move-Item "$agent\src\index.mjs.d066-new" "$agent\src\index.mjs" -Force
    Move-Item "$agent\scripts\alipay_name_lookup.py.d066-new" "$agent\scripts\alipay_name_lookup.py" -Force

    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(30)
    while ((@(Get-AgentProcesses).Count -ne 1 -or
            (Get-ScheduledTask -TaskName $taskName).State -ne "Running") -and
           (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }

    $newProcesses = @(Get-AgentProcesses)
    if ($newProcesses.Count -ne 1) {
        throw "agent_single_instance_failed"
    }
    if ((Get-ScheduledTask -TaskName $taskName).State -ne "Running") {
        throw "agent_task_not_running"
    }
    if ((Get-FileHash "$agent\src\index.mjs" -Algorithm SHA256).Hash -ne $candidateIndexHash) {
        throw "index_hash_mismatch"
    }
    if ((Get-FileHash "$agent\scripts\alipay_name_lookup.py" -Algorithm SHA256).Hash -ne $candidateScriptHash) {
        throw "script_hash_mismatch"
    }

    Start-Sleep -Seconds 5
    $after = Get-AdbCounts
    Write-Output ((
        "deployment=SUCCESS oldPids={0} newPid={1} " +
        "beforeOnline={2} beforeUnauthorized={3} beforeOffline={4} " +
        "afterOnline={5} afterUnauthorized={6} afterOffline={7}") -f
        ($oldPids -join ","), $newProcesses[0].ProcessId,
        $before.Online, $before.Unauthorized, $before.Offline,
        $after.Online, $after.Unauthorized, $after.Offline
    )
    Write-Output "indexHash=$candidateIndexHash"
    Write-Output "scriptHash=$candidateScriptHash"
} catch {
    $reason = $_.Exception.Message
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Copy-Item "$backup\src\index.mjs" "$agent\src\index.mjs.rollback" -Force
    Copy-Item "$backup\scripts\alipay_name_lookup.py" "$agent\scripts\alipay_name_lookup.py.rollback" -Force
    Move-Item "$agent\src\index.mjs.rollback" "$agent\src\index.mjs" -Force
    Move-Item "$agent\scripts\alipay_name_lookup.py.rollback" "$agent\scripts\alipay_name_lookup.py" -Force
    Start-ScheduledTask -TaskName $taskName
    Write-Output "deployment=ROLLED_BACK reason=$reason"
    exit 1
}
