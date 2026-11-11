import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
function definition(name) {
  const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(match, name);
  return match[0];
}
const serialize = new Function('compactEventDetail', definition('compactTaskResultForStatus')
  + ';return compactTaskResultForStatus;')(value => value);

test('actual Agent runTask and HTTP status transport retain native preview proof', async () => {
  const posts = [];
  const native = {previewStatus:'ready_before_send',previewCode:'stopped_before_send',
    remarkSaveStatus:'confirmed',remarkPhoneSet:true,invitationSent:false,sendStatus:'not_attempted'};
  const context = vm.createContext({
    Buffer, encodeURIComponent, log:() => {}, compactEventDetail:value => value,
    taskEvent:async () => {}, compactTaskResultForEvent:value => value,
    taskWecomPreview:async () => native,
    api:async (route, options) => posts.push(JSON.parse(JSON.stringify({route,...options}))),
  });
  vm.runInContext(['compactTaskResultForStatus','taskStatus','runTask'].map(definition).join('\n'), context);
  await context.runTask({type:'wecom_customer_preview',taskId:'fixture-preview',payload:{requireRemarkPhone:true}});
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.status, 'succeeded');
  assert.equal(posts[0].body.result.previewStatus, 'ready_before_send');
  assert.equal(posts[0].body.result.remarkPhoneSet, true);
  assert.equal(posts[0].body.result.remarkSaveStatus, 'confirmed');
  assert.equal(posts[0].body.result.sendStatus, 'not_attempted');
});

test('only exact invitation and limit proofs survive the actual serializer', () => {
  const base = {previewStatus:'send_attempted',previewCode:'invitation_click_issued_delivery_unknown',
    sendStatus:'unknown',remarkSaveStatus:'confirmed',remarkPhoneSet:true};
  const confirmed = serialize({...base,invitationRequestConfirmed:true,invitationRequestProof:'wecom_system_dialog_v1'});
  assert.equal(confirmed.invitationRequestConfirmed, true);
  assert.equal(confirmed.invitationRequestProof, 'wecom_system_dialog_v1');
  assert.equal(confirmed.sendStatus, 'unknown');
  assert.equal(confirmed.invitationSent, null);
  for (const value of [false, 'true', 1, null]) {
    const result = serialize({...base,remarkPhoneSet:value,invitationRequestConfirmed:value,
      invitationRequestProof:'wecom_system_dialog_v1'});
    assert.equal(result.remarkPhoneSet, value === false ? false : undefined);
    assert.equal(result.invitationRequestConfirmed, undefined);
  }
  for (const proof of ['unknown','wecom_system_toast_v1','wecom_sent_overlay_v1']) {
    assert.equal(serialize({...base,invitationRequestConfirmed:true,invitationRequestProof:proof}).invitationRequestConfirmed, undefined);
  }
  const limited = {...base,previewStatus:'blocked',previewCode:'wecom_add_friend_too_frequent',
    addFriendLimitConfirmed:true,addFriendLimitProof:'wecom_system_dialog_v1'};
  assert.equal(serialize(limited).addFriendLimitConfirmed, true);
  assert.equal(serialize({...limited,previewCode:'other'}).addFriendLimitConfirmed, undefined);
  assert.equal(serialize({...limited,addFriendLimitConfirmed:'true'}).addFriendLimitConfirmed, undefined);
});

test('unrelated results acquire no WeCom proof fields', () => {
  const result = serialize({action:'fixture lookup',remarkPhoneSet:true,invitationRequestConfirmed:true,
    invitationRequestProof:'wecom_system_dialog_v1'});
  assert.equal(Object.hasOwn(result,'remarkPhoneSet'), false);
  assert.equal(Object.hasOwn(result,'invitationRequestConfirmed'), false);
});
