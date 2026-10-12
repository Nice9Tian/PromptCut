/**
 * remotion 式的卡的建卡检查（`server/remotion-style-check.mjs`）接进建卡、改卡两条路之后的行为。
 * 跑：node scripts/test-suite.mjs server/test/remotion-style.test.mjs
 *
 *   RSC-01  「remotion 式的规矩」每一条各有一张违规的样例卡：建卡时被拒绝，报错指出行号；合规的样例卡通过
 *   RSC-02  给 remotion 式的卡的报错不往 Motion 上引；声明成 motion 式的卡检查和原来一样，一条不多
 *   RSC-03  三道只读的第一道：顶层写了不是常量的东西被拒（逐种写法）
 *   RSC-04  装卡不查：已经在库里的老卡（声明成 remotion 式、按新规矩全是违规）照旧装得上
 *   RSC-05  改卡：框架出现之前建的老卡只拒绝这次新增的违规；用框架写的卡每一条都拒；从 motion 式改成 remotion 式按新建算
 *   RSC-06  内置的 remotion 式的卡（四张）：原样改一处文案能过；新加违规被拒并指出行号；别的内置文件照旧
 *   RSC-07  桌面建卡这条路（`createUserCard`，`/api/cards/create` 调的那个）：违规的 400 并带行号，合规的落盘
 *   RSC-08  渲染节点装同步文件的预检（`source-gate.mjs`）不因为这套规矩变严：用框架写的卡装得上，老卡照旧
 *   RSC-09  看源码查不出来的那一类（谁先加载好）：这类写法确实过得了检查，兜底在别处（见用例里的说明）
 *
 * 云端 Agent 建卡的那条路在 `cloud-agent-tools.test.mjs` 的 CA-HT-03b；在线页面的载入在 `src/online/cardRuntime/remotionLock.test.mjs`；
 * 真 Chrome 里的画面在探针 `scripts/probes/remotion-style-probe.mjs`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

// 这份单测不带改动层：建卡直接写进临时的「检出」
delete process.env.PROMPTCUT_CARD_OVERRIDES;

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const FIX = path.join(ROOT, 'server', 'test', 'fixtures', 'remotion-style');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n');
const repo = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const cards = await import('../vite-plugin-cards.ts');
const { inspectRemotionStyle, remotionStyleErrors, REMOTION_IMPORT_ALLOW } = await import('../remotion-style-check.mjs');
const { checkSyncedSource } = await import('../hosted-render/source-gate.mjs');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

const idOf = (source) => /\bid:\s*"([^"]+)"/.exec(source)[1];
const author = (source, before = '') => cards.checkCardSource(idOf(source), source, [], { mode: 'author', before });
/** 源码里第一次出现 needle 的那一行（1 起） */
const lineOf = (source, needle) => {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `夹具里找不到 ${needle}`);
  return source.slice(0, at).split('\n').length;
};
const remotionLines = (errors) => errors.filter((e) => e.startsWith('[remotion 式] 第 '));

/** 每条规矩一张违规样例：文件、规则代号、违规的那一行里的字样（据此算行号）、报错里该有的字样 */
const VIOLATIONS = [
  { file: 'real-time.tsx', rule: 'real-time', needles: ['performance.now()', 'new Date()'], says: /真实时间/ },
  { file: 'timer.tsx', rule: 'timer', needles: ['setTimeout('], says: /定时器/ },
  { file: 'frame-callback.tsx', rule: 'frame-callback', needles: ['requestAnimationFrame(', 'cancelAnimationFrame('], says: /逐帧回调/ },
  { file: 'motion.tsx', rule: 'motion', needles: ['from "motion/react"', '<motion.div'], says: /Motion/ },
  { file: 'presence.tsx', rule: 'presence', needles: ['<AnimatePresence>'], says: /进出场组件/ },
  { file: 'css-animation.tsx', rule: 'css-animation', needles: ['transition: "opacity', 'className="animate-pulse"', '@keyframes'], says: /CSS 的动画和过渡/ },
  { file: 'random.tsx', rule: 'random', needles: ['Math.random()'], says: /不带种子的随机/ },
  { file: 'state.tsx', rule: 'state', needles: ['useState(0)'], says: /活得比一帧长/ },
  { file: 'state-ref.tsx', rule: 'state', needles: ['useRef(0)', 'frames.current += 1'], says: /活得比一帧长/ },
  { file: 'state-top-write.tsx', rule: 'state', needles: ['COUNTER.frames += 1', 'TRAIL.push(t)'], says: /文件顶层的 (COUNTER|TRAIL)/ },
  { file: 'state-global.tsx', rule: 'state', needles: ['window as'], says: /全局对象/ },
  { file: 'top-level.tsx', rule: 'top-level', needles: ['let frames = 0', 'new Map<'], says: /顶层/ },
  { file: 'import.tsx', rule: 'import', needles: ['from "lottie-web"'], says: /只许引用框架/ },
  { file: 'frame-mode.tsx', rule: 'frame-mode', needles: ['frameMode: MODES[0]'], says: /字面量/ },
];
const COMPLIANT = ['rs-title-reveal.tsx', 'rs-bar-race.tsx', 'rs-orbit-canvas.tsx', 'rs-alias-write.tsx'];

test('RSC-01 每条规矩各有一张违规的样例卡：建卡时被拒绝并指出行号；合规的样例卡通过', () => {
  assert.deepEqual(fs.readdirSync(path.join(FIX, 'violations')).sort(), VIOLATIONS.map((v) => v.file).sort(), '夹具目录里的每个文件都在表里');
  // 「remotion 式的规矩」列的八样，一样不落
  for (const rule of ['real-time', 'timer', 'frame-callback', 'motion', 'presence', 'css-animation', 'random', 'state']) {
    assert.ok(VIOLATIONS.some((v) => v.rule === rule), `缺 ${rule} 的违规样例`);
  }
  for (const v of VIOLATIONS) {
    const source = read(`violations/${v.file}`);
    const r = author(source);
    assert.equal(r.ok, false, `${v.file} 应当被拒绝`);
    const lines = remotionLines(r.errors);
    for (const needle of v.needles) {
      const line = lineOf(source, needle);
      const hit = lines.find((e) => e.startsWith(`[remotion 式] 第 ${line} 行：`));
      assert.ok(hit, `${v.file}：第 ${line} 行（${needle}）应当被指出来。实际：\n${r.errors.join('\n')}`);
    }
    assert.ok(lines.some((e) => v.says.test(e)), `${v.file} 的报错该提到 ${v.says}：\n${lines.join('\n')}`);
    // 除了这一条规矩和它连带的那一条（Motion 的两张样例都要引 motion/react），不该再报别的 remotion 式的规矩
    const found = inspectRemotionStyle(source, { fileName: `src/cards/user/${v.file}` }).violations;
    assert.ok(found.some((x) => x.rule === v.rule), `${v.file} 里没有查出 ${v.rule}`);
    const others = [...new Set(found.map((x) => x.rule))].filter((x) => x !== v.rule && !(v.rule === 'presence' && x === 'motion'));
    assert.deepEqual(others, [], `${v.file} 只该违反 ${v.rule}`);
    // 每一条报错都带行号；不带行号的只有末尾那一句总说明
    for (const e of r.errors.filter((x) => x.startsWith('[remotion 式]'))) {
      assert.ok(/^\[remotion 式\] 第 \d+ 行：/.test(e) || /^\[remotion 式\] 这张卡声明的是 remotion 式/.test(e), e);
    }
  }
  for (const file of COMPLIANT) {
    const r = author(read(file));
    assert.equal(r.ok, true, `${file} 应当通过：\n${r.errors.join('\n')}`);
  }
});

test('RSC-02 给 remotion 式的卡的报错不往 Motion 上引；声明成 motion 式的卡检查和原来一样', () => {
  // 原来的报错里劝人用 Motion 的那几句，在 remotion 式的卡上不许再出现
  const POINTS_TO_MOTION = /交给 motion|用 motion\/react|改用 motion|motion 的 animate|initial \+ animate|装了的是 react、motion/;
  const all = [];
  for (const v of VIOLATIONS) all.push(...author(read(`violations/${v.file}`)).errors);
  // 再补几种会触发审查门那几类笼统发现的写法（没装的库、没定义的动画 class、交互属性）
  const base = read('rs-title-reveal.tsx');
  all.push(...author(base.replace('import type { CardDef', 'import gsap from "gsap";\nimport type { CardDef')).errors);
  all.push(...author(base.replace('<span\n', '<span className="animate-wiggle" whileHover={{ scale: 2 }}\n')).errors);
  all.push(...author(base.replace('const chars =', 'const stamp = Date.now(); setInterval(() => {}, 16); new IntersectionObserver(() => {});\n  const chars =')).errors);
  assert.ok(all.length > 40);
  for (const e of all) assert.doesNotMatch(e, POINTS_TO_MOTION, e);
  // 原来对所有卡出现即拒的三样，在 remotion 式的卡上照样拒，带行号
  const three = author(base.replace('const chars =', 'const stamp = Date.now();\n  setInterval(() => {}, 16);\n  new IntersectionObserver(() => {});\n  const chars ='));
  for (const what of [/第 \d+ 行：读了真实时间（Date\.now\(\)）/, /第 \d+ 行：用了定时器（setInterval）/, /第 \d+ 行：用了 IntersectionObserver/]) assert.match(three.errors.join('\n'), what);

  // motion 式的卡：按 remotion 式的规矩全是违规的写法，照旧通过
  const stateful = `import { motion, AnimatePresence, useSpring } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
let mounts = 0;
const cache = new Map<string, number>();
function C({ params }: CardProps<Params>) {
  const [n, setN] = useState(0);
  const seen = useRef(0);
  seen.current += 1;
  mounts += 1;
  const x = useSpring(0);
  useEffect(() => { const id = requestAnimationFrame(() => setN(Math.random() + performance.now())); return () => cancelAnimationFrame(id); }, []);
  return <AnimatePresence><motion.div className="transition-all animate-pulse" style={{ x, transition: "opacity 1s" }} animate={{ opacity: 1 }}>{params.text}{n}{cache.size}</motion.div></AnimatePresence>;
}
export const card: CardDef<Params> = {
  id: "old-style", name: "老写法", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;
  const ok = author(stateful);
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.deepEqual(remotionStyleErrors(stateful).errors, []);
  // 它们原来的报错原样：文案一个字没变
  const withTimer = author(stateful.replace('seen.current += 1;', 'seen.current += 1; setTimeout(() => {}, 1); Date.now();'));
  assert.deepEqual(withTimer.errors, [
    '不要用 Date.now():导出时走的是虚拟时间,会和画面对不上。动画交给 motion/react,需要读时间就用组件收到的 t。',
    '不要用 setTimeout / setInterval 驱动动画:导出时它们不受虚拟时钟控制。用 motion/react 的 animate,或读组件参数 t。',
  ]);
  // 旧值 react（代码按有状态读）与认不出的值：不当 remotion 式查
  for (const mode of ['react', 'non-react', 'stateless']) {
    const r = remotionStyleErrors(stateful.replace('"stateful"', `"${mode}"`));
    assert.deepEqual([r.remotionStyle, r.errors], [false, []], mode);
  }
});

test('RSC-03 第一道只读：顶层写了不是常量的东西被拒（逐种写法）；常量的各种写法通过', () => {
  const base = read('rs-bar-race.tsx');
  const withTop = (line) => base.replace('const PALETTE =', `${line}\nconst PALETTE =`);
  const rejected = {
    'let frames = 0;': /顶层写了 let/,
    'var frames = 0;': /顶层写了 var/,
    'const cache = new Map();': /顶层用了 new/,
    'const buf = new Float32Array(8);': /顶层用了 new/,
    'const seen = { n: 0 }, also = new Set();': /顶层用了 new/,
    'class Store { static n = 0 }': /顶层写了 class/,
    'enum Phase { In, Out }': /顶层写了 enum/,
    'console.log("载入了");': /直接执行的语句/,
    'if (typeof document !== "undefined") { document.title = "x"; }': /直接执行的语句/,
    'for (let i = 0; i < 3; i++) {}': /直接执行的语句/,
    'const data = await fetch("/x");': /顶层用了 await/,
    'const K = { n: 0 }; const bump = (K.n = 1);': /初始化式里有赋值/,
  };
  for (const [line, says] of Object.entries(rejected)) {
    const source = withTop(line);
    const r = author(source);
    assert.equal(r.ok, false, line);
    const want = lineOf(source, line);
    assert.ok(remotionLines(r.errors).some((e) => e.startsWith(`[remotion 式] 第 ${want} 行：`) && says.test(e)), `${line}\n${r.errors.join('\n')}`);
  }
  const accepted = [
    'const TAU = Math.PI * 2;',
    'const LABELS = ["一", "二", "三"] as const;',
    'const TABLE = { a: { x: 1, y: [2, 3] }, b: null, c: undefined, d: `文字 ${1 + 1}` };',
    'const SCALE = (v: number) => v * 2;',
    'const DERIVED = PALETTE_SIZE > 3 ? "多" : "少";',
    'const STEPS = Array.from({ length: 5 }, (_, i) => i * 10);',
    'const NAMES = "a|b|c".split("|").map((s) => s.toUpperCase());',
    'const PATTERN = /\\d+/g;',
    'const EASE_IN = Easing.in(Easing.cubic);',
    'type Row = { x: number };\ninterface Extra { y: number }',
    'export const helper = { scale: 2 };',
    'function pick(i: number) { let best = 0; for (let k = 0; k < i; k++) best += k; return best; }',
    '"use strict";',
  ];
  for (const line of accepted) {
    const r = author(withTop(`const PALETTE_SIZE = 4;\n${line}`));
    assert.equal(r.ok, true, `${line}\n${r.errors.join('\n')}`);
  }
});

/** 框架出现之前的写法：声明成 remotion 式，没引用框架，按新规矩有四条违规 */
const OLD_DIRECT = `import { useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
let renders = 0;
function C({ params, t = 0 }: CardProps<Params>) {
  const [open] = useState(true);
  const jitter = Math.random() * 4;
  return <div style={{ position: "absolute", inset: 0, opacity: open ? Math.min(1, t / 0.2) : 0, transition: "opacity 0.2s", left: jitter }}>{params.text}{renders}</div>;
}
export const card: CardDef<Params> = {
  id: "old-direct", name: "老卡", description: "框架出现之前建的卡", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

test('RSC-04 装卡不查：已经在库里的老卡照旧装得上（打开项目、内容库同步）', () => {
  assert.deepEqual(inspectRemotionStyle(OLD_DIRECT).violations.map((v) => v.rule).sort(), ['css-animation', 'random', 'state', 'top-level']);
  assert.equal(author(OLD_DIRECT).ok, false, '现在再新建这样一张卡是不行的');
  const installed = cards.checkCardSource('old-direct', OLD_DIRECT, [], { mode: 'install' });
  assert.deepEqual([installed.ok, installed.errors], [true, []]);

  const root = tmp('pc-rsc-install-');
  const history = tmp('pc-rsc-history-');
  fs.mkdirSync(path.join(root, 'src', 'cards', 'user'), { recursive: true });
  const [bundled] = cards.installBundledCards({ root, historyDir: history, cards: [{ id: 'old-direct', source: OLD_DIRECT }], existingIds: [] });
  assert.equal(bundled.status, 'written', bundled.error);
  assert.equal(fs.readFileSync(path.join(root, 'src/cards/user/old-direct.tsx'), 'utf8'), OLD_DIRECT, '装进来的源码一个字没动');
  const synced = cards.installSyncedFile({ root, historyDir: history, rel: 'src/cards/user/old-direct-2.tsx', source: OLD_DIRECT.replace('"old-direct"', '"old-direct-2"') });
  assert.equal(synced.status, 'written', synced.error);
  // 违规样例本身也装得上：装卡这条路上没有这套检查
  for (const v of VIOLATIONS) {
    const source = read(`violations/${v.file}`);
    const r = cards.checkCardSource(idOf(source), source, [], { mode: 'install' });
    assert.equal(r.errors.some((e) => e.includes('[remotion 式]')), false, v.file);
  }
});

test('RSC-05 改卡：老卡只拒绝这次新增的违规；用框架写的卡每一条都拒；改声明按新建算', () => {
  // 老卡改一处文案：原来就有的四条不追究
  const renamed = OLD_DIRECT.replace('name: "老卡"', 'name: "旧卡"');
  const r1 = author(renamed, OLD_DIRECT);
  assert.equal(r1.ok, true, r1.errors.join('\n'));
  // 老卡把违规的那一行挪了位置、改了别的字：个数没多，不追究
  const moved = OLD_DIRECT.replace('  const jitter = Math.random() * 4;\n', '').replace('const [open]', 'const jitter = Math.random() * 6;\n  const [open]');
  assert.equal(author(moved, OLD_DIRECT).ok, true);
  // 老卡新加一条：只报新加的那一行，旧的那一行不重复报
  const added = OLD_DIRECT.replace('  return <div', '  const extra = Math.random();\n  return <div');
  const r2 = author(added, OLD_DIRECT);
  assert.equal(r2.ok, false);
  assert.deepEqual(remotionLines(r2.errors).map((e) => /第 (\d+) 行/.exec(e)[1]), [String(lineOf(added, 'const extra = Math.random()'))], r2.errors.join('\n'));
  // 老卡新加另一条规矩的违规
  const r3 = author(OLD_DIRECT.replace('  return <div', '  requestAnimationFrame(() => {});\n  return <div'), OLD_DIRECT);
  assert.equal(r3.ok, false);
  assert.match(r3.errors.join('\n'), /第 8 行：用了浏览器的逐帧回调/);
  assert.equal(remotionLines(r3.errors).length, 1);
  // 原来对所有卡就是出现即拒的三样：老卡上也照旧（不是差量）
  const legacy = OLD_DIRECT.replace('Math.random() * 4', 'Date.now() % 4');
  const r4 = author(legacy.replace('name: "老卡"', 'name: "旧卡"'), legacy);
  assert.equal(r4.ok, false);
  assert.match(r4.errors.join('\n'), /读了真实时间（Date\.now\(\)）/);

  // 老卡开始引用框架：从这一刻起它归框架管（载入时也会锁只读），每一条都要改掉
  const adopted = OLD_DIRECT.replace('import type { CardDef', 'import { tween } from "../../kernel/remotionStyle";\nimport type { CardDef').replace('Math.min(1, t / 0.2)', 'tween(t, { duration: 0.2 })');
  const r5 = author(adopted, OLD_DIRECT);
  assert.equal(r5.ok, false);
  assert.deepEqual([...new Set(inspectRemotionStyle(adopted).violations.map((v) => v.rule))].sort(), ['css-animation', 'random', 'state', 'top-level']);
  assert.equal(remotionLines(r5.errors).length, 4, r5.errors.join('\n'));

  // 新规矩下建的卡（一条违规都没有）：之后的编辑加什么违规都拒
  const clean = read('rs-bar-race.tsx');
  assert.equal(author(clean.replace('name: "随机柱状起伏"', 'name: "柱子"'), clean).ok, true);
  const dirty = clean.replace('const count =', 'const stamp = performance.now();\n  const count =');
  const r6 = author(dirty, clean);
  assert.equal(r6.ok, false);
  assert.match(r6.errors.join('\n'), new RegExp(`第 ${lineOf(dirty, 'performance.now()')} 行：读了真实时间`));

  // 从 motion 式改成 remotion 式：改之前不归这套规矩管，改完按新建算
  const stateful = OLD_DIRECT.replace('frameMode: "direct"', 'frameMode: "stateful"');
  assert.equal(author(stateful).ok, true);
  const r7 = author(OLD_DIRECT, stateful);
  assert.equal(r7.ok, false);
  assert.equal(remotionLines(r7.errors).length, 4);
  // 反过来，从 remotion 式改成 motion 式：不归这套规矩管了
  assert.equal(author(stateful, OLD_DIRECT).ok, true);
});

test('RSC-06 内置的 remotion 式的卡：原样改文案能过；新加违规被拒并指出行号；别的内置文件照旧', () => {
  const builtins = ['src/cards/native/av-pulse.tsx', 'src/cards/native/caption-track.tsx', 'src/cards/native/sound-effects.ts', 'src/cards/_probe/slow.tsx'];
  for (const rel of builtins) {
    const before = repo(rel);
    const info = inspectRemotionStyle(before, { fileName: rel });
    assert.deepEqual([info.declared, info.usesFramework], ['direct', false], `${rel} 是声明成 remotion 式、不是用框架写的内置卡`);
    // 改一处不相干的文字
    const name = /name: "([^"]+)"/.exec(before);
    assert.ok(name, rel);
    const after = before.replace(name[0], `name: "${name[1]}改"`);
    const ok = cards.checkSourceEdit(rel, before, after);
    assert.deepEqual([ok.ok, ok.errors], [true, []], rel);
  }
  // 新加一条违规：拒绝，带行号，文案不劝人用 Motion
  const rel = 'src/cards/native/av-pulse.tsx';
  const before = repo(rel);
  const after = before.replace('const progress =', 'const wobble = Math.random();\n  const timer = setTimeout(() => {}, 1);\n  const progress =');
  const bad = cards.checkSourceEdit(rel, before, after);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), new RegExp(`\\[remotion 式\\] 第 ${lineOf(after, 'Math.random()')} 行：用了不带种子的随机`));
  assert.match(bad.errors.join('\n'), new RegExp(`\\[remotion 式\\] 第 ${lineOf(after, 'setTimeout(')} 行：用了定时器`));
  for (const e of bad.errors) assert.doesNotMatch(e, /用 motion 的 animate|交给 motion/, e);
  // 别的内置文件（motion 式的卡、共用的部件）：原来的差量规则与文案不变
  const plain = 'import type { CardDef } from "../../kernel/types";\nexport const x: CardDef<any> = { id: "x", frameMode: "stateful" } as any;\nexport const f = () => 1;\n';
  const r = cards.checkSourceEdit('src/cards/native/x.tsx', plain, plain + 'export const g = () => setTimeout(() => {}, 1);\n');
  assert.deepEqual(r.errors, ['这次编辑新加了 setTimeout / setInterval 驱动动画:用 motion 的 animate,或者读 t。']);
  const part = cards.checkSourceEdit('src/parts/lib/x.ts', 'export const f = () => 1;\n', 'export const f = () => Date.now();\n');
  assert.deepEqual(part.errors, ['这次编辑新加了 Date.now():要读时间就用组件收到的 t。']);
});

test('RSC-07 桌面建卡这条路（createUserCard）：违规的 400 并带行号，合规的落盘', () => {
  const root = tmp('pc-rsc-create-');
  fs.mkdirSync(path.join(root, 'src', 'cards', 'user'), { recursive: true });
  for (const v of VIOLATIONS) {
    const source = read(`violations/${v.file}`);
    const id = idOf(source);
    const r = cards.createUserCard({ root, id, source, existingIds: [] });
    assert.equal(r.ok, false, v.file);
    assert.equal(r.code, 400);
    const line = lineOf(source, v.needles[0]);
    assert.ok(r.body.errors.some((e) => e.startsWith(`[remotion 式] 第 ${line} 行：`)), `${v.file}\n${r.body.errors.join('\n')}`);
    assert.equal(r.body.error, r.body.errors.join('\n'), '接口回的 error 就是这些条目');
    assert.equal(fs.existsSync(path.join(root, 'src/cards/user', `${id}.tsx`)), false, '被拒的不落盘');
  }
  for (const file of COMPLIANT) {
    const source = read(file);
    const id = idOf(source);
    const r = cards.createUserCard({ root, id, source, existingIds: [] });
    assert.equal(r.ok, true, `${file}\n${r.ok ? '' : r.body.error}`);
    assert.equal(fs.readFileSync(path.join(root, 'src/cards/user', `${id}.tsx`), 'utf8'), source, '落盘的源码与交上来的一字不差');
  }
});

test('RSC-08 渲染节点装同步文件的预检不因为这套规矩变严：用框架写的卡装得上，老卡照旧', () => {
  for (const file of COMPLIANT) {
    assert.deepEqual(checkSyncedSource(`src/cards/user/${file}`, read(file)), { ok: true, errors: [] }, file);
  }
  // 预检只管「Node 一侧会不会被带去读盘、执行」，不查 remotion 式的规矩：老卡、违规样例在它这里都过
  assert.deepEqual(checkSyncedSource('src/cards/user/old-direct.tsx', OLD_DIRECT), { ok: true, errors: [] });
  for (const v of VIOLATIONS) assert.equal(checkSyncedSource(`src/cards/user/${v.file}`, read(`violations/${v.file}`)).ok, true, v.file);
  // 可以引用的模块名单里的每一个，在仓库里都真的有
  for (const mod of REMOTION_IMPORT_ALLOW) {
    if (!mod.startsWith('src/')) continue;
    assert.ok(['.ts', '.tsx', '.mjs', '/index.ts'].some((ext) => fs.existsSync(path.join(ROOT, mod + ext))), mod);
  }
});

test('RSC-09 看源码查不出来的那一类（谁先加载好）：这类写法过得了检查，兜底在别处', () => {
  /*
   * 「字体、图片要等齐了再画，不能先画一版再变」为什么查不出来：下面这张卡的源码里没有任何一句是不对的——
   * 一张 <img>、一个 @font-face 的字体名。画面会不会「先画一版再变」，取决于截这一帧的时候图片解码完没有、字体到没到，
   * 那是运行时的网络与缓存决定的，源码里没有对应的写法可认。
   *
   * 靠什么兜住（都不在建卡检查里）：
   *   - 截帧之前等齐：预渲染与导出在每一帧截图前等字体、图片、视频解码和卡片自己声明的异步准备（`server/bakery/frame-ready.mjs`、
   *     `src/export/frameCompositor.ts` 的 `document.fonts.ready`、`src/kernel/frameReady.ts` 的 `beginFrameWork`）；
   *   - remotion 式的卡不许用记状态的 hook，所以「加载好了再 setState 换一版画面」这条路在组件里走不通，
   *     异步的东西只能在 effect 里直接画，并且用 `beginFrameWork` 挡住截图（可以引用的模块名单里有它）。
   */
  const source = read('rs-title-reveal.tsx')
    .replace('<div style={{ marginTop: 24', '<img src="/@media/logo.png" alt="" style={{ width: 200 }} />\n      <div style={{ marginTop: 24')
    .replace('fontFamily: "sans-serif"', 'fontFamily: "MyWebFont, sans-serif"');
  const r = author(source);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.ok(REMOTION_IMPORT_ALLOW.includes('src/kernel/frameReady'), '异步准备的挡板在名单里');
  for (const rel of ['server/bakery/frame-ready.mjs', 'src/kernel/frameReady.ts', 'src/export/frameCompositor.ts']) assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  // 「加载好了再换一版」的那条路：用状态记「加载好了没有」，被 state 这条拦住
  const late = read('rs-title-reveal.tsx')
    .replace('import type { CardDef', 'import { useState } from "react";\nimport type { CardDef')
    .replace('const chars =', 'const [loaded, setLoaded] = useState(false);\n  const chars =')
    .replace('<div style={{ marginTop: 24', '<img src="/@media/logo.png" alt="" onLoad={() => setLoaded(true)} style={{ opacity: loaded ? 1 : 0 }} />\n      <div style={{ marginTop: 24');
  const bad = author(late);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), new RegExp(`第 ${lineOf(late, 'useState(false)')} 行：用了 useState`));
});
