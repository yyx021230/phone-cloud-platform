import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {applyHotpatch,recoveryFunctionHash} from './runtime-recovery.mjs';

const args=process.argv.slice(2);
if(args.length>1 || args.length===1 && args[0]!=="--apply") throw Error('invalid_arguments');
const apply=args[0]==="--apply";
const digest=value=>createHash('sha256').update(value).digest('hex');
const service=await fs.readFile('/app/server/wecom-cleanup-service.mjs','utf8');
const before=await fs.readFile('/app/server/wecom-preinput-recovery.mjs','utf8');
const target=await fs.readFile(new URL('./wecom-preinput-recovery.mjs',import.meta.url),'utf8');
if(digest(service)!=='26839ec25cbe47960e5dea136ef502cd43d1e6a54e4c3c536a397f8f1780b40d'
 ||digest(before)!=='de5de848afa9e9e04ec13d6efc2614e019ec33345b4339b82c9a48130c0fbb2c'
 ||digest(target)!=='9061288bb756fe4091c074220abfa74bfacc27c7af0d0d153c1fb5223defaae7')throw Error('source_hash_drift');
const result=await applyHotpatch({origin:'http://127.0.0.1:9229',serviceSource:service,preinputSource:target,
 beforeHash:recoveryFunctionHash(service),afterHash:recoveryFunctionHash(service),expectedPid:1,
 apply,closeInspector:apply});
console.log(JSON.stringify(result));
