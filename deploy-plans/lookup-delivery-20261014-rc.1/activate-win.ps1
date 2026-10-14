# EXECUTE ONLY AFTER explicit approval for candidate/shared Agent interruption.
param([switch]$ApprovedMaintenance)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if(-not $ApprovedMaintenance){throw 'maintenance approval flag required'}
$s='D:\PhoneCloud\staging\lookup-delivery-20261014-rc.1';$root='D:\PhoneCloud\agent';$b="$root\backups\lookup-delivery-20261014-rc.1"
$m=Get-Content "$s\PREPARED.json" -Raw|ConvertFrom-Json
foreach($r in $m.files){if((Get-FileHash (Join-Path $root $r.path)).Hash.ToLower() -ne $r.before){throw 'running source drift'};if((Get-FileHash (Join-Path "$s\files" $r.path)).Hash.ToLower() -ne $r.after){throw 'staged source drift'};if((Get-FileHash (Join-Path $b $r.path)).Hash.ToLower() -ne $r.before){throw 'backup drift'}}
$nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -like '*D:\PhoneCloud\agent\src\index.mjs*'})
if($nodes.Count -ne 1 -or $nodes[0].ProcessId -ne 605432){throw 'Agent baseline changed'}
$adb=Get-Process -Id 312588 -ErrorAction Stop
Stop-ScheduledTask -TaskName 'PhoneCloud Windows Agent'
Start-Sleep -Seconds 2
if(Get-Process -Id 605432 -ErrorAction SilentlyContinue){throw 'old Agent did not stop; no files copied'}
try {
 foreach($r in $m.files){if($r.before -ne $r.after){Copy-Item (Join-Path "$s\files" $r.path) (Join-Path $root $r.path) -Force};if((Get-FileHash (Join-Path $root $r.path)).Hash.ToLower() -ne $r.after){throw 'activation hash mismatch'}}
 Start-ScheduledTask -TaskName 'PhoneCloud Windows Agent'
} catch {
 foreach($r in $m.files){if($r.before -ne $r.after){Copy-Item (Join-Path $b $r.path) (Join-Path $root $r.path) -Force}}
 Start-ScheduledTask -TaskName 'PhoneCloud Windows Agent';throw
}
Start-Sleep -Seconds 3
$nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -like '*D:\PhoneCloud\agent\src\index.mjs*'})
if($nodes.Count -ne 1){throw 'Agent instance count'}
$adbAfter=Get-Process -Id 312588 -ErrorAction Stop
if($adb.StartTime -ne $adbAfter.StartTime){throw 'ADB unexpectedly changed'}
$out=[pscustomobject]@{version=$m.version;sourceCommit=$m.sourceCommit;agentPid=$nodes[0].ProcessId;adbPid=$adbAfter.Id;adbStartUnchanged=$true;files=$m.files;at=(Get-Date).ToUniversalTime().ToString('o')}
$out|ConvertTo-Json -Depth 5|Set-Content "$s\ACTIVATION.json" -Encoding UTF8
$out|ConvertTo-Json -Depth 5
