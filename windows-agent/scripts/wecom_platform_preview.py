"""One-shot leased WeCom adapter. Credentials arrive on stdin only.

Uses the fixed, already-running SYSTEM ADB socket, never starts a server,
installs packages, switches accounts or guesses coordinates. Sending requires
an explicit mode and both local and cloud one-use claims.
"""
import contextlib
import datetime
import os
import threading
import io
import json
import hashlib
import re
import socket
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path
import wecom_invite_preview as w
import wecom_remark_preview as remarks
import wecom_startup_guards as startup
import wecom_customer_invitation as invitation
from wecom_rpc_budget import bound_rpc_transport
from wecom_diagnostics import ExecutionTrace
from functools import wraps
from wecom_cleanup import cleanup_reader, TEST as POCO_TEST, pid_command, parse_pids
from wecom_call_trace import CallTrace, rpc_label
import wecom_control_pipe as control_pipe

class SafeStop(w.StopPreview): pass

CANCELLED = threading.Event()
cleaning_up = False
trace = ExecutionTrace(clock=lambda: time.monotonic())
calls = CallTrace()
external_authority = None
resource_state = {}
primary_failure = None
physical_bootstrap_hosts = None
physical_bootstrap_runtime = None
physical_bootstrap_causal = None
causal_business_budget = None


def record_resources():
    calls.emit({'kind':'resources', 'resources':dict(resource_state)}, essential=True)


def observed(label):
    def decorate(fn):
        @wraps(fn)
        def invoke(*args, **kwargs):
            with calls.call(label):
                return fn(*args, **kwargs)
        return invoke
    return decorate

def phase(name, seconds=None, timeout_code="preview_phase_timeout"):
    def decorate(fn):
        @wraps(fn)
        def observed(*args, **kwargs):
            with trace.phase(name, seconds, timeout_code):
                return fn(*args, **kwargs)
        return observed
    return decorate

DEVICES = json.loads(Path(__file__).with_name("wecom_preview_devices.json").read_text())

def validate_config(value):
    allowed = {"taskId", "deviceId", "serial", "deviceNumber", "androidUser", "phoneNumber",
               "previewOnly", "agentId", "serverBaseUrl", "agentToken"}
    if not isinstance(value, dict) or not allowed <= set(value) or set(value) - allowed - {"appSlot", "remarkName", "description", "mode", "claimDirectory", "physicalCleanup", "causalLease", "requireRemarkPhone"}:
        raise SafeStop("invalid_preview_config")
    if 'requireRemarkPhone' in value and type(value['requireRemarkPhone']) is not bool:
        raise SafeStop('invalid_wecom_remark_phone_requirement')
    mode = value.get("mode", "preview")
    if mode not in ("preview", "send") or value.get("previewOnly") is not (mode != "send"):
        raise SafeStop("invalid_preview_config")
    if mode == "send" and (not isinstance(value.get("claimDirectory"), str) or not value['claimDirectory']):
        raise SafeStop("missing_invitation_claim_directory")
    entry = DEVICES.get(value.get("deviceNumber"))
    slot = value.get("appSlot", entry["defaultAppSlot"] if entry else None)
    if (not entry or not isinstance(slot, str) or slot not in entry["appSlots"]
        or type(value.get("androidUser")) is not int or value["androidUser"] != entry["appSlots"][slot]
        or value.get("serial") != entry["serial"] or value.get("deviceId") != "adb:" + entry["serial"]):
        raise SafeStop("device_not_authorized")
    for key in ("taskId", "agentId"):
        if not isinstance(value.get(key), str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", value[key]):
            raise SafeStop("invalid_task_identity")
    w.validate_request({"phoneNumber": value.get("phoneNumber")})
    url = urllib.parse.urlsplit(value["serverBaseUrl"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise SafeStop("invalid_platform_origin")
    if not isinstance(value["agentToken"], str) or not value["agentToken"]:
        raise SafeStop("missing_agent_credential")
    if 'physicalCleanup'in value:
        from wecom_cleanup_contract import validate_binding
        if physical_bootstrap_hosts is None or physical_bootstrap_runtime is None:raise SafeStop('wecom_cleanup_bootstrap_missing')
        validate_binding(value['physicalCleanup'],value,original=True)
        ticket=value.get('causalLease')
        if not isinstance(ticket,dict)or set(ticket)!={'protocol','epoch','leaseId','purpose'}or ticket.get('protocol')!='wecom-causal-v1'or ticket.get('purpose')!='business'or physical_bootstrap_causal is None or physical_bootstrap_causal['bindingNonce']!=value['physicalCleanup']['nonce']:
            raise SafeStop('wecom_cleanup_causal_context_unconfirmed')
    elif physical_bootstrap_hosts is not None or 'causalLease' in value:raise SafeStop('wecom_cleanup_binding_mismatch')
    name, description = remarks.validate_remark_input(value)
    return dict(value, mode=mode, remarkName=name, description=description)


def remark_fingerprint(value):
    values=list(remarks.validate_remark_input(value))
    if value.get('requireRemarkPhone') is True:values.append('remark-phone-verified-v1')
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


class PreviewRemarkEntryDriver(invitation.InvitationDriverMixin, remarks.PocoRemarkDriver):
    def __init__(self, poco, foreground, lease_valid, wake_if_needed=lambda: None):
        super().__init__(poco, foreground, lease_valid)
        self.wake_if_needed=wake_if_needed

    @observed('hierarchy.snapshot')
    def snapshot(self):
        self.wake_if_needed()
        return super().snapshot()

    @observed('ui.action')
    def apply(self, action, expected_screen, phone, check_budget=lambda: None, context=None):
        with calls.call('ui.' + action):
            name = "remark_save" if action == "save_remark" else "remark_edit" if action in remarks.REMARK_ACTIONS else "recipient_search"
            with trace.phase(name):
                return self._apply(action, expected_screen, phone, check_budget, context)

    def _apply(self, action, expected_screen, phone, check_budget, context):
        if action not in ("open_remark", "open_menu"):
            return super().apply(action, expected_screen, phone, check_budget, context=context)
        for attempt in range(3):
            try:
                return super().apply(action, expected_screen, phone, check_budget, context=context)
            except w.StopPreview as error:
                # Both fixed codes are raised BEFORE the click in the audited
                # parent adapter. Never retry transport errors, input or save.
                if str(error) not in ("page_changed_before_action", "element_changed_before_action") or attempt == 2:
                    raise
                check_budget()
                expected_screen=self.snapshot()
                if action == "open_remark":remarks.resolve_remark(action, expected_screen, phone, context)
                else:w.resolve_action(action, expected_screen, phone)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

def budget():
    if CANCELLED.is_set() and not cleaning_up: raise SafeStop("preview_cancelled_no_replay")
    limit, code = trace.limit(deadline)
    if time.monotonic() >= limit: raise SafeStop(code)

def io_timeout(maximum):
    budget()
    limit, _ = trace.limit(deadline)
    return max(.001, min(maximum, limit-time.monotonic()))

@observed('lease.read')
def lease_valid():
    valid=False
    try:
        budget()
        if config.get('physicalCleanup')is not None:
            if physical_bootstrap_runtime is None or physical_bootstrap_runtime.check()is not True:return False
        if external_authority is not None:
            return external_authority.check(config)
        if causal_business_budget is None:return False
        url = config["serverBaseUrl"].rstrip("/") + "/api/v1/windows-agents/" + config["agentId"] + "/wecom-preview-tasks/" + config["taskId"] + "/lease"
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + config["agentToken"]})
        started=causal_business_budget.sample()
        with urllib.request.build_opener(NoRedirect).open(req, timeout=io_timeout(8)) as response:
            raw = response.read(8193)
        budget()
        if len(raw)>8192: return False
        proof = json.loads(raw)
        valid=(proof.get("valid") is True and proof.get("taskId") == config["taskId"]
            and proof.get("deviceId") == config["deviceId"] and proof.get("serial") == SERIAL
            and proof.get("deviceNumber") == config["deviceNumber"] and proof.get("androidUser") == selected_user
            and ("appSlot" not in config or proof.get("appSlot") == config["appSlot"])
            and proof.get("remarkFingerprint") == remark_fingerprint(config)
            and (config.get("mode", "preview") != "send" or (proof.get("mode") == "send" and proof.get("operationFingerprint") == operation_fingerprint(config)))
            and causal_business_budget.consume(proof,started))
        return valid
    except Exception: return False
    finally:
        if external_authority is None and causal_business_budget is not None and not valid:
            causal_business_budget.revoked=True

def operation_fingerprint(value):
    return hashlib.sha256(json.dumps([value.get('mode', 'preview'), remark_fingerprint(value), value['phoneNumber'], value['deviceId'], value['androidUser']], separators=(',', ':')).encode('utf8')).hexdigest()


@phase("send_claim")
def claim_invitation():
    budget()
    if not lease_valid(): raise SafeStop('device_lease_lost')
    invitation.claim_local(config['claimDirectory'], config)
    url = config['serverBaseUrl'].rstrip('/') + '/api/v1/windows-agents/' + config['agentId'] + '/wecom-preview-tasks/' + config['taskId'] + '/send-claim'
    req = urllib.request.Request(url, data=b'{}', method='POST', headers={'Authorization': 'Bearer ' + config['agentToken'], 'Content-Type': 'application/json'})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=io_timeout(8)) as response:
        raw = response.read(8193)
    budget()
    if len(raw) > 8192: return False
    proof = json.loads(raw)
    return proof.get('claimed') is True and proof.get('taskId') == config['taskId'] and proof.get('operationFingerprint') == operation_fingerprint(config)


def mutate(cmd):
    budget()
    if not lease_valid(): raise SafeStop("device_lease_lost")
    return shell(cmd)


@observed('adb.identity')
def adb_identity():
 import psutil
 ids={c.pid for c in psutil.net_connections(kind='tcp') if c.status=='LISTEN' and c.laddr.port==5037}
 if len(ids)!=1:raise SafeStop('adb_listener_unconfirmed')
 p=psutil.Process(next(iter(ids)))
 if p.username()!=r'NT AUTHORITY\SYSTEM' or Path(p.exe())!=Path(r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe'):raise SafeStop('adb_identity_unconfirmed')
 return p.pid

def exact(s,n):
 b=b''
 while len(b)<n:
  v=receive(s,n-len(b))
  if not v:raise SafeStop('adb_closed')
  b+=v
 return b

@observed('adb.command')
def command(s,cmd):
 if external_authority is not None and not lease_valid():raise SafeStop('device_lease_lost')
 b=cmd.encode();s.settimeout(io_timeout(6))
 try:s.sendall(('%04x'%len(b)).encode()+b)
 except socket.timeout:
  budget();raise SafeStop('adb_io_timeout')
 if exact(s,4)!=b'OKAY':raise SafeStop('adb_rejected')

@observed('adb.connect')
def connection():
 budget()
 if external_authority is not None and not lease_valid():raise SafeStop('device_lease_lost')
 if adb_identity()!=initial_adb:raise SafeStop('adb_process_changed')
 try:
  with calls.call('adb.socket_connect'):s=socket.create_connection(('127.0.0.1',5037),io_timeout(2))
 except socket.timeout:
  budget();raise SafeStop('adb_io_timeout')
 try:s.settimeout(io_timeout(6));return s
 except Exception:s.close();raise

@observed('adb.receive')
def receive(s, size):
 s.settimeout(io_timeout(6))
 try:
  value=s.recv(size)
 except socket.timeout:
  budget()
  raise SafeStop('adb_io_timeout')
 budget()
 return value

@observed('adb.shell')
def shell(cmd,keep=False):
 s=connection()
 out=b''
 try:
  command(s,'host:transport:'+SERIAL);command(s,'shell:'+cmd)
  if keep:return s
  while True:
   part=receive(s,65536)
   if not part:break
   out+=part
   if len(out)>2*1024*1024:raise SafeStop('adb_response_too_large')
 finally:
  if not keep or sys.exc_info()[0] is not None:s.close()
 return out.decode('utf-8','replace')

@observed('adb.host')
def host(cmd):
 s=connection()
 try:
  command(s,cmd);length=exact(s,4)
  if length==b'OKAY':length=exact(s,4)
  return exact(s,int(length,16)).decode()
 finally:s.close()

@observed('foreground.read')
def foreground_info():
 raw=shell('dumpsys activity activities')
 observe_startup_state('foreground',raw)
 for line in raw.splitlines():
  if 'ResumedActivity' in line or re.search(r'\bResumed:',line):
   match=re.search(r'\bu(\d+)\s+(com\.[A-Za-z0-9_.]+)/([A-Za-z0-9_.$]+)',line)
   if match:return match.group(2),int(match.group(1)),match.group(2)+'/'+match.group(3)
 return '',-1,''

def foreground():
 package,user,_=foreground_info()
 return package if user==selected_user else ''

@observed('poco.health')
def health(port):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d/uiautomation/connectionState'%port,timeout=io_timeout(2)) as response:return json.load(response).get('connected') is True
 except:return False

@observed('hierarchy.snapshot_any')
def any_snapshot(poco):
 package,_,_=foreground_info()
 with calls.call('rpc.freeze'):frozen=poco.freeze()
 nodes=[]
 for kind in w.NODE_TYPES+("android.widget.RadioButton","android.widget.CheckBox"):
  query=frozen(type=kind)
  if len(query)==0:continue
  for item in list(query):
   if item.attr("visible") is not True:continue
   n=w.Node(kind=kind,text=item.attr("text") or "",name=item.attr("name") or "",desc=item.attr("contentDescription") or "",enabled=item.attr("enabled") is True,position=tuple(item.get_position()),size=tuple(item.get_size()))
   if not w.is_system_status_indicator(n) and n not in nodes:nodes.append(n)
 if len(nodes)>600:raise SafeStop("hierarchy_too_large")
 return w.Screen(package,tuple(nodes))

@observed('ui.observed_click')
def observed_click(poco,screen,node,allowed_package):
 if not lease_valid():raise SafeStop("device_lease_lost")
 if foreground_info()[0]!=allowed_package:raise SafeStop("foreground_changed")
 if any_snapshot(poco)!=screen:raise SafeStop("page_changed_before_observed_click")
 selector={"type":node.kind,"text":node.text} if node.text else {"type":node.kind,"name":node.name}
 query=poco(**selector)
 if len(query)==0:raise SafeStop("missing_observed_element")
 item=w.unique(list(query))
 if (item.attr("visible") is not True or item.attr("enabled") is not True or (item.attr("text") or "")!=node.text or (item.attr("contentDescription") or "")!=node.desc or (item.attr("name") or "")!=node.name or tuple(item.get_position())!=node.position or tuple(item.get_size())!=node.size):raise SafeStop("observed_element_changed")
 if not lease_valid():raise SafeStop("device_lease_lost")
 item.click()

@observed('ui.startup_action')
def startup_click(poco,package,context,selector):
 # Re-observe only when validation failed BEFORE the click was issued.
 for attempt in range(3):
  page=any_snapshot(poco)
  if page.package!=package or not context(page):raise SafeStop("startup_context_changed")
  node=w.unique(page.matching(selector))
  try:
   observed_click(poco,page,node,package);return
  except SafeStop as error:
   if str(error) not in ("page_changed_before_observed_click","observed_element_changed") or attempt==2:raise
   time.sleep(.3)



@phase("selector_observe")
def resolve_observed_wecom_slot(poco):
    package,_,activity=foreground_info()
    if package!="com.android.intentresolver" or not activity.endswith("/.DoubleAppResolverActivity"):
        return False
    def slot(node):
        label=re.sub(r"\s","",node.text)
        return label=="企业微信" if selected_user==0 else re.fullmatch(r"(?:Ⅱ|II)[·.]?企业微信",label) is not None
    with trace.phase("selector_click"):
        startup_click(poco,package,lambda page:any("选择要使用的应用" in n.text for n in page.nodes),slot)
    return True


def wait_for_wecom_foreground(poco, seconds=35):
    with trace.phase("foreground_wait", seconds, "wecom_launch_not_ready"):
        return _wait_for_wecom_foreground(poco, seconds)

def _wait_for_wecom_foreground(poco, seconds):
    until=min(deadline,time.monotonic()+seconds)
    chosen=False
    while foreground()!=w.PACKAGE and time.monotonic()<until:
        budget()
        if not chosen: chosen=resolve_observed_wecom_slot(poco)
        time.sleep(.25)
    if foreground()!=w.PACKAGE: raise SafeStop("wecom_launch_not_ready")

def observe_startup_state(kind, raw):
    # Only the typed isolated authority can save fixed states from an existing
    # read. No extra phone queries, raw dumps, or public API fields.
    if external_authority is not None:
        try:external_authority.observe_startup(kind,raw,selected_user)
        except Exception:pass
    return raw

@phase("screen_prepare", 20, "screen_prepare_timeout")
def prepare_screen_before_poco():
    # Only a positively observed sleeping display moves the existing normal
    # wake before instrumentation. No key/PIN/settings or unknown-page clicks.
    if not re.search(r'mWakefulness=(?:Asleep|Dozing)\b', observe_startup_state('power_before',shell('dumpsys power'))):
        return False
    observe_startup_state('wake_response',mutate('input keyevent 224'))
    if config['deviceNumber'] != '25':
        observe_startup_state('dismiss_response',mutate('wm dismiss-keyguard'))
    if config['deviceNumber'] == '25' and startup.keyguard_state(
            observe_startup_state('keyguard',shell('dumpsys window policy')),selected_user) not in ('nonsecure_clear','nonsecure_showing'):
        raise SafeStop('device_unlock_requires_user')
    try:
        startup.confirm_awake(lambda:observe_startup_state('power_after',shell('dumpsys power')),
            lease_valid,check_budget=budget)
    except w.StopPreview as error:
        if str(error) != 'screen_wake_not_confirmed' or config['deviceNumber'] != '25':raise
        startup.wake_observed_25_once(config['deviceNumber'],selected_user,
            lambda:observe_startup_state('power_after',shell('dumpsys power')),
            lambda:observe_startup_state('keyguard',shell('dumpsys window policy')),lease_valid,
            lambda:observe_startup_state('power_fallback_response',mutate('input keyevent 26')),check_budget=budget)
    if config['deviceNumber'] == '25':
        observe_startup_state('dismiss_response',mutate('wm dismiss-keyguard'))
        startup.dismiss_nonsecure_keyguard(lambda:observe_startup_state('keyguard',shell('dumpsys window policy')), lease_valid,
            lambda:mutate('input keyevent 82'), android_user=selected_user, check_budget=budget)
    return True


def process_start_token(stat):
    # Linux comm may contain spaces/parentheses; starttime is field 22.
    rest = stat.rsplit(") ", 1)
    fields = rest[1].split() if len(rest) == 2 else []
    return fields[19] if len(fields) > 19 and fields[19].isdigit() else ""


def reader_pids(package):
    try:
        return parse_pids(shell(pid_command(package)))
    except ValueError:
        raise SafeStop('poco_pid_unconfirmed')


def reader_forwards():
    rows = []
    for line in host('host:list-forward').splitlines():
        fields = line.split()
        if len(fields) != 3:
            raise SafeStop('poco_forward_unconfirmed')
        rows.append(tuple(fields))
    return rows


def remove_reader_forward(port):
    connection_socket = connection()
    try: command(connection_socket, 'host-serial:' + SERIAL + ':killforward:tcp:' + str(port))
    finally: connection_socket.close()


def run_host(value, diagnostic_stream=None, *, authority=None):
    global config, SERIAL, selected_user, initial_adb, deadline, cleaning_up, trace, external_authority, resource_state, primary_failure, causal_business_budget
    cleaning_up = False
    primary_failure = None
    external_authority = None
    causal_business_budget = None
    resource_state = {'readerStarted':False, 'pid':'', 'startToken':'', 'forwards':[], 'cleanupConfirmed':None}
    trace = ExecutionTrace(diagnostic_stream, clock=lambda: time.monotonic())
    with trace.phase("configuration"):
        config = validate_config(value)
        if config.get('physicalCleanup')is not None:
            from wecom_cleanup_contract import CausalLeaseBudget
            causal_business_budget=CausalLeaseBudget(config.get('causalLease'))
        if authority is not None:
            from wecom_screen_lease import ScreenAuthority
            if type(authority) is not ScreenAuthority or config['mode'] != 'preview' or authority.binding['purpose'] != 'preview':
                raise SafeStop('qa_preview_authority_invalid')
            authority.observe = calls.call
            external_authority = authority
    SERIAL = config["serial"]; selected_user = config["androidUser"]
    deadline = time.monotonic() + 210
    ports = []; instrument = None; owned_pid = ""; owned_start = ""; result = {}; reader_started = False
    with trace.phase("adb_identity"):
        initial_adb = adb_identity()
    try:
        with trace.phase("device_preflight"):
            if not lease_valid(): raise SafeStop("device_lease_lost")
            if "package:" not in shell("pm list packages --user %d com.tencent.wework" % selected_user):
                raise SafeStop("requested_app_slot_missing")
            if "package:" not in shell("pm path com.netease.open.pocoservice"):
                raise SafeStop("existing_poco_missing")
            if reader_pids('com.netease.open.pocoservice') or reader_pids(POCO_TEST):
                raise SafeStop("poco_already_running")
            # Every run starts the exclusively leased account slot from scratch.
            # Stop only that Android user BEFORE Poco is
            # created; restarting it after RPC setup can invalidate that reader.
            response=mutate("am force-stop --user %d com.tencent.wework"%selected_user)
            if any(marker in response for marker in ("Error","Exception","Permission Denial")):
                raise SafeStop("wecom_restart_rejected")
        screen_prepared = prepare_screen_before_poco()
        with trace.phase("poco_launch"):
            for remote_port in (10080, 10081):
                if not lease_valid(): raise SafeStop("device_lease_lost")
                ports.append(int(host("host-serial:"+SERIAL+":forward:tcp:0;tcp:"+str(remote_port))))
                resource_state['forwards'] = list(zip(ports,(10080,10081)))
                record_resources()
            reader_started = True  # Set BEFORE delivery; a failed ACK can still have started it.
            resource_state['readerStarted'] = True
            record_resources()
            response = mutate("am start -n com.netease.open.pocoservice/.TestActivity")
            if any(marker in response for marker in ("Error", "Exception", "Permission Denial")):
                raise SafeStop("poco_start_rejected")
            # Establish ownership before instrumentation health checks can fail.
            owned_pid = shell("pidof com.netease.open.pocoservice").strip()
            pid_until = min(deadline, time.monotonic()+3)
            while not owned_pid and time.monotonic() < pid_until:
                budget(); time.sleep(.2)
                owned_pid = shell("pidof com.netease.open.pocoservice").strip()
            if not re.fullmatch(r"\d+", owned_pid): raise SafeStop("poco_owner_unconfirmed")
            owned_start = process_start_token(shell("cat /proc/"+owned_pid+"/stat"))
            resource_state.update(pid=owned_pid,startToken=owned_start)
            record_resources()
            if not owned_start: raise SafeStop("poco_owner_unconfirmed")
            if not lease_valid(): raise SafeStop("device_lease_lost")
            instrument = shell("am instrument -w -e debug false -e class com.netease.open.pocoservice.InstrumentedTestAsLauncher com.netease.open.pocoservice/androidx.test.runner.AndroidJUnitRunner", keep=True)
        with trace.phase("poco_health"):
            until = min(deadline, time.monotonic()+12)
            while time.monotonic()<until and not health(ports[0]): time.sleep(.3)
            # Android instrumentation may replace the Activity's process. Bind the
            # new instance only while our exclusive lease still holds, before a
            # failed health check exits. Instance tokens protect cleanup identity;
            # they are not interpreted as application launch chronology.
            current_pid = shell("pidof com.netease.open.pocoservice").strip()
            if current_pid != owned_pid:
                if not re.fullmatch(r"\d+", current_pid) or not lease_valid():
                    raise SafeStop("poco_owner_changed")
                current_start = process_start_token(shell("cat /proc/"+current_pid+"/stat"))
                if not current_start:
                    raise SafeStop("poco_owner_changed")
                owned_pid, owned_start = current_pid, current_start
                resource_state.update(pid=owned_pid,startToken=owned_start)
                record_resources()
            if not health(ports[0]): raise SafeStop("poco_not_ready")
        with trace.phase("wecom_launch"):
            activities = shell("cmd package resolve-activity --brief --user %d com.tencent.wework"%selected_user).splitlines()
            launch = activities[-1].strip() if activities else ""
            if not re.fullmatch(r"com\.tencent\.wework/[A-Za-z0-9_.$]+",launch): raise SafeStop("wecom_activity_unconfirmed")
            if not screen_prepared:
                mutate("input keyevent 224"); mutate("wm dismiss-keyguard")
            if config["deviceNumber"] == "25" and not screen_prepared:
                startup.dismiss_nonsecure_keyguard(lambda:shell("dumpsys window policy"), lease_valid,
                    lambda:mutate("input keyevent 82"), android_user=selected_user, check_budget=budget)
            response=mutate("am start --user %d -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "%selected_user+launch)
            if "Error" in response: raise SafeStop("wecom_launch_rejected")
        with trace.phase("rpc_setup"):
            with calls.call('rpc.import'):
                import poco.drivers.android.uiautomation as u
            with calls.call('rpc.client'):
                def rpc_failed(error):
                    trace.record_rpc_failure(error)
                    observer=getattr(external_authority,'observe_rpc_failure',None)
                    if observer is not None:observer(dict(trace.transport_failure),dict(resource_state))
                client=u.AndroidRpcClient("http://127.0.0.1:"+str(ports[1])); client.set_timeout(3); bound_rpc_transport(client,6,on_error=rpc_failed)
            send=client.transport.send
            def bounded_send(request,timeout=None):
                with calls.call(rpc_label(request)):
                    budget()
                    if external_authority is not None:
                        if not lease_valid(): raise SafeStop('device_lease_lost')
                        if adb_identity() != initial_adb: raise SafeStop('adb_process_changed')
                    with calls.call('rpc.transport'):
                        response = send(request,timeout=io_timeout(6 if timeout is None else timeout))
                    budget()
                    return response
            client.transport.send=bounded_send
            with calls.call('rpc.agent'):
                remote=client.remote("poco-uiautomation-framework")
                agent=u.PocoAgent(u.RemotePocoHierarchy(remote.dumper,remote.selector,remote.attributor),remote.inputer,u.ScreenWrapper(remote.screen),None)
                poco=u.Poco(agent,**w.PREVIEW_POCO_OPTIONS)
        with trace.phase("startup_guards"):
            proximity_dismissals=0
            if config["deviceNumber"] == "25":
                if startup.dismiss_miui_proximity(lambda:any_snapshot(poco),foreground,lease_valid,
                    lambda:shell("dumpsys window policy"),lambda:mutate("input keyevent 24"),android_user=selected_user,check_budget=budget):
                    proximity_dismissals+=1
            package,user,activity=foreground_info()
            if package=="com.android.settings" and activity.endswith("/.Settings$UsbDetailsActivity"):
                startup_click(poco,package,lambda page:all(page.has(v) for v in ("取消","仅限充电","传输文件","传输照片")),lambda n:n.labeled("取消"))
                mutate("am start --user %d -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "%selected_user+launch)
                package,user,activity=foreground_info()
            wake_guard=startup.ScreenWakeGuard(lambda:shell("dumpsys power"),lease_valid,
                lambda:mutate("input keyevent 224"),lambda:mutate("wm dismiss-keyguard"),check_budget=budget)
            driver=PreviewRemarkEntryDriver(poco,foreground,lease_valid,wake_guard.ensure_awake)
            if authority is not None:driver.before_action_difference=authority.observe_difference
        wait_for_wecom_foreground(poco)
        with trace.phase("home_navigation", 60, "home_navigation_timeout"):
            until=min(deadline,time.monotonic()+60); home=False; update_dismissed=False; blank_frames=0; home_steps=0
            while home_steps < 20:
                budget()
                if time.monotonic()>=until: raise SafeStop("home_navigation_timeout")
                page=driver.snapshot(); w.guard(page)
                if authority is not None:authority.observe_page('home',page)
                observed=any_snapshot(poco)
                if config['deviceNumber'] == '25' and selected_user == 0 and startup.is_observed_25_loading(config['deviceNumber'],selected_user,foreground_info(),page):
                    time.sleep(.3);continue
                home_steps += 1
                if config["deviceNumber"] == "25" and startup.is_miui_proximity_overlay(observed):
                    if proximity_dismissals>=2: raise SafeStop("system_overlay_reappeared")
                    if startup.dismiss_miui_proximity(lambda:any_snapshot(poco),foreground,lease_valid,
                        lambda:shell("dumpsys window policy"),lambda:mutate("input keyevent 24"),
                        android_user=selected_user,check_budget=budget): proximity_dismissals+=1
                    continue
                if observed.package==w.PACKAGE and all(observed.has(v) for v in ("发现新版本","立即更新","取消")):
                    if update_dismissed: raise SafeStop("update_dialog_reappeared")
                    startup_click(poco,w.PACKAGE,lambda current:all(current.has(v) for v in ("发现新版本","立即更新","取消")),lambda n:n.kind in ("android.widget.Button","android.widget.TextView") and n.text=="取消")
                    update_dismissed=True; continue
                if w.is_home(page) and not w.is_menu(page):
                    second=driver.snapshot();w.guard(second)
                    if w.is_home(second) and not w.is_menu(second):home=True;break
                    continue
                def return_back():
                    with calls.call('ui.return_back'):mutate('input keyevent 4')
                if w.return_from_customer_detail(page,snapshot=driver.snapshot,foreground=foreground,
                        back=return_back,check_budget=budget):
                    time.sleep(.3);continue
                test_search=False
                try:test_search=w.editor(page).text in ("","手机号",config["phoneNumber"])
                except w.StopPreview:pass
                global_search=(foreground_info()[2].endswith("/.contact.controller.globalsearch.GlobalSearchActivityV2") and len(page.matching(lambda n:n.kind=="android.widget.EditText" and n.name=="com.tencent.wework:id/lnx"))==1)
                invitation_return=startup.is_observed_25_invite_foreground(config["deviceNumber"],selected_user,foreground_info())
                known=(invitation_return or page.has(w.SEND) or w.profile_matches(page,config["phoneNumber"]) or w.is_add_page(page) or w.is_menu(page) or test_search or global_search)
                if not known:
                    if authority is not None:
                        authority.observe_page('unknown_home',page)
                        blank_frames=blank_frames+1 if len(page.nodes)<=3 else 0
                        if blank_frames>=2 and authority.observe_blank_screen(lambda:poco.snapshot(width=360)):
                            raise SafeStop('qa_empty_page_captured')
                    # A blank startup frame may settle; no writes on unknown pages.
                    time.sleep(.3); continue
                if driver.snapshot()!=page or foreground()!=w.PACKAGE: raise SafeStop("home_navigation_page_changed")
                if invitation_return and not startup.is_observed_25_invite_foreground(config["deviceNumber"],selected_user,foreground_info()):
                    raise SafeStop("initial_invite_activity_changed")
                with calls.call('ui.return_back'):mutate("input keyevent 4")
                time.sleep(.3)
            if not home:raise SafeStop("home_not_confirmed")
        remaining=min(120,deadline-time.monotonic()-10)
        if remaining<10:raise SafeStop("preview_job_budget_exhausted")
        with trace.phase("recipient_search"):
            result=remarks.run_customer_preview(driver,{"phoneNumber":config["phoneNumber"],"remarkName":config["remarkName"],"description":config["description"]},timeout=remaining,max_reads=100,replace_name=config.get("mode") == "send" or config.get('requireRemarkPhone') is True,require_remark_phone=config.get('requireRemarkPhone',False))
            if result.get('status') in ('blocked','stopped') and not trace.failure_phase:
                trace.failure_phase = 'recipient_search'
                trace.emit('recipient_search', 'error')
        if config.get('requireRemarkPhone') is True and result.get('status') == 'ready_before_send' and result.get('remarkPhoneSet') is not True:
            raise SafeStop('remark_phone_not_verified')
        if config.get("mode") == "send":
            with trace.phase("invitation_send"):
                result=invitation.send_once(driver,result,claim_invitation,budget,observe_application_ack=config.get('requireRemarkPhone') is True)
        if result.get("status")=="ready_before_send" and not lease_valid():
            result.update(status="blocked",code="device_lease_lost")
        code=result.get("code") or ("preview_ready" if result.get("status")=="ready_before_send" else "preview_stopped")
        output = {"previewStatus":result.get("status") if result.get("status") in ("ready_before_send", "send_attempted") else "blocked",
                "previewCode":code,"invitationSent":result.get("invitationSent",False),"sendStatus":result.get("sendStatus","not_attempted"),"remarkSaveStatus":result.get("remarkSaveStatus","not_attempted")}
        if config.get('requireRemarkPhone') is True:output['remarkPhoneSet']=result.get('remarkPhoneSet') is True
        if result.get('invitationRequestConfirmed') is True and result.get('invitationRequestProof')=='wecom_system_dialog_v1':
            output.update(invitationRequestConfirmed=True,invitationRequestProof='wecom_system_dialog_v1')
        if code=='wecom_add_friend_too_frequent':
            output.update(addFriendLimitConfirmed=True,addFriendLimitProof='wecom_system_dialog_v1')
        return output
    finally:
        if 'output'in locals()and output.get('previewStatus')=='blocked':
            primary_failure=output.get('previewCode')
        elif isinstance(sys.exc_info()[1],(SafeStop,w.StopPreview)):
            candidate=str(sys.exc_info()[1])
            if re.fullmatch(r'[a-z][a-z0-9_]{0,99}',candidate):primary_failure=candidate
        cleaning_up = True
        deadline = time.monotonic() + 12
        trace.emit("cleanup", "begin")
        with calls.call('cleanup.reader'):
            cleanup_ok = cleanup_reader(serial=SERIAL,
                ports=list(zip(ports, (10080, 10081))), owned_pid=owned_pid, owned_start=owned_start,
                reader_started=reader_started, pids=reader_pids,
                start_token=lambda pid:process_start_token(shell('cat /proc/' + pid + '/stat')),
                stop_main=lambda:shell('am force-stop com.netease.open.pocoservice'),
                close_instrument=lambda:instrument.close() if instrument else None,
                forwards=reader_forwards, remove_forward=remove_reader_forward)
        if not cleanup_ok and "output" in locals():
            output.update(previewStatus="blocked",previewCode="preview_cleanup_unconfirmed")
        trace.cleanup(cleanup_ok)
        resource_state['cleanupConfirmed'] = cleanup_ok
        record_resources()


def watch_control_fd(fd):
    # Compatibility entry for existing POSIX pipe tests.
    control_pipe.watch(lambda:os.read(fd,64),CANCELLED)


def start_control_monitor(stream):
    return control_pipe.start(stream,CANCELLED)


def main(keep_diagnostic_watchdog=False):
    global trace, calls
    previous_calls = calls
    trace = ExecutionTrace(sys.stderr, clock=lambda: time.monotonic())
    calls = CallTrace(sys.stderr, clock=lambda: time.monotonic())
    calls.start()
    diagnostic_stream = sys.stderr
    try:
        raw=control_pipe.read_line(sys.stdin,16384)
        if len(raw)>16384:raise SafeStop("invalid_preview_config")
        value=json.loads(raw)
        start_control_monitor(sys.stdin)
        # Discard dependency diagnostics rather than accumulating sensitive UI.
        with open(os.devnull,"w") as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
            output=run_host(value, diagnostic_stream)
    except (SafeStop,w.StopPreview) as error:
        code=str(error)
        if not re.fullmatch(r"[a-z0-9_]{1,100}",code):code="preview_stopped"
        output={"previewStatus":"blocked","previewCode":code,"invitationSent":False,"remarkSaveStatus":"unknown"}
    except Exception:
        output={"previewStatus":"blocked","previewCode":"preview_executor_error_no_replay","invitationSent":False,"remarkSaveStatus":"unknown"}
    output['diagnostic'] = {'wecomExecution': trace.summary()}
    calls.flush_tail()
    calls.emit({'kind': 'lifecycle', 'event': 'before_final_json'}, essential=True)
    calls.sample()
    print(json.dumps(output),flush=True)
    calls.emit({'kind': 'lifecycle', 'event': 'final_json_flushed'}, essential=True)
    if not keep_diagnostic_watchdog:
        calls.close()
        calls = previous_calls

if __name__=="__main__":
    if sys.argv[1:]==['--physical-causal-v1']:
        try:
            from wecom_host_identity import causal_reader_bootstrap
            bootstrap_raw=control_pipe.read_line(sys.stdin,8192)
            if len(bootstrap_raw)>8192:raise SafeStop('wecom_cleanup_bootstrap_unconfirmed')
            physical_bootstrap_hosts,physical_bootstrap_runtime,physical_bootstrap_causal=causal_reader_bootstrap(json.loads(bootstrap_raw))
            print('WECOM_PHYSICAL_READY '+json.dumps({'version':1,'hosts':physical_bootstrap_hosts,'bootstrap':physical_bootstrap_causal}),file=sys.stderr,flush=True)
        except Exception:
            print(json.dumps({'previewStatus':'blocked','previewCode':'wecom_cleanup_bootstrap_unconfirmed','invitationSent':False,'sendStatus':'not_attempted','remarkSaveStatus':'not_attempted'}),flush=True)
            sys.exit(1)
    elif sys.argv[1:]:
        print(json.dumps({'previewStatus':'blocked','previewCode':'wecom_cleanup_bootstrap_unconfirmed','invitationSent':False,'sendStatus':'not_attempted','remarkSaveStatus':'not_attempted'}),flush=True)
        sys.exit(1)
    main(keep_diagnostic_watchdog=True)
