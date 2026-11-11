import copy
import hashlib
import json
import unittest
from wecom_single_candidate import qa_profiles
from wecom_single_state import assert_idle


class FleetProfileTests(unittest.TestCase):
    def setUp(self):
        self.original=json.dumps({'155':dict(serial='Known',androidUser=999,defaultAppSlot='clone',appSlots={'main':0,'clone':999})}).encode()
        self.manifest=dict(version=1,mode='preview_only',originalProfileSha256=hashlib.sha256(self.original).hexdigest(),devices={'155':'Known','69':'New'})

    def build(self,m=None):return qa_profiles(self.original,json.dumps(m or self.manifest).encode())

    def test_derived_profiles_preserve_known_clone_and_do_not_edit_original(self):
        actual,proof=self.build();actual=json.loads(actual);proof=json.loads(proof)
        self.assertEqual(actual['155'],json.loads(self.original)['155'])
        self.assertEqual(actual['69']['appSlots'],{'main':0})
        self.assertEqual(proof['qaOnlyNumbers'],['69'])
        self.assertFalse(proof['productionProfileChanged'])
        self.assertEqual(proof['derivedProfileSha256'],hashlib.sha256(self.build()[0]).hexdigest())
        self.assertNotIn('69',json.loads(self.original))

    def test_wrong_source_or_non_preview_manifest_is_rejected(self):
        for patch in ({'mode':'send'},{'originalProfileSha256':'0'*64},{'devices':{}},{'devices':{'69':'New\nInjected'}},{'devices':{'0':'New'}}):
            m=copy.deepcopy(self.manifest);m.update(patch)
            with self.assertRaisesRegex(RuntimeError,'qa_manifest_invalid'):self.build(m)

    def test_existing_binding_and_physical_alias_conflicts_are_not_overwritten(self):
        for devices,code in (({'155':'Replaced'},'existing_conflict'),({'69':'known'},'alias'),({'69':'New','71':'new'},'alias')):
            m=copy.deepcopy(self.manifest);m['devices']=devices
            with self.assertRaisesRegex(RuntimeError,code):self.build(m)


class UnconfiguredAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.target=dict(deviceId='adb:New',serial='New',deviceNumber='69')
        self.state=dict(devices=[dict(deviceId='adb:New',deviceName='69',listingStatus='listed',adb={'serial':'New'})],
                        lookupExcluded=True,locks=[],tasks=[],jobs=[],sessions=[],
                        runtime=dict(online=True,adbOnline=True,agentOnline=True,listed=True,busy=False,available=False,occupancy=None,unavailableReason='wecom_not_configured'))

    def test_only_explicit_qa_profile_can_admit_unconfigured_idle_phone(self):
        with self.assertRaisesRegex(RuntimeError,'qa_target_not_idle'):assert_idle(self.target,self.state)
        self.assertEqual(assert_idle(self.target,self.state,allow_unconfigured=True)['deviceName'],'69')

    def test_unknown_flags_busy_or_other_runtime_reason_never_bypasses_occupancy(self):
        for patch in ({'busy':True},{'busy':None},{'online':False},{'adbOnline':None},{'agentOnline':False},{'listed':False},{'occupancy':{'type':'screen_control'}},{'unavailableReason':'device_busy'},{'unavailableReason':None}):
            s=copy.deepcopy(self.state);s['runtime'].update(patch)
            with self.assertRaisesRegex(RuntimeError,'qa_target_not_idle'):assert_idle(self.target,s,allow_unconfigured=True)

    def test_qa_profile_never_overrides_persistent_work_or_lookup_reservation(self):
        for k in ('locks','tasks','jobs','sessions','lookupExcluded'):
            s=copy.deepcopy(self.state);s[k]=False if k=='lookupExcluded'else[{'original':'untouched'}]
            with self.assertRaisesRegex(RuntimeError,'qa_target_not_exclusive'):assert_idle(self.target,s,allow_unconfigured=True)


if __name__=='__main__':unittest.main()
