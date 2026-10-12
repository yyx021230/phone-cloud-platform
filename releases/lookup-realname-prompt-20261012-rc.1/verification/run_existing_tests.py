import importlib.util,pathlib,unittest,sys,contextlib,io
base=pathlib.Path('releases/platform-api-docs-20261010-rc.1/windows-agent/scripts');spec=importlib.util.spec_from_file_location('existing_runner_tests',base/'automation_runners_test.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);old=m.load_module
candidate=pathlib.Path('releases/lookup-realname-prompt-20261012-rc.1/windows-agent/scripts/alipay_name_lookup.py')
def load(name,file):
 if file=='alipay_name_lookup.py':
  s=importlib.util.spec_from_file_location(name,candidate);mod=importlib.util.module_from_spec(s);s.loader.exec_module(mod);return mod
 return old(name,file)
m.load_module=load
with contextlib.redirect_stdout(io.StringIO()):r=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(m))
sys.exit(not r.wasSuccessful())
