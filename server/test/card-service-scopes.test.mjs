import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CardService } from '../card-service.mjs';

function context(revision) {
  return { revision, input: 'input', output: 'output', temp: 'temp', opened: null, active: 0, lastUsed: 0 };
}

test('legacy projects without optional style or fps have a stable runtime scope', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pc-card-legacy-scope-'));
  try {
    const service=new CardService({root:process.cwd(),dir:directory,runtime:{}});
    const project={width:64,height:64,tracks:[],media:[]};
    const a=await service.context(project),b=await service.context({...project,style:{},fps:30});
    assert.equal(a.revision,b.revision);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('CardService evicts only idle scope and waits while all scopes are leased', async () => {
  const opened = [], closed = [];
  const runtime = {
    async open(scope) { opened.push(scope); },
    async closeScope(scope) { closed.push(scope); },
  };
  const service = new CardService({ root: process.cwd(), dir: process.cwd(), runtime, maxOpenedScopes: 2 });
  service.runtimeDir = async () => 'runtime';
  const one = context('one'), two = context('two'), three = context('three');
  service.scopes.set(one.revision, one); service.scopes.set(two.revision, two); service.scopes.set(three.revision, three);
  const releaseOne = await service.lease(one);
  const releaseTwo = await service.lease(two);
  let openedThree = false;
  const pending = service.lease(three).then(release => { openedThree = true; release(); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(openedThree, false);
  assert.deepEqual(closed, []);
  releaseOne();
  await pending;
  assert.deepEqual(closed, ['one']);
  assert.equal(three.opened !== null, true);
  releaseTwo();
  // Metadata persists after eviction: reopening calls the normal runtime open path.
  const releaseAgain = await service.lease(one); releaseAgain();
  assert.equal(opened.filter(x => x === 'one').length, 2);
});

test('concurrent admissions never exceed the configured opened scope cap', async () => {
  let live = 0, peak = 0;
  const runtime = { async open() { live++; peak = Math.max(peak, live); }, async closeScope() { live--; } };
  const service = new CardService({ root: process.cwd(), dir: process.cwd(), runtime, maxOpenedScopes: 2 });
  service.runtimeDir = async () => 'runtime';
  const contexts = ['a', 'b', 'c'].map(context); contexts.forEach(x => service.scopes.set(x.revision, x));
  const first = await Promise.all(contexts.slice(0, 2).map(x => service.lease(x)));
  const third = service.lease(contexts[2]);
  first[0]();
  const thirdRelease = await third;
  assert.equal(peak, 2);
  first[1](); thirdRelease();
});

test('shared work survives one consumer abort and retries an aborted entry', async () => {
  const service = new CardService({ root: process.cwd(), dir: process.cwd(), runtime: {} });
  const cache = new Map(); let resolve; let starts = 0;
  const start = signal => { starts++; return new Promise((res, rej) => { resolve = res; signal.addEventListener('abort', () => rej(new Error('aborted'))); }); };
  const first = new AbortController();
  const a = service.shared(cache, 'frame', start, first.signal);
  const b = service.shared(cache, 'frame', start);
  await new Promise(resolve => setImmediate(resolve));
  first.abort(); resolve('ok');
  await assert.rejects(a); assert.equal(await b, 'ok'); assert.equal(starts, 1);
  const controller = new AbortController();
  const abandoned = service.shared(cache, 'retry', start, controller.signal); controller.abort();
  await assert.rejects(abandoned);
  const retry = service.shared(cache, 'retry', () => Promise.resolve('retry-ok'));
  assert.equal(await retry, 'retry-ok');
});

test('failed scope opening releases admission and can be retried', async () => {
  let attempts=0;
  const runtime={async open(){ if(++attempts===1) throw new Error('denied'); }};
  const service=new CardService({root:process.cwd(),dir:process.cwd(),runtime});
  service.runtimeDir=async()=> 'runtime';
  const one=context('one');service.scopes.set(one.revision,one);
  await assert.rejects(service.lease(one),/denied/);
  assert.equal(one.active,0);assert.equal(one.opened,null);
  const release=await service.lease(one);release();release();
  assert.equal(one.active,0);assert.equal(attempts,2);
});

test('runner restart reopens a retained scope instead of using a stale open promise', async () => {
  let attempts=0;
  const runtime={scopes:new Map(),async open(id){attempts++;this.scopes.set(id,true);}};
  const service=new CardService({root:process.cwd(),dir:process.cwd(),runtime});
  service.runtimeDir=async()=> 'runtime';
  const one=context('one');service.scopes.set(one.revision,one);
  (await service.lease(one))();runtime.scopes.clear();
  (await service.lease(one))();assert.equal(attempts,2);
});

test('closing waits for in-flight scope admission before shutting down the runner', async () => {
  const events=[];let finish;
  const runtime={async open(){events.push('opening');await new Promise(resolve=>{finish=resolve;});events.push('opened');},async close(){events.push('closed');}};
  const service=new CardService({root:process.cwd(),dir:process.cwd(),runtime});service.runtimeDir=async()=> 'runtime';
  const one=context('one');service.scopes.set(one.revision,one);
  const lease=service.lease(one);await new Promise(resolve=>setImmediate(resolve));
  const close=service.close();finish();(await lease)();await close;
  assert.deepEqual(events,['opening','opened','closed']);
});
