import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedRequest } from './preview-client.mjs';
const route = '/api/v1/user/automation/wecom-preview-tasks';
const body = { mode: 'preview', appSlot: 'main', requestId: 'fixture-preview-01' };
test('live acceptance can only submit an explicit internal preview', () => {
  assert.equal(authorizedRequest('POST', route, body), true);
  for (const change of [{ mode: 'send' }, { mode: undefined }, { send: false }, { previewOnly: true }, { appSlot: 'clone' }]) {
    assert.equal(authorizedRequest('POST', route, { ...body, ...change }), false);
  }
});
test('real invitation, cleanup mutation and task claim routes are refused before network', () => {
  for (const forbidden of ['/api/v1/wecom/customer-invitations', '/api/v1/windows-agents/demo/tasks/next', '/api/v1/windows-agents/demo/wecom-cleanup/demo/proof']) {
    assert.equal(authorizedRequest('POST', forbidden, body), false);
    assert.equal(authorizedRequest('GET', forbidden), false);
  }
});
test('catalog and original preview result are the read-only API surface', () => {
  assert.equal(authorizedRequest('GET', '/api/v1/user/automation/wecom-preview-devices'), true);
  assert.equal(authorizedRequest('GET', route + '/00000000-0000-4000-8000-000000000001'), true);
  assert.equal(authorizedRequest('DELETE', route, body), false);
});
