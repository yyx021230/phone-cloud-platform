import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLookupReaderCapabilities} from './lookup-reader-capabilities.mjs';
test('immutable capability survives a fresh store and concurrent declarations without a runtime snapshot',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-floor-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'markers');
 const store=await createLookupReaderCapabilities(dir);assert.equal(store.has('a'),false);
 await Promise.all(Array.from({length:15},()=>store.enable('a')));assert.equal(store.has('a'),true);assert.equal(store.has('b'),false);
 const restored=await createLookupReaderCapabilities(dir);assert.equal(restored.has('a'),true);
 const files=await fs.readdir(dir);assert.equal(files.length,1);assert.match(files[0],/^[a-f0-9]{64}\.v1$/);
 assert.equal(await fs.readFile(path.join(dir,files[0]),'utf8'),'1\n');
});
test('failed write never acknowledges or caches capability, retry persists, corrupt marker blocks only lookup admission',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-floor-fail-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'markers');
 const store=await createLookupReaderCapabilities(dir);await fs.writeFile(dir,'block directory');
 await assert.rejects(store.enable('a'));assert.equal(store.has('a'),false);
 await fs.rm(dir);await store.enable('a');assert.equal(store.has('a'),true);
 const file=(await fs.readdir(dir))[0];await fs.writeFile(path.join(dir,file),'corrupt');
 const corrupt=await createLookupReaderCapabilities(dir);assert.equal(corrupt.has('a'),true);assert.equal(corrupt.available('a'),false);assert.equal(corrupt.available('b'),true);await assert.rejects(corrupt.enable('a'),/storage_unavailable/);
});

test('unreadable marker directory cannot silently become legacy or prevent service construction',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-floor-dir-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'markers');await fs.writeFile(dir,'blocked');
 const store=await createLookupReaderCapabilities(dir);assert.equal(store.has('any-agent'),true);assert.equal(store.available('any-agent'),false);await assert.rejects(store.enable('any-agent'),/storage_unavailable/);
});
