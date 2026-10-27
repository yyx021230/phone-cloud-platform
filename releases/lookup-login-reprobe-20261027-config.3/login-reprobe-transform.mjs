import assert from 'node:assert/strict';
export function applyLoginReprobe(source, expected, at) {
  const s=structuredClone(source);
  assert.equal(s.configRevision,expected.configRevision,'configuration changed');
  const ids=new Set(expected.devices.map(d=>d.deviceId));
  assert.ok(!s.channels.some(c=>ids.has(c.deviceId)),'a target is active');
  for(const e of expected.devices){
    const d=s.devices.find(x=>x.deviceId===e.deviceId);
    assert.ok(d&&d.deviceNumber===e.deviceNumber,'device mapping changed');
    assert.deepEqual(d.accountOffline,e.accountOffline,'new login evidence; refresh preview');
    assert.equal(d.enabled,e.enabled,'device switch changed');
    if(d.deviceNumber===78)continue;
    d.accountOffline.blockedRounds=[]; // Retain failure/notification until a new named probe succeeds.
    if(d.deviceNumber===118)d.enabled=true;
  }
  s.devices=s.devices.filter(d=>d.deviceNumber!==78);
  assert.equal(source.devices.length-s.devices.length,1);
  for(const p of s.preparations||[])if(p.stopRequestedAt===undefined)p.probeDemand=true;
  s.configRevision=(s.configRevision||0)+1;s.revision=(s.revision||0)+1;
  (s.audits||=[]).push({at:new Date(at).toISOString(),action:'operator_login_reprobe_authorized',actor:'user-authorized-maintenance',removedNumbers:[78],enabledNumbers:[118],reprobeNumbers:expected.devices.filter(d=>d.deviceNumber!==78).map(d=>d.deviceNumber),readinessGranted:false,cooldownsChanged:false});s.audits=s.audits.slice(-1000);
  return s;
}
