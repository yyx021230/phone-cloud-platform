"""Owned existing-service access; mocks only, no Android or network access."""
import ast
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

S=Path(__file__).parent
spec=importlib.util.spec_from_file_location('native_elements',S/'xhs_native_elements.py')
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)


class ExistingServiceTests(unittest.TestCase):
    def setUp(self):
        self.current='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'
        self.original=self.current
        self.pid=''
        self.port=None
        self.mapping_serial='serial'
        self.remote='tcp:10081'
        self.calls=[]
        self.process=Mock()
        self.process.poll.return_value=None
        self.spawn=Mock(return_value=self.process)
        self.rpc=Mock(return_value={'name':'root','payload':{},'children':[]})
        self.session=native.ExistingNativeElementSession('sdk-adb','serial',self.adb_run,lambda:self.current,lambda:None,
                                                        spawn=self.spawn,rpc_dump=self.rpc,choose_port=lambda:23456,sleep=lambda s:None)

    def adb_run(self,adb,serial,*args,**kw):
        self.assertEqual((adb,serial),('sdk-adb','serial'))
        self.calls.append(args)
        text=''
        code=0
        if args[:4]==('shell','pm','list','packages'):text='package:'+native.PACKAGE
        elif args==('shell','pm','list','instrumentation'):text='instrumentation:'+native.RUNNER+' (target='+native.PACKAGE+')'
        elif args[:2]==('shell','pidof'):
            text=self.pid
            if not text:code=1
        elif args==('forward','--no-rebind','tcp:23456','tcp:10081'):self.port=23456
        elif args[:3]==('shell','am','start'):
            self.pid='77'
            self.current='mCurrentFocus=Window{x u0 '+native.PACKAGE+'/.TestActivity}'
        elif args==('get-state',):text='device'
        elif args==('shell','input','keyevent','4'):self.current=self.original
        elif args[:3]==('shell','am','force-stop'):self.pid=''
        elif args==('forward','--list'):
            if self.port:text=self.mapping_serial+' tcp:23456 '+self.remote
        elif args==('forward','--remove','tcp:23456'):self.port=None
        else:raise AssertionError('unreviewed native operation '+str(args))
        return SimpleNamespace(returncode=code,stdout=text.encode(),stderr=b'')

    def test_existing_service_start_dump_and_owned_cleanup(self):
        value=self.session.start()
        self.assertEqual(value,{'name':'root','payload':{},'children':[]})
        self.assertEqual(self.current,self.original)
        self.rpc.assert_called_once_with('http://127.0.0.1:23456')
        self.session.close()
        self.assertEqual(self.pid,'');self.assertIsNone(self.port)
        self.assertEqual(self.spawn.call_count,1)
        args=self.spawn.call_args.args[0]
        self.assertEqual(args[:4],['sdk-adb','-s','serial','shell'])
        self.assertEqual(args[-1],native.RUNNER)
        self.assertFalse(any(any(x in ('install','uninstall','clear','screencap','kill-server','start-server','monkey') for x in call) for call in self.calls))

    def test_preexisting_service_is_preserved_before_any_forward_or_input(self):
        self.pid='42'
        with self.assertRaisesRegex(native.NativeElementError,'already active'):self.session.start()
        self.session.close()
        self.assertEqual(self.pid,'42');self.assertIsNone(self.port);self.spawn.assert_not_called()

    def test_missing_existing_package_never_installs_it(self):
        self.session.run=lambda *a,**kw:SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
        with self.assertRaisesRegex(native.NativeElementError,'not installed'):self.session.start()
        self.spawn.assert_not_called()

    def test_changed_phone_process_is_not_stopped_as_ours(self):
        self.session.start();self.pid='88'
        with self.assertRaisesRegex(native.NativeElementError,'process changed'):self.session.dump()
        with self.assertRaisesRegex(native.NativeElementError,'foreign process preserved'):self.session.close()
        self.assertEqual(self.pid,'88')
        self.assertFalse(any(call[:3]==('shell','am','force-stop') for call in self.calls))

    def test_changed_forward_mapping_is_preserved(self):
        self.session.start();self.remote='tcp:9999'
        with self.assertRaisesRegex(native.NativeElementError,'foreign mapping preserved'):self.session.close()
        self.assertEqual(self.port,23456)
        self.assertNotIn(('forward','--remove','tcp:23456'),self.calls)

    def test_unknown_forward_creation_is_not_retried_or_reported_clean(self):
        original=self.session.run
        def failed(adb,serial,*args,**kw):
            value=original(adb,serial,*args,**kw)
            if args[:2]==('forward','--no-rebind'):
                raise native.subprocess.TimeoutExpired('adb',8)
            return value
        self.session.run=failed
        with self.assertRaises(native.subprocess.TimeoutExpired):self.session.start()
        with self.assertRaisesRegex(native.NativeElementError,'creation outcome unproven'):self.session.close()
        self.assertEqual(sum(c[:2]==('forward','--no-rebind') for c in self.calls),1)
        self.assertNotIn(('forward','--remove','tcp:23456'),self.calls)
        self.spawn.assert_not_called()

    def test_foreground_change_stops_without_another_hierarchy_rpc(self):
        self.session.start();self.current='mCurrentFocus=Window{x u0 other.app/.Activity}'
        with self.assertRaisesRegex(native.NativeElementError,'foreground changed'):self.session.dump()
        self.assertEqual(self.rpc.call_count,1)
        self.session.close()

    def test_an_instrumentation_exit_never_restarts_it(self):
        self.process.poll.return_value=1
        with self.assertRaisesRegex(native.NativeElementError,'stopped during startup'):self.session.start()
        self.assertEqual(self.spawn.call_count,1)
        self.session.close()

    def test_missing_xhs_foreground_stops_before_any_command(self):
        self.current='mCurrentFocus=Window{x u0 other.app/.Activity}'
        with self.assertRaisesRegex(native.NativeElementError,'foreground'):self.session.start()
        self.assertEqual(self.calls,[])

    def test_clone_activity_must_return_to_the_same_user(self):
        self.original='mCurrentFocus=Window{x u999 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'
        self.current=self.original
        self.session.start()
        self.assertEqual(native.ExistingNativeElementSession.activity(self.current)[0],'999')
        self.session.close()

    def test_runtime_has_only_bounded_hierarchy_rpc_and_no_framework_constructor(self):
        text=(S/'xhs_native_elements.py').read_text();tree=ast.parse(text)
        modules=[n.module for n in ast.walk(tree) if isinstance(n,ast.ImportFrom)]
        self.assertFalse(any(m and (m.startswith('airtest') or m.startswith('poco')) for m in modules))
        self.assertNotIn('AndroidUiautomationPoco(',text)
        self.assertIn('timeout=3',text)
        self.assertNotIn('getScreen(',text)


class HierarchyRpcTests(unittest.TestCase):
    def request(self):
        return {'id':'one','uri':'poco-uiautomation-framework','method':['dumper','dumpHierarchy']}

    def response(self,body):
        value=Mock();value.__enter__=Mock(return_value=value);value.__exit__=Mock(return_value=False)
        value.read.return_value=body
        return value

    def test_only_hierarchy_post_has_a_fixed_network_and_response_budget(self):
        request=self.request();response=self.response(b'{"id":"one","result":{"payload":{}}}')
        with patch.object(native.urllib.request,'urlopen',return_value=response) as post:
            result=native.post_hierarchy_rpc('http://127.0.0.1:23456',request,'session')
        self.assertEqual(result['result'],{'payload':{}})
        self.assertEqual(post.call_args.kwargs['timeout'],3)
        self.assertEqual(response.read.call_args.args,(4*1024*1024+1,))
        payload=json.loads(post.call_args.args[0].data)
        self.assertEqual(payload['session_id'],'session');self.assertNotIn('session_id',request)

    def test_screen_input_and_unknown_endpoints_never_send_an_rpc(self):
        for key,value in [('method',['screen','getScreen','dumpHierarchy']),('method',['input','dumpHierarchy']),('uri','other')]:
            request=self.request();request[key]=value
            with patch.object(native.urllib.request,'urlopen') as post,self.assertRaises(native.NativeElementError):
                native.post_hierarchy_rpc('http://127.0.0.1:23456',request,'session')
            post.assert_not_called()

    def test_foreign_response_identity_is_rejected(self):
        with patch.object(native.urllib.request,'urlopen',return_value=self.response(b'{"id":"other"}')):
            with self.assertRaisesRegex(native.NativeElementError,'identity'):native.post_hierarchy_rpc('http://127.0.0.1:23456',self.request(),'s')

    def test_oversized_response_is_rejected_before_decoding(self):
        with patch.object(native.urllib.request,'urlopen',return_value=self.response(b'x'*(4*1024*1024+1))):
            with self.assertRaisesRegex(native.NativeElementError,'budget'):native.post_hierarchy_rpc('http://127.0.0.1:23456',self.request(),'s')

    def test_network_failure_does_not_retry_or_restart_the_service(self):
        with patch.object(native.urllib.request,'urlopen',side_effect=TimeoutError('timeout')) as post:
            with self.assertRaises(TimeoutError):native.post_hierarchy_rpc('http://127.0.0.1:23456',self.request(),'s')
        self.assertEqual(post.call_count,1)

    def test_external_endpoint_is_not_contacted(self):
        with patch.object(native.urllib.request,'urlopen') as post:
            with self.assertRaisesRegex(native.NativeElementError,'local endpoint'):
                native.post_hierarchy_rpc('https://example.com',self.request(),'s')
        post.assert_not_called()


if __name__=='__main__':unittest.main()
