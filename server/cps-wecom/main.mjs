import path from 'node:path';
import pg from 'pg';
import {parseClients} from './protocol.mjs';
import {createStore} from './store.mjs';
import {createPlatform} from './platform.mjs';
import {createService} from './service.mjs';
import {createHttpServer,listen} from './http.mjs';

// Separate opt-in bridge. Do not load the platform .env or inherit its startup,
// media, Agent, ADB lifecycle or scheduled maintenance.
if(process.env.CPS_WECOM_ENABLED!=='true')throw Error('cps_bridge_disabled');
const clients=parseClients(process.env.CPS_WECOM_CLIENTS_JSON);
if(clients.size===0)throw Error('cps_clients_required');
const production=process.env.NODE_ENV==='production';
if(production&&[...clients.values()].some(c=>!c.callbackUrl.startsWith('https:')))throw Error('cps_https_callback_required');
if(production&&!process.env.CPS_DATABASE_URL)throw Error('cps_production_requires_postgres');
if(!['preview','send'].includes(process.env.CPS_EXECUTION_MODE))throw Error('cps_explicit_execution_mode_required');
const upstream=new URL(process.env.CPS_PLATFORM_BASE_URL);
if(production&&upstream.protocol!=='https:'&&!['127.0.0.1','[::1]'].includes(upstream.hostname))throw Error('cps_secure_platform_transport_required');
const platform=createPlatform({baseUrl:process.env.CPS_PLATFORM_BASE_URL,token:process.env.CPS_PLATFORM_TOKEN,mode:process.env.CPS_EXECUTION_MODE});
let pool;
const store=await createStore(process.env.CPS_DATABASE_URL?{getPool:async()=>pool||=new pg.Pool({connectionString:process.env.CPS_DATABASE_URL,connectionTimeoutMillis:2000,statement_timeout:5000,max:3}),key:process.env.CPS_STATE_KEY||'default'}:{file:path.resolve(process.env.CPS_DATA_DIR||'data/cps-wecom','journal.json')});
const service=createService({store,clients,platform});
try{await service.initialize();}catch{await service.close();await pool?.end();throw Error('cps_bridge_initialization_failed');}
const server=createHttpServer(service);let lastStatus='';
const timer=setInterval(async()=>{
  try{await service.tick();const status=JSON.stringify(service.status());if(status!==lastStatus){lastStatus=status;console.info('CPS bridge state: '+status);}}
  catch{console.warn('CPS bridge unavailable; original leads retained');}
},1000).unref();
await listen(server,Number(process.env.CPS_PORT||8797),'127.0.0.1');
console.log('CPS WeCom bridge listening on loopback; execution mode: '+platform.mode);
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(timer);await new Promise(r=>server.close(r));await service.close();await pool?.end();}
process.on('SIGTERM',()=>close().catch(()=>{process.exitCode=1;}));process.on('SIGINT',()=>close().catch(()=>{process.exitCode=1;}));
