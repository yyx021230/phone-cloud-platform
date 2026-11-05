async function publishDeviceSnapshot(snapshot, options = {}) {
  const devices=snapshot.devices;
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
