"""WeCom customer preview with optional remarks. Never sends an invitation.

Use run_customer_preview(PocoRemarkDriver(existing_poco, foreground, real_lease),
                        {"phoneNumber": authorized_phone}).
The original run_preview remains available for previews without remark writes.
"""
from dataclasses import dataclass
import time
import wecom_invite_preview as w

DEFAULT_REMARK = "测试客户"
DEFAULT_DESCRIPTION = "接口联调测试"
# ECMAScript trim whitespace, so API and Python canonicalize identically.
INPUT_WHITESPACE = "\u0009\u000b\u000c\u0020\u00a0\ufeff\u000a\u000d\u2028\u2029\u1680\u202f\u205f\u3000" + "".join(chr(n) for n in range(0x2000, 0x200b))

def validate_remark_input(request):
    def normalize(key, fallback, limit):
        value = request.get(key, fallback)
        if not isinstance(value, str): raise w.StopPreview("invalid_wecom_" + key)
        if key == "description": value = value.replace("\r\n", "\n").replace("\r", "\n")
        value = value.strip(INPUT_WHITESPACE)
        if len(value) > limit or any((ord(c) < 32 and not (key == "description" and c == "\n")) or 0x7f <= ord(c) <= 0x9f or 0xd800 <= ord(c) <= 0xdfff for c in value):
            raise w.StopPreview("invalid_wecom_" + key)
        return value or fallback
    return (normalize("remarkName", DEFAULT_REMARK, 20), normalize("description", DEFAULT_DESCRIPTION, 120))
NAME_ID = "com.tencent.wework:id/d0y"
DESCRIPTION_ID = "com.tencent.wework:id/czj"
BACK_ID = "com.tencent.wework:id/ns5"
# Five-editor layouts observed on 67, 157 (5.0.12), and 59 (5.0.9).
# Never combine IDs from different observed layouts.
REMARK_LAYOUTS = ((NAME_ID, DESCRIPTION_ID, BACK_ID),
                  ("com.tencent.wework:id/d67", "com.tencent.wework:id/d4r", "com.tencent.wework:id/o62"),
                  ("com.tencent.wework:id/d0r", "com.tencent.wework:id/czc", "com.tencent.wework:id/nr7"),
                  ("com.tencent.wework:id/d0s", "com.tencent.wework:id/czd", "com.tencent.wework:id/nr_"),
                  ("com.tencent.wework:id/cqe", "com.tencent.wework:id/cp0", "com.tencent.wework:id/n24"),
                  ("com.tencent.wework:id/cu1", "com.tencent.wework:id/csm", "com.tencent.wework:id/nc9"))
REMARK_ACTIONS = ("open_remark", "fill_remark", "fill_description", "save_remark", "close_remark")
EMPTY_VALUES = {NAME_ID: ("", "备注名"), DESCRIPTION_ID: ("", "添加更多备注信息")}
DEFAULTS = {NAME_ID: DEFAULT_REMARK, DESCRIPTION_ID: DEFAULT_DESCRIPTION}
for _name, _description, _back in REMARK_LAYOUTS[1:]:
    EMPTY_VALUES[_name] = ("", "备注名")
    EMPTY_VALUES[_description] = ("", "添加更多备注信息")
    DEFAULTS[_name], DEFAULTS[_description] = DEFAULT_REMARK, DEFAULT_DESCRIPTION


def editors(screen):
    return tuple(n for n in screen.nodes if n.visible and n.kind == "android.widget.EditText")


def values(screen):
    return tuple((n.name, n.text, n.desc, n.enabled) for n in editors(screen))


def remark_layout(screen):
    if not all(screen.has(v) for v in ("设置备注和描述", "备注名", "企业", "电话", "描述", "保存")):
        return None
    nodes = editors(screen)
    if len(nodes) != 5 or not all(n.enabled for n in nodes):
        return None
    layouts = [layout for layout in REMARK_LAYOUTS
               if all(sum(n.name == key for n in nodes) == 1 for key in layout[:2])
               and not any(n.name in DEFAULTS and n.name not in layout[:2] for n in nodes)]
    return layouts[0] if len(layouts) == 1 else None


def remark_page(screen):
    return remark_layout(screen) is not None


def remark_phone_matches(screen, phone):
    # Only the independently observed telephone editors inside the complete
    # known five-editor remark page count; a matching remark NAME is not proof.
    return remark_page(screen) and sum(n.name == 'android.widget.EditText' and n.text == phone
                                      for n in editors(screen)) == 1


@dataclass(frozen=True)
class RemarkContext:
    expected: tuple
    value: str = ""
    requested: tuple = (DEFAULT_REMARK, DEFAULT_DESCRIPTION)
    replace_name: bool = False


def resolve_remark(action, screen, phone, context=None):
    w.guard(screen)
    if screen.has(w.SEND):
        raise w.StopPreview("send_boundary_reached")
    if action == "open_remark" and w.profile_matches(screen, phone) and not screen.has("发消息"):
        if screen.has("设置备注和描述"):
            return w.unique(screen.matching(lambda n: n.labeled("设置备注和描述")))
        return w.unique(screen.matching(lambda n: n.kind == "android.widget.TextView"
                        and n.name in w.OBSERVED_PROFILE_DESCRIPTIONS and n.text == "描述"))
    if action not in REMARK_ACTIONS or not remark_page(screen) or context is None:
        raise w.StopPreview("remark_action_not_allowed")
    if values(screen) != context.expected:
        raise w.StopPreview("remark_fields_changed")
    if action in ("fill_remark", "fill_description"):
        key = remark_layout(screen)[0 if action == "fill_remark" else 1]
        node = w.unique(screen.matching(lambda n: n.kind == "android.widget.EditText" and n.name == key))
        if not isinstance(context.requested, tuple) or len(context.requested) != 2:
            raise w.StopPreview("invalid_remark_context")
        requested = validate_remark_input(dict(zip(("remarkName", "description"), context.requested)))
        desired = requested[0 if action == "fill_remark" else 1]
        if (node.text.strip() not in EMPTY_VALUES[key] and not (action == "fill_remark" and context.replace_name is True)) or context.value != desired:
            raise w.StopPreview("remark_overwrite_forbidden")
        return node
    if action == "save_remark":
        return w.unique(screen.matching(lambda n: n.labeled("保存")))
    if action == "close_remark":
        return w.unique(screen.matching(lambda n: n.kind == "android.widget.TextView"
                                       and n.name == remark_layout(screen)[2] and not n.text and not n.desc))
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
    def __init__(self, driver, sleep, requested, replace_name=False, require_remark_phone=False):
        self.driver, self.sleep = driver, sleep
        self.requested = requested
        self.replace_name = replace_name
        self.require_remark_phone = require_remark_phone
        self.remark_phone_set = False
        self.saved = False
        self.save_status = "not_attempted"
        self.prepared = False
        self.events = []

    def snapshot(self):
        return self.driver.snapshot()

    def guard_input_observation(self):
        guard=getattr(self.driver,'guard_input_observation',None)
        if guard is not None:guard()

    def observe_input_change(self,before,after):
        observe=getattr(self.driver,'observe_input_change',None)
        if observe is not None:observe(before,after)

    def observe_action_change(self,action,before,after):
        observe=getattr(self.driver,'observe_action_change',None)
        if observe is not None:observe(action,before,after)

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
            if screen.has("个人信息") or screen.has("客户详情"):
                if not w.profile_matches(screen, phone):
                    raise w.StopPreview("profile_phone_mismatch")
                if screen.has("发消息"):
                    raise w.StopPreview("already_contact")
                return True
            return False
        return self.read_until(matches, check_budget)

    def prepare(self, screen, phone, check_budget):
        if self.prepared: raise w.StopPreview("remark_prepare_repeated")
        self.perform("open_remark", screen, phone, check_budget)
        screen = self.read_until(remark_page, check_budget)
        if self.require_remark_phone and not remark_phone_matches(screen, phone):
            raise w.StopPreview('remark_phone_not_verified')
        expected = values(screen)
        changed = False
        name_id, description_id, _ = remark_layout(screen)
        desired = {name_id: self.requested[0], description_id: self.requested[1]}
        for key, action in ((name_id, "fill_remark"), (description_id, "fill_description")):
            node = w.unique([n for n in editors(screen) if n.name == key])
            if node.text == desired[key] or (node.text.strip() not in EMPTY_VALUES[key] and not (key == name_id and self.replace_name)):
                continue  # Preserve an existing name/description, even on rerun.
            before = expected
            after = tuple((name, desired[key] if name == key else text, desc, enabled)
                          for name, text, desc, enabled in before)
            self.perform(action, screen, phone, check_budget, RemarkContext(before, desired[key], self.requested, self.replace_name))
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
        context = RemarkContext(expected, requested=self.requested)
        if changed:
            self.perform("save_remark", screen, phone, check_budget, context)
            screen = self.profile(phone, check_budget)
            # Reopen and read persisted values; navigation alone is not proof.
            self.perform("open_remark", screen, phone, check_budget)
            screen = self.read_until(remark_page, check_budget)
            if values(screen) != expected:
                raise w.StopPreview("remark_persistence_unconfirmed")
            second = self.driver.snapshot(); w.guard(second)
            if not remark_page(second) or values(second) != expected:
                raise w.StopPreview("remark_persistence_unstable")
            screen = second
            self.saved = True
            self.save_status = "confirmed"
        else:
            self.save_status = "not_needed"
        if self.require_remark_phone:
            second = self.driver.snapshot(); w.guard(second); check_budget()
            if values(second) != expected or not remark_phone_matches(second, phone):
                raise w.StopPreview('remark_phone_not_verified')
            self.remark_phone_set = True
        self.perform("close_remark", screen, phone, check_budget, context)
        screen = self.profile(phone, check_budget)
        self.prepared = True
        return screen

    def apply(self, action, expected_screen, phone, check_budget):
        if action == "open_preview":
            expected_screen = self.prepare(expected_screen, phone, check_budget)
        self.driver.apply(action, expected_screen, phone, check_budget)


def run_customer_preview(driver, request, timeout=120, max_reads=90,
                         cancelled=lambda: False, clock=time.monotonic, sleep=time.sleep, replace_name=False, require_remark_phone=False):
    """Requested or default remark/description for empty fields, then stop before invitation.

    Original nonempty fields and every other editor are preserved. Save is
    attempted at most once; uncertain writes stop without replay. The entire
    traversal shares the original deadline/cancellation and real lease gates.
    """
    if not isinstance(request, dict) or set(request) - {"phoneNumber", "mode", "remarkName", "description"}:
        raise w.StopPreview("invalid_request")
    requested = validate_remark_input(request)
    if type(require_remark_phone) is not bool:raise w.StopPreview('invalid_wecom_remark_phone_requirement')
    wrapper = _RemarkingDriver(driver, sleep, requested, replace_name=replace_name, require_remark_phone=require_remark_phone)
    core_request = {k: v for k, v in request.items() if k not in ("remarkName", "description")}
    result = w.run_preview(wrapper, core_request, timeout=timeout, max_reads=max_reads,
                           cancelled=cancelled, clock=clock, sleep=sleep)
    result.update(workflowVersion="wecom-customer-preview-v2", remarkSaved=wrapper.saved,
                  remarkSaveStatus=wrapper.save_status, remarkPrepared=wrapper.prepared,
                  remarkEvents=wrapper.events)
    if require_remark_phone:result['remarkPhoneSet'] = wrapper.remark_phone_set
    return result
