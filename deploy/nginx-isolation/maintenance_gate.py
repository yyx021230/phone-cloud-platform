#!/usr/bin/env python3
"""Temporary business admission gate; verify with synthetic Unix sockets only."""
import argparse
import importlib.util
import json
import socketserver
import subprocess
import tempfile
import threading
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('isolation', Path(__file__).with_name('verify.py'))
isolation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolation)
FLAG = '/run/phone-cloud-platform-release-20261029.flag'
# Keep completion, result reads, heartbeat and outbox routes available.
PATTERN = (r'^1:(?:GET:/api/v1/windows-agents/[^/]+/tasks/next|'
           r'POST:/api/v1/(?:open/name-lookups/(?:prepare|tasks|query|sessions)|'
           r'open/name-lookups/sessions/[^/]+/query|'
           r'wecom/customer-invitations|user/automation/(?:wecom-preview-tasks|'
           r'xhs-data-tasks|xhs-publish-tasks|alipay-name-sessions)|'
           r'user/automation/alipay-name-sessions/[^/]+/query|'
           r'windows-agent-tasks|open/xhs-data/batches))$')

def snippet(flag=FLAG):
    return ('    set $pc_release_paused 0;\n'
            f'    if (-f {flag}) {{ set $pc_release_paused 1; }}\n'
            '    set $pc_release_request "$pc_release_paused:$request_method:$uri";\n'
            f'    if ($pc_release_request ~ "{PATTERN}") {{ return 503; }}\n')

def verify(binary):
    isolation.require_unprivileged()
    isolation.require_no_production_write_access()
    before = isolation.metadata()
    cases = []
    with tempfile.TemporaryDirectory(prefix='pc-release-gate-', dir='/var/tmp') as folder:
        root = Path(folder)
        flag = root/'paused'
        class Handler(isolation.http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b'synthetic')
            do_POST = do_GET
            def log_message(self, *_args):
                pass
        server = isolation.UnixServer(str(root/'upstream.sock'), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        config = isolation.render_config(root).replace('    location = /inventory-fixture {', snippet(flag)+'    location = /inventory-fixture {')
        (root/'nginx.conf').write_text(config)
        args = [binary, '-p', folder, '-c', str(root/'nginx.conf')]
        checked = subprocess.run(args+['-t'], capture_output=True, timeout=5)
        if checked.returncode:
            raise RuntimeError('ISOLATED_CONFIG_CHECK_FAILED')
        process = None
        try:
            with (root/'startup.log').open('wb') as output:
                process = subprocess.Popen(args, stdout=output, stderr=output)
                end = time.monotonic()+5
                while not (root/'front.sock').exists():
                    if process.poll() is not None or time.monotonic()>end:
                        raise RuntimeError('ISOLATED_START_FAILED')
                    time.sleep(.05)
                routes = [('GET','/api/v1/windows-agents/synthetic/tasks/next',True),
                          ('POST','/api/v1/open/name-lookups/tasks',True),
                          ('POST','/api/v1/open/name-lookups/query',True),
                          ('POST','/api/v1/wecom/customer-invitations',True),
                          ('POST','/api/v1/user/automation/xhs-data-tasks',True),
                          ('GET','/api/v1/open/name-lookups/tasks/synthetic',False),
                          ('POST','/api/v1/windows-agent-tasks/synthetic/status',False),
                          ('POST','/api/v1/windows-agent-tasks/synthetic/ack',False),
                          ('POST','/api/v1/windows-agents/heartbeat',False),
                          ('POST','/api/v1/windows-agents/synthetic/human-probes',False),
                          ('GET','/webrtc/synthetic',False)]
                for paused in [False,True,False]:
                    if paused: flag.write_text('synthetic')
                    elif flag.exists(): flag.unlink()
                    for method,path,blocked in routes:
                        client = isolation.UnixClient(str(root/'front.sock'),timeout=3)
                        client.request(method,path,body=b'',headers={'Host':'fixture.invalid'})
                        response=client.getresponse();response.read();client.close()
                        expected=503 if paused and blocked else 200
                        if response.status!=expected:
                            raise RuntimeError('SYNTHETIC_GATE_MISMATCH')
                        cases.append({'paused':paused,'method':method,'path':path,'status':response.status})
        finally:
            if process and process.poll() is None: process.terminate();process.wait(timeout=5)
            server.shutdown();server.server_close()
    if isolation.metadata()!=before:
        raise RuntimeError('PRODUCTION_DIRECTORY_DRIFT: stop; do not auto-repair')
    return {'status':'synthetic_gate_verified','cases':len(cases),'allTempPathsIsolated':True,'productionDirectoryMetadataUnchanged':True,'results':cases}

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--verify',action='store_true');parser.add_argument('--binary',default='/usr/sbin/nginx');args=parser.parse_args()
    if args.verify: print(json.dumps(verify(args.binary)))
    else: print(snippet(),end='')
