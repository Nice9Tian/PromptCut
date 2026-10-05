import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as runtime from '../runners/cli-runtime.mjs';

const fixture = fileURLToPath(new URL('./fixtures/codex-auth-cli.mjs', import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auth-state-'));
const previous = process.env.PROMPTCUT_CLI_HOME;
process.env.PROMPTCUT_AI_CONFIG = path.join(sandbox, 'ai.json');
mock.module(new URL('../runners/cli-runtime.mjs', import.meta.url).href, { namedExports: {
  ...runtime, resolveCli: name => `${name}-auth-simulation`,
  cliCommand: (exe, args) => /-auth-simulation$/.test(exe)
    ? { command: process.execPath, args: [fixture, ...args] } : runtime.cliCommand(exe, args),
} });
const { createCodexAuthState, codexAuthState, codexAuthReason, authErrorDecoder } = await import('../runners/codex-auth-state.mjs');
const { probeAuth } = await import('../runners/auth.mjs');
const { startRun } = await import('../runners/codex.mjs');
const { listProviders, startRun: startProvider } = await import('../runners/index.mjs');
const { createSetupService } = await import('../runners/setup.mjs');
const { startCliLoop } = await import('../runners/cli-loop.mjs');
const { probeQuota } = await import('../runners/quota.mjs');
let home;
const write = patch => fs.writeFileSync(path.join(home, 'simulation.json'), JSON.stringify(patch));
const calls = () => fs.existsSync(path.join(home, 'calls.jsonl')) ? fs.readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for(let n=0;n<300;n++) { if(fn()) return; await wait(10); } assert.fail('timeout'); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function run(extra = {}) {
  const events = [];
  const handle = startRun({ cwd: home, prompt: 'simulation only', systemPrompt: '', onEvent: ev => events.push(ev), ...extra });
  return { events, ...handle };
}
const terminals = events => events.filter(e => e.type === 'error' || e.type === 'done');
function invalidate() { const s=codexAuthState(); assert.equal(s.invalidate(s.snapshot().generation, 'token_revoked'), true); }
test.beforeEach(() => { home=fs.mkdtempSync(path.join(sandbox, 'case-')); process.env.PROMPTCUT_CLI_HOME=home; write({ loggedIn:true }); });
test.after(() => { if(previous===undefined) delete process.env.PROMPTCUT_CLI_HOME; else process.env.PROMPTCUT_CLI_HOME=previous;
  assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir())); fs.rmSync(sandbox,{recursive:true,force:true}); });

test('explicit OpenAI evidence only; split UTF8/data, untruncated tail; ordinary faults stay ordinary', () => {
  for(const text of ['token_revoked', 'Failed to refresh token: refresh_token_reused', '401 Unauthorized https://api.openai.com/v1/responses', 'workspace routing discovery unauthorized (401)']) assert.ok(codexAuthReason(text), text);
  for(const text of ['401 Unauthorized', 'network timeout', 'Failed to refresh token: connection reset', '429 https://api.openai.com', '503 https://api.openai.com', 'MCP external 401 token_revoked', '401 https://api.openai.com.evil.test']) assert.equal(codexAuthReason(text), null, text);
  const got=[];const decode=authErrorDecoder(r=>got.push(r));decode(Buffer.from('x'.repeat(4000)+' token_'));decode(Buffer.from('revoked'));assert.deepEqual(got,['token_revoked']);
  const huge=[];authErrorDecoder(r=>huge.push(r))(Buffer.from('token_revoked '+'x'.repeat(20000)));assert.deepEqual(huge,['token_revoked']);
  const external=[];const mcp=authErrorDecoder(r=>external.push(r));mcp(Buffer.from('MCP external '+'x'.repeat(20000)));mcp(Buffer.from(' token_revoked'));assert.deepEqual(external,[]);
});

test('runtime token_revoked overrides local login and both provider caches; repeated refresh cannot revive', async () => {
  assert.equal((await probeAuth('codex')).loggedIn,true);
  assert.equal((await listProviders()).find(p=>p.id==='codex').auth.loggedIn,true);
  write({scenario:'split'});const r=run();await r.done;
  assert.equal(terminals(r.events).length,1);assert.equal(terminals(r.events)[0].authReason,'token_revoked');
  assert.equal(codexAuthState().snapshot().state,'invalid');
  for(const refresh of [false,true,false]) assert.equal((await listProviders({refresh})).find(p=>p.id==='codex').auth.status,'invalid');
  // Runtime invalidation resolves before Windows completes asynchronous child termination.
  // Keep the exit requirement, but observe it within the existing bounded fixture wait.
  for(const {pid} of calls()) if(pid) await until(() => !alive(pid));
});

test('a delayed positive probe from before invalidation cannot seed auth cache', async () => {
  write({loggedIn:true,probeDelay:160});const p=probeAuth('codex',{refresh:true});await until(()=>calls().length>0);invalidate();
  assert.equal((await p).status,'invalid');assert.equal((await probeAuth('codex')).status,'invalid');
});

test('old negative probe cannot overwrite a successful newer login', async () => {
  write({loggedIn:false,probeDelay:180});const old=probeAuth('codex',{refresh:true});await until(()=>calls().length>0);
  const state=codexAuthState();state.completeLogin(state.beginLogin());write({loggedIn:true});
  assert.equal((await old).loggedIn,true);assert.equal((await probeAuth('codex')).loggedIn,true);
});

test('failed active re-login does not hide revocation from an existing run',async()=>{
  write({scenario:'stderr',runDelay:150});const old=run();await until(()=>calls().some(c=>c.args?.[0]==='exec'));
  codexAuthState().beginLogin();await old.done;assert.equal(codexAuthState().snapshot().state,'invalid');
});

test('older successful login callback cannot replace a newer login',async()=>{
  invalidate();let release;const pending=new Promise(r=>release=r);
  const older=createSetupService({verifyAuth:async(_provider,opts)=>{assert.equal(opts.raw,true);await pending;return{loggedIn:true};}});
  older.start('codex','login');await until(()=>calls().some(c=>c.args?.[0]==='login'&&!c.args?.[1]));
  const newer=createSetupService();newer.start('codex','login');await until(()=>newer.list()[0].state==='succeeded');
  const revision=codexAuthState().snapshot().revision;release();await until(()=>older.list()[0].state!=='running');
  assert.equal(older.list()[0].state,'failed');assert.equal(codexAuthState().snapshot().revision,revision);older.dispose();newer.dispose();
});

test('persist across fresh process; home isolation; corrupt record yields unknown and allows verified recovery', () => {
  invalidate();const moduleUrl=new URL('../runners/codex-auth-state.mjs',import.meta.url).href;
  const output=execFileSync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(m.codexAuthState().effective({loggedIn:true})))`],{env:process.env,encoding:'utf8',windowsHide:true});
  assert.equal(JSON.parse(output).status,'invalid');
  assert.equal(createCodexAuthState(path.join(home,'different')).effective({loggedIn:true}).loggedIn,true);
  const file=path.join(home,'codex-home','promptcut-auth-state.json'); const saved=JSON.parse(fs.readFileSync(file));
  assert.deepEqual(Object.keys(saved).sort(),['generation','reason','revision','state','time','version']);
  fs.writeFileSync(file,'{bad');const s=createCodexAuthState(home);assert.equal(s.effective({loggedIn:true}).loggedIn,null);
  assert.equal(s.completeLogin(s.beginLogin()),true);assert.equal(createCodexAuthState(home).snapshot().state,'normal');
});

test('persistence failure keeps memory invalid and exposes limitation; unexpected record data is discarded', () => {
  const s=createCodexAuthState(home,{io:{...fs,writeFileSync(){throw new Error('read-only');}}});
  assert.equal(s.invalidate(s.snapshot().generation,'token_revoked'),true);assert.equal(s.effective({loggedIn:true}).loggedIn,false);assert.match(s.snapshot().persistenceWarning,/重启/);
});

test('successful raw login clears old invalidity and persisted marker; duplicate clicks reuse one job', async () => {
  invalidate();write({loggedIn:true,loginDelay:100});const service=createSetupService();
  const first=service.start('codex','login');assert.equal(service.start('codex','login').id,first.id);
  await until(()=>service.list()[0].state!=='running');assert.equal(service.list()[0].state,'succeeded',service.list()[0].message);
  assert.equal(codexAuthState().snapshot().state,'normal');assert.equal((await probeAuth('codex',{refresh:true})).loggedIn,true);
  assert.equal(createCodexAuthState(home).snapshot().state,'normal');assert.equal(calls().filter(c=>c.args?.[0]==='login'&&!c.args?.[1]).length,1);service.dispose();
});

for(const outcome of ['fail','unconfirmed','cancel','timeout']) test(`login ${outcome} preserves invalidity and recovery entry`,async()=>{
  invalidate();write({loginOutcome:['cancel','timeout'].includes(outcome)?'hang':outcome});
  const service=createSetupService({timeoutMs:outcome==='timeout'?150:3000});service.start('codex','login');
  if(outcome==='cancel') {await until(()=>calls().some(c=>c.args?.[0]==='login'&&!c.args?.[1]));service.cancel('codex');}
  await until(()=>service.list()[0].state!=='running');assert.equal(service.list()[0].state,'failed');assert.equal(codexAuthState().snapshot().state,'invalid');
  assert.equal((await probeAuth('codex',{refresh:true})).status,'invalid');service.dispose();await wait(50);
});

test('late old run and old login success cannot pollute the newer successful login generation', async()=>{
  write({scenario:'stderr',runDelay:400});const old=run();await until(()=>calls().some(c=>c.args?.[0]==='exec'));
  const s=codexAuthState();const a=s.beginLogin();const b=s.beginLogin();assert.equal(s.completeLogin(b),true);assert.equal(s.completeLogin(a),false);
  await old.done;assert.equal(s.snapshot().state,'normal');assert.equal(terminals(old.events).length,1);assert.equal(terminals(old.events)[0].authReason,undefined);
});

test('known invalid and corrupt states block CLI at server entry, including text protocol; other providers remain separate', async()=>{
  invalidate();const before=calls().length;
  for(const toolProtocol of [false,true]) {const r=run({toolProtocol});await r.done;assert.equal(terminals(r.events).length,1);assert.equal(terminals(r.events)[0].authReason,'token_revoked');}
  assert.equal(calls().length,before);assert.equal((await probeAuth('agy',{refresh:true})).reason,undefined);
  const beforeQuota=calls().length;assert.equal((await probeQuota('codex')).ok,false);assert.equal(calls().length,beforeQuota,'invalid quota probe must not start app-server');
  const otherEvents=[];const other=startProvider({provider:'claude',cwd:home,systemPrompt:'',prompt:'simulation only',onEvent:e=>otherEvents.push(e)});await other.done;
  assert.equal(calls().length,beforeQuota+1,'another provider can still start its simulated CLI');assert.ok(!otherEvents.some(e=>e.type==='error'));
  const corruptHome=fs.mkdtempSync(path.join(sandbox,'corrupt-'));fs.mkdirSync(path.join(corruptHome,'codex-home'));fs.writeFileSync(path.join(corruptHome,'codex-home','promptcut-auth-state.json'),'invalid');
  process.env.PROMPTCUT_CLI_HOME=corruptHome;const unknown=run();await unknown.done;assert.equal(terminals(unknown.events)[0].authReason,'state_unknown');
});

test('auth error passes text protocol and permission fallback without executing tools or replaying prompt',async()=>{
  for(const toolProtocol of [true,false]) {
    const s=codexAuthState();s.completeLogin(s.beginLogin());write({scenario:'stdout',denied:true});let tools=0;
    const before=calls().filter(c=>c.args?.[0]==='exec').length;const r=run({toolProtocol,callTool:()=>{tools++;}});await r.done;
    assert.equal(terminals(r.events).length,1);assert.equal(terminals(r.events)[0].authReason,'token_revoked');assert.equal(tools,0);
    assert.equal(calls().filter(c=>c.args?.[0]==='exec').length-before,1);assert.ok(!r.events.some(e=>e.text?.includes('文本协议重试')));
  }
});

test('immediate text-protocol cancel never starts CLI or executes queued tool blocks',async()=>{
  write({scenario:'split'});let tools=0;const r=run({toolProtocol:true,callTool:()=>tools++});r.abort();await r.done;
  assert.equal(calls().filter(c=>c.args?.[0]==='exec').length,0);assert.equal(tools,0);assert.equal(terminals(r.events).length,0);
});

test('review loop preserves auth metadata and never retries even if retryable was incorrectly set',async()=>{
  let starts=0;const events=[];const r=startCliLoop({prompt:'simulation',systemPrompt:'',onEvent:e=>events.push(e)},opts=>{
    starts++;opts.onEvent({type:'error',message:'login invalid',authProvider:'codex',authReason:'token_revoked',retryable:true});return{abort(){},done:Promise.resolve()};
  },{lessonsStore:{read:()=>[],add(){}}});await r.done;assert.equal(starts,1);assert.equal(terminals(events).length,1);assert.equal(terminals(events)[0].authReason,'token_revoked');
});

for(const error of ['network disconnected','timeout','429 Too Many Requests','503 Service Unavailable','MCP external 401 Unauthorized']) test(`runtime does not invalidate on ${error}`,async()=>{
  write({scenario:'stderr',error});const r=run();await until(()=>calls().some(c=>c.args?.[0]==='exec'));await wait(80);r.abort();await r.done;
  assert.equal(codexAuthState().snapshot().state,'normal');assert.equal(terminals(r.events).length,0);
});

test('external MCP token_revoked is a tool failure, not OpenAI login invalidity',async()=>{
  write({scenario:'mcp'});const r=run({toolProtocol:true});await r.done;assert.equal(codexAuthState().snapshot().state,'normal');assert.equal(terminals(r.events).length,1);
});

test('cancel races authentication; abnormal exit and early turn done settle once and leave no process',async()=>{
  for(const scenario of ['stderr','exit','normal']) {
    const s=codexAuthState();s.completeLogin(s.beginLogin());write({scenario,runDelay:100});const r=run();
    if(scenario==='stderr') {await until(()=>calls().some(c=>c.args?.[0]==='exec'));r.abort();}
    await r.done;assert.ok(terminals(r.events).length<=1);for(const c of calls()) if(c.pid) await until(() => !alive(c.pid));
  }
});

test('fatal auth cleans only this Windows CLI process tree; unrelated task process survives', {skip:process.platform!=='win32'},async()=>{
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  try { write({scenario:'split',descendant:true});const r=run();await r.done;
    for(const c of calls()) if(c.pid||c.descendant) await until(() => !alive(c.pid||c.descendant));
    assert.equal(alive(unrelated.pid),true);
  } finally {const closed=new Promise(r=>unrelated.once('close',r));unrelated.kill('SIGKILL');await closed;}
});
