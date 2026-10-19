"""New-host runtime smoke test: no Agent startup, ADB invocation, phone or network request."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    args = parser.parse_args()
    baseline = json.loads((args.bundle/'RELOCATION_BASELINE.json').read_text())
    if os.name != 'nt' or platform.node().lower() == baseline['sourceComputer'].lower():
        raise SystemExit('Run on the new Windows host only.')
    root = Path(r'D:\PhoneCloud')
    commands = [
        ('node', [str(root/'tools/node/node.exe'), '--version']),
        ('node_dependencies', [str(root/'tools/node/node.exe'), '-e',
            "for (const m of ['ws','@yume-chan/adb','@yume-chan/adb-server-node-tcp','@yume-chan/adb-scrcpy']) require.resolve(m); console.log('resolved');"]),
        ('python_native_dependencies', [str(root/'tools/python39/python.exe'), '-c',
            "import cv2,numpy,PIL,importlib.metadata as m; assert m.version('airtest')=='1.4.3'; assert m.version('pocoui')=='1.0.94'; print('loaded')"]),
        ('lookup_ocr_native_and_models', [str(root/'agent/runtime/lookup-ocr/Scripts/python.exe'), '-c',
            "import numpy as np; import onnxruntime,cv2; from rapidocr_onnxruntime import RapidOCR; engine=RapidOCR(); engine(np.zeros((64,256,3),dtype=np.uint8)); print('inference_completed')"]),
        ('windows_chinese_ocr', ['powershell','-NoProfile','-NonInteractive','-Command',
            "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Runtime.WindowsRuntime;$t=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime];$l=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime];if($null -eq $t::TryCreateFromLanguage($l::new('zh-Hans-CN'))){throw 'missing Chinese OCR'};Write-Output 'engine_created'"]),
    ]
    results = []
    for name, command in commands:
        try:
            result = subprocess.run(command, cwd=root/'agent', capture_output=True, timeout=60)
            results.append({'check': name, 'passed': result.returncode == 0, 'exit': result.returncode})
        except (OSError, subprocess.TimeoutExpired) as error:
            results.append({'check': name, 'passed': False, 'failure': type(error).__name__})
    print(json.dumps({'checks': results, 'agentStarted': False, 'adbInvoked': False}, indent=2))
    raise SystemExit(0 if all(item['passed'] for item in results) else 1)


if __name__ == '__main__':
    main()
