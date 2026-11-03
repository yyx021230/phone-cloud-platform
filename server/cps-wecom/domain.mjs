import {createHash} from 'node:crypto';
import {failure} from './protocol.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const memberIdentity=value=>digest([value.wecom_corp_id,value.wecom_userid]);
export const recipientIdentity=value=>digest([value.wecom_corp_id,value.wecom_userid,value.phone]);
export function remarkName(input) {
  const value=input.phone+'_'+input.lead_id;
  if([...value].length>20)throw failure(2003,'备注名超过20字符，请CPS按约定处理；平台不会截断或改换格式');
  return value;
}
// Business-day policy is explicit and independent of the host timezone.
export const businessDay=ms=>Math.floor((ms+8*3600000)/86400000);
export const businessDayEnd=ms=>(businessDay(ms)+1)*86400000-8*3600000;
export function memberLimit(state,member,now) {
  const id=memberIdentity(member);
  return state.limits.find(r=>r.key===id&&(r.until===null||r.until>now));
}
