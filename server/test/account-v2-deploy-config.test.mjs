import assert from 'node:assert/strict';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { loadAccountV2DeployConfig } from '../hosted/deploy/account-v2-config.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-account-v2-deploy-'));
  t.after(() => {
    const base = path.resolve(os.tmpdir()) + path.sep;
    if (!path.resolve(dir).startsWith(base)) throw new Error('fixture-outside-temp');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pki = assetWiringPki(dir);
  const write = (name, bytes, mode = 0o600) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes, { mode });
    return file;
  };
  const ed25519 = name => {
    const pair = generateKeyPairSync('ed25519');
    return {
      privateFile: write(`${name}.pem`, pair.privateKey.export({ format: 'pem', type: 'pkcs8' })),
      publicFile: write(`${name}.pub.pem`, pair.publicKey.export({ format: 'pem', type: 'spki' }), 0o644),
    };
  };
  const caFile = path.join(dir, 'ca.crt');
  const role = name => ({ keyFile: path.join(dir, `${name}.key`), certFile: path.join(dir, `${name}.crt`),
    caFile, fingerprint256: pki[name].fingerprint256 });
  const additionalRole = (name, san = '127.0.0.1', isCa = false) => {
    const openssl = process.env.OPENSSL ?? (process.platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl');
    const run = args => {
      const result = spawnSync(openssl, args, { cwd: dir, windowsHide: true, stdio: 'ignore', timeout: 30000 });
      if (result.status !== 0) throw new Error('temporary-pki-generation-failed');
    };
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`,
      '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    const extensionFile = san === '127.0.0.1' && !isCa ? 'extensions.txt' : `${name}-extensions.txt`;
    if (extensionFile !== 'extensions.txt') fs.writeFileSync(path.join(dir, extensionFile),
      `subjectAltName=DNS:localhost,IP:${san}\nextendedKeyUsage=serverAuth,clientAuth\n${isCa ? 'basicConstraints=critical,CA:TRUE\n' : ''}`);
    run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-days', '1', '-extfile', extensionFile, '-out', `${name}.crt`]);
    return { keyFile: path.join(dir, `${name}.key`), certFile: path.join(dir, `${name}.crt`), caFile,
      fingerprint256: new X509Certificate(fs.readFileSync(path.join(dir, `${name}.crt`))).fingerprint256 };
  };
  const manifest = {
    v: 1, authorityId: 'doc-v2-prod-1', enabledServices: ['account', 'doc', 'asset'],
    roles: { account: role('account'), doc: role('doc'), asset: role('asset') },
    internalOrigins: { account: 'https://127.0.0.1:8792/', doc: 'https://127.0.0.1:8793/', asset: 'https://127.0.0.1:8794/' },
    publicUrls: { accountOrigin: 'https://example.test/', docPublicUrl: 'wss://example.test/hosted/',
      assetPublicUrl: 'https://example.test/media/api/asset', authorityUrl: 'https://example.test/editor' },
    ports: { account: 8790, doc: 8787, asset: 8788 },
    paths: { accountRegistryFile: path.join(dir, 'account-registry.json'), docRegistryFile: path.join(dir, 'doc-registry.json'),
      orderWitnessKeysFile: path.join(dir, 'witness-keys.json'),
      accountCredentialKeyFile: write('credentials.key', Buffer.alloc(32, 7)),
      accountDataDir: path.join(dir, 'account-data'), docDataDir: path.join(dir, 'doc-data'),
      assetDataDir: path.join(dir, 'asset-data'),
      assetRecoveryFenceFile: path.join(dir, 'recovery-fence.json'),
      accountOrderModuleFile: fileURLToPath(new URL('../account/password-order.mjs', import.meta.url)) },
    keys: { docSigning: { keyId: 'doc-signing-1', privateFile: ed25519('doc-signing').privateFile },
      accountOrder: { keyId: 'order-1', ...ed25519('account-order') }, docAttestation: ed25519('doc-attestation') },
    assetServiceIdentity: 'promptcut-asset-v2',
  };
  const manifestFile = path.join(dir, 'manifest.json');
  const load = () => { fs.writeFileSync(manifestFile, JSON.stringify(manifest)); return loadAccountV2DeployConfig(manifestFile); };
  return { dir, manifest, load, role, additionalRole, pki };
}

test('v2 deploy config emits path-only runtime env and registries for actual three roles', t => {
  const { manifest, load } = fixture(t);
  const result = load();
  assert.equal(result.docEnv.PROMPTCUT_ACCOUNT_V2_REQUIRED, '1');
  assert.equal(result.docEnv.PROMPTCUT_ASSET_STATUS_ORIGIN, manifest.internalOrigins.asset.slice(0, -1));
  assert.equal(result.assetEnv.PROMPTCUT_ASSET_DOC_FINGERPRINT256.toLowerCase().replaceAll(':', ''),
    result.publicConfig.servicePins.doc);
  assert.equal(result.accountEnv.ACCOUNT_CREDENTIAL_KEY_FILE, manifest.paths.accountCredentialKeyFile);
  assert.equal(result.accountEnv.ACCOUNT_DATA_DIR, manifest.paths.accountDataDir);
  assert.equal(result.accountEnv.ACCOUNT_ORIGINS, 'https://example.test');
  assert.equal(result.accountEnv.ACCOUNT_DOC_SERVER_FINGERPRINT256, result.publicConfig.servicePins.doc);
  assert.deepEqual(JSON.parse(result.generatedFiles[manifest.paths.accountRegistryFile]),
    [{ serviceId: 'doc', fingerprint256: result.publicConfig.servicePins.doc }]);
  assert.deepEqual(JSON.parse(result.generatedFiles[manifest.paths.docRegistryFile]).map(item => item.serviceId), ['account', 'asset']);
  assert.deepEqual(result.publicConfig.enabledServices, ['account', 'doc', 'asset']);
  assert.equal('PROMPTCUT_ASSET_INSTANCE_ID' in result.docEnv, false);
  assert.equal('ready' in result.publicConfig, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /BEGIN (?:PRIVATE|RSA PRIVATE) KEY/);
  assert.doesNotMatch(serialized, /credentials\.key.*\\u0007/);
});

test('v2 deploy config rejects missing roles, repeated identities, wrong pins and private keys', t => {
  const { manifest, load, role } = fixture(t);
  const reject = code => assert.throws(load, error => error.code === code);
  const originalAsset = structuredClone(manifest.roles.asset);
  delete manifest.roles.asset; reject('role-configuration');
  manifest.roles.asset = structuredClone(originalAsset);
  manifest.roles.asset = role('doc'); reject('role-identity');
  manifest.roles.asset = structuredClone(originalAsset);
  manifest.roles.asset.fingerprint256 = manifest.roles.doc.fingerprint256; reject('role-pin');
  manifest.roles.asset = structuredClone(originalAsset);
  manifest.roles.asset.keyFile = manifest.roles.doc.keyFile; reject('role-certificate');
  manifest.roles.asset = structuredClone(originalAsset);
  manifest.enabledServices.push('agent'); reject('role-configuration');
  manifest.enabledServices.pop();
  manifest.enabledServices.push('doc'); reject('enabled-services');
});

test('v2 deploy config registers an optional service only when its distinct identity is enabled', t => {
  const { manifest, load, additionalRole } = fixture(t);
  manifest.enabledServices.push('agent');
  manifest.roles.agent = additionalRole('agent');
  const result = load();
  assert.deepEqual(JSON.parse(result.generatedFiles[manifest.paths.docRegistryFile]).map(item => item.serviceId),
    ['account', 'asset', 'agent']);
  assert.deepEqual(result.publicConfig.enabledServices, ['account', 'doc', 'asset', 'agent']);
  assert.equal(JSON.stringify(result).includes('render'), false);
});

test('v2 deploy config rejects non-loopback or colliding internal ports and incomplete asset status', t => {
  const { manifest, load } = fixture(t);
  const reject = code => assert.throws(load, error => error.code === code);
  manifest.internalOrigins.asset = 'https://example.test:8794/'; reject('internal-origin');
  manifest.internalOrigins.asset = manifest.internalOrigins.doc; reject('port-conflict');
  manifest.internalOrigins.asset = 'https://127.0.0.1:8794/';
  delete manifest.roles.asset.caFile; reject('role-configuration');
  manifest.roles.asset.caFile = manifest.roles.doc.caFile;
  delete manifest.internalOrigins.asset; reject('internal-origins');
});

test('v2 deploy config preserves and validates account order and credential references', t => {
  const { manifest, load, dir } = fixture(t);
  const reject = code => assert.throws(load, error => error.code === code);
  const oldCredential = manifest.paths.accountCredentialKeyFile;
  manifest.paths.accountCredentialKeyFile = path.join(dir, 'missing-credentials.key'); reject('account-credential-key');
  manifest.paths.accountCredentialKeyFile = oldCredential;
  const shortCredential = path.join(dir, 'short-credentials.key');
  fs.writeFileSync(shortCredential, Buffer.alloc(16), { mode: 0o600 });
  manifest.paths.accountCredentialKeyFile = shortCredential; reject('account-credential-key');
  manifest.paths.accountCredentialKeyFile = oldCredential;
  const oldPublic = manifest.keys.accountOrder.publicFile;
  manifest.keys.accountOrder.publicFile = manifest.keys.docAttestation.publicFile; reject('account-order-key');
  manifest.keys.accountOrder.publicFile = oldPublic;
  const oldAssetOrigin = manifest.internalOrigins.asset;
  manifest.internalOrigins.asset = 'https://127.0.0.1:8792/'; reject('port-conflict');
  manifest.internalOrigins.asset = oldAssetOrigin;
  const oldRegistry = manifest.paths.docRegistryFile;
  manifest.paths.docRegistryFile = manifest.paths.accountCredentialKeyFile; reject('path-conflict');
  manifest.paths.docRegistryFile = oldRegistry;
  assert.equal(load().accountEnv.ACCOUNT_ORDER_SIGNING_KEY_FILE, manifest.keys.accountOrder.privateFile);
});

test('v2 deploy config requires every nested deployment field, including unused destination paths', t => {
  const { manifest, load } = fixture(t);
  delete manifest.paths.assetRecoveryFenceFile;
  assert.throws(load, error => error.code === 'paths');
});

test('v2 deploy config rejects a correctly signed asset leaf with a prefix-only loopback SAN', t => {
  const { manifest, load, additionalRole } = fixture(t);
  manifest.roles.asset = additionalRole('asset', '127.0.0.10');
  assert.throws(load, error => error.code === 'role-identity');
});

test('v2 deploy config rejects a CA certificate used as a service leaf', t => {
  const { manifest, load, additionalRole } = fixture(t);
  manifest.roles.asset = additionalRole('asset', '127.0.0.1', true);
  assert.throws(load, error => error.code === 'role-certificate');
});

test('v2 deploy config rejects a reused Ed25519 key saved under different paths', t => {
  const { dir, manifest, load } = fixture(t);
  const duplicatePrivate = path.join(dir, 'duplicate-order.pem');
  const duplicatePublic = path.join(dir, 'duplicate-order.pub.pem');
  fs.copyFileSync(manifest.keys.docAttestation.privateFile, duplicatePrivate);
  fs.copyFileSync(manifest.keys.docAttestation.publicFile, duplicatePublic);
  manifest.keys.accountOrder.privateFile = duplicatePrivate;
  manifest.keys.accountOrder.publicFile = duplicatePublic;
  assert.throws(load, error => error.code === 'duplicate-signing-key');
});
