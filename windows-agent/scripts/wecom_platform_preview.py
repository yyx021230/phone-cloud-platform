"""One-shot, preview-only production adapter. Credentials arrive on stdin only.

Uses the fixed, already-running SYSTEM ADB socket, never starts a server,
installs packages, switches accounts, guesses coordinates or sends invitations.
"""
import contextlib
import datetime
import os
import threading
import io
import json
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
from wecom_rpc_budget import bound_rpc_transport

class SafeStop(Exception): pass

CANCELLED = threading.Event()
cleaning_up = False

DEVICES = json.loads(Path(__file__).with_name("wecom_preview_devices.json").read_text())

def validate_config(value):
    allowed = {"taskId", "deviceId", "serial", "deviceNumber", "androidUser", "phoneNumber",
               "previewOnly", "agentId", "serverBaseUrl", "agentToken"}
    if not isinstance(value, dict) or set(value) != allowed or value.get("previewOnly") is not True:
        raise SafeStop("invalid_preview_config")
    entry = DEVICES.get(value.get("deviceNumber"))
    if (not entry or type(value.get("androidUser")) is not int or value["androidUser"] != entry["androidUser"]
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
    return value

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

def budget():
    if CANCELLED.is_set() and not cleaning_up: raise SafeStop("preview_cancelled_no_replay")
    if time.monotonic() >= deadline: raise SafeStop("preview_job_budget_exhausted")

def lease_valid():
    try:
        budget()
        url = config["serverBaseUrl"].rstrip("/") + "/api/v1/windows-agents/" + config["agentId"] + "/wecom-preview-tasks/" + config["taskId"] + "/lease"
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + config["agentToken"]})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=min(8, deadline-time.monotonic())) as response:
            raw = response.read(8193)
        if len(raw)>8192: return False
        proof = json.loads(raw)
        return (proof.get("valid") is True and proof.get("taskId") == config["taskId"]
            and proof.get("deviceId") == config["deviceId"] and proof.get("serial") == SERIAL
            and proof.get("deviceNumber") == config["deviceNumber"] and proof.get("androidUser") == selected_user
            and datetime.datetime.fromisoformat(proof["expiresAt"].replace("Z","+00:00")).timestamp() > time.time()+3)
    except Exception: return False

def mutate(cmd):
    budget()
    if not lease_valid(): raise SafeStop("device_lease_lost")
    return shell(cmd)


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
  v=s.recv(n-len(b))
  if not v:raise SafeStop('adb_closed')
  b+=v
 return b

def command(s,cmd):
 b=cmd.encode();s.sendall(('%04x'%len(b)).encode()+b)
 if exact(s,4)!=b'OKAY':raise SafeStop('adb_rejected')

def connection():
 budget()
 if adb_identity()!=initial_adb:raise SafeStop('adb_process_changed')
 s=socket.create_connection(('127.0.0.1',5037),2);s.settimeout(6);return s

def shell(cmd,keep=False):
 s=connection();command(s,'host:transport:'+SERIAL);command(s,'shell:'+cmd)
 if keep:return s
 out=b''
 try:
  while True:
   part=s.recv(65536)
   if not part:break
   out+=part
   if len(out)>2*1024*1024:raise SafeStop('adb_response_too_large')
 finally:s.close()
 return out.decode('utf-8','replace')

def host(cmd):
 s=connection()
 try:
  command(s,cmd);length=exact(s,4)
  if length==b'OKAY':length=exact(s,4)
  return exact(s,int(length,16)).decode()
 finally:s.close()

def foreground_info():
 raw=shell('dumpsys activity activities')
 for line in raw.splitlines():
  if 'ResumedActivity' in line or re.search(r'\bResumed:',line):
   match=re.search(r'\bu(\d+)\s+(com\.[A-Za-z0-9_.]+)/([A-Za-z0-9_.$]+)',line)
   if match:return match.group(2),int(match.group(1)),match.group(2)+'/'+match.group(3)
 return '',-1,''

def foreground():
 package,user,_=foreground_info()
 return package if user==selected_user else ''

def health(port):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d/uiautomation/connectionState'%port,timeout=2) as response:return json.load(response).get('connected') is True
 except:return False

def any_snapshot(poco):
 package,_,_=foreground_info();frozen=poco.freeze();nodes=[]
 for kind in w.NODE_TYPES+("android.widget.RadioButton","android.widget.CheckBox"):
  query=frozen(type=kind)
  if len(query)==0:continue
  for item in list(query):
   if item.attr("visible") is not True:continue
   n=w.Node(kind=kind,text=item.attr("text") or "",name=item.attr("name") or "",desc=item.attr("contentDescription") or "",enabled=item.attr("enabled") is True,position=tuple(item.get_position()),size=tuple(item.get_size()))
   if not w.is_system_status_indicator(n) and n not in nodes:nodes.append(n)
 if len(nodes)>600:raise SafeStop("hierarchy_too_large")
 return w.Screen(package,tuple(nodes))

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


def process_start_token(stat):
    # Linux comm may contain spaces/parentheses; starttime is field 22.
    rest = stat.rsplit(") ", 1)
    fields = rest[1].split() if len(rest) == 2 else []
    return fields[19] if len(fields) > 19 and fields[19].isdigit() else ""


def run_host(value):
    global config, SERIAL, selected_user, initial_adb, deadline, cleaning_up
    cleaning_up = False
    config = validate_config(value)
    SERIAL = config["serial"]; selected_user = config["androidUser"]
    deadline = time.monotonic() + 210
    ports = []; instrument = None; owned_pid = ""; owned_start = ""; result = {}
    initial_adb = adb_identity()
    try:
        if not lease_valid(): raise SafeStop("device_lease_lost")
        if "package:" not in shell("pm list packages --user %d com.tencent.wework" % selected_user):
            raise SafeStop("requested_app_slot_missing")
        if "package:" not in shell("pm path com.netease.open.pocoservice"):
            raise SafeStop("existing_poco_missing")
        if shell("pidof com.netease.open.pocoservice").strip(): raise SafeStop("poco_already_running")
        for remote_port in (10080, 10081):
            if not lease_valid(): raise SafeStop("device_lease_lost")
            ports.append(int(host("host-serial:"+SERIAL+":forward:tcp:0;tcp:"+str(remote_port))))
        mutate("am start -n com.netease.open.pocoservice/.TestActivity")
        # Establish ownership before instrumentation health checks can fail.
        owned_pid = shell("pidof com.netease.open.pocoservice").strip()
        if not re.fullmatch(r"\d+", owned_pid): raise SafeStop("poco_owner_unconfirmed")
        owned_start = process_start_token(shell("cat /proc/"+owned_pid+"/stat"))
        if not owned_start: raise SafeStop("poco_owner_unconfirmed")
        if not lease_valid(): raise SafeStop("device_lease_lost")
        instrument = shell("am instrument -w -e debug false -e class com.netease.open.pocoservice.InstrumentedTestAsLauncher com.netease.open.pocoservice/androidx.test.runner.AndroidJUnitRunner", keep=True)
        until = min(deadline, time.monotonic()+12)
        while time.monotonic()<until and not health(ports[0]): time.sleep(.3)
        # Android instrumentation may replace the Activity's process. Bind the
        # new instance only while our exclusive lease still holds, before a
        # failed health check exits; never adopt a pre-existing/older instance.
        current_pid = shell("pidof com.netease.open.pocoservice").strip()
        if current_pid != owned_pid:
            if not re.fullmatch(r"\d+", current_pid) or not lease_valid():
                raise SafeStop("poco_owner_changed")
            current_start = process_start_token(shell("cat /proc/"+current_pid+"/stat"))
            if not current_start or int(current_start) < int(owned_start):
                raise SafeStop("poco_owner_changed")
            owned_pid, owned_start = current_pid, current_start
        if not health(ports[0]): raise SafeStop("poco_not_ready")
        launch = shell("cmd package resolve-activity --brief --user %d com.tencent.wework"%selected_user).splitlines()[-1].strip()
        if not re.fullmatch(r"com\.tencent\.wework/[A-Za-z0-9_.$]+",launch): raise SafeStop("wecom_activity_unconfirmed")
        mutate("input keyevent 224"); mutate("wm dismiss-keyguard")
        if config["deviceNumber"] == "25":
            startup.dismiss_nonsecure_keyguard(lambda:shell("dumpsys window policy"), lease_valid,
                lambda:mutate("input keyevent 82"), android_user=selected_user, check_budget=budget)
        response=mutate("am start --user %d -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "%selected_user+launch)
        if "Error" in response: raise SafeStop("wecom_launch_rejected")
        import poco.drivers.android.uiautomation as u
        client=u.AndroidRpcClient("http://127.0.0.1:"+str(ports[1])); client.set_timeout(3); bound_rpc_transport(client,6)
        send=client.transport.send
        def bounded_send(request,timeout=None):
            budget()
            return send(request,timeout=min(6 if timeout is None else timeout,deadline-time.monotonic()))
        client.transport.send=bounded_send
        remote=client.remote("poco-uiautomation-framework")
        agent=u.PocoAgent(u.RemotePocoHierarchy(remote.dumper,remote.selector,remote.attributor),remote.inputer,u.ScreenWrapper(remote.screen),None)
        poco=u.Poco(agent,**w.PREVIEW_POCO_OPTIONS)
        if config["deviceNumber"] == "25":
            startup.dismiss_miui_proximity(lambda:any_snapshot(poco),foreground,lease_valid,
                lambda:shell("dumpsys window policy"),lambda:mutate("input keyevent 24"),android_user=selected_user,check_budget=budget)
        package,user,activity=foreground_info()
        if package=="com.android.settings" and activity.endswith("/.Settings$UsbDetailsActivity"):
            startup_click(poco,package,lambda page:all(page.has(v) for v in ("取消","仅限充电","传输文件","传输照片")),lambda n:n.labeled("取消"))
            mutate("am start --user %d -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "%selected_user+launch)
            package,user,activity=foreground_info()
        if package=="com.android.intentresolver" and activity.endswith("/.DoubleAppResolverActivity"):
            def slot(n):
                label=re.sub(r"\s","",n.text)
                return label=="企业微信" if selected_user==0 else re.fullmatch(r"(?:Ⅱ|II)[·.]?企业微信",label) is not None
            startup_click(poco,package,lambda page:any("选择要使用的应用" in n.text for n in page.nodes),slot)
        driver=remarks.PocoRemarkDriver(poco,foreground,lease_valid)
        until=min(deadline,time.monotonic()+18)
        while foreground()!=w.PACKAGE and time.monotonic()<until: budget();time.sleep(.25)
        until=min(deadline,time.monotonic()+60); home=False; update_dismissed=False
        for _ in range(20):
            budget()
            if time.monotonic()>=until: raise SafeStop("home_navigation_timeout")
            page=driver.snapshot(); w.guard(page)
            observed=any_snapshot(poco)
            if observed.package==w.PACKAGE and all(observed.has(v) for v in ("发现新版本","立即更新","取消")):
                if update_dismissed: raise SafeStop("update_dialog_reappeared")
                startup_click(poco,w.PACKAGE,lambda current:all(current.has(v) for v in ("发现新版本","立即更新","取消")),lambda n:n.kind in ("android.widget.Button","android.widget.TextView") and n.text=="取消")
                update_dismissed=True; continue
            if w.is_home(page) and not w.is_menu(page):
                second=driver.snapshot();w.guard(second)
                if w.is_home(second) and not w.is_menu(second):home=True;break
                continue
            test_search=False
            try:test_search=w.editor(page).text in ("","手机号",config["phoneNumber"])
            except w.StopPreview:pass
            global_search=(foreground_info()[2].endswith("/.contact.controller.globalsearch.GlobalSearchActivityV2") and len(page.matching(lambda n:n.kind=="android.widget.EditText" and n.name=="com.tencent.wework:id/lnx"))==1)
            known=(page.has(w.SEND) or w.profile_matches(page,config["phoneNumber"]) or w.is_add_page(page) or w.is_menu(page) or test_search or global_search)
            if not known:
                # A blank startup frame may settle; no writes on unknown pages.
                time.sleep(.3); continue
            if driver.snapshot()!=page or foreground()!=w.PACKAGE: raise SafeStop("home_navigation_page_changed")
            mutate("input keyevent 4"); time.sleep(.3)
        if not home:raise SafeStop("home_not_confirmed")
        remaining=min(120,deadline-time.monotonic()-10)
        if remaining<10:raise SafeStop("preview_job_budget_exhausted")
        result=remarks.run_customer_preview(driver,{"phoneNumber":config["phoneNumber"]},timeout=remaining,max_reads=100)
        if result.get("status")=="ready_before_send" and not lease_valid():
            result.update(status="blocked",code="device_lease_lost")
        code=result.get("code") or ("preview_ready" if result.get("status")=="ready_before_send" else "preview_stopped")
        output = {"previewStatus":result.get("status") if result.get("status")=="ready_before_send" else "blocked",
                "previewCode":code,"invitationSent":False,"remarkSaveStatus":result.get("remarkSaveStatus","not_attempted")}
        return output
    finally:
        cleaning_up = True
        deadline = time.monotonic() + 12
        cleanup_ok = True
        # Touch only our own target/forwards; never stop an unrelated Poco owner.
        if instrument or owned_pid:
            try:
                if (owned_pid and owned_start and shell("pidof com.netease.open.pocoservice").strip()==owned_pid
                    and process_start_token(shell("cat /proc/"+owned_pid+"/stat"))==owned_start):
                    # Cleanup only the exact tool process created by this child.
                    # The parent keeps this serial reserved until child exit.
                    shell("am force-stop com.netease.open.pocoservice")
                else: cleanup_ok = False
            except Exception: cleanup_ok = False
            if instrument: instrument.close()
        for port in ports:
            try:
                connection_socket = connection()
                try: command(connection_socket,"host-serial:"+SERIAL+":killforward:tcp:"+str(port))
                finally: connection_socket.close()
            except Exception: cleanup_ok = False
        if not cleanup_ok and "output" in locals():
            output.update(previewStatus="blocked",previewCode="preview_cleanup_unconfirmed")


def watch_control_fd(fd):
    # Read the OS pipe directly: a daemon holding sys.stdin's buffered-reader
    # lock can abort CPython 3.9 during shutdown. EOF means parent lost.
    pending = b""
    try:
        while True:
            chunk = os.read(fd, 64)
            if not chunk: break
            pending += chunk
            if b"cancel\n" in pending or len(pending) > 1024: break
    except OSError:
        pass
    finally:
        CANCELLED.set()


def start_control_monitor(stream):
    threading.Thread(target=watch_control_fd,args=(stream.fileno(),),daemon=True).start()


def main():
    try:
        raw=sys.stdin.readline(16385)
        if len(raw)>16384:raise SafeStop("invalid_preview_config")
        value=json.loads(raw)
        start_control_monitor(sys.stdin)
        # Discard dependency diagnostics rather than accumulating sensitive UI.
        with open(os.devnull,"w") as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
            output=run_host(value)
    except (SafeStop,w.StopPreview) as error:
        code=str(error)
        if not re.fullmatch(r"[a-z0-9_]{1,100}",code):code="preview_stopped"
        output={"previewStatus":"blocked","previewCode":code,"invitationSent":False,"remarkSaveStatus":"unknown"}
    except Exception:
        output={"previewStatus":"blocked","previewCode":"preview_executor_error_no_replay","invitationSent":False,"remarkSaveStatus":"unknown"}
    print(json.dumps(output),flush=True)

if __name__=="__main__":main()
