"""Run under unshare -n only: two independent queues, expiry and untouched data."""
import collections
import json
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

binary = sys.argv[1]
subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
procs, rules, readers, sent, received, logs = [], [], [], [], [], []
stop = threading.Event()
base = ["iptables", "-t", "mangle"]


def consume(p):
    for line in p.stdout: logs.append(json.loads(line))


def receive():
    while not stop.is_set():
        for sock in select.select(readers, [], [], .02)[0]:
            b, anc, _, _ = sock.recvmsg(4096, 1024)
            sec, ns = next(struct.unpack("@qq", x[2][:16]) for x in anc if x[0] == socket.SOL_SOCKET and x[1] == 35)
            received.append((sec*1000000000+ns, sock.getsockname()[1], b))


try:
    for port, q in [(48190, 49161), (48191, 49162)]:
        p = subprocess.Popen([binary, "--destination", "127.0.0.1", "--source-port", "48189", "--destination-port", str(port),
            "--queue", str(q), "--manual-duration", "10s", "--rate", "8000000", "--packets-per-group", "2"], stdout=subprocess.PIPE, text=True)
        procs.append(p)
        assert json.loads(p.stdout.readline())["event"] == "armed"
        threading.Thread(target=consume, args=(p,), daemon=True).start()
        r = ["-p", "udp", "--sport", "48189", "-d", "127.0.0.1/32", "--dport", str(port), "-j", "NFQUEUE", "--queue-num", str(q), "--queue-bypass"]
        subprocess.run(base+["-I", "OUTPUT"]+r, check=True)
        rules.append(r)
    for port in [48190, 48191, 48192]:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
        s.setsockopt(socket.SOL_SOCKET, 35, 1)
        s.bind(("127.0.0.1", port))
        readers.append(s)
    threading.Thread(target=receive, daemon=True).start()
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tx.bind(("127.0.0.1", 48189))
    for p in procs: p.send_signal(signal.SIGUSR1)
    t0 = time.monotonic()
    for g in range(12):
        time.sleep(max(0, t0+g+.25-time.monotonic()))
        for i in range(156):
            b = bytes([0x80,108])+struct.pack("!HII", g*156+i, g, 7)+bytes(1188)
            for port in [48190, 48191, 48192]:
                sent.append((port,b))
                tx.sendto(b,("127.0.0.1",port))
        b = bytes([0x80,200])+struct.pack("!HII", 6000+g,g,7)+bytes(1188)
        for port in [48190,48191]:
            sent.append((port,b)); tx.sendto(b,("127.0.0.1",port))
    time.sleep(.6)
    for r in rules: subprocess.run(base+["-D","OUTPUT"]+r,check=True)
    rules.clear()
    for p in procs: p.send_signal(signal.SIGTERM)
    for p in procs: p.wait(timeout=3)
    stop.set()
    frames=[]
    for port in [48190,48191,48192]:
        for g in range(12):
            z=[(t,struct.unpack("!H",b[2:4])[0]) for t,pt,b in received if pt==port and b[1]==108 and struct.unpack("!I",b[4:8])[0]==g]
            assert len(z)==156 and all(b[1]==a[1]+1 for a,b in zip(z,z[1:]))
            span=(z[-1][0]-z[0][0])/1e6
            paced=port!=48192 and g<10
            assert 150<span<300 if paced else span<40, (port,g,span)
            frames.append(dict(flow=port-48190,frame=g,spanMs=round(span,3),paced=paced))
    exact=collections.Counter(sent)==collections.Counter((pt,b) for _,pt,b in received)
    assert exact and all(p.returncode==0 for p in procs) and not any(x.get("errors",0) for x in logs)
    print(json.dumps(dict(valid=True,sent=len(sent),received=len(received),exactPayloads=exact,frames=frames,productionNetworkTouched=False)))
finally:
    for r in rules: subprocess.run(base+["-D","OUTPUT"]+r,check=True)
    for p in procs:
        if p.poll() is None: p.send_signal(signal.SIGTERM); p.wait(timeout=3)
    stop.set()
    for s in readers: s.close()
