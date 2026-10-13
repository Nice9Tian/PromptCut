// 独立素材服务进程的入口，只给 account-runner-process 夹具用。
//
// 和生产入口 `server/hosted/asset-main.mjs` 读同一组环境变量、起的是同一个 `startHostedAssetService`。
// 只多做一件生产入口在这台机器上不肯做的事：打开「运行素材」。生产入口打开它要 root 写的登记文件
// （核属主、cgroup，只在 Linux 上）；这里不带那份登记，素材服务的实例号由它自己现生成。
// 所以这个入口证明不了「文档服务认的素材进程就是 root 登记的那一个」，只证明三方的请求与签名对得上、字节真的进出。
import fs from 'node:fs';
import path from 'node:path';
import { startHostedAssetService } from '../../hosted/asset-runtime.mjs';

const env = process.env;
const file = name => { const value = env[name]; if (!value || !path.isAbsolute(value)) throw new Error('asset-configuration'); return fs.readFileSync(value); };
const port = name => { const value = Number(env[name]); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('asset-port'); return value; };
const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
let service;
try {
  const ca = file('PROMPTCUT_ASSET_DOC_CA_FILE');
  const agentPin = String(env.PROMPTCUT_ASSET_AGENT_FINGERPRINT256 ?? '').replaceAll(':', '').toLowerCase(), serviceKid = env.PROMPTCUT_ASSET_AGENT_SERVICE_KID;
  if (!/^[a-f0-9]{64}$/.test(agentPin) || !serviceKid || !env.PROMPTCUT_ASSET_SERVICE_IDENTITY) throw new Error('asset-run-configuration');
  service = await startHostedAssetService({ dataDir: env.PROMPTCUT_ASSET_DATA_DIR, host: env.PROMPTCUT_ASSET_HOST || '127.0.0.1',
    port: port('PROMPTCUT_ASSET_PORT'), internalPort: port('PROMPTCUT_ASSET_INTERNAL_PORT'), publicUrl: env.PROMPTCUT_ASSET_PUBLIC_URL,
    doc: { authorityId: env.PROMPTCUT_ASSET_DOC_AUTHORITY_ID, origin: env.PROMPTCUT_ASSET_DOC_ORIGIN,
      serverFingerprint256: env.PROMPTCUT_ASSET_DOC_FINGERPRINT256,
      tls: { key: file('PROMPTCUT_ASSET_CLIENT_KEY_FILE'), cert: file('PROMPTCUT_ASSET_CLIENT_CERT_FILE'), ca } },
    internalTls: { key: file('PROMPTCUT_ASSET_INTERNAL_KEY_FILE'), cert: file('PROMPTCUT_ASSET_INTERNAL_CERT_FILE'), ca },
    docFingerprint256: env.PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256, serviceIdentity: env.PROMPTCUT_ASSET_SERVICE_IDENTITY, log,
    runAssets: { agentFingerprint256: agentPin, timeoutMs: 30_000, maxResponseBytes: 1024 * 1024, maxBodyBytes: 16 * 1024 * 1024,
      // 和生产入口同一个写法：只把钉住的那张 Agent 证书对应到配置里的服务钥匙号
      resolveAgentTransport({ req, socket, fingerprint256: actual }) {
        if (socket !== req.socket || actual !== agentPin || socket.authorized !== true || socket.destroyed) throw new Error('asset-run-service-forbidden');
        return { serviceKid };
      } } });
  log('asset.listen', { port: service.port, internalPort: service.internalPort, instanceId: service.instanceId, runAssets: service.runAssetsStatus });
} catch (error) { log('asset.config-error', { code: error.code ?? error.message ?? 'asset-configuration' }); process.exitCode = 1; }
if (service) {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (stopping) return; stopping = true;
    void service.close().then(() => { log('asset.closed'); }, () => { log('asset.close-failed'); process.exitCode = 1; });
  });
}
