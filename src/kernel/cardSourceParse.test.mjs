/**
 * 卡片源码解析(`cardSourceParse.mjs`,C10 契约第 9 节「识别」)的单测。跑:
 *   node --test src/kernel/cardSourceParse.test.mjs
 *
 * 夹具:
 *   1. 仓库里**每一个** `src/cards/user/*.tsx`:解析结果与注册表里那个文件的卡(`userCards` / `userCardFileOf`,经 vite 真的载入)逐个相同;
 *   2. 更宽的语料:`src/cards/` 下全部 `.tsx`(内置卡与用户卡同一种写法),解析结果与模块的具名导出里长得像 CardDef 的逐个相同;
 *   3. 手写的边角:注释 / 字符串 / 模板里写着的「卡」、JSX 文字里的撇号、正则、泛型、`export { a as b }`、默认导出、常量 id、
 *      展开、缺字段的对象、方法写法。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { parseCardSource, isUserCardEntryKey } from "./cardSourceParse.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const byId = (a) => [...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
const isCardDef = (c) => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string" && typeof c.defaults === "object"
  && Array.isArray(c.controls) && (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function");

async function withVite(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { return await fn(server); } finally { await server.close(); }
}

test("仓库里每一个 src/cards/user/*.tsx:解析结果与注册表里那个文件的卡逐个相同", async () => withVite(async (server) => {
  const user = await server.ssrLoadModule("/src/cards/user/index.ts");
  const dir = path.join(ROOT, "src/cards/user");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  assert.ok(files.length > 0, "仓库里至少有一张用户卡");
  let cards = 0;
  for (const f of files) {
    const base = f.replace(/\.tsx$/, "");
    const want = user.userCards.filter((c) => user.userCardFileOf[c.id] === base).map((c) => ({ id: c.id, name: c.name }));
    const got = parseCardSource(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.deepEqual(byId(got), byId(want), `${f} 的解析结果与注册表不一致`);
    assert.ok(isUserCardEntryKey(`src/cards/user/${f}`));
    cards += want.length;
  }
  assert.equal(cards, user.userCards.length, "注册表里每一张用户卡都出自某个文件、都被解析到");
}));

test("更宽的语料:src/cards 下全部 .tsx 的解析结果与模块导出的 CardDef 逐个相同", async () => withVite(async (server) => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".tsx")) files.push(f); } };
  walk(path.join(ROOT, "src/cards"));
  assert.ok(files.length >= 20, `语料不该太少:${files.length}`);
  let cards = 0;
  for (const f of files) {
    const rel = "/" + path.relative(ROOT, f).split(path.sep).join("/");
    const mod = await server.ssrLoadModule(rel);
    const seen = new Set();
    const want = [];
    for (const v of Object.values(mod)) if (isCardDef(v) && !seen.has(v.id)) { seen.add(v.id); want.push({ id: v.id, name: v.name }); }
    assert.deepEqual(byId(parseCardSource(fs.readFileSync(f, "utf8"))), byId(want), rel);
    cards += want.length;
  }
  assert.ok(cards >= 20, `语料里的卡不该太少:${cards}`);
}));

const CARD = (id, name, extra = "") => `export const c_${id.replace(/\W/g, "_")}: CardDef<P> = {
  id: "${id}",
  name: "${name}",${extra}
  defaults: { text: "x" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: View,
};`;

test("边角:注释、字符串、模板里的「卡」不算;JSX 文字里的撇号、正则、泛型不打乱后面的解析", () => {
  const src = `
import type { CardDef } from "../../kernel/types";
// export const fake1 = { id: "no-1", name: "x", defaults: {}, controls: [], Component: V };
/* export const fake2 = { id: "no-2", name: "x", defaults: {}, controls: [], Component: V }; */
const s = "export const fake3 = { id: 'no-3', name: 'x', defaults: {}, controls: [], Component: V }";
const t = \`
export const fake4 = { id: "no-4", name: "x", defaults: {}, controls: [], Component: V };
\${ "{" } }\`;
const re = /[{"'\`]+/g;
const glob = "src/**/*.tsx";
function View({ params }: CardProps<P>) {
  const [n] = useState<number>(0);
  const pick = <T,>(xs: T[]) => xs[0];
  return <div className="a" data-x={"}"}>Don't {params.text} it's <b>ok</b> {n > 1 ? <i>y</i> : "z"}</div>;
}
${CARD("real-card", "真卡")}
`;
  assert.deepEqual(parseCardSource(src), [{ id: "real-card", name: "真卡" }]);
});

test("边角:export { a as b }、默认导出、常量 id、展开、方法写法、多张卡、同 id 只留第一张", () => {
  const src = `
const ID = "const-id";
const NAME: string = "常量名";
const base = { id: "base-card", name: "底卡", defaults: {}, controls: [], Component: V };
const hidden = { id: "hidden-card", name: "没导出", defaults: {}, controls: [], Component: V };
const aliased = { id: "alias-card", name: "别名导出", defaults: {}, controls: [], card(sources) { return sources; } };
export const fromConst = { id: ID, name: NAME, defaults: {}, controls: [], audio: (s) => s };
export const spreadCard = { ...base, id: "spread-card", name: "展开卡" };
export const dup = { id: "const-id", name: "重复", defaults: {}, controls: [], Component: V };
export { aliased as renamed, base };
export default { id: "default-card", name: \`默认\`, defaults: {}, controls: [], Component };
`;
  assert.deepEqual(byId(parseCardSource(src)), byId([
    { id: "const-id", name: "常量名" },
    { id: "spread-card", name: "展开卡" },
    { id: "alias-card", name: "别名导出" },
    { id: "base-card", name: "底卡" },
    { id: "default-card", name: "默认" },
  ]));
});

test("边角:缺字段、值不是字面量、坏源码 → 不算卡,不抛", () => {
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", controls: [], Component: V };`), [], "缺 defaults");
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", defaults: {} , Component: V };`), [], "缺 controls");
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", defaults: {}, controls: [] };`), [], "缺组件");
  assert.deepEqual(parseCardSource(`export const a = { id: makeId(), name: "x", defaults: {}, controls: [], Component: V };`), [], "id 不是字面量");
  assert.deepEqual(parseCardSource(`export const a = { id: \`a-\${n}\`, name: "x", defaults: {}, controls: [], Component: V };`), [], "带替换的模板");
  assert.deepEqual(parseCardSource(`export const a = defineCard({ id: "a", name: "x", defaults: {}, controls: [], Component: V });`), [], "包在函数里");
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", defaults: {}, controls: [], Component: V`), [{ id: "a", name: "x" }], "截断的源码尽量认");
  for (const junk of ["", "{{{{", "`${", "/*", "<div>", "export const", "export {"]) assert.deepEqual(parseCardSource(junk), [], JSON.stringify(junk));
  assert.deepEqual(parseCardSource(null), []);
  assert.deepEqual(parseCardSource(`export const a = { "id": 'q\\'s', 'name': "转义\\u4e2d\\n", defaults: {}, controls: [], Component: V } as const;`), [{ id: "q's", name: "转义中\n" }], "引号键与转义");
});

test("isUserCardEntryKey:只认 src/cards/user/ 下一层的 .tsx", () => {
  assert.equal(isUserCardEntryKey("src/cards/user/a.tsx"), true);
  assert.equal(isUserCardEntryKey("src/cards/user/index.ts"), false);
  assert.equal(isUserCardEntryKey("src/cards/user/lib/b.tsx"), false);
  assert.equal(isUserCardEntryKey("src/cards/native/c.tsx"), false);
  assert.equal(isUserCardEntryKey(undefined), false);
});
