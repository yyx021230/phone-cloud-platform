"""Drain owned child pipes concurrently while observing actual OS exit."""
import threading
import time


def capture_process(p, *, timeout=290, observe_native=lambda pid:None, inspect_node=lambda pid:None):
    node=inspect_node(p.pid);streams={};native=None
    def drain(key,stream):
        data='';seen=0
        while True:
            chunk=stream.read(8192)
            if not chunk:break
            seen+=len(chunk)
            if key=='out'and len(data)<65536:data+=chunk[:65536-len(data)]
        streams[key]={'data':data,'size':seen}
    threads=[threading.Thread(target=drain,args=(key,stream),daemon=True)for key,stream in [('out',p.stdout),('err',p.stderr)]]
    for thread in threads:thread.start()
    started=time.monotonic()
    while p.poll()is None and time.monotonic()-started<timeout:
        observed=observe_native(p.pid)
        if observed is not None:native=observed
        time.sleep(.08)
    if p.poll()is None:return dict(pending=True,node=node,native=native)
    for thread in threads:thread.join(3)
    valid=all(not thread.is_alive()for thread in threads)and streams.get('out',{}).get('size',65537)<=65536
    return dict(pending=False,node=node,native=native,hostExitCode=p.returncode,
        stdout=streams.get('out',{}).get('data','')if valid else '',pipeDrainComplete=valid,
        stdoutBytes=streams.get('out',{}).get('size',0),stderrBytes=streams.get('err',{}).get('size',0))
