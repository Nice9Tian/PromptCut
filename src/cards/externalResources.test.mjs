/**
 * 守门:内置卡与部件的源码、内置预设里不出现新的外链资源(图片、字体、样式、脚本)。
 * 〔裁:主会话 2026-10-06〕在线浏览器的跨源舞台只许本源、`data:`、`blob:` 的资源(`src/online/stagePolicy.mjs`),
 * 外链资源在那里一律加载不出来;内置卡不许因此退步,所以资源要么随构建自带,要么在在线页面里有明确的降级。
 * 现有的唯一例外登记在 `KNOWN` 里,连同它的处理办法;新增外链会让这条测试变红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 已知的外链(文件 → 出现几处、怎么处理的) */
const KNOWN = {
  "server/catalog/particles/nasa.json": { count: 1, handled: "在线页面里不载入这张背景图(src/cards/native/particles.tsx 的 onlineSafeBackground);徽标受美国法规限制,不随构建自带" },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
/** 去掉注释(来源说明里的网址不算资源);字符串里的 `//` 不动 */
function stripComments(src) {
  let out = "", i = 0, quote = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (quote) { out += c; if (c === "\\") { out += d ?? ""; i += 2; continue; } if (c === quote) quote = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i = src.indexOf("*/", i + 2); i = i < 0 ? src.length : i + 2; continue; }
    out += c; i++;
  }
  return out;
}
const EXTERNAL = /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'`)]*/gi;
/** 不是要加载的资源:XML 命名空间 */
const HARMLESS = /^https?:\/\/www\.w3\.org\//i;

function externalsIn(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  let text = fs.readFileSync(file, "utf8");
  if (/\.(tsx?|mjs|js|css)$/.test(file)) text = stripComments(text);
  if (/\/index\.json$/.test(rel)) { try { const j = JSON.parse(text); delete j.source; text = JSON.stringify(j); } catch { /* 原样 */ } }
  return (text.match(EXTERNAL) ?? []).filter((u) => !HARMLESS.test(u)).map((u) => ({ rel, url: u }));
}

test("EXT-01 内置卡与部件的源码、内置预设里没有新的外链资源;已知的例外都登记了处理办法", () => {
  const files = [
    ...walk(path.join(ROOT, "src", "cards")).filter((f) => !f.split(path.sep).join("/").includes("/cards/user/")),
    ...walk(path.join(ROOT, "src", "parts")),
    ...walk(path.join(ROOT, "server", "catalog")),
  ].filter((f) => /\.(tsx?|mjs|css|json)$/.test(f) && !/\.test\./.test(f) && !/\.md$/.test(f));
  assert.ok(files.length > 100, `扫到的文件太少(${files.length}),路径可能变了`);
  const found = new Map();
  for (const f of files) for (const hit of externalsIn(f)) found.set(hit.rel, [...(found.get(hit.rel) ?? []), hit.url]);
  for (const [rel, urls] of found) {
    assert.ok(KNOWN[rel], `${rel} 里有外链资源 ${urls[0]}:在线浏览器的隔离舞台里加载不出来。改成随构建自带(写明来源与许可证),或给出在线页面里的降级并登记到本测试的 KNOWN`);
    assert.equal(urls.length, KNOWN[rel].count, `${rel} 的外链数变了:${urls.join(" ")}`);
  }
  for (const rel of Object.keys(KNOWN)) assert.ok(found.has(rel), `${rel} 已经没有外链了,把它从 KNOWN 里去掉`);
});

test("EXT-02 预设 nasa 的外链背景图:在线页面里不载入,桌面照旧", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "cards", "native", "particles.tsx"), "utf8");
  assert.match(src, /background: \{ \.\.\.onlineSafeBackground\(opts\.background\), color: "transparent" \}/);
  assert.match(src, /__pcOnlinePage === true && typeof bg\.image === "string" && EXTERNAL_CSS_URL\.test\(bg\.image\)\) delete bg\.image/);
  const nasa = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "catalog", "particles", "nasa.json"), "utf8"));
  const re = /url\(\s*['"]?\s*(?:https?:)?\/\//i;
  assert.ok(re.test(nasa.background.image), "nasa 预设的背景图应当还是外链(桌面照旧);要是改成自带了,连同 KNOWN 一起改");
});
