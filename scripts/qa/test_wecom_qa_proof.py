import unittest
from wecom_qa_proof import fresh_snapshot,current_snapshot

class ProofFreshnessTests(unittest.TestCase):
    def test_wait_without_new_facts_does_not_refresh_or_accept_old_cache(self):
        now=[10.0];cache=dict(at=8.0,allowed=True,generation='one')
        row,age,allowed=fresh_snapshot(lambda:dict(cache),'one',clock=lambda:now[0],wait=lambda seconds:now.__setitem__(0,now[0]+seconds))
        self.assertFalse(allowed);self.assertEqual(row['at'],8);self.assertGreaterEqual(age,2.6)
    def test_actual_new_fact_uses_its_own_start_and_generation(self):
        now=[10.0];cache=dict(at=8,allowed=True,generation='one')
        def wait(seconds):now[0]+=seconds;cache.update(at=now[0]-.1)
        row,age,allowed=fresh_snapshot(lambda:dict(cache),'one',clock=lambda:now[0],wait=wait)
        self.assertTrue(allowed);self.assertAlmostEqual(age,.1)
    def test_denial_and_changed_generation_are_not_retried_into_acceptance(self):
        for row in (dict(at=10,allowed=False,generation='one'),dict(at=10,allowed=True,generation='other')):
            _,_,allowed=fresh_snapshot(lambda:row,'one',clock=lambda:10,wait=lambda n:self.fail('no stale wait needed'))
            self.assertFalse(allowed)

class CurrentProofTests(unittest.TestCase):
    def test_recent_cache_avoids_a_network_read_but_denial_is_never_revived(self):
        for allowed,age in ((True,.2),(False,5)):
            row=dict(at=10-age,allowed=allowed,generation='g')
            result=current_snapshot(lambda:row,'g',lambda:self.fail('must not refetch'),clock=lambda:10)
            self.assertEqual(result[2],allowed)
    def test_stale_cache_uses_actual_new_observation_start(self):
        old=dict(at=7,allowed=True,generation='g');new=dict(at=9,allowed=True,generation='g')
        row,age,ok,via=current_snapshot(lambda:old,'g',lambda:new,clock=lambda:10)
        self.assertTrue(ok);self.assertEqual(age,1);self.assertEqual(row['at'],9);self.assertEqual(via,'synchronous_fact')
    def test_slow_or_changed_synchronous_facts_fail_without_timestamp_rewrite(self):
        for row in (dict(at=6,allowed=True,generation='g'),dict(at=10,allowed=True,generation='other'),dict(at=10,allowed=False,generation='g')):
            self.assertFalse(current_snapshot(lambda:{},'g',lambda:row,clock=lambda:10)[2])

if __name__=='__main__':unittest.main()
