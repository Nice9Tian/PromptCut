/**
 * 托管组合的入口（SP，契约 `docs/plan/shared-project-contract.md` 第 1 节）：一个 Node 进程，两个端口——
 * 文档服务与素材服务。阿里云上由 PM2 以 fork 模式跑它（app `promptcut-hosted`，演练实例 `promptcut-drill`），
 * 部署见 `scripts/remote/docservice.mjs deploy-hosted`。组装在 `combo.mjs`。
 *
 * 跑：PROMPTCUT_DATA_DIR=<数据目录> node server/hosted/main.mjs
 *
 * 环境变量：
 *   PROMPTCUT_DATA_DIR               全部持久数据的根目录，必须已经存在且可写（拷走整个目录即可迁移，`hosting-migration.md`）：
 *                                      docservice/  文档服务（`local` 空间、tenants/<projectId>/、凭证存储 auth/）
 *                                      assets/      media/、snap/、px/，按哈希前两位分子目录；布局标记 assets/.layout
 *                                      secrets/     cluster-token（0600），目录 0700
 *   PROMPTCUT_DOCSERVICE_PORT        文档服务端口，缺省 8787
 *   PROMPTCUT_ASSET_PORT             素材服务端口，缺省 8788
 *   PROMPTCUT_DOCSERVICE_HOST        两个端口都绑它，缺省 0.0.0.0
 *   PROMPTCUT_DOCSERVICE_PUBLIC_URL  形如 ws://<公网地址>:8787 或 wss://<域名>/hosted/：记录与诊断；它的源也是邀请链接的源（C10a）
 *   PROMPTCUT_ASSET_PUBLIC_URL       形如 http://<公网地址>:8788/api/asset，登记给成员（经 service.endpoints 下发）。
 *                                    绑非回环地址时必须设；只绑回环时缺省 http://127.0.0.1:<端口>/api/asset
 *   PROMPTCUT_CLUSTER_TOKEN          集群令牌的回落来源：优先读 $PROMPTCUT_DATA_DIR/secrets/cluster-token。
 *                                    令牌只守管理接口（地址登记、迁移盘点），不给数据面任何权限
 *   PROMPTCUT_DEVICE_ID / PROMPTCUT_DEVICE_NAME  本机设备信息（本机声明用）
 *   PROMPTCUT_TRUST_LOOPBACK         本机信任（`docs/plan/http-transport-contract.md` 第 10 节）：1（缺省）回环来源算本机；
 *                                    0 不算——文档服务握手、共享端点、素材服务、管理接口都按远端对待回环来的请求，也不豁免限速。
 *                                    部署在反向代理之后时必须是 0（代理转进来的请求看上去都是回环）；deploy-hosted 写 0。
 *                                    0 时必须有集群令牌（地址登记只能带令牌）
 *   PROMPTCUT_AGENT_PUBLIC_URL       云端 Agent 服务对页面的公网地址，形如 https://<域名>/agent/v1（`docs/plan/cloud-agent-contract.md` 第 10.4 节）。
 *                                    设了、且服务登记表里有 agent 服务时，经成员列表顶层的 hosted.agent.url 下发给页面；不设就不下发
 *
 * 失败即关（打一行 `config.error { reason }`，同时写 stdout 与 stderr，退出码 1）：
 *   data-dir           数据目录没设、不存在、不是目录或不可写
 *   layout             assets/.layout 与分目录布局对不上，或 assets/ 里有东西却没有标记
 *   bad-token-format   令牌（文件或环境变量）不是 32～256 个 base64url 字符
 *   auth-store         绑非回环地址而凭证存储打不开（auth-contract 第 10 节）
 *   asset-public-url   绑非回环地址而没设 PROMPTCUT_ASSET_PUBLIC_URL，或它不是 http(s) 地址
 *   agent-public-url   PROMPTCUT_AGENT_PUBLIC_URL 设了却不是 http(s) 地址
 *   listen             端口被占等，监听失败
 *   trust-loopback     PROMPTCUT_TRUST_LOOPBACK 不是 0 或 1
 *   cluster-token-required  PROMPTCUT_TRUST_LOOPBACK=0 而没有集群令牌
 * 没有令牌照常启动：管理接口只认本机回环，带令牌的握手 401。
 *
 * 只依赖 Node 内置模块与仓库里的这些目录 / 文件（部署清单见契约第 10 节）：
 * server/hosted/、server/docservice/、server/auth/、server/asset-store/、server/render-queue/、server/render-node/session-link.mjs、server/render-node/ws-transport.mjs、
 * server/asset-announce.mjs、server/asset-service.ts、server/vite-plugin-media.ts、server/http-guard.mjs。
 * `.ts` 靠 Node 的类型剥离直接载入（Node ≥ 22.18 / 24），不转译。
 */
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { checkTokenFormat } from '../docservice/auth.mjs';
import { localDeviceInfo } from '../auth/device.mjs';
import { startHostedCombo, readClusterToken, checkDataDir, HostedConfigError } from './combo.mjs';

function log(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/** 配置错误：同一行写到 stdout 与 stderr，然后以退出码 1 结束 */
function configError(reason, extra = {}) {
  const line = `${JSON.stringify({ t: new Date().toISOString(), event: 'config.error', reason, ...extra })}\n`;
  process.stdout.write(line);
  process.stderr.write(line);
  process.exitCode = 1;
}

function portOf(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : NaN;
}

const pinOf = value => String(value ?? '').replaceAll(':', '').toLowerCase();
const pinValid = value => /^[a-f0-9]{64}$/.test(value);
function accountServiceRegistry(services, { accountPin, assetPin, agentKid }) {
  const expected = agentKid ? ['account', 'asset', 'agent'] : ['account', 'asset'];
  if (!Array.isArray(services) || services.length !== expected.length) throw Error('services');
  const rolePins = new Map(), pins = new Set();
  for (const entry of services) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'serviceId') || !Object.hasOwn(entry, 'fingerprint256') ||
        !expected.includes(entry.serviceId)) throw Error('services');
    const pin = pinOf(entry.fingerprint256);
    if (!pinValid(pin) || rolePins.has(entry.serviceId) || pins.has(pin)) throw Error('services');
    rolePins.set(entry.serviceId, pin); pins.add(pin);
  }
  if (expected.some(role => !rolePins.has(role)) || rolePins.get('account') !== accountPin ||
      rolePins.get('asset') !== assetPin || !pinValid(accountPin) || !pinValid(assetPin)) throw Error('services');
  return [...rolePins].map(([serviceId, fingerprint256]) => ({ serviceId, fingerprint256 }));
}

async function main() {
  const env = process.env;
  const host = env.PROMPTCUT_DOCSERVICE_HOST || '0.0.0.0';
  const loopbackBind = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const docPort = portOf('PROMPTCUT_DOCSERVICE_PORT', 8787);
  const assetPort = portOf('PROMPTCUT_ASSET_PORT', 8788);
  if (Number.isNaN(docPort) || Number.isNaN(assetPort)) return configError('bad-port');

  let dataDir;
  try {
    dataDir = checkDataDir(env.PROMPTCUT_DATA_DIR);
  } catch (err) {
    if (err instanceof HostedConfigError) return configError(err.reason, err.extra);
    throw err;
  }

  let tokenInfo;
  try {
    tokenInfo = readClusterToken(dataDir, env);
  } catch (err) {
    // 文件在却读不了：按数据目录不可用处理；错误里只有系统错误码，没有令牌
    return configError('data-dir', { detail: `secrets:${String(err?.code ?? 'read')}` });
  }
  const token = tokenInfo.token;
  if (token !== undefined && !checkTokenFormat(token)) return configError('bad-token-format', { source: tokenInfo.source });
  if (tokenInfo.loose) log('secrets.mode', { warning: 'secrets/cluster-token 的权限比 0600 宽，建议 chmod 600' });

  const rawTrust = env.PROMPTCUT_TRUST_LOOPBACK;
  if (rawTrust !== undefined && rawTrust !== '' && rawTrust !== '0' && rawTrust !== '1') return configError('trust-loopback');
  const trustLoopback = rawTrust !== '0';
  if (!trustLoopback && token === undefined) return configError('cluster-token-required');

  const assetPublicUrl = env.PROMPTCUT_ASSET_PUBLIC_URL || undefined;
  if (assetPublicUrl !== undefined) {
    let ok = false;
    try { ok = /^https?:$/.test(new URL(assetPublicUrl).protocol); } catch { ok = false; }
    if (!ok) return configError('asset-public-url', { detail: 'not-http' });
  } else if (!loopbackBind) {
    return configError('asset-public-url', { detail: 'unset' });
  }

  const agentPublicUrl = env.PROMPTCUT_AGENT_PUBLIC_URL || undefined;
  if (agentPublicUrl !== undefined) {
    let ok = false;
    try { ok = /^https?:$/.test(new URL(agentPublicUrl).protocol); } catch { ok = false; }
    if (!ok) return configError('agent-public-url', { detail: 'not-http' });
  }

  let account = null;
  if (env.PROMPTCUT_ACCOUNT_V2_REQUIRED !== undefined && env.PROMPTCUT_ACCOUNT_V2_REQUIRED !== '0' && env.PROMPTCUT_ACCOUNT_V2_REQUIRED !== '1') return configError('account-v2-required');
  const accountRequired = env.PROMPTCUT_ACCOUNT_V2_REQUIRED === '1';
  if (accountRequired && env.PROMPTCUT_ACCOUNT_V2 !== '1') return configError('account-v2-required');
  if (env.PROMPTCUT_ACCOUNT_V2 !== undefined && env.PROMPTCUT_ACCOUNT_V2 !== '0' && env.PROMPTCUT_ACCOUNT_V2 !== '1') return configError('account-v2');
  if (env.PROMPTCUT_ACCOUNT_V2 === '1') {
    try {
      const file = name => {
        const filename = env[name];
        if (!filename || !path.isAbsolute(filename)) throw new Error('missing-file');
        return fs.readFileSync(filename);
      };
      const internalPort = portOf('PROMPTCUT_ACCOUNT_INTERNAL_PORT', NaN);
      if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535) throw new Error('internal-port');
      const services = JSON.parse(file('PROMPTCUT_ACCOUNT_INTERNAL_SERVICES_FILE').toString('utf8'));
      account = {
        origin: env.PROMPTCUT_ACCOUNT_ORIGIN,
        authorityId: env.PROMPTCUT_ACCOUNT_AUTHORITY_ID,
        authorityUrl: env.PROMPTCUT_ACCOUNT_AUTHORITY_URL,
        serverFingerprint256: env.PROMPTCUT_ACCOUNT_SERVER_FINGERPRINT256,
        keyId: env.PROMPTCUT_ACCOUNT_SIGNING_KEY_ID,
        signingKey: file('PROMPTCUT_ACCOUNT_SIGNING_KEY_FILE'),
        clientTls: { key: file('PROMPTCUT_ACCOUNT_CLIENT_KEY_FILE'), cert: file('PROMPTCUT_ACCOUNT_CLIENT_CERT_FILE'), ca: file('PROMPTCUT_ACCOUNT_CA_FILE') },
        internalTls: { key: file('PROMPTCUT_ACCOUNT_INTERNAL_KEY_FILE'), cert: file('PROMPTCUT_ACCOUNT_INTERNAL_CERT_FILE'), ca: file('PROMPTCUT_ACCOUNT_CA_FILE') },
        services, internalPort,
        order: {
          witnessKeys: JSON.parse(file('PROMPTCUT_ACCOUNT_ORDER_WITNESS_KEYS_FILE').toString('utf8')),
          issuer: env.PROMPTCUT_ACCOUNT_ORDER_ISSUER || 'visuhive-account',
          docAttestationPrivateKey: file('PROMPTCUT_DOC_ORDER_ATTESTATION_KEY_FILE'),
        },
      };
      if (!account.authorityId || !account.authorityUrl || !account.keyId) throw new Error('authority');
    } catch { return configError('account-v2'); }
  }

  let combo;
  // 独立v2素材status连接：这里仅doc client钥匙；asset进程另读自己的配置。
  let assetStatus = null;
  if (env.PROMPTCUT_ASSET_STATUS_ORIGIN) {
    try {
      if (!account || !assetPublicUrl) throw new Error('asset-status');
      const file = name => { const filename = env[name]; if (!filename || !path.isAbsolute(filename)) throw new Error('asset-status'); return fs.readFileSync(filename); };
      assetStatus = { origin: env.PROMPTCUT_ASSET_STATUS_ORIGIN, serverFingerprint256: env.PROMPTCUT_ASSET_STATUS_FINGERPRINT256,
        instanceId: env.PROMPTCUT_ASSET_INSTANCE_ID || undefined,
        tls: { key: file('PROMPTCUT_ASSET_STATUS_CLIENT_KEY_FILE'), cert: file('PROMPTCUT_ASSET_STATUS_CLIENT_CERT_FILE'), ca: file('PROMPTCUT_ASSET_STATUS_CA_FILE') } };
    } catch { return configError('asset-status'); }
  }
  if (account) {
    if (!assetStatus || env.PROMPTCUT_ASSET_INSTANCE_ID) return configError('asset-status');
    try {
      const accountPin = pinOf(account.serverFingerprint256), assetPin = pinOf(assetStatus.serverFingerprint256);
      account.services = accountServiceRegistry(account.services, { accountPin, assetPin,
        agentKid: env.PROMPTCUT_DOC_AGENT_SERVICE_KID });
      const internalPin = pinOf(new X509Certificate(account.internalTls.cert).fingerprint256);
      if (internalPin !== pinOf(new X509Certificate(account.clientTls.cert).fingerprint256) ||
          internalPin !== pinOf(new X509Certificate(assetStatus.tls.cert).fingerprint256)) throw Error('doc-certificate');
      if (env.PROMPTCUT_DOC_AGENT_SERVICE_KID) {
        const agent = account.services.find(service => service.serviceId === 'agent');
        account.agent = { fingerprint256: agent.fingerprint256, serviceKid: env.PROMPTCUT_DOC_AGENT_SERVICE_KID };
      }
    } catch { return configError('account-v2'); }
  }
  let runAssets = null;
  if (env.PROMPTCUT_DOC_RUN_ASSETS_ENABLED !== undefined && !['0', '1'].includes(env.PROMPTCUT_DOC_RUN_ASSETS_ENABLED))
    return configError('run-assets');
  if (env.PROMPTCUT_DOC_RUN_ASSETS_ENABLED === '1') {
    try {
      if (process.platform !== 'linux' || !account?.agent || !assetStatus) throw Error('run-assets');
      const dir = env.PROMPTCUT_DOC_RUN_ASSET_REGISTRY_DIR;
      const uid = Number(env.PROMPTCUT_DOC_RUN_ASSET_UID);
      const ticketTtlMs = Number(env.PROMPTCUT_DOC_RUN_ASSET_TICKET_TTL_MS);
      const maxBodyBytes = Number(env.PROMPTCUT_DOC_RUN_ASSET_MAX_BODY_BYTES);
      if (!path.isAbsolute(dir ?? '') || !Number.isSafeInteger(uid) || uid < 1 ||
          !Number.isSafeInteger(ticketTtlMs) || ticketTtlMs < 1 ||
          !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 ||
          !env.PROMPTCUT_DOC_RUN_ASSET_UNIT || !env.PROMPTCUT_DOC_RUN_ASSET_CGROUP_PATH ||
          !env.PROMPTCUT_DOC_RUN_ASSET_SERVICE_IDENTITY) throw Error('run-assets');
      const assetPin = account.services.find(service => service.serviceId === 'asset')?.fingerprint256;
      runAssets = { ticketTtlMs, maxBodyBytes, rootRegistry: {
        files: { registryFile: path.join(dir, 'current.json'), anchorFile: path.join(dir, 'anchor.json'),
          reservationFile: path.join(dir, 'reservation.json'), publisherLockFile: path.join(dir, '.publisher.lock') },
        expected: { authorityId: account.authorityId, serviceIdentity: env.PROMPTCUT_DOC_RUN_ASSET_SERVICE_IDENTITY,
          uid, unit: env.PROMPTCUT_DOC_RUN_ASSET_UNIT,
          cgroupPath: env.PROMPTCUT_DOC_RUN_ASSET_CGROUP_PATH,
          clientFingerprint256: assetPin,
          serverFingerprint256: pinOf(assetStatus.serverFingerprint256) } } };
    } catch { return configError('run-assets'); }
  }
  try {
    combo = await startHostedCombo({
      dataDir,
      docPort,
      assetPort,
      host,
      clusterToken: token,
      assetPublicUrl,
      docPublicUrl: env.PROMPTCUT_DOCSERVICE_PUBLIC_URL || undefined,
      agentPublicUrl,
      account,
      accountRequired,
      assetStatus,
      runAssets,
      trustLoopback,
      localDevice: localDeviceInfo(),
      log,
    });
  } catch (err) {
    if (err instanceof HostedConfigError) return configError(err.reason, err.extra);
    if (err?.code === 'EADDRINUSE' || err?.code === 'EACCES' || err?.code === 'EADDRNOTAVAIL') {
      return configError('listen', { code: err.code, port: err.port ?? null });
    }
    throw err;
  }

  log('listen', {
    role: 'hosted', host, node: process.version, dataDir,
    docservice: { port: combo.docPort, publicUrl: env.PROMPTCUT_DOCSERVICE_PUBLIC_URL || null },
    asset: { port: combo.assetPort, publicUrl: combo.assetPublicUrl, announced: combo.announced },
    admin: token === undefined ? 'loopback-only' : `token:${tokenInfo.source}`,
    authStore: combo.credentialStore ? 'ok' : 'unavailable',
    loopbackTrust: trustLoopback,
    agent: { publicUrl: agentPublicUrl ?? null },
    account: { mode: account ? 'v2' : 'legacy', required: accountRequired, assetReady: combo.accountRuntime?.sessionReady === true,
      internalPort: combo.accountInternalPort },
  });

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      log('stop', { signal: sig });
      combo.close().then(() => process.exit(0), () => process.exit(0));
      // PM2 的 kill_timeout 是 5 s，这里 3 s 内一定退
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

await main();
