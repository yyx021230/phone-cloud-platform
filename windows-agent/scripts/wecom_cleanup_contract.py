"""Fixed WeCom cleanup v1 binding; no phone data in verification envelopes."""
import re
from wecom_physical_verify import VerifyStop

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
