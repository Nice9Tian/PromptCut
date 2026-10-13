/**
 * 0.7.18 验收的 38 行结论表与覆盖守门(纯逻辑,不起进程;单测在 `server/test/four-stage-acceptance-v18.test.mjs`)。
 *
 * 一行的结论只有四种:通过 / 失败 / 未跑 / 不适用。规则(与派活指令一致):
 *   - 这一行的清单项里只要有一项失败(含「不稳定」:首败后复跑过的),这一行就是失败;
 *   - 没有失败、但有项没跑(人工、要安装包、要节点、等分支合入、前置没过、本次没选中),这一行是「未跑」并列出没跑的项——没跑不算通过;
 *   - 没有失败、没有没跑的,且至少有一项通过,才是「通过」;
 *   - 这一行的项全是「不适用」(写死了依据的),这一行是「不适用」;
 *   - 一行没有任何清单项,算「未跑」(并在 --check-coverage 里报错)。
 */
import { WHERE_LABEL, whereOf, levelOf, commandText } from './acceptance-lib.mjs';

export const ROW_VERDICTS = ['通过', '失败', '未跑', '不适用'];

/** 一个清单项对一行的贡献:{ id, name, state: pass|fail|notrun|na, why, where } */
export function itemContribution(item, rec) {
  const where = whereOf(item);
  const base = { id: item.id, name: item.name, where };
  if (item.notApplicable || where === 'na') return { ...base, state: 'na', why: item.notApplicable || '不适用' };
  const v = rec?.verdict;
  if (v === 'pass') return { ...base, state: 'pass', why: rec.stability ? `过(稳定性 ${rec.stability})` : '过' };
  if (v === 'na') return { ...base, state: 'na', why: (rec.reasons || []).join(';') || '不适用' };
  if (v === 'fail') return { ...base, state: 'fail', why: (rec.reasons || []).join(';') || '不过' };
  if (v === 'flaky') return { ...base, state: 'fail', why: `不稳定(稳定性 ${rec.stability || '?'}):${(rec.reasons || []).join(';')}` };
  if (v === 'blocked') return { ...base, state: 'notrun', why: (rec.reasons || []).join(';') || '跑不了(前置没过)' };
  if (v === 'missing') return { ...base, state: 'notrun', why: (rec.reasons || []).join(';') || '本检出缺文件' };
  if (v === 'waiting') return { ...base, state: 'notrun', why: (rec.reasons || []).join(';') || `等 ${item.waitFor} 合入` };
  if (v === 'manual') return { ...base, state: 'notrun', why: `${WHERE_LABEL[where] || '人工'}:${rec.reasons?.[0] || item.manual || ''}`.slice(0, 220) };
  if (v === 'remote') return { ...base, state: 'notrun', why: `${WHERE_LABEL[where] || '节点'}:${rec.reasons?.[0] || item.remoteOnly || ''}`.slice(0, 220) };
  if (v === 'skipped') return { ...base, state: 'notrun', why: '续跑跳过(没有上次结果)' };
  // 本次根本没选中 / 没跑到
  const label = WHERE_LABEL[where] || where;
  if (where === 'wait') return { ...base, state: 'notrun', why: `等 ${item.waitFor} 合入;本次没跑` };
  if (item.optional) return { ...base, state: 'notrun', why: `补充项,本次没选中(${label});加 --include-optional 或 --only 点名` };
  if (levelOf(item) === 'network') return { ...base, state: 'notrun', why: `${label};本次没选真实网络验证(--level network 只生成待办)` };
  return { ...base, state: 'notrun', why: `本次没跑(${label})` };
}

function combine(contribs) {
  const fails = contribs.filter((c) => c.state === 'fail');
  const notrun = contribs.filter((c) => c.state === 'notrun');
  const passes = contribs.filter((c) => c.state === 'pass');
  const nas = contribs.filter((c) => c.state === 'na');
  let verdict;
  if (fails.length) verdict = '失败';
  else if (notrun.length) verdict = '未跑';
  else if (passes.length) verdict = '通过';
  else if (nas.length) verdict = '不适用';
  else verdict = '未跑';
  return { verdict, fails, notrun, passes, nas };
}

/**
 * 38 行的结论表。rows:V18_ROWS;items:清单(全部,不只是选中的);results:results.json 里的 items 数组(可以为空数组)。
 * 返回 [{ id, name, verdict, basis: [{id, name, state, why, where}], fails, notrun, passes, nas, derived: [{id, verdict}] }]
 */
export function rowTable(rows, items, results) {
  const byId = new Map((results || []).map((r) => [r.id, r]));
  const out = new Map();
  for (const row of rows) {
    const mine = items.filter((it) => (it.rows || []).includes(row.id));
    const contribs = mine.map((it) => itemContribution(it, byId.get(it.id)));
    out.set(row.id, { row, contribs });
  }
  const done = new Map();
  const resolve = (id, stack = []) => {
    if (done.has(id)) return done.get(id);
    const { row, contribs } = out.get(id);
    let all = contribs.slice();
    const derived = [];
    for (const d of row.derives || []) {
      if (stack.includes(d)) continue;
      const sub = resolve(d, [...stack, id]);
      derived.push({ id: d, verdict: sub.verdict });
      // 汇总行把被指向那一行的结论当一条依据:失败/未跑/通过/不适用各自对应
      const state = { 通过: 'pass', 失败: 'fail', 未跑: 'notrun', 不适用: 'na' }[sub.verdict];
      all = all.concat([{ id: `行 ${d}`, name: sub.row.name, state, where: 'local', why: sub.verdict === '通过' ? '通过' : sub.verdict + (sub.fails.length ? `:${sub.fails.map((f) => f.id).join('、')}` : sub.notrun.length ? `:${sub.notrun.map((f) => f.id).join('、')}` : '') }]);
    }
    const c = combine(all);
    // 整行写死不适用,且没有任何通过/失败/没跑的依据
    const res = { id, name: row.name, row, verdict: c.verdict, basis: all, fails: c.fails, notrun: c.notrun, passes: c.passes, nas: c.nas, derived, na: row.na || null };
    done.set(id, res);
    return res;
  };
  return rows.map((r) => resolve(r.id));
}

const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

/** 一行「没跑的原因」或「失败原因」文字(表里最后一列) */
function reasonText(r) {
  if (r.verdict === '通过') return '';
  if (r.verdict === '不适用') return r.na || r.nas.map((n) => n.why).join(';');
  const parts = [];
  if (r.fails.length) parts.push('失败:' + r.fails.map((f) => `${f.id}(${clip(f.why, 160)})`).join(';'));
  if (r.notrun.length) parts.push('没跑:' + r.notrun.map((n) => `${n.id}(${clip(n.why, 110)})`).join(';'));
  return parts.join(' / ');
}

/** 计数:{ 通过, 失败, 未跑, 不适用 } */
export function tableCounts(table) {
  const c = { 通过: 0, 失败: 0, 未跑: 0, 不适用: 0 };
  for (const r of table) c[r.verdict]++;
  return c;
}

/** Markdown:主会话整份贴进对话。meta:{ commit, startedAt, finishedAt, host, level, args } */
export function rowsMarkdown(table, meta = {}) {
  const c = tableCounts(table);
  const lines = [];
  lines.push('## 0.7.18 验收:38 行结论');
  lines.push('');
  lines.push(`- 提交:\`${meta.commit || '?'}\`${meta.dirtyFiles ? `(工作区另有 ${meta.dirtyFiles} 个未提交改动)` : ''};机器 ${meta.host || '?'};${meta.startedAt || ''}${meta.finishedAt ? ` → ${meta.finishedAt}` : ''}`);
  lines.push(`- 合计 ${table.length} 行:通过 ${c.通过}、失败 ${c.失败}、未跑 ${c.未跑}、不适用 ${c.不适用}。规则:一行里只要有一项失败就是失败;有项没跑而其余通过是「未跑」并列出没跑的项,**没跑不算通过**。`);
  lines.push('- 「没跑」包括:本次没选中的项、人工看的项、要安装包、要部署到节点以后、要真实网络、等某条分支合入、前置没过。');
  lines.push('');
  lines.push('| 行 | 项目 | 结论 | 由哪些清单项得出 | 失败原因 / 没跑的原因 |');
  lines.push('|---|---|---|---|---|');
  for (const r of table) {
    const basis = r.basis.map((b) => `${b.state === 'pass' ? '✓' : b.state === 'fail' ? '✗' : b.state === 'na' ? '-' : '·'}${b.id}`).join(' ');
    lines.push(`| ${r.id} | ${cell(r.name)} | **${r.verdict}** | ${cell(basis) || '(没有清单项)'} | ${cell(reasonText(r))} |`);
  }
  lines.push('');
  lines.push('依据一栏的记号:✓ 这一项通过;✗ 失败;· 没跑;- 不适用。');
  return lines.join('\n') + '\n';
}

/** 终端里的短表(一行一条) */
export function rowsText(table) {
  const c = tableCounts(table);
  const lines = [`0.7.18 验收 38 行:通过 ${c.通过}、失败 ${c.失败}、未跑 ${c.未跑}、不适用 ${c.不适用}`];
  for (const r of table) {
    lines.push(`${r.verdict.padEnd(3, '　')} ${r.id.padEnd(10)} ${r.name}`);
    const t = reasonText(r);
    if (t) lines.push(`        ${clip(t, 400)}`);
  }
  return lines.join('\n');
}

/** --rows-map:38 行各由哪些清单项覆盖、每项在哪能跑 */
export function rowsMapText(rows, items) {
  const lines = [];
  for (const row of rows) {
    const mine = items.filter((it) => (it.rows || []).includes(row.id));
    lines.push(`${row.id.padEnd(10)} ${row.name}${row.derives ? `  (汇总:指向 ${row.derives[0]}～${row.derives[row.derives.length - 1]})` : ''}${row.na ? `  [不适用:${row.na}]` : ''}`);
    if (!mine.length && !row.derives) lines.push('           (没有清单项!)');
    for (const it of mine) {
      const w = whereOf(it);
      lines.push(`           ${it.id.padEnd(30)} ${WHERE_LABEL[w]}${it.waitFor ? `(${it.waitFor})` : ''}  ${it.name}`);
    }
  }
  return lines.join('\n');
}

/** 从一条命令里取出引用的仓库文件(脚本、测试文件);带占位符 {…} 或通配 * 的不取 */
export function filesOfCommand(cmd) {
  const out = [];
  for (const part of cmd || []) {
    if (typeof part !== 'string' || /[{*]/.test(part)) continue;
    if (/^(scripts|server|src|tools|desktop)\//.test(part) && /\.(mjs|cjs|js|ts|tsx|ps1)$/.test(part)) out.push(part);
  }
  return out;
}

/**
 * --check-coverage 的新增检查(探针登记的那一项沿用 coverageReport):
 *   - 38 行每行至少有一条清单项(derives 的汇总行除外,但它指向的行要有);
 *   - 清单项引用的文件(命令里的脚本与测试文件、requires)在仓库里存在;标了 where: wait 的除外,单列;
 *   - 清单项里 rows 引用的行号都存在(validateManifest 也查,这里再报一遍);
 * exists:(相对路径) => boolean(测试注入)。
 */
export function v18CoverageCheck(rows, items, exists) {
  const uncoveredRows = rows.filter((r) => !r.derives && !items.some((it) => (it.rows || []).includes(r.id))).map((r) => r.id);
  const missingFiles = []; // 不是 wait 的项却缺文件:真问题
  const waitingFiles = []; // wait 的项,缺文件是预期的
  for (const it of items) {
    if (it.cwd === 'main') continue;
    const files = new Set([...filesOfCommand(it.cmd), ...(it.steps || []).flatMap((s) => filesOfCommand(s.cmd || s)), ...(it.requires || [])]);
    for (const f of files) {
      if (exists(f)) continue;
      (whereOf(it) === 'wait' ? waitingFiles : missingFiles).push({ item: it.id, file: f, waitFor: it.waitFor || null });
    }
  }
  const unknownRows = [];
  const ids = new Set(rows.map((r) => r.id));
  for (const it of items) for (const r of it.rows || []) if (!ids.has(r)) unknownRows.push({ item: it.id, row: r });
  return { uncoveredRows, missingFiles, waitingFiles, unknownRows, ok: !uncoveredRows.length && !missingFiles.length && !unknownRows.length };
}

/** G0-2 的跳过名单自检:名单里的条目要写全(name、file、why),名字不重复 */
export function skipListProblems(skipAllow) {
  const problems = [];
  const seen = new Set();
  for (const a of skipAllow || []) {
    for (const k of ['name', 'file', 'why']) if (!a[k]) problems.push(`跳过名单里有一条缺 ${k}:${JSON.stringify(a).slice(0, 80)}`);
    if (seen.has(a.name)) problems.push(`跳过名单里的名字重复:${a.name}`);
    seen.add(a.name);
  }
  return problems;
}

export { commandText };
