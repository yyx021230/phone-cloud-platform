// Existing helpers only; no HTTP authentication, DB, phone or app entry point.
import test from "node:test";
import assert from "node:assert/strict";
import * as h from "../../server/managed-lookup-delivery.mjs";
const time=Date.parse("2026-11-03T00:00:00.000Z"),later=time+61000;
function task(type){return {taskId:"synthetic",type,status:"queued",payload:type==="screen_gallery_import"?{imageDataUrl:"synthetic-image",screenSessionId:"synthetic-session"}:type==="xhs_publish"?{imageDataUrls:["synthetic-image"]}:{phoneNumber:"13900000000",managedLookup:{protocol:"managed_lookup_v1",generation:"synthetic-generation"}}};}
function leased(type){const t=task(type);h.issueScreenGalleryDelivery(t,{token:"synthetic-token",nowMs:time,leaseMs:60000});return t;}
for(const type of ["screen_gallery_import","xhs_publish","alipay_name_query"]){
  test(`${type}: supported queued delivery and payload`,()=>{const t=leased(type);assert.equal(h.supportsLeasedWindowsTaskDelivery(t),true);assert.equal(h.hasActiveScreenGalleryDelivery(t,time),true);const r=h.readScreenGalleryDeliveryPayload(t,"synthetic-token",time);assert.equal(r.ok,true);assert.deepEqual(r.payload,type==="screen_gallery_import"?{imageDataUrl:"synthetic-image",screenSessionId:"synthetic-session"}:type==="xhs_publish"?{imageDataUrls:["synthetic-image"]}:{phoneNumber:"13900000000",managedLookup:t.payload.managedLookup});});
  test(`${type}: wrong payload token rejected unchanged`,()=>{const t=leased(type),old=structuredClone(t);assert.equal(h.readScreenGalleryDeliveryPayload(t,"wrong",time).ok,false);assert.deepEqual(t,old);});
  test(`${type}: wrong queued ACK token rejected unchanged`,()=>{const t=leased(type),old=structuredClone(t);assert.equal(h.acknowledgeScreenGalleryDelivery(t,"wrong",time).ok,false);assert.deepEqual(t,old);});
  test(`${type}: queued expired payload and ACK rejected`,()=>{const t=leased(type),old=structuredClone(t);assert.equal(h.hasActiveScreenGalleryDelivery(t,later),false);assert.equal(h.readScreenGalleryDeliveryPayload(t,"synthetic-token",later).ok,false);assert.equal(h.acknowledgeScreenGalleryDelivery(t,"synthetic-token",later).ok,false);assert.deepEqual(t,old);});
  test(`${type}: queued matching ACK becomes running`,()=>{const t=leased(type);assert.deepEqual(h.acknowledgeScreenGalleryDelivery(t,"synthetic-token",time),{ok:true,idempotent:false});assert.equal(t.status,"running");assert.equal(t.delivery.ackedAt,new Date(time).toISOString());});
  test(`${type}: running matching acknowledged token remains idempotent after expiry`,()=>{const t=leased(type);h.acknowledgeScreenGalleryDelivery(t,"synthetic-token",time);const old=structuredClone(t);assert.deepEqual(h.acknowledgeScreenGalleryDelivery(t,"synthetic-token",later),{ok:true,idempotent:true});assert.deepEqual(t,old);});
  test(`${type}: running wrong token rejected`,()=>{const t=leased(type);h.acknowledgeScreenGalleryDelivery(t,"synthetic-token",time);const old=structuredClone(t);assert.equal(h.acknowledgeScreenGalleryDelivery(t,"wrong",later).ok,false);assert.deepEqual(t,old);});
  test(`${type}: running without previous ACK is not idempotent`,()=>{const t=leased(type);t.status="running";const old=structuredClone(t);assert.equal(h.acknowledgeScreenGalleryDelivery(t,"synthetic-token",time).ok,false);assert.deepEqual(t,old);});
}
for(const slot of ["main","clone"])test(`WeCom ${slot}: current profile unsupported, no lease or invitation`,()=>{
  const t={taskId:"synthetic-wecom",type:"wecom_customer_preview",status:"queued",payload:{appSlot:slot,mode:"preview",previewOnly:true}},old=structuredClone(t);
  assert.equal(h.supportsLeasedWindowsTaskDelivery(t),false);assert.equal(h.hasActiveScreenGalleryDelivery(t,time),false);
  assert.throws(()=>h.issueScreenGalleryDelivery(t,{token:"synthetic-token",nowMs:time}),/screen_gallery_delivery_not_queueable/);
  assert.deepEqual(h.readScreenGalleryDeliveryPayload(t,"synthetic-token",time),{ok:false,error:"windows_task_payload_not_found"});
  assert.deepEqual(h.acknowledgeScreenGalleryDelivery(t,"synthetic-token",time),{ok:false,error:"windows_task_delivery_not_found"});assert.deepEqual(t,old);
});
