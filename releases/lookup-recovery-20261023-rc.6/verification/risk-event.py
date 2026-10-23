import sys,json
from unittest import mock
sys.path.insert(0,sys.argv[1])
from test_lookup_usb_recovery_flow import FlowTests,tree,lookup
r=FlowTests().risk_runner(tree('我的'))
with mock.patch.object(lookup.time,'sleep',return_value=None):
 try:r.prepare_available_account()
 except RuntimeError as e:
  assert str(e)=='alipay_account_restriction_before_search:device_risk'
 else:raise AssertionError('risk did not block search')
step=r.emit.call_args.args[0];detail=r.emit.call_args.kwargs
assert not r.open_search.called and not r.switch_account.called
print(json.dumps({'stepId':step,'detail':detail,'metadata':r.account_metadata()}))
