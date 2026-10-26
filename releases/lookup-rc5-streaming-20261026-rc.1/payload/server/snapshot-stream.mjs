import { createReadStream, mkdtempSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import copyFrom from './vendor/pg-copy-streams/copy-from.js';
import copyTo from './vendor/pg-copy-streams/copy-to.js';
import Parser from './vendor/stream-json/Parser.js';
import Assembler from './vendor/stream-json/Assembler.js';

const signature = Buffer.from('PGCOPY\n\xff\r\n\0', 'binary');
const header = Buffer.concat([signature, Buffer.alloc(8)]);
const int16 = n => { const b=Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = n => { const b=Buffer.alloc(4); b.writeInt32BE(n); return b; };

// Synchronous bounded serialization freezes the snapshot before any await.
// Private temporary files are disposed on success, rollback, or connection failure.
export function spoolSnapshot(snapshot, stringify=JSON.stringify) {
  const dir=mkdtempSync(join(tmpdir(),'phone-cloud-snapshot-'));
  const file=join(dir,'state.json'); let fd, bytes=0, parts=[], chars=0;
  const dispose=()=>rmSync(dir,{recursive:true,force:true});
  try {
    fd=openSync(file,'wx',0o600);
    const flush=()=>{if(!parts.length)return; const b=Buffer.from(parts.join('')); for(let off=0;off<b.length;)off+=writeSync(fd,b,off,b.length-off);bytes+=b.length;parts=[];chars=0;};
    const add=s=>{if(chars+s.length>262144)flush();parts.push(s);chars+=s.length;if(chars>=262144)flush();};
    add('{');let first=true;
    for(const key of Object.keys(snapshot)) {
      const value=snapshot[key];
      if(Array.isArray(value)&&typeof value.toJSON!=='function') {
        add((first?'':',')+JSON.stringify(key)+':[');first=false;
        for(let i=0;i<value.length;i++)add((i?',':'')+(stringify(value[i])??'null'));
        add(']');
      } else {
        const encoded=stringify(value);if(encoded===undefined)continue;
        add((first?'':',')+JSON.stringify(key)+':'+encoded);first=false;
      }
    }
    add('}');flush();closeSync(fd);fd=undefined;
    return {file,bytes,dispose};
  } catch(error) {if(fd!==undefined)closeSync(fd);dispose();throw error;}
}

export async function writeSpooledSnapshot(client,stateKey,encoded) {
  const key=Buffer.from(stateKey);
  async function* row(){yield header;yield int16(2);yield int32(key.length);yield key;yield int32(encoded.bytes);yield* createReadStream(encoded.file);yield int16(-1);}
  const target=client.query(copyFrom('COPY phone_cloud_state (state_key, data) FROM STDIN WITH (FORMAT binary)'));
  await pipeline(Readable.from(row(),{objectMode:false}),target);
  if(target.rowCount!==1)throw new Error('snapshot_copy_row_count');
}

// Decode a one-column COPY binary stream without holding its full JSON field.
export class SnapshotBinaryDecoder extends Transform {
  constructor(){super();this.stage='header';this.pending=Buffer.alloc(0);this.remaining=0;this.rows=0;}
  _transform(chunk,_encoding,callback){
    try {
      let b=this.pending.length?Buffer.concat([this.pending,chunk]):chunk;this.pending=Buffer.alloc(0);
      while(b.length){
        if(this.stage==='payload') {
          const n=Math.min(b.length,this.remaining);this.push(b.subarray(0,n));this.remaining-=n;b=b.subarray(n);
          if(!this.remaining)this.stage='fields';continue;
        }
        const needed=this.stage==='header'?19:this.stage==='fields'?2:this.stage==='length'?4:0;
        if(this.stage==='done')throw new Error('snapshot_copy_trailing_data');
        if(b.length<needed){this.pending=Buffer.from(b);break;}
        if(this.stage==='header'){
          if(!b.subarray(0,11).equals(signature)||b.readInt32BE(11)!==0||b.readInt32BE(15)!==0)throw new Error('snapshot_copy_header');
          this.stage='fields';
        }else if(this.stage==='fields'){
          const count=b.readInt16BE(0);
          if(count===-1)this.stage='done';
          else {if(count!==1||this.rows++)throw new Error('snapshot_copy_rows');this.stage='length';}
        }else{
          this.remaining=b.readInt32BE(0);if(this.remaining<=0)throw new Error('snapshot_copy_null_or_empty');this.stage='payload';
        }
        b=b.subarray(needed);
      }
      callback();
    }catch(e){callback(e);}
  }
  _flush(callback){callback(this.stage==='done'&&!this.pending.length?null:new Error('snapshot_copy_truncated'));}
}

// JSON.parse semantics for own keys (including __proto__), with no full JSON string.
class SafeAssembler extends Assembler {
  _saveValue(value){
    if(this.done)this.current=value;
    else if(Array.isArray(this.current))this.current.push(value);
    else {Object.defineProperty(this.current,this.key,{value,enumerable:true,writable:true,configurable:true});this.key=null;}
  }
  stringValue(value){this._saveValue(value);}
}
export async function readSnapshotStream(source) {
  const decoder=new SnapshotBinaryDecoder(), parser=new Parser({streamKeys:false,streamStrings:false,streamNumbers:false});
  const assembler=new SafeAssembler();let completed=0;
  const sink=new Writable({objectMode:true,write(token,_enc,cb){try{assembler.consume(token);if(assembler.done)completed++;cb();}catch(e){cb(e);}}});
  // Empty SELECT is represented by no JSON document; inject an empty object only
  // for the parser, then return null so bootstrap behavior remains unchanged.
  const emptySafe=new Transform({transform(b,_e,cb){this.push(b);cb();},flush(cb){if(!decoder.rows)this.push('{}');cb();}});
  await pipeline(source,decoder,emptySafe,parser,sink);
  if(!decoder.rows)return null;
  if(!assembler.done||completed!==1||!assembler.current||Array.isArray(assembler.current)||typeof assembler.current!=='object')throw new Error('snapshot_root_invalid');
  return assembler.current;
}
export async function loadStreamedSnapshot(pool,stateKey) {
  if(typeof stateKey!=='string'||stateKey.includes('\0'))throw new Error('snapshot_state_key');
  const client=await pool.connect();let failed=false;
  try {
    // COPY does not accept bind parameters; E literal escapes both slash and quote.
    const literal="E'"+stateKey.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
    return await readSnapshotStream(client.query(copyTo(`COPY (SELECT data FROM phone_cloud_state WHERE state_key = ${literal}) TO STDOUT WITH (FORMAT binary)`)));
  }catch(e){failed=true;throw e;}finally{client.release(failed);}
}
