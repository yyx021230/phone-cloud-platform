import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup

class AccountUsbOverlayTests(unittest.TestCase):
    def runner(self, overlay_phase=None, close_error=None):
        r=lookup.Runner.__new__(lookup.Runner)
        state={'phase':'home','overlay':overlay_phase in ('home','both')}
        r.emit=mock.Mock()
        r.focus_state=mock.Mock(side_effect=lambda:([], 'mCurrentFocus=Window{x u0 VivoUsbDialog type=2003}' if state['overlay'] else 'mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/.AlipayLogin}', 'com.eg.android.AlipayGphone'))
        r.account_restriction_evidence=mock.Mock(return_value=None)
        r.dismiss_known_overlay=mock.Mock(return_value=False)
        def dismiss():
            if not state['overlay']:return False
            if close_error:raise RuntimeError(close_error)
            state['overlay']=False
            return True
        r.dismiss_vivo_usb_mode_dialog=mock.Mock(side_effect=dismiss)
        def dump(token):
            root=ET.Element('hierarchy')
            # The underlying tree may remain visible under an OEM window.
            if state['phase']=='home':
                ET.SubElement(root,'node',{'text':'我的','resource-id':lookup.TAB_DESCRIPTION_ID})
            else:
                ET.SubElement(root,'node',{'content-desc':'设置','resource-id':lookup.SETTINGS_ENTRY_ID})
            return root,{}
        r.dump=mock.Mock(side_effect=dump)
        def tap(root,parent,action,**kw):
            if state['overlay']:raise AssertionError('unsafe navigation under USB dialog')
            if action=='open_my_tab':
                state['phase']='settings'
                state['overlay']=overlay_phase in ('settings','both')
        r.tap_unique=mock.Mock(side_effect=tap)
        return r,state

    def test_home_usb_window_cancelled_before_account_navigation(self):
        r,state=self.runner('home')
        r.enter_my_settings('test')
        self.assertFalse(state['overlay'])
        self.assertEqual([c.args[2] for c in r.tap_unique.call_args_list],['open_my_tab','open_settings'])

    def test_late_usb_window_cancelled_before_settings_tap(self):
        r,state=self.runner('settings')
        r.enter_my_settings('test')
        self.assertFalse(state['overlay'])
        self.assertEqual(r.tap_unique.call_count,2)

    def test_uncertain_cancel_never_continues_account_navigation(self):
        r,_=self.runner('home','poco_vivo_usb_mode_dialog:cancel_not_confirmed')
        with self.assertRaisesRegex(RuntimeError,'cancel_not_confirmed'):
            r.enter_my_settings('test')
        r.tap_unique.assert_not_called()

    def test_reappearing_usb_window_stops_without_second_cancel_or_settings_tap(self):
        r,_=self.runner('both')
        with self.assertRaisesRegex(RuntimeError,'reappeared_during_account_navigation'):
            r.enter_my_settings('test')
        self.assertEqual(r.dismiss_vivo_usb_mode_dialog.call_count,1)
        self.assertEqual([c.args[2] for c in r.tap_unique.call_args_list],['open_my_tab'])

    def test_uncovered_home_navigation_is_unchanged(self):
        r,_=self.runner()
        r.enter_my_settings('test')
        self.assertEqual([c.args[2] for c in r.tap_unique.call_args_list],['open_my_tab','open_settings'])

if __name__=='__main__':unittest.main()
