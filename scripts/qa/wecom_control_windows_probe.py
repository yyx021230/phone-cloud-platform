"""No-phone Windows red/green probe for the exact control reader source."""
import hashlib
import json
import subprocess
import sys
import threading
import time
from pathlib import Path


def probe(module_folder):
    cases=[]
    for label in ('legacy_blocking_crt','new_open','new_cancel_lf','new_cancel_crlf','new_parent_eof','new_pre_cancel_lf','new_pre_cancel_crlf'):
        source="import sys,threading,os\nsys.path.insert(0,"+repr(str(module_folder))+")\nevent=threading.Event()\n"
        if label=='legacy_blocking_crt':source+="threading.Thread(target=lambda:os.read(sys.stdin.fileno(),64),daemon=True).start()\n"
        else:
            source+="from wecom_control_pipe import start,read_line\n"
            if label.startswith('new_pre_cancel'):source+="assert read_line(sys.stdin,100).strip()=='{}'\n"
            source+="start(sys.stdin,event)\n"
            if label.startswith('new_pre_cancel'):source+="assert event.is_set();print('cancel_before_import',flush=True)\n"
        source+="import poco.drivers.android.uiautomation\nprint('import_ready',flush=True)\n"
        if label not in ('legacy_blocking_crt','new_open'):source+="assert event.wait(5);print('control_cancelled',flush=True)\n"
        p=subprocess.Popen([sys.executable,'-c',source],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        output=[];stderr=[];started=time.monotonic()
        if label.startswith('new_pre_cancel'):
            p.stdin.write(b'{}\n'+(b'cancel\r\n'if label.endswith('crlf')else b'cancel\n'));p.stdin.flush()
        def drain_lines(stream,buffer):
            for line in iter(stream.readline,b''):buffer.append(line.strip())
        ts=[threading.Thread(target=drain_lines,args=(s,b),daemon=True)for s,b in ((p.stdout,output),(p.stderr,stderr))]
        for t in ts:t.start()
        until=time.monotonic()+3
        while b'import_ready'not in output and p.poll()is None and time.monotonic()<until:time.sleep(.02)
        before_cancel=b'import_ready'in output
        if label in ('legacy_blocking_crt','new_cancel_lf','new_cancel_crlf'):
            p.stdin.write(b'can');p.stdin.flush();time.sleep(.05)
            p.stdin.write(b'cel\r\n'if label=='new_cancel_crlf'else b'cel\n');p.stdin.flush()
        elif label=='new_parent_eof':p.stdin.close()
        try:p.wait(timeout=5);forced=False
        except subprocess.TimeoutExpired:p.kill();p.wait(timeout=3);forced=True
        if not p.stdin.closed:p.stdin.close()
        for t in ts:t.join(2)
        for stream in (p.stdout,p.stderr):stream.close()
        cases.append(dict(case=label,exitCode=p.returncode,ms=round((time.monotonic()-started)*1000),
            importCompletedBeforeControl=before_cancel,importCompleted=b'import_ready'in output,
            cancelDetected=b'control_cancelled'in output,cancelBeforeImport=b'cancel_before_import'in output,forcedOwnProbeKill=forced,stderrBytes=sum(len(x)for x in stderr),processExited=p.poll()is not None))
    return dict(sourceSha256=hashlib.sha256((module_folder/'wecom_control_pipe.py').read_bytes()).hexdigest(),cases=cases,phoneActions=0)

if __name__=='__main__':
    if sys.platform!='win32':raise RuntimeError('windows_only')
    print(json.dumps(probe(Path(sys.argv[1]))))
