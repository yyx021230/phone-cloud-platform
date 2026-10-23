# -*- coding: utf-8 -*-
"""Offline annotation only; no network or phone control."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import argparse,json,hashlib
p=argparse.ArgumentParser();p.add_argument('--detections',required=True);p.add_argument('--images',required=True);p.add_argument('--out',required=True);a=p.parse_args()
rows=json.loads(Path(a.detections).read_text());rows=rows['images'] if isinstance(rows,dict) else rows
out=Path(a.out);out.mkdir(mode=0o700,parents=True,exist_ok=True);manifest=[]
for row in rows:
 src=Path(a.images)/row['file'];assert hashlib.sha256(src.read_bytes()).hexdigest()==row['imageSha256']
 im=Image.open(src).convert('RGB');assert list(im.size)==row['size'];raw=out/(src.stem+'-raw.png');im.save(raw)
 marked=im.copy();d=ImageDraw.Draw(marked);candidates=[]
 try:font=ImageFont.truetype('/System/Library/Fonts/Monaco.ttf',20)
 except OSError:font=ImageFont.load_default()
 for i,c in enumerate(row['boxes']):
  box=c['box'];cid='b'+str(i);candidates.append({'id':cid,'box':box});d.rectangle(box,outline='#ff2525',width=2)
  x,y=box[0],max(0,box[1]-24);d.rectangle((x,y,x+55,y+24),fill='#000000');d.text((x+2,y),cid,font=font,fill='#ffffff')
 annotated=out/(src.stem+'-boxes.png');marked.save(annotated)
 manifest.append({'label':src.stem,'raw':str(raw.resolve()),'annotated':str(annotated.resolve()),'width':im.width,'height':im.height,'candidates':candidates})
(out/'inputs.json').write_text(json.dumps(manifest,indent=2));print('Prepared',len(manifest),'private image pairs; no network or phone actions.')
for f in out.iterdir():f.chmod(0o600)
