/** 独立账号v2素材入口；部署由root分配专用OS用户，不能共持doc/account/agent/render私钥。 */
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { certificateFingerprint } from '../account/client.mjs';
import { startHostedAssetService } from './asset-runtime.mjs';

const file = name => { const value = process.env[name]; if (!value || !path.isAbsolute(value)) throw new Error('asset-configuration'); return fs.readFileSync(value); };
const port = name => { const value = Number(process.env[name]); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('asset-port'); return value; };
const positive = name => { const value = Number(process.env[name]); if (!Number.isSafeInteger(value) || value < 1) throw new Error('asset-run-configuration'); return value; };
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
    docFingerprint256: env.PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256, recoveryFence: env.PROMPTCUT_ASSET_RECOVERY_FENCE_FILE,
    serviceIdentity: env.PROMPTCUT_ASSET_SERVICE_IDENTITY, log };
  if (env.PROMPTCUT_ASSET_RUN_ENABLED !== undefined && !['0', '1'].includes(env.PROMPTCUT_ASSET_RUN_ENABLED))
    throw new Error('asset-run-configuration');
  if (env.PROMPTCUT_ASSET_RUN_ENABLED === '1') {
    const fingerprint256 = String(env.PROMPTCUT_ASSET_AGENT_FINGERPRINT256 ?? '').replaceAll(':', '').toLowerCase();
    const serviceKid = env.PROMPTCUT_ASSET_AGENT_SERVICE_KID;
    if (!/^[a-f0-9]{64}$/.test(fingerprint256) || typeof serviceKid !== 'string' || !serviceKid)
      throw new Error('asset-run-configuration');
    config.runAssets = { agentFingerprint256: fingerprint256,
      timeoutMs: positive('PROMPTCUT_ASSET_RUN_TIMEOUT_MS'),
      maxResponseBytes: positive('PROMPTCUT_ASSET_RUN_MAX_RESPONSE_BYTES'),
      maxBodyBytes: positive('PROMPTCUT_ASSET_RUN_MAX_BODY_BYTES'),
      // This callback only maps the pinned live Agent mTLS peer to the
      // configured service key. The doc rechecks current registry and the
      // precise registered RAM instance on every run-assets request.
      resolveAgentTransport({ req, socket, fingerprint256: actual }) {
        if (socket !== req.socket || actual !== fingerprint256 || socket.authorized !== true || socket.destroyed)
          throw new Error('asset-run-service-forbidden');
        return { serviceKid };
      } };
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' ||
        !env.PROMPTCUT_ASSET_ROOT_UNIT || !env.PROMPTCUT_ASSET_ROOT_CGROUP_PATH)
      throw new Error('asset-run-configuration');
    config.runAssets.rootReservationFile = env.PROMPTCUT_ASSET_ROOT_RESERVATION_FILE;
    if (!path.isAbsolute(config.runAssets.rootReservationFile ?? '')) throw new Error('asset-run-configuration');
    config.runAssets.rootExpected = { authorityId: config.doc.authorityId,
      serviceIdentity: config.serviceIdentity, uid: process.getuid(), unit: env.PROMPTCUT_ASSET_ROOT_UNIT,
      cgroupPath: env.PROMPTCUT_ASSET_ROOT_CGROUP_PATH,
      clientFingerprint256: certificateFingerprint(new X509Certificate(config.doc.tls.cert).fingerprint256),
      serverFingerprint256: certificateFingerprint(new X509Certificate(config.internalTls.cert).fingerprint256) };
  }
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
