/** Server-internal relocation snapshots. Paths come from the running service, never a .proc.
 * Complete immutable assets and the entire tenant (content, revisions, costs and events) move.
 * Staging remains inaccessible; source data and prior destination data are retained.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createFileStore } from '../docservice/store/index.mjs';
import { projectModule } from '../docservice/modules/project.mjs';
import { isProjectId } from '../auth/protocol.mjs';
import { freezeRoom, isRelocationId, relocationTarget, relocationManifest, roomUnavailableReason } from './relocation.mjs';

const namespaces = ['media', 'snap', 'px'];
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reject = reason => { throw Object.assign(new Error('Relocation data rejected'), { reason }); };
const order = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function fileAt(root, relative) {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.split('/').some(s => !/^[A-Za-z0-9._@%-]{1,512}$/.test(s) || /^\.+$/.test(s))) reject('bad-relocation-path');
  const base = path.resolve(root), file = path.resolve(base, ...relative.split('/'));
  if (!file.startsWith(base + path.sep)) reject('bad-relocation-path');
  for (let dir = file; ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) reject('relocation-link');
    if (dir === base) break;
  }
  return file;
}
function fileHash(file) {
  const fd = fs.openSync(file, 'r'), h = createHash('sha256'), buffer = Buffer.alloc(128 * 1024);
  try { let read; while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) h.update(buffer.subarray(0, read)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function copyChecked(source, destination, digest) {
  if (!fs.statSync(source).isFile() || fileHash(source) !== digest) reject('relocation-data-changed');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`; fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fileHash(temp) !== digest) reject('relocation-data-changed'); fs.renameSync(temp, destination);
}
function tree(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  if (fs.lstatSync(root).isSymbolicLink()) reject('relocation-link');
  const entries = [];
  for (const name of fs.readdirSync(root)) {
    if (name.includes('.tmp-')) continue;
    const relative = prefix + name, file = fileAt(root, name), st = fs.lstatSync(file);
    if (st.isSymbolicLink()) reject('relocation-link');
    if (st.isDirectory()) entries.push(...tree(file, relative + '/'));
    else if (st.isFile()) entries.push({ path: relative, size: st.size, digest: fileHash(file) });
    else reject('relocation-link');
  }
  return entries.sort(order);
}
function sourceFile(index, entry, dataDir, assets) {
  if (entry.path.startsWith('doc/')) return fileAt(path.join(dataDir, 'tenants', index.roomId), entry.path.slice(4));
  const [, ns, file] = entry.path.split('/'), spec = assets[ns];
  return fileAt(spec.root, spec.shard ? `${file.slice(0, 2)}/${file}` : file);
}
function validateIndex(index) {
  if (!index || index.version !== 1 || !isProjectId(index.roomId) || !isRelocationId(index.txnId)
    || !Number.isSafeInteger(index.epoch) || index.epoch < 1 || !relocationTarget(index.target) || !relocationManifest(index.manifest)
    || index.record?.projectId !== index.roomId || !Array.isArray(index.entries) || index.entries.length > 100000) reject('bad-relocation-data');
  const seen = new Set();
  for (const e of index.entries) {
    if (!e || !/^doc\/[^\\]+$|^assets\/(?:media|snap|px)\/[a-f0-9]{64}(?:\.[a-z0-9]{1,32})?$/.test(e.path)
      || !Number.isSafeInteger(e.size) || e.size < 0 || !/^[a-f0-9]{64}$/.test(e.digest)) reject('bad-relocation-data');
    fileAt('.', e.path); const key = e.path.toLowerCase(); if (seen.has(key)) reject('bad-relocation-data'); seen.add(key);
    if (e.path.startsWith('assets/') && e.path.split('/')[2].slice(0, 64) !== e.digest) reject('relocation-asset-damaged');
  }
  if (!same(index.entries, [...index.entries].sort(order)) || jsonHash({ record: index.record, files: index.entries.filter(e => e.path.startsWith('doc/')) }) !== index.manifest.logDigest
    || jsonHash(index.entries.filter(e => e.path.startsWith('assets/'))) !== index.manifest.assetDigest) reject('relocation-data-changed');
  return index;
}
function requiredAssets(project) {
  const required = new Set();
  const add = (ns, value) => { if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) required.add(`${ns}/${value}`); };
  for (const media of project?.media ?? []) {
    add('media', media.hash); add('media', media.tiers?.original); add('media', media.tiers?.small);
  }
  // Recognize explicit CAS URLs only; arbitrary content keys are not asset hashes.
  const visit = value => {
    if (typeof value === 'string') {
      const m = /(?:^|\/)@?(media|snap|px)\/([a-f0-9]{64})(?:[.?/#]|$)/.exec(value);
      if (m) add(m[1], m[2]);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(project); return required;
}
export function prepareRelocationSnapshot({ dataDir, store, roomId, txnId, expectedEpoch, target, assets }) {
  if (!isProjectId(roomId) || !isRelocationId(txnId) || !relocationTarget(target)) reject('bad-relocation');
  const root = path.join(dataDir, 'relocation', txnId), indexFile = fileAt(root, 'index.json'), rec = store.peek(roomId);
  if (!rec) reject('no-project');
  const unavailable = roomUnavailableReason(rec); let index;
  if (unavailable) {
    if (unavailable !== 'relocating' || rec.relocation.txnId !== txnId || !fs.existsSync(indexFile)) reject(unavailable);
    index = validateIndex(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
    if (!same(index.target, target) || index.epoch !== expectedEpoch || !same(index.manifest, rec.relocation.manifest)) reject('relocation-conflict');
  } else {
    const tenant = path.join(dataDir, 'tenants', roomId), diagnostics = [];
    const log = event => diagnostics.push(event);
    const project = projectModule({ store: createFileStore({ dir: tenant, log }), log });
    const rev = project.revOf(roomId);
    if (rev < 1 || !project.describe().projects.find(p => p.projectId === roomId)?.hasBody || diagnostics.length) reject('host-data-missing');
    const record = structuredClone(rec); delete record.relocation; delete record.relocationActivation;
    if (record.invite) record.inviteDigestSecret ??= Buffer.from(store.serverSecret).toString('base64url');
    const entries = tree(tenant).map(e => ({ ...e, path: 'doc/' + e.path }));
    for (const ns of namespaces) {
      const spec = assets[ns]; if (!spec?.root) reject('relocation-assets-unavailable');
      for (const entry of tree(spec.root)) {
        const parts = entry.path.split('/'), file = parts.at(-1);
        if (!/^[a-f0-9]{64}(?:\.[a-z0-9]{1,32})?$/.test(file)) continue;
        if (spec.shard ? parts.length !== 2 || parts[0] !== file.slice(0, 2) : parts.length !== 1) continue;
        if (entry.digest !== file.slice(0, 64)) reject('relocation-asset-damaged');
        entries.push({ ...entry, path: `assets/${ns}/${file}` });
      }
    }
    const available = new Set(entries.filter(e => e.path.startsWith('assets/')).map(e => e.path.slice(7).split('.')[0]));
    const missing = [...requiredAssets(project.bodyOf(roomId))].filter(ref => !available.has(ref));
    if (missing.length) throw Object.assign(new Error('Relocation materials incomplete'), { reason: 'relocation-materials-missing', missingCount: missing.length });
    entries.sort(order);
    index = { version: 1, roomId, txnId, epoch: expectedEpoch, target, record, entries,
      manifest: { rev, logDigest: jsonHash({ record, files: entries.filter(e => e.path.startsWith('doc/')) }), assetDigest: jsonHash(entries.filter(e => e.path.startsWith('assets/'))) } };
    validateIndex(index); atomicJson(indexFile, index);
    // No await between final state collection, private journal persistence and source fencing.
    freezeRoom({ store, roomId, txnId, expectedEpoch, target, manifest: index.manifest });
  }
  for (const entry of index.entries) copyChecked(sourceFile(index, entry, dataDir, assets), fileAt(root, entry.path), entry.digest);
  return { root, index: structuredClone(index) };
}
/** Transport adapters must stream these verified files to the target's private stage. */
export function copyRelocationStage({ snapshot, dataDir }) {
  const index = validateIndex(snapshot.index), root = path.join(dataDir, 'relocation', index.txnId);
  for (const entry of index.entries) copyChecked(fileAt(snapshot.root, entry.path), fileAt(root, entry.path), entry.digest);
  atomicJson(fileAt(root, 'index.json'), index); return { root, index: structuredClone(index) };
}
export function loadRelocationStage({ dataDir, txnId }) {
  if (!isRelocationId(txnId)) reject('bad-relocation');
  const root = path.join(dataDir, 'relocation', txnId), index = validateIndex(JSON.parse(fs.readFileSync(fileAt(root, 'index.json'), 'utf8')));
  if (index.txnId !== txnId) reject('relocation-conflict'); return { root, index };
}
/** Receiver metadata is accepted only against an authenticated directory transaction. */
export function receiveRelocationIndex({ dataDir, index, authority }) {
  validateIndex(index);
  if (authority?.roomId !== index.roomId || authority.txnId !== index.txnId || authority.epoch !== index.epoch + 1
    || !same(relocationTarget(authority.target), index.target) || !same(relocationManifest(authority.manifest), index.manifest)) reject('relocation-conflict');
  const root = path.join(dataDir, 'relocation', index.txnId), file = fileAt(root, 'index.json');
  if (fs.existsSync(file)) { if (!same(JSON.parse(fs.readFileSync(file, 'utf8')), index)) reject('relocation-conflict'); }
  else atomicJson(file, index);
  return { root, index: structuredClone(index) };
}
export function relocationFileStream({ snapshot, relative }) {
  const index = validateIndex(snapshot.index), entry = index.entries.find(e => e.path === relative);
  if (!entry) reject('bad-relocation-path');
  const file = fileAt(snapshot.root, relative);
  if (fs.statSync(file).size !== entry.size || fileHash(file) !== entry.digest) reject('relocation-data-changed');
  return fs.createReadStream(file);
}
/** Bounded streaming reception. Interrupted or dishonest transfers never publish a complete file. */
export async function receiveRelocationFile({ dataDir, txnId, relative, stream }) {
  const stage = loadRelocationStage({ dataDir, txnId }), entry = stage.index.entries.find(e => e.path === relative);
  if (!entry) reject('bad-relocation-path');
  const file = fileAt(stage.root, relative);
  if (fs.existsSync(file) && fs.statSync(file).size === entry.size && fileHash(file) === entry.digest) {
    // Drain a retry without unbounded memory or replacing an already verified immutable file.
    let count = 0; for await (const chunk of stream) { count += chunk.length; if (count > entry.size) reject('relocation-data-changed'); }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`, digest = createHash('sha256'); let count = 0;
  const check = new Transform({ transform(chunk, encoding, done) {
    count += chunk.length;
    if (count > entry.size) return done(Object.assign(new Error('Relocation length rejected'), { reason: 'relocation-data-changed' }));
    digest.update(chunk); done(null, chunk);
  } });
  try {
    await pipeline(stream, check, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (count !== entry.size || digest.digest('hex') !== entry.digest) reject('relocation-data-changed');
    const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function verifiedStage(stage) {
  const index = validateIndex(stage.index);
  if (!same(JSON.parse(fs.readFileSync(fileAt(stage.root, 'index.json'), 'utf8')), index)) reject('relocation-data-changed');
  for (const entry of index.entries) if (fs.statSync(fileAt(stage.root, entry.path)).size !== entry.size || fileHash(fileAt(stage.root, entry.path)) !== entry.digest) reject('relocation-data-changed');
  return index;
}
/** This only prepares the target. A source or target crash cannot publish a half-import. */
export function installRelocationStage({ stage, dataDir, store, assets, reloadSpace }) {
  const index = verifiedStage(stage), prior = store.peek(index.roomId), tenant = path.join(dataDir, 'tenants', index.roomId);
  if (fs.existsSync(tenant) && !prior) reject('relocation-conflict');
  const record = { ...structuredClone(index.record), hostingEpoch: index.epoch + 1, generation: index.record.generation + 1,
    relocation: { version: 1, roomId: index.roomId, txnId: index.txnId, phase: 'staging', epoch: index.epoch, targetEpoch: index.epoch + 1, target: index.target, manifest: index.manifest } };
  store.installRelocated(record); reloadSpace?.(index.roomId);
  const docs = index.entries.filter(e => e.path.startsWith('doc/'));
  const matches = fs.existsSync(tenant) && same(tree(tenant).map(e => ({ ...e, path: 'doc/' + e.path })), docs);
  if (!matches) {
    const temporary = path.join(stage.root, 'install-tenant'), backup = path.join(stage.root, 'prior-tenant');
    for (const entry of docs) copyChecked(fileAt(stage.root, entry.path), fileAt(temporary, entry.path.slice(4)), entry.digest);
    fs.mkdirSync(path.dirname(tenant), { recursive: true, mode: 0o700 });
    if (fs.existsSync(tenant)) { if (fs.existsSync(backup)) reject('relocation-conflict'); fs.renameSync(tenant, backup); }
    fs.renameSync(temporary, tenant);
  }
  for (const entry of index.entries.filter(e => e.path.startsWith('assets/'))) {
    const [, ns, file] = entry.path.split('/'), spec = assets[ns]; if (!spec?.root) reject('relocation-assets-unavailable');
    const destination = fileAt(spec.root, spec.shard ? `${file.slice(0, 2)}/${file}` : file);
    if (fs.existsSync(destination)) { if (fileHash(destination) !== entry.digest) reject('relocation-asset-damaged'); }
    else copyChecked(fileAt(stage.root, entry.path), destination, entry.digest);
  }
  return { roomId: index.roomId, txnId: index.txnId, epoch: index.epoch + 1, target: index.target, manifest: index.manifest };
}
/** Pass only an authenticated authority result; untrusted project files never reach this API. */
export function activateRelocationStage({ stage, dataDir, store, assets, authority }) {
  const index = verifiedStage(stage), rec = store.peek(index.roomId);
  if (authority?.roomId !== index.roomId || authority.txnId !== index.txnId || authority.epoch !== index.epoch + 1
    || !same(relocationTarget(authority.target), index.target) || !same(relocationManifest(authority.manifest), index.manifest)) reject('relocation-conflict');
  if (!rec?.relocation && same(rec?.relocationActivation, authority)) return;
  if (rec?.relocation?.phase !== 'staging' || rec.relocation.txnId !== index.txnId || rec.hostingEpoch !== authority.epoch) reject('relocation-conflict');
  for (const entry of index.entries) if (fileHash(sourceFile(index, entry, dataDir, assets)) !== entry.digest) reject('relocation-data-changed');
  store.update(index.roomId, draft => { delete draft.relocation; draft.relocationActivation = structuredClone(authority); });
}
