import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs/promises';
test('recovery console distinguishes pending/applied/offline, keeps resume visible for healthy paused phone, and escapes labels',async()=>{
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('function renderWindowsRecoveryConsole()'),source.indexOf('function renderWindows()'));
 const agent={agentId:'fixture',agentName:'Fixture',lastSeenAt:new Date().toISOString(),recoveryControl:{revision:1,paused:[{serial:'18',reason:'fixture'}]},health:{recoveryControl:{protocol:'device_recovery_control_v1',revision:0,synced:true},deviceRecovery:{observedAt:new Date().toISOString(),queue:[{serial:'130',deviceName:'130',state:'adb_interface_ready_transport_missing'}]}}};
 const els={windowsRecoveryConsole:{innerHTML:''}},state={agents:[agent],devices:[{deviceName:'18<script>',adb:{agentId:'fixture',serial:'18'},recovery:{state:'adb_device'}}]};
 const c=vm.createContext({state,els,isOnline:x=>Boolean(x),shortTime:x=>x||'',escapeHtml:x=>String(x||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});vm.runInContext(block,c);vm.runInContext('renderWindowsRecoveryConsole()',c);
 assert.match(els.windowsRecoveryConsole.innerHTML,/暂停待确认/);assert.match(els.windowsRecoveryConsole.innerHTML,/继续自动恢复/);assert.match(els.windowsRecoveryConsole.innerHTML,/data-recovery-toggle="130"/);assert.doesNotMatch(els.windowsRecoveryConsole.innerHTML,/18<script>/);
 agent.health.recoveryControl.revision=1;vm.runInContext('renderWindowsRecoveryConsole()',c);assert.match(els.windowsRecoveryConsole.innerHTML,/自动恢复已暂停/);
 agent.lastSeenAt='';vm.runInContext('renderWindowsRecoveryConsole()',c);assert.match(els.windowsRecoveryConsole.innerHTML,/暂停待确认/);
});
