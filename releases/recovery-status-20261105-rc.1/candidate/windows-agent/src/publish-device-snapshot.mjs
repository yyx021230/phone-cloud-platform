async function publishDeviceSnapshot(snapshot, options = {}) {
  const devices=snapshot.devices;
  // State-only reconciliation: no ADB/PnP calls, no new scan, no scheduling.
  // A slow or failed isolation write must not delay normal device publication.
  void recoveryIsolation.observeAdb(snapshot, {
    minStableMs: config.pnpRecoveryStableSeconds * 1_000,
    minStableScans: config.pnpRecoveryStableScans,
    maxGapMs: Math.max(45_000, Number(config.scanIntervalSeconds || 30) * 1_500)
  }).then(serials=>{
    if(serials.length)log("recovery isolation cleared after stable discovery", {serials});
  }).catch(error=>log("recovery isolation reconciliation failed",
    error?.message==="recovery_isolation_load_failed" ? "recovery_isolation_load_failed" : "recovery_isolation_save_failed"));
  const activeAutomationTask=hasActiveAutomationTask();
  health.lastScan={ok:true,at:new Date(snapshot.observedAt).toISOString(),error:"",activeAutomationTask,reason:options.reason||""};
  // Cached physical inventory may add missing phones but never overwrites fresh
  // ADB states or requires a Windows inventory operation on this fast path.
  appendPhysicalRecoveryRows(devices,buildDeviceRecoveryObservations({devices,inventory:lastPhysicalPnpInventory,knownSerials:cachedAdbSerials(lastServerDevicesById),inventoryReady:isPhysicalPnpInventoryReady()}));
  health.deviceRecovery=currentPnpRecoveryHealth();
  markAutomationPreflightPending(devices);
  lastDevices=devices;lastDevicesScannedAt=snapshot.observedAt;
  annotateDeviceAutomationStatus(devices);
  const syncResult=await syncDevicesToPlatform(devices);
  rememberServerDevices(syncResult.devices||[]);
  await saveDeviceScanCache(syncResult.devices||[]).catch(error=>log("device scan cache save failed",error.message));
  log("synced devices",devices.map(device=>`${device.adbSerial}:${device.state}`).join(", ")||"none");
}
