#!/usr/bin/env node
/**
 * 把旧办法（不带账号）建的云端项目号登记成墓碑，只做这一件事。
 *
 * 背景：旧云端项目从来不在账号账本（`account-v2.sqlite`）里。节点上把它们清掉以后，用户电脑上指向它们的项目文件
 * 要凭文档服务签发的「这个项目已不存在」的证明才转成本地项目（`server/recovery/gone-proof.mjs`）；文档服务只对
 * 账本里留有墓碑的项目号签。这支脚本把一份项目号清单写进账本的 `legacyTombstones`。
 *
 * **墓碑一登记，客户端就会把对应的文件转成本地项目，不管旧服务上那个项目是不是还开着**（打开文件时先问证明、后连接）。
 * 所以顺序必须是：旧服务已经停掉、旧数据已经备份 → 登记 → 才删旧数据。脚本自己查不了旧服务停没停，`apply` 要你明说。
 *
 * 子命令（缺省什么都不写；`plan`、`verify`、`print-public-key`、`list` 任何时候都不写任何东西）：
 *   plan   --ledger <账本绝对路径> --authority-id <签发方标识> --ids <清单文件> [--legacy-data <旧数据目录>]
 *          空跑：逐个项目号报「要新登记 / 已登记过 / 与账号项目撞号 / 写法不对 / 旧数据里没有这个项目」。账本以只读方式打开。
 *   apply  同上，`--legacy-data` 必给，另加 --source <一句来源说明> --old-service-stopped yes
 *          真写。清单里只要有一个不能登记（写法不对、撞号、旧数据里对不上），一个都不写。已登记过的原样不动（重复跑结果相同）。
 *   revoke --ledger … --authority-id … --ids <清单文件> --source <一句原因>
 *          撤销：把清单里的号从墓碑里拿掉（留一条撤销记录）。撤销后文档服务不再为它们签证明。见下「登记错了怎么办」。
 *   list   --ledger … --authority-id …
 *          列出现有的墓碑与撤销记录。
 *   verify --origin <公网入口> --authority-id <标识> --kid <钥匙号> --public-key <公钥> --service <旧文件里记的服务地址> --ids <清单文件>
 *          [--absent <另一份清单：不该有墓碑的项目号>]
 *          从公网问一遍：清单里每个号都拿得到证明并且验得过；--absent 里的每个号都明确答「没有墓碑」。
 *   print-public-key --signing-key-file <文档服务签名私钥文件>
 *          打印这把钥匙的公钥（32 字节原始公钥的 base64url），填进客户端的信任表用。只读私钥文件，不打印私钥。
 *
 * 清单文件：一行一个项目号（`sp_` 开头），空行和 `#` 开头的行不算。
 * `--legacy-data`：旧托管数据目录（只读）。脚本在它下面找旧项目的登记文件 `…/auth/projects/<项目号>.json`，
 *   清单里每个号都要在那里有一份、并且文件里的 `projectId` 就是这个号；对不上的拒绝。它只挡「号写错了、不是旧项目」，
 *   挡不了「旧项目还开着」——那一条靠先停旧服务。
 * 账本可以在文档服务运行时写（SQLite 独占写事务，服务每次读都读最新的一份），不用停文档服务。写之前先自己备份账本文件。
 *
 * 登记错了怎么办：
 *   - 证明没有有效期，但客户端从不保存证明：每次打开文件都现问一次。`revoke` 之后再打开那份文件就拿不到证明，不再转换。
 *   - 撤销之前已经转换过的：用户那边多了一个本地项目，**原文件没有被改**（转换后的第一次保存一定是另存），
 *     再打开原文件就照常连回原云端项目。已经另存出去的本地副本收不回，也不需要收回。
 *   - 撤销之前已经签出去、被别人截下来的证明：对产品没用，客户端只认自己当场从信任表里的地址问来的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ID = /^sp_[a-z2-7]{26}$/;

export function parseIds(text) {
  return String(text).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

/**
 * 旧托管数据目录里登记着哪些旧项目号（只读）。认这几种摆法：给的是托管数据根（下面有 `docservice/auth/projects`）、
 * 文档服务数据目录（`auth/projects`）、或直接是那个 `projects` 目录。找不到登记目录就抛错。
 */
export function readLegacyProjectIds(dir) {
  const root = path.resolve(dir);
  const found = [path.join(root, 'docservice', 'auth', 'projects'), path.join(root, 'auth', 'projects'), root]
    .find(candidate => { try { return fs.statSync(candidate).isDirectory() && fs.readdirSync(candidate).some(name => /^sp_[a-z2-7]{26}\.json$/.test(name)); } catch { return false; } });
  if (!found) throw new Error(`在 ${root} 下面没找到旧项目的登记目录（…/auth/projects/sp_….json）`);
  const ids = new Set();
  for (const name of fs.readdirSync(found)) {
    const id = name.replace(/\.json$/, '');
    if (!ID.test(id) || !name.endsWith('.json')) continue;
    try { if (JSON.parse(fs.readFileSync(path.join(found, name), 'utf8'))?.projectId === id) ids.add(id); } catch { /* 读不了的登记文件不算数 */ }
  }
  return { dir: found, ids };
}

/**
 * 逐个项目号判一遍，不写。`state` 是账本的当前内容；`legacyIds` 给了就再和旧数据对一遍（Set）。
 * 每行的 `action`：`new`、`already`、`invalid`、`duplicate-line`、`conflict-account-project`、`not-in-legacy-data`。
 */
export function planLegacyTombstones(state, ids, { legacyIds = null } = {}) {
  const seen = new Set();
  return ids.map(id => {
    if (!ID.test(id)) return { id, action: 'invalid' };
    if (seen.has(id)) return { id, action: 'duplicate-line' };
    seen.add(id);
    if (Object.hasOwn(state.projects ?? {}, id)) return { id, action: 'conflict-account-project' };
    const old = state.legacyTombstones?.[id];
    if (old) return { id, action: 'already', tombstone: old };
    if (legacyIds && !legacyIds.has(id)) return { id, action: 'not-in-legacy-data' };
    return { id, action: 'new' };
  });
}
const BLOCKING = new Set(['invalid', 'conflict-account-project', 'not-in-legacy-data']);

/** 真写。清单里有任何一个不能登记的，整份拒绝、一个都不写。回这次的逐项结果。 */
export function applyLegacyTombstones(ledger, ids, { source, now = Date.now, legacyIds = null } = {}) {
  if (typeof source !== 'string' || !source.trim() || source.length > 200) throw new Error('要用 --source 写一句来源说明（200 字以内）');
  return ledger.transaction(state => {
    const plan = planLegacyTombstones(state, ids, { legacyIds });
    const blocked = plan.filter(row => BLOCKING.has(row.action));
    if (blocked.length) throw Object.assign(new Error(`清单里有 ${blocked.length} 个项目号不能登记，一个都没写`), { plan });
    state.legacyTombstones ??= {};
    for (const row of plan) {
      if (row.action !== 'new') continue;
      row.tombstone = state.legacyTombstones[row.id] = { revision: ++state.revision, deletedAt: now(), source: source.trim() };
      row.action = 'written';
    }
    return plan;
  });
}

/** 撤销：从墓碑里拿掉，留一条撤销记录。没登记过的报 `not-registered`，不算错。 */
export function revokeLegacyTombstones(ledger, ids, { source, now = Date.now } = {}) {
  if (typeof source !== 'string' || !source.trim() || source.length > 200) throw new Error('要用 --source 写一句撤销原因（200 字以内）');
  return ledger.transaction(state => {
    const seen = new Set();
    return ids.map(id => {
      if (!ID.test(id)) return { id, action: 'invalid' };
      if (seen.has(id)) return { id, action: 'duplicate-line' };
      seen.add(id);
      const tombstone = state.legacyTombstones?.[id];
      if (!tombstone) return { id, action: 'not-registered' };
      delete state.legacyTombstones[id];
      state.legacyTombstoneRevocations ??= {};
      (state.legacyTombstoneRevocations[id] ??= []).push({ revokedAt: now(), source: source.trim(), tombstone });
      ++state.revision;
      return { id, action: 'revoked', tombstone };
    });
  });
}

/**
 * 只读地读一份账本的当前内容：不建表、不改任何东西。不是这个签发方的账本（或根本不是账本）就抛错。
 * `plan`、`list` 用它；`apply`、`revoke` 也先过它这一关，免得对着一个不相干的 sqlite 文件建表写空状态。
 */
export async function readLedgerReadOnly(file, authorityId) {
  if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error('--ledger 要给已有账本文件的绝对路径（这支脚本不新建账本）');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    let row;
    try { row = db.prepare('SELECT payload FROM account_authority_state WHERE id=1').get(); }
    catch { throw new Error('这个文件不是账号账本（里面没有账本的表）；什么都没写'); }
    if (!row || db.prepare('PRAGMA user_version').get().user_version !== 2) throw new Error('这个文件不是账号账本（版本不对或没有内容）；什么都没写');
    const state = JSON.parse(row.payload);
    if (state.v !== 2 || state.authorityId !== authorityId) throw new Error(`账本的签发方标识是 ${JSON.stringify(state.authorityId)}，不是 --authority-id 给的那个；什么都没写`);
    return state;
  } finally { db.close(); }
}

/** 文档服务签名私钥 → 客户端信任表里填的公钥写法 */
export function publicKeyOf(privatePem) {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('这不是 Ed25519 签名钥匙');
  return jwk.x;
}

/** 从公网核对：`ids` 里的都拿得到验得过的证明，`absent` 里的都明确没有墓碑。回逐项结果与是否全对。 */
export async function verifyLegacyTombstones({ authority, service, ids, absent = [], fetch: fetcher = globalThis.fetch }) {
  const { queryGone } = await import('../../recovery/gone-proof.mjs');
  const rows = [];
  for (const [list, want] of [[ids, 'gone'], [absent, 'no-tombstone']]) {
    for (const id of list) {
      let got;
      try { got = (await queryGone({ version: 1, roomId: id, service, where: 'hosted' }, { authorities: [authority], fetch: fetcher })).state; }
      catch (error) { got = `unavailable:${error?.detail ?? error?.message}`; }
      rows.push({ id, want, got, ok: got === want });
    }
  }
  return { rows, ok: rows.every(row => row.ok) };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    const key = argv[i].slice(2); const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 后面要跟一个值`);
    out[key] = value; i++;
  }
  return out;
}
const need = (options, key) => { if (!options[key]) throw new Error(`缺 --${key}`); return options[key]; };
const idsOf = file => parseIds(fs.readFileSync(file, 'utf8'));
const when = ms => new Date(ms).toISOString();

async function main(argv) {
  const options = args(argv); const command = options._[0] ?? 'help';
  const say = line => process.stdout.write(`${line}\n`);
  if (command === 'print-public-key') { say(publicKeyOf(fs.readFileSync(need(options, 'signing-key-file')))); return 0; }
  if (['plan', 'apply', 'revoke', 'list'].includes(command)) {
    const file = need(options, 'ledger'); const authorityId = need(options, 'authority-id');
    const before = await readLedgerReadOnly(file, authorityId);
    const count = state => Object.keys(state.legacyTombstones ?? {}).length;
    if (command === 'list') {
      for (const [id, t] of Object.entries(before.legacyTombstones ?? {})) say(`${id}\t墓碑\trevision=${t.revision}\tdeletedAt=${when(t.deletedAt)}\t${t.source ?? ''}`);
      for (const [id, list] of Object.entries(before.legacyTombstoneRevocations ?? {})) for (const r of list) say(`${id}\t已撤销\trevokedAt=${when(r.revokedAt)}\t${r.source ?? ''}`);
      say(`# 墓碑 ${count(before)} 个；撤销记录 ${Object.values(before.legacyTombstoneRevocations ?? {}).reduce((n, l) => n + l.length, 0)} 条`);
      return 0;
    }
    const ids = idsOf(need(options, 'ids'));
    if (command === 'plan') {
      const legacy = options['legacy-data'] ? readLegacyProjectIds(options['legacy-data']) : null;
      const plan = planLegacyTombstones(before, ids, { legacyIds: legacy?.ids ?? null });
      for (const row of plan) say(`${row.id}\t${row.action}${row.tombstone ? `\trevision=${row.tombstone.revision}\tdeletedAt=${when(row.tombstone.deletedAt)}` : ''}`);
      const n = action => plan.filter(row => row.action === action).length;
      if (legacy) {
        const extra = [...legacy.ids].filter(id => !ids.includes(id) && !before.legacyTombstones?.[id]);
        say(`# 旧数据（${legacy.dir}）里登记着 ${legacy.ids.size} 个旧项目；不在清单里、也没登记过墓碑的有 ${extra.length} 个${extra.length ? '：' + extra.join(' ') : ''}`);
      } else say('# 没给 --legacy-data：这次没有和旧数据核对（apply 时必须给）');
      say(`# 空跑，没有写：清单 ${plan.length} 个；新登记 ${n('new')}，已登记过 ${n('already')}，撞号 ${n('conflict-account-project')}，写法不对 ${n('invalid')}，旧数据里没有 ${n('not-in-legacy-data')}，重复行 ${n('duplicate-line')}；账本里的旧项目墓碑 ${count(before)} → ${count(before)}`);
      return plan.some(row => BLOCKING.has(row.action)) ? 2 : 0;
    }
    const source = need(options, 'source');
    let legacy = null;
    if (command === 'apply') {
      legacy = readLegacyProjectIds(need(options, 'legacy-data'));
      if (options['old-service-stopped'] !== 'yes') throw new Error('登记之后客户端就会把这些文件转成本地项目，不管旧服务上的项目是不是还开着。先停掉旧服务、备份好旧数据，再加 --old-service-stopped yes 重跑；什么都没写');
    }
    const { openAccountLedger } = await import('../../account/ledger.mjs');
    const ledger = openAccountLedger({ file, authorityId });
    try {
      const rows = command === 'apply' ? applyLegacyTombstones(ledger, ids, { source, legacyIds: legacy.ids }) : revokeLegacyTombstones(ledger, ids, { source });
      for (const row of rows) say(`${row.id}\t${row.action}${row.tombstone ? `\trevision=${row.tombstone.revision}\tdeletedAt=${when(row.tombstone.deletedAt)}` : ''}`);
      const n = action => rows.filter(row => row.action === action).length;
      const after = count(ledger.read());
      if (command === 'apply') say(`# 已写入：清单 ${rows.length} 个；新登记 ${n('written')}，已登记过 ${n('already')}，重复行 ${n('duplicate-line')}；账本里的旧项目墓碑 ${count(before)} → ${after}`);
      else say(`# 已撤销：清单 ${rows.length} 个；撤销 ${n('revoked')}，本来就没登记 ${n('not-registered')}，写法不对 ${n('invalid')}，重复行 ${n('duplicate-line')}；账本里的旧项目墓碑 ${count(before)} → ${after}`);
      return 0;
    } finally { ledger.close(); }
  }
  if (command === 'verify') {
    const origin = new URL(need(options, 'origin')).origin;
    const authority = { authorityId: need(options, 'authority-id'), origin, services: [need(options, 'service')], keys: { [need(options, 'kid')]: need(options, 'public-key') } };
    const result = await verifyLegacyTombstones({ authority, service: authority.services[0], ids: idsOf(need(options, 'ids')), absent: options.absent ? idsOf(options.absent) : [] });
    for (const row of result.rows) say(`${row.id}\t应为 ${row.want}\t实际 ${row.got}\t${row.ok ? '对' : '不对'}`);
    say(`# ${result.ok ? '全部对上' : '有对不上的'}：${result.rows.filter(row => row.ok).length}/${result.rows.length}`);
    return result.ok ? 0 : 2;
  }
  say('用法见文件头：plan | apply | revoke | list | verify | print-public-key');
  return command === 'help' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (Array.isArray(error?.plan)) for (const row of error.plan) process.stderr.write(`${row.id}\t${row.action}\n`);
    process.exitCode = 1;
  });
}
