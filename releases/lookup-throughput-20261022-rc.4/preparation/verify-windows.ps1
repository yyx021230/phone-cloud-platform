$ErrorActionPreference='Stop'
$stage=$PSScriptRoot;$root='D:\PhoneCloud\agent';$plan=Get-Content (Join-Path $stage 'WINDOWS_PLAN.json') -Raw | ConvertFrom-Json
$adb=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'adb.exe' -and $_.ExecutablePath -eq 'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe' -and $_.CommandLine -match 'fork-server'})
# Use the listener as the exact server identity even if command-line wording varies.
$listener=@(Get-NetTCPConnection -LocalPort 5037 -State Listen);if($listener.Count -ne 1){throw 'ADB listener ambiguous'}
$server=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener[0].OwningProcess);$owner=Invoke-CimMethod -InputObject $server -MethodName GetOwner
if($server.ExecutablePath -ne 'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe' -or ($owner.Domain+'\'+$owner.User) -ne 'NT AUTHORITY\SYSTEM'){throw 'ADB baseline mismatch'}
$agents=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'PhoneCloud' -and $_.CommandLine -match 'src[\\/]index.mjs'})
if($agents.Count -ne 1){throw 'Agent instance mismatch'};$agent=$agents[0];$ao=Invoke-CimMethod -InputObject $agent -MethodName GetOwner;if(($ao.Domain+'\'+$ao.User) -ne 'NT AUTHORITY\SYSTEM'){throw 'Agent owner mismatch'}
$before=@{};$after=@{}
foreach($property in $plan.windowsFiles.PSObject.Properties){$f=$property.Name;$h=$property.Value;$live=Join-Path $root $f;$candidate=Join-Path $stage $f;$actual=if(Test-Path $live){(Get-FileHash $live -Algorithm SHA256).Hash.ToLower()}else{$null};if($actual -ne $h.before){throw ('runtime drift: '+$f)};if((Get-FileHash $candidate -Algorithm SHA256).Hash.ToLower() -ne $h.after){throw ('stage mismatch: '+$f)};$before[$f]=$actual;$after[$f]=$h.after}
foreach($property in $plan.validationHelpers.PSObject.Properties){$f=$property.Name;if((Get-FileHash (Join-Path $root $f) -Algorithm SHA256).Hash.ToLower() -ne $property.Value){throw ('OCR helper drift: '+$f)}}
$backup=Join-Path $stage 'rollback';if(Test-Path $backup){throw 'backup already exists'};New-Item -ItemType Directory $backup | Out-Null
foreach($f in $before.Keys){if($before[$f]){$dest=Join-Path $backup $f;New-Item -ItemType Directory (Split-Path $dest) -Force | Out-Null;Copy-Item (Join-Path $root $f) $dest}}
foreach($f in $after.Keys){if($f.EndsWith('.mjs')){& 'D:\PhoneCloud\tools\node\node.exe' --check (Join-Path $stage $f);if($LASTEXITCODE -ne 0){throw ('node syntax: '+$f)}}}
$py='D:\PhoneCloud\agent\runtime\lookup-ocr\Scripts\python.exe';foreach($f in $after.Keys){if($f.EndsWith('.py')){& $py -m py_compile (Join-Path $stage $f);if($LASTEXITCODE -ne 0){throw ('python syntax: '+$f)}}}
foreach($f in $before.Keys){$live=Join-Path $root $f;$actual=if(Test-Path $live){(Get-FileHash $live -Algorithm SHA256).Hash.ToLower()}else{$null};if($actual -ne $before[$f]){throw ('runtime changed during staging: '+$f)}}
@{candidate=$plan.candidate;sourceCommit=$plan.sourceCommit;status='staged-not-activated';stage=$stage;agentPid=$agent.ProcessId;agentOwner='NT AUTHORITY\SYSTEM';adbPid=$server.ProcessId;adbOwner='NT AUTHORITY\SYSTEM';adbPath=$server.ExecutablePath;before=$before;after=$after;nodeSyntax='passed';python39Syntax='passed';agentReloaded=$false;adbCalled=$false} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stage 'WINDOWS_PREPARATION.json') -Encoding UTF8
Write-Output 'Windows staged, backed up and syntax verified; live files unchanged.'
