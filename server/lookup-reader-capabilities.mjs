import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

// Small immutable markers in the existing persistent DATA_DIR. Do not force a
// full runtime snapshot for heartbeat, and never erase a floor on omission.
export async function createLookupReaderCapabilities(directory) {
  const enabled = new Set(), blocked = new Set(), pending = new Map();
  let unavailable = false;
  const key = agentId => {
    if (typeof agentId !== 'string' || !agentId || agentId.length > 200) throw Error('invalid_capacity_agent');
    return createHash('sha256').update(agentId).digest('hex');
  };
  const names = await fs.readdir(directory).catch(error => {if(error.code!=='ENOENT')unavailable=true;return [];});
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.v1$/.test(name)) continue;
    try {
      if (await fs.readFile(path.join(directory,name),'utf8') !== '1\n') blocked.add(name.slice(0,-3));
      else enabled.add(name.slice(0,-3));
    } catch { blocked.add(name.slice(0,-3)); }
  }
  return {
    has: agentId => unavailable || enabled.has(key(agentId)) || blocked.has(key(agentId)),
    available: agentId => !unavailable && !blocked.has(key(agentId)),
    async enable(agentId) {
      const id=key(agentId);
      if(unavailable || blocked.has(id)) throw Error('reader_capability_storage_unavailable');
      if(enabled.has(id))return;
      if(pending.has(id))return pending.get(id);
      const operation=(async()=>{
        await fs.mkdir(directory,{recursive:true,mode:0o700});
        const temporary=path.join(directory,id+'.'+randomUUID()+'.tmp');
        try {
          const handle=await fs.open(temporary,'wx',0o600);
          try {await handle.writeFile('1\n');await handle.sync();}finally{await handle.close();}
          await fs.rename(temporary,path.join(directory,id+'.v1'));
          const dir=await fs.open(directory,'r');try{await dir.sync();}finally{await dir.close();}
          enabled.add(id);
        }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
      })();
      pending.set(id,operation);
      try{await operation;}finally{pending.delete(id);}
    }
  };
}
