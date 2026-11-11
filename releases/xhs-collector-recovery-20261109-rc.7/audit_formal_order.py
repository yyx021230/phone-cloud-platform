"""Apply the candidate's public digest rule to the existing local formal audit."""
from verify_public_order import verify_public_order


def audit_formal_order(base_audit, job, target, *, window_end):
    proof = base_audit(job, target, window_end=window_end)
    checks = proof['checks']
    if checks['orderedDigests']:
        return proof

    collection = (job.get('result') or {}).get('collection') or {}
    if verify_public_order(collection):
        checks['orderedDigests'] = True
        proof['publicOrderedDigestVerified'] = True
        proof['listIntegrityVerified'] = all(value for key, value in checks.items()
                                             if key != 'reportedIdTwoFreshSamples')
        proof['verifiedComplete'] = all(checks.values())
    return proof
