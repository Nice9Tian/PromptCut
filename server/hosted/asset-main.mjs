/** 独立账号v2素材入口；部署由root分配专用OS用户，不能共持doc/account/agent/render私钥。 */
import fs from 'node:fs';
import path from 'node:path';
import { startHostedAssetService } from './asset-runtime.mjs';

const file = name => { const value = process.env[name]; if (!value || !path.isAbsolute(value)) throw new Error('asset-configuration'); return fs.readFileSync(value); };
const port = name => { const value = Number(process.env[name]); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('asset-port'); return value; };
const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
let service;
try {
  const env = process.env, ca = file('PROMPTCUT_ASSET_DOC_CA_FILE');
  const config = { dataDir: env.PROMPTCUT_ASSET_DATA_DIR, host: env.PROMPTCUT_ASSET_HOST || '127.0.0.1',
    port: port('PROMPTCUT_ASSET_PORT'), internalPort: port('PROMPTCUT_ASSET_INTERNAL_PORT'), publicUrl: env.PROMPTCUT_ASSET_PUBLIC_URL,
    doc: { authorityId: env.PROMPTCUT_ASSET_DOC_AUTHORITY_ID, origin: env.PROMPTCUT_ASSET_DOC_ORIGIN,
      serverFingerprint256: env.PROMPTCUT_ASSET_DOC_FINGERPRINT256,
      tls: { key: file('PROMPTCUT_ASSET_CLIENT_KEY_FILE'), cert: file('PROMPTCUT_ASSET_CLIENT_CERT_FILE'), ca } },
    internalTls: { key: file('PROMPTCUT_ASSET_INTERNAL_KEY_FILE'), cert: file('PROMPTCUT_ASSET_INTERNAL_CERT_FILE'), ca },
    docFingerprint256: env.PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256, log };
  if (env.PROMPTCUT_HOSTED_RENDER_CAP_BYTES !== undefined) {
    const cap = Number(env.PROMPTCUT_HOSTED_RENDER_CAP_BYTES); if (!Number.isFinite(cap) || cap < 0) throw new Error('asset-capacity'); config.renderCapBytes = Math.floor(cap);
  }
  service = await startHostedAssetService(config);
  log('asset.listen', { port: service.port, internalPort: service.internalPort, instanceId: service.instanceId, ready: service.ready });
} catch (error) { log('asset.config-error', { code: ['asset-port', 'asset-capacity'].includes(error.message) ? error.message : error.code ?? 'asset-configuration' }); process.exitCode = 1; }
if (service) {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (stopping) return; stopping = true;
    void service.close().then(() => { log('asset.closed'); }, () => { log('asset.close-failed'); process.exitCode = 1; });
  });
}
