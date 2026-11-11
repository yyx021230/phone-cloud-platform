import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET
from audit_formal_order import audit_formal_order
from verify_public_order import verify_public_order

RELEASE = Path(__file__).resolve().parent
FIXTURES = RELEASE.parents[1] / 'windows-agent/scripts/fixtures'
spec = importlib.util.spec_from_file_location('candidate', (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

class CandidateTests(unittest.TestCase):
    def test_clipped_digest_reproduces_after_api_truncation_without_collisions(self):
        date = '2026-11-09'
        long = '长'*177 + '🚗' + '短尾结尾'
        result = sync.public_list_audit_events([(long,date),('正常标题',date)])
        self.assertEqual(result[0],'collection_public_identity:prefix178_utf16_v1')
        projected = [('长'*177,date),('正常标题',date)]
        expected = hashlib.sha256(json.dumps(projected,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        self.assertEqual(result[1],'collection_public_sha256:'+expected)
        self.assertEqual(sync.public_list_audit_events([(long,date),(long+'另一个',date)]),[])
        collection = {'complete':True, 'notes':[{'title':long.encode('utf-16-le')[:360].decode('utf-16-le'),
                          'published_date':date},{'title':'正常标题','published_date':date}],
                      'recovery_events':['collection_integrity:verified_two_pass',
                          'collection_primary_sha256:'+'a'*64,'collection_verification_sha256:'+'a'*64,
                          'collection_primary_count:2','collection_verification_count:2',*result]}
        self.assertTrue(verify_public_order(collection))
        def baseline(job, target, *, window_end):
            return {'checks': {'orderedDigests': False, 'dates': window_end == date,
                               'reportedIdTwoFreshSamples': False},
                    'listIntegrityVerified': False, 'verifiedComplete': False}

        wrapped = {'result': {'collection': collection}}
        audit = audit_formal_order(baseline, wrapped, {}, window_end=date)
        self.assertTrue(audit['listIntegrityVerified'])
        self.assertFalse(audit['verifiedComplete'])
        self.assertFalse(audit_formal_order(baseline, wrapped, {}, window_end='wrong')['listIntegrityVerified'])
        collection['notes'].reverse()
        self.assertFalse(verify_public_order(collection))

    def test_textview_empty_layout_requires_complete_terminal_structure(self):
        root = ET.parse(FIXTURES/'xhs/works-empty-display-elements.xml').getroot()
        for node in root.iter('node'):
            if node.get('text') in ('全部笔记','仅统计近半年内笔记','暂无可展示的笔记'):
                node.set('class','android.widget.TextView')
        view, = [n for n in root.iter('node') if n.get('class')=='android.webkit.WebView' and n.get('text')=='数据中心']
        self.assertTrue(sync.proven_display_empty_state(view))
        next(n for n in root.iter('node') if n.get('text')=='全部笔记').set('enabled','false')
        self.assertFalse(sync.proven_display_empty_state(view))

    def test_phone_only_login_requires_two_matching_same_slot_native_reads(self):
        def login():
            root=ET.Element('hierarchy')
            def role(parent, text, y, cls='android.widget.TextView', clickable='false', **extra):
                attrs={'text':text,'class':cls,'package':sync.XHS_PACKAGE,'enabled':'true',
                       'bounds':f'[10,{y}][100,{y+10}]','clickable':clickable,**extra}
                return ET.SubElement(parent,'node',attrs)
            role(root,'登录后展示自己',10)
            button=role(root,'',30,'android.view.ViewGroup','true')
            role(button,'手机号登录',30)
            role(root,'其他登录方式',50,clickable='true')
            role(root,'我已阅读并同意《用户协议》《隐私政策》《未成年人个人信息保护规则》',70)
            row=role(root,'',90,'android.widget.LinearLayout')
            role(row,'账号丢失了？',90)
            role(row,'找回账号',90,clickable='true')
            role(root,'',110,'android.view.ViewGroup','true',**{'content-desc':'我','selected':'true'})
            return root
        tree=login()
        focus='mCurrentFocus=Window{x u999 com.xingin.xhs/.index.v2.IndexActivityV2}'
        events=['collection_slot_requested:app2','clone_user_requested:999']
        for second,expected in [(login(),'account is logged out'),(ET.Element('hierarchy'),'state changed')]:
            with self.subTest(expected=expected),patch.object(sync,'focus',return_value=focus), patch.object(sync.time,'sleep'), patch.object(sync,'native_window_capture',side_effect=[login(),second]) as reads, patch.object(sync,'adb') as adb:
                with self.assertRaisesRegex(RuntimeError,expected):
                    sync.confirm_logged_out('adb','fixture',tree,Mock(),list(events))
                self.assertEqual(reads.call_count,2)
                adb.assert_not_called()
        with self.assertRaisesRegex(RuntimeError,'requested slot'):
            sync.login_element_evidence(tree,focus.replace('u999','u0'),events)
        next(n for n in tree.iter('node') if n.get('text')=='找回账号').set('text','')
        self.assertIsNone(sync.login_element_evidence(tree,focus,events))


    def test_clone_location_prompt_only_backs_out_of_the_proven_own_task(self):
        pkg = 'com.android.permissioncontroller'
        current = f'mCurrentFocus=Window{{fixture u999 {pkg}/{pkg}.permission.ui.GrantPermissionsActivity type=1}}'
        dump = '\n'.join([current, f'mFocusedApp=ActivityRecord{{fixture u999 {pkg}/.permission.ui.GrantPermissionsActivity t42 d0}}',
                         'mPreferredTopFocusableRootTask=Task{fixture #42 type=standard A=99912345:com.xingin.xhs} U=999 displayId=0'])
        returned = 'mCurrentFocus=Window{fixture u999 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}'
        args = SimpleNamespace(adb='mock', serial='fixture', app_slot='app2')
        roles = [('permission_message', '“Ⅱ·小红书”请求访问您的位置信息', 'TextView', 'false'),
                 ('permission_allow_foreground_only_button', '使用应用时允许', 'Button', 'true'),
                 ('permission_allow_one_time_button', '本次使用时允许', 'Button', 'true'),
                 ('permission_deny_button', '禁止', 'Button', 'true')]

        def prompt(title=None):
            root = ET.Element('hierarchy')
            for i, (resource, text, cls, clickable) in enumerate(roles):
                ET.SubElement(root, 'node', {'package': pkg, 'resource-id': f'{pkg}:id/{resource}',
                    'text': title if i == 0 and title else text, 'class': 'android.widget.'+cls,
                    'clickable': clickable, 'enabled': 'true', 'visible-to-user': 'true',
                    'bounds': f'[10,{40*i}][200,{40*i+30}]'})
            return root

        scenarios = [
            (dump, dump, prompt(), returned, False, True, None),
            (dump.replace('t42 d0', 't43 d0'), dump, prompt(), returned, False, False, None),
            (dump, dump, prompt('其他应用'), returned, False, False, None),
            (dump, dump.replace('#42', '#43'), prompt(), returned, False, False, 'changed before Back'),
            (dump, dump, prompt(), current, False, True, 'stayed foreground after Back'),
            (dump, dump, prompt(), returned, True, False, None),
        ]
        for first, second, tree, after, attempted, sent, error in scenarios:
            with self.subTest(sent=sent, error=error, attempted=attempted):
                states = iter((first, second))
                actions = []

                def adb(_path, _serial, *cmd, **kwargs):
                    if cmd == ('shell', 'dumpsys', 'window'):
                        return next(states)
                    actions.append(cmd)

                events = ['collection_slot_requested:app2', 'clone_user_requested:999']
                if attempted:
                    events.append('clone_profile_location_back_once')
                with patch.object(sync, 'adb', side_effect=adb), patch.object(sync, 'capture', return_value=tree), \
                     patch.object(sync, 'focus', return_value=after), patch.object(sync, 'native_window_capture', return_value=tree), \
                     patch.object(sync.time, 'sleep'):
                    if error:
                        with self.assertRaisesRegex(sync.ElementListReadError, error):
                            sync.recover_clone_location_prompt(args, current, lambda: None, events)
                    else:
                        result = sync.recover_clone_location_prompt(args, current, lambda: None, events)
                        self.assertIs(result, tree if sent else None)
                self.assertEqual(actions, [('shell','input','keyevent','4')] if sent else [])


if __name__=='__main__':
    unittest.main()
