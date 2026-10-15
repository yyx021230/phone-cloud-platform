// Host-only preload: keep both existing Windows ADB identities after SYSTEM restarts.
// Contains file locations only; never copies, generates or logs private keys.
const fs = require('node:fs');
const path = require('node:path');
if (process.platform !== 'win32') throw new Error('Windows ADB auth preload requires Windows');
const existingKeys = [
  'C:\\Windows\\SysWOW64\\config\\systemprofile\\.android\\adbkey',
  'C:\\Users\\Administrator\\.android\\adbkey',
];
for (const key of existingKeys) {
  if (!fs.statSync(key).isFile()) throw new Error('Required existing ADB identity is unavailable');
}
const previous = (process.env.ADB_VENDOR_KEYS || '').split(path.delimiter).filter(Boolean);
process.env.ADB_VENDOR_KEYS = [...new Set([...previous, ...existingKeys])].join(path.delimiter);
