/** The hosted destination owns its private staging files and registration key.
 * Only the authenticated directory source can stream an exact prepared transaction.
 * No private bundle or registration key is returned to an editor page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { isProjectId, isDeviceId } from '../auth/protocol.mjs';
import { isRelocationId } from '../recovery/relocation.mjs';
import { receiveRelocationIndex, receiveRelocationFile, loadRelocationStage, installRelocationStage, activateRelocationStage, prepareRelocationSnapshot, relocationFileStream } from '../recovery/relocation-files.mjs';
import { startHostingHost, mirrorOf } from '../hosting/host.mjs';
import { requestRelocation } from '../hosting/relocation-client.mjs';
import { markRoomMoved } from '../recovery/relocation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refuse = reason => { throw Object.assign(new Error('Relocation destination rejected'), { reason }); };
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
export function createHostedRelocation({ paths, hosting, store, device, assets, reloadSpace, authenticate, docBaseOf, assetBaseOf }) {
  const root = path.join(paths.secrets, 'relocation'), workers = new Map(); let closing = false, timer;
  const fileOf = txnId => { if (!isRelocationId(txnId)) refuse('bad-relocation'); return path.join(root, `${txnId}.json`); };
  const read = txnId => {
    const meta = JSON.parse(fs.readFileSync(fileOf(txnId), 'utf8'));
    if (meta.version !== 1 || meta.txnId !== txnId || !isProjectId(meta.roomId) || !isDeviceId(meta.deviceId) || !/^[A-Za-z0-9_-]{43}$/.test(meta.registrationKey)) refuse('relocation-damaged');
    return meta;
  };
  const exact = (meta, view) => {
    if (view.move?.txnId !== meta.txnId || view.move.targetVerifier !== hash(meta.registrationKey) || view.move.target.where !== 'hosted'
      || view.move.target.service !== hosting.authorityService || view.move.targetDeviceId && view.move.targetDeviceId !== meta.deviceId) refuse('relocation-conflict');
    return { roomId: view.roomId, txnId: meta.txnId, epoch: view.move.targetEpoch, target: view.move.target, manifest: view.move.manifest };
  };
  function recover(meta) {
    if (meta.role === 'export') {
      const view = hosting.relocationView(meta.roomId);
      if (view.move?.txnId !== meta.txnId || view.move.sourceEpoch !== meta.sourceEpoch || !same(view.move.target, meta.target) || view.move.targetVerifier !== meta.targetVerifier) refuse('relocation-conflict');
      if (view.move.phase === 'committed') markRoomMoved({ store, roomId: meta.roomId, authority: view.location });
      return view.move.phase === 'committed';
    }
    const view = hosting.relocationView(meta.roomId); exact(meta, view);
    if (view.move.phase !== 'committed') return false;
    const stage = loadRelocationStage({ dataDir: paths.docservice, txnId: meta.txnId });
    activateRelocationStage({ stage, dataDir: paths.docservice, store, assets, authority: view.location });
    if (!closing && !workers.has(meta.txnId)) workers.set(meta.txnId, startHostingHost({ service: hosting.authorityService, roomId: meta.roomId, hostKey: meta.registrationKey,
      deviceId: meta.deviceId, instance: randomBytes(32).toString('base64url'), record: () => store.peek(meta.roomId), docBase: docBaseOf(), assetBase: assetBaseOf(), state: () => {} }));
    return true;
  }
  async function sourceHost(roomId) {
    if (fs.existsSync(root)) for (const file of fs.readdirSync(root)) {
      if (!/^move_[a-f0-9]{32}\.json$/.test(file)) continue;
      const meta = read(file.slice(0, -5));
      if (meta.roomId === roomId && meta.role !== 'export' && hosting.relocationSourceAllowed(meta)) return meta.registrationKey;
    }
    // A natively hosted room has no LAN registration to recover. Enrol the actual cloud
    // service with its own private authority; never invent another project or password.
    const file = path.join(paths.secrets, 'hosting-rooms', `${roomId}.json`); let record;
    if (fs.existsSync(file)) record = JSON.parse(fs.readFileSync(file, 'utf8'));
    else { record = { roomId, deviceId: device.deviceId, registrationKey: randomBytes(32).toString('base64url') }; write(file, record); }
    if (record.roomId !== roomId || record.deviceId !== device.deviceId || !/^[A-Za-z0-9_-]{43}$/.test(record.registrationKey)) refuse('relocation-damaged');
    const rec = store.peek(roomId);
    const response = await fetch(`${hosting.authorityService}/hosting/register`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.registrationKey}` },
      body: JSON.stringify({ roomId, deviceId: device.deviceId, instance: randomBytes(32).toString('base64url'), hostingEpoch: rec.hostingEpoch ?? 1, mirror: mirrorOf(rec) }) });
    if (!response.ok) { const body = await response.json(); refuse(body.error ?? 'host-auth'); }
    return record.registrationKey;
  }
  function sweep() {
    if (closing) return;
    if (fs.existsSync(root)) for (const file of fs.readdirSync(root)) {
      if (!/^move_[a-f0-9]{32}\.json$/.test(file)) continue;
      try { recover(read(file.slice(0, -5))); } catch { /* Preserve stage; an authenticated explicit retry reports the fixed reason. */ }
    }
    timer = setTimeout(sweep, 1000); timer.unref();
  }
  const reply = (res, status, result) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result)); };
  async function exportRun(req, res) {
    const u = new URL(req.url, 'http://localhost'), operation = u.pathname.slice('/hosting/relocation/export-'.length);
    try {
      if (!['start', 'index', 'file', 'publish'].includes(operation) || (operation === 'file' || operation === 'index' ? req.method !== 'GET' : req.method !== 'POST')) return reply(res, 404, { ok: false, error: 'no-endpoint' });
      let body;
      if (req.method === 'GET') body = { roomId: u.searchParams.get('roomId'), txnId: u.searchParams.get('txnId') };
      else { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) refuse('too-large'); } body = JSON.parse(raw); }
      if (!isProjectId(body.roomId) || !isRelocationId(body.txnId)) refuse('bad-relocation');
      const capability = operation === 'start' ? body.sourceCapability : /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (!/^[A-Za-z0-9_-]{43}$/.test(capability ?? '')) return reply(res, 401, { ok: false, error: 'auth' });
      let meta = fs.existsSync(fileOf(body.txnId)) ? read(body.txnId) : null;
      if (meta) {
        if (meta.role !== 'export' || meta.roomId !== body.roomId || meta.sourceCapabilityDigest !== hash(capability)) return reply(res, 401, { ok: false, error: 'auth' });
      } else {
        if (operation !== 'start') return reply(res, 401, { ok: false, error: 'auth' });
        const protocols = body.protocols;
        if (!Array.isArray(protocols) || protocols.length > 8 || !protocols.every(p => typeof p === 'string' && p.length < 4096 && !p.includes(','))) return reply(res, 401, { ok: false, error: 'auth' });
        const principal = authenticate({ method: req.method, url: req.url, socket: req.socket, headers: { ...req.headers, 'sec-websocket-protocol': protocols.join(', ') } });
        if (!principal || principal.scope !== 'member' || principal.tenantId !== body.roomId) return reply(res, 401, { ok: false, error: 'auth' });
        if (!same(body.target, { service: hosting.authorityService, where: 'lan', deviceId: principal.deviceId }) || !/^[a-f0-9]{64}$/.test(body.targetVerifier ?? '')) refuse('relocation-conflict');
        const rec = store.peek(body.roomId), registrationKey = await sourceHost(body.roomId);
        meta = { version: 1, role: 'export', roomId: body.roomId, txnId: body.txnId, deviceId: device.deviceId, registrationKey,
          sourceCapabilityDigest: hash(capability), sourceEpoch: rec.hostingEpoch ?? 1, target: body.target, targetVerifier: body.targetVerifier };
        write(fileOf(body.txnId), meta);
      }
      if (operation === 'start') {
        if (!same(body.target, meta.target) || body.targetVerifier !== meta.targetVerifier) refuse('relocation-conflict');
        const rec = store.peek(meta.roomId);
        let snapshot;
        if (rec.relocation?.phase === 'moved' && rec.relocation.txnId === meta.txnId) snapshot = loadRelocationStage({ dataDir: paths.docservice, txnId: meta.txnId });
        else snapshot = prepareRelocationSnapshot({ dataDir: paths.docservice, store, roomId: meta.roomId, txnId: meta.txnId, expectedEpoch: meta.sourceEpoch, target: meta.target, assets });
        const result = await requestRelocation({ service: hosting.authorityService, trustedService: hosting.authorityService, operation: 'begin',
          body: { roomId: meta.roomId, txnId: meta.txnId, expectedEpoch: meta.sourceEpoch, target: meta.target, targetVerifier: meta.targetVerifier, manifest: snapshot.index.manifest }, registrationKey: meta.registrationKey });
        return reply(res, 200, { ok: true, roomId: meta.roomId, txnId: meta.txnId, epoch: meta.sourceEpoch + 1, target: meta.target, manifest: snapshot.index.manifest, phase: result.move.phase });
      }
      const view = hosting.relocationView(meta.roomId);
      if (view.move?.txnId !== meta.txnId || view.move.sourceEpoch !== meta.sourceEpoch || !same(view.move.target, meta.target) || view.move.targetVerifier !== meta.targetVerifier) refuse('relocation-conflict');
      const snapshot = loadRelocationStage({ dataDir: paths.docservice, txnId: meta.txnId });
      if (operation === 'index') return reply(res, 200, { ok: true, roomId: meta.roomId, txnId: meta.txnId, index: snapshot.index });
      if (operation === 'file') {
        const relative = u.searchParams.get('path'), stream = relocationFileStream({ snapshot, relative }), entry = snapshot.index.entries.find(e => e.path === relative);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.size, 'cache-control': 'no-store' }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
      }
      const published = await requestRelocation({ service: hosting.authorityService, trustedService: hosting.authorityService, operation: 'publish',
        body: { roomId: meta.roomId, txnId: meta.txnId, expectedEpoch: meta.sourceEpoch, target: meta.target, targetVerifier: meta.targetVerifier, manifest: snapshot.index.manifest }, registrationKey: meta.registrationKey });
      markRoomMoved({ store, roomId: meta.roomId, authority: published.location });
      reply(res, 200, { ok: true, ...published.location });
    } catch (e) { reply(res, e.reason === 'deleted' ? 410 : e.reason ? 409 : 503, { ok: false, error: e.reason ?? 'relocation-storage', ...(e.missingCount ? { missingCount: e.missingCount } : {}) }); }
  }
  async function run(req, res) {
    const u = new URL(req.url, 'http://localhost'), operation = u.pathname.slice('/hosting/relocation/import-'.length);
    try {
      if (!['init', 'index', 'file', 'complete', 'activate'].includes(operation) || (operation === 'file' ? req.method !== 'PUT' : req.method !== 'POST')) return reply(res, 404, { ok: false, error: 'no-endpoint' });
      let body;
      if (operation === 'file') body = { roomId: u.searchParams.get('roomId'), txnId: u.searchParams.get('txnId') };
      else { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 64 * 1024 * 1024) refuse('too-large'); } body = JSON.parse(text); }
      if (!isProjectId(body.roomId) || !isRelocationId(body.txnId)) refuse('bad-relocation');
      const registrationKey = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (!hosting.relocationSourceAllowed({ ...body, registrationKey })) return reply(res, 403, { ok: false, error: 'host-auth' });
      if (operation === 'init') {
        if (!same(body.target, { service: hosting.authorityService, where: 'hosted', deviceId: null })) refuse('relocation-conflict');
        const file = fileOf(body.txnId); let meta;
        if (fs.existsSync(file)) meta = read(body.txnId);
        else { meta = { version: 1, roomId: body.roomId, txnId: body.txnId, deviceId: device.deviceId, registrationKey: randomBytes(32).toString('base64url') }; write(file, meta); }
        if (meta.roomId !== body.roomId) refuse('relocation-conflict');
        return reply(res, 200, { ok: true, roomId: meta.roomId, txnId: meta.txnId, deviceId: meta.deviceId, targetVerifier: hash(meta.registrationKey) });
      }
      const meta = read(body.txnId); if (meta.roomId !== body.roomId) refuse('relocation-conflict');
      const view = hosting.relocationView(body.roomId), authority = exact(meta, view);
      if (operation === 'index' || operation === 'file') {
        if (view.move.phase !== 'prepared') refuse('relocation-conflict');
        if (operation === 'index') receiveRelocationIndex({ dataDir: paths.docservice, index: body.index, authority });
        else await receiveRelocationFile({ dataDir: paths.docservice, txnId: body.txnId, relative: u.searchParams.get('path'), stream: req });
      } else if (operation === 'complete') {
        if (view.move.phase === 'committed') recover(meta);
        else {
          const stage = loadRelocationStage({ dataDir: paths.docservice, txnId: meta.txnId });
          const installed = installRelocationStage({ stage, dataDir: paths.docservice, store, assets, reloadSpace });
          hosting.relocationReady({ ...installed, deviceId: meta.deviceId }, meta.registrationKey);
        }
      } else if (!recover(meta)) refuse('relocation-not-ready');
      reply(res, 200, { ok: true, ...authority, phase: hosting.relocationView(body.roomId).move.phase });
    } catch (e) {
      reply(res, e.reason === 'deleted' ? 410 : e.reason ? 409 : 503, { ok: false, error: e.reason ?? 'relocation-storage' });
    }
  }
  return {
    handle(req, res) { const p = new URL(req.url, 'http://localhost').pathname;
      if (p.startsWith('/hosting/relocation/export-')) { void exportRun(req, res); return true; }
      if (!p.startsWith('/hosting/relocation/import-')) return false; void run(req, res); return true; },
    start() { sweep(); },
    async close() { closing = true; clearTimeout(timer); await Promise.all([...workers.values()].map(worker => worker.stop())); workers.clear(); },
  };
}
