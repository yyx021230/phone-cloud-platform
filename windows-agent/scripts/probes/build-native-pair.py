"""Build and test the dedicated reader; requires existing JDK and Android build tools."""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

p = argparse.ArgumentParser()
p.add_argument('--java-home', type=Path, required=True)
p.add_argument('--sdk', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
source = Path(__file__).parent
with tempfile.TemporaryDirectory(prefix='xhs-native-pair-') as folder:
    root = Path(folder); classes = root/'classes'; dex = root/'dex'
    classes.mkdir(); dex.mkdir()
    files = ['NativeElementsProbe.java', 'NativeWindowReader.java', 'NativeWindowPair.java',
             'NativeWindowReaderTest.java', 'NativeWindowPairTest.java']
    subprocess.run([str(a.java_home/'bin/javac'), '--release', '8', '-Xlint:-options', '-d', str(classes),
                    *[str(source/f) for f in files]], check=True)
    for name in ['NativeWindowReaderTest', 'NativeWindowPairTest']:
        subprocess.run([str(a.java_home/'bin/java'), '-cp', str(classes), name], check=True)
    subprocess.run([str(a.sdk/'build-tools/35.0.0/d8'), '--min-api', '24', '--lib', str(a.sdk/'platforms/android-35/android.jar'),
                    '--output', str(dex), *[str(f) for f in sorted(classes.glob('*.class')) if 'Test' not in f.name]],
                   env=dict(os.environ, JAVA_HOME=str(a.java_home)), check=True)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(a.output, 'w') as archive:
        info = zipfile.ZipInfo('classes.dex', (2026, 10, 26, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (dex/'classes.dex').read_bytes())
print(hashlib.sha256(a.output.read_bytes()).hexdigest())
