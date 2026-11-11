import {fixture} from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
export function made(name){const f=fixture({suffix:name,serial:`fixture-${name}`});f.input.task.fixtureOpaque={nested:[null,false,{unrecognized:"preserve",unicode:"测试"}],number:17};return f;}
