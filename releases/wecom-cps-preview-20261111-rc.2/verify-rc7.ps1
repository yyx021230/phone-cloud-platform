param([switch]$Apply)
$ErrorActionPreference='Stop'
$stage='D:\PhoneCloud\staging\wecom-cps-preview-20261111'
$test=Join-Path $stage 'verify-rc6-tests\scripts'
New-Item -ItemType Directory -Force $test | Out-Null
Copy-Item 'D:\PhoneCloud\agent\scripts\wecom*.py' $test -Force
Copy-Item "$stage\wecom_preinput_recovery.rc7.py" "$test\wecom_preinput_recovery.py" -Force
Copy-Item "$stage\test_wecom_preinput_recovery.py" $test -Force
New-Item -ItemType Directory -Force "$stage\verification\wecom-cleanup-v1" | Out-Null
Copy-Item "$stage\fixtures.json" "$stage\verification\wecom-cleanup-v1\fixtures.json" -Force
Push-Location $test
try { & 'D:\PhoneCloud\tools\python39\python.exe' -m unittest test_wecom_preinput_recovery; if($LASTEXITCODE -ne 0){throw 'native_tests_failed'} } finally { Pop-Location }
$target='D:\PhoneCloud\agent\scripts\wecom_preinput_recovery.py'
if((Get-FileHash $target -Algorithm SHA256).Hash.ToLower() -ne '8855e920032c76346ca0280b7d8798595bd8c6b4de60e21a40ed4bd3ecab1601'){throw 'source_drift'}
if((Get-FileHash "$stage\wecom_preinput_recovery.rc7.py" -Algorithm SHA256).Hash.ToLower() -ne '061ba84a2750d8c60fe1d4fcbf42ca941a8fa732d8d053abf0c528a83f98ff55'){throw 'candidate_drift'}
$processes=Get-CimInstance Win32_Process
$agent=@($processes | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*D:\PhoneCloud\agent\src\index.mjs*' })
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 5037)
if($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne 20016){throw 'listener_drift'}
$adb=@($processes | Where-Object { $_.Name -eq 'adb.exe' -and $_.ProcessId -eq $listeners[0].OwningProcess })
if($agent.Count -ne 1 -or $agent[0].ProcessId -ne 11604 -or $adb.Count -ne 1 -or $adb[0].ProcessId -ne 20016){throw 'runtime_drift'}
foreach($p in @($agent[0],$adb[0])) { $o=Invoke-CimMethod -InputObject $p -MethodName GetOwner; if($o.ReturnValue -ne 0 -or $o.Domain -ne 'NT AUTHORITY' -or $o.User -ne 'SYSTEM'){throw 'owner_drift'} }
if(@($processes | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'wecom_(invite|cleanup|preinput)' }).Count -ne 0){throw 'active_wecom_worker'}
if($Apply){Copy-Item $target "$stage\wecom_preinput_recovery.before-rc7.py";Copy-Item "$stage\wecom_preinput_recovery.rc7.py" "$target.next";Move-Item "$target.next" $target -Force}
[pscustomobject]@{applied=[bool]$Apply;agentPid=$agent[0].ProcessId;adbPid=$adb[0].ProcessId;sha256=(Get-FileHash $target -Algorithm SHA256).Hash.ToLower()} | ConvertTo-Json -Compress
