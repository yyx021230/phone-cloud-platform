import pg from 'pg';
const client=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:'wecom23-original-readonly',connectionTimeoutMillis:4000});await client.connect();
try{await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='3000ms'");
const job='680a14a8-3988-4eb4-ad45-734bfafa03fd';
const j=await client.query("SELECT job_id,status,device_id,data->>'windowsTaskId' AS windows_task_id,data->>'lockId' AS lock_id,data->>'createdAt' AS created_at,data->>'completedAt' AS completed_at,data#>>'{result,previewCode}' AS code FROM phone_cloud_automation_jobs WHERE job_id=$1",[job]);
const t=await client.query("SELECT task_id,status,agent_id,data->>'createdAt' AS created_at,data->>'pickedAt' AS picked_at,data->>'completedAt' AS completed_at,data#>>'{payload,physicalCleanup,obligationId}' AS obligation_id,data#>>'{result,error}' AS error,data->'events' AS events FROM phone_cloud_windows_tasks WHERE task_id=$1",[j.rows[0].windows_task_id]);
const l=await client.query("SELECT lock_id,status,data->>'lockType' AS lock_type,data->>'createdAt' AS created_at,data->>'updatedAt' AS updated_at,data#>>'{physicalCleanup,phase}' AS phase,data#>>'{physicalCleanup,binding,originalTaskId}' AS original_task_id,data#>>'{physicalCleanup,originalTerminalAt}' AS original_terminal_at,data#>>'{physicalCleanup,hostClosedAt}' AS host_closed_at,data#>'{physicalCleanup,hosts}' AS hosts FROM phone_cloud_device_locks WHERE lock_id=$1 OR data#>>'{physicalCleanup,originalJobId}'=$2",[j.rows[0].lock_id,job]);
await client.query('ROLLBACK');const out={at:new Date().toISOString(),jobs:j.rows,tasks:t.rows,locks:l.rows};console.log(JSON.stringify(out).replace(/1[3-9][0-9]{9}/g,'[masked-phone]'));
}finally{await client.end();}
