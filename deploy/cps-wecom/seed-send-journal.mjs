// First production activation only. The source preview journals are immutable;
// this copies inactive history and conservative recipient guards, never work.
import {isDeepStrictEqual as equal} from 'node:util';
const deny=()=>{throw Error('cps_send_seed_ineligible');};
const inactive=new Set(['needs_attention','preview_complete']);
const strength={not_sent:0,reserved:1,submission_unknown:2,submitted:2,already_contact:3,request_confirmed:3,unknown:4};
export function seedSendJournal(sources){
 if(!Array.isArray(sources)||!sources.length)deny();
 const leads=new Map(),recipients=new Map(),nonces=new Map(),limits=new Map(),keys=new Set();
 for(const {key,data:s}of sources){
  if(typeof key!=='string'||!key.startsWith('preview-')||keys.has(key)||s?.version!==2||s.executionMode!=='preview'
    ||!Number.isSafeInteger(s.revision)||s.revision<0||!['leads','recipients','nonces','limits'].every(k=>Array.isArray(s[k])))deny();
  keys.add(key);
  for(const lead of s.leads){
   if(!inactive.has(lead.stage)||lead.attempts!==0||lead.outcome!=null||typeof lead.appId!=='string'||typeof lead.leadId!=='string')deny();
   const id=JSON.stringify([lead.appId,lead.leadId]);
   if(leads.has(id)&&!equal(leads.get(id),lead))deny();
   leads.set(id,structuredClone(lead));
  }
  for(const r of s.recipients){
   if(!Object.hasOwn(strength,r.state)||!s.leads.some(l=>l.appId===r.appId&&l.leadId===r.leadId&&l.recipientKey===r.key))deny();
   const prior=recipients.get(r.key);
   if(prior&&prior.physicalKey!==r.physicalKey)deny();
   if(!prior||strength[r.state]>strength[prior.state]||strength[r.state]===strength[prior.state]&&r.updatedAt>prior.updatedAt)recipients.set(r.key,structuredClone(r));
  }
  for(const n of s.nonces){const old=nonces.get(n.key);if(!old||n.expiresAt>old.expiresAt)nonces.set(n.key,structuredClone(n));}
  for(const l of s.limits){const old=limits.get(l.key);if(!old||l.until===null||old.until!==null&&l.until>old.until)limits.set(l.key,structuredClone(l));}
 }
 return {version:2,revision:0,executionMode:'send',leads:[...leads.values()],recipients:[...recipients.values()],
  nonces:[...nonces.values()],limits:[...limits.values()]};
}
