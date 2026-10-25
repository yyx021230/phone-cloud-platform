param([switch]$ApprovedCurrentMaintenance)
if(-not $ApprovedCurrentMaintenance){throw 'Current maintenance authorization required'}
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$stage='D:\PhoneCloud\staging\lookup-ai-coverage-20261026-rc5';$root='D:\PhoneCloud\agent';$taskName='PhoneCloud Windows Agent'
$plan=Get-Content ($stage+'\WINDOWS_PLAN.json') -Raw | ConvertFrom-Json
function Agents { @(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'PhoneCloud' -and $_.CommandLine -match 'src[\\/]index.mjs'}) }
function Assert-Adb {
 $listeners=@(Get-NetTCPConnection -LocalPort 5037 -State Listen);if($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne 20316){throw 'ADB listener changed'}
 $p=Get-CimInstance Win32_Process -Filter 'ProcessId=20316';$o=Invoke-CimMethod -InputObject $p -MethodName GetOwner
 if($p.ExecutablePath -ne 'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe' -or ($o.Domain+'\'+$o.User) -ne 'NT AUTHORITY\SYSTEM'){throw 'ADB identity changed'}
}
Assert-Adb
$agents=@(Agents);if($agents.Count -ne 1 -or $agents[0].ProcessId -ne 27236){throw 'Agent baseline changed'}
$task=Get-ScheduledTask -TaskName $taskName;$taskBefore=$task | Export-Clixml -Path ($stage+'\rollback\agent-task.before.xml')
if($task.Principal.UserId -notin @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')){throw 'Task owner mismatch'}
foreach($p in $plan.windowsFiles.PSObject.Properties){$f=$p.Name;$h=$p.Value;$live=Join-Path $root $f;$actual=if(Test-Path $live){(Get-FileHash $live).Hash.ToLower()}else{$null};if($actual -ne $h.before){throw ('Before hash mismatch: '+$f)};if((Get-FileHash (Join-Path ($stage+'\candidate') $f)).Hash.ToLower() -ne $h.after){throw ('Candidate hash mismatch: '+$f)};if($h.before -and (Get-FileHash (Join-Path ($stage+'\rollback') $f)).Hash.ToLower() -ne $h.before){throw ('Backup mismatch: '+$f)}}
$changed=$false
try {
 Stop-ScheduledTask -TaskName $taskName
 $deadline=(Get-Date).AddSeconds(25);while(@(Agents).Count -gt 0 -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 500};if(@(Agents).Count -gt 0){throw 'Agent stop timed out'}
 Assert-Adb
 $changed=$true
 foreach($p in $plan.windowsFiles.PSObject.Properties){$dest=Join-Path $root $p.Name;Copy-Item (Join-Path ($stage+'\candidate') $p.Name) ($dest+'.ai-coverage-rc5-new');Move-Item ($dest+'.ai-coverage-rc5-new') $dest -Force;if((Get-FileHash $dest).Hash.ToLower() -ne $p.Value.after){throw ('Copied hash mismatch: '+$p.Name)}}
 Start-ScheduledTask -TaskName $taskName
 $deadline=(Get-Date).AddSeconds(35);while(@(Agents).Count -ne 1 -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 500}
 $agents=@(Agents);if($agents.Count -ne 1){throw 'Agent instance count mismatch'};$o=Invoke-CimMethod -InputObject $agents[0] -MethodName GetOwner;if(($o.Domain+'\'+$o.User) -ne 'NT AUTHORITY\SYSTEM'){throw 'Agent owner mismatch'}
 Assert-Adb
 $receipt=@{status='activated';sourceCommit=$plan.sourceCommit;atUtc=[DateTime]::UtcNow.ToString('o');previousAgentPid=27236;agentPid=$agents[0].ProcessId;agentOwner='NT AUTHORITY\SYSTEM';adbPid=20316;adbUnchanged=$true;files=$plan.windowsFiles;taskActionChanged=$false}
 $receipt | ConvertTo-Json -Depth 6 | Set-Content ($stage+'\WINDOWS_ACTIVATED.json') -Encoding UTF8
 Write-Output ('activated Agent PID='+$agents[0].ProcessId+'; ADB unchanged')
} catch {
 $reason=$_.Exception.Message
 if($changed){Stop-ScheduledTask -TaskName $taskName;Start-Sleep -Seconds 2;if(@(Agents).Count -gt 0){throw ('Rollback blocked by running Agent: '+$reason)};foreach($p in $plan.windowsFiles.PSObject.Properties){$live=Join-Path $root $p.Name;if($p.Value.before){Copy-Item (Join-Path ($stage+'\rollback') $p.Name) $live -Force}else{if(Test-Path $live){Move-Item $live ($live+'.ai-coverage-rc5-held') -Force}}}}
 Start-ScheduledTask -TaskName $taskName
 throw ('Agent activation failed, previous files restored where changed: '+$reason)
}
