param([switch]$SwitchAuthorized)
. (Join-Path $PSScriptRoot 'agent-release-common.ps1')
if(-not $SwitchAuthorized){throw 'root_switch_authorization_required'}
$prepared=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'PREPARED.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($prepared.sourceCommit -ne $script:Source -or $prepared.state -ne 'prepared_not_activated'){throw 'prepared_receipt_mismatch'}
$null=Assert-Task
Assert-Agent
Assert-Adb
Assert-Before
Assert-Frozen $prepared.frozen
Assert-Payload
foreach($f in $script:Manifest.files|Where-Object{$null -ne $_.beforeSha256}){if((File-Hash (Join-Path $script:Backup $f.path)) -cne $f.beforeSha256){throw 'backup_missing_or_changed'}}
$all=@(Get-CimInstance Win32_Process -OperationTimeoutSec 2)
$front=@([int]$script:Manifest.expectedAgent.pid);$owned=@()
for($i=0;$i -lt 8 -and $front.Count -gt 0;$i++){$next=@($all|Where-Object{$_.ParentProcessId -in $front});$owned+=$next;$front=@($next.ProcessId)}
$business=@()
foreach($p in $owned|Where-Object{$_.Name -in @('python.exe','pythonw.exe')}){
 if($p.ExecutablePath -notin @('D:\PhoneCloud\tools\python39\python.exe','D:\PhoneCloud\agent\runtime\lookup-ocr\Scripts\python.exe') -or $p.CommandLine -notmatch 'D:\\PhoneCloud\\agent\\scripts\\(xhs_airtest_poco|alipay_name_lookup|lookup_ocr_worker|xhs_publish_poco|xhs_xml_uiautomator|wecom_platform_preview|wecom_cleanup_verify|kuaishou_vehicle_lead|小红书数据同步)\.py'){throw 'unrecognized_python_descendant'}
 $f=Process-Fact $p
 if($f.owner -cne 'NT AUTHORITY\SYSTEM'){throw 'business_python_identity_unconfirmed'}
 $business+=$f
}
$knownParents=@([int]$script:Manifest.expectedAgent.pid)+@($owned.ProcessId)
function New-BusinessSnapshot{
 $rows=@(Get-CimInstance Win32_Process -OperationTimeoutSec 2)
 $front=@($knownParents);$seen=@{};$descendants=@()
 for($depth=0;$depth -lt 8 -and $front.Count -gt 0;$depth++){
  $next=@($rows|Where-Object{$_.ParentProcessId -in $front -and -not $seen.ContainsKey([int]$_.ProcessId)})
  foreach($p in $next){$seen[[int]$p.ProcessId]=$true}
  $descendants+=$next;$front=@($next.ProcessId)
 }
 $facts=@()
 foreach($p in $descendants|Where-Object{$_.Name -in @('python.exe','pythonw.exe')}){
  if($p.ExecutablePath -notin @('D:\PhoneCloud\tools\python39\python.exe','D:\PhoneCloud\agent\runtime\lookup-ocr\Scripts\python.exe') -or $p.CommandLine -notmatch 'D:\\PhoneCloud\\agent\\scripts\\(xhs_airtest_poco|alipay_name_lookup|lookup_ocr_worker|xhs_publish_poco|xhs_xml_uiautomator|wecom_platform_preview|wecom_cleanup_verify|kuaishou_vehicle_lead|小红书数据同步)\.py'){throw 'unrecognized_late_python_descendant'}
  $f=Process-Fact $p
  if($f.owner -cne 'NT AUTHORITY\SYSTEM'){throw 'late_business_python_identity_unconfirmed'}
  $facts+=$f
 }
 return $facts
}
function Stop-Exact($fact){
 $c=Get-CimInstance Win32_Process -OperationTimeoutSec 2 -Filter ('ProcessId='+$fact.pid)
 if(-not $c){return}
 $actual=Process-Fact $c
 if($actual.createdAt -cne $fact.createdAt -or $actual.path -cne $fact.path -or $actual.owner -cne $fact.owner){throw 'stop_target_identity_changed'}
 $p=Get-Process -Id $fact.pid
 $null=$p.Handle
 $processTicks=$p.StartTime.ToUniversalTime().Ticks;$cimTicks=$c.CreationDate.ToUniversalTime().Ticks
 if(($processTicks-($processTicks%10)) -ne ($cimTicks-($cimTicks%10))){throw 'process_handle_creation_changed'}
 $p.Kill()
 if(-not $p.WaitForExit(1000)){throw 'exact_process_exit_timeout'}
}
$clock=[Diagnostics.Stopwatch]::StartNew()
$installed=@()
function Assert-SwitchBudget{if($clock.ElapsedMilliseconds -gt 30000){throw 'switch_30s_budget_exhausted'};if(@(Find-Agent).Count -gt 0){throw 'unexpected_agent_restart'}}
try{
 Stop-Exact $script:Manifest.expectedAgent
 for($i=$business.Count-1;$i -ge 0;$i--){Assert-SwitchBudget;Stop-Exact $business[$i]}
 for($round=0;$round -lt 3;$round++){
  Assert-SwitchBudget
  $late=@(New-BusinessSnapshot)
  if($late.Count -eq 0){break}
  $knownParents+=@($late.pid)
  for($i=$late.Count-1;$i -ge 0;$i--){Assert-SwitchBudget;Stop-Exact $late[$i];$business+=$late[$i]}
 }
 if(@(New-BusinessSnapshot).Count -ne 0){throw 'business_python_did_not_quiesce'}
 foreach($f in $business){$remaining=Get-CimInstance Win32_Process -OperationTimeoutSec 2 -Filter ('ProcessId='+$f.pid);if($remaining -and $remaining.CreationDate.ToUniversalTime().ToString('o') -ceq $f.createdAt){throw 'original_business_python_still_alive'}}
 if(@(Get-CimInstance Win32_Process|Where-Object{$_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -match 'D:\\PhoneCloud\\agent\\scripts\\'}).Count -ne 0){throw 'other_agent_business_python_remaining'}
 Assert-SwitchBudget
 Assert-Adb
 foreach($f in $script:Manifest.files|Where-Object{$_.action -in @('add','update')}){
  Assert-SwitchBudget
  $target=Join-Path $script:Root $f.path
  $temporary=$target+'.platform-32c0091-prep2-new'
  if(Test-Path -LiteralPath $temporary){throw 'switch_temp_file_already_exists'}
  Copy-Item -LiteralPath (Join-Path (Join-Path $PSScriptRoot 'extracted') $f.path) -Destination $temporary
  if((File-Hash $temporary) -cne $f.candidateSha256){throw 'switch_temp_hash_mismatch'}
  Move-Item -LiteralPath $temporary -Destination $target -Force
  $installed+=$f.path
 }
 Assert-SwitchBudget
 Assert-After
 Assert-Frozen $prepared.frozen
 Assert-Adb
 $null=Assert-Task
 Start-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath
 Write-Receipt 'ACTIVATION.json' ([ordered]@{state='task_started_pending_postcheck';sourceCommit=$script:Source;at=[DateTime]::UtcNow.ToString('o');elapsedMs=$clock.ElapsedMilliseconds;installed=$installed;oldBusinessPythonFacts=$business;businessPythonExitConfirmed=$true;phonePhysicalCleanupVerified=$false;adbRestarted=$false;taskDefinitionChanged=$false;automaticRollback=$false})
 [ordered]@{state='task_started_pending_postcheck';sourceCommit=$script:Source;elapsedMs=$clock.ElapsedMilliseconds;installed=$installed.Count}|ConvertTo-Json -Compress
}catch{
 Write-Receipt 'ACTIVATION_FAILED.json' ([ordered]@{state='failed_root_action_required';sourceCommit=$script:Source;at=[DateTime]::UtcNow.ToString('o');elapsedMs=$clock.ElapsedMilliseconds;installed=$installed;automaticRollback=$false;warning='Original task may auto-restart after PT1M; root must retain cloud admission gates. No guarantee Agent remains stopped.';code=([string]$_.Exception.Message)})
 throw
}
