// 工具 schema 送到模型手里长什么样。
// 这里挡住的是一个真实发生过的失败:add_clip 的 params 被规范成
// { type:"object", properties:{} },意思变成「这个对象没有任何字段」,
// 模型因此一个卡片参数都传不出去,建出来的卡永远是 params: {}。
// 跑法:node --test server/test/tool-schema.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolToVendor, sanitizeSchema } from '../harness/schema.mjs';
import { tools as mcpTools } from '../mcp-tools.mjs';
import { buildParamsSchema, injectCardParams, injectPartParams, buildPartParamsSchema } from '../card-params-schema.mjs';

/** 两张形状不同的卡,够覆盖 text / number / select / required */
const CARDS = [
  {
    id: 'caption-track',
    controls: [
      { key: 'lines', label: '字幕', type: 'text', required: true, hint: '一行一条' },
      { key: 'showEn', label: '显示英文', type: 'select', options: [{ value: 'true' }, { value: 'false' }] },
      { key: 'strokeW', label: '描边宽度', type: 'number' },
    ],
  },
  {
    id: 'odometer',
    controls: [
      { key: 'value', label: '数值', type: 'number' },
      { key: 'unit', label: '单位', type: 'text' },
    ],
  },
];

// ── sanitizeSchema:自由对象不能被改写成「没有字段」 ──────────────
test('嵌套的自由对象保持自由,不再被塞成 properties: {}', () => {
  const out = sanitizeSchema({ type: 'object', properties: { blob: { type: 'object' } } }, 'openai');
  assert.notDeepEqual(out.properties.blob.properties, {}, '空 properties 等于告诉模型「没有字段可填」');
  assert.equal(out.properties.blob.additionalProperties, true);
});

test('没有参数的工具,顶层仍然是 properties: {}', () => {
  const out = sanitizeSchema({ type: 'object', properties: {} }, 'openai');
  assert.deepEqual(out.properties, {}, '「这个工具不接受参数」是真的没有字段,不能改');
});

test('anyOf 分支会被一起清洗', () => {
  const out = sanitizeSchema(
    { type: 'object', properties: { p: { type: 'object', anyOf: [{ type: 'object', properties: { free: { type: 'object' } } }] } } },
    'openai',
  );
  assert.equal(out.properties.p.anyOf[0].properties.free.additionalProperties, true);
});

test('gemini 不支持 additionalProperties,退回空对象而不是留个非法字段', () => {
  const out = sanitizeSchema({ type: 'object', properties: { blob: { type: 'object' } } }, 'gemini');
  assert.equal(out.properties.blob.additionalProperties, undefined);
  assert.deepEqual(out.properties.blob.properties, {});
});

// ── buildParamsSchema:每张卡的真实字段 ───────────────────────────
test('每张卡一个分支,字段名和类型都对得上', () => {
  const schema = buildParamsSchema(CARDS);
  const caption = schema.anyOf.find((b) => b.title === 'caption-track');
  assert.ok(caption, '要能按 cardId 找到分支');
  assert.equal(caption.properties.lines.type, 'string');
  assert.equal(caption.properties.strokeW.type, 'number');
  assert.deepEqual(caption.properties.showEn.enum, ['true', 'false']);
  assert.deepEqual(caption.required, ['lines'], '必填要传给模型,不然它不知道非填不可');
  assert.match(caption.properties.lines.description, /一行一条/, 'hint 要透出去');
});

test('卡片刚加的参数也能传:每个分支都允许额外字段', () => {
  assert.equal(buildParamsSchema(CARDS).anyOf[0].additionalProperties, true);
});

test('拿不到卡片时返回 null,由调用方退回自由对象', () => {
  assert.equal(buildParamsSchema([]), null);
  assert.equal(buildParamsSchema(undefined), null);
});

// ── 端到端:模型最终收到的 add_clip ───────────────────────────────
function sentToModel(cards) {
  const tools = mcpTools
    .filter((t) => ['add_clip', 'update_clip'].includes(t.name))
    .map((t) => ({ ...t, inputSchema: JSON.parse(JSON.stringify(t.inputSchema)) }));
  if (cards) injectCardParams(tools, cards);
  return Object.fromEntries(tools.map((t) => [t.name, toolToVendor(t, 'openai').function.parameters]));
}

test('注入之后,模型能在 add_clip 里看到 lines 这个字段', () => {
  const params = sentToModel(CARDS).add_clip.properties.params;
  assert.ok(Array.isArray(params.anyOf), '应该是按 cardId 分支的联合类型');
  const caption = params.anyOf.find((b) => b.title === 'caption-track');
  assert.ok('lines' in caption.properties, '这正是以前传不出去的那个参数');
});

test('update_clip 同样注入', () => {
  const params = sentToModel(CARDS).update_clip.properties.params;
  assert.ok(params.anyOf.some((b) => b.title === 'odometer'));
});

test('回归:没注入时 params 不再是「没有字段的对象」', () => {
  // 就算注入失败,也不能再退化成 properties:{} —— 那是模型交不出参数的根因
  const params = sentToModel(null).add_clip.properties.params;
  assert.notDeepEqual(params.properties, {}, '空 properties 会让模型只能交出 {}');
  assert.equal(params.additionalProperties, true);
});

test('注入不会污染共享的 mcpTools 常量', () => {
  sentToModel(CARDS);
  const raw = mcpTools.find((t) => t.name === 'add_clip');
  assert.equal(raw.inputSchema.properties.params.anyOf, undefined, 'mcpTools 是模块级共享的,不能被就地改掉');
});

// ── 三处声明必须对齐 ──────────────────────────────────────────────────
// 一个工具要能被调用，得同时出现在三个地方：mcp-tools.mjs 的声明、mcpExecutor 的
// 分发、EditorApi 的实现。缺哪一处都是「模型看得见但调不动」，而且只在模型真的
// 去调的时候才暴露 —— 那时候一次任务已经跑废了。
test('mcp-tools 里每个 browser 工具，执行器里都有对应的分发分支', () => {
  const src = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
  // web_* 走的是前缀分发 + runWebTool 里的 switch，不是逐个 tool === 分支。守卫的意思没变：
  // 声明了就必须真有地方接住，所以这里也认 case "web_x": 这种形式。
  const missing = mcpTools
    .filter((t) => t.side === 'browser')
    .map((t) => t.name)
    .filter((n) => !src.includes(`tool === "${n}"`) && !src.includes(`case "${n}":`));
  assert.deepEqual(missing, [], `执行器里没有分支的工具：${missing.join('、')}`);
});

test('执行器分发的每个工具名，mcp-tools 里都真的有声明', () => {
  const src = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
  const declared = new Set(mcpTools.map((t) => t.name));
  const dispatched = [
    ...[...src.matchAll(/tool === "([a-z_]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/case "(web_[a-z_]+)":/g)].map((m) => m[1]),
  ];
  const orphans = dispatched.filter((n) => !declared.has(n));
  assert.deepEqual(orphans, [], `执行器分发了但没声明的工具：${orphans.join('、')}`);
});

test('只有两个看画面的工具放宽了超时；都要大于自己那条管线的上限，否则报错信息会被桥的超时盖掉', () => {
  const withTimeout = mcpTools.filter((t) => t.timeoutMs);
  assert.deepEqual(withTimeout.map((t) => t.name), ['see_preview', 'see_sequences']);
  for (const t of withTimeout) assert.ok(t.timeoutMs > 120000, `${t.name} 要大于 vite-plugin-vision 里 120 秒的渲染上限`);
});

// ── 枚举值必须是字符串 ─────────────────────────────────────────────
// 诊断报告里抓到的真失败:collect_probe 的 quality 写了数字枚举 [2160, 1440, …],
// Gemini 的 OpenAI 兼容接口回 400「enum[0] (TYPE_STRING), 2160」,整个请求被拒,
// agent 一个工具都调不了。取值范围写进 description,服务端用白名单兜底。
test('所有工具的 enum 值都是字符串(Gemini 只认字符串枚举)', () => {
  const bad = [];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum)) {
      for (const v of node.enum) if (typeof v !== 'string') bad.push(`${where}: ${JSON.stringify(v)}`);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'enum') continue;
      if (v && typeof v === 'object') walk(v, `${where}.${k}`);
    }
  };
  for (const t of mcpTools) walk(t.inputSchema, t.name);
  assert.deepEqual(bad, [], '数字 / 布尔枚举会让 Gemini 直接拒掉整个请求');
});

test('所有 type 都是单一字符串(Gemini 不认数组 type,sanitizeSchema 也不会打平它)', () => {
  const bad = [];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if ('type' in node && typeof node.type !== 'string') bad.push(`${where}: ${JSON.stringify(node.type)}`);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'enum' || k === 'type') continue;
      if (v && typeof v === 'object') walk(v, `${where}.${k}`);
    }
  };
  for (const t of mcpTools) walk(t.inputSchema, t.name);
  assert.deepEqual(bad, []);
});

// ── 部件:add_part / set_part 的 params 与 add_composite 的 parts ───────────────
const PARTS = [
  { id: 'text-title', controls: [{ key: 'text', label: '标题', type: 'text', required: true }, { key: 'size', label: '字号', type: 'number' }] },
  { id: 'list-pins', controls: [{ key: 'items', label: '要点', type: 'text' }] },
];
test('injectPartParams 只碰部件工具;injectCardParams 不再误伤 add_part 的 params', () => {
  const tools = JSON.parse(JSON.stringify(mcpTools));
  injectCardParams(tools, [{ id: 'x', controls: [{ key: 'foo', label: 'f', type: 'text' }] }]);
  const addPart = tools.find((t) => t.name === 'add_part');
  assert.equal(addPart.inputSchema.properties.params.anyOf, undefined, '卡片 schema 不该灌进 add_part');
  injectPartParams(tools, PARTS);
  assert.equal(addPart.inputSchema.properties.params.anyOf.length, 2);
  assert.deepEqual(addPart.inputSchema.properties.params.anyOf[0].required, ['text']);
  assert.equal(tools.find((t) => t.name === 'set_part').inputSchema.properties.params.anyOf[1].title, 'list-pins');
  const parts = tools.find((t) => t.name === 'add_composite').inputSchema.properties.parts;
  assert.equal(parts.type, 'array');
  assert.deepEqual(parts.items.properties.partId.enum, ['text-title', 'list-pins']);
  assert.equal(parts.items.properties.children.items.properties.children.items.properties.children, undefined, '最多三层');
  assert.equal(tools.find((t) => t.name === 'add_clip').inputSchema.properties.params.anyOf[0].title, 'x', '卡片工具还是卡片 schema');
  assert.equal(buildPartParamsSchema([]), null);
});

test('sanitizeSchema:compat 和 vendor 解耦 —— openai 也能按 Gemini 子集清洗,gemini 也能关掉', () => {
  const schema = { type: 'object', properties: { params: { type: 'object' }, n: { type: 'number', default: 1 } }, additionalProperties: true };
  const openaiCompat = sanitizeSchema(schema, 'openai', { compat: true });
  assert.equal(openaiCompat.additionalProperties, undefined);
  assert.deepEqual(openaiCompat.properties.params, { type: 'object', properties: {} });
  assert.equal(openaiCompat.properties.n.default, undefined);
  const openaiPlain = sanitizeSchema(schema, 'openai');
  assert.equal(openaiPlain.properties.params.additionalProperties, true);
  assert.equal(sanitizeSchema(schema, 'gemini').properties.params.additionalProperties, undefined, 'gemini 默认就是 compat');
  assert.equal(sanitizeSchema(schema, 'gemini', { compat: false }).properties.params.additionalProperties, true);
});
