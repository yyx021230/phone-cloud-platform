import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { OpenNameLookupApiError, OpenNameLookupClient } from "./node_client.mjs";

test("node client signs the exact transmitted body and adds idempotency", async () => {
  const calls = [];
  const secret = "s".repeat(32);
  const client = new OpenNameLookupClient({
    baseUrl: "https://phone.example.test/",
    clientId: "partner-a",
    secret,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, queryId: "query-1" }), {
        status: 202, headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.enqueueQuery("session/one", {
    phoneNumber: "13800000000", clientReference: "order-000001", consentReference: "consent-000001"
  }, { idempotencyKey: "idem-000001" });
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, "https://phone.example.test/api/v1/open/name-lookups/sessions/session%2Fone/queries");
  assert.equal(options.headers["Idempotency-Key"], "idem-000001");
  const pathname = new URL(url).pathname;
  const bodyHash = crypto.createHash("sha256").update(options.body).digest("hex");
  const canonical = ["POST", pathname, options.headers["X-Timestamp"], options.headers["X-Nonce"], bodyHash].join("\n");
  const expected = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  assert.equal(options.headers["X-Signature"], expected);
});

test("enqueueMany preserves caller order and waitForQueries surfaces human action", async () => {
  const submitted = [];
  let poll = 0;
  const client = new OpenNameLookupClient({
    baseUrl: "https://phone.example.test",
    clientId: "partner-a",
    secret: "s".repeat(32),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/queries") && options.method === "POST") {
        const body = JSON.parse(options.body);
        submitted.push(body.clientReference);
        return new Response(JSON.stringify({ queryId: `query-${submitted.length}` }), { status: 202 });
      }
      poll += 1;
      return new Response(JSON.stringify({ session: {
        humanAction: { required: true, queryId: "query-1", resumeAllowed: true },
        queueState: { status: "waiting" },
        results: [{ queryId: "query-1", status: "needs_human_verification" }]
      } }), { status: 200 });
    }
  });
  const accepted = await client.enqueueMany("session-1", [
    { phoneNumber: "13800000000", clientReference: "order-000001", consentReference: "consent-000001" },
    { phoneNumber: "13900000000", clientReference: "order-000002", consentReference: "consent-000002" }
  ]);
  assert.deepEqual(submitted, ["order-000001", "order-000002"]);
  assert.deepEqual(accepted.map((item) => item.queryId), ["query-1", "query-2"]);
  const outcome = await client.waitForQueries("session-1", ["query-1", "query-2"], { pollIntervalMs: 1 });
  assert.equal(poll, 1);
  assert.equal(outcome.state, "human_action_required");
});

test("HTTP failures expose status, code and response payload", async () => {
  const client = new OpenNameLookupClient({
    baseUrl: "https://phone.example.test", clientId: "partner-a", secret: "s".repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({ error: "device_busy" }), { status: 409 })
  });
  await assert.rejects(client.listDevices(), (error) => {
    assert.ok(error instanceof OpenNameLookupApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "device_busy");
    return true;
  });
});

test("managed lookupName uses phone-only body and stable key across a network retry", async () => {
  const calls=[];const client=new OpenNameLookupClient({baseUrl:"http://local",clientId:"fixture",secret:"fixture-secret",fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body),key:options.headers["Idempotency-Key"],nonce:options.headers["X-Nonce"]});if(calls.length===1)throw new Error("lost response");return new Response(JSON.stringify({ok:true,name:"test*"}),{status:200});}});
  const result=await client.lookupName("13800000000");assert.equal(result.name,"test*");assert.deepEqual(calls[0].body,{phoneNumber:"13800000000"});assert.equal(calls[0].key,calls[1].key);assert.notEqual(calls[0].nonce,calls[1].nonce);assert.ok(calls[0].url.endsWith("/query"));
});

test('async SDK resubmission preserves key but refreshes signature nonce; GET only reads result',async()=>{
 const calls=[];const c=new OpenNameLookupClient({baseUrl:'http://127.0.0.1:1',clientId:'fixture',secret:'s'.repeat(32),fetchImpl:async(url,options)=>{calls.push({url,options});if(calls.length===1)throw Error('response lost');return new Response(JSON.stringify(options.method==='GET'?{ok:true,lookupId:'id-1',status:'processing',name:'',code:''}:{ok:true,lookupId:'id-1',status:'processing',reused:true}),{status:200});}});
 assert.equal((await c.submitLookup('13800000001',{idempotencyKey:'saved-key-0001'})).lookupId,'id-1');assert.equal(calls[0].options.headers['Idempotency-Key'],calls[1].options.headers['Idempotency-Key']);assert.notEqual(calls[0].options.headers['X-Nonce'],calls[1].options.headers['X-Nonce']);assert.deepEqual(JSON.parse(calls[0].options.body),{phoneNumber:'13800000001'});await c.getLookupResult('id/one');assert.equal(calls.at(-1).options.method,'GET');assert.ok(calls.at(-1).url.endsWith('/tasks/id%2Fone'));assert.equal(calls.at(-1).options.body,undefined);
});
test('async SDK does not turn HTTP/business failures into automatic new submissions',async()=>{let calls=0;const c=new OpenNameLookupClient({baseUrl:'http://127.0.0.1:1',clientId:'fixture',secret:'s'.repeat(32),fetchImpl:async()=>{calls++;return new Response(JSON.stringify({ok:false,code:'lookup_pool_disabled'}),{status:503});}});await assert.rejects(c.submitLookup('13800000001',{idempotencyKey:'saved-key-0001'}),{code:'lookup_pool_disabled'});assert.equal(calls,1);});

test('prepare uses empty signed body and same saved key across network retry',async()=>{
 const calls=[];const client=new OpenNameLookupClient({baseUrl:'http://local',clientId:'fixture',secret:'fixture-secret',fetchImpl:async(url,options)=>{calls.push({url,options});if(calls.length===1)throw Error('lost');return new Response(JSON.stringify({ok:true,ready:false}),{status:200});}});
 await client.prepareLookup({idempotencyKey:'saved-preparation-key'});assert.equal(calls.length,2);assert.ok(calls[0].url.endsWith('/prepare'));assert.equal(calls[0].options.body,'{}');assert.equal(calls[0].options.headers['Idempotency-Key'],calls[1].options.headers['Idempotency-Key']);assert.notEqual(calls[0].options.headers['X-Nonce'],calls[1].options.headers['X-Nonce']);
});
