// Persisted per-device circuit breaker. No timer silently re-enables a phone.
export const LOOKUP_FAILURE_LIMIT=3;
export const lookupDeviceUnavailable=d=>d?.lookupUnavailable===true;
export function recordLookupPreparationFailure(s,c,r,now){
  const d=s.devices.find(d=>d.deviceId===c.deviceId);
  if(!d||!r||r.availabilityFailureRecorded)return;
  r.availabilityFailureRecorded=true;
  d.prepareFailureCount=Math.min(LOOKUP_FAILURE_LIMIT,(d.prepareFailureCount||0)+1);
  d.quarantineUntil=now+[30000,60000,120000][d.prepareFailureCount-1];
  if(d.prepareFailureCount>=LOOKUP_FAILURE_LIMIT){d.lookupUnavailable=true;d.lookupUnavailableAt=now;}
}
export function recordLookupPreparationSuccess(s,c){
  const d=s.devices.find(d=>d.deviceId===c.deviceId);
  // An old late result cannot release an operator-visible quarantine.
  if(d&&!lookupDeviceUnavailable(d)){d.prepareFailureCount=0;d.quarantineUntil=0;}
}
export function resetLookupUnavailable(d){
  d.prepareFailureCount=0;d.quarantineUntil=0;d.lookupUnavailable=false;delete d.lookupUnavailableAt;
}
