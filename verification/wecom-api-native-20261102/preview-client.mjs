// Explicitly invoked production acceptance client. No Agent/bootstrap or ADB access.
// Approved account credentials come only from the existing app environment;
// the authorized phone arrives only on stdin and is never printed or persisted here.
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';

const origin = `http://127.0.0.1:${process.env.PORT || 8787}`;
const endpoint = '/api/v1/user/automation/wecom-preview-tasks';
const terminal = new Set(['succeeded', 'failed', 'expired', 'cancelled']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));

export function authorizedRequest(method, route, body) {
  if (method === 'GET' && (route === '/api/v1/wecom/devices'
      || route === '/api/v1/admin/lookup-pool'
      || route === '/api/v1/user/automation/wecom-preview-devices'
      || /^\/api\/v1\/user\/automation\/wecom-preview-tasks(?:\/[a-f0-9-]{36})?$/.test(route))) return true;
  if (method !== 'POST') return false;
  if (route === '/api/v1/auth/login') return true;
  return route === endpoint && body?.mode === 'preview' && body?.appSlot === 'main'
    && typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)
    && !Object.hasOwn(body, 'previewOnly') && !Object.hasOwn(body, 'send')
    && Object.keys(body).every(key => ['deviceId', 'appSlot', 'phoneNumber', 'remarkName', 'description', 'mode', 'requestId'].includes(key));
}

async function request(method, route, token, body) {
  if (!authorizedRequest(method, route, body)) throw Error('request_outside_preview_scope');
  const response = await fetch(origin + route, {
    method, redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let value; try { value = await response.json(); } catch { throw Error('response_outcome_unknown'); }
  if (!response.ok) throw Error(`http_${response.status}_${/^[a-z0-9_]+$/.test(value.error || '') ? value.error : 'request_failed'}`);
  return { httpStatus: response.status, value };
}

function publicJob(job) {
  return { jobId: job.jobId, deviceNumber: job.deviceNumber, appSlot: job.appSlot,
    mode: job.mode, requestId: job.requestId, status: job.status,
    createdAt: job.createdAt, completedAt: job.completedAt,
    result: { status: job.result?.status, code: job.result?.code,
      invitationSent: job.result?.invitationSent, sendStatus: job.result?.sendStatus,
      sendClaimed: job.result?.sendClaimed, remarkSaveStatus: job.result?.remarkSaveStatus,
      execution: job.result?.execution } };
}

async function databaseEvidence(jobId) {
  if (!process.env.DATABASE_URL) throw Error('readonly_database_not_configured');
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    application_name: 'wecom-preview-acceptance-readonly', connectionTimeoutMillis: 4000,
    statement_timeout: 1500, query_timeout: 2500 });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const job = (await client.query('SELECT data FROM phone_cloud_automation_jobs WHERE job_id=$1', [jobId])).rows[0]?.data;
    const task = job?.windowsTaskId ? (await client.query('SELECT data FROM phone_cloud_windows_tasks WHERE task_id=$1', [job.windowsTaskId])).rows[0]?.data : null;
    const binding = task?.payload?.physicalCleanup;
    const lock = binding?.obligationId ? (await client.query('SELECT data FROM phone_cloud_device_locks WHERE lock_id=$1', [binding.obligationId])).rows[0]?.data : null;
    const duty = lock?.physicalCleanup, generation = duty?.verification;
    const verify = generation?.verificationTaskId ? (await client.query('SELECT data FROM phone_cloud_windows_tasks WHERE task_id=$1', [generation.verificationTaskId])).rows[0]?.data : null;
    await client.query('COMMIT');
    return { readonlyPg: true, originalTaskId: task?.taskId || null, originalTaskStatus: task?.status || null,
      obligationId: lock?.lockId || null, obligationStatus: lock?.status || null, phase: duty?.phase || null,
      originalBindingMatches: Boolean(binding && isDeepStrictEqual(binding, duty?.binding)),
      hosts: duty?.hosts?.map(host => ({ role: host.role, pid: host.pid, createdAt: host.createdAt,
        hasExactCreationToken: /^0x1\.[0-9a-f]{13}p\+\d+$/.test(host.creationToken || ''),
        hasMachineId: /^[a-f0-9]{64}$/.test(host.machineId || '') })) || [],
      hostClosedAt: duty?.hostClosedAt || null, originalTerminalAt: duty?.originalTerminalAt || null,
      verificationTaskId: verify?.taskId || null, verificationStatus: verify?.status || null,
      verificationPickedAt: verify?.pickedAt || null, verificationResult: verify?.result?.cleanupVerified === true,
      verificationType: verify?.type || null,
      verificationBindingMatches: Boolean(verify && isDeepStrictEqual(verify.payload?.physicalCleanup, binding)),
      sameAgentAndDevice: Boolean(verify && verify.agentId === task?.agentId && binding?.agentId === task?.agentId
        && verify.deviceId === task?.deviceId && binding?.deviceId === task?.deviceId),
      proofBindingMatches: Boolean(duty?.proof && isDeepStrictEqual(duty.proof.binding, binding)),
      proofGenerationMatches: Boolean(duty?.proof && duty.proof.verificationTaskId === verify?.taskId
        && duty.proof.verificationId === generation?.verificationId && duty.proof.verificationNonce === generation?.verificationNonce),
      proofSnapshots: duty?.proof?.snapshots?.map(frame => ({ observedAt: frame.observedAt,
        packagesAbsent: frame.packagesAbsent, packageNames: frame.packageNames, serialForwardCount: frame.serialForwardCount })) || [],
      releasedAt: lock?.releasedAt || null, releaseReason: lock?.releaseReason || null,
      proofCommitTimesMatch: Boolean(lock?.releasedAt && lock.releasedAt === verify?.completedAt),
      originalSendClaimed: Boolean(job?.wecomSendClaimAt), originalJobStatus: job?.status || null };
  } finally { await client.end().catch(() => {}); }
}

async function main() {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const line = await new Promise(resolve => reader.once('line', resolve)); reader.close();
  const input = JSON.parse(line);
  if (!/^1[3-9]\d{9}$/.test(input.phoneNumber || '') || !input.phoneNumber.endsWith('6441')
      || input.deviceNumber !== '43' || input.mode !== 'preview') throw Error('acceptance_target_outside_scope');
  const resourceAge = Date.now() - Date.parse(input.resourceCheckedAt);
  if (!Number.isFinite(resourceAge) || resourceAge < -5000 || resourceAge > 45000
      || !Number.isInteger(input.spareSlots) || input.spareSlots < 1) throw Error('resource_evidence_stale_or_full');
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) throw Error('approved_admin_env_unavailable');
  const login = await request('POST', '/api/v1/auth/login', '', { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
  const token = login.value.session?.token; if (!token) throw Error('admin_session_unavailable');
  const inventory = (await request('GET', '/api/v1/wecom/devices', token)).value;
  const pool = (await request('GET', '/api/v1/admin/lookup-pool', token)).value.pool;
  const catalog = (await request('GET', '/api/v1/user/automation/wecom-preview-devices', token)).value.devices;
  const mapping = catalog.filter(device => String(device.deviceNumber) === '43');
  const phone = inventory.devices.filter(device => String(device.deviceNumber) === input.deviceNumber);
  if (phone.length !== 1 || !phone[0].available || phone[0].busy || !phone[0].adbOnline || !phone[0].agentOnline
      || inventory.capacity.remaining < 1 || mapping.length !== 1 || !mapping[0].available
      || !mapping[0].appSlots.some(slot => slot.appSlot === 'main')
      || pool.devices.some(device => device.enabled && String(device.deviceNumber) === input.deviceNumber)) throw Error('fresh_device_or_pool_guard_failed');
  const internal = (await request('GET', '/api/v1/user/automation/wecom-preview-tasks', token)).value;
  if (internal.tasks.some(task => task.requestId === input.requestId)) throw Error('intent_already_submitted_use_original_result');
  // Device identity comes from the fresh authenticated inventory's matching fixed
  // mapping, supplied by the local preflight from the official preview catalog.
  const body = { deviceId: mapping[0].deviceId, appSlot: 'main', phoneNumber: input.phoneNumber,
    remarkName: '测试客户', description: '接口联调测试', mode: 'preview', requestId: input.requestId };
  emit({ stage: 'submit_attempt', requestId: input.requestId, deviceNumber: '43', mode: 'preview', phoneSuffix: '6441' });
  const accepted = await request('POST', endpoint, token, body);
  const jobId = accepted.value.task?.jobId; if (!/^[a-f0-9-]{36}$/.test(jobId || '')) throw Error('submission_outcome_unknown');
  emit({ stage: 'accepted', httpStatus: accepted.httpStatus, job: publicJob(accepted.value.task) });
  const replay = await request('POST', endpoint, token, body);
  emit({ stage: 'same_request_replay', httpStatus: replay.httpStatus, sameJobId: replay.value.task?.jobId === jobId, reused: replay.value.reused === true });
  const deadline = Date.now() + 420000; let lastKey = '', lastPgAt = 0, job, proof, terminalAt = 0;
  while (Date.now() < deadline) {
    job = (await request('GET', `${endpoint}/${jobId}`, token)).value.task;
    const devices = (await request('GET', '/api/v1/wecom/devices', token)).value.devices;
    const current = devices.find(device => String(device.deviceNumber) === '43');
    const key = JSON.stringify([job.status, job.result?.code, current?.available, current?.busyReason]);
    if (key !== lastKey) { emit({ stage: 'observation', job: publicJob(job), device: { available: current?.available, busy: current?.busy, busyReason: current?.busyReason } }); lastKey = key; }
    if (Date.now() - lastPgAt >= 10000 || terminal.has(job.status)) {
      try { proof = await databaseEvidence(jobId); emit({ stage: 'physical_evidence', evidence: proof }); }
      catch { emit({ stage: 'physical_evidence_unavailable', code: 'readonly_pg_evidence_unavailable' }); }
      lastPgAt = Date.now();
    }
    if (terminal.has(job.status) && !terminalAt) terminalAt = Date.now();
    if (terminalAt && (proof?.obligationStatus === 'released' || proof?.verificationStatus === 'failed'
        || Date.now() - terminalAt > 90000)) {
      const succeeded = job.status === 'succeeded' && job.result?.status === 'ready_before_send'
        && job.result?.invitationSent === false && job.result?.sendStatus === 'not_attempted'
        && !job.result?.sendClaimed && proof?.obligationStatus === 'released' && proof.verificationResult
        && proof.originalBindingMatches && proof.proofBindingMatches && proof.proofGenerationMatches
        && proof.verificationBindingMatches && proof.sameAgentAndDevice && proof.proofCommitTimesMatch
        && proof.releaseReason === 'wecom_physical_verified' && proof.hostClosedAt && proof.hosts.length === 1
        && proof.proofSnapshots.length === 2 && proof.proofSnapshots.every(frame => frame.packagesAbsent && frame.serialForwardCount === 0);
      emit({ stage: 'final', succeeded, job: publicJob(job), physicalEvidence: proof,
        currentDeviceAvailable: current?.available, realInvitationAttempted: false,
        note: 'Preview may fill empty remarks; no invitation endpoint or send claim was called.' });
      process.exitCode = succeeded ? 0 : 1; return;
    }
    await sleep(2000);
  }
  throw Error('bounded_observation_ended_original_task_retained');
}

if (process.argv.includes('--accept-preview')) {
  await main().catch(error => {
    emit({ stage: 'client_failure_original_task_retained', code: /^[a-z0-9_]+$/.test(error.message || '') ? error.message : 'acceptance_outcome_unconfirmed' });
    process.exitCode = 1;
  });
}
