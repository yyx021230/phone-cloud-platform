// Discovery/publication and maintenance have independent owners. A timed-out
// maintenance promise retains ownership until it actually settles; no retry
// timer can create overlapping PnP work. Each scan publishes its fresh snapshot.
export function createDeviceScanPipeline({discover,publish,maintain,onError=()=>{}}) {
  let scanning=null, maintenance=null, latest=[], observedAt=0, pendingOptions={};
  const snapshot=()=>({devices:structuredClone(latest),observedAt});
  function startMaintenance(options) {
    pendingOptions={...pendingOptions,...options,forcePnpInventory:Boolean(pendingOptions.forcePnpInventory || options.forcePnpInventory)};
    if(maintenance)return;
    const selected=pendingOptions;pendingOptions={};
    maintenance=Promise.resolve().then(()=>maintain(snapshot(),selected,snapshot)).catch(e=>onError(e,'maintenance')).finally(()=>{maintenance=null;});
  }
  return {
    snapshot,
    maintenanceActive:()=>Boolean(maintenance),
    async scan(options={}) {
      if(scanning)return {skipped:true,reason:'already_running'};
      scanning=Promise.resolve().then(async()=>{
        const devices=await discover();latest=structuredClone(devices);observedAt=Date.now();
        await publish(snapshot(),options);
        startMaintenance(options);
        return {skipped:false};
      });
      try{return await scanning;}finally{scanning=null;}
    }
  };
}

export function recoverySnapshotAdmission(snapshot,serial,{now=Date.now(),maxAgeMs=30000}={}) {
  if(!snapshot.observedAt || now-snapshot.observedAt>maxAgeMs)return 'adb_snapshot_stale';
  const row=snapshot.devices.find(x=>String(x.adbSerial||'').toUpperCase()===String(serial).toUpperCase());
  if(row?.state==='device')return 'device_became_online';
  if(row?.state==='unauthorized')return 'device_unauthorized';
  return '';
}
