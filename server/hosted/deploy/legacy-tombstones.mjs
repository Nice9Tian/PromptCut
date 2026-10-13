#!/usr/bin/env node
/**
 * 把旧办法（不带账号）建的云端项目号登记成墓碑，只做这一件事。
 *
 * 背景：旧云端项目从来不在账号账本（`account-v2.sqlite`）里。节点上把它们清掉以后，用户电脑上指向它们的项目文件
 * 要凭文档服务签发的「这个项目已不存在」的证明才转成本地项目（`server/recovery/gone-proof.mjs`）；文档服务只对
 * 账本里留有墓碑的项目号签。这支脚本把一份项目号清单写进账本的 `legacyTombstones`。
 *
 * 四个子命令（缺省什么都不写）：
 *   plan   --ledger <账本绝对路径> --authority-id <签发方标识> --ids <清单文件>
 *          空跑：逐个项目号报「要新登记 / 已登记过 / 与账号项目撞号 / 写法不对」，不写账本。
 *   apply  同上，另加 --source <一句来源说明>
 *          真写。清单里有写法不对或与账号项目撞号的，一个都不写。已登记过的原样不动（重复跑结果相同）。
 *   verify --origin <公网入口> --authority-id <标识> --kid <钥匙号> --public-key <公钥> --service <旧文件里记的服务地址> --ids <清单文件>
 *          [--absent <另一份清单：不该有墓碑的项目号>]
 *          从公网问一遍：清单里每个号都拿得到证明并且验得过；--absent 里的每个号都明确答「没有墓碑」。
 *   print-public-key --signing-key-file <文档服务签名私钥文件>
 *          打印这把钥匙的公钥（32 字节原始公钥的 base64url），填进客户端的信任表用。只读私钥文件，不打印私钥。
 *
 * 清单文件：一行一个项目号（`sp_` 开头），空行和 `#` 开头的行不算。
 * 账本可以在文档服务运行时写（SQLite 独占写事务，服务每次读都读最新的一份），不用停服务。写之前先自己备份账本文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ID = /^sp_[a-z2-7]{26}$/;

export function parseIds(text) {
  return String(text).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

/** 逐个项目号判一遍，不写。`state` 是账本的当前内容。 */
export function planLegacyTombstones(state, ids) {
  const seen = new Set();
  return ids.map(id => {
    if (!ID.test(id)) return { id, action: 'invalid' };
    if (seen.has(id)) return { id, action: 'duplicate-line' };
    seen.add(id);
    if (Object.hasOwn(state.projects ?? {}, id)) return { id, action: 'conflict-account-project' };
    const old = state.legacyTombstones?.[id];
    return old ? { id, action: 'already', tombstone: old } : { id, action: 'new' };
  });
}

/** 真写。清单里有任何一个不能登记的，整份拒绝、一个都不写。回这次的逐项结果。 */
export function applyLegacyTombstones(ledger, ids, { source, now = Date.now } = {}) {
  if (typeof source !== 'string' || !source.trim() || source.length > 200) throw new Error('要用 --source 写一句来源说明（200 字以内）');
  return ledger.transaction(state => {
    const plan = planLegacyTombstones(state, ids);
    const blocked = plan.filter(row => row.action === 'invalid' || row.action === 'conflict-account-project');
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

async function main(argv) {
  const options = args(argv); const command = options._[0] ?? 'help';
  const say = line => process.stdout.write(`${line}\n`);
  if (command === 'print-public-key') { say(publicKeyOf(fs.readFileSync(need(options, 'signing-key-file')))); return 0; }
  if (command === 'plan' || command === 'apply') {
    const file = need(options, 'ledger');
    if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error('--ledger 要给已有账本文件的绝对路径（这支脚本不新建账本）');
    const { openAccountLedger } = await import('../../account/ledger.mjs');
    const ledger = openAccountLedger({ file, authorityId: need(options, 'authority-id') });
    try {
      const ids = idsOf(need(options, 'ids'));
      const before = Object.keys(ledger.read().legacyTombstones ?? {}).length;
      const plan = command === 'apply' ? applyLegacyTombstones(ledger, ids, { source: need(options, 'source') }) : planLegacyTombstones(ledger.read(), ids);
      for (const row of plan) say(`${row.id}\t${row.action}${row.tombstone ? `\trevision=${row.tombstone.revision}\tdeletedAt=${new Date(row.tombstone.deletedAt).toISOString()}` : ''}`);
      const count = action => plan.filter(row => row.action === action).length;
      const after = Object.keys(ledger.read().legacyTombstones ?? {}).length;
      say(`# ${command === 'apply' ? '已写入' : '空跑，没有写'}：清单 ${plan.length} 个；新登记 ${count(command === 'apply' ? 'written' : 'new')}，已登记过 ${count('already')}，撞号 ${count('conflict-account-project')}，写法不对 ${count('invalid')}，重复行 ${count('duplicate-line')}；账本里的旧项目墓碑 ${before} → ${after}`);
      return plan.some(row => row.action === 'invalid' || row.action === 'conflict-account-project') ? 2 : 0;
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
  say('用法见文件头：plan | apply | verify | print-public-key');
  return command === 'help' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (Array.isArray(error?.plan)) for (const row of error.plan) process.stderr.write(`${row.id}\t${row.action}\n`);
    process.exitCode = 1;
  });
}
