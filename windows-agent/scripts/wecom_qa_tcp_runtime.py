"""Fresh Windows TCP ownership facts for isolated QA, with no network writes.

Only the LISTEN and IPv4 ESTABLISHED rows consumed by the QA guards are
returned. IPv6 listeners remain included in the unique ADB owner check.
No connection/PID facts are cached. The loaded System32 API pointer is reused.

https://learn.microsoft.com/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable
https://learn.microsoft.com/windows/win32/api/tcpmib/ns-tcpmib-mib_tcp6row_owner_pid
"""
import ctypes
import contextlib
import os
import socket
import struct
import threading
from collections import namedtuple

Endpoint=namedtuple('Endpoint','ip port')
Connection=namedtuple('Connection','status laddr raddr pid')
_function=None
_dll=None
_lock=threading.Lock()
MAX_BYTES=8*1024*1024
MAX_ROWS=100000


def api():
    global _function,_dll
    if os.name!='nt':raise RuntimeError('qa_tcp_windows_only')
    with _lock:
        if _function is None:
            _dll=ctypes.WinDLL('iphlpapi.dll',use_last_error=True,winmode=0x800)
            f=_dll.GetExtendedTcpTable
            f.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32),ctypes.c_int,
                        ctypes.c_uint32,ctypes.c_int,ctypes.c_uint32]
            f.restype=ctypes.c_uint32
            _function=f
    return _function


def fetch_table(family,table_class,call=None):
    if (family,table_class)not in((2,5),(23,3)):raise ValueError('qa_tcp_table_kind_invalid')
    call=api()if call is None else call
    capacity=262144;row_size=24 if family==2 else 56
    for _ in range(3):
        size=ctypes.c_uint32(capacity);buffer=ctypes.create_string_buffer(capacity)
        code=call(buffer,ctypes.byref(size),False,family,table_class,0)
        if code==122:
            if not capacity<size.value<=MAX_BYTES:raise ValueError('qa_tcp_table_size_invalid')
            capacity=size.value;continue
        if code!=0:raise OSError(code,'qa_tcp_table_read_failed')
        if size.value>capacity:raise ValueError('qa_tcp_table_size_invalid')
        count=struct.unpack_from('<I',buffer)[0]
        if count>MAX_ROWS or not 4<=4+count*row_size<=size.value<=capacity:raise ValueError('qa_tcp_table_size_invalid')
        return buffer.raw[:4+count*row_size]
    raise RuntimeError('qa_tcp_table_changed_too_often')


def parse_table(raw,family):
    if family not in(2,23)or not isinstance(raw,bytes)or len(raw)<4:
        raise ValueError('qa_tcp_table_invalid')
    count=struct.unpack_from('<I',raw)[0];width=24 if family==2 else 56
    if count>MAX_ROWS or 4+width*count!=len(raw):raise ValueError('qa_tcp_table_invalid')
    result=[]
    for i in range(count):
        if family==2:
            state,la,lp,ra,rp,pid=struct.unpack_from('<IIIIII',raw,4+24*i)
            if not 1<=state<=12:raise ValueError('qa_tcp_state_invalid')
            if state not in(2,5):continue
            local=Endpoint(socket.inet_ntoa(struct.pack('<I',la)),socket.ntohs(lp&65535))
            remote=Endpoint(socket.inet_ntoa(struct.pack('<I',ra)),socket.ntohs(rp&65535))if state==5 else ()
        else:
            la,scope,lp,ra,scope2,rp,state,pid=struct.unpack_from('<16sII16sIIII',raw,4+56*i)
            if state!=2:raise ValueError('qa_tcp_listener_state_invalid')
            local=Endpoint(socket.inet_ntop(socket.AF_INET6,la),socket.ntohs(lp&65535));remote=()
        result.append(Connection('LISTEN'if state==2 else'ESTABLISHED',local,remote,pid))
    return result


class WindowsTcpRuntime:
    backend='win_iphelper_fresh_v1'
    def __init__(self,*,process=None,read_table=fetch_table):
        if process is None:
            import psutil
            process=psutil.Process
        self.Process=process;self.read_table=read_table

    def net_connections(self,*,kind):
        if kind!='tcp':raise ValueError('qa_tcp_kind_invalid')
        # Both are fresh kernel queries, including on every later send check.
        return parse_table(self.read_table(2,5),2)+parse_table(self.read_table(23,3),23)


@contextlib.contextmanager
def identity_scope(host,authority):
    """Only this private child uses the same fresh facts for its identity read."""
    original=host.adb_identity
    @host.observed('adb.identity')
    def identity():
        authority.host_identity()  # Includes both births, SYSTEM, paths and both listener families.
        return authority.binding['adbPid']
    host.adb_identity=identity
    try:
        yield
    finally:
        if host.adb_identity is not identity:raise RuntimeError('qa_identity_hook_changed')
        host.adb_identity=original
