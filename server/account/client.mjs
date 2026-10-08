import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { INTERNAL_PATHS, validateAccountPrincipal, validateEventBatch, requireRequestId } from './protocol.mjs';

export const accountError = (status, code) => Object.assign(new Error(code), { status, code });
export const certificateFingerprint = value => String(value ?? '').replaceAll(':', '').toLowerCase();

/** Explicit owner-provided private CA, client certificate and pinned account leaf.
 * No credentials in URLs/logs, no loopback exemption, no CA-only fallback.
 */
export function createAccountClient({ origin, tls, serverFingerprint256, timeoutMs = 5000 }) {
  const url = new URL(origin);
  const pin = certificateFingerprint(serverFingerprint256);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin)) throw accountError(503, 'account-configuration');
  const agent = new https.Agent({ key: tls.key, cert: tls.cert, ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3',
    checkServerIdentity(host, certificate) {
      const error = checkServerIdentity(host, certificate);
      if (error) return error;
      if (certificateFingerprint(certificate.fingerprint256) !== pin) return accountError(503, 'account-certificate');
    } });
  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const fail = () => reject(accountError(503, 'account-unavailable'));
      const req = https.request(new URL(path, url), { method, agent, timeout: timeoutMs,
        headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {} }, res => {
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { res.destroy(); fail(); } else chunks.push(chunk); });
        res.on('error', fail);
        res.on('end', () => {
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(); }
          if (res.statusCode !== 200 || value?.ok !== true) {
            if (res.statusCode === 401) return reject(accountError(401, 'credential-revoked'));
            return fail();
          }
          resolve(value);
        });
      });
      req.on('timeout', () => req.destroy()); req.on('error', fail); req.end(encoded);
    });
  }
  return { close: () => agent.destroy(),
    async verify(accessToken) {
      if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 256) throw accountError(401, 'login-required');
      const result = await request('POST', INTERNAL_PATHS.verify, { accessToken, audience: 'doc', requestId: randomUUID() });
      try {
        const principal = validateAccountPrincipal(result.principal);
        if (result.accountEventSeq !== principal.accountEventSeq) throw new Error();
        return principal;
      } catch { throw accountError(503, 'account-protocol'); }
    },
    /** Doc-persisted accepted-message qualification has a separate purpose from
     * ordinary access-token admission. This never returns a reusable principal. */
    async verifyAcceptedMessage(actorRef, context) {
      const identity = ['accountId', 'loginId', 'credentialId', 'loginGeneration'];
      const messageFields = ['projectId', 'conversationId', 'messageId', 'recordDigest'];
      const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
      const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
      const messageRef = context?.messageRef;
      if (!exact(actorRef, identity) || !/^acc_[0-9a-f]{24}$/.test(actorRef.accountId ?? '') ||
          !reference(actorRef.loginId) || !reference(actorRef.credentialId) ||
          !Number.isSafeInteger(actorRef.loginGeneration) || actorRef.loginGeneration < 1 ||
          !exact(context, ['purpose', 'messageRef']) || context.purpose !== 'accepted-message' ||
          !exact(messageRef, messageFields) || !messageFields.slice(0, 3).every(field => reference(messageRef[field])) ||
          !/^[0-9a-f]{64}$/.test(messageRef.recordDigest ?? '')) throw accountError(400, 'accepted-message-reference');
      const result = await request('POST', '/internal/v2/credentials/verify-accepted-message', {
        requestId: randomUUID(), audience: 'doc', actorRef, messageRef,
      });
      if (!exact(result, ['ok', 'purpose', 'actorRef', 'messageRef', 'accountEventSeq', 'kind']) ||
          result.purpose !== 'accepted-message' || result.kind !== 'editor' ||
          !exact(result.actorRef, identity) || identity.some(field => result.actorRef[field] !== actorRef[field]) ||
          !exact(result.messageRef, messageFields) || messageFields.some(field => result.messageRef[field] !== messageRef[field]) ||
          !Number.isSafeInteger(result.accountEventSeq) || result.accountEventSeq < 0)
        throw accountError(503, 'accepted-message-protocol');
      return { ...result.actorRef, accountEventSeq: result.accountEventSeq };
    },
    async events(after = 0) {
      const result = await request('GET', `${INTERNAL_PATHS.events}?after=${after}`);
      try { return validateEventBatch(result, after); } catch { throw accountError(503, 'account-event-gap'); }
    },
    ack(eventId, receipt) {
      requireRequestId(receipt.receiptId);
      return request('POST', `${INTERNAL_PATHS.events}/${encodeURIComponent(eventId)}/ack`, receipt);
    },
  };
}
