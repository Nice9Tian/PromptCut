// 卡片参数校验 + 建卡源码校验。两个模块都是纯逻辑,这里转译后直接跑,
// 不需要 React、浏览器或 dev server。跑法:node --test server/test/cards.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

/** assert.throws 不把错误还给你,但这里要断言报错文案本身 */
const caught = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('本该抛错却没有'); };

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cards-test-'));
fs.mkdirSync(OUT, { recursive: true });

function compile(srcRel, outName, rewrites = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [from, to] of rewrites) src = src.split(from).join(to);
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return 'file:///' + file.replace(/\\/g, '/');
}

const registryUrl = compile('src/kernel/registry.ts', 'registry.mjs');
const cardParamsUrl = compile('src/kernel/cardParams.ts', 'cardParams.mjs', [['./registry', './registry.mjs']]);
// 转译产物落在临时目录里,解析不到 node_modules,所以把 typescript 换成绝对 URL
const tsUrl = pathToFileURL(require_.resolve('typescript')).href;
const pluginUrl = compile('server/vite-plugin-cards.ts', 'cards-plugin.mjs', [["from 'typescript'", `from '${tsUrl}'`]]);

const { registerCards } = await import(registryUrl);
const { validateCardParams, findCard } = await import(cardParamsUrl);
const { checkCardSource } = await import(pluginUrl);

// 一张最小的假卡,形状和真卡一致
registerCards([{
  id: 'demo-card', name: '演示', description: 'd', source: 'native',
  defaults: { lines: '', mode: 'a', size: 10, accent: '#fff' },
  controls: [
    { key: 'lines', label: '内容', type: 'text', required: true, hint: '一行一条。' },
    { key: 'mode', label: '模式', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'size', label: '字号', type: 'number' },
    { key: 'accent', label: '主色', type: 'color' },
  ],
  Component: () => null,
}]);

// ── validateCardParams ────────────────────────────────────────────
test('必填项为空 → 拒绝,并带上 hint', () => {
  const e = caught(() => validateCardParams('demo-card', { size: 20 }));
  assert.match(e.message, /lines/);
  assert.match(e.message, /必填/);
  assert.match(e.message, /一行一条/);      // hint 要透出去
});

test('必填项只有空白 → 仍然算没填', () => {
  assert.throws(() => validateCardParams('demo-card', { lines: '   ' }), /必填/);
});

test('必填项填了 → 通过,并返回合并结果', () => {
  const merged = validateCardParams('demo-card', { lines: '0|1|你好|' });
  assert.equal(merged.lines, '0|1|你好|');
  assert.equal(merged.mode, 'a');          // 没传的用 defaults
  assert.equal(merged.size, 10);
});

test('键名写错 → 拒绝,并列出真正的参数名', () => {
  const e = caught(() => validateCardParams('demo-card', { lines: 'x', linez: 'y' }));
  assert.match(e.message, /linez/);
  assert.match(e.message, /不是 demo-card 的参数/);
  assert.match(e.message, /mode/);          // 要告诉它有哪些合法参数
});

test('select 取值不在选项里 → 拒绝并列出可选值', () => {
  const e = caught(() => validateCardParams('demo-card', { lines: 'x', mode: 'c' }));
  assert.match(e.message, /a \/ b/);
});

test('number 收到字符串 → 拒绝', () => {
  assert.throws(() => validateCardParams('demo-card', { lines: 'x', size: '20' }), /要数字/);
});

test('改已有 clip 的次要参数,不该因为本次没带必填项而被拒', () => {
  const merged = validateCardParams('demo-card', { size: 30 }, { lines: '0|1|已经填过了|' });
  assert.equal(merged.size, 30);
  assert.equal(merged.lines, '0|1|已经填过了|');
});

test('卡片不存在 → 报错并列出可用 id', () => {
  const e = caught(() => findCard('no-such-card'));
  assert.match(e.message, /demo-card/);
});

// ── checkCardSource ───────────────────────────────────────────────
const GOOD = `
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "价格", description: "d", source: "user",
  defaults: { text: "¥1" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

test('合格源码 → 通过', () => {
  const r = checkCardSource('price-tag', GOOD, ['odometer']);
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('id 不是 kebab-case → 拒绝', () => {
  assert.match(checkCardSource('PriceTag', GOOD, []).errors.join('\n'), /kebab-case/);
});

test('id 和源码里的 id 不一致 → 拒绝', () => {
  const r = checkCardSource('other-id', GOOD, []);
  assert.match(r.errors.join('\n'), /price-tag.*不一致|不一致/s);
});

test('id 撞车 → 拒绝', () => {
  assert.match(checkCardSource('price-tag', GOOD, ['price-tag']).errors.join('\n'), /已经有 id/);
});

test('mu- 前缀 → 拒绝', () => {
  const src = GOOD.replace('id: "price-tag"', 'id: "mu-thing"');
  assert.match(checkCardSource('mu-thing', src, []).errors.join('\n'), /mu- 前缀/);
});

test('没有 CardDef 具名导出 → 拒绝', () => {
  const src = GOOD.replace('export const priceTag: CardDef<Params>', 'const priceTag: any');
  assert.match(checkCardSource('price-tag', src, []).errors.join('\n'), /具名导出/);
});

test('用了 Date.now → 拒绝', () => {
  const src = GOOD.replace('params.text', 'params.text + Date.now()');
  assert.match(checkCardSource('price-tag', src, []).errors.join('\n'), /Date\.now/);
});

test('用了 setInterval → 拒绝', () => {
  const src = GOOD.replace('return <motion', 'setInterval(() => {}, 16);\n  return <motion');
  assert.match(checkCardSource('price-tag', src, []).errors.join('\n'), /setTimeout \/ setInterval/);
});

test('用了 IntersectionObserver → 拒绝', () => {
  const src = GOOD.replace('return <motion', 'new IntersectionObserver(() => {});\n  return <motion');
  assert.match(checkCardSource('price-tag', src, []).errors.join('\n'), /IntersectionObserver/);
});

test('语法错误 → 拒绝并给出行号', () => {
  const src = GOOD.replace('defaults: { text: "¥1" },', 'defaults: { text: "¥1" ,');
  const r = checkCardSource('price-tag', src, []);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /语法错误/);
});

test('缺 controls 字段 → 拒绝', () => {
  const src = GOOD.replace('  controls: [{ key: "text", label: "文字", type: "text" }],\n', '');
  assert.match(checkCardSource('price-tag', src, []).errors.join('\n'), /缺少 controls/);
});
