import sys,pathlib,runpy,subprocess,json,time
root=pathlib.Path(__file__).parent;sys.path.insert(0,str(root/'scripts'))
import alipay_name_lookup as lookup
original=lookup.Runner.poco_result_snapshot

def snapshot(self,poco,stage):
    # Fault at the actual post-OCR boundary, once in the original task only.
    if self.payload.get('_faultAfterFrame') and stage=='visual_after':
        self.emit('test_injected_visual_after_timeout',controlledFault=True,resubmitsInput=False)
        class DeadReader:
            def freeze(self):raise TimeoutError('HTTPConnectionPool(host=127.0.0.1): Read timed out. (read timeout=2.0)')
        return original(self,DeadReader(),stage)
    try:return original(self,poco,stage)
    except Exception:
        # Preserve bounded first-failure transport/system evidence before recovery.
        evidence={'at':time.time(),'stage':stage,'controlled':False,'reads':[]}
        for args in [['shell','echo','reader_diag_ok'],['shell','pidof','com.netease.open.pocoservice'],['logcat','-b','events','-d','-t','100']]:
            begin=time.monotonic()
            try:
                r=subprocess.run([self.adb_path,'-s',self.serial]+args,capture_output=True,timeout=3)
                evidence['reads'].append({'args':args,'code':r.returncode,'ms':round((time.monotonic()-begin)*1000),'out':r.stdout.decode('utf8','replace')[-16000:],'err':r.stderr.decode('utf8','replace')[-2000:]})
            except Exception as e:evidence['reads'].append({'args':args,'errorType':type(e).__name__,'ms':round((time.monotonic()-begin)*1000)})
        (root/('natural-failure-'+str(time.time_ns())+'-private.json')).write_text(json.dumps(evidence),encoding='utf8')
        raise
lookup.Runner.poco_result_snapshot=snapshot
runpy.run_path(str(root/'scripts/xhs_airtest_poco.py'),run_name='__main__')
