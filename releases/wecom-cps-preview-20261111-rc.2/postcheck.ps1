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
$expected.'src/index.mjs'='8a94d6a5ce8e3d26eb9513e38a49163b74f80271ddf5952cb98423139911a871'
$expected.'scripts/wecom_invite_preview.py'='06fd6f6b36d03958d6cde711423704d2e4ab7818afebfec23577f492144d23e8'
$expected.'scripts/wecom_cleanup_verify.py'='e2193cbe39ae03119b2e569cc6de5c531c78b18eb91945206c2dfdddf8b8eb13'
$expected.'scripts/wecom_preinput_recovery.py'='061ba84a2750d8c60fe1d4fcbf42ca941a8fa732d8d053abf0c528a83f98ff55'
# Observed external XHS hot update at 06:39 UTC, preserved; not owned by this release.
$expected.'scripts/小红书数据同步.py'='86aa18abe0a0abd26075ec51392559868fbe7ceb7584147fb4ed39a69093844b'
$actual=[ordered]@{}
$expected.PSObject.Properties | ForEach-Object { $actual[$_.Name]=FileHash (Join-Path $root $_.Name); if($actual[$_.Name] -ne $_.Value){throw ('agent_source_drift:'+$_.Name)} }
$processes=@(Agents)
if($processes.Count -ne 1 -or $processes[0].ProcessId -ne 11604 -or (Owner $processes[0]) -ne 'NT AUTHORITY\SYSTEM'){throw 'agent_identity_changed'}
$prior=Get-Content -Raw "$stage\agent-preflight.json" | ConvertFrom-Json
if((ConvertTo-Json -Compress (TaskIdentity)) -ne (ConvertTo-Json -Compress $prior.task) -or (ConvertTo-Json -Compress (FrozenFiles)) -ne (ConvertTo-Json -Compress $prior.frozen) -or (ConvertTo-Json -Compress (AdbIdentity)) -ne (ConvertTo-Json -Compress $prior.adb)){throw 'frozen_baseline_changed'}
$report=[ordered]@{atUtc=[DateTime]::UtcNow.ToString('o');agentPid=11604;agentCreatedAt=$processes[0].CreationDate.ToUniversalTime().ToString('o');agentOwner=(Owner $processes[0]);adb=(AdbIdentity);frozen=(FrozenFiles);task=(TaskIdentity);outboxPending=(OutboxCount);verifiedAgentFiles=$actual.Count;agentFiles=$actual}
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 "$stage\postcheck.json"
[pscustomobject]@{agentPid=11604;adbPid=20016;verifiedAgentFiles=$actual.Count;outboxPending=$report.outboxPending;frozenBaselineUnchanged=$true} | ConvertTo-Json -Compress
