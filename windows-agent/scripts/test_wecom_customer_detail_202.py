import json
from dataclasses import replace
from pathlib import Path
import unittest

import wecom_invite_preview as w
from test_wecom_invite_preview import Device, PATH, PHONE, OTHER, run, text


def observed():
    data=json.loads((Path(__file__).parent/'fixtures/wecom/already-contact-202.json').read_text(encoding='utf-8'))
    return w.Screen(w.PACKAGE,tuple(w.Node(**{**row,'position':tuple(row['position']),'size':tuple(row['size'])})for row in data['nodes']))


class CustomerDetail202Tests(unittest.TestCase):
    def test_observed_phone_is_verified_as_existing_contact(self):
        screen=observed();self.assertEqual(w.customer_detail_phone(screen),PHONE)
        self.assertTrue(w.profile_matches(screen,PHONE));self.assertFalse(w.profile_matches(screen,OTHER))

    def test_full_home_search_stops_as_already_contact_without_add_message_or_remark(self):
        device=Device([*PATH[:5],observed()]);result=run(device)
        self.assertEqual(result['code'],'already_contact')
        self.assertEqual(device.calls,['open_menu','open_add','open_search','enter_phone','search'])

    def test_wrong_target_is_not_already_contact(self):
        screen=observed();screen=replace(screen,nodes=tuple(replace(n,text=OTHER)if n.text==PHONE else n for n in screen.nodes))
        self.assertEqual(w.customer_detail_phone(screen),OTHER)
        self.assertEqual(run(Device([*PATH[:5],screen]))['code'],'profile_phone_mismatch')

    def test_phone_in_description_or_nickname_cannot_replace_the_actual_row(self):
        screen=observed();nodes=tuple(replace(n,text=OTHER)if n.text==PHONE else n for n in screen.nodes)
        for extra in (text(PHONE,position=(.6,.44),size=(.5,.04)),text(PHONE,position=(.6,.24),size=(.5,.04))):
            changed=replace(screen,nodes=nodes+(extra,))
            self.assertEqual(w.customer_detail_phone(changed),OTHER)
            self.assertFalse(w.profile_matches(changed,PHONE))

    def test_each_native_layout_control_is_required_visible_enabled_and_exact(self):
        screen=observed()
        for i,n in enumerate(screen.nodes):
            if n.text in ('电话',PHONE):continue
            for mutation in ('missing','hidden','disabled','renamed'):
                with self.subTest(label=n.text,mutation=mutation):
                    if mutation=='missing':nodes=screen.nodes[:i]+screen.nodes[i+1:]
                    else:
                        values={'visible':False}if mutation=='hidden'else{'enabled':False}if mutation=='disabled'else{'name':'unknown:id/control'}
                        nodes=screen.nodes[:i]+(replace(n,**values),)+screen.nodes[i+1:]
                    self.assertIsNone(w.customer_detail_phone(replace(screen,nodes=nodes)))

    def test_ambiguous_phone_rows_and_invalid_geometry_are_not_proof(self):
        screen=observed();phone=next(n for n in screen.nodes if n.text==PHONE)
        self.assertIsNone(w.customer_detail_phone(replace(screen,nodes=screen.nodes+(replace(phone,text=OTHER),))))
        for values in ({'position':(.6,.8)},{'size':(0,.1)},{'position':(float('nan'),.3)},{'enabled':False},{'visible':False}):
            changed=replace(screen,nodes=tuple(replace(n,**values)if n is phone else n for n in screen.nodes))
            self.assertIsNone(w.customer_detail_phone(changed))

    def test_add_or_send_surface_and_other_app_do_not_become_existing_contact(self):
        screen=observed()
        for label in ('添加为联系人',w.SEND):
            self.assertIsNone(w.customer_detail_phone(replace(screen,nodes=screen.nodes+(text(label),))))
        self.assertIsNone(w.customer_detail_phone(replace(screen,package='other.app')))

    def test_known_old_detail_can_only_return_back_after_fresh_full_page_check(self):
        screen=observed();calls=[]
        self.assertTrue(w.return_from_customer_detail(screen,snapshot=lambda:screen,foreground=lambda:w.PACKAGE,back=lambda:calls.append('back'),check_budget=lambda:None))
        self.assertEqual(calls,['back'])
        with self.assertRaises(w.StopPreview):
            w.return_from_customer_detail(screen,snapshot=lambda:replace(screen,nodes=screen.nodes[:-1]),foreground=lambda:w.PACKAGE,back=lambda:calls.append('unsafe'),check_budget=lambda:None)
        self.assertEqual(calls,['back'])


if __name__=='__main__':unittest.main()
