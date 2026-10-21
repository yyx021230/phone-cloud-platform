from pathlib import Path
import sys,json,time
stage=Path(r'D:\PhoneCloud\agent\staging\lookup-ocr-probe-pressure-20261020-rc1');sys.path.insert(0,str(stage))
from alipay_visual_result import parse_empty_rows,_recognize_local
frames=json.loads((stage/'fixtures/lookup_recharge_recommendations.json').read_text(encoding='utf-8'))
for f in frames:assert parse_empty_rows(f['rows'],'10123456789',f['size'])['notFound'] is True
import cv2,numpy as np
img=np.full((120,1000,3),255,dtype=np.uint8);cv2.putText(img,'1234567890',(20,85),cv2.FONT_HERSHEY_SIMPLEX,2,(0,0,0),3);ok,raw=cv2.imencode('.png',img);assert ok
start=time.perf_counter();rows,size=_recognize_local(raw.tobytes());assert any('1234567890' in x[1].replace(' ','') for x in rows)
result={'passed':True,'platform':'Windows','parserFixtures':len(frames),'nativeInference':'synthetic_digits','seconds':round(time.perf_counter()-start,3),'phoneCommands':0,'liveScriptsChanged':False}
(stage/'NATIVE-VERIFIED.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
