import '../lib/no-user-dirs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as publicPath from './lib/account-public-path.mjs';
import { publicOptions, projectFromVisibleLink, projectFrameMetadata, testAccountMetadata, resourceMetadata, testIdentities } from './lib/account-public-path.mjs';

for (const name of ['enterNewProject', 'joinProject']) test(`actual ${name} waits for enabled controls before input and again before click`, async () => {
  const source = await fs.readFile(new URL('./account-public-user-pages-probe.mjs', import.meta.url), 'utf8');
  const body = new RegExp(`async function ${name}\\([\\s\\S]*?\\n}`).exec(source)?.[0];
  assert.ok(body);
  let enabled = false, stopped = false;
  const fills = [], clicks = [];
  const node = { disabled:false, readOnly:false, getClientRects:() => [1] };
  const button = { ...node, get disabled() { return !enabled; } };
  const document = { querySelector:selector => selector.includes('cloud-create') || selector.includes('cloud-join') ? button : node };
  const page = {
    async waitForFunction(predicate, _options, ...args) {
      const check = vm.runInNewContext(`(${predicate.toString()})`, { document });
      while (!check(...args)) {
        if (stopped) throw new Error('controlled-test-stopped');
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    async click(selector) { clicks.push(selector); throw new Error('controlled-after-real-click'); },
  };
  const action = vm.runInNewContext(`(${body})`, {
    waitForEnabledForm:publicPath.waitForEnabledForm,
    projectStep:async (_page, _stage, callback) => callback(),
    type:async (_page, selector) => { fills.push(selector); enabled = false; },
  });
  const outcome = action(page, name === 'joinProject' ? { link:'controlled-input' } : 'controlled-input', 'controlled').then(() => null, error => error);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fills.length, 0, 'busy controls must prevent even early input');
    assert.equal(clicks.length, 0);
    enabled = true;
    while (!fills.length) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clicks.length, 0, 'a new disabled interval during input must prevent submit');
    enabled = true;
    assert.equal((await outcome)?.message, 'controlled-after-real-click');
    assert.equal(fills.length, 1); assert.equal(clicks.length, 1);
  } finally { stopped = true; enabled = true; await outcome; }
});

test('actual website login waits for anonymous initialization, its existing handler and enabled submit', async () => {
  const source = await fs.readFile(new URL('./account-public-user-pages-probe.mjs', import.meta.url), 'utf8');
  const extract = name => new RegExp(`async function ${name}\\([\\s\\S]*?\\n}`).exec(source)?.[0];
  let enabled = false, handlerReady = false, stopped = false;
  const fills = [], clicks = [], inspected = [];
  const button = { get disabled() { return !enabled; }, getClientRects:() => [1] };
  const input = { disabled:false, readOnly:false, getClientRects:() => [1] };
  const nav = { querySelector:() => input };
  const document = { querySelector:selector => selector === '.who' ? nav : selector.includes('button') ? button : input };
  const page = {
    safeMe:{ anonymous:false },
    async goto() {}, async waitForNavigation() {},
    async waitForFunction(predicate, _options, ...args) {
      const check = vm.runInNewContext(`(${predicate.toString()})`, { document, location:{ pathname:'/login' } });
      while (!check(...args)) { if (stopped) throw new Error('controlled-test-stopped'); await new Promise(resolve => setImmediate(resolve)); }
    },
    async click(selector) { clicks.push(selector); throw new Error('controlled-after-real-click'); },
    registrationCdp:{ async send(method, payload) {
      inspected.push({ method, objectId:payload?.objectId });
      if (method === 'Runtime.evaluate') return { result:{ objectId:'same-session-form' } };
      if (method === 'DOMDebugger.getEventListeners') return { listeners:handlerReady ? [{ type:'submit' }] : [] };
      return {};
    } },
  };
  const context = {
    browser:{ async createBrowserContext() { return {}; } }, contexts:[], newPage:async () => page,
    ORIGIN:'https://visuhive.com', waitForEnabledForm:publicPath.waitForEnabledForm,
    websiteStep:async (_page, _stage, callback) => callback(),
    waitFor:async predicate => { while (!await predicate()) { if (stopped) throw new Error('controlled-test-stopped'); await new Promise(resolve => setImmediate(resolve)); } },
    type:async (_page, selector) => { fills.push(selector); enabled = false; },
  };
  context.waitWebsiteFormReady = vm.runInNewContext(`(${extract('waitWebsiteFormReady')})`, context);
  const login = vm.runInNewContext(`(${extract('websiteList')})`, context);
  const outcome = login({ name:'controlled-name', password:'never-log' }, 'owned', 'controlled-id', 'controlled-project', 'controlled').then(() => null, error => error);
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(fills.length, 0);
    page.safeMe.anonymous = true; enabled = true;
    // A visible/enabled button alone is insufficient without the actual handler.
    while (!inspected.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(fills.length, 0); handlerReady = true;
    while (fills.length < 2) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(clicks.length, 0);
    enabled = true;
    assert.equal((await outcome)?.message, 'controlled-after-real-click');
    assert.equal(clicks.length, 1);
    assert.ok(inspected.filter(entry => entry.method === 'DOMDebugger.getEventListeners').every(entry => entry.objectId === 'same-session-form'));
    assert.ok(inspected.some(entry => entry.method === 'Runtime.releaseObject' && entry.objectId === 'same-session-form'));
  } finally { stopped = true; enabled = true; handlerReady = true; await outcome; }
});

test('the browser availability predicate rejects hidden, locked and unauthenticated project controls without changing DOM', async () => {
  let visible = true, buttonDisabled = false, inputDisabled = false, readOnly = false, accountPresent = true;
  const button = { get disabled() { return buttonDisabled; }, getClientRects:() => visible ? [1] : [] };
  const input = { get disabled() { return inputDisabled; }, get readOnly() { return readOnly; }, getClientRects:() => [1] };
  const document = { querySelector:selector => selector === 'button' ? button : selector === 'input' ? input : accountPresent ? input : null };
  const page = { async waitForFunction(predicate, _options, ...args) {
    assert.equal(vm.runInNewContext(`(${predicate.toString()})`, { document })(...args), true);
  } };
  const options = { buttonSelector:'button', inputSelector:'input', requireAccount:true };
  await publicPath.waitForEnabledForm(page, options);
  for (const set of [() => { visible = false; }, () => { buttonDisabled = true; }, () => { inputDisabled = true; }, () => { readOnly = true; }, () => { accountPresent = false; }]) {
    visible = true; buttonDisabled = false; inputDisabled = false; readOnly = false; accountPresent = true;
    set(); await assert.rejects(publicPath.waitForEnabledForm(page, options), { code:'ERR_ASSERTION' });
  }
  assert.equal(accountPresent, false, 'the predicate must not fabricate authentication');
});

test('public writes require an explicit flag and private native arguments never change the public host', () => {
  assert.equal(publicOptions([]).run, false);
  assert.equal(publicOptions(['--dry-preflight']).run, false);
  assert.equal(publicOptions(['--run-public']).run, true);
  for (const args of [['--origin', 'https://evil'], ['--password', 'secret'], ['--run-public', '--dry-preflight'], ['--out', os.tmpdir()], ['--desktop-exe', 'C:/installed.exe']]) assert.throws(() => publicOptions(args));
  const options = publicOptions(['--desktop-exe', path.join(os.tmpdir(), 'isolated-public-build', 'promptcut.exe'), '--desktop-profile-root', path.join(os.tmpdir(), 'isolated-public-profile'), '--desktop-sha256', 'a'.repeat(64), '--desktop-source-root', path.join(os.tmpdir(), 'isolated-public-source')]);
  assert.equal(options.run, false); assert.equal(options.sha, 'a'.repeat(64));
});
test('resource diagnostics discard query/header secrets and visible link has a strict real public project shape', () => {
  const meta = resourceMetadata('https://visuhive.com/editor/assets/main.js?ticket=never-log', 'script', 200, 'text/javascript');
  assert.deepEqual(meta, { path:'/editor/assets/main.js', type:'script', status:200, mime:'text/javascript' });
  assert.ok(!JSON.stringify(meta).includes('never-log'));
  assert.equal(resourceMetadata('https://evil/editor/x', 'script', 200, 'text/javascript'), null);
  assert.equal(resourceMetadata('https://visuhive.com/api/account/me?secret=x', 'fetch', 200, 'application/json'), null);
  assert.equal(projectFromVisibleLink(`项目链接：https://visuhive.com/editor?project=sp_${'a'.repeat(26)}`).projectId, `sp_${'a'.repeat(26)}`);
  assert.throws(() => projectFromVisibleLink(`https://evil/editor?project=sp_${'a'.repeat(26)}`));
  const identities = testIdentities(); assert.ok(identities.accounts.every(a => a.name.startsWith(identities.marker) && a.password.length >= 32));
  assert.notEqual(identities.accounts[0].password, identities.accounts[1].password);
});
test('actual Rust isolation functions and their own assertions compile and reject public/native boundary deviations', async () => {
  const rust = await fs.readFile(new URL('../../desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const extract = name => { const value = new RegExp(`^fn ${name}\\([\\s\\S]*?^}`, 'm').exec(rust)?.[0]; assert.ok(value); return value; };
  const ownTest = /^    fn account_probe_binding_is_identifier_and_port_scoped\(\)[\s\S]*?^    }/m.exec(rust)?.[0]; assert.ok(ownTest);
  const constant = /^const EDITOR_PORT: u16 = [0-9]+;/m.exec(rust)?.[0]; assert.ok(constant);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-account-public-rust-'));
  try {
    const source = path.join(dir, 'binding.rs'), binary = path.join(dir, process.platform === 'win32' ? 'binding.exe' : 'binding');
    await fs.writeFile(source, `${constant}\n${extract('account_editor_port')}\n${extract('account_cloud_binding')}\n#[test]\n${ownTest}\n`);
    const compiled = spawnSync('rustc', ['--edition=2021', '--test', source, '-o', binary], { windowsHide:true, encoding:'utf8', timeout:60_000 });
    assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stderr);
    const checked = spawnSync(binary, [], { windowsHide:true, encoding:'utf8', timeout:10_000 });
    assert.equal(checked.error, undefined); assert.equal(checked.status, 0, checked.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive:true, force:true });
  }
});

test('real project-state diagnostics keep only exact public project binding and discard all other frame data', () => {
  const projectId = `sp_${'a'.repeat(26)}`;
  const payload = JSON.stringify({ type:'project.state', projectId, body:{ password:'never-log' }, ticket:'never-log', sid:'never-log' });
  assert.deepEqual(projectFrameMetadata(payload, 'received'), { type:'project.state', projectId });
  assert.deepEqual(projectFrameMetadata(payload, 'sent'), { type:'project.state' });
  assert.deepEqual(projectFrameMetadata(JSON.stringify({ type:'project.open', projectId }), 'sent'), { type:'project.open', projectId });
  assert.deepEqual(projectFrameMetadata(JSON.stringify({ type:'project.state', projectId:projectId + '?ticket=secret' }), 'received'), { type:'project.state' });
  assert.equal(projectFrameMetadata('{', 'received'), null);
  assert.equal(projectFrameMetadata('null', 'received'), null);
  assert.equal(projectFrameMetadata(JSON.stringify({ type:'arbitrary\nsecret', projectId }), 'received'), null);
});

test('test account identity comes only from the actual public account shape and exact own marker', () => {
  const marker = 'pcpub_abcdef012345_a', id = `acc_${'1'.repeat(24)}`;
  const body = { account:{ id, name:marker, extra:'never-log' }, csrfToken:'never-log', session:{ token:'never-log' } };
  assert.deepEqual(testAccountMetadata(body, marker), { accountId:id, marker });
  assert.equal(testAccountMetadata({ account:null }, marker), null);
  assert.equal(testAccountMetadata({ accountId:id, id }, marker), null);
  assert.equal(testAccountMetadata(body, 'pcpub_abcdef012345_b'), null);
  assert.equal(testAccountMetadata({ account:{ id:id + '?secret=x', name:marker } }, marker), null);
  assert.equal(testAccountMetadata({ account:{ id, name:'unowned-account' } }, 'unowned-account'), null);
});

test('actual default/dry CLI stops before browser, public network or account creation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-account-public-dry-'));
  try {
    const out = path.join(dir, 'out');
    const checked = spawnSync(process.execPath, [fileURLToPath(new URL('./account-public-user-pages-probe.mjs', import.meta.url)), '--dry-preflight', '--out', out], {
      windowsHide:true, encoding:'utf8', timeout:10_000,
    });
    assert.equal(checked.error, undefined); assert.equal(checked.status, 0, checked.stderr);
    const result = JSON.parse(await fs.readFile(path.join(out, 'result.json'), 'utf8'));
    assert.equal(result.summary.mode, 'dry-preflight'); assert.equal(result.summary.completed, false);
    assert.equal(result.summary.dryPreflightPassed, true); assert.equal(result.cleanup.browser, 'not-started');
    assert.deepEqual(result.network, []); assert.deepEqual(result.websocket, []); assert.deepEqual(result.screenshots, []);
    assert.equal(result.accountNames, undefined); assert.equal(result.ownedProjects, undefined);
    assert.equal(result.preflight.publicNetwork, 'not-contacted');
  } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive:true, force:true }); }
});
