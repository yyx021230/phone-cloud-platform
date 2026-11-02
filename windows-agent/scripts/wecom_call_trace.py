"""Private fixed-label call evidence. Never logs arguments, locals or UI."""
import contextlib
import json
import os
import re
import sys
import threading
import time

PREFIX = 'WECOM_CALL '
CALLS = frozenset(('adb.identity', 'adb.connect', 'adb.command', 'adb.shell',
    'adb.host', 'adb.receive', 'lease.read', 'foreground.read', 'poco.health',
    'rpc.import', 'rpc.client', 'rpc.agent', 'rpc.send', 'rpc.freeze',
    'hierarchy.snapshot', 'hierarchy.snapshot_any', 'ui.observed_click',
    'ui.startup_action', 'ui.return_back', 'ui.action', 'cleanup.reader', 'qa.host_identity',
    'qa.inventory', 'qa.proof_request', 'adb.socket_connect', 'rpc.transport')) | frozenset('ui.'+name for name in (
        'open_menu','open_add','open_search','enter_phone','search','open_preview',
        'open_remark','fill_remark','fill_description','save_remark','close_remark')) | frozenset('rpc.'+name for name in (
        'dump','dumpHierarchy','select','getAttr','setAttr','click','longClick','swipe','keyevent','getPortSize','setText','getScreen'))
ERRORS = frozenset(('SafeStop', 'StopPreview', 'TimeoutError', 'OSError',
    'ReadTimeout', 'ConnectTimeout', 'ConnectionError', 'RpcTimeoutException',
    'TransportDisconnected', 'RpcDeliveryUnknown', 'RuntimeError', 'ValueError', 'Exception', 'PermissionError','FileNotFoundError','JSONDecodeError','HTTPError','URLError','AccessDenied','NoSuchProcess','ConnectionResetError','ConnectionAbortedError'))


def rpc_label(request):
    label = 'rpc.send'
    if isinstance(request, dict) and isinstance(request.get('method'), (list, tuple)):
        for operation in request['method']:
            if (isinstance(operation, (list, tuple)) and len(operation) == 2
                    and operation[0] == 'getattr' and isinstance(operation[1], str)
                    and 'rpc.'+operation[1] in CALLS):
                label = 'rpc.'+operation[1]
    return label


class CallTrace:
    def __init__(self, stream=None, clock=time.monotonic, interval=5):
        self.stream, self.clock, self.interval = stream, clock, interval
        self.started = clock()
        self.main_ident = threading.main_thread().ident
        self.sequence = 0
        self.active = []
        self.recent = []
        self.samples = 0
        self.rows = 0
        self.error_rows = 0
        self.ui_rows = 0
        self.tail_flushed = False
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.worker = None

    def emit(self, value, essential=False):
        with self.lock:
            self.rows += 1
            is_error=value.get('kind')=='call'and value.get('state')=='error'
            if is_error:self.error_rows += 1
            if value.get('kind')=='call'and str(value.get('call','')).startswith('ui.')and value.get('call')!='ui.action':
                self.ui_rows+=1
                if self.ui_rows<=128:essential=True
            value = dict(version=1, elapsedMs=max(0, int((self.clock()-self.started)*1000)), **value)
            # Keep the actual latest records even after ordinary streaming caps.
            if value.get('kind')!='tail':self.recent = (self.recent + [value])[-64:]
            if is_error and self.error_rows>64:return
            if self.rows>4000 and not essential:return
        if self.stream is None: return
        line = PREFIX + json.dumps(value, separators=(',', ':')) + '\n'
        try:
            try: descriptor = self.stream.fileno()
            except (AttributeError, OSError, ValueError): descriptor = None
            if descriptor is None:
                self.stream.write(line); self.stream.flush()
            else:
                os.write(descriptor, line.encode('utf-8'))
        except (OSError, ValueError): pass

    @contextlib.contextmanager
    def call(self, label):
        if label not in CALLS: raise ValueError('invalid_call_label')
        with self.lock:
            self.sequence += 1; ident = self.sequence
            entry = {'id': ident, 'call': label, 'started': self.clock()}
            self.active.append(entry)
        self.emit({'kind': 'call', 'id': ident, 'call': label, 'state': 'begin'})
        try:
            yield
        except BaseException as error:
            name = type(error).__name__
            self.emit({'kind': 'call', 'id': ident, 'call': label, 'state': 'error',
                       'errorClass': name if name in ERRORS else 'other',
                       'durationMs': max(0, int((self.clock()-entry['started'])*1000))},essential=True)
            raise
        else:
            self.emit({'kind': 'call', 'id': ident, 'call': label, 'state': 'end',
                       'durationMs': max(0, int((self.clock()-entry['started'])*1000))})
        finally:
            with self.lock: self.active = [e for e in self.active if e['id'] != ident]

    def flush_tail(self):
        with self.lock:
            if self.tail_flushed:return
            self.tail_flushed=True
            tail=[dict(value)for value in self.recent[-64:]]
        for value in tail:
            self.emit({'kind':'tail','record':value},essential=True)

    def sample(self):
        with self.lock:
            active = [{k:e[k] for k in ('id', 'call')} for e in self.active[-12:]]
            if self.samples >= 48: return
            self.samples += 1
        frames = sys._current_frames(); threads = []
        for thread in threading.enumerate()[:8]:
            role = 'main' if thread.ident == self.main_ident else 'control' if thread.name == 'wecom-control' else 'diagnostic' if thread is self.worker else 'other'
            stack = []; frame = frames.get(thread.ident)
            while frame is not None and len(stack) < 12:
                module = str(frame.f_globals.get('__name__', ''))
                name = frame.f_code.co_name
                allowed = module.startswith(('wecom_', 'poco.', 'hrpc.', 'requests.', 'urllib3.', 'urllib.', 'importlib.', '_frozen_importlib')) or module in ('__main__', 'threading', 'socket', 'ssl', 'subprocess')
                if allowed and re.fullmatch(r'[A-Za-z0-9_.<>]{1,100}', name):
                    stack.append({'module': module[:100], 'function': name, 'line': frame.f_lineno})
                frame = frame.f_back
            threads.append({'role': role, 'daemon': thread.daemon, 'alive': thread.is_alive(), 'stack': stack})
        self.emit({'kind': 'stack', 'activeCalls': active, 'threads': threads}, essential=True)

    def start(self):
        if self.stream is None or self.worker is not None: return
        def watch():
            while not self.stop.wait(self.interval):
                self.sample()
                if self.clock()-self.started > 260: break
        self.worker = threading.Thread(target=watch, name='wecom-diagnostic', daemon=True)
        self.worker.start()

    def close(self):
        self.stop.set()
        if self.worker is not None and self.worker is not threading.current_thread():
            self.worker.join(timeout=1)
