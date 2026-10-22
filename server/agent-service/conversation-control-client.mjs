import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { certificateFingerprint, accountError } from '../account/client.mjs';
import { machineCode, machineFingerprint } from '../runners/machine-id.mjs';
import { openAccountLedger, canonicalJson } from '../account/ledger.mjs';
import { CONVERSATION_CONTROL_ROOT, conversationControlOperations, conversationControlScope } from '../account/agent-read-control.mjs';
import { createConversationTransports } from '../agent/service/conversation-transports.mjs';

const fail = code => { throw accountError(503, code); };
/**
 * 本地「已关读取」回执在文档服务确认关掉以后还留多久（毫秒）。
 *
 * 每次 HTTP 读取（列对话、开事件流、发消息后的读回）关掉时都在本地账本里记一行，原来一行都不删：
 * 2026-10-19 节点上这本账攒到 10.6 MB 的一段 JSON，每记一行都要整段解析、整段写回并落盘（约 0.25 秒 CPU 加一次 10 MB 的写），
 * 把主服务的事件循环占住，页面上列对话、发消息、取 info 一个个排着等 2～7 秒。
 * 这一行只在两种时候有用：文档服务的读取控制流点名要关它（`consume` 里的 `closeHandles` 要先在本地查到它），
 * 或重连后文档服务报它还开着（`ready`）。文档服务确认关掉以后不会再点名它；点名与确认在两条连接上，先后不定，
 * 所以确认以后再留一阵才删。别的实例（重启前的进程、旧的一代）的行这个实例永远用不上（`closeHandles` 按实例与代核对），直接删。
 */
export const CONFIRMED_CLOSE_KEEP_MS = 10 * 60_000;
/** 没交成的「前一个实例已经不在了」隔多久再交一次（毫秒）。只在还有没交成的前一个实例时才排。 */
export const HANDOVER_RETRY_MS = 2000;

/**
 * 〔裁〕H07：这个数据目录的独占锁。握着它的进程才登记读取、订阅读取控制、开读取；进程结束（含被硬杀）时操作系统放开它，
 * 正常收口时在全部读取关完以后才放开。所以下一个拿到锁的进程可以断定：此前在这个目录里报过的实例，进程都已经不在了
 * （或已经正常收口），它们名下的读取不可能再往页面写任何东西。
 *
 * 锁是一份 SQLite 文件上一直不提交的 `BEGIN EXCLUSIVE`（和文档服务的操作历史 `.owner` 同一个做法），在 Windows 和 Linux 上都是
 * 操作系统的文件锁。锁号存在同一份文件里，第一次建时生成、以后不变：文档服务据它核「两个实例握的是同一把锁」。
 * 锁号绑在这一份文件上（文件号与所在的卷）：整个目录被拷走另起一份时，拷出来的那份文件号不同，拿锁时换一个新锁号，
 * 于是拷出来的那份替不了原来那份里的实例交证据。
 * 拿不到（另一个活着的进程握着）就抛 `read-control-owner-busy`，调用方隔一会儿再试：活着的那个不会被顶替。
 */
export function acquireDataDirLock(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=0;');
    db.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(lock_id TEXT NOT NULL, file_id TEXT NOT NULL);');
    const stat = fs.statSync(file, { bigint: true }), fileId = `${stat.dev}:${stat.ino}`;
    const row = db.prepare('SELECT lock_id, file_id FROM owner').get();
    if (!row || row.file_id !== fileId) {
      db.exec('DELETE FROM owner');
      db.prepare('INSERT INTO owner VALUES(?, ?)').run(`lock_${randomUUID()}`, fileId);
    }
    db.exec('COMMIT; BEGIN EXCLUSIVE;');
    const lockId = db.prepare('SELECT lock_id FROM owner').get()?.lock_id;
    if (typeof lockId !== 'string' || !/^lock_[0-9a-f-]{36}$/.test(lockId)) throw accountError(503, 'read-control-owner-invalid');
    let released = false;
    return { lockId, release() { if (released) return; released = true; try { db.exec('ROLLBACK'); } catch { /* 已经不在事务里 */ } db.close(); } };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 没开成事务 */ }
    db.close();
    if (error?.code === 'read-control-owner-invalid') throw error;
    throw accountError(503, 'read-control-owner-busy');
  }
}
let thisMachine = null;
/** 这台机器的识别码（只是摘要，原始标识不出 `runners/machine-id.mjs`）。一个进程只算一次。 */
const machineOf = () => thisMachine ??= machineCode(machineFingerprint());
/** One OS instance, one actual pinned control connection. No human token or
 * delegation is persisted. Local receipts are produced by actual close only. */
export function createConversationControlClient({ origin, tls, serverFingerprint256, runClient,
  receiptFile, retryMs = 500, onDiagnostic = () => {}, now = Date.now, confirmedKeepMs = CONFIRMED_CLOSE_KEEP_MS,
  lockFile = receiptFile ? `${receiptFile}.owner` : null, handoverRetryMs = HANDOVER_RETRY_MS, machine = null } = {}) {
  const base = new URL(origin), pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin) ||
      typeof runClient?.conversationControlProofFor !== 'function') fail('read-control-configuration');
  let closed = false, store = null, stream = null, retry = null, starting = null, expectedSeq = 0, identity = null;
  let lock = null, leaseDeclared = false, handoverTimer = null, handovers = null;
  const requests = new Set(), work = new Map();
  const local = () => store.read().agentReadClosedV1 ?? {};
  /** 文档服务确认关掉的读取 → 确认的时刻（只在内存里；重启后是新实例，旧行整批按「别的实例」删） */
  const confirmed = new Map();
  const markConfirmed = ids => { const at = now(); for (const id of ids) confirmed.set(id, at); };
  function persistClosed(ids) {
    const cutoff = now() - confirmedKeepMs, dropped = [];
    store.transaction(state => {
      const rows = state.agentReadClosedV1 ??= {};
      for (const [readHandleId, row] of Object.entries(rows)) {
        const otherInstance = row?.instanceId !== identity.instanceId || row?.instanceGeneration !== identity.instanceGeneration;
        const at = confirmed.get(readHandleId);
        if (otherInstance || (at !== undefined && at <= cutoff)) { delete rows[readHandleId]; dropped.push(readHandleId); }
      }
      for (const readHandleId of ids) rows[readHandleId] ??= { readHandleId,
        instanceId: identity.instanceId, instanceGeneration: identity.instanceGeneration };
    });
    for (const id of dropped) confirmed.delete(id);
  }
  const transports = createConversationTransports({ instanceIdentity: () => identity,
    async onClosed(id) { if (!store || closed) return; persistClosed([id]); await closeHandles([id]); } });
  function request(action, input, { signal, frame } = {}) {
    if (closed || !identity) return Promise.reject(accountError(503, 'read-control-unavailable'));
    const body = { ...input, nonce: randomUUID() }, operation = conversationControlOperations[action];
    conversationControlScope(operation, body);
    const path = CONVERSATION_CONTROL_ROOT + action, encoded = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let socket, socketClosed = false, requestClosed = false, responseClosed = false, responseSeen = false,
        result, error, complete = false, settled = false;
      const finish = () => {
        if (settled || !complete || !(socket ? socketClosed : requestClosed) || (responseSeen && !responseClosed)) return;
        settled = true; signal?.removeEventListener('abort', abortSignal); error ? reject(error) : resolve(result);
      };
      const abort = reason => { if (frame) void transports.disconnect();
        error ??= reason; complete = true; req.destroy(); socket?.destroy(); finish(); };
      const abortSignal = () => abort(accountError(503, 'read-control-aborted'));
      const req = https.request(new URL(path, base), { method: 'POST', agent: false, key: tls.key, cert: tls.cert,
        ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', timeout: 5000,
        checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
          (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'read-control-server-certificate') : undefined); },
        headers: { 'content-type': 'application/json', 'content-length': encoded.length, connection: 'close' } }, res => {
        responseSeen = true;
        res.once('close', () => { responseClosed = true;
          if (!complete) abort(accountError(503, 'read-control-disconnected')); finish(); });
        res.on('error', () => abort(accountError(503, 'read-control-disconnected')));
        const chunks = []; let size = 0, pending = Buffer.alloc(0);
        res.on('data', chunk => {
          try {
            if (frame && res.statusCode === 200) {
              pending = Buffer.concat([pending, chunk]);
              if (pending.length > 1024 * 1024) fail('read-control-frame-too-large');
              for (;;) {
                const index = pending.indexOf(10); if (index < 0) break;
                const line = pending.subarray(0, index); pending = pending.subarray(index + 1);
                frame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
              }
            } else { size += chunk.length; if (size > 1024 * 1024) fail('read-control-response-too-large'); chunks.push(chunk); }
          } catch (e) { abort(e); }
        });
        res.on('end', () => {
          if (frame && res.statusCode === 200) return abort(accountError(503, 'read-control-disconnected'));
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode !== 200 || value?.ok !== true) error = accountError(res.statusCode ?? 503, value?.code ?? 'read-control-unavailable');
            else result = value.result;
          } catch { error = accountError(503, 'read-control-protocol'); }
          complete = true; finish();
        });
      });
      requests.add(req); req.once('close', () => { requests.delete(req); requestClosed = true; finish(); });
      req.on('error', e => abort(accountError(503, e.code === 'ECONNREFUSED' ? 'read-control-unavailable' : 'read-control-disconnected')));
      req.on('timeout', () => abort(accountError(503, 'read-control-timeout')));
      req.on('socket', current => {
        socket = current; current.once('close', () => { socketClosed = true; finish(); });
        current.once('secureConnect', () => {
          try { if (signal?.aborted || closed) return abortSignal();
            const proof = runClient.conversationControlProofFor({ socket: current, path, operation, body });
            req.setHeader(proof.name, proof.value); req.end(encoded);
          } catch (e) { abort(e); }
        });
      });
      signal?.addEventListener('abort', abortSignal, { once: true }); if (signal?.aborted) abortSignal();
    });
  }
  async function closeHandles(ids) {
    for (const id of ids) {
      const row = local()[id];
      if (!row || row.instanceId !== identity.instanceId || row.instanceGeneration !== identity.instanceGeneration)
        fail('read-resource-unknown');
    }
    const result = await request('close', { requestId: `close:${ids.join(':').slice(0, 180)}`, readHandleIds: ids });
    markConfirmed(ids);
    return result;
  }
  function consume(value) {
    if (value?.authorityId !== identity.authorityId) fail('read-control-authority-mismatch');
    if (value.type === 'control') {
      if (!Number.isSafeInteger(value.seq) || value.seq !== expectedSeq + 1 || !Array.isArray(value.readHandleIds)) fail('read-control-gap');
      expectedSeq = value.seq;
      if (!value.required) return;
      const key = value.controlId;
      if (work.has(key)) return;
      // fence() synchronously closes output before any Promise continuation.
      const unknown = value.readHandleIds.filter(id => !transports.hasClosed(id) && !local()[id]);
      const closing = transports.fence(unknown);
      const pending = (async () => {
        if (value.unknownInstance) fail('read-resource-unknown');
        await closing;
        persistClosed(unknown);
        await closeHandles(value.readHandleIds);
        const receipt = { requestId: `ack:${value.seq}`, controlId: value.controlId, payloadDigest: value.payloadDigest,
          seq: value.seq, readHandleIds: value.readHandleIds };
        store.transaction(state => { const rows = state.agentReadReceiptsV1 ??= {}, old = rows[key];
          if (old && canonicalJson(old) !== canonicalJson(receipt)) fail('read-control-receipt-mismatch'); rows[key] = receipt; });
        await request('ack', receipt);
      })();
      work.set(key, pending); void pending.catch(error => onDiagnostic({ code: error.code ?? 'read-control-pending' }))
        .finally(() => work.delete(key));
    } else if (value.type === 'ready') {
      if (value.instanceId !== identity.instanceId || value.instanceGeneration !== identity.instanceGeneration ||
          value.head !== expectedSeq || !Array.isArray(value.openReadHandleIds)) fail('read-control-ready-mismatch');
      // Old same-OS closed handles may have lost their close ACK. A new OS key
      // cannot acquire this instance or recycle those persisted receipts.
      for (const id of value.openReadHandleIds) if (local()[id]) void closeHandles([id]).catch(() => {});
      transports.ready();
    } else fail('read-control-frame-invalid');
  }
  /** 本地记一笔：这个实例在这把锁下跑过（握着锁才记）。下一个拿到锁的进程据此替它交「已经不在了」。 */
  function recordLease() {
    store.transaction(state => {
      const rows = state.agentInstanceLeasesV1 ??= {};
      rows[identity.instanceId] ??= { instanceId: identity.instanceId, instanceGeneration: identity.instanceGeneration, lockId: lock.lockId };
    });
  }
  /** 向文档服务报锁。旧的文档服务不认这个接口（404）：那就不报，以后也没人能替这个实例交证据，它名下的读取照旧只能等它自己关。 */
  async function declareLease() {
    if (leaseDeclared) return;
    try { await request('lease', { requestId: `lease:${identity.instanceId}`, lockId: lock.lockId, machine: machine ?? machineOf() }); }
    catch (error) { if (error.code !== 'read-control-no-route') throw error; onDiagnostic({ code: 'read-lease-unsupported' }); }
    leaseDeclared = true;
  }
  /** 本地记着的、不是本实例的那些：它们的进程已经不在了（锁在本进程手里），替它们交给文档服务。
   * 文档服务确认收口了、或明确说这一个永远收不了口（不认识、不是同一个身份、没报过锁），就删掉这一笔；
   * 它说那个实例还连着、或者暂时连不上，就留着，过一会儿再交。 */
  function handoverPredecessors() {
    if (handovers) return handovers;
    handovers = (async () => {
      const rows = Object.values(store.read().agentInstanceLeasesV1 ?? {})
        .filter(row => row.instanceId !== identity.instanceId && row.lockId === lock.lockId);
      let pending = 0;
      for (const row of rows) {
        let settled = false;
        try {
          await request('handover', { requestId: `handover:${row.instanceId}`, instanceId: row.instanceId, instanceGeneration: row.instanceGeneration });
          settled = true; onDiagnostic({ code: 'read-handover-done' });
        } catch (error) {
          settled = ['read-handover-unknown', 'read-handover-forbidden', 'read-handover-unproven', 'read-control-no-route'].includes(error.code);
          onDiagnostic({ code: error.code ?? 'read-handover-pending' });
        }
        if (settled) store.transaction(state => { delete state.agentInstanceLeasesV1?.[row.instanceId]; }); else pending += 1;
      }
      return pending;
    })().finally(() => { handovers = null; });
    void handovers.then(pending => {
      if (!pending || closed) return;
      clearTimeout(handoverTimer);
      handoverTimer = setTimeout(() => { if (!closed) void handoverPredecessors().catch(() => {}); }, handoverRetryMs);
      handoverTimer.unref?.();
    }, () => {});
    return handovers;
  }
  async function start() {
    if (closed) fail('read-control-closed');
    if (starting) return starting;
    starting = (async () => {
      // 先拿锁：拿到锁以前不登记读取、不订阅，于是不会有读取挂在一个「锁不在自己手里」的实例名下
      lock ??= acquireDataDirLock(lockFile);
      identity = await runClient.registerInstance();
      store ??= openAccountLedger({ file: receiptFile, authorityId: identity.authorityId });
      recordLease();
      await declareLease();
      await handoverPredecessors();
      expectedSeq = 0;
      stream = request('subscribe', { requestId: `subscribe_${randomUUID()}` }, { frame: consume });
      void stream.catch(error => onDiagnostic({ code: error.code ?? 'read-control-disconnected' })).finally(() => {
        void transports.disconnect(); stream = null;
        if (!closed) { retry = setTimeout(() => { void start().catch(() => {}); }, retryMs); retry.unref?.(); }
      });
    })().finally(() => { starting = null; });
    return starting;
  }
  return { start, transports,
    read(input) { return transports.read(({ requestId, signal }) => request('open', { ...input, requestId }, { signal })); },
    // 锁最后放：页面上的读取都关完了、本地账本也关了，下一个进程拿到锁时这个实例已经不可能再写任何东西
    async close() { closed = true; clearTimeout(retry); clearTimeout(handoverTimer); const draining = transports.close();
      for (const req of requests) req.destroy(); await Promise.allSettled([draining, stream, handovers, ...work.values()]);
      store?.close(); lock?.release(); },
    describe: () => ({ ...transports.describe(), executorMounted: false,
      localClosedReceipts: store ? Object.keys(local()).length : 0, confirmedClosedReceipts: confirmed.size }) };
}
