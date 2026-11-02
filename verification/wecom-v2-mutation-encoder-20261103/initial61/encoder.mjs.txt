// Verification-only canonical tree leaf. No parser, storage, authority or I/O.
import {createHash} from "node:crypto";
import {types} from "node:util";
const PREFIX=Buffer.from("WCMUT1\0","utf8"),MAX_BYTES=262144,MAX_NODES=50000,MAX_DEPTH=24;
const fail=code=>{throw new Error(`wecom_fixture_encode_${code}`);};
function unicode(s){for(let i=0;i<s.length;i++){const n=s.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const m=s.charCodeAt(++i);if(!(m>=0xdc00&&m<=0xdfff))fail("unicode");}else if(n>=0xdc00&&n<=0xdfff)fail("unicode");}}
function scalarCompare(a,b){let i=0,j=0;while(i<a.length&&j<b.length){const x=a.codePointAt(i),y=b.codePointAt(j);if(x!==y)return x<y?-1:1;i+=x>0xffff?2:1;j+=y>0xffff?2:1;}return i<a.length?1:j<b.length?-1:0;}
export function encodeMutationTree(value){
  const chunks=[],active=new Set();let bytes=0,nodes=0;
  function push(b){if(bytes+b.length>MAX_BYTES)fail("bytes");bytes+=b.length;chunks.push(b);}
  function header(tag,length){const b=Buffer.allocUnsafe(5);b[0]=tag;b.writeUInt32BE(length,1);push(b);}
  function text(s){unicode(s);const n=Buffer.byteLength(s,"utf8");if(bytes+5+n>MAX_BYTES)fail("bytes");header(3,n);push(Buffer.from(s,"utf8"));}
  function node(depth){if(depth>MAX_DEPTH)fail("depth");if(++nodes>MAX_NODES)fail("nodes");}
  function visit(v,depth){
    node(depth);
    if(v===null){push(Buffer.from([0]));return;}
    if(typeof v==="boolean"){push(Buffer.from([v?2:1]));return;}
    if(typeof v==="string"){text(v);return;}
    if(typeof v==="number"){
      if(!Number.isFinite(v)||Object.is(v,-0)||(Number.isInteger(v)&&!Number.isSafeInteger(v)))fail("number");
      const b=Buffer.allocUnsafe(9);b[0]=4;b.writeDoubleBE(v,1);push(b);return;
    }
    if(typeof v!=="object"||types.isProxy(v))fail("structure");
    if(active.has(v))fail("cycle");
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail("prototype");
    const keys=Reflect.ownKeys(v);if(keys.some(k=>typeof k!=="string"))fail("structure");
    const descriptors=new Map();
    for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,"value")||(!d.enumerable&&!(array&&k==="length")))fail("structure");descriptors.set(k,d);}
    active.add(v);
    try{
      if(array){
        const n=descriptors.get("length")?.value;
        if(!Number.isSafeInteger(n)||n<0)fail("structure");
        if(n>MAX_NODES-nodes)fail("nodes");
        if(keys.length!==n+1)fail("structure");
        for(let i=0;i<n;i++)if(!descriptors.has(String(i)))fail("structure");
        header(5,n);for(let i=0;i<n;i++)visit(descriptors.get(String(i)).value,depth+1);
      }else{
        for(const k of keys)unicode(k);
        keys.sort(scalarCompare);header(6,keys.length);
        for(const k of keys){node(depth+1);text(k);visit(descriptors.get(k).value,depth+1);}
      }
    }finally{active.delete(v);}
  }
  push(Buffer.from(PREFIX));visit(value,0);return Buffer.concat(chunks,bytes);
}
export function fingerprintMutationTree(value){return createHash("sha256").update(encodeMutationTree(value)).digest("hex");}
