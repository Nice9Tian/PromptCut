/** 独立asset进程只用自己的client证书问doc；不接收public自报principal或角色。 */
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { certificateFingerprint, accountError } from '../account/client.mjs';

export function createAssetMtlsTransport({ origin, tls, serverFingerprint256, timeoutMs = 5000 }) {
  const base = new URL(origin), pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin)) throw accountError(503, 'asset-mtls-configuration');
  const agent = new https.Agent({ key: tls.key, cert: tls.cert, ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3',
    checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
      (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'asset-mtls-certificate') : undefined); } });
  const requests = new Set(); let stopped = false;
  const request = (method, route, body) => new Promise((resolve, reject) => {
    if (stopped || !route.startsWith('/internal/v2/')) return reject(accountError(503, 'asset-authority-unavailable'));
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const fail = () => reject(accountError(503, 'asset-authority-unavailable'));
    const req = https.request(new URL(route, base), { method, agent, timeout: timeoutMs,
      headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {} }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { res.destroy(); fail(); } else chunks.push(chunk); });
      res.on('aborted', fail); res.on('error', fail);
      res.on('end', () => {
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(); }
        if (res.statusCode !== 200 || value?.ok !== true) return reject(accountError(
          [400, 401, 403, 404, 409, 410, 415].includes(res.statusCode) ? res.statusCode : 503,
          typeof value?.code === 'string' ? value.code : 'asset-authority-unavailable'));
        resolve(value);
      });
    });
    requests.add(req); req.once('close', () => requests.delete(req));
    req.on('timeout', () => req.destroy()); req.on('error', fail); req.end(encoded);
  });
  return { request, close() { stopped = true; for (const req of requests) req.destroy(); agent.destroy(); } };
}

export function createAssetDocClient({ authorityId, ...config }) {
  if (typeof authorityId !== 'string' || !authorityId) throw accountError(503, 'asset-authority-configuration');
  const transport = createAssetMtlsTransport(config), subscriptions = new Set(); let notified = 0;
  const principal = value => {
    if (value?.allowed !== true || value.authorityId !== authorityId ||
        ['accountId', 'loginId', 'credentialId', 'projectId', 'authorizationId'].some(key => typeof value[key] !== 'string' || !value[key]) ||
        !Number.isSafeInteger(value.loginGeneration) || !Number.isSafeInteger(value.accessRevision) || !Number.isSafeInteger(value.revocationSeq) ||
        !['r', 'rw'].includes(value.access)) throw accountError(503, 'asset-authority-protocol');
    // 精确字段白名单；即使服务响应误带token也不把它传播到队列/日志。
    return Object.fromEntries(['accountId', 'loginId', 'credentialId', 'loginGeneration', 'projectId', 'authorizationId',
      'authorityId', 'access', 'accessRevision', 'revocationSeq', 'expiresAt', 'role'].map(key => [key, value[key]]));
  };
  return {
    authorityId,
    async resolveAssetTicket(assetTicket, projectId) {
      if (typeof assetTicket !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(assetTicket)) throw accountError(401, 'asset-ticket-required');
      const result = await transport.request('POST', '/internal/v2/access/check', { assetTicket, ...(projectId === undefined ? {} : { projectId }), action: 'read', resource: { ns: 'media' } });
      const p = principal(result); if (projectId !== undefined && p.projectId !== projectId) throw accountError(403, 'project-mismatch'); return p;
    },
    async checkAccess(input) {
      const result = await transport.request('POST', '/internal/v2/access/check', input), p = principal(result);
      if (p.projectId !== input.projectId || p.authorizationId !== input.principal?.authorizationId) throw accountError(503, 'asset-authority-protocol');
      return { allowed: true, ...p };
    },
    async eventsSince(after) {
      const result = await transport.request('GET', `/internal/v2/access/events?after=${after}`);
      if (!Number.isSafeInteger(result.headSeq) || result.headSeq < after || !Array.isArray(result.events) || result.events.length > 100 ||
          result.events.some((event, n) => event.seq !== after + n + 1 || typeof event.eventId !== 'string' || !event.eventId)) throw accountError(503, 'asset-event-gap');
      // 新通知同步启动lease fence；连续页和ACK仍由持久consumer处理。
      for (const event of result.events) if (event.seq > notified) { notified = event.seq; for (const callback of subscriptions) callback(event); }
      return { events: result.events, headSeq: result.headSeq };
    },
    subscribeRevocations(_context, callback) { subscriptions.add(callback); return () => subscriptions.delete(callback); },
    ackAccessEvent(eventId, serviceId, receipt) {
      if (serviceId !== 'asset') throw accountError(403, 'service-forbidden');
      return transport.request('POST', `/internal/v2/access/events/${encodeURIComponent(eventId)}/ack`, receipt);
    },
    close() { subscriptions.clear(); transport.close(); },
  };
}

/** doc进程读取asset实时内部status；仅持doc私钥，永不加载asset私钥。 */
export function createAssetReadyProbe(config) {
  const transport = createAssetMtlsTransport(config);
  const probe = async ({ authorityId, requiredAccessHead }) => {
    const value = await transport.request('GET', '/internal/v2/asset/status');
    if (value.ready !== true || value.authorityId !== authorityId || value.accessCursor !== requiredAccessHead || value.accessHead !== requiredAccessHead ||
        typeof value.instanceId !== 'string' || !value.instanceId) throw accountError(503, 'asset-not-ready');
    return value;
  };
  probe.close = () => transport.close(); return probe;
}
