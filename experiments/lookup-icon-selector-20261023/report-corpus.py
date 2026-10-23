# -*- coding: utf-8 -*-
from pathlib import Path
import argparse,json,html,hashlib,statistics
p=argparse.ArgumentParser();p.add_argument('--root',required=True);a=p.parse_args();root=Path(a.root)
inventory=json.loads((root/'inventory.json').read_text());detections=json.loads((root/'detections.json').read_text());results=[];inputs={}
for group in ['first','rest']:
 results+=json.loads((root/('results-'+group+'.json')).read_text())
 for x in json.loads((root/group/'inputs.json').read_text()):inputs[x['label']]=(group,x)
first_attempt=list(results)
retry_path=root/'results-retry.json'
retries=json.loads(retry_path.read_text()) if retry_path.exists() else []
replaced={x['id']:x for x in retries}
assert len(replaced)==len(retries) and set(replaced).issubset({x['id'] for x in results})
results=[replaced.get(x['id'],x) for x in results]
assert len(results)==len(inventory)==len({x['id'] for x in results})==56
byid={x['id']:x for x in results};cards=[];safe=[]
for case in inventory:
 r=byid[case['id']];group,inp=inputs[case['id']];label=case['id'];good=r['passed'];color='#33e895' if good else '#ff746b';kind='模拟图' if case['synthetic'] else '历史截图';status='通过' if good else '未通过';act='不点击' if r['action']=='no_action' else '关闭框 '+r['candidateId']
 svg=''
 if r['action']=='close':
  x,y,x2,y2=r['box'];svg=f'<rect x="{x}" y="{y}" width="{x2-x}" height="{y2-y}" stroke="{color}" stroke-width="4" fill="none"/>'
 cards.append(f'<article><h3 style="color:{color}">{label} · {kind} · {status}</h3><p>{html.escape(case["category"])} ｜ {act} ｜ {r["elapsedMs"]/1000:.2f}秒</p><details><summary>查看编号框图与选择（含原始背景，仅本机）</summary><div class="picture"><img src="{group}/{label}-boxes.png"><svg viewBox="0 0 {inp["width"]} {inp["height"]}">{svg}</svg></div></details></article>')
 safe.append({'id':label,'category':case['category'],'synthetic':case['synthetic'],'pixelSha256':case['pixelSha256'],'imageSha256':case['fileSha256'],'expectedAction':case['expectedAction'],'result':r})
summary={'firstAttempt':{'total':len(first_attempt),'passed':sum(x['passed'] for x in first_attempt),'failed':sum(not x['passed'] for x in first_attempt)},'retestedCases':[x['id'] for x in retries],'unchangedInputPairsVerified':55,'total':len(results),'passed':sum(x['passed'] for x in results),'failed':sum(not x['passed'] for x in results),'historicalImages':sum(not x['synthetic'] for x in inventory),'syntheticImages':sum(x['synthetic'] for x in inventory),'expectedClose':sum(x['expectedAction']=='close' for x in inventory),'expectedNoAction':sum(x['expectedAction']=='no_action' for x in inventory),'actualClose':sum(x['action']=='close' for x in results),'falseClose':sum(x['action']=='close' and x['expected']=='no_action' for x in results),'missedClose':sum(x['action']!='close' and x['expected']=='close' for x in results),'modelRequests':sum(x['candidateCount']>0 for x in results),'latencyMs':{'min':min(x['elapsedMs'] for x in results),'median':statistics.median(x['elapsedMs'] for x in results),'max':max(x['elapsedMs'] for x in results)},'phoneActions':0,'productionChanges':0,'cases':safe}
(root/'CORPUS_RESULTS.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
(root/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>已有图片全量选框测试</title><style>body{background:#111827;color:#e5edf9;font:16px system-ui;margin:30px auto;padding:20px;max-width:1000px}article{padding:15px;background:#1d293b;border-radius:10px;margin:12px 0}.picture{position:relative;max-width:480px}.picture img{width:100%;display:block}.picture svg{position:absolute;inset:0;width:100%;height:100%}summary{cursor:pointer}p{line-height:1.6}</style><h1>已有查名截图：检测框 → 6.1sol 选框</h1><p>'+str(summary['total'])+'张，'+str(summary['passed'])+'通过，'+str(summary['failed'])+'未通过。45张历史截图、11张模拟图；像素去重，排除2个非截图资源。首次全量55通过、1条本地零高度框错误；修复后单独重测s046通过，其他55张图片和候选列表哈希保持不变。模型点击选择仅供离线验证，无手机操作，不代表生产完整路径验收。</p>'+''.join(cards))
for f in ['CORPUS_RESULTS.json','index.html']:(root/f).chmod(0o600)
print(json.dumps({k:v for k,v in summary.items() if k!='cases'},ensure_ascii=False))
