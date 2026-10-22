import os,sys,json,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent/'scripts'))
os.environ['PHONE_CLOUD_LOOKUP_OCR_PYTHON']=r'D:\PhoneCloud\agent\runtime\lookup-ocr\Scripts\python.exe'
import alipay_visual_result as visual
from lookup_ocr_runtime import close
base=Path(__file__).resolve().parent
out=[]
try:
 for sample in json.loads((base/'private-evidence/index.json').read_text()):
  raw=(base/'private-evidence'/('case-%02d.jpg'%sample['case'])).read_bytes();start=time.monotonic();frames=[]
  try:
   for frame in range(2):
    rows,size=visual.recognize(raw,timeout=10)
    if visual.protection(rows,size) or visual.search_loading(rows,sample['phone'],size):raise ValueError('protected_or_loading')
    result=visual.parse_rows(rows,sample['phone'],size)
    category=('unverified' if result.get('notFound') else 'named') if result else ('empty' if visual.parse_empty_rows(rows,sample['phone'],size) else 'unconfirmed')
    frames.append(category)
   out.append({'case':sample['case'],'expected':sample['expected'],'categories':frames,'passed':frames==[sample['expected']]*2,'milliseconds':round((time.monotonic()-start)*1000)})
  except Exception as e:out.append({'case':sample['case'],'passed':False,'errorType':type(e).__name__})
finally:close()
report={'nativePython':sys.version.split()[0],'offlineOnly':True,'adbCalls':0,'deviceQueries':0,'systemIdentityChanged':False,'cases':out,'passed':sum(x['passed'] for x in out),'total':len(out)}
(base/'WINDOWS_OCR_RESULT.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));sys.exit(0 if report['passed']==report['total']==21 else 1)
