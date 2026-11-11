"""Run existing element safety tests against this exact candidate; no processes."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
R = Path(__file__).resolve().parent
ROOT = R.parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0,str(ROOT/'windows-agent/scripts'))
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
candidate=load('dialog_broad_candidate',ROOT/'windows-agent/scripts/小红书数据同步.py')
tests=load('dialog_broad_tests',ROOT/'windows-agent/scripts/test_xhs_data_sync.py')
tests.sync=candidate
with patch.object(subprocess,'Popen',side_effect=AssertionError('offline verification must not start a process')):
    result=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(tests))
raise SystemExit(0 if result.wasSuccessful() else 1)
