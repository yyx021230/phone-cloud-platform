"""Local transport test only: fail identity before any ADB/phone/lease I/O."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'windows-agent' / 'scripts'))
import wecom_platform_preview as host

def no_adb():
    raise host.SafeStop('adb_identity_unconfirmed')

host.adb_identity = no_adb
host.main()
