/** The hosted destination owns its private staging files and registration key.
 * Only the authenticated directory source can stream an exact prepared transaction.
 * No private bundle or registration key is returned to an editor page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { isProjectId, isDeviceId } from '../auth/protocol.mjs';
import { isRelocationId } from '../recovery/relocation.mjs';
import { receiveRelocationIndex, receiveRelocationFile, loadRelocationStage, installRelocationStage, activateRelocationStage } from '../recovery/relocation-files.mjs';
import { startHostingHost } from '../hosting/host.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refuse = reason => { throw Object.assign(new Error('Relocation destination rejected'), { reason }); };
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
export function createHostedRelocation({ paths, hosting, store, device, assets, reloadSpace, docBaseOf, assetBaseOf }) {
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
    const view = hosting.relocationView(meta.roomId); exact(meta, view);
    if (view.move.phase !== 'committed') return false;
    const stage = loadRelocationStage({ dataDir: paths.docservice, txnId: meta.txnId });
    activateRelocationStage({ stage, dataDir: paths.docservice, store, assets, authority: view.location });
    if (!closing && !workers.has(meta.txnId)) workers.set(meta.txnId, startHostingHost({ service: hosting.authorityService, roomId: meta.roomId, hostKey: meta.registrationKey,
      deviceId: meta.deviceId, instance: randomBytes(32).toString('base64url'), record: () => store.peek(meta.roomId), docBase: docBaseOf(), assetBase: assetBaseOf(), state: () => {} }));
    return true;
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
    handle(req, res) { if (!new URL(req.url, 'http://localhost').pathname.startsWith('/hosting/relocation/import-')) return false; void run(req, res); return true; },
    start() { sweep(); },
    async close() { closing = true; clearTimeout(timer); await Promise.all([...workers.values()].map(worker => worker.stop())); workers.clear(); },
  };
}
