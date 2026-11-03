"""Observed MIUI startup guards for an already leased, connected test host.

No ADB, installation, settings changes, password entry or application launch.
Callbacks must be bounded and bound to the same exclusively leased device.
"""
import re
import time
import wecom_invite_preview as w

SUMMARY = 'android.miui:id/screen_on_proximity_sensor_summary_text_view'
HINT = 'android.miui:id/screen_on_proximity_sensor_hint_has_navigation_bar_text_view'
ANIMATION = 'android.miui:id/screen_on_proximity_sensor_hint_animation'


def keyguard_state(policy, android_user):
    if type(android_user) is not int or android_user < 0 or 'KeyguardServiceDelegate' not in policy:
        return 'unknown'
    section = policy.split('KeyguardServiceDelegate', 1)[1].split('Looper state:', 1)[0]
    def field(name, expression):
        values = re.findall(r'(?m)^\s*' + name + '=' + expression + r'\s*$', section)
        return values[0] if len(values) == 1 else None
    secure = field('secure', r'(true|false)')
    showing = field('mIsShowing', r'(true|false)')
    user = field('mCurrentUserId', r'(\d+)')
    if secure is None or showing is None or user != str(android_user):
        return 'unknown'
    if secure == 'true':
        return 'secure'
    return 'nonsecure_showing' if showing == 'true' else 'nonsecure_clear'


def dismiss_nonsecure_keyguard(read_policy, lease_valid, send_menu, android_user=0,
                              check_budget=lambda: None, sleep=time.sleep):
    """One normal MENU event only after two non-password keyguard observations."""
    check_budget()
    state = keyguard_state(read_policy(), android_user)
    if state == 'nonsecure_clear':
        return False
    if state != 'nonsecure_showing':
        raise w.StopPreview('device_unlock_requires_user')
    check_budget()
    state = keyguard_state(read_policy(), android_user)
    if state == 'nonsecure_clear':
        return False
    if state != 'nonsecure_showing' or lease_valid() is not True:
        raise w.StopPreview('device_unlock_context_changed')
    check_budget()
    send_menu()  # Never retry an event whose delivery is uncertain.
    for _ in range(8):
        check_budget()
        state = keyguard_state(read_policy(), android_user)
        if state == 'nonsecure_clear':
            return True
        if state != 'nonsecure_showing':
            break
        sleep(.25)
    raise w.StopPreview('device_unlock_not_confirmed')


def is_miui_proximity_overlay(screen):
    if screen.package != w.PACKAGE:
        return False
    expected = ((SUMMARY, 'android.widget.TextView'), (HINT, 'android.widget.TextView'),
                (ANIMATION, 'android.widget.ImageView'))
    for name, kind in expected:
        if len(screen.matching(lambda n: n.name == name and n.kind == kind)) != 1:
            return False
    summary = screen.matching(lambda n: n.name == SUMMARY)[0]
    hint = screen.matching(lambda n: n.name == HINT)[0]
    return summary.text == '请勿遮挡听筒区域' and re.sub(r'\s', '', hint.text) == '或按下“音量+”'


def dismiss_miui_proximity(read_screen, foreground, lease_valid, read_policy,
                          press_volume_up, android_user=0, check_budget=lambda: None,
                          sleep=time.sleep):
    """Follow the exact system hint once; preserve all existing UI guards."""
    check_budget()
    observed = read_screen()
    if not is_miui_proximity_overlay(observed):
        return False
    w.guard(observed)
    if read_screen() != observed:
        raise w.StopPreview('system_overlay_changed_before_action')
    if keyguard_state(read_policy(), android_user) != 'nonsecure_clear':
        raise w.StopPreview('device_unlock_requires_user')
    if foreground() != w.PACKAGE or lease_valid() is not True:
        raise w.StopPreview('system_overlay_lease_or_foreground_lost')
    check_budget()
    press_volume_up()  # The displayed OS dismissal, never a business button.
    for _ in range(8):
        check_budget()
        current = read_screen()
        w.guard(current)
        if not current.matching(lambda n: n.name in (SUMMARY, HINT, ANIMATION)):
            return True
        sleep(.25)
    raise w.StopPreview('system_overlay_dismissal_not_confirmed')


def is_observed_25_invite_foreground(device_number, android_user, current):
    # Initial navigation only: never proof that a NEW request is ready to send.
    return (device_number=='25' and android_user==0 and current[0]=='com.tencent.wework' and current[1]==0 and current[2] in (
            'com.tencent.wework/.friends.controller.WechatContactSendVerifyActivity',
            'com.tencent.wework/.contact.controller.WechatContactInfoActivity'))


class InitialPageReturn:
    """One BACK from two observed startup activities; never saves or sends."""
    MOMENTS = w.PACKAGE+'/.moments.controller.MomentsEnterpriseNotificationListActivity'
    REMARK = w.PACKAGE+'/.contact.controller.ContactRemarkAndOtherInfoEditActivity'

    def __init__(self):
        self.attempted=set()

    def matches(self, page, current, android_user, phone):
        if (page.package!=w.PACKAGE or len(current)!=3 or current[:2]!=(w.PACKAGE,android_user)
                or type(android_user)is not int or android_user<0 or page.has(w.SEND)):
            return False
        if current[2]==self.MOMENTS:
            return len(page.nodes)>3 and not page.matching(lambda n:n.kind=='android.widget.EditText')
        if current[2]==self.REMARK:
            import wecom_remark_preview as remarks
            return remarks.remark_page(page) and len(page.matching(
                lambda n:n.kind=='android.widget.EditText' and re.sub(r'[\s-]','',n.text)==phone))==1
        return False

    def apply(self, page, *, android_user, phone, snapshot, foreground_info,
              lease_valid, back, check_budget=lambda:None):
        check_budget();current=foreground_info()
        if not self.matches(page,current,android_user,phone):return False
        if current[2]in self.attempted:raise w.StopPreview('initial_page_return_not_confirmed')
        w.guard(page);check_budget()
        fresh=snapshot();w.guard(fresh)
        if fresh!=page or foreground_info()!=current or lease_valid()is not True:
            raise w.StopPreview('initial_page_return_context_changed')
        check_budget();self.attempted.add(current[2])
        back()  # Unknown delivery propagates; this activity is never retried.
        return True


class ScreenWakeGuard:
    """The previously verified host's bounded normal wake, without settings edits."""
    def __init__(self, read_power, lease_valid, wake, dismiss, check_budget=lambda: None):
        self.read_power,self.lease_valid,self.wake,self.dismiss=read_power,lease_valid,wake,dismiss
        self.check_budget=check_budget;self.count=0

    def ensure_awake(self):
        self.check_budget()
        if not re.search(r'mWakefulness=(?:Asleep|Dozing)\b',self.read_power()):
            return False
        if self.count>=3:raise w.StopPreview('repeated_display_sleep')
        if self.lease_valid() is not True:raise w.StopPreview('device_lease_lost')
        self.check_budget();self.count+=1
        self.wake()  # Unknown delivery propagates, never replayed here.
        if self.lease_valid() is not True:raise w.StopPreview('device_lease_lost')
        self.check_budget();self.dismiss()  # Normal OS request; no PIN/password bypass.
        return True


def confirm_awake(read_power, lease_valid, check_budget=lambda:None, sleep=time.sleep):
    """Read-only settling after one wake; original caller deadline still applies."""
    for attempt in range(4):
        check_budget()
        if lease_valid() is not True:raise w.StopPreview('device_lease_lost')
        check_budget();raw=read_power();check_budget()
        if re.search(r'mWakefulness=Awake\b',raw):return True
        if not re.search(r'mWakefulness=(?:Asleep|Dozing)\b',raw):break
        if attempt<3:sleep(.2)
    raise w.StopPreview('screen_wake_not_confirmed')
