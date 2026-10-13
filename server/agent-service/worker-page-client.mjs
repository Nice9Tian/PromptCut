/**
 * 任务进程里的「反向通道」薄客户端(0.7.18 工具表接线)。
 *
 * 反向通道的登记表(哪张页面在线、哪条请求在等)在主服务(`account-master-assembly.mjs` 里的 `page-bridge.mjs`);
 * 工具调用发生在任务进程。这里对工具提供者(`createPageControlTools`、`createHandoffTools`、`createCollectBridge`)
 * 给出和 `createPageBridge` 同一个形状的那几样(`requestPage`、`initiator`、`limits`、`extraTools`),
 * 实际做法是经 `worker-page-internal.mjs` 那条内部请求问主服务并等它回答。
 *
 * 规矩:
 *   - 发起人、发起页只从**这个进程自己**向文档服务取的当前运行授权里取(`createRunPageAuthority`);调用方给的只是断言,对不上就拒;
 *   - 发起页此刻在不在文档服务的在场表里,由这一轮自己的数据连接去问(`presence`);不在就当场回不在线,不去打扰主服务;
 *   - 请求体里不带发起人账号;主服务拼运行上下文用的是它自己向文档服务问来的那一份;
 *   - 这一轮被叫停(登记器的信号、调用方的信号、`cancelRun`、`close`)时把那条连接断掉,主服务据此把等待作废;
 *   - 主服务回了「页面交回了」之后,这里再向文档服务核一次:授权还是当前的、还是发起人本人有效、栅栏版本与页面号没变;
 *     不一致按不在线处理,页面交来的内容不当结果用;
 *   - 主服务连不上、中途断了、超时:回 `{ delivered: false, offline: true }`,原因写明(`master-unavailable` 等),不挂着。
 */
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { canonicalJson } from '../account/ledger.mjs';
import { WORKER_PAGE_PATH } from './worker-page-internal.mjs';
import { PAGE_BRIDGE_DEFAULTS, PAGE_BRIDGE_TOOLS, PageBridgeError, BRIDGE_REQUEST_ID_RE, checkedPageArgs,
  createRunPageAuthority } from '../agent/service/page-bridge.mjs';

const fail = (code, status = 503) => { throw new PageBridgeError(code, status); };
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const offline = (why, state = 'offline') => Object.freeze({ delivered: false, offline: true, why, state });

/**
 * @param {object} o
 * @param {object} o.runClient 这个任务进程自己的那一个(签名用它内存里的钥匙;取授权也用它)
 * @param {object} o.resources 运行资源登记器(`run-resources.mjs`)
 * @param {string} o.origin 主服务内部口的地址(`https://127.0.0.1:<端口>/`)
 * @param {{ key, cert, ca }} o.tls 这个进程的任务证书(和交事件用的是同一张)
 * @param {string} o.serverFingerprint256 主服务证书的指纹
 * @param {(context: object) => Promise<{ members: Array<{ accountId: string, isInitiator: boolean, pages: Array<{ pageId: string, live: boolean }> }> }>} o.presence
 *   文档服务的在场表(这一轮的数据连接上的 `selection.query`);取不到按不在线办
 * @param {Record<string, { args(value: object): object }>} [o.extraTools] 别的工具包加在这条通道上的请求(只用它的 `args` 先在本进程里把参数查一遍)
 */
export function createWorkerPageClient({ runClient, resources, origin, tls, serverFingerprint256, presence, extraTools = null,
  limits: limitOverrides = {}, now = Date.now, log = () => {} } = {}) {
  let base;
  try { base = new URL(origin); } catch { fail('page-bridge-configuration'); }
  const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.hostname !== '127.0.0.1' || base.pathname !== '/' || base.search || base.hash ||
      !tls?.key || !tls.cert || !tls.ca || !/^[a-f0-9]{64}$/.test(pin) ||
      typeof runClient?.workerPageEnvelopeFor !== 'function' || typeof runClient.workerPageProofFor !== 'function' ||
      typeof presence !== 'function') fail('page-bridge-configuration');
  const extra = new Map(Object.entries(extraTools ?? {}).filter(([, spec]) => typeof spec?.args === 'function'));
  const authority = createRunPageAuthority({ resources, runClient });
  const limits = Object.freeze({ ...PAGE_BRIDGE_DEFAULTS, ...limitOverrides });
  const say = (event, fields) => { try { log(event, fields); } catch { /* 日志的事 */ } };
  /** 在途的请求:`{ context, abort }` */
  const inflight = new Set();
  /** 同一个请求号重复调用回同一个结果(宿主重试同一次工具调用时页面不会执行两次;主服务那边也按请求号去重) */
  const byRequest = new Map();
  let closed = false;

  function post(envelope, signal, waitMs) {
    const bodyText = canonicalJson(envelope), encoded = Buffer.from(bodyText);
    return new Promise((resolve) => {
      let done = false, socket = null;
      const finish = (value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        try { req.destroy(); } catch { /* 已经关了 */ } try { socket?.destroy(); } catch { /* 已经关了 */ } resolve(value); };
      const onAbort = () => finish(offline('run-cancelled', 'cancelled'));
      const req = https.request(new URL(WORKER_PAGE_PATH, base), {
        ...tls, method: 'POST', agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.3',
        checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
          (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'worker-page-server-certificate') : undefined); },
        headers: { 'content-type': 'application/json', 'content-length': encoded.length, connection: 'close' },
      }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) finish(offline('master-protocol', 'interrupted')); else chunks.push(chunk); });
        res.on('error', () => finish(offline('master-unavailable', 'interrupted')));
        res.once('end', () => {
          try {
            const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (res.statusCode === 200 && body?.ok === true && plain(body.result)) return finish(body.result);
            const code = typeof body?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(body.code) ? body.code : 'master-unavailable';
            // 主服务明确拒绝(鉴权不过、参数不对、同号不同内容):不是「不在线」,如实抛
            if ([400, 403, 404, 409, 413].includes(res.statusCode)) return finish({ rejected: true, status: res.statusCode, code });
            finish(offline(code, 'interrupted'));
          } catch { finish(offline('master-protocol', 'interrupted')); }
        });
        // 回应没收完连接就断了(主服务重启、被关)
        res.once('close', () => finish(offline('master-unavailable', 'interrupted')));
      });
      const timer = setTimeout(() => finish(offline('deadline', 'expired')), Math.max(1, waitMs));
      timer.unref?.();
      req.once('error', () => finish(offline('master-unavailable', 'interrupted')));
      req.once('socket', (current) => {
        socket = current;
        current.once('secureConnect', async () => {
          try {
            if (done) return;
            const proof = await runClient.workerPageProofFor({ socket: current, envelope, bodyText, nonce: randomUUID() });
            if (done) return;
            req.setHeader(proof.name, proof.value); req.end(encoded);
          } catch (error) { finish({ rejected: true, status: 503, code: typeof error?.code === 'string' ? error.code : 'worker-page-proof' }); }
        });
      });
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    });
  }

  async function initiatorPages(context, binding) {
    let state;
    try { state = await presence(context); } catch (error) { say('agent.page.presence', { code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'error' }); return null; }
    if (!state || !Array.isArray(state.members)) return null;
    const mine = state.members.find((member) => member?.accountId === binding.accountId && member.isInitiator === true && Array.isArray(member.pages));
    return (mine?.pages ?? []).filter((page) => typeof page?.pageId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(page.pageId) && typeof page.live === 'boolean')
      .slice(0, 64).map((page) => ({ pageId: page.pageId, live: page.live }));
  }

  async function issue(context, input) {
    const binding = await authority.current(context);
    if (input.initiatorAccountId !== binding.accountId || input.pageId !== binding.pageId) fail('page-binding-mismatch', 403);
    const refuse = (why, state) => { say('agent.page.offline', { tool: input.tool, why }); return offline(why, state); };
    if (binding.pageId === null) return refuse('no-page');
    if (binding.grantState !== 'active') return refuse('initiator-revoked');
    const pages = await initiatorPages(context, binding);
    if (pages === null) return refuse('presence-unavailable');
    if (!pages.some((page) => page.pageId === binding.pageId && page.live === true)) return refuse('page-not-live');
    const remaining = input.deadline - Number(now());
    if (remaining <= 0) return refuse('deadline', 'expired');
    let envelope;
    try { envelope = runClient.workerPageEnvelopeFor({ requestId: input.requestId, request: { tool: input.tool, args: input.args, timeoutMs: Math.max(1, Math.trunc(remaining)), initiatorPages: pages } }); }
    catch (error) { fail(typeof error?.code === 'string' ? error.code : 'page-bridge-unavailable', 503); }
    // 取消:调用方的信号、这一轮被收回(登记器的信号)、宿主的 cancelRun / close
    const controller = new AbortController();
    const entry = { context, abort: () => controller.abort() };
    const signals = [input.signal];
    try { signals.push(authority.signalFor(context)); } catch { /* 这一轮没登记过资源:没有可听的信号 */ }
    const detach = [];
    for (const signal of signals) {
      if (!signal || typeof signal.addEventListener !== 'function') continue;
      if (signal.aborted) controller.abort();
      else { const handler = () => controller.abort(); signal.addEventListener('abort', handler, { once: true }); detach.push(() => signal.removeEventListener('abort', handler)); }
    }
    inflight.add(entry);
    let out;
    try {
      say('agent.page.request', { projectId: context.projectId, runId: context.runId, tool: input.tool });
      // 等主服务的时限比页面的时限略长一点:让「超时」由主服务的登记表来判并落盘
      out = await post(envelope, controller.signal, remaining + 5_000);
    } finally { inflight.delete(entry); for (const off of detach) off(); }
    if (out?.rejected === true) fail(out.code, out.status);
    if (out?.delivered === true) {
      const answer = out.answer;
      if (!plain(answer) || typeof answer.ok !== 'boolean') return refuse('answer-unreadable', 'rejected');
      // 页面交回了:再核一次这一轮此刻还算数(核对期间被停、转私有、被踢、换了栅栏版本的,页面交来的不当结果用)
      let again = null;
      try { again = await authority.current(context); } catch { again = null; }
      if (!again || again.grantState !== 'active' || again.fenceRevision !== binding.fenceRevision ||
          again.accountId !== binding.accountId || again.pageId !== binding.pageId) return refuse('run-changed', 'rejected');
      return Object.freeze({ delivered: true, answer });
    }
    if (out?.delivered === false && out.offline === true) {
      say('agent.page.offline', { tool: input.tool, why: String(out.why ?? 'offline').slice(0, 60) });
      return offline(String(out.why ?? 'offline').slice(0, 60), typeof out.state === 'string' ? out.state.slice(0, 20) : 'offline');
    }
    return refuse('master-protocol', 'interrupted');
  }

  function requestPage(request) {
    if (closed) return Promise.reject(new PageBridgeError('page-bridge-closed', 503));
    try {
      if (!plain(request) || Object.keys(request).some((k) => !['run', 'initiatorAccountId', 'pageId', 'tool', 'args', 'requestId', 'deadline', 'signal'].includes(k))) fail('bad-request', 400);
      if (typeof request.tool !== 'string') fail('page-tool-unknown', 404);
      const known = PAGE_BRIDGE_TOOLS.includes(request.tool);
      if (!known && !extra.has(request.tool)) fail('page-tool-unknown', 404);
      const args = known ? checkedPageArgs(request.tool, request.args, limits) : extra.get(request.tool).args(request.args);
      if (!plain(args)) fail('bad-args', 400);
      if (typeof request.requestId !== 'string' || !BRIDGE_REQUEST_ID_RE.test(request.requestId)) fail('bad-request-id', 400);
      const at = Number(now());
      const wanted = request.deadline === undefined ? at + limits.pageMs : request.deadline;
      if (typeof wanted !== 'number' || !Number.isFinite(wanted)) fail('bad-deadline', 400);
      const deadline = Math.min(Math.trunc(wanted), at + limits.maxPageMs);
      const digest = canonicalJson([request.run, request.tool, args]);
      const prior = byRequest.get(request.requestId);
      if (prior) { if (prior.digest !== digest) fail('idempotency-conflict', 409); return prior.promise; }
      const promise = issue(request.run, { tool: request.tool, args, requestId: request.requestId, deadline, signal: request.signal ?? null,
        initiatorAccountId: request.initiatorAccountId, pageId: request.pageId });
      byRequest.set(request.requestId, { digest, promise });
      if (byRequest.size > 500) byRequest.delete(byRequest.keys().next().value);
      void promise.catch(() => {});
      return promise;
    } catch (error) { return Promise.reject(error); }
  }

  async function initiator(context) {
    const binding = await authority.current(context);
    return { initiatorAccountId: binding.accountId, pageId: binding.pageId, grantState: binding.grantState };
  }

  /** 这一轮结束或被叫停:在途的请求全部断掉(主服务据此把等待作废) */
  function cancelRun(scope) {
    let count = 0;
    for (const entry of [...inflight]) {
      if (scope && (entry.context.projectId !== scope.projectId || entry.context.conversationId !== scope.conversationId ||
          (scope.runId !== undefined && entry.context.runId !== scope.runId))) continue;
      entry.abort(); count += 1;
    }
    return count;
  }

  function close() {
    closed = true;
    const pending = cancelRun(null);
    return { childrenClosed: true, streamsClosed: true, workPending: pending ? 0 : 0 };
  }

  return Object.freeze({ requestPage, initiator, cancelRun, close, limits,
    extraTools: Object.freeze([...extra.keys()]), describe: () => ({ inflight: inflight.size, closed }) });
}
