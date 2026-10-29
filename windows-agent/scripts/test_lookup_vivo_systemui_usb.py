import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup


def usb():
    root=ET.Element('hierarchy')
    for text,rid in [('USB 用于','usb_select_title_tv')]+[(t,'title') for t in ['仅充电','传输文件\u00a0/ Android Auto','传输照片','USB 网络共享','MIDI']]:
        ET.SubElement(root,'node',{'text':text,'package':'com.android.systemui','resource-id':'com.android.systemui:id/'+rid})
    return root


class SystemUiUsbTests(unittest.TestCase):
    def fixture(self):
        r=lookup.Runner({'serial':'SYNTHETIC'});state={'closed':False};r.emit=mock.Mock()
        r.focus_state=lambda:([], 'mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/.AlipayLogin}' if state['closed'] else 'mCurrentFocus=Window{x u0 com.android.systemui}', 'mFocusedApp=com.eg.android.AlipayGphone/.AlipayLogin')
        r.dump=mock.Mock(side_effect=lambda *a,**kw:(usb(),{}))
        def adb(args,**kw):
            if args==['shell','getprop','sys.usb.config']:return 'mtp,adb'
            self.assertEqual(args,['shell','input','keyevent','4']);state['closed']=True;return ''
        r.adb=mock.Mock(side_effect=adb)
        return r,state

    def test_exact_current_vivo_layout_closes_once_and_preserves_usb_mode(self):
        r,s=self.fixture()
        with mock.patch.object(lookup.time,'sleep'):
            self.assertTrue(r.dismiss_known_overlay())
        self.assertTrue(s['closed']);self.assertEqual(r.dump.call_count,2)
        self.assertEqual(sum(c.args[0]==['shell','input','keyevent','4'] for c in r.adb.call_args_list),1)
        self.assertEqual(sum(c.args[0]==['shell','getprop','sys.usb.config'] for c in r.adb.call_args_list),2)

    def test_arbitrary_systemui_or_changed_dialog_never_receives_back(self):
        for change in ['unknown','late']:
            r,_=self.fixture();unknown=ET.Element('hierarchy')
            r.dump.side_effect=[(unknown,{})] if change=='unknown' else [(usb(),{}),(unknown,{})]
            if change=='unknown':self.assertFalse(r.dismiss_vivo_usb_mode_dialog())
            else:
                with self.assertRaisesRegex(RuntimeError,'foreground_changed'):r.dismiss_vivo_usb_mode_dialog()
            self.assertFalse(any('input' in c.args[0] for c in r.adb.call_args_list))

    def test_covered_other_app_and_duplicate_labels_are_not_authorization(self):
        r,_=self.fixture();r.focus_state=lambda:([],'mCurrentFocus=Window{x u0 com.android.systemui}','other.app/.Home')
        self.assertFalse(r.dismiss_vivo_usb_mode_dialog());r.dump.assert_not_called();r.adb.assert_not_called()
        tree=usb();tree.append(ET.fromstring(ET.tostring(tree[-1])))
        self.assertFalse(lookup.Runner.vivo_usb_systemui_evidence(tree))

    def test_reappearing_verified_usb_does_not_loop(self):
        r,s=self.fixture()
        with mock.patch.object(lookup.time,'sleep'):r.dismiss_vivo_usb_mode_dialog()
        s['closed']=False
        with self.assertRaisesRegex(RuntimeError,'reappeared'):r.dismiss_vivo_usb_mode_dialog()
        self.assertEqual(sum(c.args[0]==['shell','input','keyevent','4'] for c in r.adb.call_args_list),1)

if __name__=='__main__':unittest.main()
