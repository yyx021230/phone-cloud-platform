import threading
import unittest
from unittest.mock import patch
import wecom_platform_preview as host
from wecom_diagnostics import ExecutionTrace


class SelectorBudgetTests(unittest.TestCase):
    def run_wait(self, overall=100, seconds=None):
        now=[0.0];selections=[]
        def foreground():
            host.budget()
            return host.w.PACKAGE if selections else 'com.android.intentresolver'
        def select(poco):
            host.budget();selections.append('main');now[0]+=20
            host.budget();return True
        with patch.object(host,'deadline',overall,create=True), \
             patch.object(host,'cleaning_up',False), \
             patch.object(host,'CANCELLED',threading.Event()), \
             patch.object(host,'trace',ExecutionTrace(clock=lambda:now[0])), \
             patch.object(host.time,'monotonic',side_effect=lambda:now[0]), \
             patch.object(host.time,'sleep',side_effect=lambda s:now.__setitem__(0,now[0]+s)), \
             patch.object(host,'foreground',side_effect=foreground), \
             patch.object(host,'resolve_observed_wecom_slot',side_effect=select):
            if seconds is None:host.wait_for_wecom_foreground(None)
            else:host.wait_for_wecom_foreground(None,seconds)
        return selections

    def test_old_budget_stops_during_slow_single_selection(self):
        with self.assertRaisesRegex(host.SafeStop,'wecom_launch_not_ready'):
            self.run_wait(seconds=18)

    def test_default_allows_slow_selection_without_click_replay(self):
        self.assertEqual(self.run_wait(),['main'])

    def test_original_job_deadline_still_stops_selection(self):
        with self.assertRaisesRegex(host.SafeStop,'preview_job_budget_exhausted'):
            self.run_wait(overall=15)


if __name__=='__main__':unittest.main()
