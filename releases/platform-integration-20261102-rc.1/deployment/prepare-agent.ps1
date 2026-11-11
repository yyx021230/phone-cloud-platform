. (Join-Path $PSScriptRoot 'agent-release-common.ps1')
$null=Assert-Task
Assert-Agent
Assert-Adb
Assert-Before
if(Test-Path -LiteralPath $script:Backup){throw 'backup_directory_already_exists'}
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'extracted')){throw 'extraction_directory_already_exists'}
if((File-Hash (Join-Path $PSScriptRoot 'payload.zip')) -ne $script:ZipHash){throw 'payload_zip_hash_mismatch'}
Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'payload.zip') -DestinationPath (Join-Path $PSScriptRoot 'extracted')
Assert-Payload
$frozen=Frozen-Facts
$overlay=Join-Path $PSScriptRoot 'runtime-overlay'
$null=New-Item -ItemType Directory -Path $script:Backup
foreach($f in $script:Manifest.files){
 $current=Join-Path $script:Root $f.path
 if($null -ne $f.beforeSha256){
  $backupFilePath=Join-Path $script:Backup $f.path
  $null=New-Item -ItemType Directory -Force -Path (Split-Path $backupFilePath)
  Copy-Item -LiteralPath $current -Destination $backupFilePath
  if((File-Hash $backupFilePath) -cne $f.beforeSha256){throw 'backup_file_hash_mismatch'}
 }
 $target=Join-Path $overlay $f.path
 $null=New-Item -ItemType Directory -Force -Path (Split-Path $target)
 $overlaySourcePath=if($f.action -in @('add','update')){Join-Path (Join-Path $PSScriptRoot 'extracted') $f.path}else{$current}
 Copy-Item -LiteralPath $overlaySourcePath -Destination $target
 if((File-Hash $target) -cne $f.expectedAfterSha256){throw 'overlay_file_hash_mismatch'}
}
$python='D:\PhoneCloud\tools\python39\python.exe'
$dependency=& $python -I -B -c "import json,importlib.util,psutil;print(json.dumps({'psutil':psutil.__version__,'airtest':importlib.util.find_spec('airtest')is not None,'poco':importlib.util.find_spec('poco')is not None}))"
if($LASTEXITCODE -ne 0){throw 'python_dependencies_unconfirmed'}
$dep=$dependency|ConvertFrom-Json
if(-not $dep.airtest -or -not $dep.poco){throw 'python_sdk_missing'}
$scriptList=@($script:Manifest.files|Where-Object{$_.path -like 'scripts/wecom_*.py'}|ForEach-Object{[IO.Path]::GetFileNameWithoutExtension($_.path)})|ConvertTo-Json -Compress
$moduleToken=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($scriptList))
$code="import base64,importlib,json,sys;sys.path.insert(0,sys.argv[1]);[importlib.import_module(n) for n in json.loads(base64.b64decode(sys.argv[2]))];print('runtime_import_ok')"
$import=& $python -I -S -B -c $code (Join-Path $overlay 'scripts') $moduleToken
if($LASTEXITCODE -ne 0 -or $import -ne 'runtime_import_ok'){throw 'runtime_import_closure_failed'}
& 'D:\PhoneCloud\tools\node\node.exe' --check (Join-Path $overlay 'src/index.mjs')
if($LASTEXITCODE -ne 0){throw 'agent_syntax_failed'}
Assert-Before
Assert-Frozen $frozen
Assert-Adb
Assert-Agent
if($script:Source -cne $script:Manifest.sourceCommit){throw 'release_source_binding_changed'}
$receipt=[ordered]@{state='prepared_not_activated';sourceCommit=$script:Source;at=[DateTime]::UtcNow.ToString('o');payloadFiles=$script:Manifest.payloadFileCount;runtimePaths=$script:Manifest.runtimePathCount;backupRoot=$script:Backup;frozen=$frozen;dependencies=$dep;runtimePythonImports=$scriptList;nodeSyntax=$true;productionChanged=$false}
Write-Receipt 'PREPARED.json' $receipt
$receipt|ConvertTo-Json -Depth 7 -Compress
