param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$stage = 'D:\PhoneCloud\staging\wecom-cps-preview-20261111'
$root = 'D:\PhoneCloud\agent'
$entry = "$root\src\index.mjs"
$taskName = 'PhoneCloud Windows Agent'
$beforeHash = 'dd15cc1f6ab588d45ba5f2a19c3cebc06b663e6315f08c68025d5df904e27041'
$afterHash = '8a94d6a5ce8e3d26eb9513e38a49163b74f80271ddf5952cb98423139911a871'
function FileHash($file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }
function Agents {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*D:\PhoneCloud\agent\src\index.mjs*' })
}
function Owner($item) {
    $own = Invoke-CimMethod -InputObject $item -MethodName GetOwner
    if ($own.ReturnValue -ne 0) { throw 'owner_unconfirmed' }
    "$($own.Domain)\$($own.User)"
}
function AdbIdentity {
    $adb = Get-CimInstance Win32_Process -Filter 'ProcessId=20016'
    if (!$adb -or $adb.ExecutablePath -ne 'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe' -or (Owner $adb) -ne 'NT AUTHORITY\SYSTEM') { throw 'adb_identity_changed' }
    $listeners = @(Get-NetTCPConnection -LocalPort 5037 -State Listen -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne 20016) { throw 'adb_listener_changed' }
    [ordered]@{ pid=20016; created=$adb.CreationDate.ToUniversalTime().ToString('o'); owner=(Owner $adb); path=$adb.ExecutablePath }
}
function TaskIdentity {
    $task = Get-ScheduledTask -TaskName $taskName
    $action = @($task.Actions)
    if ($task.Principal.UserId -ne 'SYSTEM' -or $action.Count -ne 1 -or $action[0].Execute -ne 'D:\PhoneCloud\tools\node\node.exe' -or $action[0].Arguments -ne '--require D:\PhoneCloud\agent\adb-auth-env.cjs D:\PhoneCloud\agent\src\index.mjs') { throw 'frozen_task_action_changed' }
    [ordered]@{ user=$task.Principal.UserId; executable=$action[0].Execute; arguments=$action[0].Arguments }
}
function FrozenFiles {
    [ordered]@{ config=(FileHash "$root\config.json"); authEnvironment=(FileHash "$root\adb-auth-env.cjs"); adbBinary=(FileHash 'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe') }
}
function OutboxCount {
    @(Get-ChildItem -LiteralPath "$root\data\lookup-status-outbox" -File | Where-Object { $_.Name -match '^[a-f0-9]{64}\.json$' }).Count
}
$expected = Get-Content -Raw -LiteralPath "$stage\agent.expected.json" | ConvertFrom-Json
$drift = @($expected.PSObject.Properties | Where-Object { (FileHash (Join-Path $root $_.Name)) -ne $_.Value })
if ($drift.Count -ne 0) { throw ('agent_source_drift:' + (($drift | ForEach-Object Name) -join ',')) }
if ((FileHash "$stage\index.candidate.mjs") -ne $afterHash -or (FileHash $entry) -ne $beforeHash -or (FileHash "$stage\index.backup.mjs") -ne $beforeHash) { throw 'index_hash_drift' }
$processes = @(Agents)
if ($processes.Count -ne 1 -or $processes[0].ProcessId -ne 15224 -or (Owner $processes[0]) -ne 'NT AUTHORITY\SYSTEM') { throw 'agent_identity_changed' }
$report = [ordered]@{ atUtc=[DateTime]::UtcNow.ToString('o'); agentPid=15224; agentOwner=(Owner $processes[0]); task=(TaskIdentity); adb=(AdbIdentity); frozen=(FrozenFiles); verifiedAgentFiles=@($expected.PSObject.Properties).Count; outboxPending=(OutboxCount); indexBefore=$beforeHash; indexAfter=$afterHash; applied=$false }
if (!$Apply) {
    $report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath "$stage\agent-preflight.json"
    $report | ConvertTo-Json -Depth 6 -Compress
    exit 0
}
$prior = Get-Content -Raw -LiteralPath "$stage\agent-preflight.json" | ConvertFrom-Json
if ((ConvertTo-Json -Compress $report.task) -ne (ConvertTo-Json -Compress $prior.task) -or (ConvertTo-Json -Compress $report.adb) -ne (ConvertTo-Json -Compress $prior.adb) -or (ConvertTo-Json -Compress $report.frozen) -ne (ConvertTo-Json -Compress $prior.frozen)) { throw 'preflight_identity_drift' }
if ($report.outboxPending -ne 0) { throw 'lookup_terminal_outbox_pending' }
# Caller must first drain actual cloud work under the approved admission window.
# ADB has separately been proved outside any Windows Job; never stop its task.
Stop-ScheduledTask -TaskName $taskName
$deadline = (Get-Date).AddSeconds(20)
while (@(Agents).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
if (@(Agents).Count -ne 0) { throw 'agent_stop_timeout' }
$null = AdbIdentity
Copy-Item -LiteralPath "$stage\index.candidate.mjs" -Destination "$entry.wecom-preview-new"
if ((FileHash "$entry.wecom-preview-new") -ne $afterHash -or (FileHash $entry) -ne $beforeHash) { throw 'copy_hash_drift' }
Move-Item -LiteralPath "$entry.wecom-preview-new" -Destination $entry -Force
Start-ScheduledTask -TaskName $taskName
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 250
    $processes = @(Agents)
} while ($processes.Count -ne 1 -and (Get-Date) -lt $deadline)
if ($processes.Count -ne 1 -or $processes[0].ProcessId -eq 15224 -or (Owner $processes[0]) -ne 'NT AUTHORITY\SYSTEM') { throw 'new_agent_identity_unconfirmed' }
if ((FileHash $entry) -ne $afterHash) { throw 'loaded_file_hash_changed' }
if ((ConvertTo-Json -Compress (TaskIdentity)) -ne (ConvertTo-Json -Compress $report.task) -or (ConvertTo-Json -Compress (FrozenFiles)) -ne (ConvertTo-Json -Compress $report.frozen) -or (ConvertTo-Json -Compress (AdbIdentity)) -ne (ConvertTo-Json -Compress $report.adb)) { throw 'frozen_baseline_changed' }
$report.applied = $true
$report.agentPidAfter = [int]$processes[0].ProcessId
$report.agentCreatedAfter = $processes[0].CreationDate.ToUniversalTime().ToString('o')
$report.completedAtUtc = [DateTime]::UtcNow.ToString('o')
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath "$stage\agent-applied.json"
$report | ConvertTo-Json -Depth 6 -Compress
