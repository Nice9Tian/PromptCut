import fs from 'node:fs';
import path from 'node:path';
import { loadAccountV2DeployConfig } from './account-v2-config.mjs';

const ROLES = ['account', 'doc', 'asset'];
const UNIT_NAMES = { account: 'promptcut-account-v2', doc: 'promptcut-doc-v2', asset: 'promptcut-asset-v2' };
const ENTRY = { account: ['account', 'server.mjs'], doc: ['server', 'hosted', 'main.mjs'],
  asset: ['server', 'hosted', 'asset-main.mjs'] };
const sameOrWithin = (value, root) => value === root || value.startsWith(`${root}${path.sep}`);

function invalid(code) { const error = new Error(code); error.code = code; throw error; }
function absolute(value, code) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || path.normalize(value) !== value ||
      /[\r\n\0]/.test(value)) invalid(code);
  return value;
}
function regular(value, code) {
  const filename = absolute(value, code);
  let stat;
  try { stat = fs.lstatSync(filename); } catch { invalid(code); }
  if (!stat.isFile() || stat.isSymbolicLink()) invalid(code);
  return { filename, stat };
}
function directory(value, code) {
  const filename = absolute(value, code);
  let stat;
  try { stat = fs.statSync(filename); } catch { invalid(code); }
  if (!stat.isDirectory()) invalid(code);
  return filename;
}
function environmentFile(values) {
  return Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) invalid('environment-value');
    return `${key}=${JSON.stringify(value)}`;
  }).join('\n') + '\n';
}
const unitPath = value => `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
// systemd 249 parses WorkingDirectory and EnvironmentFile as single rvalues,
// without ExecStart's word extraction or C unescaping. Keep literal spaces and
// backslashes; only % specifiers are escaped. Ambiguous suffix/quotes fail.
export function formatUnitSinglePath(value) {
  absolute(value, 'unit-single-path');
  if (/[ \t]$/.test(value) || /["'\t]/.test(value)) invalid('unit-single-path');
  return value.replaceAll('%', '%%');
}
function unit(role, { user, nodePath, sourceDir, entry, envFile, dataDir, privateFiles, forbiddenFiles }) {
  return `[Unit]\nDescription=PromptCut account v2 ${role}\nWants=network-online.target\nAfter=network-online.target\n\n` +
    `[Service]\nType=simple\nUser=${user}\nGroup=${user}\nWorkingDirectory=${formatUnitSinglePath(sourceDir)}\n` +
    `EnvironmentFile=${formatUnitSinglePath(envFile)}\nExecStart=${unitPath(nodePath)} ${unitPath(entry)}\nRestart=on-failure\nRestartSec=3s\n` +
    `NoNewPrivileges=true\nProtectSystem=strict\nPrivateTmp=true\n` +
    `ReadWritePaths=${unitPath(dataDir)}\nReadOnlyPaths=${[sourceDir, ...privateFiles].map(unitPath).join(' ')}\n` +
    `InaccessiblePaths=${forbiddenFiles.map(unitPath).join(' ')}\n` +
    `\n[Install]\nWantedBy=multi-user.target\n`;
}

/**
 * Generate an installable, reviewable plan without writing to the host. The
 * root installer must atomically place files with the declared ownership,
 * verify a recoverable backup, and explicitly start the three units later.
 * There are no service ordering dependencies: asset can wait on the actual
 * doc cursor and doc restarts until the account authority is available.
 */
export function createAccountV2InstallPlan({ manifestFile, installDir, nodePath, pcSourceDir, vhSourceDir, users }) {
  const config = loadAccountV2DeployConfig(manifestFile);
  if (config.publicConfig.enabledServices.join(',') !== ROLES.join(',')) invalid('optional-service-uninstalled');
  const install = absolute(installDir, 'install-directory');
  const node = regular(nodePath, 'node-binary');
  if (process.platform !== 'win32' && !(node.stat.mode & 0o111)) invalid('node-binary');
  const pcSource = directory(pcSourceDir, 'pc-source');
  const vhSource = directory(vhSourceDir, 'vh-source');
  const source = { account: vhSource, doc: pcSource, asset: pcSource };
  const entries = Object.fromEntries(ROLES.map(role => [role,
    regular(path.join(source[role], ...ENTRY[role]), 'service-entry').filename]));
  if (!users || typeof users !== 'object' || Array.isArray(users) ||
      Object.keys(users).length !== 3 || ROLES.some(role => !Object.hasOwn(users, role) ||
        typeof users[role] !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(users[role]) || users[role] === 'root') ||
      new Set(ROLES.map(role => users[role])).size !== 3) invalid('service-users');

  const { accountEnv, docEnv, assetEnv, generatedFiles, publicConfig } = config;
  const tokenFile = path.join(docEnv.PROMPTCUT_DATA_DIR, 'secrets', 'cluster-token');
  const token = regular(tokenFile, 'existing-cluster-token');
  if (process.platform !== 'win32' && (token.stat.mode & 0o077)) invalid('cluster-token-permissions');
  if (new Set(ROLES.map(role => source[role])).size !== 2) invalid('source-layout');
  const dataDirs = { account: accountEnv.ACCOUNT_DATA_DIR, doc: docEnv.PROMPTCUT_DATA_DIR,
    asset: assetEnv.PROMPTCUT_ASSET_DATA_DIR };
  for (const role of ROLES) directory(dataDirs[role], 'service-data-directory');
  for (const role of ROLES) {
    if (sameOrWithin(install, dataDirs[role]) || sameOrWithin(dataDirs[role], install) ||
        sameOrWithin(source[role], dataDirs[role]) || sameOrWithin(dataDirs[role], source[role]))
      invalid('data-boundary');
    for (const other of ROLES.filter(value => value !== role)) {
      if (sameOrWithin(dataDirs[role], dataDirs[other])) invalid('data-boundary');
    }
  }

  const privateFiles = {
    account: [accountEnv.ACCOUNT_INTERNAL_KEY_FILE, accountEnv.ACCOUNT_ORDER_SIGNING_KEY_FILE,
      accountEnv.ACCOUNT_CREDENTIAL_KEY_FILE],
    doc: [docEnv.PROMPTCUT_ACCOUNT_INTERNAL_KEY_FILE, docEnv.PROMPTCUT_ACCOUNT_SIGNING_KEY_FILE,
      docEnv.PROMPTCUT_DOC_ORDER_ATTESTATION_KEY_FILE, tokenFile],
    asset: [assetEnv.PROMPTCUT_ASSET_INTERNAL_KEY_FILE],
  };
  const allPrivate = ROLES.flatMap(role => privateFiles[role]);
  if (new Set(allPrivate).size !== allPrivate.length) invalid('private-file-sharing');
  // Keys may live in several owner directories (the old credential key and
  // cluster token are persistent), but no role may share or traverse another
  // role's private-file directory.
  const privateRoots = Object.fromEntries(ROLES.map(role => [role,
    [...new Set(privateFiles[role].map(file => path.dirname(file)))]]));
  for (const role of ROLES) for (const other of ROLES.filter(value => value !== role)) {
    if (privateRoots[role].some(root => privateRoots[other].some(peer =>
      sameOrWithin(root, peer) || sameOrWithin(peer, root))))
      invalid('private-directory-sharing');
  }
  if (ROLES.some(role => privateRoots[role].some(root => sameOrWithin(install, root) ||
      sameOrWithin(root, install)))) invalid('install-directory');

  const envs = { account: accountEnv, doc: { ...docEnv, PROMPTCUT_TRUST_LOOPBACK: '0' }, asset: assetEnv };
  const files = { ...generatedFiles };
  const units = {};
  const fileAccess = {};
  const filePolicies = {
    [accountEnv.ACCOUNT_SERVICE_REGISTRY_FILE]: { owner: 'root', group: users.account, mode: '0640' },
    [docEnv.PROMPTCUT_ACCOUNT_INTERNAL_SERVICES_FILE]: { owner: 'root', group: users.doc, mode: '0640' },
    [docEnv.PROMPTCUT_ACCOUNT_ORDER_WITNESS_KEYS_FILE]: { owner: 'root', group: users.doc, mode: '0640' },
  };
  for (const role of ROLES) {
    const envFile = path.join(install, `${UNIT_NAMES[role]}.env`);
    const unitFile = `/etc/systemd/system/${UNIT_NAMES[role]}.service`;
    const forbiddenFiles = ROLES.filter(other => other !== role).flatMap(other => privateFiles[other]);
    files[envFile] = environmentFile(envs[role]);
    files[unitFile] = unit(role, { user: users[role], nodePath: node.filename,
      sourceDir: source[role], entry: entries[role], envFile, dataDir: dataDirs[role],
      privateFiles: privateFiles[role], forbiddenFiles });
    filePolicies[envFile] = { owner: 'root', group: users[role], mode: '0640' };
    filePolicies[unitFile] = { owner: 'root', group: 'root', mode: '0644' };
    units[role] = { name: UNIT_NAMES[role], unitFile, envFile, user: users[role], entry: entries[role] };
    fileAccess[role] = { user: users[role], readPrivate: [...privateFiles[role]],
      readPublic: role === 'account' ? [accountEnv.ACCOUNT_SERVICE_REGISTRY_FILE,
        accountEnv.ACCOUNT_DOC_ATTESTATION_PUBLIC_KEY_FILE, accountEnv.ACCOUNT_INTERNAL_CERT_FILE,
        accountEnv.ACCOUNT_INTERNAL_CA_FILE] : role === 'doc'
        ? [docEnv.PROMPTCUT_ACCOUNT_INTERNAL_SERVICES_FILE, docEnv.PROMPTCUT_ACCOUNT_ORDER_WITNESS_KEYS_FILE,
          docEnv.PROMPTCUT_ACCOUNT_INTERNAL_CERT_FILE, docEnv.PROMPTCUT_ACCOUNT_CA_FILE]
        : [assetEnv.PROMPTCUT_ASSET_INTERNAL_CERT_FILE, assetEnv.PROMPTCUT_ASSET_DOC_CA_FILE],
      writeData: dataDirs[role], denyPrivate: forbiddenFiles };
  }
  if (Object.keys(files).length !== Object.keys(generatedFiles).length + 6) invalid('install-path-conflict');
  return { publicConfig, units, files, fileAccess, filePolicies,
    existingRequired: [tokenFile, accountEnv.ACCOUNT_CREDENTIAL_KEY_FILE],
    installOnly: true };
}
