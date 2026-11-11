// Run in the existing CPS image, with its restricted env file. No phone or
// callback actions; --apply requires every old journal coordinator to be gone.
import pg from '/app/node_modules/pg/lib/index.js';
import fs from 'node:fs/promises';import {createHash}from 'node:crypto';
import {seedSendJournal}from './seed-send-journal.mjs';
import {createStore}from '/app/server/cps-wecom/store.mjs';
import {createPlatform}from '/app/server/cps-wecom/platform.mjs';
const args=process.argv.slice(2);if(args.length>1||args.length===1&&args[0]!=='--apply')throw Error('invalid_arguments');
const apply=args[0]==='--apply',key='production',sourceKeys=['preview-20261110','preview-20261110-pilot200','preview-20261110-pilot202'];
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const requireFact=(v,code)=>{if(!v)throw Error(code);};
const pool=new pg.Pool({connectionString:process.env.CPS_DATABASE_URL,max:1,connectionTimeoutMillis:2000,statement_timeout:5000});
let client,transaction=false,phase='environment';
try{
 requireFact(process.env.CPS_EXECUTION_MODE==='preview'&&process.env.CPS_STATE_KEY==='preview-20261110','source_environment_changed');
 const clients=JSON.parse(process.env.CPS_WECOM_CLIENTS_JSON),members=clients.flatMap(c=>c.members);
 requireFact(clients.length===1&&members.length===2&&members.every(m=>m.enabled&&m.bindingVerified&&m.appSlot==='main')&&members.map(m=>m.deviceNumber).sort().join(',')==='200,202','member_scope_changed');
 phase='inventory';const platform=createPlatform({baseUrl:process.env.CPS_PLATFORM_BASE_URL,token:process.env.CPS_PLATFORM_TOKEN,mode:'preview'});
 const inventory=await platform.inventory(),ids=[];
 for(const m of members){const rows=inventory.devices.filter(d=>d.deviceNumber===m.deviceNumber);requireFact(rows.length===1&&rows[0].available&&rows[0].remarkPhoneReady,'target_not_ready');ids.push(rows[0].deviceId);}
 requireFact(ids.sort().join(',')==='adb:30620834210068C,adb:c06a13fa','physical_scope_changed');
 phase='source_snapshot';client=await pool.connect();await client.query(apply?'BEGIN':'BEGIN READ ONLY');transaction=true;
 if(apply)for(const name of [key,...sourceKeys]){const r=await client.query("SELECT pg_try_advisory_xact_lock(hashtext('phone_cloud_cps_wecom'),hashtext($1)) AS locked",[name]);requireFact(r.rows[0].locked,'journal_coordinator_active');}
 requireFact((await client.query('SELECT 1 FROM phone_cloud_cps_wecom WHERE state_key=$1',[key])).rowCount===0,'production_journal_already_exists');
 const rows=(await client.query('SELECT state_key,data FROM phone_cloud_cps_wecom WHERE state_key=ANY($1::text[]) ORDER BY state_key'+(apply?' FOR UPDATE':''),[sourceKeys])).rows;
 requireFact(rows.length===sourceKeys.length,'source_journal_missing');
 phase='build_seed';const sources=rows.map(r=>({key:r.state_key,data:r.data})),seed=seedSendJournal(sources),leads=seed.leads;
 phase='original_jobs';const history=JSON.parse(await fs.readFile('/app/send-history-audit.json','utf8')),jobs=history.originalJobs;
 requireFact(Array.isArray(jobs),'original_job_audit_missing');
 requireFact(jobs.length===leads.length,'original_job_missing');
 for(const lead of leads){const j=jobs.find(j=>j?.jobId===lead.jobId);requireFact(j&&j.mode==='preview'&&['succeeded','failed'].includes(j.status)&&j.requestId===lead.requestId&&j.deviceId===lead.deviceId&&j.appSlot===lead.target.appSlot&&j.result?.sendClaimed===false&&j.result?.invitationSent===false&&j.result?.sendStatus==='not_attempted','original_preview_not_confirmed');}
 // The CPS DB role cannot read main tables and older jobs are outside the API's
 // loaded history. Existing read-only host access supplies this narrow, fresh
 // audit; the immutable operator image binds its exact contents to this run.
 phase='send_history';
 const age=Date.now()-Date.parse(history.atUtc),historic=history.sendJobsOnCurrentPhones;
 requireFact(history.version===1&&history.deviceIds?.slice().sort().join(',')===ids.join(',')&&age>=0&&age<600000&&historic===0,'existing_phone_send_history_requires_reconciliation');
 // Validate against the exact deployed schema, using an ephemeral file only.
 phase='deployed_schema';const temporary='/tmp/cps-send-seed-validate.json';await fs.writeFile(temporary,JSON.stringify(seed),{flag:'wx',mode:0o600});
 const store=await createStore({file:temporary});await store.close();await fs.unlink(temporary);
 const audit={atUtc:new Date().toISOString(),apply,targetStateKey:key,sourceJournals:sources.map(s=>({key:s.key,revision:s.data.revision,sha256:hash(s.data),leadCount:s.data.leads.length})),seedSha256:hash(seed),seedLeads:seed.leads.length,seedRecipients:seed.recipients.length,seedNonces:seed.nonces.length,seedLimits:seed.limits.length,originalPreviewJobsChecked:jobs.length,historicSendsOnCurrentPhones:historic,oldPreviewJobsReplayed:0,callbacksInvoked:0};
 if(apply){
  await fs.mkdir('/receipt',{mode:0o700});
  await fs.writeFile('/receipt/journals.before.private.json',JSON.stringify(sources),{flag:'wx',mode:0o600});
  await fs.writeFile('/receipt/send-seed.private.json',JSON.stringify(seed),{flag:'wx',mode:0o600});
  await client.query('INSERT INTO phone_cloud_cps_wecom(state_key,data) VALUES($1,$2::jsonb)',[key,JSON.stringify(seed)]);
  await client.query('COMMIT');transaction=false;
  await fs.writeFile('/receipt/journal-activated.json',JSON.stringify(audit,null,2)+'\n',{flag:'wx',mode:0o600});
 }else{await client.query('ROLLBACK');transaction=false;}
 console.log(JSON.stringify(audit));
}catch(error){if(transaction)await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({ok:false,phase,code:/^[a-z_]{1,90}$/.test(error.message)?error.message:'seed_activation_failed',systemCode:/^[A-Z0-9_]{1,30}$/.test(error.code||'')?error.code:null}));process.exitCode=1;}
finally{client?.release();await pool.end();}
