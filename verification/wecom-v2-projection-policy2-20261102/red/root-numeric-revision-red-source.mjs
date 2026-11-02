import assert from 'node:assert/strict';
import {createWecomV2ProjectionPolicy} from './server/wecom-v2-projection-policy.mjs';
import {fixture} from './verification/wecom-v2-projection-policy-20261102/fixture.mjs';
const f=fixture();f.canonical.anchor.mapping_revision=1;
const policy=createWecomV2ProjectionPolicy({readPolicyEpoch:()=>f.observation.serverEpoch,readCanonicalProjection:()=>f.observation});
assert.equal(policy({targets:[f.request]}).results[0].decision,'reject_target','normalized mapping revision must be a string');
