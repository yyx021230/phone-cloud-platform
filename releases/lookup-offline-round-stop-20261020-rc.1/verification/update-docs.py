# coding: utf-8
"""Local candidate only. Preserve the existing four-endpoint/API-Key bundle."""
from pathlib import Path
import hashlib,json,zipfile
r=Path(__file__).resolve().parents[1]
source=Path('/tmp/pc-lookup-card-status-final-20261020')
baseline=json.loads((r/'BASELINE.json').read_text())
replacements={
 '空闲到期走安全停止：可能短暂expired，随后stopping，收到手机停止确认才stopped；未确认时不释放占用、不启动下一轮。':
 '空闲到期走安全停止：可能短暂expired，随后stopping。在线手机等待停止确认；持续掉线30秒的手机在旧任务撤销并持久化后单独隔离，不再阻塞整轮结束。隔离不代表手机已经停止，恢复连接后仍须确认旧会话清理，才可重新接单。',
 '若手机离线、尚未确认停止，仍返回 stopping；新 prepare 键此时返回409 `lookup_round_stopping`。':
 '在线手机仍在停止或离线隔离尚未持久化时返回 stopping，新 prepare 键返回409 `lookup_round_stopping`。持续掉线30秒的手机完成任务撤销后单独隔离，本轮可以返回 stopped，下一轮使用其他可用手机；隔离手机恢复后先清理旧会话，确认停止后才重新接单。',
 'stopping时每5秒重复相同停止请求；手机离线尚未确认停止时会保持stopping，不冒充已完成。此时新启动返回409 lookup_round_stopping。':
 'stopping时每5秒重复相同停止请求。持续掉线30秒的手机撤销旧任务并持久化后单独隔离，不再阻塞本轮stopped或下一轮启动；隔离手机本身仍不可用，重连后须先完成旧会话停止确认。在线停止未确认或隔离写入失败时仍保持stopping，新启动返回409 lookup_round_stopping。',
 '停止探测与分配、取消排队，运行中的手机等停止确认；已完成结果保留。':
 '停止探测与分配、取消排队；在线手机等待停止确认，持续掉线30秒的手机撤销旧任务并持久化后单独隔离。本轮结束不代表隔离手机已停止，该手机重连清理并确认后才能复用；已完成结果保留。',
 'stopping等待停止确认；stopped本轮已结束':
 'stopping正在停止；stopped本轮已结束，离线手机可能仍隔离等待重连清理'
}
files=['docs/OPEN_NAME_LOOKUP_README.md','docs/OPEN_NAME_LOOKUP_API.md','docs/OPEN_NAME_LOOKUP_PARTNER_HANDOFF.md','public/api-reference.json','public/openapi.json','public/downloads/name-lookup-openapi.json','public/downloads/name-lookup-http-guide.md']
sha=lambda b:hashlib.sha256(b).hexdigest()
for f in files:
 data=(source/f).read_bytes();baseline['before'][f]=sha(data)
 text=data.decode()
 for a,b in replacements.items():text=text.replace(a,b)
 assert text!=data.decode(),f
 if f.endswith('.json'):
  obj=json.loads(text)
  if 'info' in obj:obj['info']['version']=r.name
  else:obj.update(version=r.name,updatedAt='2026-10-20')
  text=json.dumps(obj,ensure_ascii=False,indent=2)+'\n'
 target=r/f;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text)
zip_path='public/downloads/name-lookup-integration.zip'
hash_path='public/downloads/name-lookup-sha256.json'
for f in [zip_path,hash_path]:baseline['before'][f]=sha((source/f).read_bytes())
with zipfile.ZipFile(source/zip_path) as z:bundle={name:z.read(name) for name in z.namelist()}
bundle['README.md']=(r/'public/downloads/name-lookup-http-guide.md').read_bytes()
bundle['openapi.json']=(r/'public/downloads/name-lookup-openapi.json').read_bytes()
with zipfile.ZipFile(r/zip_path,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,data in sorted(bundle.items()):
  info=zipfile.ZipInfo(name,(2026,10,20,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,data)
(r/hash_path).write_text(json.dumps({'version':r.name,'files':{name:sha(data) for name,data in bundle.items()},'zipSha256':sha((r/zip_path).read_bytes())},indent=2)+'\n')
(r/'BASELINE.json').write_text(json.dumps(baseline,ensure_ascii=False,indent=2)+'\n')
print('Updated seven contract files and existing four-endpoint download bundle; no SDK/auth changes.')
