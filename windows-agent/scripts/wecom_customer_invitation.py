"""Explicit single invitation attempt after the audited search/remark traversal.

No CLI or connection entry point. Caller supplies the live leased driver and a
one-use durable claim; unknown send outcomes are never replayed.
"""
import hashlib
import json
import os
import re
import time
from pathlib import Path
import wecom_invite_preview as w


INVITATION_ACKS = frozenset(('已发送好友申请', '好友申请已发送', '已成功发送好友申请',
                            '添加申请已发送', '申请已发送', '邀请已发送', '已发送添加邀请'))
TEXT_TOAST = re.compile(
    r'TextToastRecord\{([a-f0-9]+) token=([^\r\n]+?) '
    r'packageName=com\.tencent\.wework text=([^\r\n]+) duration=[01]\}'
)


def application_toasts(dump):
    """Identifiers of explicit WeCom success notices from Android's toast queue."""
    matches = set()
    for line in dump.splitlines():
        match = TEXT_TOAST.fullmatch(line.strip())
        if match and match[3] in INVITATION_ACKS:
            matches.add((match[1], match[2]))
    return matches


def claim_local(directory, config):
    # Fixed Agent-owned directory, not a request field. Keep a recipient fence
    # across task IDs and restarts without storing phones, remarks or credentials.
    key = hashlib.sha256(json.dumps([config['serial'], config['androidUser'], config['phoneNumber']],
                                  separators=(',', ':')).encode('utf8')).hexdigest()
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    try:
        with (root / (key + '.json')).open('x', encoding='utf8') as stream:
            json.dump({'taskId': config['taskId'], 'state': 'claimed_or_unknown'}, stream)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        raise w.StopPreview('invitation_local_claim_exists_no_retry')
    # On platforms supporting directory fsync, persist the directory entry too.
    if os.name != 'nt':
        fd = os.open(str(root), os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)


class InvitationDriverMixin:
    def send_invitation(self, expected, check_budget):
        fresh = self.snapshot()
        w.guard(fresh)
        if fresh != expected:
            raise w.StopPreview('invitation_page_changed')
        node = w.unique(fresh.matching(lambda n: n.labeled(w.SEND)))
        query = self.poco(type=node.kind, text=node.text) if node.text else self.poco(type=node.kind, contentDescription=node.desc)
        if len(query) == 0:
            raise w.StopPreview('invitation_element_missing')
        item = w.unique(list(query))
        if (item.attr('visible') is not True or item.attr('enabled') is not True
                or (item.attr('text') or '') != node.text or (item.attr('name') or '') != node.name
                or (item.attr('contentDescription') or '') != node.desc
                or tuple(item.get_position()) != node.position or tuple(item.get_size()) != node.size):
            raise w.StopPreview('invitation_element_changed')
        self._guard_host()
        check_budget()
        item.click()  # Exactly one call; a timeout may already have sent.


def application_ack(screen):
    """Closed, read-only native dialog proof; never infer from page navigation."""
    if screen.package != w.PACKAGE:return False
    messages=[n for n in screen.nodes if n.visible and n.kind=='android.widget.TextView' and n.name=='android:id/message']
    buttons=[n for n in screen.nodes if n.visible and n.name=='android:id/button1' and n.text in ('确定','知道了')]
    return len(messages)==len(buttons)==1 and messages[0].text in ('已发送好友申请','好友申请已发送','已成功发送好友申请')


def send_once(driver, prepared, claim, check_budget, observe_application_ack=False,
              read_toasts=None):
    if (prepared.get('status') != 'ready_before_send' or prepared.get('remarkPrepared') is not True
            or prepared.get('remarkSaveStatus') not in ('confirmed', 'not_needed')):
        return prepared
    if observe_application_ack and prepared.get('remarkPhoneSet') is not True:
        return dict(prepared,status='blocked',code='remark_phone_not_verified',invitationSent=False,sendStatus='not_attempted')
    result = dict(prepared, sendStatus='not_attempted')
    claimed = False
    try:
        check_budget()
        page = driver.snapshot(); w.guard(page)
        if observe_application_ack and application_ack(page):
            raise w.StopPreview('invitation_result_already_present')
        w.unique(page.matching(lambda n: n.labeled(w.SEND)))
        if driver.snapshot() != page:
            raise w.StopPreview('invitation_page_unstable')
        prior_toasts = application_toasts(read_toasts()) if read_toasts else set()
        # Mark unknown BEFORE awaiting the cloud. A failed acknowledgement can
        # already have persisted the claim. Never automatically try it again.
        claimed = True
        if claim() is not True:
            raise w.StopPreview('invitation_claim_unconfirmed_no_retry')
        check_budget()
        driver.send_invitation(page, check_budget)
        # Native click completion proves an attempt, not recipient delivery.
        result.update(status='send_attempted', code='invitation_click_issued_delivery_unknown')
        if observe_application_ack:
            # Two fresh exact frames and a live original lease. No second tap,
            # no retry of a timed out RPC and no changed overall deadline.
            until = time.monotonic() + 6 if read_toasts else None
            while True:
                driver._guard_host();check_budget()
                toast_proof = bool(read_toasts and application_toasts(read_toasts()) - prior_toasts)
                after=driver.snapshot();w.guard(after)
                if application_ack(after):
                    driver._guard_host();check_budget();second=driver.snapshot();w.guard(second)
                    if second==after and application_ack(second):
                        result.update(invitationRequestConfirmed=True,invitationRequestProof='wecom_system_dialog_v1')
                        break
                if toast_proof:
                    result.update(invitationRequestConfirmed=True,invitationRequestProof='wecom_system_toast_v1')
                    break
                if until is None or time.monotonic() >= until:
                    break
                time.sleep(.2)
    except w.StopPreview as error:
        result.update(status='blocked', code=str(error))
        if str(error)=='wecom_add_friend_too_frequent':
            result.update(addFriendLimitConfirmed=True,addFriendLimitProof='wecom_system_dialog_v1')
    except Exception:
        result.update(status='blocked', code='invitation_outcome_unknown_no_retry')
    result.update(invitationSent=None if claimed else False, sendStatus='unknown' if claimed else 'not_attempted')
    return result
