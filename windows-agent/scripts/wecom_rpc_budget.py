"""Bound one already connected Poco client's HTTP transport; never retries.

HRPC's client timeout only bounds waiting AFTER synchronous transport.send().
Its synchronous HTTP call otherwise receives timeout=None and may never return.
This helper changes only the dedicated test client's send method, not shared
requests defaults, installed packages, ADB, Agent or another Poco instance.
"""
import math
from wecom_invite_preview import StopPreview


class RpcDeliveryUnknown(StopPreview):
    """Do not let SDK TransportDisconnected decorators repeat a delivered write."""


RPC_ERROR_TYPES = frozenset(('TimeoutError','ReadTimeout','ReadTimeoutError','ConnectTimeout',
    'ConnectTimeoutError','RpcTimeoutException','ConnectionError','ConnectionResetError',
    'ConnectionAbortedError','BrokenPipeError','TransportDisconnected','PeerDenied','PeerUnavailable',
    'PermissionError','OSError','URLError','HTTPError'))
RPC_FAILURE_REASONS=frozenset(('connect_timeout','read_timeout','timeout','connection_closed',
    'transport_disconnected','peer_verification_failed','connection_error','unknown'))


def safe_rpc_failure(value):
    if (not isinstance(value,dict)or set(value)-{'reason','errorType','elapsedMs','errno','winerror'}
            or not isinstance(value.get('reason'),str)or value['reason']not in RPC_FAILURE_REASONS
            or not isinstance(value.get('errorType'),str)or value['errorType']not in RPC_ERROR_TYPES|{'OtherError'}):return None
    for key in('elapsedMs','errno','winerror'):
        if key in value and(type(value[key])is not int or not(-200000 if key!='elapsedMs'else 0)<=value[key]<=(200000 if key!='elapsedMs'else 900000)):return None
    return dict(value)


def rpc_failure_details(error):
    """Only fixed classes and numeric OS codes; never exception/request text."""
    name=type(error).__name__
    reason=('connect_timeout'if name in('ConnectTimeout','ConnectTimeoutError')else
            'read_timeout'if name in('ReadTimeout','ReadTimeoutError','RpcTimeoutException')else
            'timeout'if isinstance(error,TimeoutError)else
            'connection_closed'if name in('ConnectionResetError','ConnectionAbortedError','BrokenPipeError')else
            'transport_disconnected'if name=='TransportDisconnected'else
            'peer_verification_failed'if name in('PeerDenied','PeerUnavailable')else
            'connection_error'if name in('ConnectionError','URLError','HTTPError')else'unknown')
    value={'reason':reason,'errorType':name if name in RPC_ERROR_TYPES else'OtherError'}
    for key in('errno','winerror'):
        number=getattr(error,key,None)
        if type(number)is int and -200000<=number<=200000:value[key]=number
    return value


def bound_rpc_transport(client, seconds=3, *, on_error=None):
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 0 < seconds <= 10:
        raise ValueError('invalid_rpc_timeout')
    if on_error is not None and not callable(on_error):raise ValueError('invalid_rpc_observer')
    transport = client.transport
    if getattr(transport, '_wecom_bounded', False):
        raise ValueError('rpc_transport_already_bound')
    original_send = transport.send

    def send(request, timeout=None):
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError('invalid_rpc_timeout')
        try:
            return original_send(request, timeout=seconds if timeout is None else min(timeout, seconds))
        except Exception as error:
            if on_error is not None:
                try:on_error(error)
                except Exception:pass  # Evidence failure cannot replay or mask the original operation.
            raise RpcDeliveryUnknown('wecom_rpc_delivery_unknown_no_replay') from error

    transport.send = send
    transport._wecom_bounded = True
    return client
