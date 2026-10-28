import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as policy from './pnp-recovery-policy.mjs';
import * as wave from './pnp-recovery-wave.mjs';
import * as state from './device-recovery-state.mjs';
const source = await fs.readFile(new URL('./index.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function requestSafePnpRescanForMissingDevices(');
const end = source.indexOf('\nasync function loadPnpRecoveryState(', start);
assert(start > 0 && end > start);

async function batch({ installer = 'busy', rows = ['PNP', 'ADB'], limit = 1, busy = [], paused = [], probes = [] } = {}) {
  const commands = [], events = [], wakes = [], attempts = new Map();
  let probeCount = 0;
  if(rows.includes('ADB')) attempts.set('ADB',{policyVersion:5,attempts:0,lastAttemptAt:1,actionHistory:[]});
  const observations = rows.map(serial => ({ key: serial, serial, physicalPresent: true,
    state: serial.startsWith('ADB') ? 'adb_offline' : 'adb_interface_ready_transport_missing',
    physical: { adbInterfaceInstanceId: `USB\\VID_2D95&MI_02\\${serial}`, rootInstanceId: `USB\\VID_2D95\\${serial}` }
  }));
  const devices = observations.filter(x => x.state === 'adb_offline').map(x => ({adbSerial:x.serial,state:'offline'}));
  const probe = () => { const value = probes[probeCount++] || installer; return {state:value,busy:value!=='idle',reason:value==='busy'?'device_install_busy':value==='unknown'?'device_install_probe_failed':'',processes:[]}; };
  const ctx = {
    ...policy, ...wave, ...state, Date, Set, Map, Promise, os:{platform:()=>'win32'},
    config:{ pnpRecoveryStableSeconds:10,pnpRecoveryStableScans:2,pnpRescanCooldownSeconds:60,pnpRecoveryAbsentResetSeconds:60,pnpMaxAutomaticAttemptsPerDevice:5,pnpMaxTargetRecoveriesPerPass:limit,pnpDeviceInstallPollSeconds:5,pnpTargetResetCooldownSeconds:1,pnpTargetRetryMaxSeconds:30,pnpTargetAbsentRetrySeconds:30,pnpTargetRecoveryConcurrency:8,pnpContinuousRecoveryEnabled:true,pnpPostActionProbeSeconds:5,adbPath:'fixture-adb'},
    pnpTargetRecoveryAttempts:attempts,observeAdbRecoveryVerification:x=>({state:x}),observePhysicalAbsence:x=>({state:x}),
    serialAdbActivity:{activeCount:serial=>busy.includes(serial)?1:0},isDeviceSerialReserved:()=>false,
    lastPhysicalPnpCandidateScanAt:Date.now(),lastPhysicalPnpInventory:[],lastPhysicallyPresentAndroidUsbSerials:rows,
    isPhysicalPnpInventoryReady:()=>true,deviceScanPipeline:{snapshot:()=>({observedAt:Date.now(),devices})},
    lastDeviceRecoveryObservations:[],buildDeviceRecoveryObservations:()=>observations,cachedAdbSerials:()=>rows,lastServerDevicesById:new Map(),
    pnpRecoveryJournal:{observeTransitions:()=>{},record:e=>events.push(e)},appendPhysicalRecoveryRows:()=>{},
    screenControlledSerials:new Set(),activeTaskSerials:new Set(),pnpRecoveryControl:{paused:()=>paused.map(serial=>({serial})),reason:s=>paused.includes(s)?'device_recovery_paused':''},
    recoveryIsolation:{health:()=>({isolated:[]}),reason:()=>'',confirmed:async()=>{},failure:async()=>{},isolate:async()=>{}},
    pnpRecoverySafety:{observe:(_o,c)=>({actionableCount:rows.length,canMutate:!c.installerBusy,blockedReason:c.installerBusy?'device_install_busy':'',circuitOpen:false}),recordAction:()=>{},health:()=>({}),recordFailure:()=>{}},
    publicPnpRecoveryHealth:x=>x,lastPnpRecoveryHealth:{},logPnpRecoverySafetyTransition:()=>{},schedulePnpRecoveryStateSave:()=>{},
    preemptBackgroundSmsSyncForPnpRecovery:async()=>{},pnpMissingDeviceRecovery:{observe:()=>({missing:rows,resetSerials:rows,rescanSerials:[]}),markReset:()=>{}},scheduleNextPnpRecoveryDueWake:()=>{},
    inspectWindowsDeviceInstallActivity:async()=>probe(),pnpRecoveryWakeScheduler:{schedule:(...x)=>wakes.push(x)},
    pnpRecoveryAdmissionReason:()=>'',recoverySnapshotAdmission:()=>'',skipRecoveryIfAdbAlreadyOnline:async()=>false,
    persistPnpRecoveryStateNow:async()=>{},pnpScreenCoordinator:{tryBegin:()=>()=>{}},log:()=>{},cleanLogText:String,delay:async()=>{},
    run:async(_exe,args)=>{commands.push(args);return args[0]==='devices'?'List of devices attached\n':'ok';},
    parseAdbDevices:()=>[],executePnpRecoveryAction:async plan=>{commands.push(['pnp',plan.instanceId]);return {result:'ok'};}
  };
  await vm.runInNewContext('('+source.slice(start,end)+')',ctx)(devices);
  return {commands,events,wakes,attempts,probeCount};
}
for (const installer of ['busy', 'unknown']) {
  test(`${installer} installer does not starve reconnect behind PnP at capacity one`,async()=>{
    const r=await batch({installer});assert(r.commands.some(args=>args.join(' ')==='-s ADB reconnect'));
    assert(!r.commands.some(args=>args[0]==='pnp'));assert(!r.attempts.has('PNP'));
    assert(r.wakes.length);assert(r.events.some(e=>e.serial==='PNP'&&e.type==='deferred'));
  });
}
test('mixed busy batch still reconnects its offline phone',async()=>{const r=await batch({limit:2});assert(r.commands.some(args=>args.join(' ')==='-s ADB reconnect'));assert(!r.commands.some(args=>args[0]==='pnp'));});
test('installer idle permits both recovery kinds',async()=>{
  const r=await batch({installer:'idle',limit:2});assert(r.commands.some(args=>args[0]==='pnp'));assert(r.commands.some(args=>args.join(' ')==='-s ADB reconnect'));
});
test('transport-only wave never probes installer',async()=>{
  const r=await batch({rows:['ADB']});assert.equal(r.probeCount,0);assert(r.commands.some(args=>args.join(' ')==='-s ADB reconnect'));
});
test('busy or paused transport target cannot use installer bypass',async()=>{
  for(const options of [{busy:['ADB']},{paused:['ADB']}]) {const r=await batch({...options});assert.equal(r.commands.length,0);}
});
test('installer becomes busy after selection: PnP defers with zero attempts, reconnect continues',async()=>{
  const r=await batch({installer:'busy',probes:['idle','busy'],limit:2});assert(!r.commands.some(args=>args[0]==='pnp'));assert(r.commands.some(args=>args.join(' ')==='-s ADB reconnect'));assert.equal(r.attempts.get('PNP')?.attempts||0,0);
});
test('recovery wake still invokes scan while installer remains busy',async()=>{
  const start=source.indexOf('pnpRecoveryWakeScheduler = createPnpRecoveryWakeScheduler({');
  const end=source.indexOf('\nconst serialAdbActivity',start);assert(start>0&&end>start);
  const scans=[];let captured;const ctx={config:{pnpDeviceInstallPollSeconds:5},createPnpRecoveryWakeScheduler:o=>(captured=o,{schedule:()=>{}}),inspectWindowsDeviceInstallActivity:async()=>({busy:true,state:'busy',reason:'device_install_busy',processes:[]}),log:()=>{},scanAndSync:async options=>scans.push(options)};
  vm.runInNewContext(source.slice(start,end),ctx);await captured.run('fixture');assert.equal(scans.length,1);assert.equal(scans[0].forcePnpInventory,false);
});
