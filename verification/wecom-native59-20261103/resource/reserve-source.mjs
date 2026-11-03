import fs from'node:fs';import{createHash}from'node:crypto';
if(createHash('sha256').update(fs.readFileSync('server/index.mjs')).digest('hex')!=='4bcecc8702ea577a77e5f17664b7833ced33b681f88e5beedcdc6875b6f047cc')throw Error('source_drift');
let raw='';for await(const c of process.stdin)raw+=c;const input=JSON.parse(raw);
if(Object.keys(input).sort().join(',')!=='concurrency,expectedConfigRevision'||input.concurrency!==11)throw Error('scope_invalid');
const r=await fetch('http://127.0.0.1:8787/api/v1/admin/lookup-pool',{method:'PUT',headers:{authorization:'Bearer '+process.env.ADMIN_API_TOKEN,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(6000)});
console.log(JSON.stringify({at:new Date().toISOString(),http:r.status,body:await r.json(),submittedKeys:Object.keys(input)}));