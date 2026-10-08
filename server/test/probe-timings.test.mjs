/**
 * 探针共用的耗时记录件(scripts/probes/probe-timings.mjs)的单测。
 * 规则见 docs/semantics/guide_files/verification.md「耗时只记录,不当闸门」:时间数字照量、照写进结果,不决定过不过。
 * 编号 PT-01～。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTimings, parseTimingLines, timingScale, TIMINGS_PREFIX } from '../../scripts/probes/probe-timings.mjs';
import { parseTimingLines as runnerParse } from '../../scripts/acceptance/acceptance-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBES = path.join(ROOT, 'scripts', 'probes');

test('PT-01 record:记数字、单位、原门槛;量不出来记 null;返回记下的值', () => {
  const t = createTimings('p', { scale: 1 });
  assert.equal(t.record('编码 p50', 143.20049, { formerLimit: '≤ 300 ms' }), 143.2);
  assert.equal(t.record('没量到', null), null);
  assert.equal(t.record('不是数', NaN), null);
  assert.equal(t.record('下载', 12.5, { unit: 'MiB/s', note: '最慢一次' }), 12.5);
  assert.deepEqual(t.list, [
    { name: '编码 p50', value: 143.2, unit: 'ms', formerLimit: '≤ 300 ms' },
    { name: '没量到', value: null, unit: 'ms' },
    { name: '不是数', value: null, unit: 'ms' },
    { name: '下载', value: 12.5, unit: 'MiB/s', note: '最慢一次' },
  ]);
});

test('PT-02 TIMINGS 行:探针打的一行,探针这边与运行器那边解析出来的一样', () => {
  const t = createTimings('stream-produce-probe', { scale: 1 });
  t.record('a', 1);
  t.record('b', 2, { formerLimit: '≤ 5 秒' });
  const line = t.line();
  assert.ok(line.startsWith(TIMINGS_PREFIX));
  assert.ok(!line.includes('\n'));
  const out = `别的输出\n${line}\n{"ok":true}\n`;
  const want = [{ probe: 'stream-produce-probe', name: 'a', value: 1, unit: 'ms' }, { probe: 'stream-produce-probe', name: 'b', value: 2, unit: 'ms', formerLimit: '≤ 5 秒' }];
  assert.deepEqual(parseTimingLines(out), want);
  assert.deepEqual(runnerParse(out), want);
  const printed = [];
  t.print((s) => printed.push(s));
  assert.deepEqual(printed, [line]);
});

test('PT-03 PC_PROBE_TIMING_SCALE:把记下的数字放大(证明时间不是闸门时用),记录里标 scaled', () => {
  assert.equal(timingScale({}), 1);
  assert.equal(timingScale({ PC_PROBE_TIMING_SCALE: '1000' }), 1000);
  assert.equal(timingScale({ PC_PROBE_TIMING_SCALE: '-3' }), 1);
  assert.equal(timingScale({ PC_PROBE_TIMING_SCALE: 'abc' }), 1);
  const t = createTimings('p', { scale: 1000 });
  assert.equal(t.record('编码 p50', 143, { formerLimit: '≤ 300 ms' }), 143000);
  assert.deepEqual(t.list, [{ name: '编码 p50', value: 143000, unit: 'ms', formerLimit: '≤ 300 ms', scaled: 1000 }]);
});

test('PT-04 merge:把子进程结果行带回来的记录并进来,坏的跳过', () => {
  const t = createTimings('p', { scale: 1 });
  t.merge([{ name: 'x', value: 1, unit: 'ms' }, null, { value: 2 }, 'str']);
  t.merge(undefined);
  assert.deepEqual(t.list, [{ name: 'x', value: 1, unit: 'ms' }]);
});

test('PT-05 改成只记录的探针都接了 probe-timings,并且会打 TIMINGS 行', () => {
  const probes = [
    'ready-index-probe', 'stream-produce-probe', 'preview-fallback-probe', 'c10-browser-probe', 'online-stage-watch-probe', 'online-stage-handshake-probe',
    'm7-browser-probe', 'tier-switch-probe', 'sound-preview-probe', 'hosted-render-probe',
    'online-user-cards-probe', 'custom-measure-probe', 'storage-ui-probe', 'card-sync-probe', 'online-card-exec-probe', 'online-card-sound-probe',
    'cloud-agent-isolation-probe', 'cloud-agent-run-probe', 'cloud-agent-ui-probe', 'cloud-agent-ux-probe', 'cloud-agent-ux-ui-probe',
  ];
  for (const name of probes) {
    const src = fs.readFileSync(path.join(PROBES, `${name}.mjs`), 'utf8');
    assert.match(src, /from '\.\/probe-timings\.mjs'/, `${name} 没引 probe-timings`);
    assert.match(src, /\.record\(/, `${name} 没有记录耗时`);
    assert.ok(/\.print\(\)|TIMINGS_PREFIX|\.line\(\)/.test(src), `${name} 没打 TIMINGS 行`);
    assert.ok(!/待笔记本复核|--timing-authoritative|性能基准机/.test(src.replace(/原来[^\n]*已去掉[^\n]*/g, '')), `${name} 还带着按笔记本判的说法`);
  }
});

test('PT-06 m7 探针:没有 W7 这一项、没有退出码 3、没有「待复核」的 pending', () => {
  const src = fs.readFileSync(path.join(PROBES, 'm7-browser-probe.mjs'), 'utf8');
  const ids = /const ITEM_IDS = \[([^\]]+)\]/.exec(src)[1];
  assert.ok(!ids.includes('W7'));
  assert.ok(!/book\.(part|judge|pending)\('W7'/.test(src));
  assert.ok(!/exitCode = [^;]*\? 1 : 3/.test(src));
  assert.match(src, /process\.exitCode = final\.ok \? 0 : 1/);
  assert.ok(!src.includes('book.timed('));
});

test('PT-07 真的起一个子进程:放大 1000 倍后数字远超原门槛,进程照样以 0 退出(时间不影响退出码)', { timeout: 60_000 }, () => {
  // 一段最小的「探针」:量一个数、记下来、功能断言通过 → 退出码只看功能断言
  const lib = pathToFileURL(path.join(PROBES, 'probe-timings.mjs')).href;
  const code = `import { createTimings } from ${JSON.stringify(lib)};const t=createTimings('mini');const fails=[];const p50=t.record('编码 p50',143,{formerLimit:'≤ 300 ms'});t.print();console.log(JSON.stringify({ok:fails.length===0,fails,p50}));process.exit(fails.length?1:0);`;
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  const plain = run({ PC_PROBE_TIMING_SCALE: '' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(parseTimingLines(plain.stdout)[0].value, 143);
  const scaled = run({ PC_PROBE_TIMING_SCALE: '1000' });
  assert.equal(scaled.status, 0, scaled.stderr);
  const got = parseTimingLines(scaled.stdout)[0];
  assert.equal(got.value, 143000);
  assert.equal(got.scaled, 1000);
  assert.ok(got.value > 300, '远超原门槛 300 ms');
});
