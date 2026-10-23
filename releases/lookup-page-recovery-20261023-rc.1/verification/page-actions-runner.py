"""Bridge the real Python Runner (simulated device I/O) to HTTP task failures."""
import json,sys
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'windows-agent/scripts'))
from test_lookup_page_actions import run_frames,NETWORK,USB,UPDATE,ActionSafetyTests,SIZE
from test_lookup_overlay_guard import clock
import alipay_visual_result as visual
out={}
try:run_frames([NETWORK],budget=10)
except RuntimeError as e:out['networkFailure']=str(e)
assert out.get('networkFailure')=='local_lookup_result_unconfirmed:network_refresh_exhausted'
for kind,rows in [('coloros_usb',USB),('vivo_update',UPDATE)]:
 runner,state=ActionSafetyTests().fixture(kind)
 with clock(),mock.patch.object(visual,'recognize',return_value=(rows,SIZE)):
  result=runner.run_poco(mock.Mock())
 assert result['postHumanResult'] and result['realNameTailCharacter']=='甲'
 assert len([c for c in state['commands'] if c[:3]==['shell','input','tap']])==1
 out[kind]={'originalResultResumed':True,'safeTapCount':1,'retyped':False}
print(json.dumps(out))
