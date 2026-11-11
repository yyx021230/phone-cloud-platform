$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$script:Root='D:\PhoneCloud\agent'
$script:TaskName='PhoneCloud Windows Agent'
$script:TaskPath='\'
$script:Source='32c0091a534aa7f9038deb91aa33f202f72e0e6b'
$script:ManifestHash='7ad822bbf45b2d2b71bc9f491b7e61bcdf01ecc2625adb457a03b8c0f463a06d'
$script:ZipHash='7c4278d18e4115e4efcb0487ded24e279e9d6a9d84fa3f49c5e8d45459ba78e6'
$script:Backup='D:\PhoneCloud\backups\platform-integration-20261102-rc.1-win-32c0091-prep3'
function File-Hash([string]$p){if(Test-Path -LiteralPath $p){return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()};return $null}
function Text-Hash([string]$s){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Write-Receipt([string]$name,$value){$value|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $PSScriptRoot $name) -Encoding UTF8}
if((File-Hash (Join-Path $PSScriptRoot 'AGENT_MANIFEST.json')) -ne $script:ManifestHash){throw 'release_manifest_hash_mismatch'}
$script:Manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'AGENT_MANIFEST.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($script:Manifest.sourceCommit -ne $script:Source -or $script:Manifest.files.Count -ne $script:Manifest.runtimePathCount){throw 'release_binding_mismatch'}
if($script:Manifest.mustInclude.'scripts/小红书数据同步.py' -cne 'c4f0fd8cb50bd87085de18d781d52c52bb49cf9537abf11094e9592cafb3a179'){throw 'xhs_must_include_binding_missing'}
if(@($script:Manifest.files|Where-Object{$_.path -ceq 'scripts/小红书数据同步.py' -and $_.candidateSha256 -ceq $script:Manifest.mustInclude.'scripts/小红书数据同步.py'}).Count -ne 1){throw 'xhs_must_include_path_missing'}
foreach($f in $script:Manifest.files){if($f.path -cnotin @('scripts/小红书数据同步.py','scripts/feishu-kuaishou-lead.mjs') -and $f.path -notmatch '^(src/[A-Za-z0-9_.-]+\.mjs|scripts/[A-Za-z0-9_-]+\.(py|json|ps1|png)|scripts/native/[A-Za-z0-9_-]+\.jar)$'){throw 'release_path_invalid'}}
function Assert-Task{
 $t=Get-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath
 if($t.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM') -or [string]$t.Principal.LogonType -ne 'ServiceAccount'){throw 'task_identity_changed'}
 if((Text-Hash (Export-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath)) -ne $script:Manifest.expectedTaskXmlSha256){throw 'task_definition_changed'}
 return $t
}
function Process-Fact($p){
 $o=Invoke-CimMethod -OperationTimeoutSec 2 -InputObject $p -MethodName GetOwner
 return [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;path=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');owner=($o.Domain+'\'+$o.User)}
}
function Find-Agent{
 return @(Get-CimInstance Win32_Process -OperationTimeoutSec 2 -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -match 'D:\\PhoneCloud\\agent\\src\\index\.mjs'})
}
function Assert-Process($expected){
 $p=Get-CimInstance Win32_Process -OperationTimeoutSec 2 -Filter ('ProcessId='+$expected.pid)
 if(-not $p){throw 'required_process_absent'}
 $f=Process-Fact $p
 if($f.path -cne $expected.path -or $f.owner -cne $expected.owner -or $f.createdAt -cne $expected.createdAt){throw 'process_identity_changed'}
 return $p
}
function Assert-Adb{
 $rows=@(Get-NetTCPConnection -LocalPort 5037 -State Listen)
 $ids=@($rows|Select-Object -ExpandProperty OwningProcess -Unique)
 if($ids.Count -ne 1 -or $ids[0] -ne $script:Manifest.expectedAdb.pid -or @($rows|Where-Object{$_.LocalAddress -ne '127.0.0.1'}).Count){throw 'adb_listener_changed'}
 $null=Assert-Process $script:Manifest.expectedAdb
}
function Assert-Agent{
 $agents=@(Find-Agent)
 if($agents.Count -ne 1 -or $agents[0].ProcessId -ne $script:Manifest.expectedAgent.pid){throw 'agent_single_instance_changed'}
 $null=Assert-Process $script:Manifest.expectedAgent
}
function Assert-Before{
 foreach($f in $script:Manifest.files){if((File-Hash (Join-Path $script:Root $f.path)) -cne $f.beforeSha256){throw ('production_file_drift:'+ $f.path)}}
}
function Assert-After{
 foreach($f in $script:Manifest.files){if((File-Hash (Join-Path $script:Root $f.path)) -cne $f.expectedAfterSha256){throw ('installed_file_mismatch:'+ $f.path)}}
}
function Frozen-Facts{
 return [ordered]@{config=(File-Hash (Join-Path $script:Root 'config.json'));authEnv=(File-Hash (Join-Path $script:Root 'adb-auth-env.cjs'));package=(File-Hash (Join-Path $script:Root 'package.json'));lock=(File-Hash (Join-Path $script:Root 'package-lock.json'));task=(Text-Hash (Export-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath))}
}
function Assert-Frozen($expected){
 $now=Frozen-Facts
 foreach($k in @('config','authEnv','package','lock','task')){if($now[$k] -cne $expected.$k){throw ('frozen_file_changed:'+ $k)}}
}
function Assert-Payload{
 if((File-Hash (Join-Path $PSScriptRoot 'payload.zip')) -ne $script:ZipHash){throw 'payload_zip_hash_mismatch'}
 $dir=Join-Path $PSScriptRoot 'extracted'
 foreach($f in $script:Manifest.files|Where-Object{$_.action -in @('add','update')}){if((File-Hash (Join-Path $dir $f.path)) -cne $f.candidateSha256){throw ('payload_file_hash_mismatch:'+ $f.path)}}
 if(@(Get-ChildItem -LiteralPath $dir -File -Recurse).Count -ne $script:Manifest.payloadFileCount){throw 'payload_file_count_mismatch'}
}
