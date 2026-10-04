import fs from 'node:fs';
import path from 'node:path';
import { openRecoveryVault, recoveryStorageFailure } from './vault.mjs';
import { parseCollaboration } from './descriptor.mjs';
import { fileNameOf } from '../docservice/store/index.mjs';
import { fromLocalClient, guard } from '../http-guard.mjs';
import { randomBytes } from 'node:crypto';
import { startHostingHost } from '../hosting/host.mjs';
import { roomUnavailableReason } from './relocation.mjs';
import { prepareRelocationSnapshot } from './relocation-files.mjs';
import { transferRelocationToHosted } from './relocation-transfer.mjs';
import { pullRelocationToLocal } from './relocation-pull.mjs';

/** Local-only identity API. Its root and protection backend are owned by the app. */
export function recoveryHttp({ dir, dataDir, store, device, baseOf, assetBaseOf, assets, reloadSpace, onClose }) {
  let vault;
  const hosts = new Map();
  const tasks = new Map();
  const moves = new Map(); const moveAbort = new AbortController(); let moveTimer;
  const instance = randomBytes(32).toString('base64url');
  const getVault = () => vault ??= openRecoveryVault({ dir });
  let closing = false, unregisterTimer, unregisterBusy = false;
  async function flushUnregister() {
    if (closing || unregisterBusy) return;
    unregisterBusy = true;
    try {
      for (const item of getVault().pendingUnregister()) {
        if (closing) break;
        try {
          const r = await fetch(`${item.descriptor.service}/hosting/unregister`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${item.registrationKey}` }, body: JSON.stringify({ roomId: item.descriptor.roomId, deleted: true }) });
          if (r.ok || [404,410].includes(r.status)) getVault().completeUnregister(item.descriptor);
        } catch { /* The protected tombstone survives process exit; never re-register this room. */ }
      }
    } catch { /* Reading damage is reported by the local recovery API, never overwritten. */ }
    finally { unregisterBusy = false; if (!closing) { unregisterTimer = setTimeout(flushUnregister, 30000); unregisterTimer.unref(); } }
  }
  unregisterTimer = setTimeout(flushUnregister, 0); unregisterTimer.unref();
  const hostId = d => JSON.stringify([d.service, d.roomId]);
  function activate(descriptor, owner) {
    const id = hostId(descriptor);
    if (hosts.has(id)) { const entry = hosts.get(id); entry.owners.add(owner); return entry; }
    const h = getVault().host(descriptor);
    if (!h || h.deviceId !== device.deviceId || descriptor.where !== 'lan') throw new Error('not-original-host');
    const entry = { state: 'pending', worker: null, owners: new Set([owner]) };
    entry.worker = startHostingHost({ service: descriptor.service, roomId: descriptor.roomId,
      hostKey: h.registrationKey, deviceId: device.deviceId, instance,
      record: () => store?.peek(descriptor.roomId), docBase: baseOf(), assetBase: assetBaseOf?.() ?? baseOf().replace(/\/docservice$/, ''),
      state: state => { entry.state = state; } });
    hosts.set(id, entry); return entry;
  }
  function startMove(descriptor, txnId) {
    const prior = moves.get(descriptor.roomId);
    if (prior?.running || prior?.txnId === txnId && (prior.state === 'complete' || prior.terminal || prior.retryAt > Date.now())) return prior;
    const h = getVault().host(descriptor);
    if (!h || h.deviceId !== device.deviceId || !assets) throw Object.assign(new Error('Source host required'), { reason: 'not-original-host' });
    const rec = store.peek(descriptor.roomId), target = { service: descriptor.service, where: 'hosted', deviceId: null };
    const snapshot = prepareRelocationSnapshot({ dataDir, store, roomId: descriptor.roomId, txnId, expectedEpoch: rec.relocation?.epoch ?? rec.hostingEpoch ?? 1, target, assets });
    const move = { state: 'moving', txnId, running: true, delay: prior?.delay ?? 500, retryAt: 0, terminal: false, error: null };
    moves.set(descriptor.roomId, move);
    const entry = hosts.get(hostId(descriptor)); hosts.delete(hostId(descriptor)); void entry?.worker.stop();
    void transferRelocationToHosted({ snapshot, service: descriptor.service, trustedService: descriptor.service, registrationKey: h.registrationKey, store, signal: moveAbort.signal }).then(() => {
      move.state = 'complete'; move.error = null;
    }, error => {
      move.state = 'waiting'; move.error = error.reason ?? 'relocation-network';
      move.terminal = !error.retryable && !['relocation-network', 'relocation-storage', 'cancelled'].includes(move.error);
      move.retryAt = Date.now() + move.delay; move.delay = Math.min(30000, move.delay * 2);
    }).finally(() => { move.running = false; });
    return move;
  }
  function startLocalMove(pending) {
    const prior = moves.get(pending.descriptor.roomId);
    if (prior?.running || prior?.txnId === pending.txnId && (prior.state === 'complete' || prior.terminal || prior.retryAt > Date.now())) return prior;
    if (pending.deviceId !== device.deviceId || !pending.record || !assets) throw Object.assign(new Error('Destination identity required'), { reason: 'auth' });
    const move = { state: 'moving', txnId: pending.txnId, running: true, delay: prior?.delay ?? 500, retryAt: 0, terminal: false, error: null };
    moves.set(pending.descriptor.roomId, move);
    void pullRelocationToLocal({ dataDir, store, assets, reloadSpace, move: pending, identity: pending.record, device, signal: moveAbort.signal,
      current: () => getVault().pendingLocalMoves().some(item => item.txnId === pending.txnId && !!item.record) }).then(authority => {
      getVault().completeLocalMove(pending, authority, baseOf()); move.state = 'complete'; move.error = null;
    }).catch(error => {
      move.state = 'waiting'; move.error = error.reason ?? 'relocation-storage';
      move.terminal = !error.retryable && !['relocation-network', 'relocation-storage', 'cancelled', 'recovery-storage-busy'].includes(move.error);
      move.retryAt = Date.now() + move.delay; move.delay = Math.min(30000, move.delay * 2);
    }).finally(() => { move.running = false; });
    return move;
  }
  function resumeMoves() {
    if (closing) return;
    if (store && assets) for (const item of store.list()) {
      const rec = store.peek(item.projectId), move = rec?.relocation;
      if (move?.phase !== 'frozen' || move.target?.where !== 'hosted') continue;
      try { startMove({ version: 1, roomId: rec.projectId, service: move.target.service, where: 'lan' }, move.txnId); } catch { /* Keep the durable source restriction; explicit status returns the cause. */ }
    }
    if (store && assets) try { for (const pending of getVault().pendingLocalMoves()) startLocalMove(pending); } catch { /* Preserve protected jobs; no empty replacement. */ }
    moveTimer = setTimeout(resumeMoves, 1000); moveTimer.unref();
  }
  moveTimer = setTimeout(resumeMoves, 0); moveTimer.unref();
  onClose?.(() => { closing = true; moveAbort.abort(); clearTimeout(moveTimer); clearTimeout(unregisterTimer); for (const entry of hosts.values()) void entry.worker.stop(); hosts.clear(); });
  const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  return async (req, res, next) => {
    const p = String(req.url).split('?')[0];
    if (!p.startsWith('/api/collaboration/')) return next();
    if (!fromLocalClient(req) || !guard(req, res)) { if (!res.headersSent) reply(res, 403, { ok: false, error: 'forbidden' }); return; }
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' });
    const began = Date.now(); let recoveryPhase = 'body-parse';
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024 * 1024) return reply(res, 413, { ok: false, error: 'too-large' }); }
      const body = JSON.parse(raw); recoveryPhase = 'descriptor-parse'; const descriptor = parseCollaboration(body.descriptor);
      if (!descriptor || descriptor.version !== 1) return reply(res, 400, { ok: false, error: 'unsupported' });
      recoveryPhase = 'vault-open'; const v = getVault(); recoveryPhase = 'vault-operation';
      const task = typeof body.task === 'string' && body.task.length <= 128 ? body.task : null;
      const version = Number.isSafeInteger(body.taskVersion) && body.taskVersion >= 0 ? body.taskVersion : null;
      if (p.endsWith('/cancel-host') || p.endsWith('/activate-host') || p.endsWith('/restore-host') || p.endsWith('/move-hosted') || p.endsWith('/move-lan')) {
        if (!task || version === null) return reply(res, 400, { ok: false, error: 'bad-task' });
        if ((tasks.get(task) ?? -1) > version) return reply(res, 409, { ok: false, error: 'cancelled' });
        tasks.set(task, version);
      }
      if (p.endsWith('/cancel-host')) {
        const entry = hosts.get(hostId(descriptor));
        entry?.owners.delete(task);
        if (entry && !entry.owners.size) { hosts.delete(hostId(descriptor)); await entry.worker.stop(); }
        return reply(res, 200, { ok: true });
      }
      if (p.endsWith('/settings-read')) return reply(res, 200, { ok: true, settings: v.settings(descriptor) });
      if (p.endsWith('/move-lan') || p.endsWith('/move-lan-status')) {
        if (descriptor.where !== 'hosted' || !store || !assets) return reply(res, 409, { ok: false, error: 'not-ready' });
        try {
          let pending = v.pendingLocalMoves().find(item => item.descriptor.roomId === descriptor.roomId && item.descriptor.service === descriptor.service);
          if (!pending && p.endsWith('/move-lan')) {
            v.beginLocalMove(descriptor, device.deviceId, body.contentId); pending = v.pendingLocalMoves().find(item => item.descriptor.roomId === descriptor.roomId && item.descriptor.service === descriptor.service);
          }
          if (p.endsWith('/move-lan') && pending && moves.get(descriptor.roomId)?.terminal) { moves.get(descriptor.roomId).terminal = false; moves.get(descriptor.roomId).retryAt = 0; }
          const move = pending ? startLocalMove(pending) : moves.get(descriptor.roomId);
          return reply(res, 200, { ok: true, state: move?.state ?? 'idle', terminal: move?.terminal ?? false, error: move?.error ?? null, descriptor: { ...descriptor, where: 'lan', hint: baseOf() } });
        } catch (e) { return reply(res, 409, { ok: false, error: e.reason ?? 'relocation-storage' }); }
      }
      if (p.endsWith('/move-hosted') || p.endsWith('/move-status')) {
        if (descriptor.where !== 'lan') return reply(res, 409, { ok: false, error: 'not-original-host' });
        const h = v.host(descriptor);
        if (!h || h.deviceId !== device.deviceId) return reply(res, 403, { ok: false, error: 'not-original-host' });
        const rec = store?.peek(descriptor.roomId);
        if (!rec) return reply(res, 409, { ok: false, error: 'host-data-missing' });
        const unavailable = roomUnavailableReason(rec);
        if (unavailable === 'relocated') return reply(res, 200, { ok: true, state: 'complete', descriptor: { ...descriptor, where: rec.relocation.target.where } });
        try {
          let move = moves.get(descriptor.roomId);
          if (p.endsWith('/move-hosted')) move = startMove(descriptor, rec.relocation?.txnId ?? `move_${randomBytes(16).toString('hex')}`);
          return reply(res, 200, { ok: true, state: move?.state ?? (unavailable ? 'waiting' : 'idle'), error: move?.error ?? null,
            terminal: move?.terminal ?? false, descriptor: { ...descriptor, where: 'hosted' } });
        } catch (e) { return reply(res, 409, { ok: false, error: e.reason ?? 'relocation-storage', ...(e.missingCount ? { missingCount: e.missingCount } : {}) }); }
      }
      if (p.endsWith('/settings-write')) { if (body.settings?.projectId !== descriptor.roomId) return reply(res, 400, { ok: false, error: 'bad-settings' }); v.saveSettings(descriptor, body.settings); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/journal')) { v.journal(descriptor, body.contentId, body.journal); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/identity')) { v.remember({ ...body.record, service: descriptor.service, roomId: descriptor.roomId }, body.contentId); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/select')) { const selected = v.select(descriptor, body.contentId); if (selected.host) selected.host = { deviceId: selected.host.deviceId };
        const pending = v.pendingLocalMoves().find(item => item.descriptor.roomId === descriptor.roomId && item.descriptor.service === descriptor.service);
        const active = moves.get(descriptor.roomId);
        const move = pending && active?.txnId !== pending.txnId ? { state: 'moving', terminal: false, error: null } : active;
        return reply(res, 200, { ok: true, ...selected, settings: v.settings(descriptor), protection: v.protection,
          recoveryMove: move ? { state: move.state, terminal: move.terminal, error: move.error } : null }); }
      if (p.endsWith('/revoke')) { const entry = hosts.get(hostId(descriptor)); v.revoke(descriptor); await entry?.worker.stop({ deleted: true }); hosts.delete(hostId(descriptor)); clearTimeout(unregisterTimer); void flushUnregister(); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/host-state')) return reply(res, 200, { ok: true, state: hosts.get(hostId(descriptor))?.state ?? 'inactive' });
      if (p.endsWith('/host-update')) { await hosts.get(hostId(descriptor))?.worker.update(); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/activate-host')) {
        if (!store?.peek(descriptor.roomId) || descriptor.where !== 'lan') return reply(res, 404, { ok: false, error: 'no-project' });
        const unavailable = roomUnavailableReason(store.peek(descriptor.roomId));
        if (unavailable) return reply(res, 409, { ok: false, error: unavailable });
        v.bindHost(descriptor, device.deviceId); activate(descriptor, task); return reply(res, 200, { ok: true });
      }
      if (p.endsWith('/restore-host')) {
        const h = v.host(descriptor);
        if (!h || h.deviceId !== device.deviceId) return reply(res, 403, { ok: false, error: 'not-original-host' });
        const rec = store?.peek(descriptor.roomId);
        if (!rec) return reply(res, 409, { ok: false, error: 'host-data-missing' });
        const unavailable = roomUnavailableReason(rec);
        if (unavailable) return reply(res, 409, { ok: false, error: unavailable });
        const projects = path.join(dataDir, 'tenants', descriptor.roomId, 'projects');
        if (!fs.existsSync(path.join(projects, `${fileNameOf(descriptor.roomId)}.ops.ndjson`))) return reply(res, 409, { ok: false, error: 'host-data-missing' });
        return reply(res, 200, { ok: true, candidate: { where: 'lan', projectId: rec.projectId, name: rec.name, mode: rec.mode, base: baseOf(), service: descriptor.service, hostDeviceName: device.deviceName, originalHost: true } });
      }
      reply(res, 404, { ok: false, error: 'no-endpoint' });
    } catch (e) {
      // Fixed categories only: never send paths, messages, stacks, project data or protected bytes.
      const failure = recoveryStorageFailure(e), retryable = failure.error === 'recovery-storage-busy';
      reply(res, 503, { ok: false, error: failure.error, ...(retryable ? { retryAfter: 1 } : {}), storageDiagnostic: {
        phase: recoveryPhase, storagePhase: failure.storagePhase, code: failure.code,
        elapsedMs: Date.now() - began,
      }, message: retryable ? '协作恢复信息暂时无法读取或保存；原数据已保留，将自动重试。' : '无法可靠读取或保存协作恢复信息；原数据已保留，请从备份恢复或重新认证。' });
    }
  };
}
