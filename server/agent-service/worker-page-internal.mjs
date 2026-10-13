/**
 * 任务进程 → 主服务:「向发起人的页面要一件事」的内部请求(0.7.18 工具表接线;反向通道的登记表在主服务,
 * 工具在任务进程里跑,两边不在一个进程)。
 *
 * 路径与交事件(`worker-event-internal.mjs`)在同一个口上:主服务那个只绑回环、双向 TLS 的内部口。鉴权照交事件的做法,一样不少:
 *   - 连过来的证书的指纹,必须是文档服务**此刻**说的「这条任务所在那一代进程的任务证书」;
 *   - 请求带这一代进程内存里那把钥匙的签名,签的是:固定的域名与路径、权威号、root 的槽与代、任务绑定的摘要、任务的八个字段、
 *     请求号、请求体的哈希、这条 TLS 连接的导出值(换一条连接重放不了)、一次性随机数(同一条连接上重放不了);
 *   - 每个请求都回文档服务核一次(`resolveWorker`,即主身份的 `workerEventSource`):任务还在、还是这一代、还绑着这个槽。
 * 请求体里的项目、对话、任务**只用来找到文档服务里的那一条**;交给反向通道的运行上下文(项目、对话、任务、发起人)
 * 一律取自文档服务回的那一份,不取自请求体,更不取自工具参数。
 *
 * 一次请求是一条长挂的 HTTP 请求:主服务等发起页交回(或超时、被拒)才回。任务进程一侧取消(停止、转私有、关 Agent、
 * 进程被杀)就是把这条连接断掉;主服务看到连接没了,把等待中的那一次作废,之后页面交回会被拒。
 * 主服务重启时这条连接同样会断:任务进程得到的是「主服务不可达」,按「发起人不在线」收(登记表里那一行标成被中断)。
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { certificateFingerprint } from '../account/client.mjs';

export const WORKER_PAGE_PATH = '/internal/v2/worker/page/request';
export const WORKER_PAGE_PROOF_HEADER = 'x-promptcut-worker-page-proof';
export const WORKER_PAGE_EXPORTER_LABEL = 'EXPORTER-PromptCut-Agent-Worker-Page-v1';
export const WORKER_PAGE_DOMAIN = 'promptcut.agent-worker.page.v1';
/** 任务的八个字段(任务绑定的 target 里的那几个;发起人的账号不在请求里,由文档服务给) */
export const WORKER_PAGE_BINDING_FIELDS = Object.freeze(['projectId', 'conversationId', 'messageId',
  'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'serviceKid']);
export const WORKER_PAGE_MAX_BODY = 256 * 1024;

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const ref = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** 请求体的形状。这里只核形状:它是谁发的、算不算数,由下面的签名与文档服务的回答定 */
export function validateWorkerPageEnvelope(input) {
  let v;
  try { v = structuredClone(input); } catch { fail(400, 'worker-page-envelope'); }
  if (!exact(v, ['v', 'authorityId', 'rootScopeRef', 'assignmentDigest', 'binding', 'requestId', 'request']) ||
      v.v !== 1 || !ref(v.authorityId) || !hash(v.assignmentDigest) ||
      !exact(v.rootScopeRef, ['rootAuthorityId', 'slotId', 'epoch', 'recordDigest']) ||
      !ref(v.rootScopeRef.rootAuthorityId) || !ref(v.rootScopeRef.slotId) || !hash(v.rootScopeRef.recordDigest) ||
      !Number.isSafeInteger(v.rootScopeRef.epoch) || v.rootScopeRef.epoch < 1 ||
      !exact(v.binding, WORKER_PAGE_BINDING_FIELDS) || WORKER_PAGE_BINDING_FIELDS.some(k => k === 'instanceGeneration'
        ? !Number.isSafeInteger(v.binding[k]) || v.binding[k] < 1 : !ref(v.binding[k])) ||
      typeof v.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(v.requestId) ||
      !exact(v.request, ['tool', 'args', 'timeoutMs', 'initiatorPages']) ||
      typeof v.request.tool !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(v.request.tool) || !plain(v.request.args) ||
      !Number.isSafeInteger(v.request.timeoutMs) || v.request.timeoutMs < 1 || v.request.timeoutMs > 600_000 ||
      !Array.isArray(v.request.initiatorPages) || v.request.initiatorPages.length > 64 ||
      v.request.initiatorPages.some(page => !exact(page, ['pageId', 'live']) || typeof page.pageId !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(page.pageId) || typeof page.live !== 'boolean'))
    fail(400, 'worker-page-envelope');
  try { if (canonicalJson(JSON.parse(JSON.stringify(v))) !== canonicalJson(v)) fail(400, 'worker-page-envelope'); }
  catch { fail(400, 'worker-page-envelope'); }
  return v;
}

export function workerPageRequest({ body, bodyText } = {}) {
  if (typeof bodyText !== 'string' || Buffer.byteLength(bodyText, 'utf8') > WORKER_PAGE_MAX_BODY) fail(400, 'worker-page-body');
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { fail(400, 'worker-page-body'); }
  const envelope = validateWorkerPageEnvelope(body);
  if (canonicalJson(parsed) !== canonicalJson(envelope)) fail(400, 'worker-page-body');
  return { envelope, bodyHash: createHash('sha256').update(bodyText, 'utf8').digest('hex') };
}

/** 这条 TLS 连接的导出值:只从真实的连接取,不从请求头或转发信息里拼 */
export function workerPageTlsBinding(socket) {
  if (!socket?.encrypted || socket.authorized !== true || socket.destroyed ||
      typeof socket.exportKeyingMaterial !== 'function') fail(503, 'worker-page-transport');
  try {
    const bytes = socket.exportKeyingMaterial(32, WORKER_PAGE_EXPORTER_LABEL);
    if (bytes.length !== 32) fail(503, 'worker-page-transport');
    return createHash('sha256').update(bytes).digest('hex');
  } catch { fail(503, 'worker-page-transport'); }
}

export function workerPageProofPayload({ request, channelBinding, nonce } = {}) {
  if (!request || !hash(request.bodyHash) || !hash(channelBinding) || !ref(nonce)) fail(400, 'worker-page-proof');
  const e = validateWorkerPageEnvelope(request.envelope);
  return { v: 1, domain: WORKER_PAGE_DOMAIN, method: 'POST', path: WORKER_PAGE_PATH,
    authorityId: e.authorityId, rootScopeRef: e.rootScopeRef, assignmentDigest: e.assignmentDigest,
    binding: e.binding, requestId: e.requestId, envelopeDigest: digestOf(e),
    bodyHash: request.bodyHash, channelBinding, nonce };
}

/**
 * 只挂在主服务的那个直连、双向 TLS 的内部口上。
 * @param {object} o
 * @param {string} o.authorityId 文档服务的权威号(主身份登记成功后才知道)
 * @param {(input: { projectId: string, runGrantId: string, assignmentDigest: string }) => Promise<object>} o.resolveWorker
 *   主身份向文档服务现问的那一条(`runClient.workerEventSource`);不许用缓存
 * @param {(call: { context: object, source: object, envelope: object, signal: AbortSignal }) => Promise<object>} o.onRequest
 *   鉴权通过之后才调。`context` 是从文档服务的回答里拼出来的可信八字段;`signal` 在任务进程把连接断掉时触发
 */
export function createWorkerPageInternalHandler({ authorityId, resolveWorker, onRequest } = {}) {
  if (!ref(authorityId) || typeof resolveWorker !== 'function' || typeof onRequest !== 'function') fail(503, 'worker-page-configuration');
  const used = new WeakMap();
  return async function handle(req, res) {
    if (req.url !== WORKER_PAGE_PATH) return false;
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
      res.end(JSON.stringify(body));
    };
    const controller = new AbortController();
    // 回应写完之前连接没了 = 任务进程不等了(它被停、被杀、自己取消)
    const onGone = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onGone);
    try {
      if (req.method !== 'POST') fail(405, 'method-not-allowed');
      if (req.socket?.encrypted !== true || req.socket.authorized !== true || req.socket.destroyed ||
          Object.keys(req.headers ?? {}).some(k => k === 'forwarded' || k === 'x-real-ip' || k.startsWith('x-forwarded-')))
        fail(403, 'worker-page-peer');
      const peer = certificateFingerprint(req.socket.getPeerCertificate?.()?.fingerprint256);
      if (!hash(peer)) fail(403, 'worker-page-peer');
      const encoded = req.headers?.[WORKER_PAGE_PROOF_HEADER];
      if (typeof encoded !== 'string' || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail(403, 'worker-page-proof');
      let proof;
      try { proof = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { fail(403, 'worker-page-proof'); }
      if (!exact(proof, ['v', 'nonce', 'signature']) || proof.v !== 1 || !ref(proof.nonce) ||
          typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) fail(403, 'worker-page-proof');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; if (size > WORKER_PAGE_MAX_BODY) fail(413, 'worker-page-body'); chunks.push(chunk);
      }
      let bodyText, body;
      try { bodyText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); body = JSON.parse(bodyText); }
      catch { fail(400, 'worker-page-body'); }
      const request = workerPageRequest({ body, bodyText });
      const e = request.envelope;
      if (e.authorityId !== authorityId) fail(403, 'worker-page-source');
      // 每个请求都现问文档服务:这条任务还在、还是这一代进程、还绑着这个槽
      let source;
      try { source = structuredClone(await resolveWorker({ projectId: e.binding.projectId, runGrantId: e.binding.runGrantId, assignmentDigest: e.assignmentDigest })); }
      catch (error) { fail([400, 401, 403, 404, 409].includes(error?.status) ? 403 : 503, [400, 401, 403, 404, 409].includes(error?.status) ? 'worker-page-source' : 'worker-page-authority-unavailable'); }
      const grant = source?.runGrant;
      if (source?.allowed !== true || !grant || !['active', 'retained'].includes(grant.state) || !ref(grant.readReceiptId) || !ref(grant.accountId) ||
          WORKER_PAGE_BINDING_FIELDS.some(k => grant[k] !== e.binding[k]) ||
          source.assignmentDigest !== e.assignmentDigest || canonicalJson(source.rootScopeRef) !== canonicalJson(e.rootScopeRef) ||
          !Number.isSafeInteger(source.fenceRevision) || source.fenceRevision < 0 ||
          source.message?.messageId !== e.binding.messageId || source.message?.senderAccountId !== grant.accountId)
        fail(403, 'worker-page-source');
      if (certificateFingerprint(source.workerFingerprint256) !== peer || source.scopePublicKeyDigest !== digestOf(source.scopePublicKey)) fail(403, 'worker-page-peer');
      let key;
      try {
        key = createPublicKey({ key: Buffer.from(source.scopePublicKey, 'base64'), format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'der', type: 'spki' }).toString('base64') !== source.scopePublicKey)
          fail(403, 'worker-page-key');
      } catch { fail(403, 'worker-page-key'); }
      const payload = workerPageProofPayload({ request, nonce: proof.nonce, channelBinding: workerPageTlsBinding(req.socket) });
      if (!verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(proof.signature, 'base64url'))) fail(403, 'worker-page-signature');
      const nonces = used.get(req.socket) ?? new Set();
      if (nonces.has(proof.nonce)) fail(403, 'worker-page-replay');
      nonces.add(proof.nonce); used.set(req.socket, nonces);
      // 可信的运行上下文:八个字段全部来自文档服务的回答
      const context = Object.freeze({ projectId: grant.projectId, conversationId: grant.conversationId, runId: grant.runId,
        runGrantId: grant.runGrantId, instanceId: grant.instanceId, instanceGeneration: grant.instanceGeneration,
        senderAccountId: grant.accountId, messageId: grant.messageId });
      if (controller.signal.aborted) return true;
      const result = await onRequest({ context, source, envelope: e, signal: controller.signal });
      reply(200, { ok: true, result });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503;
      reply(status, { ok: false, code: typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code) ? error.code : 'worker-page-unavailable' });
    } finally { res.off('close', onGone); }
    return true;
  };
}
