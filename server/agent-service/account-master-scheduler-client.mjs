/**
 * 槽调度向 Agent 主服务问的那两条（`account-master-assembly.mjs` 的内部口）：
 *   pending()          哪些对话在排队、哪些任务要强制关（主服务原样转问文档服务）
 *   scopeControl(row)  取这一条的强制终态（文档服务签的，root 的发布器自己验签）
 * 用 root 那张证书连（主服务只认它来问这两条），主服务的证书在这里按指纹钉住。
 * 调度不在主服务那个进程里时（Linux 上它在 root 进程里）用这个客户端；回来的东西调度只是递。
 */
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { certificateFingerprint } from '../account/client.mjs';

export const MASTER_SCHEDULER_PENDING_PATH = '/internal/v2/master/scheduler/pending';
export const MASTER_SCHEDULER_CONTROL_PATH = '/internal/v2/master/scheduler/scope-control';
const fail = (code, status = 503) => Object.assign(new Error(code), { status, code });
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

export function createMasterSchedulerClient({ origin, tls, serverFingerprint256, timeoutMs = 15_000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw fail('master-scheduler-client-configuration'); }
  const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.hostname !== '127.0.0.1' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls.cert || !tls.ca || !/^[a-f0-9]{64}$/.test(pin) || !Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw fail('master-scheduler-client-configuration');
  const requests = new Set(); let closed = false;
  const call = (route, body) => new Promise((resolve, reject) => {
    if (closed) return reject(fail('master-scheduler-client-closed'));
    const encoded = Buffer.from(JSON.stringify(body));
    let value, error = null, ready = false, socket = null, socketClosed = false, settled = false;
    const finish = () => { if (settled || !ready || (socket && !socketClosed)) return; settled = true; clearTimeout(timer); requests.delete(req);
      error ? reject(error) : resolve(value); };
    const abort = cause => { if (ready) return; error = cause; ready = true; req.destroy(); socket?.destroy(); finish(); };
    const req = https.request(new URL(route, base), { method: 'POST', agent: false, key: tls.key, cert: tls.cert, ca: tls.ca,
      rejectUnauthorized: true, minVersion: 'TLSv1.3',
      checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
        (certificateFingerprint(cert.fingerprint256) !== pin ? fail('master-scheduler-server-certificate') : undefined); },
      headers: { connection: 'close', 'content-type': 'application/json', 'content-length': encoded.length } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) abort(fail('master-scheduler-response-too-large')); else chunks.push(chunk); });
      res.on('error', () => abort(fail('master-scheduler-unavailable')));
      res.on('aborted', () => abort(fail('master-scheduler-unavailable')));
      res.on('end', () => {
        if (ready) return;
        let parsed;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return abort(fail('master-scheduler-protocol')); }
        if (res.statusCode === 200 && parsed?.ok === true) value = parsed.result;
        else error = fail(safe(parsed?.code) ? parsed.code : 'master-scheduler-unavailable', [400, 403, 404, 409].includes(res.statusCode) ? res.statusCode : 503);
        ready = true; req.destroy(); socket?.destroy(); finish();
      });
    });
    requests.add(req);
    const timer = setTimeout(() => abort(fail('master-scheduler-timeout')), timeoutMs);
    req.on('socket', current => { socket = current; current.once('close', () => { socketClosed = true; finish(); }); });
    req.on('error', cause => { abort(safe(cause?.code) && cause.status ? cause : fail('master-scheduler-unavailable')); if (!socket) finish(); });
    req.end(encoded);
  });
  return {
    pending: () => call(MASTER_SCHEDULER_PENDING_PATH, {}),
    scopeControl: row => call(MASTER_SCHEDULER_CONTROL_PATH, row),
    close() { closed = true; for (const req of [...requests]) req.destroy(fail('master-scheduler-client-closed')); },
  };
}
