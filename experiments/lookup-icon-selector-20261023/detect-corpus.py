from pathlib import Path
import torch,numpy as np,json,time,hashlib
from PIL import Image
from torchvision.ops import nms
import argparse
p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--inventory',required=True);p.add_argument('--out',required=True);a=p.parse_args()
model_path=Path(a.model)
assert hashlib.sha256(model_path.read_bytes()).hexdigest()=='11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c', 'Model hash differs from evaluated baseline'
torch.set_num_threads(4)
t=time.monotonic();model=torch.jit.load(str(model_path),map_location='cpu').eval();print('loaded',time.monotonic()-t,flush=True)
results=[]
inventory=json.loads(Path(a.inventory).read_text())
for case in inventory:
 f=case['id']+Path(case['source']).suffix
 source=Path(case['source'])
 assert hashlib.sha256(source.read_bytes()).hexdigest()==case['fileSha256'], 'Input image changed'
 im=Image.open(source).convert('RGB');w,h=im.size;s=min(1280/w,1280/h);canvas=Image.new('RGB',(1280,1280),(114,114,114));canvas.paste(im.resize((round(w*s),round(h*s)),Image.Resampling.BILINEAR),(0,0))
 x=torch.from_numpy(np.array(canvas)).permute(2,0,1).float()[None]/255;t=time.monotonic()
 with torch.inference_mode(): outputs=model(x)
 boxes=[];scores=[]
 for i,stride in enumerate([8,16,32]):
  cls=outputs[2*i].sigmoid()[0,0];ltrb=outputs[2*i+1][0];gy,gx=torch.meshgrid(torch.arange(cls.shape[-2],dtype=torch.float32),torch.arange(cls.shape[-1],dtype=torch.float32),indexing='ij');cx,cy=gx+.5,gy+.5;l,top,r,b=ltrb
  boxes.append(torch.stack([(cx-l)*stride,(cy-top)*stride,(cx+r)*stride,(cy+b)*stride],-1).reshape(-1,4));scores.append(cls.reshape(-1))
 boxes,scores=torch.cat(boxes),torch.cat(scores);keep=scores>.05;boxes,scores=boxes[keep],scores[keep];keep=nms(boxes,scores,.45);boxes,scores=boxes[keep]/s,scores[keep];boxes[:,0::2].clamp_(0,w);boxes[:,1::2].clamp_(0,h)
 row={'file':f,'size':[w,h],'elapsedSeconds':round(time.monotonic()-t,3),'boxes':[{'box':[round(v,1) for v in b],'score':round(float(sc),4)} for b,sc in zip(boxes.tolist(),scores.tolist())],'imageSha256':hashlib.sha256(source.read_bytes()).hexdigest()};row['caseId']=case['id'];row['source']=str(source);results.append(row);Path(a.out).write_text(json.dumps(results,indent=2)); print(f,row['elapsedSeconds'],'regions',len(row['boxes']),flush=True)
