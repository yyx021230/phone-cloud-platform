$ErrorActionPreference = "Stop"

$runnerFile = "D:\PhoneCloud\agent\scripts\alipay_name_lookup.py"
$candidateFile = "D:\PhoneCloud\staging\20260910-d071-post-jigsaw-focus-v1\merged\scripts\alipay_name_lookup.py"
$backupFile = "D:\PhoneCloud\backups\20260910-before-d071-post-jigsaw-focus-v1\scripts\alipay_name_lookup.py"
$python = "D:\PhoneCloud\tools\python39\python.exe"

$expectedHash = (Get-FileHash $candidateFile -Algorithm SHA256).Hash
New-Item -ItemType Directory -Force -Path (Split-Path $backupFile) | Out-Null
Copy-Item $runnerFile $backupFile -Force
try {
    & $python -m py_compile $candidateFile
    if ($LASTEXITCODE -ne 0) { throw "python_compile_failed" }
    Copy-Item $candidateFile "$runnerFile.d071-new" -Force
    Move-Item "$runnerFile.d071-new" $runnerFile -Force
    if ((Get-FileHash $runnerFile -Algorithm SHA256).Hash -ne $expectedHash) { throw "runner_hash_mismatch" }
    Write-Output "deployment=SUCCESS agentRestarted=false adbRestarted=false"
    Write-Output "runnerHash=$expectedHash"
} catch {
    $reason = $_.Exception.Message
    Copy-Item $backupFile "$runnerFile.rollback" -Force
    Move-Item "$runnerFile.rollback" $runnerFile -Force
    Write-Output "deployment=ROLLED_BACK reason=$reason"
    exit 1
}
