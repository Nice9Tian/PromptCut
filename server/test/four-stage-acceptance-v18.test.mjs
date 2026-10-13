// 验收运行器的 0.7.18 部分:38 行结论表的合成规则、跳过名单与失败 todo 的判定、清单对 38 行的覆盖、--check-coverage 守门。
// 纯逻辑加真清单的自洽检查;只有最后两条起运行器子进程(--rows-map、--rows-from、--check-coverage),不跑任何清单项的命令。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judge, parseSkippedTests, parseFailingTodos, validateManifest, whereOf } from '../../scripts/acceptance/acceptance-lib.mjs';
import { rowTable, rowsMarkdown, tableCounts, v18CoverageCheck, skipListProblems, filesOfCommand, itemContribution } from '../../scripts/acceptance/v18-table.mjs';
import { V18_ROWS, V18_ROW_IDS } from '../../scripts/acceptance/v18-rows.mjs';
import { ITEMS, ROWS, G0_2_SKIPS } from '../../scripts/acceptance/four-stage-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'acceptance', 'four-stage-acceptance.mjs');

const rows = [{ id: 'A', name: '甲' }, { id: 'B', name: '乙' }, { id: 'C', name: '丙', na: '不是这一版' }, { id: 'D', name: '汇总', derives: ['A', 'B'] }];
const it = (id, rowIds, extra = {}) => ({ id, name: id, category: 'V18', level: 'local', taskRef: 't', rows: rowIds, where: 'local', cmd: ['node', 'x.mjs'], pass: { exit: 0 }, ...extra });
const rec = (id, verdict, reasons = []) => ({ id, verdict, reasons });

test('V18-01 一行的结论:有失败就是失败;没失败但有没跑的是未跑;全过才是通过;全不适用是不适用', () => {
  const items = [it('a1', ['A']), it('a2', ['A']), it('b1', ['B']), it('b2', ['B'], { where: 'manual', cmd: undefined, manual: '人工看' }), it('c1', ['C'], { where: 'na', cmd: undefined, notApplicable: '归下一版' })];
  const t = rowTable(rows, items, [rec('a1', 'pass'), rec('a2', 'fail', ['退出码 1']), rec('b1', 'pass'), rec('b2', 'manual')]);
  const by = Object.fromEntries(t.map((r) => [r.id, r]));
  assert.equal(by.A.verdict, '失败');
  assert.match(by.A.fails[0].why, /退出码 1/);
  assert.equal(by.B.verdict, '未跑', '有项没跑而其余通过 → 未跑,不是通过');
  assert.deepEqual(by.B.notrun.map((n) => n.id), ['b2']);
  assert.equal(by.C.verdict, '不适用');
  // 汇总行:A 失败,所以汇总行失败
  assert.equal(by.D.verdict, '失败');
  assert.deepEqual(by.D.derived.map((d) => d.verdict), ['失败', '未跑']);
  const ok = rowTable(rows, [it('a1', ['A']), it('b1', ['B'])], [rec('a1', 'pass'), rec('b1', 'pass')]);
  assert.deepEqual(ok.map((r) => r.verdict), ['通过', '通过', '未跑', '通过'].map((v, i) => (i === 2 ? '未跑' : v)));
  assert.deepEqual(tableCounts(ok), { 通过: 3, 失败: 0, 未跑: 1, 不适用: 0 });
});

test('V18-02 没跑的各种原因都算未跑,flaky 算失败,没选中的项不算通过', () => {
  const base = it('x', ['A']);
  const cases = [
    [rec('x', 'blocked', ['前置没过']), 'notrun'], [rec('x', 'missing', ['缺文件']), 'notrun'], [rec('x', 'waiting', ['等分支']), 'notrun'],
    [rec('x', 'remote', ['节点']), 'notrun'], [rec('x', 'manual', ['人工']), 'notrun'], [rec('x', 'skipped'), 'notrun'], [rec('x', 'flaky', ['偶发']), 'fail'],
    [undefined, 'notrun'], [rec('x', 'pass'), 'pass'], [rec('x', 'fail', ['坏']), 'fail'],
  ];
  for (const [r, state] of cases) assert.equal(itemContribution(base, r).state, state, JSON.stringify(r));
  // 没有任何结果:没有一行是通过(不适用的行除外)
  const none = rowTable(V18_ROWS, ITEMS, []);
  assert.equal(tableCounts(none).通过, 0, '一项都没跑,不能有任何一行通过');
  assert.deepEqual(none.filter((r) => r.verdict === '不适用').map((r) => r.id).sort(), ['2.1-10', '2.1-11']);
  // 一行没有任何清单项:未跑
  assert.equal(rowTable([{ id: 'Z', name: '空' }], [], [])[0].verdict, '未跑');
});

test('V18-03 Markdown 带 38 行、每行一条;失败与没跑的原因写在最后一列', () => {
  const t = rowTable(V18_ROWS, ITEMS, [{ id: 'G0-1', verdict: 'fail', reasons: ['tsc 有错'] }]);
  const md = rowsMarkdown(t, { commit: 'abc1234', host: 'pc', startedAt: 's', finishedAt: 'f' });
  for (const r of V18_ROWS) assert.ok(md.includes(`| ${r.id} |`), `表里缺 ${r.id}`);
  assert.equal(md.split('\n').filter((l) => /^\| (2\.1|2\.3|RS)/.test(l)).length, 38);
  assert.match(md, /2\.3-11[^\n]*失败[^\n]*G0-1\(tsc 有错\)/);
  assert.match(md, /没跑不算通过/);
});

test('V18-04 跳过名单:名单以外多一条就不过;名单里的跳过(含平台限定)放行;没写原因的跳过也点名', () => {
  const out = [
    'ℹ tests 9', '  ﹣ 恢复遍历遇symlink (0.13ms) # Windows 不请求 symlink 权限', '﹣ 集成:layout (0.07ms) # SKIP', '﹣ 新冒出来的跳过 (0.01ms) # 缺东西',
    'ℹ skipped 3', 'ℹ fail 0', '✓ npm test 最终结果：零失败',
  ].join('\n');
  assert.deepEqual(parseSkippedTests(out).map((x) => x.name), ['恢复遍历遇symlink', '集成:layout', '新冒出来的跳过']);
  assert.equal(parseSkippedTests(out)[1].reason, '', '「# SKIP」是没写原因');
  const item = { pass: { exit: 0, skipAllow: [{ name: '恢复遍历遇symlink', file: 'a', why: 'w', platforms: [process.platform] }, { name: '集成:layout', file: 'b', why: 'w' }] } };
  const j = judge(item, [{ exitCode: 0, output: out }]);
  assert.equal(j.verdict, 'fail');
  assert.match(j.reasons.join(), /多出 1 条不在跳过名单里的跳过.*新冒出来的跳过/);
  const clean = judge(item, [{ exitCode: 0, output: out.replace('﹣ 新冒出来的跳过 (0.01ms) # 缺东西\n', '') }]);
  assert.equal(clean.verdict, 'pass');
  // 平台限定的条目在别的平台上不放行
  const other = judge({ pass: { exit: 0, skipAllow: [{ name: '恢复遍历遇symlink', file: 'a', why: 'w', platforms: ['plan9'] }] } }, [{ exitCode: 0, output: '﹣ 恢复遍历遇symlink (0.1ms) # x' }]);
  assert.equal(other.verdict, 'fail');
  assert.deepEqual(skipListProblems([{ name: 'a', file: 'f', why: 'w' }, { name: 'a', file: 'f', why: 'w' }, { name: 'b' }]).length, 3);
});

test('V18-05 失败的 todo:点名 todoFail 的项有一条没转绿就不过;通过的 todo 不算', () => {
  const out = ['⚠ 甲 (0.7ms) # 产品问题:x', '✔ 乙 (1ms) # 现状不成立但已经转绿', '⚠ 测试文件进程异常：a.test.mjs（第 1 次）', '⚠ 甲 (0.7ms) # 产品问题:x', 'ℹ todo 2'].join('\n');
  assert.deepEqual(parseFailingTodos(out).map((x) => x.name), ['甲']);
  assert.equal(judge({ pass: { exit: 0, todoFail: true } }, [{ exitCode: 0, output: out }]).verdict, 'fail');
  assert.match(judge({ pass: { exit: 0, todoFail: true } }, [{ exitCode: 0, output: out }]).reasons.join(), /1 条 todo.*甲/);
  assert.equal(judge({ pass: { exit: 0 } }, [{ exitCode: 0, output: out }]).verdict, 'pass', '没点名的项(如全量测试)不因 todo 变红,只在 failingTodos 里记着');
});

test('V18-06 真清单:合格、38 行每行都有项、引用的文件在(等分支合入的单列)、每项写明在哪能跑', () => {
  assert.deepEqual(validateManifest(ITEMS, { rowIds: V18_ROW_IDS }), []);
  assert.equal(ROWS.length, 38);
  const cov = v18CoverageCheck(ROWS, ITEMS, (f) => fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(cov.uncoveredRows, []);
  assert.deepEqual(cov.missingFiles, [], '非「等分支合入」的项引用的文件要在仓库里');
  assert.deepEqual(cov.unknownRows, []);
  for (const w of cov.waitingFiles) assert.ok(w.waitFor, `${w.item} 缺文件却没写 waitFor`);
  for (const x of ITEMS.filter((i) => i.category === 'V18')) {
    assert.ok(['local', 'installer', 'node', 'network', 'manual', 'wait', 'na'].includes(whereOf(x)), x.id);
    assert.ok(x.rows.length >= 1, x.id);
  }
  // 老清单(0.7.17 以前)不是 V18 类,它们的 rows 只来自 OLD_ITEM_ROWS
  for (const x of ITEMS.filter((i) => i.category !== 'V18' && i.rows)) for (const r of x.rows) assert.ok(V18_ROW_IDS.has(r), `${x.id} → ${r}`);
});

test('V18-07 G0-2 的跳过名单:每条写全,平台限定的写明;跳过上限 2 的旧写法没了', () => {
  assert.deepEqual(skipListProblems(G0_2_SKIPS), []);
  assert.ok(G0_2_SKIPS.every((s) => ['平台不符', '缺外部依赖', '本来该跑却被无声跳过'].includes(s.kind)), '每条要归类');
  const g = ITEMS.find((x) => x.id === 'G0-2');
  assert.equal(g.pass.limits.skipped, undefined, '不再是「skipped ≤ 数字」');
  assert.equal(g.pass.skipAllow, G0_2_SKIPS);
  assert.deepEqual(g.requiresEnv, ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE']);
  // 被无声跳过的那一条,清单里另有一项专门把它跑一遍
  assert.ok(ITEMS.some((x) => x.id === 'G0-6' && x.env?.PC_STAGE_TEST_URL));
});

test('V18-08 filesOfCommand:取脚本与测试文件,不取占位符和通配', () => {
  assert.deepEqual(filesOfCommand(['node', 'scripts/test-suite.mjs', 'server/test/a.test.mjs', 'server/test/*.test.mjs', '{item}/x.mjs', '--out', 'docs/x.md']), ['scripts/test-suite.mjs', 'server/test/a.test.mjs']);
});

test('V18-09 运行器子进程:--rows-map 列 38 行;--rows-from 用已有结果出结论表并写 Markdown;--check-coverage 通过', { timeout: 120_000 }, () => {
  const run = (args) => spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 100_000 });
  const m = run(['--rows-map']);
  assert.equal(m.status, 0, m.stderr);
  for (const r of V18_ROWS) assert.ok(m.stdout.includes(r.id), r.id);
  assert.ok(!m.stdout.includes('(没有清单项!)'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-v18-rows-'));
  try {
    const results = path.join(dir, 'results.json');
    fs.writeFileSync(results, JSON.stringify({ meta: { commit: 'abc', host: 'h', startedAt: 's', finishedAt: 'f' }, items: [{ id: 'G0-1', verdict: 'pass' }, { id: 'V18-auth-start-page', verdict: 'fail', reasons: ['坏'] }] }));
    const r = run(['--rows-from', results, '--out', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0\.7\.18 验收 38 行:通过 0、失败 \d+、未跑 \d+、不适用 2/);
    const md = fs.readFileSync(path.join(dir, 'rows-table.md'), 'utf8');
    assert.match(md, /\| 2\.1-21 \|[^\n]*\*\*失败\*\*/);
    assert.ok(fs.existsSync(path.join(dir, 'rows-table.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const c = run(['--check-coverage']);
  assert.equal(c.status, 0, c.stdout.slice(-1500));
  assert.match(c.stdout, /守门:通过/);
});
