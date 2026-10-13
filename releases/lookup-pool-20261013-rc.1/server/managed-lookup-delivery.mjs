import * as legacy from './screen-gallery-import.mjs';
export const MANAGED_LOOKUP_PROTOCOL='managed_lookup_v1';
export const isManagedLookupTask=t=>/^alipay_name_(start|query|switch|stop)$/.test(t?.type||'')&&t?.payload?.managedLookup?.protocol===MANAGED_LOOKUP_PROTOCOL;
export function supportsLeasedWindowsTaskDelivery(t){return isManagedLookupTask(t)||legacy.supportsLeasedWindowsTaskDelivery(t);}
export function hasActiveScreenGalleryDelivery(t,now=Date.now()){return isManagedLookupTask(t)?t.status==='queued'&&!!t.delivery?.token&&Date.parse(t.delivery.expiresAt)>now:legacy.hasActiveScreenGalleryDelivery(t,now);}
export function issueScreenGalleryDelivery(t,o={}){
  if(!isManagedLookupTask(t))return legacy.issueScreenGalleryDelivery(t,o);
  if(t.status!=='queued'||!o.token)throw new Error('managed_lookup_delivery_not_queueable');
  const now=o.nowMs??Date.now();t.delivery={token:o.token,attempt:(t.deliveryAttempts||0)+1,leasedAt:new Date(now).toISOString(),expiresAt:new Date(now+(o.leaseMs||60000)).toISOString(),ackedAt:''};t.deliveryAttempts=t.delivery.attempt;t.updatedAt=t.delivery.leasedAt;
  const x=structuredClone(t);x.deliveryToken=t.delivery.token;delete x.delivery;delete x.payload.phoneNumber;return x;
}
export function readScreenGalleryDeliveryPayload(t,token,now=Date.now()){
  if(!isManagedLookupTask(t))return legacy.readScreenGalleryDeliveryPayload(t,token,now);
  if(!hasActiveScreenGalleryDelivery(t,now)||token!==t.delivery.token)return {ok:false,error:'managed_lookup_delivery_stale'};
  return {ok:true,payload:{phoneNumber:t.payload.phoneNumber||'',managedLookup:t.payload.managedLookup}};
}
export function acknowledgeScreenGalleryDelivery(t,token,now=Date.now()){
  if(!isManagedLookupTask(t))return legacy.acknowledgeScreenGalleryDelivery(t,token,now);
  if(t.status==='running'&&token&&t.delivery?.token===token&&t.delivery.ackedAt)return {ok:true,idempotent:true};
  if(!hasActiveScreenGalleryDelivery(t,now)||token!==t.delivery.token)return {ok:false,error:'managed_lookup_delivery_stale'};
  t.status='running';t.pickedAt=t.pickedAt||new Date(now).toISOString();t.updatedAt=new Date(now).toISOString();t.delivery.ackedAt=t.updatedAt;return {ok:true,idempotent:false};
}
