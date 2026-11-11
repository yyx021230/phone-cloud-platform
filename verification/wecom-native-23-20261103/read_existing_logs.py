import sys,json,re
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
base=Path(r'D:\PhoneCloud\agent')
rows=[]
for folder in [base/'logs',base/'data'/'logs',Path(r'D:\PhoneCloud\logs')]:
 if folder.is_dir():
  for f in folder.glob('*'):
   if f.is_file() and f.suffix in ('.log','.txt'):
    with f.open('rb')as h:
     h.seek(max(0,f.stat().st_size-2097152)); raw=h.read(2097152)
    for l in raw.decode('utf-8','replace').splitlines():
     if any(t in l for t in ['781489c2-6f52-4448-ac58-c4efa62103e8','278c3012-04bf-4d61-8bf6-f378b322ea93','680a14a8-3988-4eb4-ad45-734bfafa03fd']):
      l=re.sub(r'1[3-9][0-9]{9}','[masked-phone]',l)
      l=re.sub(r'(?i)(token|authorization|password|secret)[\s\x22:=>]+[^,}\s]+',r'\1:[redacted]',l)
      rows.append({'file':str(f),'line':l[:4096]})
print(json.dumps({'matchingRows':rows,'boundedBytesPerFile':2097152,'adbCalls':0}))
