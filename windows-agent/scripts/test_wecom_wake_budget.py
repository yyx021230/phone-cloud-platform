import threading
import unittest
from unittest.mock import patch
import wecom_platform_preview as host
from wecom_diagnostics import ExecutionTrace


class WakeBudgetTests(unittest.TestCase):
    def run_wake(self, overall=100):
        now=[0.0];commands=[]
        def mutate(command):
            host.budget();commands.append(command);now[0]+=5
            return ''
        with patch.object(host,'config',{'deviceNumber':'59'},create=True), \
             patch.object(host,'external_authority',None),patch.object(host,'selected_user',0,create=True), \
             patch.object(host,'deadline',overall,create=True),patch.object(host,'cleaning_up',False), \
             patch.object(host,'CANCELLED',threading.Event()), \
             patch.object(host,'trace',ExecutionTrace(clock=lambda:now[0])), \
             patch.object(host.time,'monotonic',side_effect=lambda:now[0]), \
             patch.object(host,'lease_valid',return_value=True), \
             patch.object(host,'shell',side_effect=['mWakefulness=Asleep','mWakefulness=Awake']), \
             patch.object(host,'mutate',side_effect=mutate):
            result=host.prepare_screen_before_poco()
        return result,commands

    def test_slow_single_wake_and_dismiss_complete_without_repeating_actions(self):
        result,commands=self.run_wake()
        self.assertTrue(result)
        self.assertEqual(commands,['input keyevent 224','wm dismiss-keyguard'])

    def test_wake_stage_does_not_extend_original_job_deadline(self):
        with self.assertRaisesRegex(host.SafeStop,'preview_job_budget_exhausted'):
            self.run_wake(overall=6)


if __name__=='__main__':unittest.main()
