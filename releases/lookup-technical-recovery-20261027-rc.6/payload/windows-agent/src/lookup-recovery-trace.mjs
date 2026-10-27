// Lookup-only, bounded diagnostics. No raw OCR text, identity, phone or image.
const allowed=new Set(['lookup_visual_result_probe','lookup_visual_frame_read','lookup_visual_pending_wait','lookup_visual_loading_wait','account_picker_sample','account_picker_sampling_finished','account_picker_stable','coloros_securepay_usb_warning_closed','known_overlay_ocr_target','known_overlay_closed','network_result_refreshed','lookup_network_refresh','lookup_network_refresh_failed','lookup_network_refresh_still_busy']);
const reasons=new Set(['stable','first_valid','rows_changed','invalid_rows','list_not_seen','sample_timeout','hierarchy_missing']);
export function collectLookupTrace(trace,events){
 for(const e of events||[]){if(!allowed.has(e?.step))continue;const row={step:e.step};
  for(const k of ['elapsedMs','sampleMs','remainingMs','sampleCount','savedAccountCount'])if(Number.isFinite(e[k])&&e[k]>=0)row[k]=Math.min(3600000,Math.round(e[k]));
  if(reasons.has(e.sampleReason))row.sampleReason=e.sampleReason;
  if(typeof e.networkBusy==='boolean')row.networkBusy=e.networkBusy;
  if(['poco','local_ocr'].includes(e.driver))row.driver=e.driver;
  for(const k of ['resubmitsInput','tapConfirmed'])if(typeof e[k]==='boolean')row[k]=e[k];
  if(Number.isInteger(e.refreshCount)&&e.refreshCount>=0&&e.refreshCount<=1)row.refreshCount=e.refreshCount;
  trace.push(row);if(trace.length>40)trace.shift();
 }return trace;
}
export const isAutomaticLookupResume = payload => ['page','state','device','network','automatic'].includes(payload?.recoveryOrigin);
