"""Decode two redacted OCR frames through the real read-only result runner.
Native focus/input and screenshot transport are simulated; no ADB is called.
"""
import sys,json,pathlib,time
from unittest import mock
root=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'windows-agent/scripts'))
import alipay_visual_result as visual
from test_lookup_blank_card_guard import BlankCardGuardTests
phone=sys.argv[1];index=int(phone[-3:])%21
samples=json.loads((root/'windows-agent/scripts/fixtures/lookup-20261021-redacted-replay.json').read_text())
sample=samples[index];raw=[]
for original in sample['raw']:
 row=list(original);row[1]=row[1].replace('10123456789',phone)
 if len(row)==6:row[4]=list(row[1])
 raw.append(row)
rows=visual._result_rows(raw);r,poco=BlankCardGuardTests().fixture();r.payload['preparedEmptyResult']=True
r.poco_nodes.return_value[0].attr.side_effect=lambda k:phone if k=='text' else ''
with mock.patch.object(visual,'recognize',return_value=(rows,sample['size'])):
 result=r.poco_visual_result_readonly(poco,phone,time.perf_counter()+15)
assert r.adb.call_count==2
assert result.get('notFound')==(sample['expected']=='empty')
print(json.dumps(result,ensure_ascii=False))
