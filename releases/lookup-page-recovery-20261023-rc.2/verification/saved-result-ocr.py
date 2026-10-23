"""Read saved images locally; report hashes/kinds only. No ADB or model calls."""
from pathlib import Path
import sys, json, hashlib, argparse, re, time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'windows-agent/scripts'))
from alipay_visual_result import _recognize_local, parse_rows, parse_empty_rows, protection
p=argparse.ArgumentParser();p.add_argument('directories',nargs='+');a=p.parse_args();out=[];seen=set()
for directory in a.directories:
    for image in sorted(Path(directory).glob('*.jpg')):
        if image.name.startswith('contact'):continue
        raw=image.read_bytes();digest=hashlib.sha256(raw).hexdigest()
        if digest in seen:continue
        seen.add(digest);start=time.monotonic();rows,size=_recognize_local(raw)
        inputs=[re.sub(r'\s+','',str(t)) for box,t,score in rows if re.fullmatch(r'1\d{10}',re.sub(r'\s+','',str(t))) and sum(float(x[1]) for x in box)/(4*size[1])<.14 and score>=.98]
        phone=inputs[0] if len(inputs)==1 else ''
        result=parse_rows(rows,phone,size) if phone else None
        empty=parse_empty_rows(rows,phone,size) if phone and not result else None
        kind='name' if result and not result.get('notFound') else 'unverified' if result else 'no_name' if empty else 'protected' if protection(rows,size) else 'unconfirmed'
        out.append({'sha256':digest,'kind':kind,'elapsedMs':round((time.monotonic()-start)*1000),'hasExactInput':bool(phone),'method':result.get('matchMethod') if result else None})
print(json.dumps({'images':out,'count':len(out),'phoneActions':0,'modelCalls':0}))
