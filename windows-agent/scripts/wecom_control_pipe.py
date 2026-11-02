"""One control reader without holding a Windows CRT read lock during SDK import."""
import os
import threading


def watch(receive, cancelled, wait=None, initial=b''):
    wait=cancelled.wait if wait is None else wait
    pending=initial
    try:
        while not cancelled.is_set():
            chunk=receive()
            if chunk is None:
                wait(.05)
                continue
            if not chunk:break
            pending+=chunk
            if b'cancel\n'in pending.replace(b'\r\n',b'\n') or len(pending)>1024:break
    except (OSError,ValueError):
        pass
    finally:cancelled.set()


def windows_receiver(fd):
    # Resolve the CRT descriptor once on the calling/main thread. The monitor
    # uses only the original pipe HANDLE and Win32 calls, never CRT _read().
    import ctypes
    import msvcrt
    from ctypes import wintypes
    handle=wintypes.HANDLE(msvcrt.get_osfhandle(fd))
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    peek=kernel.PeekNamedPipe
    peek.argtypes=[wintypes.HANDLE,wintypes.LPVOID,wintypes.DWORD,wintypes.LPVOID,ctypes.POINTER(wintypes.DWORD),wintypes.LPVOID]
    peek.restype=wintypes.BOOL
    read=kernel.ReadFile
    read.argtypes=[wintypes.HANDLE,wintypes.LPVOID,wintypes.DWORD,ctypes.POINTER(wintypes.DWORD),wintypes.LPVOID]
    read.restype=wintypes.BOOL
    def receive():
        available=wintypes.DWORD()
        if not peek(handle,None,0,None,ctypes.byref(available),None):
            if ctypes.get_last_error()in(6,109,232,233):return b''
            raise OSError('control_pipe_unavailable')
        if not available.value:return None
        size=min(64,available.value);buffer=ctypes.create_string_buffer(size);count=wintypes.DWORD()
        if not read(handle,buffer,size,ctypes.byref(count),None):raise OSError('control_pipe_read_failed')
        return buffer.raw[:count.value]
    return receive


def read_line(stream,maximum):
    # Byte-at-a-time only on the main thread: never let TextIOWrapper prefetch
    # a following cancel into a buffer invisible to the raw control HANDLE.
    try:fd=stream.fileno()
    except (AttributeError,OSError,ValueError):return stream.readline(maximum+1)
    value=bytearray()
    while len(value)<=maximum:
        chunk=os.read(fd,1)
        if not chunk:break
        value.extend(chunk)
        if chunk==b'\n':break
    return bytes(value).decode('utf-8')


def start(stream,cancelled):
    fd=stream.fileno();initial=b''
    if os.name=='nt':
        receive=windows_receiver(fd)
        # Already delivered cancellation is consumed BEFORE any phone work.
        try:
            while not cancelled.is_set():
                chunk=receive()
                if chunk is None:break
                if not chunk:cancelled.set();break
                initial+=chunk
                if b'cancel\n'in initial.replace(b'\r\n',b'\n')or len(initial)>1024:
                    cancelled.set();break
        except (OSError,ValueError):cancelled.set()
    else:receive=lambda:os.read(fd,64)
    worker=threading.Thread(target=watch,args=(receive,cancelled),kwargs={'initial':initial},name='wecom-control',daemon=True)
    worker.start();return worker
