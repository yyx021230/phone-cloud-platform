"""Explicit single invitation attempt after the audited search/remark traversal.

No CLI or connection entry point. Caller supplies the live leased driver and a
one-use durable claim; unknown send outcomes are never replayed.
"""
import hashlib
import json
import os
from pathlib import Path
import wecom_invite_preview as w


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


def send_once(driver, prepared, claim, check_budget):
    if (prepared.get('status') != 'ready_before_send' or prepared.get('remarkPrepared') is not True
            or prepared.get('remarkSaveStatus') not in ('confirmed', 'not_needed')):
        return prepared
    result = dict(prepared, sendStatus='not_attempted')
    claimed = False
    try:
        check_budget()
        page = driver.snapshot(); w.guard(page)
        w.unique(page.matching(lambda n: n.labeled(w.SEND)))
        if driver.snapshot() != page:
            raise w.StopPreview('invitation_page_unstable')
        # Mark unknown BEFORE awaiting the cloud. A failed acknowledgement can
        # already have persisted the claim. Never automatically try it again.
        claimed = True
        if claim() is not True:
            raise w.StopPreview('invitation_claim_unconfirmed_no_retry')
        check_budget()
        driver.send_invitation(page, check_budget)
        # Native click completion proves an attempt, not recipient delivery.
        result.update(status='send_attempted', code='invitation_click_issued_delivery_unknown')
    except w.StopPreview as error:
        result.update(status='blocked', code=str(error))
    except Exception:
        result.update(status='blocked', code='invitation_outcome_unknown_no_retry')
    result.update(invitationSent=None if claimed else False, sendStatus='unknown' if claimed else 'not_attempted')
    return result
