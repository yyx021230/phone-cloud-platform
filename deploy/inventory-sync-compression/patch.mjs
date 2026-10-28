import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The existing proxy directives are copied verbatim. Only this JSON response
// route gains content negotiation; no device fields or freshness rules change.
export const marker = '    # Inventory sync response compression (temporary validation candidate).';
export const route = '^/api/v1/windows-agents/[^/]+/devices/sync$';
export function patchSite(source) {
  if (source.includes(marker) || source.includes('devices/sync')) throw new Error('Inventory location already present; reconcile before patching');
  const matches = [...source.matchAll(/^    location \/ \{\n([\s\S]*?)^    \}/gm)];
  if (matches.length !== 1) throw new Error('Expected exactly one default proxy location');
  const match = matches[0];
  if (!match[1].includes('proxy_pass http://127.0.0.1:8787;')) throw new Error('Unexpected platform upstream');
  const addition = `${marker}\n    location ~ ${route} {\n        gzip on;\n        gzip_types application/json;\n        gzip_comp_level 1;\n        gzip_min_length 1024;\n        gzip_vary on;\n        gzip_proxied any;\n${match[1]}    }\n\n`;
  return source.slice(0, match.index) + addition + source.slice(match.index);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node patch.mjs BASELINE OUTPUT');
  fs.writeFileSync(process.argv[3], patchSite(fs.readFileSync(process.argv[2], 'utf8')), {flag: 'wx'});
}
