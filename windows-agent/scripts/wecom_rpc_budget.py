"""Bound one already connected Poco client's HTTP transport; never retries.

HRPC's client timeout only bounds waiting AFTER synchronous transport.send().
Its synchronous HTTP call otherwise receives timeout=None and may never return.
This helper changes only the dedicated test client's send method, not shared
requests defaults, installed packages, ADB, Agent or another Poco instance.
"""
import math


def bound_rpc_transport(client, seconds=3):
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 0 < seconds <= 10:
        raise ValueError('invalid_rpc_timeout')
    transport = client.transport
    if getattr(transport, '_wecom_bounded', False):
        raise ValueError('rpc_transport_already_bound')
    original_send = transport.send

    def send(request, timeout=None):
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError('invalid_rpc_timeout')
        return original_send(request, timeout=seconds if timeout is None else min(timeout, seconds))

    transport.send = send
    transport._wecom_bounded = True
    return client
