import io
import json
import threading
import unittest
from wecom_call_trace import CallTrace, PREFIX


class CallTraceTests(unittest.TestCase):
    def test_nested_calls_have_ids_and_durations_without_arguments(self):
        stream = io.StringIO(); clock = [0]; trace = CallTrace(stream, clock=lambda:clock[0])
        with trace.call('rpc.agent'):
            clock[0] = .2
            with trace.call('rpc.send'): clock[0] = .4
        rows = [json.loads(line[len(PREFIX):]) for line in stream.getvalue().splitlines()]
        self.assertEqual([(r['id'], r['state']) for r in rows], [(1,'begin'),(2,'begin'),(2,'end'),(1,'end')])
        self.assertEqual(rows[-1]['durationMs'],400)
        self.assertEqual(trace.active, [])

    def test_exception_message_and_locals_are_not_collected(self):
        stream=io.StringIO(); trace=CallTrace(stream)
        secret = 'private phone credential page'
        with self.assertRaises(RuntimeError):
            with trace.call('rpc.send'):
                trace.sample()
                raise RuntimeError(secret)
        text=stream.getvalue()
        self.assertNotIn(secret,text); self.assertNotIn('locals',text)
        self.assertIn('RuntimeError',text)
        self.assertEqual(trace.active,[])

    def test_snapshot_records_live_call_and_thread_role_without_thread_name(self):
        stream=io.StringIO();trace=CallTrace(stream)
        with trace.call('rpc.freeze'): trace.sample()
        row=next(v for v in trace.recent if v['kind']=='stack')
        self.assertEqual(row['activeCalls'],[{'id':1,'call':'rpc.freeze'}])
        main=next(t for t in row['threads'] if t['role']=='main')
        self.assertFalse(main['daemon'])
        self.assertNotIn('name',main)
        self.assertTrue(all(set(f)=={'module','function','line'} for t in row['threads'] for f in t['stack']))

    def test_invalid_label_rejected_before_any_body(self):
        trace=CallTrace()
        with self.assertRaises(ValueError):
            with trace.call('private-request-payload'): self.fail('never run')

    def test_watchdog_is_daemon_and_can_be_stopped(self):
        trace=CallTrace(io.StringIO(),interval=.01)
        trace.start();trace.start()
        self.assertTrue(trace.worker.daemon)
        trace.close(); self.assertFalse(trace.worker.is_alive())

    def test_record_budget_does_not_hide_final_lifecycle_or_stack(self):
        trace=CallTrace()
        trace.rows=4000
        trace.emit({'kind':'call','call':'rpc.send'})
        self.assertEqual([x['kind']for x in trace.recent],['call'])
        trace.emit({'kind':'lifecycle','event':'final_json_flushed'},essential=True)
        trace.sample()
        self.assertEqual([x['kind'] for x in trace.recent],['call','lifecycle','stack'])

    def test_bounded_error_and_private_tail_survive_normal_record_cap(self):
        import io,json
        stream=io.StringIO();trace=CallTrace(stream);trace.rows=4000
        for _ in range(70):
            try:
                with trace.call('rpc.send'):raise TimeoutError('private message')
            except TimeoutError:pass
        trace.flush_tail();trace.flush_tail()
        records=[json.loads(line.split(' ',1)[1])for line in stream.getvalue().splitlines()]
        errors=[r for r in records if r.get('kind')=='call'and r.get('state')=='error']
        tails=[r for r in records if r.get('kind')=='tail']
        self.assertEqual(len(errors),64);self.assertLessEqual(len(tails),64)
        self.assertNotIn('private message',stream.getvalue())

    def test_tail_keeps_actual_latest_calls_after_stream_cap(self):
        import io,json
        stream=io.StringIO();trace=CallTrace(stream);trace.rows=4000
        with trace.call('foreground.read'):pass
        self.assertEqual(stream.getvalue(),'')
        trace.flush_tail()
        rows=[json.loads(line.split(' ',1)[1])for line in stream.getvalue().splitlines()]
        self.assertTrue(any(r['kind']=='tail'and r['record'].get('call')=='foreground.read'and r['record'].get('state')=='end'for r in rows))

    def test_critical_ui_calls_are_bounded_but_survive_ordinary_cap(self):
        import io,json
        stream=io.StringIO();trace=CallTrace(stream);trace.rows=4000
        for _ in range(70):
            with trace.call('ui.enter_phone'):pass
        records=[json.loads(line.split(' ',1)[1])for line in stream.getvalue().splitlines()]
        self.assertEqual(len(records),128);self.assertEqual(records[0]['state'],'begin');self.assertEqual(records[1]['state'],'end')

if __name__ == '__main__': unittest.main()
