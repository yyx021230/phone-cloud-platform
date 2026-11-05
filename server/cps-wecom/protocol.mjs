import {createHash, timingSafeEqual} from 'node:crypto';

export const AUTH_FIELDS = new Set(['app_id', 'timestamp', 'nonce', 'sign']);
export const ROUTES = Object.freeze({dispatch:'/api/v1/lead/dispatch', devices:'/api/v1/lead/devices/query'});
export const failure = (code, message, httpStatus=200) => Object.assign(new Error(message), {businessCode:code, httpStatus});
const fields = new Set(['lead_id','phone','wecom_phone','wecom_userid','wecom_corp_id','city_id','city_name','cmb_id','cmb_name','cmd_id','cmd_name',...AUTH_FIELDS]);

// Flat JSON only, with duplicate-key rejection and lossless signed INT64 tokens.
// JSON.parse would round a CPS lead_id before signature verification.
export function parseBody(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw)>16384) throw failure(2003,'请求体超过限制',413);
  let i=0; const result=Object.create(null), skip=()=>{while(/[ \t\r\n]/.test(raw[i]||'')&&i<raw.length)i++;};
  function string() {
    const start=i++; let escaped=false;
    while(i<raw.length) { const c=raw[i++]; if(c==='"'&&!escaped)return JSON.parse(raw.slice(start,i)); if(c==='\\'&&!escaped)escaped=true;else escaped=false; }
    throw failure(2003,'JSON字符串不完整',400);
  }
  try {
    skip();if(raw[i++]!=='{')throw Error();skip();
    if(raw[i]==='}')i++;
    else while(i<raw.length) {
      if(raw[i]!=='"')throw Error(); const key=string();skip();if(raw[i++]!==':')throw Error();skip();
      if(Object.hasOwn(result,key)||['__proto__','prototype','constructor'].includes(key))throw Error();
      let value;
      if(raw[i]==='"')value=string();
      else if(raw.startsWith('true',i)){value=true;i+=4;}
      else if(raw.startsWith('false',i)){value=false;i+=5;}
      else if(raw.startsWith('null',i)){value=null;i+=4;}
      else {const number=raw.slice(i).match(/^-?(?:0|[1-9]\d*)/);if(!number)throw Error();i+=number[0].length;
        value=key==='lead_id'?BigInt(number[0]):Number(number[0]);if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error();}
      result[key]=value;skip();const end=raw[i++];if(end==='}')break;if(end!==',')throw Error();skip();
    }
    const end=i;skip();if(i!==raw.length||raw[end-1]!=='}')throw Error();return result;
  } catch(error) { if(error.businessCode)throw error;throw failure(2003,'请求必须是无重复字段的简单JSON对象，lead_id须为整数',400); }
}

export function stringifyBody(value) {
  return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+':'+(typeof v==='bigint'?v.toString():JSON.stringify(v))).join(',')+'}';
}
export function signature(body, secret) {
  const plain=Object.keys(body).filter(k=>k!=='sign'&&body[k]!==null&&body[k]!=='').sort()
    .map(k=>`${k}=${body[k]}`).join('&')+'&secret='+secret;
  return createHash('sha256').update(plain,'utf8').digest('hex');
}
export function authenticate(body, clients, now=Date.now()) {
  const client=typeof body.app_id==='string'?clients.get(body.app_id):null;
  if(!client||typeof body.sign!=='string'||!/^[a-f0-9]{64}$/.test(body.sign))throw failure(1001,'签名验证失败',401);
  if(!timingSafeEqual(Buffer.from(signature(body,client.secret),'hex'),Buffer.from(body.sign,'hex')))throw failure(1001,'签名验证失败',401);
  if(!Number.isSafeInteger(body.timestamp)||Math.abs(now-body.timestamp)>300000)throw failure(1002,'时间戳过期',401);
  if(typeof body.nonce!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(body.nonce))throw failure(2003,'nonce格式错误',400);
  return client;
}
export function dispatchInput(body) {
  if(Object.keys(body).some(k=>!fields.has(k)))throw failure(2003,'包含未约定的下发字段');
  if(typeof body.lead_id!=='bigint'||body.lead_id<=0n||body.lead_id>9223372036854775807n)throw failure(2003,'lead_id必须为正的INT64');
  if(typeof body.phone!=='string'||!/^1[3-9]\d{9}$/.test(body.phone))throw failure(2003,'客户手机号格式错误');
  const business={lead_id:body.lead_id.toString(),phone:body.phone};
  if(body.wecom_phone!==undefined){
    if(typeof body.wecom_phone!=='string'||!/^1[3-9]\d{9}$/.test(body.wecom_phone))throw failure(2003,'企微登录手机号wecom_phone格式错误');
    business.wecom_phone=body.wecom_phone;
  }
  for(const k of ['wecom_userid','wecom_corp_id']) {
    if(typeof body[k]!=='string'||!body[k]||body[k].length>128||/[\u0000-\u0020\u007f&=]/.test(body[k]))throw failure(2003,'企微企业或成员标识格式错误');
    business[k]=body[k];
  }
  for(const k of ['city_id','city_name','cmb_id','cmb_name','cmd_id','cmd_name']) {
    if(body[k]===undefined||body[k]===null||body[k]==='')continue;
    if(typeof body[k]!=='string'||[...body[k]].length>100||/[\u0000-\u001f\u007f]/.test(body[k]))throw failure(2003,'可选业务字段格式错误');
    business[k]=body[k];
  }
  return business;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(Object.keys(value).sort().map(k=>[k,value[k]]))).digest('hex');
export const memberKey = value => value.wecom_phone?JSON.stringify(['wecom_phone',value.wecom_phone]):JSON.stringify([value.wecom_corp_id,value.wecom_userid]);

export function parseClients(raw) {
  let input;try{input=JSON.parse(raw||'[]');}catch{throw Error('cps_clients_config_invalid');}
  if(!Array.isArray(input)||input.length>20)throw Error('cps_clients_config_invalid');
  const result=new Map();const slots=new Set();const officialMembers=new Set();const accountPhones=new Set();
  for(const row of input) {
    if(!row||typeof row.appId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(row.appId)||typeof row.secret!=='string'||row.secret.length<16||result.has(row.appId)||!Array.isArray(row.members)||row.members.length>500)throw Error('cps_clients_config_invalid');
    let callback;try{callback=new URL(row.callbackUrl);}catch{throw Error('cps_callback_config_invalid');}
    const loopback=['127.0.0.1','[::1]'].includes(callback.hostname);
    if(callback.username||callback.password||callback.hash||callback.search||(callback.protocol!=='https:'&&!(row.allowLoopbackTest===true&&loopback&&callback.protocol==='http:')))throw Error('cps_callback_config_invalid');
    const members=new Map();
    const phoneRouting=row.members.some(m=>m?.wecom_phone!==undefined);
    for(const m of row.members) {
      const official=['wecom_corp_id','wecom_userid'].every(k=>typeof m?.[k]==='string'&&m[k]&&m[k].length<=128&&!/[\u0000-\u0020\u007f&=]/.test(m[k]));
      if(!m||!/^[1-9]\d{0,2}$/.test(m.deviceNumber)||!['main','clone'].includes(m.appSlot)
        ||phoneRouting&&(typeof m.wecom_phone!=='string'||!/^1[3-9]\d{9}$/.test(m.wecom_phone))
        ||(!phoneRouting||m.wecom_corp_id!==undefined||m.wecom_userid!==undefined)&&!official)throw Error('cps_member_config_invalid');
      if(m.wecom_name!==undefined&&(typeof m.wecom_name!=='string'||m.wecom_name!==m.wecom_name.trim()||[...m.wecom_name].length<1||[...m.wecom_name].length>80||/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(m.wecom_name)))throw Error('cps_member_name_invalid');
      const key=memberKey(m),physical=JSON.stringify([m.deviceNumber,m.appSlot]);
      const officialKey=JSON.stringify([m.wecom_corp_id,m.wecom_userid]);
      if(members.has(key)||slots.has(physical)||official&&officialMembers.has(officialKey)||phoneRouting&&accountPhones.has(m.wecom_phone))throw Error('cps_member_config_conflict');
      if(m.bindingVerified!==undefined&&typeof m.bindingVerified!=='boolean'||m.enabled!==undefined&&typeof m.enabled!=='boolean')throw Error('cps_member_config_invalid');
      members.set(key,{...m,bindingVerified:m.bindingVerified===true,enabled:m.enabled!==false});slots.add(physical);if(official)officialMembers.add(officialKey);if(phoneRouting)accountPhones.add(m.wecom_phone);
    }
    result.set(row.appId,{appId:row.appId,secret:row.secret,callbackUrl:callback.href,members,phoneRouting,allDeviceStatus:row.allDeviceStatus===true});
  }
  return result;
}
