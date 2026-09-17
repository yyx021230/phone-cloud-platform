import copy
import unittest
from unittest.mock import patch
import manual_canary as m


class CanaryTests(unittest.TestCase):
    def setUp(self):
        self.row = dict(number="10", sessionId="session-10", status="streaming", path="pc/slot-4", browserConnected=True, agentConnected=True)
        self.items = [dict(id="read-10", state="read", path="pc/slot-4", peerConnectionEstablished=True, remoteCandidate="prflx/udp/192.0.2.1/1234", localCandidate="host/udp/192.0.2.2/8189"),
                      dict(id="pub-10", state="publish", path="pc/slot-4", peerConnectionEstablished=True, remoteCandidate="prflx/udp/192.0.2.3/4321")]

    def test_exact_target_and_session(self):
        f = m.resolve(self.row, self.items)
        self.assertEqual(f["sessionId"], "session-10")
        self.assertEqual(f["port"], 1234)
        r = m.rule_for(f)
        self.assertIn("192.0.2.1/32", r)
        self.assertIn("--queue-bypass", r)
        self.assertEqual(r[r.index("--queue-num")+1], "49161")
        f["number"] = "129"
        self.assertEqual(m.rule_for(f)[-2], "49162")
        f["number"] = "181"
        with self.assertRaises(ValueError): m.rule_for(f)

    def test_slot_reuse_never_reuses_old_identity(self):
        old = m.resolve(self.row, self.items)
        self.items[0]["id"] = "replacement-reader"
        self.assertNotEqual(old, m.resolve(self.row, self.items))
        self.row["sessionId"] = "new-session"
        self.assertNotEqual(old, m.resolve(self.row, self.items))

    def test_no_attachment_for_missing_or_ambiguous_viewer(self):
        self.assertIsNone(m.resolve(self.row, self.items[:1]))
        self.assertIsNone(m.resolve(self.row, self.items+[copy.deepcopy(self.items[0])]))
        for key in ["browserConnected", "agentConnected"]:
            row = dict(self.row, **{key:False})
            self.assertIsNone(m.resolve(row, self.items))
        self.assertIsNone(m.resolve(dict(self.row, status="closed"), self.items))
        self.assertIsNone(m.resolve(dict(self.row, path="pc/session-10"), self.items))

    def test_non_udp_non_ipv4_and_shared_tuple_refused(self):
        for candidate in ["prflx/tcp/192.0.2.1/1234", "prflx/udp/::1/1234", "prflx/udp/0.0.0.0/1234", "prflx/udp/224.0.0.1/1234"]:
            items = copy.deepcopy(self.items)
            items[0]["remoteCandidate"] = candidate
            self.assertIsNone(m.resolve(self.row, items))
        self.items[1]["remoteCandidate"] = self.items[0]["remoteCandidate"]
        self.assertIsNone(m.resolve(self.row, self.items))

    def test_cleanup_only_tagged_own_rules(self):
        lines = "\n".join([
            "-P OUTPUT ACCEPT",
            "-A OUTPUT -p udp -m comment --comment unrelated -j NFQUEUE --queue-num 22222",
            "-A OUTPUT -p udp -m comment --comment "+m.PREFIX+"10 -j NFQUEUE --queue-num 49161",
            "-A OUTPUT -p udp -m comment --comment "+m.PREFIX+"129 -j NFQUEUE --queue-num 49162"])
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            return type("Result", (), {"stdout":lines, "returncode":0})()
        with patch.object(m, "run", fake): m.remove_rules()
        self.assertEqual(len(calls), 3)
        for c in calls[1:]:
            self.assertIn("-D", c)
            self.assertNotIn("unrelated", c)
            self.assertNotIn("-F", c)

    def test_probe_is_never_stopped_before_rule_removal(self):
        events = []
        proc = type("Proc", (), {"poll":lambda _:None, "send_signal":lambda *args:events.append("signal"),
            "wait":lambda *args,**kw:events.append("wait"), "stdout":type("Stream", (), {"close":lambda _:None})(), "returncode":0})()
        selector = type("Selector", (), {"unregister":lambda *args:None})()
        active = {"10":dict(proc=proc, rule=["exact-rule"], flow=dict(sessionId="test"))}
        def fake(args, **kwargs):
            events.append("delete" if "-D" in args else "check")
            return type("Result", (), {"returncode":0})()
        with patch.object(m, "run", fake), patch.object(m, "emit"):
            m.detach("10", active, selector)
        self.assertLess(events.index("delete"), events.index("signal"))
        self.assertFalse(active)


if __name__ == "__main__": unittest.main()
