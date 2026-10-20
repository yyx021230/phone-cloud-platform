from pathlib import Path
import json,zipfile,hashlib
r=Path(__file__).resolve().parents[1];parent=r.parent/'lookup-offline-round-stop-20261020-rc.1'
note='查询执行中手机持续离线30秒：平台隔离旧手机执行，保留原lookupId和手机号，自动转交其他已探测就绪的在线手机；没有可用手机时继续排队，原任务总时限不延长，调用方继续读取原lookupId，无需重新提交。只有显式调用结束接口，或没有未完成业务且连续空闲15分钟时，才结束本轮并取消未完成工作。离线手机不会无限阻塞stopping，重连后先清理旧执行并重新探测。'
files=['docs/OPEN_NAME_LOOKUP_README.md','docs/OPEN_NAME_LOOKUP_API.md','docs/OPEN_NAME_LOOKUP_PARTNER_HANDOFF.md','public/api-reference.json','public/openapi.json','public/downloads/name-lookup-openapi.json','public/downloads/name-lookup-http-guide.md']
for f in files:
 s=(parent/f).read_text().replace('持续掉线30秒的手机','本轮已请求结束时，持续掉线30秒的手机')
 if f.endswith('.json'):
  obj=json.loads(s)
  if 'paths' in obj:
   obj['info']['version']=r.name
   for route in ['/api/v1/open/name-lookups/tasks','/api/v1/open/name-lookups/stop']:
    post=obj['paths'][route]['post'];post['description']=post.get('description','')+'\n\n'+note
  else:
   obj['version']=r.name
   for e in obj['endpoints']:
    if e.get('path') in ['/api/v1/open/name-lookups/tasks','/api/v1/open/name-lookups/stop']:e['description']=e.get('description','')+'\n'+note
   for g in obj['guides']:
    if 'lookup' in g.get('id','') and isinstance(g.get('paragraphs'),list):g['paragraphs'].append(note)
  s=json.dumps(obj,ensure_ascii=False,indent=2)+'\n'
 else:s+='\n## 手机掉线与结束本轮的区别\n\n'+note+'\n'
 p=r/f;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s)
f='public/downloads/name-lookup-integration.zip'
with zipfile.ZipFile(parent/f) as z:bundle={n:z.read(n) for n in z.namelist()}
bundle['README.md']=(r/'public/downloads/name-lookup-http-guide.md').read_bytes();bundle['openapi.json']=(r/'public/downloads/name-lookup-openapi.json').read_bytes()
with zipfile.ZipFile(r/f,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,data in sorted(bundle.items()):
  info=zipfile.ZipInfo(name,(2026,10,20,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,data)
sha=lambda b:hashlib.sha256(b).hexdigest()
(r/'public/downloads/name-lookup-sha256.json').write_text(json.dumps({'version':r.name,'files':{n:sha(d) for n,d in bundle.items()},'zipSha256':sha((r/f).read_bytes())},indent=2)+'\n')
assert all(note in (r/f).read_text() for f in files)
print('Seven contract files and original HTTP bundle updated; business handoff distinct from stopping.')
