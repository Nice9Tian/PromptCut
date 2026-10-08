import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { createAccountV2InstallPlan, formatWorkingDirectory } from '../hosted/deploy/account-v2-install-plan.mjs';

function fixture(t, { cleanup = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-v2-install-'));
  const removeFixture = () => {
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('outside-temp');
    fs.rmSync(dir, { recursive: true, force: true });
  };
  if (cleanup) t.after(removeFixture);
  const pki = assetWiringPki(dir);
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  const caFile = path.join(publicDir, 'ca.crt');
  fs.copyFileSync(path.join(dir, 'ca.crt'), caFile);
  const write = (file, bytes, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode }); return file; };
  const role = name => {
    const keyFile = write(path.join(dir, `${name}-private`, `${name}.key`), pki[name].key);
    const certFile = write(path.join(publicDir, `${name}.crt`), pki[name].cert, 0o644);
    return { keyFile, certFile, caFile, fingerprint256: pki[name].fingerprint256 };
  };
  const pair = (name, owner) => {
    const value = generateKeyPairSync('ed25519');
    return { privateFile: write(path.join(dir, `${owner}-private`, `${name}.pem`),
      value.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publicFile: write(path.join(publicDir, `${name}.pub.pem`), value.publicKey.export({ type: 'spki', format: 'pem' }), 0o644) };
  };
  const vhSourceDir = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT;
  assert.ok(path.isAbsolute(vhSourceDir ?? '') && fs.existsSync(path.join(vhSourceDir, 'account', 'server.mjs')),
    'actual VisuHive main provider is required');
  const pcSourceDir = fileURLToPath(new URL('../..', import.meta.url));
  const docDataDir = path.join(dir, 'doc-data'), accountDataDir = path.join(dir, 'account-data');
  const assetDataDir = path.join(dir, 'asset-data');
  for (const data of [docDataDir, accountDataDir, assetDataDir]) fs.mkdirSync(data);
  const token = write(path.join(docDataDir, 'secrets', 'cluster-token'), 'A'.repeat(48));
  const credential = write(path.join(dir, 'account-private', 'credential.key'), Buffer.alloc(32, 7));
  const manifest = {
    v: 1, authorityId: 'production-doc-test', enabledServices: ['account', 'doc', 'asset'],
    roles: { account: role('account'), doc: role('doc'), asset: role('asset') },
    internalOrigins: { account: 'https://127.0.0.1:6443/', doc: 'https://127.0.0.1:6444/',
      asset: 'https://127.0.0.1:6445/' },
    publicUrls: { accountOrigin: 'https://example.test/', docPublicUrl: 'wss://example.test/hosted/',
      assetPublicUrl: 'https://example.test/media/api/asset', authorityUrl: 'https://example.test/editor' },
    ports: { account: 6440, doc: 6441, asset: 6442 },
    paths: { accountRegistryFile: path.join(publicDir, 'account-registry.json'),
      docRegistryFile: path.join(publicDir, 'doc-registry.json'), orderWitnessKeysFile: path.join(publicDir, 'order-keys.json'),
      accountCredentialKeyFile: credential, accountDataDir, docDataDir, assetDataDir,
      assetRecoveryFenceFile: path.join(dir, 'recovery-fence.json'),
      accountOrderModuleFile: path.join(vhSourceDir, 'account', 'password-order.mjs') },
    keys: { docSigning: { keyId: 'doc-signing', privateFile: pair('doc-signing', 'doc').privateFile },
      accountOrder: { keyId: 'account-order', ...pair('account-order', 'account') },
      docAttestation: pair('doc-attestation', 'doc') },
    assetServiceIdentity: 'promptcut-asset-v2',
  };
  const manifestFile = write(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const options = { manifestFile, installDir: path.join(dir, 'install-plan'), nodePath: process.execPath,
    pcSourceDir, vhSourceDir, users: { account: 'vh_account', doc: 'pc_doc', asset: 'pc_asset' } };
  return { dir, pki, manifest, options, token, removeFixture, load: () => {
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    return createAccountV2InstallPlan(options);
  } };
}

const waitFor = async (check, label, timeoutMs = 20_000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`timeout:${label}`);
};
const request = (port, method, route, body, headers = {}) => new Promise((resolve, reject) => {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port, method, path: route, timeout: 5000,
    headers: { ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}), ...headers } },
  res => {
    const parts = [];
    res.on('data', chunk => parts.push(chunk)); res.once('error', reject);
    res.once('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')),
        cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); }
      catch (error) { reject(error); }
    });
  });
  req.once('error', reject); req.once('timeout', () => req.destroy(Error('request-timeout')));
  req.end(bytes);
});
const child = (nodePath, script, cwd, vars) => {
  const env = { ...process.env, ...vars };
  if (!Object.hasOwn(vars, 'PROMPTCUT_DOC_AGENT_SERVICE_KID')) delete env.PROMPTCUT_DOC_AGENT_SERVICE_KID;
  if (!Object.hasOwn(vars, 'PROMPTCUT_ASSET_INSTANCE_ID')) delete env.PROMPTCUT_ASSET_INSTANCE_ID;
  const processHandle = spawn(nodePath, [script], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', bytes => {
    if (output.length < 32_768) output += bytes.toString('utf8').slice(0, 32_768 - output.length);
  });
  const closed = new Promise(resolve => processHandle.once('close', (code, signal) => resolve({ code, signal })));
  return { processHandle, closed, get output() { return output; }, async stop() {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
    return closed;
  } };
};
const portClosed = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true));
});

test('account v2 install plan emits exactly three independent path-only units and retains old token', t => {
  const { manifest, options, token, load } = fixture(t);
  const result = load();
  assert.deepEqual(Object.keys(result.units), ['account', 'doc', 'asset']);
  assert.deepEqual(result.publicConfig.enabledServices, ['account', 'doc', 'asset']);
  assert.equal(result.existingRequired.includes(token), true);
  assert.equal(result.fileAccess.doc.writeData, manifest.paths.docDataDir);
  assert.equal(result.fileAccess.asset.writeData, manifest.paths.assetDataDir);
  assert.equal(result.fileAccess.asset.denyPrivate.includes(manifest.roles.doc.keyFile), true);
  assert.equal(result.fileAccess.doc.denyPrivate.includes(manifest.roles.asset.keyFile), true);
  assert.deepEqual(result.filePolicies[result.units.doc.envFile], { owner: 'root', group: 'pc_doc', mode: '0640' });
  assert.deepEqual(result.filePolicies[result.units.doc.unitFile], { owner: 'root', group: 'root', mode: '0644' });
  const docUnit = result.files[result.units.doc.unitFile];
  assert.equal(/^WorkingDirectory=(.*)$/m.exec(docUnit)?.[1],
    options.pcSourceDir.replaceAll('%', '%%').replaceAll('\\', '\\\\'),
    'systemd WorkingDirectory is one unquoted absolute path, not an ExecStart argument');
  assert.match(docUnit, /User=pc_doc/);
  assert.match(docUnit, /ReadWritePaths=.*doc-data/);
  assert.match(docUnit, /InaccessiblePaths=/);
  assert.match(docUnit, /Restart=on-failure/);
  assert.match(docUnit, /ExecStart=.*main\.mjs/);
  assert.ok(docUnit.includes(process.execPath.replaceAll('\\', '\\\\')));
  const assetUnit = result.files[result.units.asset.unitFile];
  assert.match(assetUnit, /User=pc_asset/);
  assert.doesNotMatch(assetUnit, /doc-data.*ReadWritePaths/);
  assert.ok(result.files[result.units.doc.envFile].includes('PROMPTCUT_ACCOUNT_V2_REQUIRED="1"'));
  assert.ok(result.files[result.units.doc.envFile].includes('PROMPTCUT_ASSET_STATUS_ORIGIN='));
  assert.ok(!Object.values(result.files).some(value => value.includes('BEGIN PRIVATE KEY')));
  assert.ok(!Object.values(result.files).some(value => value.includes('A'.repeat(48))));
  assert.equal(fs.readFileSync(token, 'utf8'), 'A'.repeat(48));
  assert.equal(result.units.account.user, options.users.account);
  assert.equal(result.installOnly, true);
});

test('systemd WorkingDirectory keeps one raw path with internal space and escaped percent/backslash', () => {
  const root = path.parse(process.cwd()).root;
  const withSpace = path.join(root, 'PromptCut Source', '100%');
  assert.equal(formatWorkingDirectory(withSpace), withSpace.replaceAll('%', '%%').replaceAll('\\', '\\\\'));
  const withBackslash = path.join(root, 'PromptCut\\Source');
  assert.equal(formatWorkingDirectory(withBackslash), withBackslash.replaceAll('\\', '\\\\'));
  assert.throws(() => formatWorkingDirectory(path.join(root, 'PromptCut Source ')),
    error => error.code === 'working-directory');
  assert.throws(() => formatWorkingDirectory(path.join(root, 'Prompt"Cut')),
    error => error.code === 'working-directory');
});

test('account v2 install plan rejects unsafe users, missing old token and shared private directories', t => {
  const { manifest, options, token, load } = fixture(t);
  options.users.asset = options.users.doc;
  assert.throws(load, error => error.code === 'service-users');
  options.users.asset = 'pc_asset';
  fs.unlinkSync(token);
  assert.throws(load, error => error.code === 'existing-cluster-token');
  fs.writeFileSync(token, 'A'.repeat(48), { mode: 0o600 });
  manifest.roles.asset.keyFile = manifest.roles.doc.keyFile;
  assert.throws(load, error => ['role-certificate', 'duplicate-role-identity'].includes(error.code));
});

test('account v2 install plan rejects nested account, doc and asset data roots', t => {
  const { manifest, load } = fixture(t);
  const nestedAsset = path.join(manifest.paths.docDataDir, 'asset-data');
  fs.mkdirSync(nestedAsset);
  manifest.paths.assetDataDir = nestedAsset;
  assert.throws(load, error => error.code === 'data-boundary');
});

test('production main rejects unknown, missing and repeated internal service identities', async t => {
  const { dir, manifest, options, load } = fixture(t);
  const plan = load();
  for (const [file, contents] of Object.entries(plan.files)) {
    if (!Object.hasOwn(plan, 'units') || ![manifest.paths.accountRegistryFile, manifest.paths.docRegistryFile,
      manifest.paths.orderWitnessKeysFile].includes(file)) continue;
    fs.writeFileSync(file, contents);
  }
  const registryFile = manifest.paths.docRegistryFile;
  const baseline = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const variants = [
    { name: 'unknown', value: [...baseline, { serviceId: 'unknown', fingerprint256: 'f'.repeat(64) }] },
    { name: 'missing-account', value: baseline.filter(entry => entry.serviceId !== 'account') },
    { name: 'missing-asset', value: baseline.filter(entry => entry.serviceId !== 'asset') },
    { name: 'duplicate-pin', value: [baseline[0], { ...baseline[1], fingerprint256: baseline[0].fingerprint256 }] },
    { name: 'undeclared-agent', value: [...baseline, { serviceId: 'agent', fingerprint256: 'e'.repeat(64) }] },
    { name: 'missing-status', value: baseline, add: { PROMPTCUT_ASSET_STATUS_ORIGIN: '' } },
    { name: 'static-instance', value: baseline, add: { PROMPTCUT_ASSET_INSTANCE_ID: 'fixture-instance' } },
  ];
  for (const variant of variants) {
    fs.writeFileSync(registryFile, JSON.stringify(variant.value));
    const env = { ...configEnv(plan.files[plan.units.doc.envFile]), ...variant.add };
    const attempt = child(options.nodePath, path.join(options.pcSourceDir, 'server/hosted/main.mjs'),
      options.pcSourceDir, env);
    let timeout;
    const ended = await Promise.race([attempt.closed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error(`main-config-hung:${variant.name}`)), 5000);
    })]).finally(() => clearTimeout(timeout));
    assert.equal(ended.code, 1, `main accepted ${variant.name}`);
    assert.match(attempt.output, /"event":"config.error"/);
    assert.equal(await portClosed(manifest.ports.doc), true);
  }
  fs.writeFileSync(registryFile, JSON.stringify(baseline));
  t.diagnostic(`main config negatives: ${variants.map(value => value.name).join(',')}; no doc listener`);
});

test('root-provisioned three-role env starts real account, main doc and separate asset with actual project query', async t => {
  const { dir, manifest, options, load, removeFixture } = fixture(t, { cleanup: false });
  const plan = load();
  for (const [file, contents] of Object.entries(plan.files)) if ([manifest.paths.accountRegistryFile,
    manifest.paths.docRegistryFile, manifest.paths.orderWitnessKeysFile].includes(file)) fs.writeFileSync(file, contents);
  const accountEnv = configEnv(plan.files[plan.units.account.envFile]);
  // The Linux deployment value stays an absolute path. Node's Windows ESM
  // importer needs a file URL when executing VH's existing dynamic import.
  if (process.platform === 'win32') accountEnv.ACCOUNT_ORDER_MODULE = pathToFileURL(accountEnv.ACCOUNT_ORDER_MODULE).href;
  const account = child(options.nodePath, path.join(options.vhSourceDir, 'account/server.mjs'),
    options.vhSourceDir, accountEnv);
  let doc, asset;
  t.after(async () => {
    const closed = await Promise.all([asset, doc, account].filter(Boolean).map(value => value.stop()));
    assert.equal(closed.every(Boolean), true);
    for (const port of [6440, 6441, 6442, 6443, 6444, 6445]) assert.equal(await portClosed(port), true,
      `owned port ${port} remained open`);
    t.diagnostic(`closed account/doc/asset pids; ports 6440-6445 clear`);
    try { removeFixture(); }
    catch (error) { t.diagnostic(`temporary fixture cleanup pending: ${error.code ?? 'unknown'}`); }
  });
  await waitFor(async () => (await request(6440, 'GET', '/api/account/me')).status === 200, 'actual-account');
  doc = child(options.nodePath, path.join(options.pcSourceDir, 'server/hosted/main.mjs'), options.pcSourceDir,
    configEnv(plan.files[plan.units.doc.envFile]));
  await waitFor(async () => (await request(6441, 'GET', '/healthz')).status === 200, 'actual-doc');
  const actor = { cookie: '', csrf: '' };
  const accountRequest = async (method, route, body) => {
    const result = await request(6440, method, `/api/account${route}`, body, {
      ...(actor.cookie ? { cookie: actor.cookie } : {}),
      ...(method === 'POST' ? { origin: 'https://example.test', 'sec-fetch-site': 'same-origin',
        'x-csrf-token': actor.csrf } : {}),
    });
    if (result.cookie) actor.cookie = result.cookie;
    if (result.body.csrfToken) actor.csrf = result.body.csrfToken;
    return result;
  };
  const initial = await accountRequest('GET', '/me');
  assert.equal(initial.status, 200);
  const registered = await accountRequest('POST', '/register', {
    name: 'InstallPlanAccount', password: 'temporary-install-test-password', remember: false });
  assert.equal(registered.status, 200, `register:${registered.status}`);
  const editor = await accountRequest('POST', '/editor/session', {
    deviceId: 'install-device', deviceName: 'Install fixture', requestId: 'install-editor' });
  assert.equal(editor.status, 200, `editor:${editor.status}`);
  const create = await request(6441, 'POST', '/hosted/shared/account/create',
    { name: 'Installed real account project', requestId: 'install-create', allowLinkJoin: true,
      initialProject: { tracks: [] } }, { authorization: `Bearer ${editor.body.accessToken}` });
  assert.equal(create.status, 201, `create:${create.status}`);
  const beforeAsset = await request(6441, 'POST', '/hosted/shared/account/session',
    { projectId: create.body.projectId, deviceId: 'install-device', requestId: 'install-before-asset' },
    { authorization: `Bearer ${editor.body.accessToken}` });
  assert.equal(beforeAsset.status, 503);
  asset = child(options.nodePath, path.join(options.pcSourceDir, 'server/hosted/asset-main.mjs'), options.pcSourceDir,
    configEnv(plan.files[plan.units.asset.envFile]));
  await waitFor(async () => (await request(6442, 'GET', '/healthz')).status === 200, 'actual-asset');
  let session;
  await waitFor(async () => {
    session = await request(6441, 'POST', '/hosted/shared/account/session',
      { projectId: create.body.projectId, deviceId: 'install-device', requestId: 'install-after-asset' },
      { authorization: `Bearer ${editor.body.accessToken}` });
    return session.status === 200;
  }, 'actual-asset-head');
  const projects = await accountRequest('GET', '/projects');
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.body.owned.map(item => item.projectId), [create.body.projectId]);
  assert.equal(typeof session.body.connectionTicket, 'string');
  t.diagnostic(`real three-service path: account/doc/asset PIDs ${account.processHandle.pid}/${doc.processHandle.pid}/${asset.processHandle.pid}; create201/status503/ready200/projects200`);
});

function configEnv(contents) {
  return Object.fromEntries(contents.trim().split('\n').map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), JSON.parse(line.slice(index + 1))];
  }));
}
