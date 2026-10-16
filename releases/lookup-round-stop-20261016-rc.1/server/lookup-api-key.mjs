import crypto from 'node:crypto';

const PREFIX = '/api/v1/open/name-lookups';
const KEY_PATTERN = /^pclk_[A-Za-z0-9_-]{43}$/;
const HMAC_HEADERS = ['x-client-id', 'x-timestamp', 'x-nonce', 'x-signature'];

function denied(code = 'invalid_lookup_api_key') {
  return Object.assign(new Error(code), { statusCode: 401 });
}

// Only the four public managed-lookup endpoints accept this credential.
// It maps to the existing client identity, preserving grants and deduplication.
export function verifyLookupApiKey(req, url, clients) {
  const allowed = req.method === 'POST' && [PREFIX + '/prepare', PREFIX + '/tasks', PREFIX + '/stop'].includes(url.pathname)
    || req.method === 'GET' && /^\/api\/v1\/open\/name-lookups\/tasks\/[A-Za-z0-9-]{1,80}$/.test(url.pathname);
  if (!allowed) throw denied('lookup_api_key_scope_denied');
  if (HMAC_HEADERS.some(name => Object.hasOwn(req.headers, name))) throw denied('mixed_lookup_auth');
  // Node joins duplicate headers with commas; reject those and empty/oversized keys.
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw denied();
  const digest = crypto.createHash('sha256').update(key).digest();
  let match;
  let count = 0;
  for (const client of clients.values()) {
    if (!/^[a-f0-9]{64}$/.test(client.apiKeySha256 || '')) continue;
    if (crypto.timingSafeEqual(digest, Buffer.from(client.apiKeySha256, 'hex'))) {
      match = client;
      count++;
    }
  }
  // Ambiguous configuration fails closed, never selects an arbitrary tenant.
  if (count !== 1) throw denied();
  return { role: 'open-api', name: match.clientId, clientId: match.clientId,
    client: match, authType: 'lookup-api-key' };
}
