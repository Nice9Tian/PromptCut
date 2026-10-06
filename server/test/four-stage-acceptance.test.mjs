/**
 * 四段最终验收运行器(scripts/acceptance/)的单测:命令行解析、清单格式校验、选取与续跑、判定、占位符、覆盖矩阵,
 * 以及一份假清单跑真的子进程流程(判定、重跑定稳定性、断点续跑、提交哈希变了拒绝续跑)。
 * 编号 FSA-01～:每条用例名里带编号,便于对账。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, validateManifest, selectItems, planResume, judge, combineAttempts, expandPlaceholders, expandCmd,
  lastJsonObject, shiftPorts, globToRegExp, matchesToken, coverageReport, taskMatrix, summaryText, listText, CATEGORIES,
} from '../../scripts/acceptance/acceptance-lib.mjs';
import { ITEMS, EXCLUDED_PROBE_FILES, TASK_ACCEPTANCE } from '../../scripts/acceptance/four-stage-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'acceptance', 'four-stage-acceptance.mjs');

const base = (over = {}) => ({
  id: 'T-1', name: '示例', category: 'G0', taskRef: '任务书一 第 1 条', cmd: ['node', '-e', '0'], pass: { exit: 0 }, ...over,
});

/* ---------------------------------------------------------------- 命令行 */

test('FSA-01 parseArgs:缺省值与各选项', () => {
  const d = parseArgs([]);
  assert.equal(d.devPort, 5690);
  assert.equal(d.devMainPort, 5693);
  assert.equal(d.mainRef, 'main');
  assert.equal(d.resume, false);
  assert.deepEqual(d.only, []);
  const o = parseArgs(['--only', 'G0,GR-*', '--only', '探针', '--from', 'GR-4', '--out', 'x', '--resume', '--flaky-rerun', '2', '--main-ref', 'abc', '--dev-port', '5700', '--include-optional', '--dry-run', '--keep-main-worktree']);
  assert.deepEqual(o.only, ['G0', 'GR-*', '探针']);
  assert.equal(o.from, 'GR-4');
  assert.equal(o.resume, true);
  assert.equal(o.flakyRerun, 2);
  assert.equal(o.mainRef, 'abc');
  assert.equal(o.devPort, 5700);
  assert.equal(o.includeOptional, true);
  assert.equal(o.dryRun, true);
  assert.equal(o.keepMainWorktree, true);
});

test('FSA-02 parseArgs:坏参数都给可读的中文错误', () => {
  assert.throws(() => parseArgs(['--nope']), /看不懂的参数/);
  assert.throws(() => parseArgs(['--only']), /缺少参数/);
  assert.throws(() => parseArgs(['--only', '--resume']), /缺少参数/);
  assert.throws(() => parseArgs(['--resume']), /要同时给 --out/);
  assert.throws(() => parseArgs(['--flaky-rerun', '99']), /0～10/);
  assert.throws(() => parseArgs(['--flaky-rerun', 'x']), /0～10/);
  assert.throws(() => parseArgs(['--dev-port', '80']), /端口号/);
  assert.doesNotThrow(() => parseArgs(['--resume', '--out', 'd']));
});

/* ---------------------------------------------------------------- 清单校验 */

test('FSA-03 validateManifest:真清单合格', () => {
  assert.deepEqual(validateManifest(ITEMS), []);
});

test('FSA-04 validateManifest:逐项抓错', () => {
  const bad = (item, re, extra = []) => {
    const errs = validateManifest([base(), ...extra, item]);
    assert.ok(errs.some((e) => re.test(e)), `${re} 没抓到,得到 ${JSON.stringify(errs)}`);
  };
  bad(base({ id: 'T-1' }), /编号重复/);
  bad(base({ id: 'T 2' }), /编号不合法/);
  bad(base({ id: 'T-2', category: '别的' }), /类别/);
  bad(base({ id: 'T-2', taskRef: '' }), /taskRef/);
  bad(base({ id: 'T-2', name: ' ' }), /缺名字/);
  bad(base({ id: 'T-2', cmd: undefined }), /既没有命令/);
  bad(base({ id: 'T-2', cmd: 'node x' }), /字符串数组/);
  bad(base({ id: 'T-2', cmd: ['node', 3] }), /字符串数组/);
  bad(base({ id: 'T-2', steps: [['node']] }), /cmd 与 steps 只能写一个/);
  bad(base({ id: 'T-2', pass: undefined }), /缺 pass/);
  bad(base({ id: 'T-2', pass: { must: ['('] } }), /不是合法正则/);
  bad(base({ id: 'T-2', pass: { limits: { n: { max: 1 } } } }), /没有对应的 metrics/);
  bad(base({ id: 'T-2', pass: { metrics: { n: 'x' }, limits: { n: {} } } }), /eq \/ max \/ min/);
  bad(base({ id: 'T-2', timing: 'laptop' }), /timingNote/);
  bad(base({ id: 'T-2', timing: 'yes' }), /timing 只能是/);
  bad(base({ id: 'T-2', needs: ['redis'] }), /needs 只能是/);
  bad(base({ id: 'T-2', prereq: ['不存在'] }), /prereq/);
  bad(base({ id: 'T-2', manual: '看图' }), /不能带命令/);
  bad(base({ id: 'T-2', cmd: undefined, pass: undefined, manual: 3 }), /manual 要写明/);
  bad(base({ id: 'T-2', tasks: ['X1'] }), /tasks 要/);
  assert.deepEqual(validateManifest([base({ id: 'T-3', tasks: ['C4a', 'K1', 'J1'] })]), []);
  bad(base({ id: 'T-2', parallel: true }), /parallel 只用于 steps/);
  bad(base({ id: 'T-2', timeoutMin: 999 }), /timeoutMin/);
  bad(base({ id: 'T-2', requiresText: [{ file: 'a' }] }), /requiresText/);
  assert.ok(validateManifest([]).length);
  assert.equal(validateManifest([base({ id: 'M-1', cmd: undefined, pass: undefined, manual: '看图' }), base({ id: 'R-1', cmd: undefined, pass: undefined, remoteOnly: '新节点上验' })]).length, 0);
});

test('FSA-05 清单自洽:prereq 都在、占位符都认得、端口不踩禁区、命令里的脚本存在或标了 requires', () => {
  const known = new Set(['node', 'repo', 'out', 'tsc', 'vite', 'dist', 'main', 'mainWorkspace', 'item', 'dev.origin', 'dev.port', 'dev-main.origin', 'dev-main.port']);
  const forbidden = [[5190, 5192], [5203, 5205], [5210, 5212], [5720, 5839], [8770, 8799]];
  const inForbidden = (n) => forbidden.some(([a, b]) => n >= a && n <= b);
  const ids = new Set(ITEMS.map((i) => i.id));
  for (const it of ITEMS) {
    for (const p of it.prereq || []) assert.ok(ids.has(p), `${it.id} 的 prereq ${p}`);
    const cmds = it.cmd ? [it.cmd] : (it.steps || []).map((s) => s.cmd || s);
    for (const c of cmds) {
      for (const part of c) {
        for (const m of part.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)) assert.ok(known.has(m[1]), `${it.id} 用了不认识的占位符 ${m[0]}`);
      }
      c.forEach((part, i) => {
        if (/^--[a-z-]*port(-[a-z])?$/.test(part) || part === '--online-base') {
          const n = Number(c[i + 1]);
          assert.ok(Number.isInteger(n), `${it.id} ${part} 不是数字`);
          assert.ok(!inForbidden(n), `${it.id} 的端口 ${n} 踩了禁区`);
        }
        const m = /^scripts\/[\w./-]+\.(mjs|cjs)$/.exec(part);
        if (m) assert.ok(fs.existsSync(path.join(ROOT, part)) || (it.requires || []).includes(part), `${it.id} 的 ${part} 既不存在也没写 requires`);
      });
    }
    if (it.cwd) assert.equal(it.cwd, 'main');
  }
});

test('FSA-06 任务书的每一条编号验收都至少被清单里一项覆盖', () => {
  const all = [...TASK_ACCEPTANCE.R, ...TASK_ACCEPTANCE.C, ...TASK_ACCEPTANCE.U, ...TASK_ACCEPTANCE.N];
  assert.equal(TASK_ACCEPTANCE.R.length, 25);
  assert.equal(TASK_ACCEPTANCE.C.length, 13);
  assert.equal(TASK_ACCEPTANCE.U.length, 6);
  assert.deepEqual(TASK_ACCEPTANCE.N, ['J1', 'K1', 'C4a', 'C4b', 'C4c', 'C8a', 'C8b', 'C8c']);
  const m = taskMatrix(ITEMS, all);
  assert.deepEqual(m.uncovered, []);
  // 每个类别都有项,且都是合法类别
  for (const it of ITEMS) assert.ok(CATEGORIES.includes(it.category));
  for (const c of CATEGORIES) assert.ok(ITEMS.some((it) => it.category === c), `类别 ${c} 没有项`);
});

test('FSA-07 清单里带耗时门槛的项都写了门槛,只能在新节点上验的项不带命令', () => {
  for (const it of ITEMS) {
    if (it.timing === 'laptop') assert.ok(it.timingNote);
    if (it.realModel) assert.ok(it.remoteOnly, `${it.id}:真实模型的行写在 remoteOnly 里`);
    if (it.remoteOnly) { assert.ok(!it.cmd && !it.steps, it.id); assert.ok(typeof it.remoteOnly === 'string' && it.remoteOnly.length > 10); }
    if (it.manual) assert.ok(!it.cmd && !it.steps, it.id);
  }
  assert.ok(ITEMS.filter((i) => i.timing === 'laptop').length >= 8);
  assert.ok(ITEMS.filter((i) => i.remoteOnly).length >= 8);
});

/* ---------------------------------------------------------------- 选取与续跑 */

const SAMPLE = [
  base({ id: 'G0-1', category: 'G0' }),
  base({ id: 'GR-1', category: 'G0-R' }),
  base({ id: 'GR-2', category: 'G0-R' }),
  base({ id: 'P-a', category: '探针' }),
  base({ id: 'X-b', category: '探针', optional: true }),
  base({ id: 'S1-1', category: '第一段' }),
];

test('FSA-08 selectItems:编号、通配、类别、--from;可选项缺省不跑;拼错的记号抛错', () => {
  assert.deepEqual(selectItems(SAMPLE).map((i) => i.id), ['G0-1', 'GR-1', 'GR-2', 'P-a', 'S1-1']);
  assert.deepEqual(selectItems(SAMPLE, { includeOptional: true }).map((i) => i.id).length, 6);
  assert.deepEqual(selectItems(SAMPLE, { only: ['G0-R'] }).map((i) => i.id), ['GR-1', 'GR-2']);
  assert.deepEqual(selectItems(SAMPLE, { only: ['GR-*'] }).map((i) => i.id), ['GR-1', 'GR-2']);
  assert.deepEqual(selectItems(SAMPLE, { only: ['X-b'] }).map((i) => i.id), ['X-b']);
  assert.deepEqual(selectItems(SAMPLE, { only: ['G0', 'S1-1'] }).map((i) => i.id), ['G0-1', 'S1-1']);
  assert.deepEqual(selectItems(SAMPLE, { from: 'GR-2' }).map((i) => i.id), ['GR-2', 'P-a', 'S1-1']);
  assert.deepEqual(selectItems(SAMPLE, { only: ['探针'], from: 'P-a' }).map((i) => i.id), ['P-a', 'X-b']);
  assert.throws(() => selectItems(SAMPLE, { only: ['G0-9'] }), /没有这个编号或类别/);
  assert.throws(() => selectItems(SAMPLE, { from: 'nope' }), /没有这个编号/);
  assert.ok(globToRegExp('GR-*').test('GR-12'));
  assert.ok(!globToRegExp('GR-*').test('XGR-1'));
  assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'));
  assert.ok(matchesToken(SAMPLE[0], 'G0') && matchesToken(SAMPLE[0], 'G0-1') && !matchesToken(SAMPLE[0], 'G0-R'));
});

test('FSA-09 planResume:已过的跳过,不过的、缺的、没跑过的重跑;不续跑时全跑', () => {
  const prev = [
    { id: 'G0-1', verdict: 'pass' }, { id: 'GR-1', verdict: 'ref-pass' }, { id: 'GR-2', verdict: 'fail' },
    { id: 'P-a', verdict: 'missing' }, { id: 'S1-1', verdict: 'flaky' },
  ];
  const sel = SAMPLE.filter((i) => !i.optional);
  const p = planResume(sel, prev, { resume: true });
  assert.deepEqual(p.skip.map((s) => s.item.id), ['G0-1', 'GR-1']);
  assert.deepEqual(p.run.map((i) => i.id), ['GR-2', 'P-a', 'S1-1']);
  assert.equal(planResume(sel, prev, { resume: false }).run.length, 5);
  assert.equal(planResume(sel, null, { resume: true }).run.length, 5);
  assert.deepEqual(planResume([...sel, base({ id: 'new' })], prev, { resume: true }).run.map((i) => i.id).slice(-1), ['new']);
});

/* ---------------------------------------------------------------- 判定 */

const run1 = (o) => [{ exitCode: 0, output: '', ...o }];

test('FSA-10 judge:退出码、must、mustNot', () => {
  const it = base({ pass: { exit: 0, must: ['^PASS$'], mustNot: ['ERROR'] } });
  assert.equal(judge(it, run1({ output: 'x\nPASS\n' })).verdict, 'pass');
  assert.equal(judge(it, run1({ output: 'x\nPASS\r\n' })).verdict, 'pass');
  const r = judge(it, run1({ output: 'x\n' }));
  assert.equal(r.verdict, 'fail');
  assert.match(r.reasons[0], /没有/);
  assert.equal(judge(it, run1({ exitCode: 1, output: 'PASS' })).verdict, 'fail');
  assert.equal(judge(it, run1({ output: 'PASS\nERROR boom' })).verdict, 'fail');
  assert.equal(judge(base({ pass: { exit: [0, 3] } }), run1({ exitCode: 3 })).verdict, 'pass');
  assert.equal(judge(base({ pass: { exit: [0, 3] } }), run1({ exitCode: 1 })).verdict, 'fail');
  assert.equal(judge(base({ pass: { exit: 2 } }), run1({ exitCode: 0 })).verdict, 'fail');
});

test('FSA-11 judge:超时、空闲被杀、起不来都是不过,原因写明', () => {
  assert.match(judge(base(), run1({ exitCode: null, timedOut: true })).reasons.join(), /超时/);
  assert.match(judge(base(), run1({ exitCode: null, idleKilled: 12 })).reasons.join(), /12分钟没有输出/);
  assert.match(judge(base(), run1({ exitCode: null, spawnError: 'ENOENT' })).reasons.join(), /起不来:ENOENT/);
});

test('FSA-12 judge:metrics 与 limits(npm test 的失败数、跳过数)', () => {
  const it = base({ pass: { exit: 0, metrics: { tests: 'ℹ tests (\\d+)', fail: 'ℹ fail (\\d+)', skipped: 'ℹ skipped (\\d+)' }, limits: { fail: { eq: 0 }, skipped: { max: 2 }, tests: { min: 100 } } } });
  const ok = judge(it, run1({ output: 'ℹ tests 4468\nℹ pass 4467\nℹ fail 0\nℹ skipped 1\n' }));
  assert.equal(ok.verdict, 'pass');
  assert.equal(ok.metrics.tests, 4468);
  assert.equal(judge(it, run1({ output: 'ℹ tests 4468\nℹ fail 1\nℹ skipped 1\n' })).verdict, 'fail');
  assert.equal(judge(it, run1({ output: 'ℹ tests 4468\nℹ fail 0\nℹ skipped 3\n' })).verdict, 'fail');
  assert.equal(judge(it, run1({ output: 'ℹ tests 50\nℹ fail 0\nℹ skipped 0\n' })).verdict, 'fail');
  assert.match(judge(it, run1({ output: 'nothing' })).reasons.join(), /没抓到/);
  // 取最后一次出现(重跑时前面还有第一次的汇总)
  assert.equal(judge(it, run1({ output: 'ℹ tests 4468\nℹ fail 2\nℹ skipped 0\n---\nℹ tests 4468\nℹ fail 0\nℹ skipped 0\n' })).verdict, 'pass');
});

test('FSA-13 judge:结果行里 fails 非空或 ok:false,即使退出码是 0 也不过', () => {
  assert.equal(judge(base(), run1({ output: '{"ok":true,"fails":[]}' })).verdict, 'pass');
  const r = judge(base(), run1({ output: 'log\n{"ok":true,"fails":["A5 超时"]}\n' }));
  assert.equal(r.verdict, 'fail');
  assert.match(r.reasons.join(), /fails 非空/);
  assert.equal(judge(base(), run1({ output: '{"ok":false}' })).verdict, 'fail');
  // 缩进打印的 JSON 也认
  assert.equal(judge(base(), run1({ output: '{\n  "fails": [\n    "x"\n  ]\n}\nFAIL 1' })).verdict, 'fail');
  assert.equal(judge(base(), run1({ output: '{\n  "fails": []\n}\nPASS' })).verdict, 'pass');
  // strictJson:false 关掉
  assert.equal(judge(base({ pass: { exit: 0, strictJson: false } }), run1({ output: '{"fails":["x"]}' })).verdict, 'pass');
});

test('FSA-14 judge:带耗时门槛的项在 PC 上记 ref-pass / ref-fail', () => {
  const it = base({ timing: 'laptop', timingNote: 'p50 ≤ 300 ms' });
  assert.equal(judge(it, run1({})).verdict, 'ref-pass');
  assert.equal(judge(it, run1({ exitCode: 1 })).verdict, 'ref-fail');
  // 笔记本(--authoritative)上按过 / 不过判
  assert.equal(judge(it, run1({}), { authoritative: true }).verdict, 'pass');
  assert.equal(judge(it, run1({ exitCode: 1 }), { authoritative: true }).verdict, 'fail');
  assert.equal(parseArgs(['--authoritative']).authoritative, true);
});

test('FSA-15 judge:多步的项,每一步都要过;结果行取输出里最后的 JSON,没有就取最后一行', () => {
  const it = base({ cmd: undefined, steps: [['a'], ['b']] });
  assert.equal(judge(it, [{ exitCode: 0, output: 'x' }, { exitCode: 0, output: 'y' }]).verdict, 'pass');
  const r = judge(it, [{ exitCode: 0, output: 'x' }, { exitCode: 2, output: 'y' }]);
  assert.equal(r.verdict, 'fail');
  assert.match(r.reasons[0], /第 2 步/);
  assert.equal(judge(base(), run1({ output: 'a\nlast line\n\n' })).resultLine, 'last line');
  assert.equal(judge(base({ pass: { exit: 0, resultLine: '^结论' } }), run1({ output: '结论 A\n别的\n' })).resultLine, '结论 A');
  assert.equal(judge(base(), run1({ output: '\u001b[32mgreen\u001b[0m' })).resultLine, 'green');
});

test('FSA-16 combineAttempts:全过、全不过、有过有不过(flaky)', () => {
  assert.deepEqual(combineAttempts([{ verdict: 'pass' }]), { verdict: 'pass', stability: null });
  assert.deepEqual(combineAttempts([{ verdict: 'pass' }, { verdict: 'pass' }]), { verdict: 'pass', stability: '2/2' });
  assert.deepEqual(combineAttempts([{ verdict: 'fail' }, { verdict: 'fail' }, { verdict: 'fail' }]), { verdict: 'fail', stability: '0/3' });
  assert.deepEqual(combineAttempts([{ verdict: 'fail' }, { verdict: 'pass' }]), { verdict: 'flaky', stability: '1/2' });
  assert.deepEqual(combineAttempts([{ verdict: 'ref-fail' }, { verdict: 'ref-pass' }]), { verdict: 'ref-fail', stability: '1/2' });
});

/* ---------------------------------------------------------------- 占位符与小工具 */

test('FSA-17 expandPlaceholders:展开、缺的抛错', () => {
  assert.equal(expandPlaceholders('{dev.origin}/?export=1', { 'dev.origin': 'http://127.0.0.1:5690' }), 'http://127.0.0.1:5690/?export=1');
  assert.deepEqual(expandCmd(['node', '{tsc}', '-b'], { tsc: 'C:\\x\\tsc' }), ['node', 'C:\\x\\tsc', '-b']);
  assert.throws(() => expandPlaceholders('{nope}', {}), /占位符 \{nope\} 没有值/);
  assert.equal(expandPlaceholders('无占位符', {}), '无占位符');
  assert.equal(expandPlaceholders(7, {}), 7);
});

test('FSA-18 lastJsonObject:单行、缩进、取最后一个、取不到返回 null', () => {
  assert.deepEqual(lastJsonObject('a\n{"a":1}\nb\n{"b":2}\n').value, { b: 2 });
  assert.deepEqual(lastJsonObject('{\n "x": {"y": [1,2]}\n}\nPASS').value, { x: { y: [1, 2] } });
  assert.equal(lastJsonObject('no json {here'), null);
  assert.equal(lastJsonObject('[1,2]'), null);
});

test('FSA-19 coverageReport:没登记也没排除的探针会被列出', () => {
  const items = [{ covers: ['a-probe.mjs'] }, { covers: ['b-probe.mjs', 'gone.mjs'] }];
  const rep = coverageReport(['a-probe.mjs', 'b-probe.mjs', 'c-probe.mjs', 'lib.mjs'], items, { 'lib.mjs': '公共件', 'old.mjs': '没了' });
  assert.deepEqual(rep.unlisted, ['c-probe.mjs']);
  assert.deepEqual(rep.staleExcluded, ['old.mjs']);
  assert.deepEqual(rep.staleCovers, ['gone.mjs']);
});

test('FSA-20 summaryText 与 listText 不出错、带关键信息', () => {
  const items = [
    { id: 'G0-1', name: 'tsc', category: 'G0', verdict: 'pass', durationSec: 5, resultLine: '', logs: ['logs/G0-1.log'] },
    { id: 'GR-7', name: 'stream', category: 'G0-R', verdict: 'ref-fail', reasons: ['退出码 1'], resultLine: '{"fails":["x"]}', logs: [], known: '已知问题' },
    { id: 'P-1', name: 'flaky', category: '探针', verdict: 'flaky', stability: '1/2', reasons: [], logs: [] },
  ];
  const t = summaryText({ meta: { startedAt: 'a', finishedAt: 'b', commit: 'abc' }, items });
  assert.match(t, /✓ G0-1/);
  assert.match(t, /≉ GR-7/);
  assert.match(t, /稳定性1\/2/);
  assert.match(t, /已知问题/);
  const l = listText(ITEMS);
  assert.match(l, /GR-3/);
  assert.match(l, /笔记本复核/);
  assert.match(l, /只能在新节点上验/);
});

/* ---------------------------------------------------------------- 真的子进程流程(假清单) */

function writeFakeManifest(dir) {
  const items = [
    { id: 'T-pass', name: '会过', category: 'G0', taskRef: '测试', cmd: ['node', '-e', 'console.log(JSON.stringify({ok:true,fails:[]}))'], pass: { exit: 0 } },
    { id: 'T-fail', name: '会挂', category: 'G0', taskRef: '测试', cmd: ['node', '-e', 'console.log("boom");process.exit(1)'], pass: { exit: 0 }, known: '已知会挂' },
    { id: 'T-flaky', name: '第一次挂第二次起过', category: 'G0-R', taskRef: '测试', cmd: ['node', '-e', 'const fs=require("fs");const f=process.argv[1];let n=0;try{n=+fs.readFileSync(f,"utf8")}catch{}fs.writeFileSync(f,String(n+1));process.exit(n===0?1:0)', '{out}/counter'], pass: { exit: 0 } },
    { id: 'T-timing', name: '带耗时门槛', category: 'G0-R', taskRef: '测试', timing: 'laptop', timingNote: 'p50 ≤ 300 ms', cmd: ['node', '-e', '0'], pass: { exit: 0 } },
    { id: 'T-json', name: '退出 0 但 fails 非空', category: '探针', taskRef: '测试', cmd: ['node', '-e', 'console.log(JSON.stringify({fails:["x"]}))'], pass: { exit: 0 } },
    { id: 'T-steps', name: '两步并行', category: '探针', taskRef: '测试', parallel: true, steps: [{ cmd: ['node', '-e', 'console.log("s1")'] }, { cmd: ['node', '-e', 'console.log("s2")'] }], pass: { exit: 0, must: ['s1', 's2'] } },
    { id: 'T-blocked', name: '前置没过', category: '探针', taskRef: '测试', prereq: ['T-fail'], cmd: ['node', '-e', '0'], pass: { exit: 0 } },
    { id: 'T-missing', name: '缺文件', category: '第二段', taskRef: '测试', requires: ['scripts/probes/不存在的探针.mjs'], cmd: ['node', 'scripts/probes/不存在的探针.mjs'], pass: { exit: 0 } },
    { id: 'T-manual', name: '人工', category: '第三段', taskRef: '测试', manual: '看图' },
    { id: 'T-remote', name: '只能在新节点上验', category: '第四段', taskRef: '测试', remoteOnly: '在新节点上跑探针看结果' },
    { id: 'T-optional', name: '补充项', category: '探针', taskRef: '测试', optional: true, cmd: ['node', '-e', '0'], pass: { exit: 0 } },
    { id: 'T-idle', name: '没输出被杀', category: '探针', taskRef: '测试', idleKillMin: 0.02, timeoutMin: 1, cmd: ['node', '-e', 'setTimeout(()=>{},60000)'], pass: { exit: 0 } },
  ];
  const file = path.join(dir, 'fake-manifest.mjs');
  fs.writeFileSync(file, `export const ITEMS = ${JSON.stringify(items, null, 2)};\nexport const EXCLUDED_PROBE_FILES = {};\nexport const TASK_ACCEPTANCE = { R: [], C: [], U: [], N: [] };\n`);
  return file;
}

const runRunner = (manifest, args) => spawnSync(process.execPath, [RUNNER, ...args], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 240_000,
  env: { ...process.env, PC_ACCEPTANCE_MANIFEST: manifest },
});

test('FSA-21 假清单跑真的子进程:判定、重跑定稳定性、进程清理、日志与 results.json', { timeout: 300_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsa-'));
  try {
    const manifest = writeFakeManifest(dir);
    const out = path.join(dir, 'out');
    const r = runRunner(manifest, ['--out', out, '--flaky-rerun', '1', '--only', 'T-pass,T-fail,T-flaky,T-timing,T-json,T-steps,T-blocked,T-missing,T-manual,T-remote,T-idle']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    const by = Object.fromEntries(res.items.map((i) => [i.id, i]));
    assert.equal(by['T-pass'].verdict, 'pass');
    assert.equal(by['T-fail'].verdict, 'fail');
    assert.equal(by['T-fail'].stability, '0/2');
    assert.equal(by['T-flaky'].verdict, 'flaky');
    assert.equal(by['T-flaky'].stability, '1/2');
    assert.equal(by['T-timing'].verdict, 'ref-pass');
    assert.equal(by['T-json'].verdict, 'fail');
    assert.match(by['T-json'].reasons.join(), /fails 非空/);
    assert.equal(by['T-steps'].verdict, 'pass');
    assert.equal(by['T-steps'].logs.length, 2);
    assert.equal(by['T-blocked'].verdict, 'blocked');
    assert.equal(by['T-missing'].verdict, 'missing');
    assert.equal(by['T-manual'].verdict, 'manual');
    assert.equal(by['T-remote'].verdict, 'remote');
    assert.equal(by['T-idle'].verdict, 'fail');
    assert.match(by['T-idle'].reasons.join(), /没有输出,被结束/);
    assert.equal(by['T-optional'], undefined, '补充项缺省不跑');
    // 每项各自的日志,里面有命令与输出
    const log = fs.readFileSync(path.join(out, by['T-fail'].logs[0]), 'utf8');
    assert.match(log, /boom/);
    assert.match(log, /退出码 1/);
    assert.ok(fs.existsSync(path.join(out, 'summary.txt')));
    assert.match(fs.readFileSync(path.join(out, 'summary.txt'), 'utf8'), /T-flaky/);
    assert.equal(res.meta.commit.length, 40);
    // 起止时间与退出码
    assert.ok(by['T-pass'].startedAt && by['T-pass'].finishedAt);
    assert.deepEqual(by['T-fail'].exitCodes, [1]);
    assert.equal(by['T-pass'].resultLine, '{"ok":true,"fails":[]}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FSA-22 断点续跑:已过的项不再跑,不稳定与失败的重跑;提交哈希变了拒绝续跑', { timeout: 300_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsa-'));
  try {
    const manifest = writeFakeManifest(dir);
    const out = path.join(dir, 'out');
    const only = 'T-pass,T-fail,T-flaky,T-timing';
    let r = runRunner(manifest, ['--out', out, '--only', only]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    let res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    assert.equal(res.items.find((i) => i.id === 'T-flaky').verdict, 'fail');
    const firstPassStart = res.items.find((i) => i.id === 'T-pass').startedAt;
    // 续跑:T-flaky 的计数器已经是 1,这次会过;T-pass 沿用
    r = runRunner(manifest, ['--out', out, '--only', only, '--resume']);
    assert.match(r.stdout, /将跑 2 项/, r.stdout);
    res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    const by = Object.fromEntries(res.items.map((i) => [i.id, i]));
    assert.equal(by['T-flaky'].verdict, 'pass');
    assert.equal(by['T-pass'].carried, true);
    assert.equal(by['T-pass'].startedAt, firstPassStart);
    assert.equal(by['T-timing'].carried, true);
    assert.equal(by['T-fail'].verdict, 'fail');
    assert.equal(res.items.length, 4);
    // 提交哈希变了:拒绝
    const file = path.join(out, 'results.json');
    res.meta.commit = '0'.repeat(40);
    fs.writeFileSync(file, JSON.stringify(res));
    r = runRunner(manifest, ['--out', out, '--only', only, '--resume']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /结果不能混/);
    r = runRunner(manifest, ['--out', out, '--only', only, '--resume', '--force-resume']);
    assert.match(r.stdout, /将跑/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FSA-23 --list / --matrix / --dry-run 不跑任何命令;--only 拼错退出码 2', { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsa-'));
  try {
    const manifest = writeFakeManifest(dir);
    let r = runRunner(manifest, ['--list']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /T-flaky/);
    assert.match(r.stdout, /共 12 项/);
    r = runRunner(manifest, ['--list', '--json', '--only', 'T-pass']);
    assert.equal(JSON.parse(r.stdout).length, 1);
    r = runRunner(manifest, ['--dry-run', '--out', path.join(dir, 'o2'), '--only', 'T-pass,T-fail']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /将跑 2 项/);
    assert.ok(!fs.existsSync(path.join(dir, 'o2', 'results.json')));
    r = runRunner(manifest, ['--only', '不存在']);
    assert.equal(r.status, 2);
    r = runRunner(manifest, ['--bad']);
    assert.equal(r.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FSA-24 真清单:--list 与 --matrix 能跑,两份任务书的编号一条不缺', { timeout: 120_000 }, () => {
  const run = (args) => spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 100_000 });
  const l = run(['--list']);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, new RegExp(`共 ${ITEMS.length} 项`));
  const m = run(['--matrix']);
  assert.equal(m.status, 0, m.stderr);
  assert.ok(!m.stdout.includes('没有任何项覆盖'));
  assert.match(m.stdout, /R25/);
  assert.match(m.stdout, /U6/);
});

test('FSA-25 --port-shift:端口类参数后的 5xxx 平移,8xxx 与别的参数不动', () => {
  assert.deepEqual(parseArgs(['--port-shift', '-110']).portShift, -110);
  assert.throws(() => parseArgs(['--port-shift', '99999']), /-3000～3000/);
  const cmd = ['node', 'p.mjs', '--port', '5690', '--doc-port', '8760', '--port-b', '5693', '--online-base', '5693', '--iters', '5690', '--origin', 'http://127.0.0.1:5690'];
  assert.deepEqual(shiftPorts(cmd, 0), cmd);
  assert.deepEqual(shiftPorts(cmd, -110), ['node', 'p.mjs', '--port', '5580', '--doc-port', '8760', '--port-b', '5583', '--online-base', '5583', '--iters', '5690', '--origin', 'http://127.0.0.1:5690']);
});
