/**
 * 卡片源码归「数据管理」(docs/decoupling-plan.md 第 3.2 节「数据管理 → 卡片」,阶段 5)。
 *
 * # 改动层
 *
 * 安装版里仓库那一份卡片源码在 `runtime/app/src/...`,而更新补丁会**整个覆盖** runtime/app ——
 * Agent 或用户改过的内置卡,升一次级就回到原样(after-0.4-plan.md P0 第 1 条)。
 * 所以装机版的改动不写回原文件,写进数据目录里的改动层:
 *
 *     <PROMPTCUT_DATA_DIR>/card-overrides/src/cards/...   (相对路径和原文件一一对应)
 *
 * 加载时优先用改动层(vite-plugin-cards 的 load 钩子),原文件当只读底版。补丁只换底版。
 * 开发期(没有 PROMPTCUT_DATA_DIR)照旧直接改仓库里的文件 —— 那时候改的就是源码本身。
 * `PROMPTCUT_CARD_OVERRIDES` 可以显式指定改动层目录(测试用)。
 *
 * # 卡片代码的哈希
 *
 * 渲染缓存的键里要带上「这张卡此刻的代码」:以前键里只有片段参数,改了卡片源码,
 * 预烘的旧图照样命中,3D 视图里贴的一直是改之前的样子。哈希按「卡片定义文件 + 它一路 import
 * 到的卡片 / 部件文件」的**生效内容**(改动层优先)算,由 vite-plugin-cards 注入算法
 * (它手里有依赖闭包),这里不反向 import 它,免得两个插件互相引用。
 *
 * # 变更通知
 *
 * 卡片源码一变(不管改的是仓库文件还是改动层),订阅者都会收到:渲染 worker 据此扔掉备用页 ——
 * 备用页是提前开好的,里面加载的是改之前的模块。
 */
import fs from "node:fs";
import path from "node:path";

/** 改动层根目录;没有就是 null(开发期直接改仓库文件) */
export function overridesRoot() {
  if (process.env.PROMPTCUT_CARD_OVERRIDES) return path.resolve(process.env.PROMPTCUT_CARD_OVERRIDES);
  if (process.env.PROMPTCUT_DATA_DIR) return path.join(process.env.PROMPTCUT_DATA_DIR, "card-overrides");
  return null;
}

/** 只有卡片和部件进改动层;内核、编辑器、服务端一律不开放 */
export function isOverridable(rel) {
  const r = String(rel).replace(/\\/g, "/");
  return r.startsWith("src/cards/") || r.startsWith("src/parts/");
}

function relOf(root, abs) {
  return path.relative(root, abs).replace(/\\/g, "/");
}

/** 这个仓库文件在改动层里对应哪个文件(不管存不存在);不可改或没有改动层时是 null */
export function overrideFileFor(root, abs) {
  const top = overridesRoot();
  if (!top) return null;
  const rel = relOf(root, abs);
  if (rel.startsWith("..") || !isOverridable(rel)) return null;
  return path.join(top, rel);
}

/** 生效的那个文件:改动层有就用改动层,否则原文件 */
export function effectivePath(root, abs) {
  const o = overrideFileFor(root, abs);
  return o && fs.existsSync(o) ? o : abs;
}

/** 读生效内容 */
export function readEffective(root, abs) {
  return fs.readFileSync(effectivePath(root, abs), "utf8");
}

/**
 * 写一个卡片 / 部件文件。有改动层就写改动层(原文件不动),没有就写原文件。
 * 返回实际写到的路径。
 */
export function writeCardFile(root, abs, content) {
  const o = overrideFileFor(root, abs);
  const target = o || abs;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** 改动层里的文件 → 它对应的仓库文件;不在改动层里就是 null */
export function repoFileForOverride(root, file) {
  const top = overridesRoot();
  if (!top) return null;
  const rel = path.relative(top, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return path.join(root, rel);
}

let hasher = null;
/** vite-plugin-cards 注入:cardId → 这张卡生效代码的哈希(找不到卡返回空串) */
export function setCardHasher(fn) {
  hasher = fn;
}

/** 这张卡此刻代码的哈希。没有注入算法(老调用方、测试)时是空串 —— 键里少一项,行为同以前 */
export function cardCodeHash(cardId) {
  if (!hasher || !cardId) return "";
  try { return hasher(String(cardId)) || ""; } catch { return ""; }
}

const listeners = new Set();
/** 卡片源码变了时通知(参数是变了的那个文件) */
export function onCardSourceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** vite-plugin-cards 在文件监听里调 */
export function emitCardSourceChange(file) {
  for (const fn of listeners) {
    try { fn(file); } catch { /* 一个订阅者出错不影响别的 */ }
  }
}
