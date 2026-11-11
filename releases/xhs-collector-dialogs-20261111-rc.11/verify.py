"""Run the candidate's exact offline suite without ADB or network calls."""
import importlib.util
from pathlib import Path
import sys
import unittest

RELEASE = Path(__file__).resolve().parent
ROOT = RELEASE.parents[1]
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT / "windows-agent/scripts"), str(ROOT / "releases/xhs-collector-recovery-20261109-rc.7")]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

candidate = module("final_dialog_candidate", ROOT / "windows-agent/scripts/小红书数据同步.py")
paths = [
    RELEASE / "test_existing_anr_wait.py",
    RELEASE / "test_anr_navigation.py",
    RELEASE / "test_late_poco.py",
    RELEASE / "test_anr_classification.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.6/test_anr_history_wake.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.6/test_current_focus_history.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.4/test_clean_root_exit.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.4/test_profile_root_recheck.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.4/test_startup_wake.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.4/test_reset_timeout.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.3/test_blank_viewport.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.3/test_navigation_transition.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.2/test_control_center.py",
    ROOT / "releases/xhs-collector-dialogs-20261111-rc.2/test_dialogs.py",
    ROOT / "releases/xhs-collector-recovery-20261109-rc.7/test_candidate.py",
    ROOT / "releases/xhs-collector-recovery-20261110-rc.1/test_note_status.py",
    ROOT / "releases/xhs-collector-recovery-20261110-rc.2/test_works_tab_timeout.py",
    ROOT / "releases/xhs-collector-recovery-20261110-rc.3/test_keyguard_timeout.py",
]
suite = unittest.TestSuite()
for i, path in enumerate(paths):
    tests = module("dialog_verification_" + str(i), path)
    tests.sync = candidate
    suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(tests))
result = unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
