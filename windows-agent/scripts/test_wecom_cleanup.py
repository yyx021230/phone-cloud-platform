import unittest
from wecom_cleanup import cleanup_reader, MAIN, TEST, ABSENT, parse_pids, pid_command


class ReaderCleanupTests(unittest.TestCase):
    def test_absence_requires_exact_executor_marker_not_silence_or_errors(self):
        for raw in ['', ' ', '\n', ABSENT[:-1], '123\n'+ABSENT, 'Error', '0', '__WECOM_PID_ERROR_V1__']:
            with self.subTest(raw=raw), self.assertRaises(ValueError): parse_pids(raw)
        self.assertEqual(parse_pids(ABSENT+'\n'), [])
        self.assertEqual(parse_pids('123 456\n'), ['123','456'])
        self.assertIn('code=$?',pid_command(MAIN))
        with self.assertRaises(ValueError): pid_command('untrusted; command')

    def run_cleanup(self, *, keep_main=False, keep_test=False, keep_forward=False,
                    changed_owner=False, changed_forward=False, response='', stop_raises=False,
                    no_owner=False, already_gone=False, read_raises=False):
        self.effects = []
        self.reads = []
        state = {'main': [] if already_gone else ['999' if changed_owner else '123'],
                 'test': ['456'] if keep_test else [], 'rows': [
                     ('other' if changed_forward else 'target', 'tcp:20001', 'tcp:10080'),
                     ('unrelated', 'tcp:20002', 'localabstract:scrcpy')]}
        def pids(package):
            self.reads.append(package)
            if read_raises: raise OSError('unreadable')
            return list(state['main' if package == MAIN else 'test'])
        def stop():
            self.effects.append('stop_main')
            if stop_raises: raise OSError('failed')
            if not keep_main: state['main'] = []
            return response
        def remove(port):
            self.effects.append(('remove', port))
            if not keep_forward: state['rows'] = [r for r in state['rows'] if r[1] != 'tcp:'+str(port)]
        return cleanup_reader(serial='target', ports=[(20001, 10080)],
            owned_pid='' if no_owner else '123', owned_start='' if no_owner else 'start',
            reader_started=True, pids=pids, start_token=lambda pid:'start', stop_main=stop,
            close_instrument=lambda:self.effects.append('close_own_instrument'),
            forwards=lambda:list(state['rows']), remove_forward=remove)

    def test_ack_with_live_main_is_not_cleanup(self):
        self.assertFalse(self.run_cleanup(keep_main=True))
        self.assertIn(MAIN, self.reads); self.assertIn(TEST, self.reads)

    def test_test_package_alive_is_not_cleanup(self):
        self.assertFalse(self.run_cleanup(keep_test=True))

    def test_ack_with_remaining_forward_is_not_cleanup(self):
        self.assertFalse(self.run_cleanup(keep_forward=True))

    def test_error_text_is_not_success_even_if_later_pids_are_empty(self):
        self.assertFalse(self.run_cleanup(response='Error: rejected'))

    def test_owner_replacement_never_gets_stopped(self):
        self.assertFalse(self.run_cleanup(changed_owner=True))
        self.assertNotIn('stop_main', self.effects)

    def test_unconfirmed_owner_after_start_delivery_never_gets_stopped(self):
        self.assertFalse(self.run_cleanup(no_owner=True))
        self.assertNotIn('stop_main', self.effects)

    def test_replaced_forward_is_not_removed(self):
        self.assertFalse(self.run_cleanup(changed_forward=True))
        self.assertNotIn(('remove', 20001), self.effects)

    def test_observed_empty_packages_and_forward_pass_without_touching_other_forward(self):
        self.assertTrue(self.run_cleanup())
        self.assertEqual(self.effects, ['stop_main', 'close_own_instrument', ('remove', 20001)])

    def test_already_exited_owned_process_needs_no_force_stop(self):
        self.assertTrue(self.run_cleanup(already_gone=True))
        self.assertNotIn('stop_main', self.effects)

    def test_stop_failure_still_closes_own_instrument_and_attempts_own_forward_cleanup(self):
        self.assertFalse(self.run_cleanup(stop_raises=True))
        self.assertIn('close_own_instrument', self.effects)
        self.assertIn(('remove', 20001), self.effects)

    def test_failed_proof_never_grants_success_or_force_stop(self):
        self.assertFalse(self.run_cleanup(read_raises=True))
        self.assertNotIn('stop_main', self.effects)

if __name__ == '__main__': unittest.main()
