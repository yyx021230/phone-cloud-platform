// Build-only: no SSH, installation, systemctl, credentials or production writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here=path.dirname(fileURLToPath(import.meta.url));
const project=path.resolve(here,'../..');
const output=process.argv[2];
if(!output || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('Provide a new absolute output binary path');
const run=(bin,args,cwd,env)=>execFileSync(bin,args,{cwd,env:{...process.env,...env},stdio:'inherit'});
const info=JSON.parse(execFileSync('go',['mod','download','-json','github.com/bluenviron/mediamtx@v1.18.2'],{encoding:'utf8',cwd:path.join(project,'media-egress')}));
if(info.Sum!=='h1:A7FWV67kVLql5WYNrZHGgiUejFmh1INvfORt1pW0JEI=') throw new Error('Pinned upstream checksum mismatch');
const pins={
  'internal/protocols/webrtc/peer_connection.go':'05e801d31e2fc0489134cfd83d8a5068b9f024f7117c5efcf7e277213ee831c2',
  'internal/servers/webrtc/session.go':'d2fcec82eea037a8a4d425858199b9f2fb2b7644bcff3c64e8faab95d54741e3',
};
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for(const [f,expected] of Object.entries(pins)) if(hash(path.join(info.Dir,f))!==expected) throw new Error('Upstream hook file mismatch');
const buildRoot=fs.mkdtempSync(path.join(os.tmpdir(),'phonecloud-viewer-build-'));
const source=path.join(buildRoot,'mediamtx');
fs.cpSync(info.Dir,source,{recursive:true});
function writable(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){fs.chmodSync(p,0o755);writable(p);}else if(e.isFile())fs.chmodSync(p,0o644);}}
fs.chmodSync(source,0o755);writable(source);
for(const f of ['peer-connection.patch','viewer-session.patch']) run('git',['apply','--check',path.join(here,f)],source);
for(const f of ['peer-connection.patch','viewer-session.patch']) run('git',['apply',path.join(here,f)],source);
for(const f of ['viewer_pacing.go','viewer_pacing_test.go']) fs.copyFileSync(path.join(here,f),path.join(source,'internal/protocols/webrtc',f));
fs.writeFileSync(path.join(source,'internal/core/VERSION'),'v1.18.2-phonecloud-viewer-pacing-v1-candidate\n');
run('go',['mod','edit','-require=phonecloud/media-egress@v0.0.0',`-replace=phonecloud/media-egress=${path.join(project,'media-egress')}`],source);
run('go',['test','-race','./...'],path.join(project,'media-egress'));
const upstreamTestArgs=['test','-mod=mod','-race'];
// These upstream cases explicitly name Linux's "lo" interface. They cannot
// serve as acceptance on macOS (lo0); do not hide this in the build evidence.
const skippedLinuxOnly=process.platform!=='linux';
if(skippedLinuxOnly) upstreamTestArgs.push('-skip','^TestPeerConnection(Candidates|Connectivity)$');
run('go',[...upstreamTestArgs,'./internal/protocols/webrtc','./internal/servers/webrtc'],source);
// Official pinned downloader also checks the release ZIP's SHA256.
run('go',['generate','./internal/servers/hls'],source);
run('go',['build','-mod=mod','-trimpath','-o',output,'.'],source,{GOOS:'linux',GOARCH:'amd64',CGO_ENABLED:'0'});
const evidence={upstream:info.Version,upstreamSum:info.Sum,source,sha256:hash(output),binary:output,
  patches:Object.fromEntries(['peer-connection.patch','viewer-session.patch','viewer_pacing.go'].map(f=>[f,hash(path.join(here,f))])),
  installed:false,liveAcceptance:false,linuxFullSuiteRequired:skippedLinuxOnly};
fs.writeFileSync(output+'.build.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
