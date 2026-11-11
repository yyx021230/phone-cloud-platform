"""Test-only structural observations. Unknown UI strings and phone data removed."""
import json
import base64
import re
import math
from collections import Counter
from pathlib import Path
import wecom_invite_preview as w
from wecom_startup_guards import keyguard_state

LABELS=frozenset(('消息','邮件','工作台','通讯录','我','文档','添加客户','加微信','搜索手机号添加','搜索','取消','手机号','个人信息','电话','描述','设置备注和描述','设置标签','添加为联系人','发消息','发送添加邀请','备注信息','设置备注','备注','保存','完成','客户','查找手机/邮箱','网络查找手机/邮箱','返回','设置','客户详情','验证申请','添加联系人','已发送添加邀请'))


def structural_page(page,phone,observation):
    if observation not in ('home','unknown_home','expected_search','changed_search','expected_menu','changed_menu'):raise ValueError('qa_observation_invalid')
    result=[]
    for node in page.nodes[:512]:
        text=node.text if isinstance(node.text,str)else ''
        description=node.desc if isinstance(node.desc,str)else ''
        normalized=re.sub(r'[\s-]','',text)
        name=node.name if re.fullmatch(r'(?:com\.tencent\.wework|com\.android\.systemui):id/[a-zA-Z0-9_]{1,40}',node.name)and not re.search(r'1[3-9]\d{9}',node.name)else ''
        result.append(dict(kind=node.kind if node.kind in w.NODE_TYPES else 'other',resource=name,
            text=text if text in LABELS else '',description=description if description in LABELS else '',
            authorizedTarget=normalized in (phone,'电话'+phone),enabled=bool(node.enabled),visible=bool(node.visible),
            position=list(node.position)if len(node.position)==2 and all(isinstance(x,(int,float))and math.isfinite(x)and 0<=x<=1 for x in node.position)else None,
            size=list(node.size)if len(node.size)==2 and all(isinstance(x,(int,float))and math.isfinite(x)and 0<=x<=1 for x in node.size)else None))
    return dict(version=1,observation=observation,package='wecom'if page.package==w.PACKAGE else 'other',
        totalNodes=len(page.nodes),truncated=len(page.nodes)>512,nodes=result,
        recognized=dict(home=w.is_home(page),menu=w.is_menu(page),add=w.is_add_page(page),profile=w.profile_matches(page,phone),sendBoundary=page.has(w.SEND)))


def writer(folder,phone):
    folder=Path(folder)
    if '/staging/wecom-qa-'not in str(folder).replace('\\','/'):raise ValueError('qa_observation_path_invalid')
    first=True
    def save(value):
        nonlocal first
        data=json.dumps(value,ensure_ascii=True).encode('ascii')
        while len(data)>131072:
            value['nodes']=value['nodes'][:len(value['nodes'])//2];value['truncated']=True
            data=json.dumps(value,ensure_ascii=True).encode('ascii')
        if first:
            (folder/'ui-first-sanitized.json').write_bytes(data);first=False
        (folder/'ui-last-sanitized.json').write_bytes(data)
    def observe(observation,page):save(structural_page(page,phone,observation))
    def difference(action,before,after):
        nonlocal first
        if action not in ('enter_phone','open_menu'):return
        changes=[]
        keys={(n.kind,n.name)for n in before.nodes+after.nodes if n.name}
        for kind,name in sorted(keys):
            old=[n for n in before.nodes if(n.kind,n.name)==(kind,name)]
            new=[n for n in after.nodes if(n.kind,n.name)==(kind,name)]
            if len(old)!=1 or len(new)!=1:continue
            changed=[key for key in ('text','desc','enabled','visible','position','size')if getattr(old[0],key)!=getattr(new[0],key)]
            if changed:
                resource=name if re.fullmatch(r'(?:com\.tencent\.wework|com\.android\.systemui):id/[a-zA-Z0-9_]{1,40}',name)and not re.search(r'1[3-9]\d{9}',name)else ''
                changes.append(dict(resource=resource,kind=kind if kind in w.NODE_TYPES else 'other',changedFields=changed))
        same_multiset=Counter(before.nodes)==Counter(after.nodes)
        suffix='search'if action=='enter_phone'else 'menu'
        expected=structural_page(before,phone,'expected_'+suffix)
        observed=structural_page(after,phone,'changed_'+suffix)
        observed.update(action=action,sameNodeMultiset=same_multiset,
            orderChanged=same_multiset and before.nodes!=after.nodes,changes=changes[:64])
        # Reuse exactly two bounded slots, replacing initial-home evidence when
        # the actual failure is at input. Never keep an unbounded frame history.
        first=True;save(expected);first=False;save(observed)
    startup_rows={}
    capture_attempted=False
    def startup(kind,raw,user):
        if kind not in ('power_before','power_after','keyguard','foreground','wake_response','dismiss_response','power_fallback_response'):return
        if kind in ('wake_response','dismiss_response','power_fallback_response'):
            value={'response':'empty'if not raw.strip()else 'denied'if re.search(r'Permission|denied',raw,re.I)else 'error'if re.search(r'Error|Exception|not found',raw,re.I)else 'nonempty'}
        elif kind=='foreground':
            lines=[line for line in raw.splitlines()if 'ResumedActivity'in line or re.search(r'\bResumed:',line)]
            matches=[re.search(r'\bu(\d+)\s+(com\.[A-Za-z0-9_.]+)/([A-Za-z0-9_.$]+)',line)for line in lines]
            match=next((m for m in matches if m),None)
            package=match.group(2)if match else ''
            groups={'com.tencent.wework':'wecom','com.android.systemui':'systemui','com.android.intentresolver':'resolver','com.android.settings':'settings','com.netease.open.pocoservice':'poco'}
            component=package+'/'+match.group(3)if match and package=='com.tencent.wework'else ''
            value={'packageGroup':groups.get(package,'other'if package else 'unknown'),
                'userMatches':bool(match and int(match.group(1))==user),
                'component':component[:180],'resumedFieldPresent':bool(lines)}
        elif kind=='keyguard':value={'keyguard':keyguard_state(raw,user)}
        else:
            states=re.findall(r'(?m)^\s*mWakefulness=(Awake|Asleep|Dozing|Dreaming)\s*$',raw)
            value={'wakefulness':states[0]if len(states)==1 else 'unknown',
                'wakefulnessChanging':bool(re.search(r'(?m)^\s*mWakefulnessChanging=true\s*$',raw))}
            def fixed_field(name,pattern):
                found=re.findall(r'(?m)^\s*'+name+'='+pattern+r'\s*$',raw)
                return found[0]if len(found)==1 else 'unknown'
            value.update(displayState=fixed_field('mScreenState',r'(OFF|ON|DOZE|DOZE_SUSPEND|VR)'),
                proximity=fixed_field('mProximity',r'(Positive|Negative|Unknown)'),
                screenOffForProximity=fixed_field('mScreenOffBecauseOfProximity',r'(true|false)'),
                waitingForNegativeProximity=fixed_field('mRequestWaitForNegativeProximity',r'(true|false)'))
        startup_rows[kind]=dict(kind=kind,**value)
        (folder/'startup-sanitized.json').write_text(json.dumps({'version':1,'observations':list(startup_rows.values())},ensure_ascii=True),encoding='ascii')
    def capture_blank_screen(capture):
        nonlocal capture_attempted
        if capture_attempted:return
        capture_attempted=True  # A failed/unknown read is never replayed.
        facts={'version':1,'stage':'capture','imageSaved':False}
        def save_facts():
            path=folder/'capture-sanitized.json'
            path.write_text(json.dumps(facts,ensure_ascii=True),encoding='ascii');path.chmod(0o600)
        try:
            data,format_name=capture()
            facts.update(stage='validate',reportedFormat=format_name if format_name in ('jpg','jpeg','png')else 'other',encodedType='str'if isinstance(data,str)else 'bytes'if isinstance(data,bytes)else 'other')
            if not isinstance(data,(str,bytes)) or len(data)>360000:raise ValueError('invalid')
            raw=data.encode('ascii')if isinstance(data,str)else data
            facts.update(encodedBytes=len(raw),asciiWhitespace=bool(re.search(rb'[\t\r\n ]',raw)))
            decoded=base64.b64decode(re.sub(rb'[\t\r\n ]',b'',raw),validate=True)
            facts['decodedBytes']=len(decoded)
            if len(decoded)>262144:raise ValueError('invalid')
            actual='jpg'if decoded.startswith(b'\xff\xd8')and decoded.endswith(b'\xff\xd9')else 'png'if decoded.startswith(b'\x89PNG\r\n\x1a\n')and decoded.endswith(b'IEND\xaeB`\x82')else None
            facts['actualFormat']=actual or 'unknown'
            if actual is None:raise ValueError('invalid')
            facts['stage']='write'
            path=folder/('unknown-page-private.'+actual);path.write_bytes(decoded);path.chmod(0o600)
            facts.update(stage='complete',imageSaved=True);save_facts();return True
        except w.StopPreview:
            facts['errorCategory']='guard_stop';save_facts();raise
        except Exception as error:
            facts['errorCategory']='invalid_image'if isinstance(error,(ValueError,UnicodeError))else 'io_error'if isinstance(error,OSError)else 'type_error'if isinstance(error,TypeError)else 'capture_unavailable'
            save_facts()
            raise w.StopPreview('qa_private_capture_invalid'if facts['stage']=='validate'else 'qa_private_capture_unavailable')
    observe.capture_blank_screen=capture_blank_screen
    observe.startup=startup
    observe.difference=difference
    return observe
