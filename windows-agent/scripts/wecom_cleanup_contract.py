"""Fixed WeCom cleanup v1 binding; no phone data in verification envelopes."""
import re
import math
import time
from wecom_physical_verify import VerifyStop

CAUSAL_PROTOCOL='wecom-causal-v1'


class CausalLeaseBudget:
    """Same original server ticket; full RTT is consumed, never added back."""
    def __init__(self,ticket,*,clock=time.monotonic):
        if not isinstance(ticket,dict)or set(ticket)!={'protocol','epoch','leaseId','purpose'}or ticket['protocol']!=CAUSAL_PROTOCOL or ticket['purpose']not in('business','verification')or any(not isinstance(ticket[k],str)or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',ticket[k])for k in('epoch','leaseId')):
            raise VerifyStop('wecom_cleanup_causal_context_unconfirmed')
        self.ticket=dict(ticket);self.clock=clock;self.deadline=None;self.last=None;self.revoked=False

    def sample(self):
        n=self.clock()
        if self.revoked or type(n)not in(int,float)or not math.isfinite(n)or n<0 or(self.last is not None and n<self.last):
            self.revoked=True;raise VerifyStop('wecom_cleanup_causal_context_unconfirmed')
        self.last=n;return n

    def consume(self,reply,started):
        try:
            finished=self.sample();remaining=reply.get('remainingMs')
            if reply.get('valid')is not True or reply.get('causalLease')!=self.ticket or type(started)not in(int,float)or not math.isfinite(started)or started<0 or started>finished or type(remaining)is not int or not 0<=remaining<=(300000 if self.ticket['purpose']=='business'else 120000):
                raise VerifyStop('wecom_cleanup_causal_context_unconfirmed')
            bound=started+remaining/1000.0
            self.deadline=bound if self.deadline is None else min(self.deadline,bound)
            if self.deadline-finished<=3:raise VerifyStop('wecom_cleanup_lease_lost')
            return True
        except Exception:
            self.revoked=True;raise

BINDING_FIELDS=('version','obligationId','originalTaskId','executionId','deviceId','serial','agentId','appSlot','androidUser','nonce')

def validate_binding(value,context,*,original=False):
    if not isinstance(value,dict)or set(value)!=set(BINDING_FIELDS)or type(value['version'])is not int or value['version']!=1:
        raise VerifyStop('wecom_cleanup_binding_mismatch')
    if any(not isinstance(value[k],str)or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',value[k])for k in ('obligationId','originalTaskId','executionId','agentId','nonce')):
        raise VerifyStop('wecom_cleanup_binding_mismatch')
    if not isinstance(value['serial'],str)or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',value['serial'])or not isinstance(value['deviceId'],str)or not value['deviceId'].startswith('adb:')or value['deviceId'][4:].lower()!=value['serial'].lower()or value['appSlot']not in ('main','clone')or type(value['androidUser'])is not int or value['androidUser']not in (0,999):
        raise VerifyStop('wecom_cleanup_binding_mismatch')
    for key in ('deviceId','serial','agentId'):
        if context.get(key)!=value[key]:raise VerifyStop('wecom_cleanup_binding_mismatch')
    if original and(value['originalTaskId']!=context.get('taskId')or value['appSlot']!=context.get('appSlot')or value['androidUser']!=context.get('androidUser')):
        raise VerifyStop('wecom_cleanup_binding_mismatch')
    return dict(value)
