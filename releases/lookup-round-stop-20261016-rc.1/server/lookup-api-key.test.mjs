import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyLookupApiKey } from './lookup-api-key.mjs';
import { parseOpenNameLookupClients } from './open-name-lookup-api.mjs';

const key = 'pclk_' + 'a'.repeat(43);
const digest = crypto.createHash('sha256').update(key).digest('hex');
const client = { clientId: 'partner-a', secret: 'h'.repeat(32), username: 'partner', deviceIds: ['mock-device'], apiKeySha256: digest };
const clients = () => parseOpenNameLookupClients(JSON.stringify([client]));
const prefix = '/api/v1/open/name-lookups';
function verify(method = 'POST', path = prefix + '/prepare', headers = { 'x-api-key': key }, map = clients()) {
  return verifyLookupApiKey({ method, headers }, new URL(path, 'http://localhost'), map);
}
test('key identifies existing client on exactly four endpoints', () => {
  for (const [method,path] of [['POST',prefix+'/stop'],['POST',prefix+'/prepare'],['POST',prefix+'/tasks'],['GET',prefix+'/tasks/mock-id']]) {
    const ctx = verify(method,path);
    assert.equal(ctx.clientId, 'partner-a'); assert.equal(ctx.authType, 'lookup-api-key');
    assert.equal(ctx.nonce, undefined); assert.equal(ctx.client.secret, client.secret);
    assert.ok(!JSON.stringify(ctx).includes(key));
  }
});
test('key scope excludes legacy, admin, SMS and wrong verbs', () => {
  for (const path of [prefix+'/query',prefix+'/devices',prefix+'/sessions', '/api/v1/admin/lookup-pool','/api/v1/open/sms/requests']) {
    assert.throws(() => verify('POST',path), {statusCode:401,message:'lookup_api_key_scope_denied'});
  }
  assert.throws(() => verify('GET',prefix+'/prepare'), {statusCode:401});
  assert.throws(() => verify('GET',prefix+'/stop'), {statusCode:401});
});
test('rejects missing, malformed, duplicate and unknown keys without leaking input', () => {
  for (const value of ['',undefined,[],key+', '+key,'pclk_'+'b'.repeat(43), 'x'.repeat(10000),client.secret]) {
    assert.throws(() => verify('POST',prefix+'/prepare',{'x-api-key':value}), {statusCode:401,message:'invalid_lookup_api_key'});
  }
});
test('rejects mixed HMAC even when the other headers are empty', () => {
  for (const h of ['x-client-id','x-timestamp','x-nonce','x-signature']) {
    assert.throws(() => verify('POST',prefix+'/prepare',{'x-api-key':key,[h]:''}), {message:'mixed_lookup_auth'});
  }
});
test('legacy clients remain usable; optional invalid digest does not enable keys', () => {
  for (const hash of [undefined,'BAD','a'.repeat(63)]) {
    const c=parseOpenNameLookupClients(JSON.stringify([{...client,apiKeySha256:hash}]));
    assert.equal(c.size,1);assert.equal(c.get('partner-a').secret,client.secret);
    assert.throws(() => verify('POST',prefix+'/prepare',{'x-api-key':key},c),{statusCode:401});
  }
});
test('duplicate digest fails closed for both clients', () => {
  const c=parseOpenNameLookupClients(JSON.stringify([client,{...client,clientId:'partner-b',username:'other'}]));
  assert.equal(c.size,2);
  assert.throws(() => verify('POST',prefix+'/prepare',{'x-api-key':key},c),{statusCode:401});
});
