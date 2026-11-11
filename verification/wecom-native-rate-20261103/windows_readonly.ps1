
$ErrorActionPreference='Stop'
$nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]index\.mjs' })
$ports=@(Get-NetTCPConnection -State Listen -LocalPort 5037 | Select-Object -ExpandProperty OwningProcess -Unique)
function Row($p) { $o=Invoke-CimMethod -InputObject $p -MethodName GetOwner; @{pid=$p.ProcessId;parentPid=$p.ParentProcessId;path=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');owner=($o.Domain+'\'+$o.User)} }
$agents=@($nodes | ForEach-Object { Row $_ })
$servers=@($ports | ForEach-Object { $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_); if($null -eq $p){throw 'listener_process_missing'}; Row $p })
$files=@{}
foreach($name in @('src/index.mjs','src/wecom-preview-task.mjs','src/wecom-cleanup-protocol.mjs','scripts/wecom_platform_preview.py','scripts/wecom_system_runtime.py','scripts/wecom_host_identity.py')) { $p=Join-Path 'D:\PhoneCloud\agent' $name; $files[$name]=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
@{at=[DateTime]::UtcNow.ToString('o');agents=$agents;adbListeners=$servers;files=$files;phoneActions=0;adbClientCalls=0} | ConvertTo-Json -Depth 6 -Compress
