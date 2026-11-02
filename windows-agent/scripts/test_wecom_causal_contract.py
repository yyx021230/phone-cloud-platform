import json
import unittest
from pathlib import Path
from wecom_cleanup_contract import CausalLeaseBudget
from wecom_host_identity import causal_reader_bootstrap
from wecom_physical_verify import VerifyStop
from test_wecom_host_identity import Hosts


class CausalContractTests(unittest.TestCase):
    def setUp(self):
        self.at=0.0
        self.ticket=dict(protocol='wecom-causal-v1',epoch='epoch-one',leaseId='lease-one',purpose='business')

    def budget(self):return CausalLeaseBudget(self.ticket,clock=lambda:self.at)
    def reply(self,remaining=10000):return dict(valid=True,causalLease=dict(self.ticket),remainingMs=remaining)

    def test_full_rtt_is_subtracted_not_added(self):
        b=self.budget();start=b.sample();self.at=2.0
        self.assertTrue(b.consume(self.reply(),start));self.assertEqual(b.deadline,10.0)
        self.assertEqual(b.deadline-self.at,8.0)

    def test_later_response_cannot_extend_first_conservative_bound(self):
        b=self.budget();start=b.sample();self.at=1.;b.consume(self.reply(),start)
        self.at=2.;start=b.sample();self.at=2.01;b.consume(self.reply(9000),start)
        self.assertEqual(b.deadline,10.)

    def test_exact_three_seconds_remaining_is_rejected_and_stays_revoked(self):
        b=self.budget();start=b.sample();self.at=7.
        with self.assertRaises(VerifyStop):b.consume(self.reply(),start)
        with self.assertRaises(VerifyStop):b.consume(self.reply(300000),self.at)

    def test_non_matching_epoch_purpose_id_and_invalid_remaining_reject(self):
        for name,value in [('epoch','epoch-two'),('purpose','verification'),('leaseId','other')]:
            with self.subTest(name=name):
                b=self.budget();r=self.reply();r['causalLease'][name]=value
                with self.assertRaises(VerifyStop):b.consume(r,0.)
        for remaining in [True,-1,300001,1.5,'10000',float('inf')]:
            with self.subTest(remaining=remaining):
                b=self.budget()
                with self.assertRaises(VerifyStop):b.consume(self.reply(remaining),0.)

    def test_monotonic_regression_is_not_repaired_by_wall_or_new_response(self):
        b=self.budget();self.at=1.;b.sample();self.at=.5
        with self.assertRaises(VerifyStop):b.sample()
        self.at=3.
        with self.assertRaises(VerifyStop):b.consume(self.reply(),3.)

    def test_invalid_ticket_and_verification_budget_do_not_inherit_300_seconds(self):
        for altered in [{},dict(self.ticket,extra=True),dict(self.ticket,purpose='other')]:
            with self.assertRaises(VerifyStop):CausalLeaseBudget(altered)
        self.ticket['purpose']='verification';b=self.budget()
        with self.assertRaises(VerifyStop):b.consume(self.reply(120001),0.)

    def envelope(self):
        f=Path(__file__).resolve().parents[2]/'verification/wecom-cleanup-v1/fixtures.json'
        binding=json.loads(f.read_text())['binding']
        return dict(version=1,binding=binding,bootstrap=dict(protocol='wecom-causal-v1',bindingNonce=binding['nonce'],pipeNonce='b'*48))

    def test_private_bootstrap_echo_is_bound_to_original_nonce_and_exact_host(self):
        e=self.envelope();hosts,guard,p=causal_reader_bootstrap(e,runtime=Hosts(),current_pid=2,parent_pid=1,platform='nt',machine=lambda:'a'*64)
        self.assertEqual(hosts[0]['pid'],2);self.assertEqual(p,e['bootstrap']);self.assertTrue(guard.check())

    def test_old_binding_wrong_pipe_and_additional_bootstrap_fields_reject(self):
        for key,value in [('bindingNonce','old'),('pipeNonce','bad'),('extra',True)]:
            e=self.envelope();e['bootstrap'][key]=value
            with self.assertRaises(VerifyStop):causal_reader_bootstrap(e,runtime=Hosts(),current_pid=2,parent_pid=1,platform='nt',machine=lambda:'a'*64)

    def test_private_nonce_does_not_override_system_parent_guard(self):
        r=Hosts();r.rows[1]['owner']='Administrator'
        with self.assertRaises(VerifyStop):causal_reader_bootstrap(self.envelope(),runtime=r,current_pid=2,parent_pid=1,platform='nt',machine=lambda:'a'*64)


if __name__=='__main__':unittest.main()
