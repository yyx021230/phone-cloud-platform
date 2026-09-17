const USB_HUB_INTERFACE_GUID = "{f18a0e88-c30c-11d0-8815-00a0c906bed8}";

export function buildPhysicalAndroidUsbInventoryScript(vendorIds = []) {
  const safeVendorIds = vendorIds
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => /^[0-9A-F]{4}$/.test(value));
  const vendors = safeVendorIds.map((value) => `'${value}'`).join(",");
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$all = @(Get-PnpDevice -PresentOnly)",
    "$fileCd = @{}",
    "$all | Where-Object { $_.Class -eq 'CDROM' -and $_.FriendlyName -eq 'Linux File-CD Gadget USB Device' } | ForEach-Object { $parts=$_.InstanceId.Split('&'); if($parts.Length -ge 2){$fileCd[[string]$parts[$parts.Length-2]]=$true} }",
    "$explicitAdbNodes = @($all | Where-Object { $_.Class -eq 'AndroidUsbDeviceClass' -or $_.FriendlyName -match '(?i)ADB Interface' })",
    "$genericCandidates = @($all | Where-Object { $_.InstanceId -match '(?i)Subclass_42&Prot_01' -or $_.Class -eq 'USBDevice' -or $_.FriendlyName -match '(?i)WinUsb' })",
    "$genericIds = @($genericCandidates | ForEach-Object { [string]$_.InstanceId } | Where-Object { $_ } | Select-Object -Unique)",
    "$genericAdbById = @{}",
    "foreach($node in $genericCandidates){ if($node.InstanceId -match '(?i)Subclass_42&Prot_01'){ $genericAdbById[[string]$node.InstanceId]=$node } }",
    "if($genericIds.Count -gt 0){",
    "  $genericProps = @(@(Get-PnpDeviceProperty -InstanceId $genericIds -KeyName 'DEVPKEY_Device_HardwareIds' -ThrottleLimit 64 -ErrorAction SilentlyContinue) + @(Get-PnpDeviceProperty -InstanceId $genericIds -KeyName 'DEVPKEY_Device_CompatibleIds' -ThrottleLimit 64 -ErrorAction SilentlyContinue))",
    "  $signatureText = @{}",
    "  foreach($property in $genericProps){ $id=[string]$property.InstanceId; if(!$id){continue}; $text=(@($property.Data) -join ';'); $signatureText[$id]=([string]$signatureText[$id] + ';' + $text) }",
    "  foreach($node in $genericCandidates){ $id=[string]$node.InstanceId; $signature=([string]$signatureText[$id] + ';' + $id); $hasAdbClass=($signature -match '(?i)(Subclass_42&Prot_01|Class_ff&SubClass_42&Prot_01)'); $hasNamedWinUsbAdb=($signature -match '(?i)MS_COMP_WINUSB' -and (([string]$node.FriendlyName + ';' + [string]$node.Name) -match '(?i)ADB')); if($hasAdbClass -or $hasNamedWinUsbAdb){ $genericAdbById[$id]=$node } }",
    "}",
    "$adbNodesById = @{}",
    "$adbKindById = @{}",
    "foreach($node in $explicitAdbNodes){ $id=[string]$node.InstanceId; if($id){$adbNodesById[$id]=$node;$adbKindById[$id]='explicit_adb'} }",
    "foreach($id in $genericAdbById.Keys){ if(!$adbNodesById.ContainsKey($id)){$adbNodesById[$id]=$genericAdbById[$id]};$adbKindById[$id]='generic_winusb_adb' }",
    "$adbNodes = @($adbNodesById.Values)",
    "$wpdNodes = @($all | Where-Object { $_.Class -in @('WPD','PortableDevice') -or $_.FriendlyName -match '(?i)MTP|portable device' })",
    `$roots = @($all | Where-Object { $_.InstanceId -match '^USB\\\\VID_([0-9A-F]{4})&PID_[0-9A-F]{4}\\\\[^\\\\]+$' -and $Matches[1] -in @(${vendors}) })`,
    "$parentById = @{}",
    "$rootIds = @($roots | ForEach-Object { [string]$_.InstanceId } | Where-Object { $_ } | Select-Object -Unique)",
    "$coreIds = @(@($rootIds) + @($adbNodes | ForEach-Object { [string]$_.InstanceId }) | Where-Object { $_ } | Select-Object -Unique)",
    "$wpdIds = @($wpdNodes | ForEach-Object { [string]$_.InstanceId } | Where-Object { $_ } | Select-Object -Unique)",
    "$properties = @()",
    "if($coreIds.Count -gt 0){$properties += @(Get-PnpDeviceProperty -InstanceId $coreIds -KeyName 'DEVPKEY_Device_Parent' -ThrottleLimit 64 -ErrorAction SilentlyContinue)}",
    "if($wpdIds.Count -gt 0){$properties += @(Get-PnpDeviceProperty -InstanceId $wpdIds -KeyName 'DEVPKEY_Device_Parent' -ThrottleLimit 64 -ErrorAction SilentlyContinue)}",
    "foreach($property in $properties){$instanceId=[string]$property.InstanceId;$parentId=[string]$property.Data;if($instanceId){$parentById[$instanceId]=$parentId}}",
    "$addressById = @{}",
    "if($rootIds.Count -gt 0){ foreach($property in @(Get-PnpDeviceProperty -InstanceId $rootIds -KeyName 'DEVPKEY_Device_Address' -ThrottleLimit 64 -ErrorAction SilentlyContinue)){ $id=[string]$property.InstanceId; if($id){$addressById[$id]=[string]$property.Data} } }",
    "$mtpRoots = @{}",
    "foreach($node in $wpdNodes){ $cursor=[string]$node.InstanceId; for($depth=0;$depth -lt 4 -and $cursor;$depth++){ if($cursor -match '^USB\\\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\\\[^\\\\]+$'){$mtpRoots[$cursor]=$true;break}; if(!$parentById.ContainsKey($cursor)){break}; $cursor=[string]$parentById[$cursor] } }",
    "$adbByParent = @{}",
    "foreach($node in $adbNodes){ $parent=[string]$parentById[[string]$node.InstanceId]; if($parent -and !$adbByParent.ContainsKey($parent)){$adbByParent[$parent]=$node} }",
    "$rows = @()",
    "$rootSerials = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)",
    "foreach($root in $roots){",
    "  if($root.InstanceId -notmatch '^USB\\\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\\\([^\\\\]+)$'){continue}",
    "  $serial=[string]$Matches[1]; if($serial -notmatch '^[A-Za-z0-9._:-]{4,128}$'){continue}",
    "  [void]$rootSerials.Add($serial)",
    "  $rootId=[string]$root.InstanceId",
    "  $upstream=[string]$parentById[$rootId]",
    "  $adbNode=$null",
    "  if($adbNodesById.ContainsKey($rootId)){$adbNode=$adbNodesById[$rootId]}elseif($adbByParent.ContainsKey($rootId)){$adbNode=$adbByParent[$rootId]}",
    "  $adbId=[string]$adbNode.InstanceId",
    "  $rows += [pscustomobject]@{Serial=$serial;Upstream=$upstream;RootId=$rootId;RootStatus=[string]$root.Status;RootProblem=[string]$root.Problem;AdbId=$adbId;AdbStatus=[string]$adbNode.Status;AdbProblem=[string]$adbNode.Problem;FileCd=[bool]$fileCd.ContainsKey($serial);Mtp=[bool]$mtpRoots.ContainsKey($rootId);AdbKind=[string]$adbKindById[$adbId];Port=[string]$addressById[$rootId]}",
    "}",
    "foreach($serial in $fileCd.Keys){ if(!$rootSerials.Contains([string]$serial)){ $rows += [pscustomobject]@{Serial=[string]$serial;Upstream='';RootId='';RootStatus='';RootProblem='';AdbId='';AdbStatus='';AdbProblem='';FileCd=$true;Mtp=$false;AdbKind='';Port=''} } }",
    "$rows | Sort-Object Serial | ForEach-Object { Write-Output ($_.Serial + \"`t\" + $_.Upstream + \"`t\" + $_.RootId + \"`t\" + $_.RootStatus + \"`t\" + $_.RootProblem + \"`t\" + $_.AdbId + \"`t\" + $_.AdbStatus + \"`t\" + $_.AdbProblem + \"`t\" + $_.FileCd + \"`t\" + $_.Mtp + \"`t\" + $_.AdbKind + \"`t\" + $_.Port) }"
  ].join("; ");
}

export function parsePhysicalAndroidUsbInventory(output = "") {
  return String(output || "")
    .split(/\r?\n/)
    .map((value) => {
      const [
        serial = "",
        upstreamInstanceId = "",
        rootInstanceId = "",
        rootStatus = "",
        rootProblem = "",
        adbInterfaceInstanceId = "",
        adbInterfaceStatus = "",
        adbInterfaceProblem = "",
        fileCd = "",
        mtp = "",
        adbInterfaceKind = "",
        portNumber = ""
      ] = value.split("\t", 12);
      return {
        serial: serial.trim(),
        upstreamInstanceId: upstreamInstanceId.trim(),
        rootInstanceId: rootInstanceId.trim(),
        rootStatus: rootStatus.trim(),
        rootProblem: rootProblem.trim(),
        adbInterfaceInstanceId: adbInterfaceInstanceId.trim(),
        adbInterfaceStatus: adbInterfaceStatus.trim(),
        adbInterfaceProblem: adbInterfaceProblem.trim(),
        fileCdPresent: String(fileCd).trim().toLowerCase() === "true",
        mtpPresent: String(mtp).trim().toLowerCase() === "true",
        adbInterfaceKind: adbInterfaceKind.trim(),
        portNumber: normalizePortNumber(portNumber),
        hubInterfacePath: usbHubInterfacePath(upstreamInstanceId)
      };
    })
    .filter((item) => /^[A-Za-z0-9._:-]{4,128}$/.test(item.serial));
}

export function usbHubInterfacePath(instanceId = "") {
  const target = String(instanceId || "").trim();
  if (!/^USB\\[A-Za-z0-9&_.\\:-]{4,500}$/i.test(target)) return "";
  return `\\\\?\\${target.replaceAll("\\", "#")}#${USB_HUB_INTERFACE_GUID}`;
}

function normalizePortNumber(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 && numeric <= 255 ? numeric : 0;
}
