import fs from 'node:fs';import vm from 'node:vm';
import {buildLookupCardStatus} from '../server/device-occupancy.mjs';
import {renderLookupCardStatus} from '../public/lookup-card-status.js';
const src=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const fn=name=>{const start=src.indexOf(`function ${name}(`);return src.slice(start,src.indexOf('\nfunction ',start+1));};
const c=vm.createContext({renderLookupCardStatus,state:{},userDevicePresence:()=>({key:'online',signal:'在线',hint:'本地模拟预览'}),userLatestTaskLabel:()=> 'API 查名字',escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),deviceInitial:()=> 'V',deviceBrandLabel:()=> 'vivo',batteryLabel:()=> '82%',shortTime:()=> '16:30',displayPhoneNumber:()=> ''});
vm.runInContext(fn('renderDeviceOccupancy')+fn('renderUserDeviceCard'),c);
const fixtures=[
 {status:'ready',results:[{status:'needs_human_verification',limitReason:'jigsaw_verification'}]},
 {status:'failed',jobs:[{jobId:'j',sessionId:'s',kind:'alipay_name_switch',status:'failed',result:{errorCode:'alipay_login_required'}}]},
 {status:'querying',pendingJobId:'q'}, {status:'ready'}, {status:'stopping'}, {status:'switching',pendingJobId:'sw'}
];
const cards=fixtures.map((s,i)=>{c.device={deviceId:`fixture-${i}`,deviceName:`模拟 ${i+1} 号`,adbOnline:true,model:'Vivo',androidVersion:'13',occupancy:{ownerLabel:'系统任务',label:'支付宝查名字',lookup:buildLookupCardStatus({sessionId:'s',...s},null,s.jobs||[])}};return vm.runInContext('renderUserDeviceCard(device)',c);}).join('');
fs.writeFileSync(new URL('../public/card-preview.html',import.meta.url),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="styles.css"><style>body{padding:24px}h1{font-size:20px}.preview{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:18px;max-width:1140px}.preview .device-card{width:auto;min-width:0}</style><body class="user-chrome"><h1>查名卡片状态 · 本地模拟</h1><div class="preview user-device-inventory-view">${cards}</div></body></html>`);
