import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';

const REQUIRED_ROLES = ['account', 'doc', 'asset'];
const OPTIONAL_ROLES = ['agent', 'render'];
const ROLE_ORDER = [...REQUIRED_ROLES, ...OPTIONAL_ROLES];
const HEX_256 = /^[a-f0-9]{64}$/;

function invalid(code) {
  // Configuration errors must never echo a manifest value, PEM, or path.
  const error = new Error(code);
  error.code = code;
  throw error;
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  return value;
}

function exactKeys(value, names, code) {
  object(value, code);
  if (Object.keys(value).some(key => !names.includes(key))) invalid(code);
}

function text(value, code) {
  if (typeof value !== 'string' || !value || value.trim() !== value) invalid(code);
  return value;
}

function absoluteFile(value, code, { privateFile = false } = {}) {
  const filename = text(value, code);
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) invalid(code);
  let stat;
  try { stat = fs.lstatSync(filename); } catch { invalid(code); }
  if (!stat.isFile() || stat.isSymbolicLink()) invalid(code);
  if (privateFile && process.platform !== 'win32' && (stat.mode & 0o077)) invalid('private-key-permissions');
  return filename;
}

function absoluteDestination(value, code) {
  const filename = text(value, code);
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) invalid(code);
  return filename;
}

function fingerprint(value, code) {
  const normalized = text(value, code).replaceAll(':', '').toLowerCase();
  if (!HEX_256.test(normalized)) invalid(code);
  return normalized;
}

function internalUrl(value, code) {
  let url;
  try { url = new URL(value); } catch { invalid(code); }
  if (url.protocol !== 'https:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password) invalid(code);
  return { origin: url.origin, port: Number(url.port) };
}

function publicUrl(value, protocols, code) {
  let url;
  try { url = new URL(value); } catch { invalid(code); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid(code);
  return url.toString();
}

function keyPair(privateFile, publicFile, code) {
  const secretPath = absoluteFile(privateFile, code, { privateFile: true });
  const publicPath = absoluteFile(publicFile, code);
  try {
    const secret = createPrivateKey(fs.readFileSync(secretPath));
    const publicKey = createPublicKey(fs.readFileSync(publicPath));
    if (secret.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519' ||
        !createPublicKey(secret).equals(publicKey)) invalid(code);
  } catch { invalid(code); }
  return { privateFile: secretPath, publicFile: publicPath };
}

function leafOf(serviceId, entry, caFile) {
  exactKeys(entry, ['keyFile', 'certFile', 'caFile', 'fingerprint256'], 'role-configuration');
  const keyFile = absoluteFile(entry.keyFile, 'role-key', { privateFile: true });
  const certFile = absoluteFile(entry.certFile, 'role-certificate');
  const roleCaFile = absoluteFile(entry.caFile, 'role-ca');
  if (roleCaFile !== caFile) invalid('role-ca');
  let leaf, ca;
  try {
    leaf = new X509Certificate(fs.readFileSync(certFile));
    ca = new X509Certificate(fs.readFileSync(caFile));
    if (!ca.ca || ca.subject !== ca.issuer || !ca.verify(ca.publicKey) ||
        !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey) ||
        !leaf.checkPrivateKey(createPrivateKey(fs.readFileSync(keyFile)))) invalid('role-certificate');
  } catch { invalid('role-certificate'); }
  const now = Date.now();
  if (now < Date.parse(leaf.validFrom) || now > Date.parse(leaf.validTo) ||
      now < Date.parse(ca.validFrom) || now > Date.parse(ca.validTo)) invalid('role-certificate-expired');
  // The installer issues one node-local identity per enabled service. A
  // localhost SAN is required because the same leaf serves internal HTTPS.
  if (leaf.subject !== `CN=${serviceId}` || !leaf.subjectAltName?.includes('IP Address:127.0.0.1')) invalid('role-identity');
  const actualPin = fingerprint(leaf.fingerprint256, 'role-certificate');
  if (actualPin !== fingerprint(entry.fingerprint256, 'role-pin')) invalid('role-pin');
  return { serviceId, keyFile, certFile, caFile, fingerprint256: actualPin,
    publicKey: leaf.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

/**
 * Offline preflight for a root-provisioned account-v2 manifest. This does not
 * write certificates, registries, PM2 files, or readiness state. The caller
 * must atomically install generatedFiles and enforce distinct OS owners.
 *
 * Manifest v1 fields: authorityId, enabledServices, roles, internalOrigins,
 * publicUrls, ports, paths, keys, assetServiceIdentity. `roles` has precisely
 * the enabled account/doc/asset/optional agent/render leaf identities; each
 * identity contains absolute keyFile/certFile/caFile and its expected pin.
 */
export function loadAccountV2DeployConfig(manifestFile) {
  const source = absoluteFile(manifestFile, 'manifest-file');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(source, 'utf8')); } catch { invalid('manifest-json'); }
  exactKeys(manifest, ['v', 'authorityId', 'enabledServices', 'roles', 'internalOrigins', 'publicUrls', 'ports', 'paths', 'keys', 'assetServiceIdentity'], 'manifest-shape');
  if (manifest.v !== 1) invalid('manifest-version');
  const authorityId = text(manifest.authorityId, 'authority-id');
  if (!Array.isArray(manifest.enabledServices) || new Set(manifest.enabledServices).size !== manifest.enabledServices.length ||
      REQUIRED_ROLES.some(role => !manifest.enabledServices.includes(role)) ||
      manifest.enabledServices.some(role => !ROLE_ORDER.includes(role))) invalid('enabled-services');
  const enabled = ROLE_ORDER.filter(role => manifest.enabledServices.includes(role));
  exactKeys(manifest.roles, enabled, 'role-configuration');
  if (Object.keys(manifest.roles).length !== enabled.length) invalid('role-configuration');
  const caFile = absoluteFile(manifest.roles.account?.caFile, 'role-ca');
  const roles = Object.fromEntries(enabled.map(role => [role, leafOf(role, manifest.roles[role], caFile)]));
  const pins = enabled.map(role => roles[role].fingerprint256);
  if (new Set(pins).size !== pins.length || new Set(enabled.map(role => roles[role].publicKey)).size !== enabled.length ||
      new Set(enabled.map(role => roles[role].keyFile)).size !== enabled.length) invalid('duplicate-role-identity');

  exactKeys(manifest.internalOrigins, REQUIRED_ROLES, 'internal-origins');
  const internal = Object.fromEntries(REQUIRED_ROLES.map(role => [role, internalUrl(manifest.internalOrigins[role], 'internal-origin')]));
  exactKeys(manifest.ports, REQUIRED_ROLES, 'public-ports');
  const publicPorts = REQUIRED_ROLES.map(role => manifest.ports[role]);
  if (publicPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535) ||
      new Set([...publicPorts, ...REQUIRED_ROLES.map(role => internal[role].port)]).size !== 6) invalid('port-conflict');

  exactKeys(manifest.publicUrls, ['accountOrigin', 'docPublicUrl', 'assetPublicUrl', 'authorityUrl'], 'public-urls');
  const accountOrigin = publicUrl(manifest.publicUrls.accountOrigin, ['https:'], 'public-url');
  const docPublicUrl = publicUrl(manifest.publicUrls.docPublicUrl, ['wss:'], 'public-url');
  const assetPublicUrl = publicUrl(manifest.publicUrls.assetPublicUrl, ['https:'], 'public-url');
  const authorityUrl = publicUrl(manifest.publicUrls.authorityUrl, ['https:'], 'public-url');
  if (!assetPublicUrl.endsWith('/media/api/asset') || !docPublicUrl.includes('/hosted/') ||
      !authorityUrl.endsWith('/editor')) invalid('public-url');

  exactKeys(manifest.paths, ['accountRegistryFile', 'docRegistryFile', 'orderWitnessKeysFile', 'accountCredentialKeyFile', 'accountDataDir', 'docDataDir', 'assetDataDir', 'assetRecoveryFenceFile', 'accountOrderModuleFile'], 'paths');
  const paths = Object.fromEntries(Object.entries(manifest.paths).map(([name, value]) => [name, absoluteDestination(value, 'path')]));
  absoluteFile(paths.accountOrderModuleFile, 'order-module');
  const credentialFile = absoluteFile(paths.accountCredentialKeyFile, 'account-credential-key', { privateFile: true });
  if (fs.statSync(credentialFile).size !== 32) invalid('account-credential-key');
  if (new Set([paths.accountDataDir, paths.docDataDir, paths.assetDataDir]).size !== 3 ||
      new Set([paths.accountRegistryFile, paths.docRegistryFile, paths.orderWitnessKeysFile]).size !== 3) invalid('path-conflict');

  exactKeys(manifest.keys, ['docSigning', 'accountOrder', 'docAttestation'], 'keys');
  exactKeys(manifest.keys.docSigning, ['keyId', 'privateFile'], 'doc-signing-key');
  const docSigningKeyId = text(manifest.keys.docSigning.keyId, 'doc-signing-key');
  const docSigningFile = absoluteFile(manifest.keys.docSigning.privateFile, 'doc-signing-key', { privateFile: true });
  try { if (createPrivateKey(fs.readFileSync(docSigningFile)).asymmetricKeyType !== 'ed25519') invalid('doc-signing-key'); }
  catch { invalid('doc-signing-key'); }
  exactKeys(manifest.keys.accountOrder, ['keyId', 'privateFile', 'publicFile'], 'account-order-key');
  const accountOrderKeyId = text(manifest.keys.accountOrder.keyId, 'account-order-key');
  const accountOrder = keyPair(manifest.keys.accountOrder.privateFile, manifest.keys.accountOrder.publicFile, 'account-order-key');
  exactKeys(manifest.keys.docAttestation, ['privateFile', 'publicFile'], 'doc-attestation-key');
  const docAttestation = keyPair(manifest.keys.docAttestation.privateFile, manifest.keys.docAttestation.publicFile, 'doc-attestation-key');
  const signingPaths = [docSigningFile, accountOrder.privateFile, docAttestation.privateFile];
  if (new Set(signingPaths).size !== signingPaths.length || signingPaths.some(file => enabled.some(role => roles[role].keyFile === file))) invalid('duplicate-signing-key');
  const generatedPaths = [paths.accountRegistryFile, paths.docRegistryFile, paths.orderWitnessKeysFile];
  const sourcePaths = [source, paths.accountCredentialKeyFile, paths.accountOrderModuleFile,
    docSigningFile, accountOrder.privateFile, accountOrder.publicFile,
    docAttestation.privateFile, docAttestation.publicFile,
    ...enabled.flatMap(role => [roles[role].keyFile, roles[role].certFile, roles[role].caFile])];
  if (generatedPaths.some(file => sourcePaths.includes(file))) invalid('path-conflict');
  const assetServiceIdentity = text(manifest.assetServiceIdentity, 'asset-service-identity');
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(assetServiceIdentity)) invalid('asset-service-identity');

  const accountRegistry = [{ serviceId: 'doc', fingerprint256: roles.doc.fingerprint256 }];
  const docRegistry = enabled.filter(role => role !== 'doc').map(role => ({ serviceId: role, fingerprint256: roles[role].fingerprint256 }));
  const generatedFiles = {
    [paths.accountRegistryFile]: `${JSON.stringify(accountRegistry, null, 2)}\n`,
    [paths.docRegistryFile]: `${JSON.stringify(docRegistry, null, 2)}\n`,
    [paths.orderWitnessKeysFile]: `${JSON.stringify({ [accountOrderKeyId]: fs.readFileSync(accountOrder.publicFile, 'utf8') }, null, 2)}\n`,
  };
  const accountEnv = {
    ACCOUNT_API_MODE: 'v2', ACCOUNT_HOST: '127.0.0.1', ACCOUNT_PORT: String(manifest.ports.account),
    ACCOUNT_DATA_DIR: paths.accountDataDir, ACCOUNT_ORIGINS: new URL(accountOrigin).origin,
    ACCOUNT_CREDENTIAL_KEY_FILE: paths.accountCredentialKeyFile,
    ACCOUNT_INTERNAL_PORT: String(internal.account.port),
    ACCOUNT_INTERNAL_KEY_FILE: roles.account.keyFile, ACCOUNT_INTERNAL_CERT_FILE: roles.account.certFile,
    ACCOUNT_INTERNAL_CA_FILE: caFile, ACCOUNT_SERVICE_REGISTRY_FILE: paths.accountRegistryFile,
    ACCOUNT_DOC_ORIGIN: internal.doc.origin, ACCOUNT_DOC_KEY_FILE: roles.account.keyFile,
    ACCOUNT_DOC_CERT_FILE: roles.account.certFile, ACCOUNT_DOC_CA_FILE: caFile,
    ACCOUNT_ORDER_MODULE: paths.accountOrderModuleFile, ACCOUNT_ORDER_SIGNING_KEY_FILE: accountOrder.privateFile,
    ACCOUNT_ORDER_KEY_ID: accountOrderKeyId, ACCOUNT_DOC_ATTESTATION_PUBLIC_KEY_FILE: docAttestation.publicFile,
  };
  const docEnv = {
    PROMPTCUT_ACCOUNT_V2: '1', PROMPTCUT_ACCOUNT_V2_REQUIRED: '1',
    PROMPTCUT_DATA_DIR: paths.docDataDir, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1',
    PROMPTCUT_ACCOUNT_ORIGIN: internal.account.origin, PROMPTCUT_ACCOUNT_AUTHORITY_ID: authorityId,
    PROMPTCUT_ACCOUNT_AUTHORITY_URL: authorityUrl, PROMPTCUT_ACCOUNT_SERVER_FINGERPRINT256: roles.account.fingerprint256,
    PROMPTCUT_ACCOUNT_SIGNING_KEY_ID: docSigningKeyId, PROMPTCUT_ACCOUNT_SIGNING_KEY_FILE: docSigningFile,
    PROMPTCUT_ACCOUNT_CLIENT_KEY_FILE: roles.doc.keyFile, PROMPTCUT_ACCOUNT_CLIENT_CERT_FILE: roles.doc.certFile,
    PROMPTCUT_ACCOUNT_CA_FILE: caFile, PROMPTCUT_ACCOUNT_INTERNAL_KEY_FILE: roles.doc.keyFile,
    PROMPTCUT_ACCOUNT_INTERNAL_CERT_FILE: roles.doc.certFile, PROMPTCUT_ACCOUNT_INTERNAL_PORT: String(internal.doc.port),
    PROMPTCUT_ACCOUNT_INTERNAL_SERVICES_FILE: paths.docRegistryFile,
    PROMPTCUT_ACCOUNT_ORDER_WITNESS_KEYS_FILE: paths.orderWitnessKeysFile,
    PROMPTCUT_DOC_ORDER_ATTESTATION_KEY_FILE: docAttestation.privateFile,
    PROMPTCUT_ASSET_STATUS_ORIGIN: internal.asset.origin,
    PROMPTCUT_ASSET_STATUS_FINGERPRINT256: roles.asset.fingerprint256,
    PROMPTCUT_ASSET_STATUS_CLIENT_KEY_FILE: roles.doc.keyFile,
    PROMPTCUT_ASSET_STATUS_CLIENT_CERT_FILE: roles.doc.certFile,
    PROMPTCUT_ASSET_STATUS_CA_FILE: caFile,
    PROMPTCUT_ASSET_PUBLIC_URL: assetPublicUrl, PROMPTCUT_DOCSERVICE_PUBLIC_URL: docPublicUrl,
    PROMPTCUT_DOCSERVICE_PORT: String(manifest.ports.doc),
  };
  const assetEnv = {
    PROMPTCUT_ASSET_DATA_DIR: paths.assetDataDir, PROMPTCUT_ASSET_HOST: '127.0.0.1',
    PROMPTCUT_ASSET_PORT: String(manifest.ports.asset), PROMPTCUT_ASSET_INTERNAL_PORT: String(internal.asset.port),
    PROMPTCUT_ASSET_PUBLIC_URL: assetPublicUrl, PROMPTCUT_ASSET_DOC_AUTHORITY_ID: authorityId,
    PROMPTCUT_ASSET_DOC_ORIGIN: internal.doc.origin, PROMPTCUT_ASSET_DOC_FINGERPRINT256: roles.doc.fingerprint256,
    PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256: roles.doc.fingerprint256,
    PROMPTCUT_ASSET_DOC_CA_FILE: caFile, PROMPTCUT_ASSET_CLIENT_KEY_FILE: roles.asset.keyFile,
    PROMPTCUT_ASSET_CLIENT_CERT_FILE: roles.asset.certFile, PROMPTCUT_ASSET_INTERNAL_KEY_FILE: roles.asset.keyFile,
    PROMPTCUT_ASSET_INTERNAL_CERT_FILE: roles.asset.certFile,
    PROMPTCUT_ASSET_RECOVERY_FENCE_FILE: paths.assetRecoveryFenceFile,
    PROMPTCUT_ASSET_SERVICE_IDENTITY: assetServiceIdentity,
  };
  return {
    accountEnv, docEnv, assetEnv, generatedFiles,
    publicConfig: { authorityId, enabledServices: enabled, internalOrigins: Object.fromEntries(REQUIRED_ROLES.map(role => [role, internal[role].origin])),
      publicUrls: { accountOrigin, docPublicUrl, assetPublicUrl, authorityUrl },
      ports: { ...manifest.ports, accountInternal: internal.account.port, docInternal: internal.doc.port, assetInternal: internal.asset.port },
      servicePins: Object.fromEntries(enabled.map(role => [role, roles[role].fingerprint256])),
      assetServiceIdentity },
  };
}
