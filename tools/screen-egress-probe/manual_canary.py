"""Bounded device10/129 viewer canary; no production code/config writes.

Run only via the reviewed transient service with an independent cleanup timer.
Credentials stay in the platform container; only session metadata leaves it.
"""
import argparse
import datetime
import ipaddress
import json
import os
from pathlib import Path
import selectors
import shlex
import signal
import subprocess
import time
import urllib.request

TARGETS = {"10": "adb:TESTDEVICE0004", "129": "adb:TESTDEVICE0002"}
QUEUES = {"10": 49161, "129": 49162}
PREFIX = "pc-manual-10129-20260910-"
BASE = ["iptables", "-w", "2", "-t", "mangle"]
NODE = r'''
const targets=JSON.parse(process.argv[1]);
const base="http://127.0.0.1:"+(process.env.PORT||8787);
const headers={Authorization:"Bearer "+process.env.ADMIN_API_TOKEN};
async function get(path){let r=await fetch(base+path,{headers,signal:AbortSignal.timeout(1500)});if(!r.ok)throw Error("metadata HTTP "+r.status);return r.json()}
let {devices}=await get("/api/v1/devices");let out=[];
for(let [number,id] of Object.entries(targets)){
 let ds=devices.filter(d=>d.deviceId===id);if(ds.length!==1)throw Error("device identity not unique");
 let d=ds[0];if(d.deviceName!==number)throw Error("device number changed");
 let sid=d.occupancy?.kind==="screen_control"?d.occupancy.sessionId:null;
 if(!sid){out.push({number,status:"waiting"});continue}
 let j=await get("/api/v1/screen-sessions/"+encodeURIComponent(sid));let s=j.session||j;
 if(s.deviceId!==id||s.sessionId!==sid)throw Error("session identity mismatch");
 out.push({number,sessionId:sid,status:s.status,browserConnected:s.browserConnected,agentConnected:s.agentConnected,path:s.mediaPath});
}
console.log(JSON.stringify(out));
'''


def run(args, check=True, timeout=6):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=check)


def emit(event, **fields):
    row = dict(event=event, utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
    row.update(fields)
    print(json.dumps(row), flush=True)


def media():
    with urllib.request.urlopen("http://127.0.0.1:9997/v3/webrtcsessions/list", timeout=1.5) as r:
        return json.load(r)["items"]


def metadata():
    return json.loads(run(["docker", "exec", "phone-cloud-platform", "node", "--input-type=module", "-e", NODE, json.dumps(TARGETS)], timeout=6).stdout)


def resolve(row, items):
    """Never infer a slot from session ID, and never reuse an old ICE tuple."""
    if row.get("status") != "streaming" or not row.get("browserConnected") or not row.get("agentConnected"):
        return None
    path = row.get("path")
    if not isinstance(path, str) or not path.startswith("pc/slot-"):
        return None
    readers = [x for x in items if x.get("state") == "read" and x.get("path") == path]
    pubs = [x for x in items if x.get("state") == "publish" and x.get("path") == path]
    if len(readers) != 1 or len(pubs) != 1:
        return None
    r, p = readers[0], pubs[0]
    if not r.get("peerConnectionEstablished") or not p.get("peerConnectionEstablished"):
        return None
    parts = r.get("remoteCandidate", "").split("/")
    local = r.get("localCandidate", "").split("/")
    if len(parts) != 4 or parts[1] != "udp" or len(local) != 4 or local[1] != "udp" or local[3] != "8189":
        return None
    ip = ipaddress.ip_address(parts[2])
    port = int(parts[3])
    if ip.version != 4 or ip.is_unspecified or ip.is_multicast or not 1 <= port <= 65535:
        return None
    if sum(x.get("remoteCandidate") == r.get("remoteCandidate") for x in items) != 1:
        return None
    return dict(number=row["number"], sessionId=row["sessionId"], path=path,
                readerId=r["id"], publisherId=p["id"], ip=str(ip), port=port)


def rule_for(flow):
    number = flow["number"]
    if number not in TARGETS:
        raise ValueError("target outside canary")
    ip = ipaddress.IPv4Address(flow["ip"])
    port = int(flow["port"])
    if not 1 <= port <= 65535:
        raise ValueError("invalid exact port")
    return ["-o", "eth0", "-p", "udp", "--sport", "8189", "-d", str(ip)+"/32", "--dport", str(port),
            "-m", "comment", "--comment", PREFIX+number, "-j", "NFQUEUE", "--queue-num", str(QUEUES[number]), "--queue-bypass"]


def remove_rules():
    # Use the kernel's own normalized exact rule; never flush a chain/table.
    for line in run(BASE+["-S", "OUTPUT"]).stdout.splitlines():
        parts = shlex.split(line)
        if "--comment" not in parts:
            continue
        tag = parts[parts.index("--comment")+1]
        if tag not in {PREFIX+n for n in TARGETS}:
            continue
        number = tag[len(PREFIX):]
        if parts[:2] != ["-A", "OUTPUT"] or "--queue-num" not in parts or parts[parts.index("--queue-num")+1] != str(QUEUES[number]):
            raise RuntimeError("owned rule shape changed")
        run(BASE+["-D"]+parts[1:])


def cleanup(directory):
    remove_rules()  # Mandatory ordering: rule removal, then worker drain.
    binary = str(directory/"probe")
    killed = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if os.readlink(entry/"exe") == binary:
                os.kill(int(entry.name), signal.SIGTERM)
                killed.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    emit("cleanup", rulesRemoved=True, workersSignaled=len(killed))


def detach(number, active, selector):
    worker = active.pop(number)
    rule = worker["rule"]
    if run(BASE+["-C", "OUTPUT"]+rule, check=False).returncode == 0:
        run(BASE+["-D", "OUTPUT"]+rule)
    proc = worker["proc"]
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
    proc.wait(timeout=4)
    selector.unregister(proc.stdout)
    proc.stdout.close()
    emit("detached", number=number, sessionId=worker["flow"]["sessionId"], exitCode=proc.returncode)


def attach(flow, directory, active, selector, remaining):
    number = flow["number"]
    proc = subprocess.Popen([str(directory/"probe"), "--destination", flow["ip"], "--source-port", "8189",
        "--destination-port", str(flow["port"]), "--queue", str(QUEUES[number]), "--rate", "8000000",
        "--packets-per-group", "2", "--manual-duration", str(max(10, int(remaining)))+"s"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
    # Track before any following operation so finally cleanup covers failures.
    worker = dict(proc=proc, rule=rule_for(flow), flow=flow, buffer=b"", last=None)
    active[number] = worker
    selector.register(proc.stdout, selectors.EVENT_READ, number)
    ready, deadline = False, time.monotonic()+3
    while time.monotonic() < deadline:
        events = selector.select(.1)
        for key, _ in events:
            if key.data != number:
                continue
            data = os.read(proc.stdout.fileno(), 65536)
            worker["buffer"] += data
            while b"\n" in worker["buffer"]:
                line, worker["buffer"] = worker["buffer"].split(b"\n", 1)
                value = json.loads(line)
                ready |= value.get("event") == "armed"
        if ready:
            break
        if proc.poll() is not None:
            raise RuntimeError("probe startup failed")
    if not ready:
        raise RuntimeError("probe startup timeout")
    # A second fresh, authenticated identity check immediately before insertion.
    rows = metadata()
    row = next(x for x in rows if x["number"] == number)
    if resolve(row, media()) != flow:
        detach(number, active, selector)
        return
    if not (directory/"lease.json").exists() or time.time() >= json.loads((directory/"lease.json").read_text())["expiresEpoch"]:
        raise RuntimeError("canary expired before attachment")
    proc.send_signal(signal.SIGUSR1)
    run(BASE+["-I", "OUTPUT", "1"]+worker["rule"])
    emit("attached", number=number, sessionId=flow["sessionId"], readerId=flow["readerId"], rate=8000000, packetsPerGroup=2)


def serve(directory):
    lease = json.loads((directory/"lease.json").read_text())
    expires = lease["expiresEpoch"]
    if not 10 <= expires-time.time() <= 3600:
        raise RuntimeError("invalid bounded lease")
    qfile = Path("/proc/net/netfilter/nfnetlink_queue")
    if qfile.exists() and qfile.read_text().strip():
        raise RuntimeError("existing NFQUEUE consumer; not attaching")
    active, last_report = {}, 0
    selector = selectors.DefaultSelector()
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    emit("watching", numbers=list(TARGETS), rate=8000000, packetsPerGroup=2, expiresUtc=lease["expiresUtc"])
    try:
        while not stopping and time.time() < expires:
            rows = metadata()
            items = media()
            for row in rows:
                number = row["number"]
                flow = resolve(row, items)
                if number in active and active[number]["flow"] != flow:
                    detach(number, active, selector)
                if flow and number not in active and expires-time.time() >= 15:
                    attach(flow, directory, active, selector, expires-time.time())
            until = time.monotonic()+1
            while not stopping and time.monotonic() < until:
                for key, _ in selector.select(.1):
                    number = key.data
                    worker = active[number]
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        raise RuntimeError("probe stream ended")
                    worker["buffer"] += data
                    while b"\n" in worker["buffer"]:
                        line, worker["buffer"] = worker["buffer"].split(b"\n", 1)
                        value = json.loads(line)
                        worker["last"] = value
                        if value.get("errors", 0) or value.get("bypass") or value.get("event") in {"latency_gate_failed", "netlink_error", "exit", "hard_deadline"}:
                            emit("gate", number=number, probe=value)
                            raise RuntimeError("probe gate; remove manual canary")
            if time.time()-last_report >= 10:
                last_report = time.time()
                status = dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), expiresUtc=lease["expiresUtc"],
                    devices=[dict(number=n, state="active" if n in active else "waiting", sessionId=active[n]["flow"]["sessionId"] if n in active else None,
                                  probe=active[n]["last"] if n in active else None) for n in TARGETS])
                temp = directory/"status.tmp"
                temp.write_text(json.dumps(status))
                os.replace(temp, directory/"status.json")
                emit("status", **status)
    finally:
        # Remove all owned rules even if one worker's shutdown fails.
        cleanup(directory)
        for n in list(active):
            detach(n, active, selector)
        selector.close()
        emit("finished")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["serve", "cleanup"])
    parser.add_argument("directory")
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if directory.parent != Path("/tmp") or not directory.name.startswith("phone-cloud-egress-probe-"):
        raise SystemExit("invalid private staging directory")
    os.umask(0o077)
    try:
        (serve if args.mode == "serve" else cleanup)(directory)
    except Exception as exc:
        emit("failed", errorType=type(exc).__name__)
        raise SystemExit(1)
