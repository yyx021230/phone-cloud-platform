from pathlib import Path
from unittest import mock
import json,time,xml.etree.ElementTree as ET
import alipay_name_lookup as m
raw=Path(__file__).with_name('usb.jpg').read_bytes()
root=ET.fromstring(Path(__file__).with_name('usb.xml').read_text(encoding='utf-8'))
r=m.Runner({'serial':'SYNTHETIC','taskId':'saved-frame-replay'});closed=[False];commands=[]
def focus(**kw):
 return ['mCurrentFocus=Window{x u0 '+(m.ALIPAY_PACKAGE+'/.AlipayLogin' if closed[0] else m.COLOROS_SECUREPAY_PACKAGE)+'}','mFocusedApp=ActivityRecord{x u0 '+m.ALIPAY_PACKAGE+'/.AlipayLogin}']
r.focus=focus;r.emit=mock.Mock()
target=r.coloros_securepay_usb_evidence(root)['ignore'];expected=r.bounds_center(target.get('bounds'))
def adb(args,**kw):
 if args==['exec-out','screencap','-p']:return raw
 assert args[:3]==['shell','input','tap'],args
 xy=tuple(map(int,args[3:]));commands.append(xy);closed[0]=True;return ''
r.adb=adb
started=time.monotonic();assert r.dismiss_coloros_securepay_usb_dialog(root,{c:p for p in root.iter() for c in p});assert commands==[expected]
closed[0]=False;commands.clear();assert r.dismiss_system_text_overlay('coloros_usb')
assert len(commands)==1; x,y=commands[0]
import re
x1,y1,x2,y2=map(int,re.findall(r'\d+',target.get('bounds')))
assert x1<=x<=x2 and y1<=y<=y2
print(json.dumps({'nativeButton3':True,'bareWindowOcrTwoFrames':True,'ocrTapInsideNativeIgnore':True,'postCloseVerified':closed[0],'elapsedMs':round((time.monotonic()-started)*1000),'deviceCommands':0,'usbModeChanged':False}))
