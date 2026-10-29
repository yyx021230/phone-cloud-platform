"""Local-only full traversal and send-boundary fault scenarios; no real phones."""
import copy
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
import wecom_invite_preview as w
import wecom_remark_preview as r
import wecom_customer_invitation as invite
import wecom_platform_preview as host
from test_wecom_invite_preview import PHONE, OTHER, PROFILE, PREVIEW, Poco
from test_wecom_remark_preview import scenario, remark
import test_wecom_platform_preview as host_tests


class Driver(invite.InvitationDriverMixin, r.PocoRemarkDriver): pass


class InvitationTests(unittest.TestCase):
    def full_driver(self, existing='已有备注', description='已有描述'):
        name='yyx（坦克）'
        pages, actions=scenario('', description, requested_name=name)
        pages[6]=remark(existing, description)
        class Advancing(Poco):
            def __call__(self, **selector):
                items=super().__call__(**selector)
                for item in items:
                    click, write=item.click, item.set_text
                    def advance(original=click):
                        original()
                        if len(self.effects)<len(pages): self.screen=pages[len(self.effects)]
                    def set_text(value, original=write):
                        original(value);self.screen=pages[len(self.effects)]
                    item.click, item.set_text=advance, set_text
                return items
        poco=Advancing(pages[0])
        return Driver(poco,lambda:w.PACKAGE,lambda:True),poco,pages,actions

    def test_home_search_full_phone_exact_remark_persist_then_one_send(self):
        driver,poco,pages,actions=self.full_driver()
        prepared=r.run_customer_preview(driver,{'phoneNumber':PHONE,'remarkName':'yyx（坦克）'},replace_name=True,sleep=lambda _:None)
        self.assertEqual(prepared['status'],'ready_before_send');self.assertTrue(prepared['remarkPrepared'])
        self.assertEqual(prepared['remarkSaveStatus'],'confirmed')
        self.assertEqual([e for e in poco.effects if e[0]=='input'],[('input',PHONE),('input','yyx（坦克）')])
        self.assertEqual(sum(value=='保存' for _,value in poco.effects),1)
        claims=[]
        out=invite.send_once(driver,prepared,lambda:claims.append('claim') or True,lambda:None)
        self.assertEqual(out['status'],'send_attempted');self.assertIsNone(out['invitationSent'])
        self.assertEqual(out['sendStatus'],'unknown');self.assertEqual(len(claims),1)
        self.assertEqual(sum(value==w.SEND for _,value in poco.effects),1)
        self.assertNotIn(PHONE,json.dumps(out));self.assertNotIn('yyx',json.dumps(out))

    def test_failed_remarks_or_wrong_phone_never_claim_or_send(self):
        for reason in ('wrong_phone','unpersisted','unknown_save'):
            driver,poco,pages,actions=self.full_driver()
            if reason=='wrong_phone': pages[5]=replace(PROFILE,nodes=tuple(replace(n,text=OTHER) if n.text==PHONE else n for n in PROFILE.nodes))
            if reason=='unpersisted': pages[9]=remark('旧备注','已有描述')
            if reason=='unknown_save':
                original=driver.apply
                def apply(action,*args,**kw):
                    if action=='save_remark': raise TimeoutError('private')
                    return original(action,*args,**kw)
                driver.apply=apply
            prepared=r.run_customer_preview(driver,{'phoneNumber':PHONE,'remarkName':'yyx（坦克）'},replace_name=True,sleep=lambda _:None)
            self.assertNotEqual(prepared['status'],'ready_before_send',reason)
            out=invite.send_once(driver,prepared,lambda:self.fail('must not claim'),lambda:None)
            self.assertFalse(any(value==w.SEND for _,value in poco.effects));self.assertFalse(out['invitationSent'])

    def test_claim_timeout_or_rejection_does_not_click_and_has_no_retry(self):
        for cause in ('false','timeout'):
            poco=Poco(PREVIEW);driver=Driver(poco,lambda:w.PACKAGE,lambda:True);claims=[]
            def claim():
                claims.append('claim')
                if cause=='timeout':raise TimeoutError('private')
                return False
            out=invite.send_once(driver,dict(status='ready_before_send',remarkPrepared=True,remarkSaveStatus='confirmed'),claim,lambda:None)
            self.assertEqual(out['sendStatus'],'unknown');self.assertEqual(len(claims),1);self.assertFalse(poco.effects)

    def test_claim_loses_lease_or_page_changes_before_click(self):
        for reason in ('lease','page','cancel'):
            poco=Poco(PREVIEW);driver=Driver(poco,lambda:w.PACKAGE,lambda:True)
            def claim():
                if reason=='lease':driver.lease_valid=lambda:False
                if reason=='page':poco.screen=PROFILE
                return True
            checks=[0]
            def budget():
                checks[0]+=1
                if reason=='cancel' and checks[0]>=2:raise w.StopPreview('cancelled')
            out=invite.send_once(driver,dict(status='ready_before_send',remarkPrepared=True,remarkSaveStatus='confirmed'),claim,budget)
            self.assertEqual(out['status'],'blocked');self.assertEqual(out['sendStatus'],'unknown');self.assertFalse(poco.effects)

    def test_send_timeout_is_one_click_and_never_reports_delivered(self):
        class Broken(Poco):
            def __call__(self,**selector):
                items=super().__call__(**selector)
                for item in items:
                    def click():self.effects.append(('click',w.SEND));raise TimeoutError('private')
                    item.click=click
                return items
        poco=Broken(PREVIEW);driver=Driver(poco,lambda:w.PACKAGE,lambda:True)
        out=invite.send_once(driver,dict(status='ready_before_send',remarkPrepared=True,remarkSaveStatus='confirmed'),lambda:True,lambda:None)
        self.assertEqual(poco.effects,[('click',w.SEND)]);self.assertEqual(out['sendStatus'],'unknown');self.assertIsNone(out['invitationSent'])

    def test_recipient_fence_survives_new_task_id_restart_and_separates_accounts(self):
        config=dict(serial='fixture',androidUser=0,phoneNumber=PHONE,taskId='original')
        with tempfile.TemporaryDirectory() as directory:
            invite.claim_local(directory,config)
            with self.assertRaisesRegex(w.StopPreview,'local_claim_exists'):invite.claim_local(directory,dict(config,taskId='new-id'))
            invite.claim_local(directory,dict(config,androidUser=999,taskId='clone'))
            self.assertEqual(len(list(Path(directory).glob('*.json'))),2)
            for item in Path(directory).iterdir():self.assertNotIn(PHONE,item.read_text());self.assertNotIn(PHONE,item.name)

    def test_fsync_failure_never_returns_claim_and_keeps_fence(self):
        config=dict(serial='fixture',androidUser=0,phoneNumber=PHONE,taskId='original')
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(invite.os,'fsync',side_effect=OSError('fixture')):
                with self.assertRaises(OSError):invite.claim_local(directory,config)
            with self.assertRaises(w.StopPreview):invite.claim_local(directory,config)

    def test_mode_and_slot_guard_and_operation_fingerprint(self):
        value=host_tests.HostGuardTests().config('155')
        for slot,user in (('main',0),('clone',999)):
            sending=host.validate_config(dict(value,mode='send',previewOnly=False,appSlot=slot,androidUser=user,claimDirectory='fixture-state'))
            self.assertEqual(sending['mode'],'send');self.assertEqual(sending['androidUser'],user)
            self.assertNotEqual(host.operation_fingerprint(sending),host.operation_fingerprint(dict(sending,mode='preview')))
        for change in (dict(mode='send'),dict(mode='send',previewOnly=False),dict(mode='bad')):
            with self.assertRaises(host.SafeStop):host.validate_config(dict(value,**change))

class FingerprintTests(unittest.TestCase):
    def test_operation_fingerprint_matches_node_with_full_target_and_unicode_remark(self):
        import subprocess
        value=host.validate_config(dict(host_tests.HostGuardTests().config('155'),mode='send',previewOnly=False,claimDirectory='fixture',remarkName='yyx（坦克）',description='渠道A\n联调'))
        job=dict(wecomMode='send',wecomRemarkName=value['remarkName'],wecomDescription=value['description'],phoneNumber=value['phoneNumber'],deviceId=value['deviceId'],wecomAndroidUser=value['androidUser'])
        code="import fs from 'node:fs';import {previewOperationFingerprint} from './server/wecom-preview.mjs';process.stdout.write(previewOperationFingerprint(JSON.parse(fs.readFileSync(0,'utf8'))));"
        result=subprocess.run(['node','--input-type=module','-e',code],input=json.dumps(job,ensure_ascii=False),text=True,capture_output=True,check=True,cwd=Path(__file__).resolve().parents[2])
        self.assertEqual(result.stdout,host.operation_fingerprint(value))
        self.assertNotEqual(host.operation_fingerprint(value),host.operation_fingerprint(dict(value,phoneNumber=OTHER)))


if __name__=='__main__':unittest.main()
