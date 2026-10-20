"""Bounded native-element access through an already installed Android service.

The service is never installed or upgraded here. Only its hierarchy RPC is used.
Every device command uses the caller's existing SDK ADB and explicit serial.
"""
import json
import re
import socket
import subprocess
import time
import urllib.request

PACKAGE = 'com.netease.open.pocoservice'
RUNNER = PACKAGE + '/androidx.test.runner.AndroidJUnitRunner'


class NativeElementError(RuntimeError):
    pass


def free_local_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def post_hierarchy_rpc(endpoint, request, session_id):
    match = re.fullmatch(r'http://127\.0\.0\.1:(\d{1,5})',endpoint)
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise NativeElementError('native RPC requires the owned local endpoint')
    method = json.dumps(request.get('method'))
    if (request.get('uri') != 'poco-uiautomation-framework' or 'dumpHierarchy' not in method
            or any(s in method.lower() for s in ('screen','input','setattr'))):
        raise NativeElementError('native RPC method is not hierarchy-only')
    payload = dict(request, session_id=session_id)
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type':'application/json'}, method='POST')
    with urllib.request.urlopen(req,timeout=3) as response:
        body = response.read(4*1024*1024+1)
    if len(body) > 4*1024*1024:
        raise NativeElementError('native hierarchy exceeded the response budget')
    value = json.loads(body)
    if not isinstance(value,dict) or value.get('id') != request.get('id'):
        raise NativeElementError('native RPC response identity is unproven')
    return value


def bounded_rpc_dump(endpoint):
    # Import only the RPC layer, without Airtest/device construction, APK
    # installation, input drivers, instrumentation watchdogs or screen APIs.
    from hrpc.client import RpcClient
    from hrpc.transport.http import HttpTransport

    class ElementTransport(HttpTransport):
        def send(self, request, timeout=None):
            self.rpc_client.put_response(post_hierarchy_rpc(self.endpoint,request,self.session_id))

    class Client(RpcClient):
        def initialize_transport(self):
            return ElementTransport(endpoint, self)

    client = Client()
    client.set_timeout(3)
    try:
        value = client.remote('poco-uiautomation-framework').dumper.dumpHierarchy()
        if not isinstance(value, dict):
            raise NativeElementError('native hierarchy did not return a node tree')
        return value
    finally:
        client.disconnect()


class ExistingNativeElementSession:
    def __init__(self, adb, serial, run, focus, guard, spawn=subprocess.Popen,
                 rpc_dump=bounded_rpc_dump, choose_port=free_local_port, sleep=time.sleep):
        self.adb, self.serial, self.run = adb, serial, run
        self.focus, self.guard, self.spawn = focus, guard, spawn
        self.rpc_dump, self.choose_port, self.sleep = rpc_dump, choose_port, sleep
        self.port = None
        self.process = None
        self.owned_pids = set()
        self.original = None

    def command(self, *args, allowed_missing=False):
        self.guard()
        result = self.run(self.adb, self.serial, *args, timeout=8)
        if result.returncode and not (allowed_missing and result.returncode == 1
                                      and not result.stdout.strip() and not result.stderr.strip()):
            raise NativeElementError('native element command failed: ' + str(args[:3]))
        return result.stdout.decode('utf-8', 'replace').strip()

    def pids(self):
        text = self.command('shell', 'pidof', PACKAGE, allowed_missing=True)
        if text and not re.fullmatch(r'\d+(?:\s+\d+)*', text):
            raise NativeElementError('native element process identity is unproven')
        return set(text.split())

    @staticmethod
    def activity(focus):
        match = re.search(r'\bu(\d+)\s+(com\.xingin\.xhs/[^}\s]+)', focus)
        return match.groups() if match else None

    def start(self):
        self.guard()
        self.original = self.activity(self.focus())
        if not self.original or self.original[0] not in ('0', '999', '128'):
            raise NativeElementError('native element reader requires the proven Xiaohongshu foreground')
        installed = self.command('shell', 'pm', 'list', 'packages', '--user', '0', PACKAGE).splitlines()
        if 'package:' + PACKAGE not in installed:
            raise NativeElementError('existing native element service is not installed; manual setup required')
        runners = self.command('shell', 'pm', 'list', 'instrumentation').splitlines()
        if sum(line == 'instrumentation:' + RUNNER + ' (target=' + PACKAGE + ')' for line in runners) != 1:
            raise NativeElementError('existing native element instrumentation is not uniquely proven')
        if self.pids():
            raise NativeElementError('another native element service is already active')
        port = self.choose_port()
        if type(port) is not int or not 1024 <= port <= 65535:
            raise NativeElementError('native local endpoint is invalid')
        self.command('forward', '--no-rebind', 'tcp:'+str(port), 'tcp:10081')
        self.port = port
        try:
            self.command('shell', 'am', 'start', '--user', '0', '-n', PACKAGE+'/.TestActivity')
        finally:
            self.owned_pids = self.pids()
        # Prove the current ADB transport immediately before starting the
        # single, owned instrumentation child. Never use a framework launcher.
        if self.command('get-state') != 'device':
            raise NativeElementError('native ADB transport is unavailable')
        self.guard()
        self.process = self.spawn([self.adb, '-s', self.serial, 'shell', 'am', 'instrument', '-w',
                                   '-e', 'debug', 'false', '-e', 'class', PACKAGE+'.InstrumentedTestAsLauncher', RUNNER],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(6):
            self.guard()
            if self.process.poll() is not None:
                raise NativeElementError('owned native instrumentation stopped during startup')
            pids = self.pids()
            if pids:
                self.owned_pids = pids
                current = self.focus()
                if PACKAGE+'/.TestActivity' in current:
                    self.command('shell', 'input', 'keyevent', '4')
                    self.sleep(.4)
                    current = self.focus()
                if self.activity(current) == self.original:
                    try:
                        value = self.dump()
                        return value
                    except (OSError, ValueError):
                        pass
            self.sleep(.5)
        raise NativeElementError('existing native element service did not become ready')

    def dump(self):
        self.guard()
        if not self.process or self.process.poll() is not None or self.pids() != self.owned_pids:
            raise NativeElementError('owned native element process changed')
        if self.activity(self.focus()) != self.original:
            raise NativeElementError('native element foreground changed')
        value = self.rpc_dump('http://127.0.0.1:'+str(self.port))
        self.guard()
        if self.activity(self.focus()) != self.original:
            raise NativeElementError('native element foreground changed during read')
        return value

    def close(self):
        errors = []
        try:
            if self.owned_pids:
                current = self.pids()
                if current == self.owned_pids:
                    self.command('shell', 'am', 'force-stop', '--user', '0', PACKAGE)
                    if self.pids():
                        errors.append('native element service did not stop')
                elif current:
                    errors.append('native element process changed; foreign process preserved')
        except Exception:
            errors.append('native element process cleanup unproven')
        if self.process is not None:
            try:
                if self.process.poll() is None:
                    self.process.terminate()
                    self.process.wait(timeout=2)
            except Exception:
                errors.append('owned native instrumentation child cleanup unproven')
        if self.port is not None:
            try:
                expected = (self.serial, 'tcp:'+str(self.port), 'tcp:10081')
                matches = [tuple(line.split()) for line in self.command('forward', '--list').splitlines()
                           if len(line.split()) == 3 and line.split()[1] == 'tcp:'+str(self.port)]
                if matches == [expected]:
                    self.command('forward', '--remove', 'tcp:'+str(self.port))
                elif matches:
                    errors.append('native forward changed; foreign mapping preserved')
            except Exception:
                errors.append('owned native forward cleanup unproven')
        if errors:
            raise NativeElementError('; '.join(errors))
