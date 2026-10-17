import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { accountError } from './client.mjs';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digestOf = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const empty = authorityId => ({ v: 2, authorityId, revision: 0, accountHead: 0, accountEvents: {}, revokedLogins: {},
  projects: {}, requests: {}, accessHead: 0, accessEvents: [], accessAcks: {}, accountAcks: {}, barriers: {} });

/** Private new v2 ledger; never migrates the existing LAN credential/project store.
 * All authorization state, event cursor, idempotent result and outbox changes commit together.
 */
export function openAccountLedger({ file, authorityId, failpoint = () => {} }) {
  if (typeof authorityId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(authorityId)) throw accountError(503, 'authority-configuration');
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw accountError(503, 'ledger-configuration');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 2) throw accountError(503, 'ledger-schema');
    db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS account_authority_state(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); PRAGMA user_version=2;');
    if (!db.prepare('SELECT id FROM account_authority_state WHERE id=1').get()) db.prepare('INSERT INTO account_authority_state VALUES(1,?)').run(JSON.stringify(empty(authorityId)));
    db.exec('COMMIT');
    fs.chmodSync(file, 0o600);
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  const load = () => {
    const state = JSON.parse(db.prepare('SELECT payload FROM account_authority_state WHERE id=1').get().payload);
    if (state.v !== 2 || state.authorityId !== authorityId || !Number.isSafeInteger(state.accountHead) || !Number.isSafeInteger(state.accessHead)) throw accountError(503, 'authority-mismatch');
    return state;
  };
  try { load(); } catch (error) { db.close(); throw error; }
  // 整本账是一段 JSON，读一次要整段解析；热路径一秒读几十上百次（2026-10-17 节点上 684 KB 的账本把文档服务主线程占满）。
  // 所以读到的结果缓存起来，账本真的变了才重新解析：自己这条连接提交过就作废，别的连接（部署脚本等）提交过由
  // `PRAGMA data_version` 看出来（它只在别的连接提交后变）。缓存是共用的，整个冻住；调用方要改就改 transaction 给的那份。
  const dataVersion = db.prepare('PRAGMA data_version');
  let cached = null, cachedVersion = null;
  const read = () => {
    const version = dataVersion.get().data_version;
    if (cached && version === cachedVersion) return cached;
    cached = deepFreeze(load()); cachedVersion = version;
    return cached;
  };
  let writing = false;
  return { authorityId, read,
    transaction(fn) {
      if (writing) throw accountError(503, 'ledger-reentrant');
      writing = true;
      try {
        db.exec('BEGIN IMMEDIATE'); const state = load(); const result = fn(state);
        if (result?.then) throw accountError(503, 'ledger-async-transaction');
        failpoint('ledger-before-write');
        db.prepare('UPDATE account_authority_state SET payload=? WHERE id=1').run(JSON.stringify(state));
        failpoint('ledger-before-commit'); cached = null; db.exec('COMMIT');
        const cloned = structuredClone(result);
        cached = deepFreeze(state); cachedVersion = dataVersion.get().data_version;
        return cloned;
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      finally { writing = false; }
    },
    inspect: () => ({ schema: db.prepare('PRAGMA user_version').get().user_version,
      synchronous: db.prepare('PRAGMA synchronous').get().synchronous, journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check, authorityId,
      accountHead: load().accountHead, accessHead: load().accessHead, projects: Object.keys(load().projects).length }),
    close: () => db.close(),
  };
}

export function appendAccessEvent(state, fields) {
  const seq = ++state.accessHead;
  const event = { v: 2, issuer: state.authorityId, eventId: `access:${state.authorityId}:${seq}`, seq, ...fields };
  state.accessEvents.push(event); return event;
}
