"""Synthetic WeCom tests; never imports Airtest or connects to a device."""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace

import wecom_invite_preview as w


# Synthetic local-only identifiers; never submit them to WeCom.
PHONE = "19900000001"
OTHER = "19900000002"


def text(value, **kwargs):
    return w.Node("android.widget.TextView", text=value, **kwargs)


def frame(*nodes, package=w.PACKAGE):
    return w.Screen(package, tuple(text(n) if isinstance(n, str) else n for n in nodes))


HOME = frame("消息", "工作台", "通讯录", w.Node("android.widget.ImageView", desc="更多", position=(.93, .06)))
MENU = frame("添加客户", "发起群聊", "扫一扫")
ADD = frame("添加客户", "面对面添加", "搜索手机号添加")
EMPTY = frame(w.Node("android.widget.EditText", name="phone_input", text="手机号"))
TYPED = frame(w.Node("android.widget.EditText", name="phone_input", text=PHONE),
              "网络查找手机/邮箱：" + PHONE)
PROFILE = frame("个人信息", "设置备注和描述", "电话", PHONE, "添加为联系人")
PREVIEW = frame("测试企业", "测试成员", "测试邀请文案", "发送添加邀请")
PATH = [HOME, MENU, ADD, EMPTY, TYPED, PROFILE, PREVIEW]
ACTIONS = ["open_menu", "open_add", "open_search", "enter_phone", "search", "open_preview"]


class Device:
    def __init__(self, frames=None):
        self.frames = list(PATH if frames is None else frames)
        self.index = 0
        self.calls = []
        self.reads = 0

    def snapshot(self):
        self.reads += 1
        return self.frames[self.index]

    def apply(self, action, expected, phone, check_budget):
        check_budget()
        # Independent oracle: any added send/save/message operation fails tests.
        if action not in ACTIONS:
            raise AssertionError("Unexpected mutation")
        self.calls.append(action)
        self.index = min(len(self.frames) - 1, self.index + 1)


def run(device, **kwargs):
    return w.run_preview(device, {"phoneNumber": PHONE}, sleep=lambda _: None, **kwargs)


class PreviewFlowTests(unittest.TestCase):
    def test_observed_system_panels_stop_before_navigation_without_dismissing_them(self):
        for names in [('qs_detail_back','detail_items_title'),('settings_button','notification_container_parent')]:
            panel=tuple(w.Node('android.view.View',name='com.android.systemui:id/'+name)for name in names)
            page=replace(HOME,nodes=HOME.nodes+panel);device=Device([page])
            self.assertEqual(run(device)['code'],'system_overlay_interrupted');self.assertFalse(device.calls)
            w.guard(replace(HOME,nodes=HOME.nodes+panel[:1]))

    def test_system_panel_during_search_is_not_reported_as_rpc_timeout_or_reclicked(self):
        panel=frame('WLAN',w.Node('android.view.View',name='com.android.systemui:id/qs_detail_back'),
                    w.Node('android.view.View',name='com.android.systemui:id/detail_items_title'))
        device=Device(PATH[:5]+[panel]);out=run(device)
        self.assertEqual(out['code'],'system_overlay_interrupted');self.assertEqual(device.calls.count('search'),1)
        self.assertNotIn('open_preview',device.calls)
    def test_full_path_stops_before_send_and_does_not_save_remarks(self):
        device = Device()
        result = run(device)
        self.assertEqual(result["status"], "ready_before_send")
        self.assertEqual(device.calls, ACTIONS)
        self.assertFalse(result["invitationSent"])
        self.assertFalse(result["remarkSaved"])
        self.assertEqual(device.index, 6)
        self.assertGreaterEqual(device.reads, 8)  # two preview observations

    def test_each_allowed_entry_page(self):
        for start in (0, 1, 2):
            with self.subTest(start=start):
                device = Device(PATH[start:])
                self.assertEqual(run(device)["status"], "ready_before_send")
                self.assertEqual(device.calls, ACTIONS[start:])

    def test_restart_at_preview_does_nothing_and_cannot_claim_target(self):
        device = Device([PREVIEW])
        self.assertEqual(run(device)["code"], "preview_target_unverified")
        self.assertEqual(device.calls, [])

    def test_reentry_arbitrary_search_chat_and_profile_are_rejected(self):
        for page in (EMPTY, TYPED, PROFILE, frame("发送", PHONE)):
            device = Device([page])
            self.assertEqual(run(device)["code"], "unsupported_start_page")
            self.assertFalse(device.calls)

    def test_invalid_numbers_and_sending_options_never_read_device(self):
        requests = [{"phoneNumber": v} for v in (None, 123, "", "123", "+86" + PHONE, " " + PHONE,
                    PHONE + ";input tap 1 1", "１９９０００００００１")]
        requests += [{"phoneNumber": PHONE, "mode": "send"},
                     {"phoneNumber": PHONE, "send": True},
                     {"phoneNumber": PHONE, "remark": "new remark"}, []]
        for request in requests:
            device = Device()
            result = w.run_preview(device, request)
            self.assertEqual(result["status"], "stopped")
            self.assertEqual(device.reads, 0)

    def test_not_found_has_no_preview_or_send(self):
        device = Device(PATH[:5] + [frame("该用户不存在")])
        self.assertEqual(run(device)["code"], "not_found")
        self.assertEqual(device.calls, ACTIONS[:5])

    def test_wrong_profile_number_stops_without_add(self):
        device = Device(PATH[:5] + [frame("个人信息", "设置备注和描述", OTHER, "添加为联系人")])
        self.assertEqual(run(device)["code"], "profile_phone_mismatch")
        self.assertNotIn("open_preview", device.calls)

    def test_already_contact_is_not_readded_or_messaged(self):
        device = Device(PATH[:5] + [frame("个人信息", "设置备注和描述", PHONE, "发消息")])
        self.assertEqual(run(device)["code"], "already_contact")
        self.assertNotIn("open_preview", device.calls)

    def test_wrong_input_never_searches_or_retypes(self):
        wrong = frame(w.Node("android.widget.EditText", text=OTHER), "网络查找手机/邮箱：" + OTHER)
        device = Device(PATH[:4] + [wrong])
        self.assertEqual(run(device)["code"], "phone_readback_mismatch")
        self.assertEqual(device.calls.count("enter_phone"), 1)
        self.assertNotIn("search", device.calls)

    def test_search_waits_for_settled_row_and_is_delivered_once(self):
        moving = replace(TYPED, nodes=(TYPED.nodes[0],
                         replace(TYPED.nodes[1], position=(.5, .19))))
        class MovingRow(Device):
            def __init__(self):
                super().__init__()
                self.observations = []
            def snapshot(self):
                if self.index == 4:
                    page = moving if not self.observations else TYPED
                    self.observations.append(page)
                    return page
                return super().snapshot()
            def apply(self, action, expected, phone, check_budget):
                if action == "search":
                    if len(self.observations) < 3 or self.observations[-2:] != [TYPED, TYPED]:
                        raise AssertionError("Search row was still moving")
                return super().apply(action, expected, phone, check_budget)
        device = MovingRow()
        self.assertEqual(run(device)["status"], "ready_before_send")
        self.assertEqual(device.calls.count("search"), 1)

    def test_number_changes_during_search_settling_stop_before_search(self):
        wrong = frame(w.Node("android.widget.EditText", text=OTHER),
                      "网络查找手机/邮箱：" + OTHER)
        class ChangedNumber(Device):
            observed = False
            def snapshot(self):
                if self.index == 4:
                    if self.observed:
                        return wrong
                    self.observed = True
                return super().snapshot()
        device = ChangedNumber()
        self.assertEqual(run(device)["code"], "phone_readback_mismatch")
        self.assertNotIn("search", device.calls)
        self.assertEqual(device.calls.count("enter_phone"), 1)

    def test_search_ack_without_navigation_never_repeats_click(self):
        class NoNavigation(Device):
            def apply(self, action, expected, phone, check_budget):
                if action == "search":
                    self.calls.append(action)
                    return
                return super().apply(action, expected, phone, check_budget)
        device = NoNavigation()
        self.assertEqual(run(device, max_reads=25)["code"], "observation_budget_exhausted")
        self.assertEqual(device.calls.count("search"), 1)

    def test_observed_search_progress_uses_original_deadline_not_read_count(self):
        busy = frame(text("查找中", name="com.tencent.wework:id/krm"))
        class SlowSearch(Device):
            remaining = 40
            def snapshot(self):
                if self.index == 5 and self.remaining:
                    self.remaining -= 1
                    return busy
                return super().snapshot()
        device = SlowSearch()
        self.assertEqual(run(device, max_reads=15)["status"], "ready_before_send")
        self.assertEqual(device.calls.count("search"), 1)

    def test_progress_whitelist_excludes_unknown_pages_and_live_controls(self):
        busy = frame(text("请稍候…", name="com.tencent.wework:id/krm"))
        self.assertTrue(w.is_observed_progress(busy))
        for page in (replace(busy, package="com.other.app"),
                     frame(text("请稍候…", name="unknown")),
                     frame(text("加载中", name="com.tencent.wework:id/krm")),
                     replace(busy, nodes=busy.nodes + (text("保存"),)),
                     replace(busy, nodes=busy.nodes * 2)):
            self.assertFalse(w.is_observed_progress(page))

    def test_oppo_clock_and_battery_only_ignored_in_top_system_band(self):
        clock = text("18:47", name="com.android.systemui:id/clock",
                     position=(.208, .03), size=(.102, .028))
        battery = text("84", name="com.android.systemui:id/battery_text",
                       position=(.859, .03), size=(.064, .015))
        self.assertTrue(w.is_system_status_indicator(clock))
        self.assertTrue(w.is_system_status_indicator(battery))
        for node in (replace(clock, name="com.tencent.wework:id/clock"),
                     replace(clock, position=(.2, .2)),
                     replace(battery, text="101"),
                     replace(battery, name="com.android.systemui:id/unknown"),
                     replace(battery, desc="确认")):
            self.assertFalse(w.is_system_status_indicator(node))

    def test_prepopulated_input_is_not_overwritten(self):
        device = Device(PATH[:3] + [TYPED])
        self.assertEqual(run(device)["code"], "unrecognized_phone_input")
        self.assertNotIn("enter_phone", device.calls)

    def test_only_empty_status_bar_background_in_observed_top_band_is_ignored(self):
        node=w.Node('android.view.View',name='android:id/statusBarBackground',position=(.5,.022),size=(1,.044))
        self.assertTrue(w.is_system_status_indicator(node))
        for other in (replace(node,name='com.tencent.wework:id/statusBarBackground'),
                      replace(node,position=(.5,.2)),replace(node,size=(1,.2)),
                      replace(node,text='unknown'),replace(node,desc='click'),
                      replace(node,kind='android.widget.Button')):
            self.assertFalse(w.is_system_status_indicator(other))

    def test_duplicate_search_rows_or_editors_fail_closed(self):
        for extra in (text("网络查找手机/邮箱：" + PHONE, name="duplicate"),
                      w.Node("android.widget.EditText", text=PHONE, name="duplicate")):
            device = Device(PATH[:4] + [replace(TYPED, nodes=TYPED.nodes + (extra,))])
            self.assertEqual(run(device)["code"], "ambiguous_or_missing_element")
            self.assertNotIn("search", device.calls)

    def test_foreground_changed_at_every_step(self):
        for i in range(len(PATH)):
            device = Device(PATH[:i] + [replace(PATH[i], package="com.other.app")])
            self.assertEqual(run(device)["code"], "wrong_foreground_app")
            self.assertEqual(len(device.calls), i)

    def test_challenge_or_limit_never_dismissed_at_every_step(self):
        for marker in w.HUMAN_MARKERS:
            for i in range(len(PATH)):
                device = Device(PATH[:i] + [replace(PATH[i], nodes=PATH[i].nodes + (text(marker),))])
                self.assertEqual(run(device)["code"], "human_required")
                self.assertEqual(len(device.calls), i)

    def test_login_required(self):
        for label in ("登录", "手机号登录", "重新登录", "登录已过期"):
            device = Device([frame(label)])
            self.assertEqual(run(device)["code"], "login_required")
            self.assertFalse(device.calls)

    def test_unknown_transition_has_bounded_wait_no_repeated_actions(self):
        device = Device([HOME, frame("加载中")])
        self.assertEqual(run(device, max_reads=6)["code"], "observation_budget_exhausted")
        self.assertEqual(device.calls, ["open_menu"])
        self.assertEqual(device.reads, 6)

    def test_slow_loading_does_not_repeat_navigation(self):
        device = Device()
        original = device.snapshot
        delayed = set()
        def snapshot():
            if device.index > 0 and device.index not in delayed:
                delayed.add(device.index)
                return frame("加载中")
            return original()
        device.snapshot = snapshot
        self.assertEqual(run(device)["status"], "ready_before_send")
        self.assertEqual(device.calls, ACTIONS)

    def test_timeout_after_read_prevents_action(self):
        device = Device()
        now = [0]
        original = device.snapshot
        def snapshot():
            now[0] = 100
            return original()
        device.snapshot = snapshot
        self.assertEqual(run(device, clock=lambda: now[0])["code"], "timeout")
        self.assertFalse(device.calls)

    def test_cancelled_does_not_touch_device(self):
        device = Device()
        self.assertEqual(run(device, cancelled=lambda: True)["code"], "cancelled")
        self.assertEqual(device.reads, 0)

    def test_invalid_budget_rejected(self):
        for kwargs in ({"timeout": float("nan")}, {"timeout": 0}, {"max_reads": 0}, {"max_reads": 500}):
            device = Device()
            self.assertEqual(run(device, **kwargs)["code"], "invalid_budget")
            self.assertFalse(device.calls)

    def test_action_exception_never_retried_or_leaked(self):
        device = Device()
        def uncertain(*args):
            device.calls.append("attempted")
            raise RuntimeError("private UI " + PHONE)
        device.apply = uncertain
        result = run(device)
        self.assertEqual(result["code"], "executor_error_no_replay")
        self.assertEqual(device.calls, ["attempted"])
        self.assertNotIn(PHONE, json.dumps(result))

    def test_forbidden_actions_and_send_screen_always_reject(self):
        for page in PATH:
            for action in ("send", "发送添加邀请", "save_remark", "发消息", "tap", "back"):
                with self.assertRaises(w.StopPreview):
                    w.resolve_action(action, page, PHONE)
        for action in ACTIONS:
            with self.assertRaises(w.StopPreview):
                w.resolve_action(action, PREVIEW, PHONE)

    def test_preview_replaces_action_page_never_clicked(self):
        for i in range(6):
            device = Device(PATH[:i] + [PREVIEW])
            self.assertEqual(run(device)["code"], "preview_target_unverified")
            self.assertEqual(len(device.calls), i)

    def test_result_contains_no_phone_or_ui_content(self):
        result = run(Device())
        content = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(PHONE, content)
        self.assertNotIn("测试", content)

    def test_stale_search_row_number_must_match_readback(self):
        stale = frame(TYPED.nodes[0], "网络查找手机/邮箱：" + OTHER)
        device = Device(PATH[:4] + [stale])
        self.assertEqual(run(device)["code"], "ambiguous_or_missing_element")
        self.assertNotIn("search", device.calls)

    def test_empty_unidentified_editor_cannot_receive_phone(self):
        device = Device(PATH[:3] + [frame(w.Node("android.widget.EditText", name="chat"))])
        self.assertEqual(run(device)["code"], "unrecognized_phone_input")
        self.assertNotIn("enter_phone", device.calls)


class PocoItem:
    def __init__(self, node, effects):
        self.node, self.effects = node, effects
    def attr(self, key):
        return {"text": self.node.text, "name": self.node.name, "contentDescription": self.node.desc,
                "visible": self.node.visible, "enabled": self.node.enabled}.get(key)
    def get_position(self):
        return self.node.position
    def get_size(self):
        return self.node.size
    def set_text(self, value):
        self.effects.append(("input", value))
    def click(self):
        self.effects.append(("click", self.node.text or self.node.desc))


class Poco:
    def __init__(self, screen):
        self.screen, self.effects = screen, []
    def freeze(self):
        return self
    def __call__(self, **selector):
        matches = []
        for n in self.screen.nodes:
            attrs = {"type": n.kind, "text": n.text, "name": n.name, "contentDescription": n.desc}
            if all(attrs[k] == v for k, v in selector.items()):
                matches.append(PocoItem(n, self.effects))
        return matches


class PocoAdapterTests(unittest.TestCase):
    def driver(self, screen):
        poco = Poco(screen)
        return poco, w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)

    def test_exact_navigation_and_input_without_coordinate_taps(self):
        for screen, action in zip(PATH, ACTIONS):
            poco, driver = self.driver(screen)
            expected = driver.snapshot()
            driver.apply(action, expected, PHONE)
            self.assertEqual(len(poco.effects), 1)
            self.assertNotEqual(poco.effects[0][1], w.SEND)

    def test_changed_page_at_commit_is_rejected(self):
        poco, driver = self.driver(PROFILE)
        expected = driver.snapshot()
        poco.screen = PREVIEW
        with self.assertRaisesRegex(w.StopPreview, "page_changed"):
            driver.apply("open_preview", expected, PHONE)
        self.assertFalse(poco.effects)

    def test_lease_lost_before_action_no_click(self):
        poco, driver = self.driver(PROFILE)
        expected = driver.snapshot()
        driver.lease_valid = lambda: False
        with self.assertRaisesRegex(w.StopPreview, "device_lease_lost"):
            driver.apply("open_preview", expected, PHONE)
        self.assertFalse(poco.effects)

    def test_expired_budget_after_second_snapshot_no_click(self):
        poco, driver = self.driver(PROFILE)
        def expired():
            raise w.StopPreview("timeout")
        with self.assertRaisesRegex(w.StopPreview, "timeout"):
            driver.apply("open_preview", driver.snapshot(), PHONE, expired)
        self.assertFalse(poco.effects)

    def test_duplicate_disabled_hidden_menu_controls_rejected(self):
        for changed in (replace(HOME.nodes[-1], enabled=False), replace(HOME.nodes[-1], visible=False),
                        replace(HOME.nodes[-1], position=(.5, .9)), replace(HOME.nodes[-1], desc="")):
            poco, driver = self.driver(replace(HOME, nodes=HOME.nodes[:-1] + (changed,)))
            with self.assertRaises(w.StopPreview):
                driver.apply("open_menu", driver.snapshot(), PHONE)
            self.assertFalse(poco.effects)

    def test_final_boundary_rejects_all_driver_actions(self):
        for action in ACTIONS + ["send", "save_remark"]:
            poco, driver = self.driver(PREVIEW)
            with self.assertRaises(w.StopPreview):
                driver.apply(action, driver.snapshot(), PHONE)
            self.assertFalse(poco.effects)

    def test_disabled_send_button_still_blocks_navigation(self):
        screen = replace(PROFILE, nodes=PROFILE.nodes + (text(w.SEND, enabled=False),))
        poco, driver = self.driver(screen)
        with self.assertRaisesRegex(w.StopPreview, "send_boundary_reached"):
            driver.apply("open_preview", driver.snapshot(), PHONE)
        self.assertFalse(poco.effects)

    def test_full_flow_through_actual_adapter_with_synthetic_poco(self):
        poco = Poco(HOME)
        original_call = poco.__class__.__call__
        class AdvancingPoco(Poco):
            def __call__(self, **selector):
                items = original_call(self, **selector)
                for item in items:
                    original_click = item.click
                    original_set = item.set_text
                    def advance():
                        self.screen = PATH[len(self.effects)]
                    def click(original=original_click):
                        original()
                        advance()
                    def set_text(value, original=original_set):
                        original(value)
                        advance()
                    item.click, item.set_text = click, set_text
                return items
        poco = AdvancingPoco(HOME)
        driver = w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)
        result = run(driver)
        self.assertEqual(result["status"], "ready_before_send")
        self.assertEqual(len(poco.effects), 6)
        self.assertEqual(poco.screen, PREVIEW)
        self.assertFalse(any(value == w.SEND for _, value in poco.effects))


class OfflineCliTests(unittest.TestCase):
    def test_cli_replay_runs_full_path(self):
        from dataclasses import asdict
        scenario = {"request": {"phoneNumber": PHONE}, "frames": []}
        for i, screen in enumerate(PATH):
            scenario["frames"].append({"nodes": [asdict(n) for n in screen.nodes],
                                       "expectAction": ACTIONS[i] if i < len(ACTIONS) else None})
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "synthetic.json"
            path.write_text(json.dumps(scenario), encoding="utf-8")
            completed = subprocess.run([sys.executable, str(pathlib.Path(w.__file__)), "--simulate", str(path)],
                                       capture_output=True, text=True, timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        result = json.loads(completed.stdout)["result"]
        self.assertEqual(result["status"], "ready_before_send")
        self.assertFalse(result["invitationSent"])
        self.assertNotIn(PHONE, completed.stdout)

    def test_cli_no_live_or_send_option(self):
        completed = subprocess.run([sys.executable, str(pathlib.Path(w.__file__)), "--live", "--send"],
                                   capture_output=True, text=True, timeout=5)
        self.assertNotEqual(completed.returncode, 0)


if __name__ == "__main__":
    unittest.main()
