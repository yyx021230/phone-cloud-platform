"""Replay the observed blocked-My startup, using the real 177 modal pixels.
No ADB subprocess, phone, credentials or network is accessed.
"""
import contextlib
import importlib.util
import io
import itertools
import json
import pathlib
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from unittest import mock

HERE=pathlib.Path(__file__).resolve().parent
MODAL=(HERE/'optional-realname-modal.png').read_bytes()


def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def replay(module):
    import cv2
    import numpy as np
    ok,empty=cv2.imencode('.png',np.full((1604,720,3),70,dtype=np.uint8));assert ok
    home=ET.fromstring(f'<hierarchy><node resource-id="{module.TAB_SELECTED_FRAME_ID}" content-desc="首页" selected="true"/><node text="我的" resource-id="{module.TAB_DESCRIPTION_ID}" selected="false" bounds="[576,1496][720,1604]"/></hierarchy>')
    settings=ET.fromstring(f'<hierarchy><node resource-id="{module.SETTINGS_ENTRY_ID}" content-desc="设置" bounds="[648,78][696,174]"/></hierarchy>')
    r=module.Runner({'serial':'OFFLINE','taskId':'blocked-start-replay'})
    state={'modal':True,'my':False,'closeTaps':0,'myTaps':0,'otherInputs':0}
    r.focus_state=mock.Mock(return_value=([], 'mCurrentFocus='+module.ALIPAY_HOME, 'mFocusedApp='+module.ALIPAY_HOME))
    r.dismiss_known_overlay=mock.Mock(return_value=False) # XML exposes only underlying Home.
    r.dump=lambda token: (settings if state['my'] else home,{})
    def adb(args,**kwargs):
        if args==['exec-out','screencap','-p']:
            return MODAL if state['modal'] else empty.tobytes()
        if args==['shell','input','tap','360','1254']:
            state['closeTaps']+=1;state['modal']=False
        elif args==['shell','input','tap','648','1550']:
            state['myTaps']+=1;state['my']=not state['modal']
        elif args==['shell','input','tap','672','126']:
            pass # Exact Settings, after verified My navigation.
        else:
            state['otherInputs']+=1
        return ''
    r.adb=adb
    clock=itertools.count()
    with contextlib.redirect_stdout(io.StringIO()),mock.patch.object(module.time,'time',side_effect=lambda:next(clock)),mock.patch.object(module.time,'sleep'):
        try:
            r.enter_my_settings('preflight');state['status']='ready_for_settings'
        except RuntimeError as e:
            state['status']=str(e)
    return state


if __name__=='__main__':
    baseline=subprocess.check_output(['git','show','b2c6dcdf:releases/platform-api-docs-20261010-rc.1/windows-agent/scripts/alipay_name_lookup.py'])
    with tempfile.TemporaryDirectory(prefix='pc-prompt-offline-') as tmp:
        old=pathlib.Path(tmp)/'runner.py';old.write_bytes(baseline)
        result={'baseline':replay(load(old,'baseline_canvas')),'candidate':replay(load(HERE.parent/'windows-agent/scripts/alipay_name_lookup.py','candidate_canvas'))}
    assert result['baseline']['status']=='alipay_account_settings_navigation_failed',result
    assert result['baseline']['closeTaps']==0 and result['baseline']['myTaps']==3,result
    assert result['candidate']['status']=='ready_for_settings' and result['candidate']['closeTaps']==1,result
    assert result['candidate']['myTaps']==2 and result['candidate']['otherInputs']==0,result
    print(json.dumps(result,indent=2))
