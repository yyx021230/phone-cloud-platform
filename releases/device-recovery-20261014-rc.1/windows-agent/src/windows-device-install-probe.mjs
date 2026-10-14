const marker = 'PC_DEVICE_INSTALL_PROBE_V1';
const script = [
  "$ErrorActionPreference = 'Stop'",
  // Avoid CIM/WMI module startup and remote provider RPC for a local name check.
  "$rows = @([System.Diagnostics.Process]::GetProcessesByName('pnputil')) + @([System.Diagnostics.Process]::GetProcessesByName('drvinst'))",
  "$lines = @($rows | ForEach-Object { try { $_.Id.ToString() + \"`t\" + $_.ProcessName + '.exe' } finally { $_.Dispose() } })",
  `Write-Output '${marker}'`,
  '$lines | ForEach-Object { Write-Output $_ }'
].join('; ');

// Share only an in-flight read, never a cached "idle" result across mutations.
// Unknown remains a blocker; diagnostics do not contain command/error text.
export function createWindowsDeviceInstallProbe({ run, now = Date.now }) {
  let pending = null;
  async function inspect() {
    const started = now();
    const finish = (state, reason, processes = [], errorCode = '', timedOut = false) => ({
      state, busy: state !== 'idle', reason, processes, errorCode, timedOut,
      durationMs: Math.max(0, now() - started), checkedAt: new Date(now()).toISOString()
    });
    try {
      const output = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
      ], { timeoutMs: 10_000 });
      const lines = String(output || '').trim().split(/\r?\n/);
      if (lines.shift() !== marker) return finish('unknown', 'device_install_probe_failed', [], 'invalid_output');
      const processes = [];
      for (const line of lines.filter(line => line.trim())) {
        const [pid, name, createdAt = ''] = line.split('\t');
        if (!/^[1-9]\d*$/.test(pid) || !/^(pnputil|drvinst)\.exe$/i.test(name)) {
          return finish('unknown', 'device_install_probe_failed', [], 'invalid_output');
        }
        processes.push({ pid: Number(pid), name: name.toLowerCase(), createdAt: createdAt.slice(0, 80) });
      }
      return finish(processes.length ? 'busy' : 'idle', processes.length ? 'device_install_busy' : '', processes);
    } catch (error) {
      const timedOut = error?.killed === true || error?.code === 'ETIMEDOUT';
      const code = String(error?.code ?? 'probe_error');
      const errorCode = /^[A-Z0-9_-]{1,40}$/i.test(code) ? code : 'probe_error';
      return finish('unknown', 'device_install_probe_failed', [], errorCode, timedOut);
    }
  }
  return () => {
    if (!pending) pending = Promise.resolve().then(inspect).finally(() => { pending = null; });
    return pending;
  };
}
