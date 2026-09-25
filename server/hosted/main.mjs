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
 *   PROMPTCUT_DOCSERVICE_PUBLIC_URL  形如 ws://8.219.80.16:8787，只作记录与诊断
 *   PROMPTCUT_ASSET_PUBLIC_URL       形如 http://8.219.80.16:8788/api/asset，登记给成员（经 service.endpoints 下发）。
 *                                    绑非回环地址时必须设；只绑回环时缺省 http://127.0.0.1:<端口>/api/asset
 *   PROMPTCUT_CLUSTER_TOKEN          集群令牌的回落来源：优先读 $PROMPTCUT_DATA_DIR/secrets/cluster-token。
 *                                    令牌只守管理接口（地址登记、迁移盘点），不给数据面任何权限
 *   PROMPTCUT_DEVICE_ID / PROMPTCUT_DEVICE_NAME  本机设备信息（本机声明用）
 *   PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1  测试开关：素材服务与管理接口不再把本机回环当自己人，本机也要票据 / 令牌
 *
 * 失败即关（打一行 `config.error { reason }`，同时写 stdout 与 stderr，退出码 1）：
 *   data-dir           数据目录没设、不存在、不是目录或不可写
 *   layout             assets/.layout 与分目录布局对不上，或 assets/ 里有东西却没有标记
 *   bad-token-format   令牌（文件或环境变量）不是 32～256 个 base64url 字符
 *   auth-store         绑非回环地址而凭证存储打不开（auth-contract 第 10 节）
 *   asset-public-url   绑非回环地址而没设 PROMPTCUT_ASSET_PUBLIC_URL，或它不是 http(s) 地址
 *   listen             端口被占等，监听失败
 * 没有令牌照常启动：管理接口只认本机回环，带令牌的握手 401。
 *
 * 只依赖 Node 内置模块与仓库里的这些目录 / 文件（部署清单见契约第 10 节）：
 * server/hosted/、server/docservice/、server/auth/、server/asset-store/、server/render-queue/、server/render-node/ws-transport.mjs、
 * server/asset-announce.mjs、server/asset-service.ts、server/vite-plugin-media.ts、server/http-guard.mjs。
 * `.ts` 靠 Node 的类型剥离直接载入（Node ≥ 22.18 / 24），不转译。
 */
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

  const assetPublicUrl = env.PROMPTCUT_ASSET_PUBLIC_URL || undefined;
  if (assetPublicUrl !== undefined) {
    let ok = false;
    try { ok = /^https?:$/.test(new URL(assetPublicUrl).protocol); } catch { ok = false; }
    if (!ok) return configError('asset-public-url', { detail: 'not-http' });
  } else if (!loopbackBind) {
    return configError('asset-public-url', { detail: 'unset' });
  }

  let combo;
  try {
    combo = await startHostedCombo({
      dataDir,
      docPort,
      assetPort,
      host,
      clusterToken: token,
      assetPublicUrl,
      docPublicUrl: env.PROMPTCUT_DOCSERVICE_PUBLIC_URL || undefined,
      trustLoopback: env.PROMPTCUT_TEST_NO_LOOPBACK_TRUST !== '1',
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
    loopbackTrust: env.PROMPTCUT_TEST_NO_LOOPBACK_TRUST !== '1',
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
