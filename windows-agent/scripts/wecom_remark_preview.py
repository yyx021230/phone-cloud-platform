"""WeCom customer preview with default remarks. Never sends an invitation.

Use run_customer_preview(PocoRemarkDriver(existing_poco, foreground, real_lease),
                        {"phoneNumber": authorized_phone}).
The original run_preview remains available for previews without remark writes.
"""
from dataclasses import dataclass
import time
import wecom_invite_preview as w

DEFAULT_REMARK = "测试客户"
DEFAULT_DESCRIPTION = "接口联调测试"
NAME_ID = "com.tencent.wework:id/d0y"
DESCRIPTION_ID = "com.tencent.wework:id/czj"
BACK_ID = "com.tencent.wework:id/ns5"
REMARK_ACTIONS = ("open_remark", "fill_remark", "fill_description", "save_remark", "close_remark")
EMPTY_VALUES = {NAME_ID: ("", "备注名"), DESCRIPTION_ID: ("", "添加更多备注信息")}
DEFAULTS = {NAME_ID: DEFAULT_REMARK, DESCRIPTION_ID: DEFAULT_DESCRIPTION}


def editors(screen):
    return tuple(n for n in screen.nodes if n.visible and n.kind == "android.widget.EditText")


def values(screen):
    return tuple((n.name, n.text, n.desc, n.enabled) for n in editors(screen))


def remark_page(screen):
    if not all(screen.has(v) for v in ("设置备注和描述", "备注名", "企业", "电话", "描述", "保存")):
        return False
    nodes = editors(screen)
    return (len(nodes) == 5 and all(n.enabled for n in nodes)
            and all(sum(n.name == key for n in nodes) == 1 for key in DEFAULTS))


@dataclass(frozen=True)
class RemarkContext:
    expected: tuple
    value: str = ""


def resolve_remark(action, screen, phone, context=None):
    w.guard(screen)
    if screen.has(w.SEND):
        raise w.StopPreview("send_boundary_reached")
    if action == "open_remark" and w.profile_matches(screen, phone) and not screen.has("发消息"):
        if screen.has("设置备注和描述"):
            return w.unique(screen.matching(lambda n: n.labeled("设置备注和描述")))
        return w.unique(screen.matching(lambda n: n.kind == "android.widget.TextView"
                        and n.name == w.OBSERVED_PROFILE_DESCRIPTION and n.text == "描述"))
    if action not in REMARK_ACTIONS or not remark_page(screen) or context is None:
        raise w.StopPreview("remark_action_not_allowed")
    if values(screen) != context.expected:
        raise w.StopPreview("remark_fields_changed")
    if action in ("fill_remark", "fill_description"):
        key = NAME_ID if action == "fill_remark" else DESCRIPTION_ID
        node = w.unique(screen.matching(lambda n: n.kind == "android.widget.EditText" and n.name == key))
        if node.text.strip() not in EMPTY_VALUES[key] or context.value != DEFAULTS[key]:
            raise w.StopPreview("remark_overwrite_forbidden")
        return node
    if action == "save_remark":
        return w.unique(screen.matching(lambda n: n.labeled("保存")))
    if action == "close_remark":
        return w.unique(screen.matching(lambda n: n.kind == "android.widget.TextView"
                                       and n.name == BACK_ID and not n.text and not n.desc))
    raise w.StopPreview("remark_action_not_allowed")


class PocoRemarkDriver(w.PocoPreviewDriver):
    """Dedicated adapter; fresh page, live attributes and real lease per write."""
    def apply(self, action, expected_screen, phone, check_budget=lambda: None, context=None):
        if action not in REMARK_ACTIONS:
            return super().apply(action, expected_screen, phone, check_budget)
        fresh = self.snapshot()
        if fresh != expected_screen:
            raise w.StopPreview("page_changed_before_action")
        node = resolve_remark(action, fresh, phone, context)
        # Resource identifiers are observed on 67, never guessed coordinates.
        selector = {"type": node.kind, "name": node.name} if action in (
            "fill_remark", "fill_description", "close_remark") else {"type": node.kind, "text": node.text}
        query = self.poco(**selector)
        if len(query) == 0:
            raise w.StopPreview("ambiguous_or_missing_element")
        item = w.unique(list(query))
        if (item.attr("visible") is not True or item.attr("enabled") is not True
                or (item.attr("text") or "") != node.text
                or (item.attr("contentDescription") or "") != node.desc
                or (item.attr("name") or "") != node.name
                or tuple(item.get_position()) != node.position or tuple(item.get_size()) != node.size):
            raise w.StopPreview("element_changed_before_action")
        self._guard_host()
        check_budget()
        if action in ("fill_remark", "fill_description"):
            item.set_text(context.value)
        else:
            item.click()


class _RemarkingDriver:
    def __init__(self, driver, sleep):
        self.driver, self.sleep = driver, sleep
        self.saved = False
        self.save_status = "not_attempted"
        self.prepared = False
        self.events = []

    def snapshot(self):
        return self.driver.snapshot()

    def read_until(self, predicate, check_budget):
        for _ in range(30):
            check_budget()
            screen = self.driver.snapshot()
            check_budget()
            w.guard(screen)
            if screen.has(w.SEND):
                raise w.StopPreview("unexpected_send_page")
            if predicate(screen):
                return screen
            self.sleep(.25)
        raise w.StopPreview("remark_observation_budget_exhausted")

    def perform(self, action, screen, phone, check_budget, context=None):
        resolve_remark(action, screen, phone, context)
        check_budget()
        if action == "save_remark":
            # A transport failure after this point can have saved. Never retry.
            self.save_status = "unknown"
        self.driver.apply(action, screen, phone, check_budget, context=context)
        self.events.append({"step": action})

    def profile(self, phone, check_budget):
        def matches(screen):
            if screen.has("个人信息"):
                if not w.profile_matches(screen, phone):
                    raise w.StopPreview("profile_phone_mismatch")
                if screen.has("发消息"):
                    raise w.StopPreview("already_contact")
                return True
            return False
        return self.read_until(matches, check_budget)

    def prepare(self, screen, phone, check_budget):
        self.perform("open_remark", screen, phone, check_budget)
        screen = self.read_until(remark_page, check_budget)
        expected = values(screen)
        changed = False
        for key, action in ((NAME_ID, "fill_remark"), (DESCRIPTION_ID, "fill_description")):
            node = w.unique([n for n in editors(screen) if n.name == key])
            if node.text.strip() not in EMPTY_VALUES[key]:
                continue  # Preserve an existing name/description, even on rerun.
            before = expected
            after = tuple((name, DEFAULTS[key] if name == key else text, desc, enabled)
                          for name, text, desc, enabled in before)
            self.perform(action, screen, phone, check_budget, RemarkContext(before, DEFAULTS[key]))
            def readback(current):
                if not remark_page(current):
                    return False
                actual = values(current)
                if actual == after:
                    return True
                if actual != before:
                    raise w.StopPreview("remark_readback_mismatch")
                return False
            screen = self.read_until(readback, check_budget)
            expected = after
            changed = True
        context = RemarkContext(expected)
        if changed:
            self.perform("save_remark", screen, phone, check_budget, context)
            screen = self.profile(phone, check_budget)
            # Reopen and read persisted values; navigation alone is not proof.
            self.perform("open_remark", screen, phone, check_budget)
            screen = self.read_until(remark_page, check_budget)
            if values(screen) != expected:
                raise w.StopPreview("remark_persistence_unconfirmed")
            self.saved = True
            self.save_status = "confirmed"
        else:
            self.save_status = "not_needed"
        self.perform("close_remark", screen, phone, check_budget, context)
        screen = self.profile(phone, check_budget)
        self.prepared = True
        return screen

    def apply(self, action, expected_screen, phone, check_budget):
        if action == "open_preview":
            expected_screen = self.prepare(expected_screen, phone, check_budget)
        self.driver.apply(action, expected_screen, phone, check_budget)


def run_customer_preview(driver, request, timeout=120, max_reads=90,
                         cancelled=lambda: False, clock=time.monotonic, sleep=time.sleep):
    """Default remark/description for empty fields, then stop before invitation.

    Original nonempty fields and every other editor are preserved. Save is
    attempted at most once; uncertain writes stop without replay. The entire
    traversal shares the original deadline/cancellation and real lease gates.
    """
    wrapper = _RemarkingDriver(driver, sleep)
    result = w.run_preview(wrapper, request, timeout=timeout, max_reads=max_reads,
                           cancelled=cancelled, clock=clock, sleep=sleep)
    result.update(workflowVersion="wecom-customer-preview-v2", remarkSaved=wrapper.saved,
                  remarkSaveStatus=wrapper.save_status, remarkPrepared=wrapper.prepared,
                  remarkEvents=wrapper.events)
    return result
