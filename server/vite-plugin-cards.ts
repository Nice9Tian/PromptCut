import type { Plugin, ViteDevServer } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/* ────────────────────────────────────────────────────────────────────
 * 0.4 起:Agent 能读、能改**所有**卡片的原始源码(内置卡也算),但改不了 HTML。
 *
 * 为什么是「改源码、不改 HTML」:舞台上的 DOM 是 React 按源码和参数渲染出来的派生物,
 * 下一次渲染就会把直接改过的 DOM 盖掉,导出时每一帧也都从源码重渲 —— 改 DOM 等于制造
 * 第二个真相。所以 DOM 只给看(inspect_card_dom,每个节点标出是源码哪一行渲染的),
 * 改动一律落回源码(edit_card)。见 docs/render-rebuild-plan.md「目标架构」。
 *
 * 能改的范围只开到卡片目录和卡片共用的部件库;内核、编辑器、服务端一律不开。
 * 内置文件改之前先备份到 out/card-edits/,改坏了能找回来。
 * ──────────────────────────────────────────────────────────────────── */

/** 按卡片 id 找定义文件时扫的目录(不递归:vendor/ 这类子目录是被卡片引用的实现,不是卡) */
const CARD_DEF_DIRS = ['src/cards/native', 'src/cards/magicui'];
/** Agent 能改的源码范围 */
const EDITABLE_ROOTS = ['src/cards/', 'src/parts/'];
const EDITABLE_EXT = /\.(tsx|ts|css)$/;
const MAX_EDIT_BYTES = 256 * 1024;

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** 这个相对路径 Agent 能不能改:在卡片 / 部件目录下、是源码或样式文件、不是测试 */
export function isEditablePath(rel: string): boolean {
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return false;
  if (/\.test\.(ts|tsx|mjs)$/.test(rel)) return false;
  return EDITABLE_ROOTS.some((r) => rel.startsWith(r)) && EDITABLE_EXT.test(rel);
}

/** 卡片 id → 定义它的源码文件(相对仓库根)。用户卡优先,其次内置卡;都没有返回 null */
export function findCardFile(root: string, id: string): string | null {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) return null;
  if (fs.existsSync(path.join(root, 'src', 'cards', 'user', `${id}.tsx`))) return `src/cards/user/${id}.tsx`;
  const re = new RegExp(`\\bid:\\s*["'\`]${id}["'\`]`);
  for (const dir of CARD_DEF_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.tsx')) continue;
      const src = fs.readFileSync(path.join(abs, f), 'utf8');
      if (re.test(src) && /\bCardDef\b/.test(src)) return `${dir}/${f}`;
    }
  }
  return null;
}

/** 一个文件直接用到的本地文件(相对导入,且落在可改范围内的);样式文件也算 —— 画面一半在 CSS 里 */
export function localImports(root: string, rel: string): string[] {
  let src = '';
  try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return []; }
  const out: string[] = [];
  const re = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const m of src.matchAll(re)) {
    const base = path.resolve(path.dirname(path.join(root, rel)), m[1] || m[2]);
    const hit = [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]
      .find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!hit) continue;
    const r = toRel(root, hit);
    if (isEditablePath(r) && !out.includes(r)) out.push(r);
  }
  return out;
}

/** 一张卡的全部本地源码:定义文件 + 它一路用到的卡片 / 部件文件(第一个是定义文件) */
export function importClosure(root: string, rel: string, limit = 60): string[] {
  const seen = [rel];
  for (let i = 0; i < seen.length && seen.length < limit; i++) {
    for (const r of localImports(root, seen[i])) if (!seen.includes(r)) seen.push(r);
  }
  return seen;
}

/** 全部卡片定义文件(用户卡 + 内置卡),给「这个文件被几张卡共用」计数用 */
function allCardFiles(root: string): string[] {
  const out: string[] = [];
  const userDir = path.join(root, 'src', 'cards', 'user');
  if (fs.existsSync(userDir)) for (const f of fs.readdirSync(userDir)) if (f.endsWith('.tsx')) out.push(`src/cards/user/${f}`);
  for (const dir of CARD_DEF_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.tsx') && /\bCardDef\b/.test(fs.readFileSync(path.join(abs, f), 'utf8'))) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

/** 每个文件被几张卡的源码闭包包含。改一个共用文件会同时改掉这么多张卡,要告诉 Agent */
export function sharedByCounts(root: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of allCardFiles(root)) for (const r of importClosure(root, f)) counts.set(r, (counts.get(r) || 0) + 1);
  return counts;
}

/** 改完之后不许**新**出现的写法:导出按帧推时间,这些东西不跟着帧走。已有的不追究(那是原作者的事) */
const RISKY_PATTERNS: [RegExp, string][] = [
  [/\bDate\.now\s*\(/g, 'Date.now():要读时间就用组件收到的 t'],
  [/\bnew\s+Date\s*\(\s*\)/g, 'new Date():要读时间就用组件收到的 t'],
  [/\bsetTimeout\s*\(|\bsetInterval\s*\(/g, 'setTimeout / setInterval 驱动动画:用 motion 的 animate,或者读 t'],
  [/\bIntersectionObserver\b/g, 'IntersectionObserver:卡片挂载即播放,没有「滚进视口」'],
  [/\bsetAnimationLoop\b/g, 'setAnimationLoop:三维画面写成 t 的纯函数,t 变了再显式 render 一次(照 scene-3d.tsx)'],
];

/** 内置 / 共用文件的一次编辑能不能落盘 */
export function checkSourceEdit(rel: string, before: string, after: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (Buffer.byteLength(after, 'utf8') > MAX_EDIT_BYTES) errors.push(`改完超过 ${MAX_EDIT_BYTES / 1024}KB,太大了。`);
  if (/\.(tsx|ts)$/.test(rel)) {
    const out = ts.transpileModule(after, {
      reportDiagnostics: true,
      fileName: rel,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    });
    for (const d of out.diagnostics || []) {
      const pos = d.start !== undefined ? after.slice(0, d.start).split('\n').length : undefined;
      errors.push(`语法错误${pos ? `(第 ${pos} 行)` : ''}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
  for (const [re, why] of RISKY_PATTERNS) {
    const n0 = (before.match(re) || []).length;
    const n1 = (after.match(re) || []).length;
    if (n1 > n0) errors.push(`这次编辑新加了 ${why}。`);
  }
  // 卡片定义文件:CardDef 的具名导出和 id 不能被改掉,不然注册表认不出它、或者换了身份
  if (/export\s+const\s+\w+\s*:\s*CardDef/.test(before)) {
    if (!/export\s+const\s+\w+\s*:\s*CardDef/.test(after)) errors.push('改完没有 `export const xxx: CardDef` 了 —— 注册表靠它认卡。');
    const idOf = (s: string) => (s.match(/\bid:\s*["'`]([^"'`]+)["'`]/) || [])[1];
    if (idOf(before) !== idOf(after)) errors.push(`CardDef 的 id 从 "${idOf(before)}" 变成了 "${idOf(after)}" —— 卡片 id 不能改,时间轴上的片段靠它找卡。`);
  }
  return { ok: errors.length === 0, errors };
}

/** 改内置 / 共用文件之前留一份原样,返回备份的相对路径 */
function backupBeforeEdit(root: string, rel: string, content: string): string {
  const dir = path.join(root, 'out', 'card-edits');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}__${rel.replace(/\//g, '__')}`);
  fs.writeFileSync(file, content, 'utf8');
  return toRel(root, file);
}

/* ── source map:把 React 记下的「转换后」行号换回源码行号 ──
 * React 19 开发版在每个 fiber 上留了 _debugStack,里面是渲染这个节点的那一行 JSX 的位置 ——
 * 但行号是 Vite 转换后代码的(实测 rank-bars.tsx:59 在原文件里是一个 animate 属性)。
 * 经 source map 换算后 6/6 准确。自己解 VLQ 而不是引第三方包:几十行的事,安装包里不一定带那个包。 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 解 mappings:返回每一行(生成代码)的段 [生成列, 源文件下标, 原行, 原列],全部 0 起 */
export function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let src = 0, oLine = 0, oCol = 0;
  for (const lineStr of mappings.split(';')) {
    const segs: number[][] = [];
    let gCol = 0;
    if (lineStr) {
      for (const segStr of lineStr.split(',')) {
        const vals: number[] = [];
        let shift = 0, value = 0;
        for (const ch of segStr) {
          let d = B64.indexOf(ch);
          const cont = d & 32;
          d &= 31;
          value += d << shift;
          if (cont) shift += 5;
          else { vals.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
        }
        if (!vals.length) continue;
        gCol += vals[0];
        if (vals.length >= 4) { src += vals[1]; oLine += vals[2]; oCol += vals[3]; segs.push([gCol, src, oLine, oCol]); }
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** 生成代码的第 line 行第 col 列(都 1 起)→ 原始位置(1 起);找不到返回 null */
export function originalPosition(decoded: number[][][], line: number, col: number): { line: number; col: number } | null {
  const segs = decoded[line - 1];
  if (!segs || !segs.length) return null;
  let hit: number[] | null = null;
  for (const s of segs) { if (s[0] <= col - 1) hit = s; else break; }
  hit = hit || segs[0];
  return { line: hit[2] + 1, col: hit[3] + 1 };
}

/** 只读 DOM 树的一个节点(页面里采出来,服务端补上源码位置) */
export interface DomNode {
  ref: number;
  parent: number;
  tag: string;
  cls: string;
  text: string;
  owner: string | null;
  site: { path: string; line: number; col: number } | null;
  where?: string;
  rect: number[];
  wrap: number;
  desc: number;
  children: number[];
}

/**
 * 把节点表排成给模型看的文本:从 fromRef 起、往下 depth 层,超出的标「…还有 N 个后代 [ref_x]」。
 * 同一行源码在兄弟节点里出现多次(.map 生成的列表)就标出来 —— 改那一行会同时改掉它们。
 */
export function formatDomTree(nodes: DomNode[], fromRef: number, depth: number, maxLines = 160): string {
  const out: string[] = [];
  let truncated = 0;
  const walk = (ref: number, d: number) => {
    const n = nodes[ref];
    if (!n) return;
    if (out.length >= maxLines) { truncated++; return; }
    const siblings = n.parent >= 0 ? nodes[n.parent].children.map((c) => nodes[c]) : [];
    const sameSite = n.where ? siblings.filter((s) => s.where === n.where).length : 0;
    const parts = [
      `[ref_${n.ref}]`,
      n.tag + (n.cls ? '.' + n.cls : ''),
      n.text ? JSON.stringify(n.text) : '',
      n.owner ? `‹${n.owner}›` : '',
      n.where || '',
      sameSite > 1 ? `(同一行源码生成了 ${sameSite} 个兄弟节点)` : '',
      n.wrap ? `(折叠了 ${n.wrap} 层包装)` : '',
      `${n.rect[2]}×${n.rect[3]}@${n.rect[0]},${n.rect[1]}`,
    ].filter(Boolean);
    if (d >= depth && n.children.length) parts.push(`…还有 ${n.desc} 个后代,传 ref:${n.ref} 往下看`);
    out.push('  '.repeat(d) + parts.join(' '));
    if (d < depth) for (const c of n.children) walk(c, d + 1);
  };
  walk(fromRef, 0);
  if (truncated) out.push(`…输出到 ${maxLines} 行为止,还有 ${truncated} 个节点没列出;挑一个 ref 往下看`);
  return out.join('\n');
}

/**
 * 在导出页里采舞台的 DOM 树(页面里执行)。折叠「只有一个子节点、自己又没字」的包装层 ——
 * 实测卡片内容都在第 6~7 层以下,前几层全是 ExportView / Stage 的外壳,不折叠的话「看三层」什么都看不到。
 */
function EXTRACT_DOM(): DomNode[] {
  const stage = document.getElementById('root')?.firstElementChild;
  if (!stage) return [];
  const fiberOf = (el: Element): any => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    return k ? (el as any)[k] : null;
  };
  const ownerName = (el: Element) => {
    let f = fiberOf(el);
    while (f) { if (typeof f.type === 'function') return f.type.displayName || f.type.name || null; f = f.return; }
    return null;
  };
  // _debugStack 第一帧是 jsxDEV 自己,往下找第一个落在 /src/ 里的调用点
  const siteOf = (el: Element) => {
    const f = fiberOf(el);
    const s = f && f._debugStack ? String(f._debugStack.stack || f._debugStack) : '';
    for (const l of s.split('\n').slice(1)) {
      if (/jsx-dev-runtime|react-dom|react_stack_bottom_frame/.test(l)) continue;
      const m = l.match(/https?:\/\/[^/]+(\/src\/[^?:)\s]+)(?:\?[^:)\s]*)?:(\d+):(\d+)/);
      if (m) return { path: m[1], line: Number(m[2]), col: Number(m[3]) };
    }
    return null;
  };
  const ownText = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
  const nodes: DomNode[] = [];
  const visit = (el: Element, parent: number): number => {
    let cur = el;
    let wrap = 0;
    while (cur.children.length === 1 && !ownText(cur)) { cur = cur.children[0]; wrap++; }
    const r = cur.getBoundingClientRect();
    const node: DomNode = {
      ref: nodes.length, parent,
      tag: cur.tagName.toLowerCase(),
      cls: (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join('.'),
      text: ownText(cur).slice(0, 40),
      owner: ownerName(cur), site: siteOf(cur),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      wrap, desc: cur.querySelectorAll('*').length, children: [],
    };
    nodes.push(node);
    for (const c of [...cur.children]) node.children.push(visit(c, node.ref));
    return node.ref;
  };
  visit(stage, -1);
  return nodes;
}

/** 只留下 clipId 那一段(和 vite-plugin-vision 的 isolateClip 同一个做法,各写一份免得两边互相牵制) */
export function isolateClipForDom(project: any, clipId: string): { project: any; clip: any } | null {
  for (const track of project?.tracks || []) {
    for (const clip of track.clips || []) {
      if (clip.id !== clipId) continue;
      const keepMedia = clip.mediaId ? (project.media || []).filter((m: any) => m.id === clip.mediaId) : [];
      return { clip, project: { ...project, media: keepMedia, tracks: [{ ...track, hidden: false, clips: [clip] }] } };
    }
  }
  return null;
}

/**
 * 建卡端点。
 *
 * AI 的文件工具被锁在 exports/ai-workspace/ 里(见 harness/tools/textEditor.mjs),
 * 够不到 src/cards/。这个端点是唯一的口子,而且只开到 src/cards/user/ 这一个目录、
 * 只允许 .tsx、一次一个文件 —— 建卡不该顺带获得改整个代码库的能力。
 *
 * 桌面版跑的是真的 vite dev server(见 desktop/src-tauri/src/lib.rs),
 * 所以文件落盘后 HMR 会直接编译加载,不需要重启也不需要重新打包。
 */

const MAX_SOURCE_BYTES = 64 * 1024;
/** kebab-case,且不能以 mu- 开头(那是 Magic UI 的前缀) */
const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/** 只认同源请求,和 ai 那几个写端点一致 */
function originOk(req: { headers: Record<string, any> }): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === 'http://' + req.headers.host || origin === 'https://' + req.headers.host;
}

/** 审查发现的一条不合规。tier 决定它属于哪一类问题,给调用方(通常是模型)分门别类地看 */
export interface CardFinding {
  /**
   * 2 = 管线还接不住的机制(canvas / 随机 / 逐帧累加),要等导出脚本那边收紧;
   * 3 = 鼠标 / 滚动 / 点击驱动,导出里没有输入,只会停在初态,要改成参数驱动;
   * deps = 引了没装的第三方库;keyframes = 用了没定义的 animate-* 动画;
   * license = 搬来的代码没声明来源和许可证,或许可证不允许分发。
   */
  tier: 2 | 3 | 'deps' | 'keyframes' | 'license';
  rule: string;
  detail: string;
}

export interface CardCheck {
  ok: boolean;
  errors: string[];
  /** 审查门给出的分档发现;没问题时为空数组 */
  findings?: CardFinding[];
}

/* ────────────────────────────────────────────────────────────────────
 * 翻译器:把第三方组件(MagicUI 等)的源码变成能落进 src/cards/user/ 的卡。
 *
 * 分两半。**机械的一半**在这里:去掉 Next.js 的指令、把 @/lib/utils 这类别名
 * 指到本地、按已验证的机制清单审查、从 props 类型推 controls。**语义的一半**
 * (useWhen 怎么写、哪个常量该提成参数、部件怎么切)交给模型在导入时做一次 ——
 * 那部分没法从代码里机械推出来。
 *
 * 审查的分档来自实测:11 张卡(6 张自家 + 5 张 MagicUI)在 openBakery/bakeFrames
 * 管线上做过「新鲜 vs 复用 vs 静态跳过」逐字节比对,Motion 的 WAAPI 与 JS 两条路、
 * CSS 动画、React 状态、rAF、useInView、useSpring 全是 0 差异;canvas 粒子、
 * Math.random、逐帧累加的 rAF 循环则还接不住(截图窗口那段自由跑的虚拟时间会
 * 让它们推进不确定的步数)。鼠标 / 滚动驱动的在导出里没有输入源,是另一类。
 * ──────────────────────────────────────────────────────────────────── */

/** 能 import 的模块:这几个之外的第三方库都没装,写了就是编译失败 */
const ALLOWED_IMPORTS: RegExp[] = [
  /^react$/, /^react\/jsx-runtime$/, /^react-dom$/,
  /^motion\/react$/, /^motion$/,
  /^lottie-web$/, /^@tsparticles\/(engine|slim)$/,   // 已装、已在导出管线上验证过的两个库
  /^three$/, /^three\/.+$/,         // 三维:已装,且在导出管线上验证过逐字节一致(见下面第二档那段)
  /^\.\.?\//,                       // 相对路径(kernel/types、native/hud、magicui/vendor/*)
];

/** Tailwind v4 自带的 animate-* */
const BUILTIN_ANIMATES = new Set(['spin', 'ping', 'pulse', 'bounce', 'none']);
/** 已经搬进 src/cards/magicui/vendor/magicui-animations.css 的 MagicUI 动画 */
const VENDORED_ANIMATES = new Set([
  'accordion-down', 'accordion-up', 'gradient', 'meteor', 'marquee', 'marquee-vertical',
  'spin-around', 'shiny-text', 'shimmer-slide', 'ripple', 'rippling', 'line', 'orbit',
  'background-position-spin', 'shine', 'pulse', 'pulse-ripple', 'rainbow', 'line-shadow',
  'aurora', 'ping', 'blink-cursor',
]);

/** 能随安装包分发的许可证 */
const LICENSE_OK = /\b(MIT|Apache[- ]2\.0|BSD[- ][23][- ]Clause|\bBSD\b|ISC|CC0|Unlicense|0BSD)\b/i;
/** 明确不能搬的:Commons Clause 禁止再分发组件本身;Hippocratic 非 OSI;GSAP 禁止用于无代码动画工具 */
const LICENSE_BAD = /Commons[- ]Clause|Hippocratic|Aceternity|\bGSAP\b|proprietary|All rights reserved|专有/i;

/* ── 可搬目录:MagicUI 全部组件的原始源码 + 审查门跑出来的档位 ──
 * 放在 server/catalog/magicui/(不在 src 下,tsc 和 vite 都不会去编译那些原始文件)。
 * 模型通过 card_authoring_guide 看到目录,通过 get_card_source({cardId:"mu-<name>"}) 拿源码,
 * 包成 CardDef 后用同一个 id 走 create_card —— 不需要新工具,也不用上网。
 */
const catalogDir = new URL('./catalog/magicui/', import.meta.url);

interface CatalogEntry {
  name: string; id: string; file: string; description: string;
  tier: 1 | 2 | 3 | 'deps'; blockers: string[]; props: string[]; imported: string | null;
}

function loadCatalog(): { license: string; components: CatalogEntry[] } | null {
  try {
    return JSON.parse(fs.readFileSync(new URL('./index.json', catalogDir), 'utf8'));
  } catch {
    return null;
  }
}

/** 目录源码:只认 mu-<name>,name 必须在 index.json 里,防止拿 id 去读别的文件 */
export function readCatalogSource(id: string): { name: string; source: string; entry: CatalogEntry } | null {
  const m = /^mu-([a-z0-9-]+)$/.exec(id);
  const cat = m && loadCatalog();
  const entry = cat && cat.components.find((c) => c.name === m![1]);
  if (!entry) return null;
  try {
    return { name: entry.name, source: fs.readFileSync(new URL(`./${entry.name}.tsx`, catalogDir), 'utf8'), entry };
  } catch {
    return null;
  }
}

/** 把目录渲染成 guide 末尾的一节。按档位分组,每行一个组件:id、一句话、搬时要注意什么 */
export function renderCatalog(): string {
  const cat = loadCatalog();
  if (!cat) return '';
  const groups: Record<string, CatalogEntry[]> = { 1: [], deps: [], 3: [], 2: [] };
  for (const c of cat.components) (groups[String(c.tier)] ||= []).push(c);
  const line = (c: CatalogEntry) =>
    `- \`${c.id}\` —— ${c.description}${c.imported ? `(已在库里:\`${c.imported}\`)` : ''}${c.props.length ? `;上游 props:${c.props.join('、')}` : ''}${c.blockers.length ? `;要处理:${c.blockers.join('、')}` : ''}`;
  return [
    '## 附:Magic UI 可搬目录',
    '',
    `来源 ${cat.license},${cat.components.length} 个组件,源码在本地。想用其中一个:\`get_card_source({ cardId: "mu-<name>" })\` 读原始源码 → 按上面「搬第三方组件」包成 CardDef、文件头写来源 → \`create_card\` 用同一个 id 建卡。档位是审查门跑出来的。`,
    '',
    `### 现在就能搬(${groups[1].length})`, ...groups[1].map(line), '',
    `### 引了没装的库,搬时要把用到的几行带进来或去掉(${groups.deps.length})`, ...groups.deps.map(line), '',
    `### 交互 / 滚动驱动,要改成由 t 驱动的参数才能进导出(${groups[3].length})`, ...groups[3].map(line), '',
    `### 管线暂不支持(${groups[2].length})`, ...groups[2].map(line), '',
    renderAssets(),
  ].join('\n');
}

/** Lottie 与粒子的素材目录:都是现成文件,不用建卡,直接 add_clip 现有的卡并把 URL 填进参数 */
function renderAssets(): string {
  const read = (kind: string) => {
    try { return JSON.parse(fs.readFileSync(new URL(`./catalog/${kind}/index.json`, import.meta.url), 'utf8')); } catch { return null; }
  };
  const out: string[] = [];
  // note 是模型看 6 帧拼图写的观察,比人写的 description 具体;有就优先用,use 是它建议的场合
  const desc = (i: any) => (i.note ? `${i.note}${i.use ? `(${i.use})` : ''}` : i.description);
  const lottie = read('lottie');
  if (lottie) {
    out.push(`## 附:Lottie 素材(${lottie.items.length},${lottie.license})`, '',
      '用法:`add_clip({ cardId: "lottie", params: { src: "<url>" } })`,clip 时长照着 seconds 给;想循环就加 `loop: "yes"`。', '',
      ...lottie.items.map((i: any) => `- \`${i.url}\` —— ${desc(i)};${i.seconds}s,${i.w}×${i.h}`), '');
  }
  const particles = read('particles');
  if (particles) {
    const featured = particles.items.filter((i: any) => i.featured);
    const rest = particles.items.filter((i: any) => !i.featured);
    out.push(`## 附:粒子配置(${particles.items.length},${particles.license})`, '',
      '用法:`add_clip({ cardId: "particles", params: { config: "<url>", seed: 1 } })`。都是背景,通常盖住整段时长放最底层;换 seed 换排布。每个都在导出管线上实跑验证过。', '',
      `### 推荐(${featured.length})`, ...featured.map((i: any) => `- \`${i.url}\` —— ${desc(i)}`), '',
      `### 其他(${rest.length},多是同一外观的变体)`,
      rest.map((i: any) => `\`${i.name}\`(${i.note || i.description})`).join('、'), '');
  }
  return out.join('\n');
}

/**
 * 机械翻译:只做不需要判断的替换。返回改过的源码和「改了什么」的清单,
 * 清单会原样回给调用方 —— 模型得知道文件和它交上来的不一样在哪。
 */
export function translateCardSource(source: string): { source: string; rewrites: string[] } {
  const rewrites: string[] = [];
  let out = source.replace(/\r\n/g, '\n');

  // Next.js 的客户端指令,Vite 里没意义,留着会被当成一个没用的字符串表达式
  if (/^\s*["']use client["'];?\s*$/m.test(out)) {
    out = out.replace(/^\s*["']use client["'];?\s*\n?/m, '');
    rewrites.push('去掉了 "use client" 指令(Next.js 专用)');
  }
  // shadcn / MagicUI 生态的 cn 别名 → 本地那份(文件落在 src/cards/user/,所以往上一级再进 magicui)
  if (/from\s+["']@\/lib\/utils["']/.test(out)) {
    out = out.replace(/from\s+["']@\/lib\/utils["']/g, 'from "../magicui/vendor/cn"');
    rewrites.push('@/lib/utils → ../magicui/vendor/cn(本地的 cn)');
  }
  return { source: out, rewrites };
}

/** 文件头(前 40 行)里有没有「来源:」声明,以及看起来像不像从 shadcn/MagicUI 生态搬来的 */
function provenance(source: string): { declared: boolean; looksVendored: boolean; header: string } {
  const header = source.split('\n').slice(0, 40).join('\n');
  return {
    declared: /来源\s*[:：]/.test(header) || /@source\b|Source:\s*https?:/i.test(header),
    // 只认别名和站点/仓库名,不认路径片段 —— 本地的 ../magicui/vendor/cn 也含 "magicui",那是我们自己的
    looksVendored: /@\/lib\/utils|@\/components\/|magicui\.design|magicuidesign|shadcn|aceternity|react-bits/i.test(source),
    header,
  };
}

/**
 * 审查门:按实测过的机制清单分档。这里**只管新增的几类**,Date.now / 定时器 /
 * IntersectionObserver 三条老规矩仍在 checkCardSource 里,报错文案不变。
 */
/**
 * 去掉注释,只留代码。给「有没有用某个 API」这类判断用 ——
 * 注释里提到一个名字不等于用了它,尤其是那些**专门解释「为什么不用它」**的注释。
 * 字符串里的 // 不该被当成注释起点,所以要跟着引号状态走,不能拿正则一把梭。
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote = "";      // 当前在哪种引号里("" = 不在)
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
      if (c === quote) quote = "";
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      // 用一个换行顶替,免得把注释两边的记号粘成一个
      out += "\n";
      continue;
    }
    out += c; i++;
  }
  return out;
}

export function reviewCardSource(source: string, hints?: { vendored?: boolean }): CardFinding[] {
  const f: CardFinding[] = [];
  const push = (tier: CardFinding['tier'], rule: string, detail: string) => f.push({ tier, rule, detail });

  // ── 第二档:管线接不住 ──
  // canvas 和 Math.random 曾经在这一档,现在不在了:导出页把 Math.random 钉成带种子的、截图期间
  // 关掉脚本执行(exportClock.ts / export-frames.mjs 的 shoot),静态跳过的探针也看得见 canvas。
  // 实测 tsParticles 粒子卡「新鲜 vs 复用 vs 跳过」逐字节 0 差异。
  //
  // WebGL 也曾经在这一档,现在不在了。当初的理由(「走 GPU 路径,两次不完全一致」)其实是**反的**:
  // 导出那套 --disable-gpu 根本没让它走 GPU,而是把它整个关死 —— getContext("webgl") 返回 null,
  // 画面是一张空画布,还不报错。现在加了 --enable-unsafe-swiftshader 走 SwiftShader 软件光栅,
  // 实测 scene-3d 卡(three.js)在真导出管线上两趟 20/20 帧逐字节相同,老基线 15/15 不受影响。
  //
  // 剩下真正接不住的不是 WebGL,是**按 delta 累积的帧循环**:截图窗口里那段自由跑的虚拟时间
  // 会让它多推进不确定的步数,而且往回拖播放头没有倒带。所以这一档现在拦的是那个模式。
  /*
   * 只匹配字面量 `setAnimationLoop(` 是拦不住的。实测四个样例:
   *   裸 requestAnimationFrame + performance.now() 累积 delta(three)  → 放行
   *   renderer.setAnimationLoop(...)                                   → 拦住
   *   requestAnimationFrame + 自增计数器(连时钟都不读)                → 放行 ← 最阴的一个
   *   const fn = "setAnimationLoop"; renderer[fn](...)                 → 放行
   *
   * 但也不能见 rAF 就拦:rAF 本身在这条管线上是**验证过没问题**的(Motion 的 JS 动画就走它,
   * 逐字节 0 差异),一刀切会把一大批本来好好的卡挡在门外。
   * 真正接不住的是「自己驱动一个三维场景」这个组合 —— 所以两个条件同时成立才拦。
   */
  /*
   * 认**名字本身**,不认调用形式:`const fn = "setAnimationLoop"; renderer[fn](cb)` 这种
   * 拐一手的写法,只匹配 `setAnimationLoop(` 是抓不住的。
   *
   * 但只看代码、不看注释 —— 这条规则的报错文案让作者「照 scene-3d.tsx 的写法」,
   * 而那张卡的注释里恰恰在解释为什么**不能**用 setAnimationLoop。连注释一起匹配的话,
   * 照着抄的人会被这条规则拒掉,理由还是它自己推荐的那份参考。
   */
  const code = stripComments(source);
  const usesRaf = /\brequestAnimationFrame\b|\bsetAnimationLoop\b/.test(code);
  const uses3D = /\bfrom\s+["']three(\/[^"']*)?["']|\bnew\s+THREE\.|\bWebGLRenderer\b|getContext\s*\(\s*["']webgl2?["']/.test(code);
  if (/\bsetAnimationLoop\b/.test(code) || (usesRaf && uses3D)) {
    push(2, '自带帧循环', '三维场景自己跑帧循环(setAnimationLoop / requestAnimationFrame)在这条管线上接不住:导出时截图窗口里那段自由跑的虚拟时间会让它多走不确定的步数,两趟导出对不上;往回拖播放头也回不到原样。把画面写成 t 的纯函数(比如 rotation.y = t * 转速 * 2π),在 t 变了的时候显式 render 一次 —— 照 src/cards/native/scene-3d.tsx 的写法,那张卡一次 rAF 都不注册。');
  }
  if (/\bfrom\s+["'](@react-three\/[^"']+|cobe|@react-three-fiber[^"']*)["']/.test(source)) {
    push(2, '三维框架', '@react-three/fiber 和 cobe 都自带 rAF 帧循环(理由同上),而且都没装。要做三维直接用 three(已装),照 src/cards/native/scene-3d.tsx 那样按 t 渲染。');
  }

  // ── 第三档:靠输入驱动,导出里没有输入 ──
  if (/addEventListener\s*\(\s*["'](mousemove|pointermove|mouseenter|mouseleave|wheel|scroll|touchmove)["']/.test(source)
    || /\bon(MouseMove|PointerMove|MouseEnter|MouseLeave|Wheel|TouchMove)\s*=/.test(source)) {
    push(3, '鼠标/滚动事件', '导出时没有鼠标也没有滚动,这类效果只会停在初态。把「光标在哪」「滚到哪」改成一个由 t 驱动的参数,效果就能进导出。');
  }
  if (/\bwhile(Hover|Tap|Drag|Focus|InView)\s*=/.test(source)) {
    push(3, 'whileHover/whileTap/whileInView', '同上:hover / tap / 进入视口在导出里都不会发生。要它播就用 initial + animate,不要挂在交互上。');
  }
  if (/\buse(Scroll|Velocity)\s*\(|window\.scrollY|scrollTop/.test(source)) {
    push(3, '滚动驱动', '同上:导出页不会滚动。');
  }

  // ── 依赖:没装的库 ──
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (!ALLOWED_IMPORTS.some((re) => re.test(spec))) {
      push('deps', `import "${spec}"`, spec.startsWith('@/')
        ? `别名 ${spec} 指向的是原项目的文件,这里没有。@/lib/utils 会自动改到本地的 cn;别的要么去掉,要么把用到的那几行搬进来。`
        : `没装 ${spec}。装了的是 react、motion/react、three、lottie-web、@tsparticles/engine|slim,加上 Tailwind class 和相对路径引的 kernel/types、native/hud、magicui/vendor/*。`);
    }
  }

  // ── 动画 class:用了没定义的 animate-* ──
  const usedAnimates = new Set<string>();
  for (const m of source.matchAll(/\banimate-([a-z][a-z0-9-]*)/g)) usedAnimates.add(m[1]);
  for (const name of usedAnimates) {
    if (BUILTIN_ANIMATES.has(name) || VENDORED_ANIMATES.has(name)) continue;
    push('keyframes', `animate-${name}`, `这个动画 class 没有定义(Tailwind 自带的只有 spin/ping/pulse/bounce,MagicUI 那 22 组已经搬进 magicui-animations.css)。把它的 @keyframes 和 .animate-${name} 写进那个文件,或改用 motion/react。`);
  }

  // ── 来源与许可证:搬来的代码必须声明,且许可证要能分发 ──
  const p = provenance(source);
  if (p.declared || p.looksVendored || hints?.vendored) {
    if (!p.declared) {
      push('license', '来源未声明', '这段代码看起来是从 shadcn / MagicUI 生态搬来的。文件头必须写「来源: <URL>」和许可证(照 src/cards/magicui/vendor/word-rotate.tsx 的写法),否则不知道能不能随安装包分发。');
    } else if (LICENSE_BAD.test(p.header)) {
      push('license', '许可证不允许分发', '声明的许可证不能搬:React Bits 的 Commons Clause 禁止再分发组件本身,Aceternity 是专有协议,animate.css 的 Hippocratic 不是 OSI 许可,GSAP 禁止用于无代码动画工具。换一个来源。');
    } else if (!LICENSE_OK.test(p.header)) {
      push('license', '许可证不在白名单', '文件头没有写出能识别的许可证。能搬的是 MIT / Apache-2.0 / BSD / ISC / CC0;把原仓库 LICENSE 里的名字写进来源那一行。');
    }
  }

  return f;
}

/** 从源码里第一个 *Props 接口推 controls 建议;推不出来就返回空 */
export function suggestControls(source: string): { key: string; label: string; type: string; hint?: string }[] {
  const sf = ts.createSourceFile('card.tsx', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const SKIP = new Set(['className', 'children', 'style', 'ref', 'key', 'id']);
  const out: { key: string; label: string; type: string; hint?: string }[] = [];

  const visit = (node: ts.Node): boolean => {
    if (ts.isInterfaceDeclaration(node) && /Props$/.test(node.name.text)) {
      for (const m of node.members) {
        if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name) || !m.type) continue;
        const key = m.name.text;
        if (SKIP.has(key)) continue;
        const t = m.type;
        if (t.kind === ts.SyntaxKind.StringKeyword) out.push({ key, label: key, type: 'text' });
        else if (t.kind === ts.SyntaxKind.NumberKeyword) out.push({ key, label: key, type: 'number' });
        else if (t.kind === ts.SyntaxKind.BooleanKeyword) out.push({ key, label: key, type: 'select', hint: 'options: true / false' });
        else if (ts.isArrayTypeNode(t) && t.elementType.kind === ts.SyntaxKind.StringKeyword) out.push({ key, label: key, type: 'text', hint: '上游是 string[],用 | 分隔,组件里 split("|")' });
        else if (ts.isUnionTypeNode(t) && t.types.every((u) => ts.isLiteralTypeNode(u) && ts.isStringLiteral(u.literal))) {
          const opts = t.types.map((u) => ((u as ts.LiteralTypeNode).literal as ts.StringLiteral).text);
          out.push({ key, label: key, type: 'select', hint: 'options: ' + opts.join(' / ') });
        }
      }
      return true;
    }
    return ts.forEachChild(node, visit) ?? false;
  };
  visit(sf);
  return out;
}

/**
 * 落盘前的静态检查。这里挡住的是「写进去就会让编辑器白屏」的几类错误,
 * 剩下的运行时问题交给 vite 的编译报错和用户预览。
 */
export function checkCardSource(
  id: string,
  source: string,
  existingIds: string[],
  /** vendored:翻译器已经确认这是搬来的代码(改写过 @/lib/utils 之类),来源声明就是必填 */
  hints?: { vendored?: boolean },
): CardCheck {
  const errors: string[] = [];

  if (!ID_RE.test(id)) {
    errors.push(`卡片 id "${id}" 不合法:要用小写 kebab-case(例如 my-title-card),只能有字母、数字和连字符。`);
  }
  // mu- 是 Magic UI 的命名空间。手写的卡不能占;翻译器从 magicui.design 搬来、
  // 文件头声明了来源的可以用 —— 这样 id 前缀仍然可信:mu- 就是「来自 MagicUI」,不论谁搬的。
  if (id.startsWith('mu-') && !/来源\s*[:：][^\n]*magicui/i.test(source.split('\n').slice(0, 40).join('\n'))) {
    errors.push('mu- 前缀留给 Magic UI 适配卡,换一个 id。(从 magicui.design 搬来、文件头写了「来源: …magicui…」的可以用。)');
  }
  // lottie- / particles- 是素材封装卡(src/cards/assets,由素材目录构建时生成)的命名空间,手写的卡不能占
  if (/^(lottie|particles)-/.test(id)) {
    errors.push('lottie- / particles- 前缀留给素材目录翻译出来的封装卡,换一个 id。');
  }
  if (existingIds.includes(id)) {
    errors.push(`已经有 id 为 "${id}" 的卡片了。卡片 id 必须唯一,换一个;想改现有的卡请直接改它的文件。`);
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    errors.push(`源码超过 ${MAX_SOURCE_BYTES / 1024}KB,太大了。`);
  }

  // 必须真的导出一个 CardDef,否则 glob 收集时会静默跳过,建了个寂寞
  if (!/export\s+const\s+\w+\s*:\s*CardDef/.test(source)) {
    errors.push('源码里没有 `export const xxx: CardDef<Params> = { ... }` 形式的具名导出 —— 自动注册靠它识别卡片。');
  }
  const idInSource = source.match(/\bid:\s*["'`]([^"'`]+)["'`]/);
  if (!idInSource) {
    errors.push('CardDef 里没有 id 字段。');
  } else if (idInSource[1] !== id) {
    errors.push(`CardDef 里的 id 是 "${idInSource[1]}",和传进来的 id "${id}" 不一致,两者必须相同。`);
  }
  for (const field of ['name', 'description', 'defaults', 'controls', 'Component']) {
    if (!new RegExp(`\\b${field}\\s*:`).test(source)) {
      errors.push(`CardDef 里缺少 ${field} 字段。`);
    }
  }

  // 这几条是硬约束:导出时用的是虚拟时钟,拿真实时间的卡导出会不同步
  if (/\bDate\.now\s*\(/.test(source)) {
    errors.push('不要用 Date.now():导出时走的是虚拟时间,会和画面对不上。动画交给 motion/react,需要读时间就用组件收到的 t。');
  }
  if (/\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(source)) {
    errors.push('不要用 setTimeout / setInterval 驱动动画:导出时它们不受虚拟时钟控制。用 motion/react 的 animate,或读组件参数 t。');
  }
  if (/\bIntersectionObserver\b/.test(source)) {
    errors.push('不要用 IntersectionObserver:卡片挂载即播放,不存在「滚动进入视口」这回事。');
  }

  // 语法检查:让写坏的文件在这里就被挡住,而不是存进去把 HMR 打挂
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  for (const d of out.diagnostics || []) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const pos = d.start !== undefined ? source.slice(0, d.start).split('\n').length : undefined;
    errors.push(`语法错误${pos ? `(第 ${pos} 行)` : ''}:${msg}`);
  }

  // 审查门:分档的发现也算拒绝理由,并且把档位写进文案 —— 模型只看得到 error 字符串,
  // 得让它一眼分清「这是管线的限制」「这是要改成参数驱动」「这是许可证问题」。
  const findings = reviewCardSource(source, hints);
  const TIER_LABEL: Record<string, string> = {
    2: '[第二档·管线暂不支持]', 3: '[第三档·交互驱动]', deps: '[依赖]', keyframes: '[动画 class]', license: '[来源/许可证]',
  };
  for (const x of findings) errors.push(`${TIER_LABEL[String(x.tier)]} ${x.rule}:${x.detail}`);

  return { ok: errors.length === 0, errors, findings };
}

/**
 * 把一次 find/replace 应用到源码上。
 *
 * 独立成纯函数不是为了复用,是为了能测:命中次数、$ 记号、空改这几种情形出错时
 * 都不会报错,只会静静地把文件改成别的样子 —— 那正是这个功能要根治的毛病。
 */
export function applyCardPatch(
  before: string,
  find: string,
  replace: string,
  replaceAll?: boolean,
): { ok: true; after: string; replaced: number } | { ok: false; error: string } {
  if (!find) return { ok: false, error: 'find 不能是空串,那会匹配到每一个位置。' };

  const hits = before.split(find).length - 1;
  if (hits === 0) {
    return {
      ok: false,
      error: 'find 在源码里一次都没匹配到 —— 你手上的版本和文件里的对不上。先调 get_card_source 读回当前源码,照着它写 find(缩进和空格都要一致)。',
    };
  }
  if (hits > 1 && !replaceAll) {
    return {
      ok: false,
      error: `find 匹配到 ${hits} 处,分不清要改哪一处。把 find 写长一点、带上周围几行让它唯一;确实要全改就传 replaceAll: true。`,
    };
  }

  // 用 split/join 而不是 String.replace:后者会把 replace 里的 $& $` $' $$ 当成
  // 「引用匹配内容」的替换记号展开,而这里的 replace 是模型逐字写好的源码,必须原样落盘。
  const after = before.split(find).join(replace);
  if (after === before) {
    return { ok: false, error: 'replace 和 find 完全一样,这次编辑什么都没改。' };
  }
  return { ok: true, after, replaced: hits };
}

export default function vitePluginCards(): Plugin {
  return {
    name: 'promptcut-cards',
    configureServer(server: ViteDevServer) {
      const userDir = path.join(server.config.root, 'src', 'cards', 'user');

      /*
       * 卡片归属表:哪张定制卡属于哪个项目。
       *
       * 为什么需要它:src/cards/user/ 是**一个全局目录**,index.ts 用 import.meta.glob 扫全目录,
       * 所以从前 Agent 给 A 项目建的卡,打开 B 项目照样出现在 list_cards 里。用户的原话是
       * 「ThreeJS 的资产又从上一个项目泄露给他了」—— 那张 logo-3d-9tian 是给某个客户做的,
       * 串到别人的片子里既是噪音也是风险。
       *
       * 为什么不写进卡片文件本身:注册表拿到的是 import 出来的 CardDef 对象,不是文件文本,
       * 读不到文件头的注释。放一张旁表最直接。
       *
       * 归属只记「谁建的」,**要不要共享是另一回事**(scope 字段),因为跨项目复用有时正是想要的
       * (自己的品牌卡下个片子还想用)。默认 project = 不共享,用户可以在聊天面板里改成共享。
       */
      const scopeFile = path.join(server.config.root, 'src', 'cards', 'user', '_scopes.json');
      type CardScope = { scope: 'project' | 'custom'; projectId?: string; createdAt?: string };
      const readScopes = (): Record<string, CardScope> => {
        try { return JSON.parse(fs.readFileSync(scopeFile, 'utf8')); } catch { return {}; }
      };
      const writeScopes = (m: Record<string, CardScope>) => {
        try { fs.writeFileSync(scopeFile, JSON.stringify(m, null, 2), 'utf8'); } catch { /* 写不进去不该让建卡失败 */ }
      };

      // GET 读全表 / POST { cardId, scope } 改一张卡的档位(聊天面板那两个勾选框用)
      server.middlewares.use('/api/cards/scopes', (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, scopes: readScopes() });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST' });
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const { cardId, scope, projectId } = JSON.parse(body || '{}');
            if (typeof cardId !== 'string' || (scope !== 'project' && scope !== 'custom')) {
              return sendJson(res, 400, { ok: false, error: 'cardId 必填,scope 只能是 project 或 custom' });
            }
            const m = readScopes();
            m[cardId] = { ...m[cardId], scope, ...(projectId ? { projectId } : {}) };
            writeScopes(m);
            sendJson(res, 200, { ok: true, scopes: m });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      // 建卡规则单独用一个端点按需取,而不是塞进每次对话的系统提示里 ——
      // 它只在「要建新卡」时才用得上,常驻会白白占掉几千 token。
      /**
       * 素材文件:/catalog/lottie/<name>.json、/catalog/particles/<name>.json。
       * Lottie 卡的 src、粒子卡的 config 直接填这个 URL,编辑器预览和导出页都从这里取
       * (同源 fetch,导出脚本的 pauseIfNetworkFetchesPending 会等它取完再推进虚拟时间)。
       * 只放行 index.json 里登记过的名字,不拿 URL 去读别的文件。
       */
      server.middlewares.use('/catalog', (req, res, next) => {
        const m = /^\/(lottie|particles)\/([A-Za-z0-9-]+)\.json$/.exec((req.url || '').split('?')[0]);
        if (!m) return next();
        const [, kind, name] = m;
        try {
          const index = JSON.parse(fs.readFileSync(new URL(`./catalog/${kind}/index.json`, import.meta.url), 'utf8'));
          if (!index.items.some((it: { name: string }) => it.name === name)) return sendJson(res, 404, { ok: false, error: `${kind} 素材目录里没有 "${name}"` });
          const body = fs.readFileSync(new URL(`./catalog/${kind}/${name}.json`, import.meta.url));
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(body);
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) });
        }
      });

      server.middlewares.use('/api/cards/guide', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const guide = fs.readFileSync(new URL('./card-authoring-guide.md', import.meta.url), 'utf-8');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          // 附上可搬目录:模型只看得见库里已有的卡,不知道 MagicUI 还有哪些没搬、各干什么。
          // 目录是审查门跑出来的(server/catalog/magicui/index.json),档位不是手写的。
          res.end(guide + '\n' + renderCatalog());
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) });
        }
      });

      /**
       * 读回一张卡的源码。0.4 起内置卡也能读(理由见文件头「Agent 能读、能改所有卡片的原始源码」)。
       *
       * 没有这个口子的时候,改卡只能走 create_card + overwrite —— 那是整篇重写,
       * 模型手上没有当前版本,只能凭记忆重建,没被提到的细节每轮都会漂。先读回来,才谈得上「改」。
       *
       * 返回定义文件的源码,外加 files:这张卡一路用到的卡片 / 部件文件,每个带 sharedBy(被几张卡共用)。
       * 传 file 就读其中那一个 —— inspect_card_dom 标出来的源码位置常常落在共用部件或 vendor 文件里。
       * 既不是用户卡、也不是已注册卡片的 id,仍然回落到 Magic UI 可搬目录(给「搬第三方组件」用)。
       */
      server.middlewares.use('/api/cards/source', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const q = new URL(req.url || '', 'http://x').searchParams;
        const id = q.get('id') || '';
        const wantFile = q.get('file') || '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `卡片 id "${id}" 不合法。` });
        const root = server.config.root;
        const defFile = findCardFile(root, id);
        if (!defFile) {
          // 不是卡 → 看看是不是可搬目录里的 MagicUI 组件。返回的是**上游原始源码**,
          // 还没包成 CardDef,模型拿到后按 guide 的「搬第三方组件」包好、用同一个 id 走 create_card。
          const cat = readCatalogSource(id);
          if (cat) {
            return sendJson(res, 200, {
              ok: true, id, file: cat.entry.file, source: cat.source, lines: cat.source.split('\n').length,
              catalog: true, tier: cat.entry.tier, blockers: cat.entry.blockers, props: cat.entry.props,
              hint: `这是 Magic UI 目录里的原始源码(MIT),还不是卡。包成 CardDef、文件头写「来源: https://magicui.design/docs/components/${cat.name}」和 MIT,再用 create_card 以 id "${id}" 建卡。${cat.entry.blockers.length ? '要先处理:' + cat.entry.blockers.join('、') : ''}`,
            });
          }
          return sendJson(res, 404, {
            ok: false,
            error: `找不到卡片 "${id}" 的源码。先用 list_cards 确认 id;Magic UI 目录里还没搬的组件用 mu-<name> 读(见 card_authoring_guide 末尾的目录)。素材封装卡(lottie-* / particles-*)是按素材目录生成的,没有单独的源码文件 —— 要改它们的画法,读 lottie / particles 这两张卡。`,
          });
        }
        const closure = importClosure(root, defFile);
        const target = wantFile || defFile;
        if (!closure.includes(target)) {
          return sendJson(res, 400, { ok: false, error: `"${target}" 不在卡片 ${id} 的源码文件里。能读的是:${closure.join('、')}` });
        }
        const counts = sharedByCounts(root);
        const source = fs.readFileSync(path.join(root, target), 'utf8');
        const builtin = !defFile.startsWith('src/cards/user/');
        sendJson(res, 200, {
          ok: true, id, file: target, source, lines: source.split('\n').length, builtin,
          files: closure.map((f) => ({ file: f, sharedBy: counts.get(f) || 1 })),
          ...(builtin ? { hint: '这是内置卡。改它用 edit_card(可以带 file 改它用到的部件 / vendor 文件);sharedBy > 1 的文件是多张卡共用的,改了它们都会跟着变。改完用 see_frames 看一眼画面。' } : {}),
        });
      });

      /**
       * 局部替换式改卡:给一段 find、一段 replace,只动那一处。用户卡和内置卡都行,带 file 可以改部件文件。
       *
       * 相对 create_card + overwrite 的意义不在省字数,在于**没提到的地方一定不变**。
       * 所以 find 必须唯一命中:命中 0 次说明调用方手上的版本是旧的,命中多次说明
       * 它想改哪一处根本没说清 —— 两种都该报错让它先读回源码,而不是替它猜。
       *
       * 能改的只有这张卡的源码闭包(定义文件 + 它用到的卡片 / 部件文件),而且只能是源码 / 样式文件。
       * 用户卡的定义文件走和建卡一样的校验;内置 / 共用文件走 checkSourceEdit(语法 + 不许新加不跟帧走的写法
       * + CardDef 导出和 id 不许动),改之前备份到 out/card-edits/。
       */
      server.middlewares.use('/api/cards/edit', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });

        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_EDIT_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          try {
            const { id, file, find, replace, replaceAll } = JSON.parse(body || '{}');
            if (typeof id !== 'string' || typeof find !== 'string' || typeof replace !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'id、find、replace 都必须是字符串' });
            }
            if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `卡片 id "${id}" 不合法。` });

            const root = server.config.root;
            const defFile = findCardFile(root, id);
            if (!defFile) {
              return sendJson(res, 404, { ok: false, error: `找不到卡片 "${id}" 的源码。先用 get_card_source 确认 id 和能改的文件。` });
            }
            const closure = importClosure(root, defFile);
            const target = typeof file === 'string' && file ? file : defFile;
            if (!closure.includes(target) || !isEditablePath(target)) {
              return sendJson(res, 400, { ok: false, error: `"${target}" 不是卡片 ${id} 的源码文件,不能改。能改的是:${closure.join('、')}` });
            }

            const abs = path.join(root, target);
            const before = fs.readFileSync(abs, 'utf8');
            const patch = applyCardPatch(before, find, replace, replaceAll === true);
            if (!patch.ok) return sendJson(res, 400, { ok: false, error: patch.error });
            const { after, replaced } = patch;

            const isUserDef = target === defFile && defFile.startsWith('src/cards/user/');
            // 用户卡的定义文件和 create 走同一套校验:局部替换一样能把文件改到编译不过
            const check = isUserDef ? checkCardSource(id, after, []) : checkSourceEdit(target, before, after);
            if (!check.ok) {
              return sendJson(res, 400, { ok: false, error: check.errors.join('\n'), errors: check.errors });
            }

            const backup = isUserDef ? undefined : backupBeforeEdit(root, target, before);
            fs.writeFileSync(abs, after, 'utf8');
            const sharedBy = sharedByCounts(root).get(target) || 1;
            sendJson(res, 200, {
              ok: true,
              id,
              file: target,
              replaced,
              source: after,
              builtin: !defFile.startsWith('src/cards/user/'),
              sharedBy,
              ...(backup ? { backup } : {}),
              hint: sharedBy > 1
                ? `已改写并热更新。这个文件被 ${sharedBy} 张卡共用,它们都会跟着变。改完用 see_frames 看一眼画面。`
                : '已改写并热更新。改完用 see_frames 看一眼画面,再决定要不要接着调。',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /*
       * 只读 DOM 树(inspect_card_dom 的服务端)。
       *
       * 用导出同一条渲染管线(scripts/export-frames.mjs)把单独这一个片段渲到指定那一帧,
       * 在页面里采出折叠过包装层的树,再用 source map 把每个节点的渲染位置换回源码行号。
       * 自己留一个 bakery(闲 90 秒自动关),不占 vite-plugin-vision 的渲染池 —— 两边互不牵制。
       * 同一时刻的树缓存起来:模型「往下看」一个 ref 时不用重渲一遍。源码一改,缓存全清。
       */
      let domBakery: any = null;
      let domIdle: ReturnType<typeof setTimeout> | null = null;
      let domChain: Promise<unknown> = Promise.resolve();
      const domTrees = new Map<string, { nodes: DomNode[]; header: string }>();
      const mapCache = new Map<string, number[][][] | null>();
      server.watcher?.on('change', () => { mapCache.clear(); domTrees.clear(); });
      const mapFor = async (urlPath: string) => {
        if (mapCache.has(urlPath)) return mapCache.get(urlPath) ?? null;
        let decoded: number[][][] | null = null;
        try {
          const env = (server as any).environments?.client;
          const r = env?.transformRequest ? await env.transformRequest(urlPath) : await server.transformRequest(urlPath);
          const m = r?.map as any;
          if (m && typeof m.mappings === 'string') decoded = decodeMappings(m.mappings);
        } catch { /* 拿不到就退回转换后的行号,并标出来 */ }
        mapCache.set(urlPath, decoded);
        return decoded;
      };
      const renderDomTree = async (origin: string, isoProject: any, frame: number): Promise<DomNode[]> => {
        const tl = 'data:application/json,' + encodeURIComponent(JSON.stringify(isoProject));
        const url = `${origin}/?export=1&timeline=${encodeURIComponent(tl)}`;
        const mod = await import(pathToFileURL(path.join(server.config.root, 'scripts', 'export-frames.mjs')).href);
        if (domIdle) clearTimeout(domIdle);
        try {
          if (!domBakery) domBakery = await mod.openBakery({ url });
          else await domBakery.reset(null, url);
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dom-'));
          try {
            await mod.bakeFrames(domBakery, { out: tmp, targetFrames: [frame], format: 'jpeg', quality: 40 });
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
          const nodes: DomNode[] = await domBakery.page.evaluate(EXTRACT_DOM);
          for (const n of nodes) {
            if (!n.site) continue;
            const dec = await mapFor(n.site.path);
            const o = dec ? originalPosition(dec, n.site.line, n.site.col) : null;
            n.where = `${n.site.path.slice(1)}:${o ? o.line : `${n.site.line}(转换后行号)`}`;
          }
          return nodes;
        } catch (e) {
          try { await domBakery?.close(); } catch { /* ignore */ }
          domBakery = null;
          throw e;
        } finally {
          domIdle = setTimeout(() => { domBakery?.close().catch(() => {}); domBakery = null; }, 90_000);
          domIdle.unref?.();
        }
      };

      server.middlewares.use('/api/cards/dom', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
          // 一次只渲一个:共用一个 bakery,并发进来的排队
          domChain = domChain.then(async () => {
            try {
              const { project, clipId, t, ref, depth } = JSON.parse(body || '{}');
              if (!project || typeof clipId !== 'string') return sendJson(res, 400, { ok: false, error: 'project 和 clipId 必填' });
              const iso = isolateClipForDom(project, clipId);
              if (!iso) return sendJson(res, 404, { ok: false, error: `项目里找不到片段 ${clipId}` });
              const fps = Number(project.fps) || 30;
              const { clip } = iso;
              const tt = typeof t === 'number' && Number.isFinite(t)
                ? Math.min(Math.max(t, clip.start), clip.end - 1 / fps)
                : (clip.start + clip.end) / 2;
              const frame = Math.max(0, Math.round(tt * fps));
              /*
               * 挪到固定起跑线上再渲:导出从第 0 帧顺推,片段排在第 50 秒就得先推一千多帧。卡片画面和它在
               * 时间轴上的绝对位置无关(提交 4edf40e 逐卡验过 34/34),所以把它挪到 0.5 秒处 ——
               * 不挪到 0 是因为第 0 帧上有预热,压着第 0 帧的卡会多经历一段(同一个提交里实测过)。
               * 片内位置用整数帧号换算,不用秒相减(浮点减法会让同一帧算出两个键)。
               */
              const LEAD_IN = 15; // 0.5 秒 @30fps;按帧数给,换 fps 也是整数帧
              const clipStartFrame = Math.round(clip.start * fps);
              const inClip = frame - clipStartFrame;
              const shiftedStart = LEAD_IN / fps;
              const shifted = { ...clip, start: shiftedStart, end: shiftedStart + (clip.end - clip.start) };
              const renderProject = {
                ...iso.project,
                duration: shifted.end + 1,
                tracks: iso.project.tracks.map((tr: any) => ({ ...tr, clips: [shifted] })),
              };
              const renderFrame = LEAD_IN + inClip;
              const key = crypto.createHash('sha1').update(JSON.stringify(renderProject)).digest('hex') + '@' + renderFrame;
              let entry = domTrees.get(key);
              const cached = !!entry;
              if (!entry) {
                const nodes = await renderDomTree(`http://${req.headers.host}`, renderProject, renderFrame);
                entry = { nodes, header: `片段 ${clipId}(${clip.cardId ?? '素材'})第 ${frame} 帧(t=${(frame / fps).toFixed(3)}s,片内第 ${inClip} 帧),折叠包装层后 ${nodes.length} 个节点。` };
                domTrees.set(key, entry);
                if (domTrees.size > 20) domTrees.delete(domTrees.keys().next().value as string);
              }
              const refNum = typeof ref === 'string' ? Number(ref.replace(/^ref_/, '')) : ref;
              const from = Number.isInteger(refNum) && entry.nodes[refNum] ? refNum : 0;
              const d = Math.max(1, Math.min(8, Number(depth) || 3));
              const text = entry.nodes.length
                ? formatDomTree(entry.nodes, from, d)
                : '(舞台上什么都没有 —— 这一刻这张卡还没进场或已经退场)';
              sendJson(res, 200, {
                ok: true, clipId, frame, t: frame / fps, nodes: entry.nodes.length, cached,
                text: `${entry.header}${from ? `从 ref_${from} ` : ''}往下 ${d} 层:\n${text}`,
                hint: '这棵树只能看、不能改:舞台上的 HTML 是源码渲染出来的。要改哪个节点,用 get_card_source 读它标出的那个文件,再用 edit_card(带 file)改那一行。',
              });
            } catch (e: any) {
              sendJson(res, 500, { ok: false, error: e?.message || String(e) });
            }
          }).catch(() => {});
        });
      });

      server.middlewares.use('/api/cards/create', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });

        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_SOURCE_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          try {
            const { id, source, existingIds, overwrite, projectId } = JSON.parse(body || '{}');
            if (typeof id !== 'string' || typeof source !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'id 和 source 都必须是字符串' });
            }

            fs.mkdirSync(userDir, { recursive: true });
            const target = path.join(userDir, `${id}.tsx`);
            // id 已经过 kebab-case 白名单,这里再确认一次落点没跑出 user 目录
            if (path.dirname(path.resolve(target)) !== path.resolve(userDir)) {
              return sendJson(res, 400, { ok: false, error: '非法的文件路径' });
            }

            const already = fs.existsSync(target);
            if (already && !overwrite) {
              // 这句话出现的时机,正是模型「想改一张已有的卡」的那一刻 —— 全仓库
              // 最该把它引到 edit_card 上的地方。原来这里写的是「传 overwrite: true」,
              // 等于在决策点上教它整篇重写。
              return sendJson(res, 409, {
                ok: false,
                error: `src/cards/user/${id}.tsx 已存在。要改它请用 get_card_source 读回源码、再用 edit_card 改那一处;确实要整张推倒重来才传 overwrite: true。`,
              });
            }

            // 先过翻译器的机械一半(去 "use client"、@/lib/utils 指到本地),再审查。
            // 翻译改过什么要回给调用方,不然模型手上的版本和落盘的对不上。
            const translated = translateCardSource(source);
            const finalSource = translated.source;
            const check = checkCardSource(id, finalSource, Array.isArray(existingIds) && !already ? existingIds : [], {
              vendored: translated.rewrites.length > 0,
            });
            if (!check.ok) {
              return sendJson(res, 400, {
                ok: false,
                error: check.errors.join('\n'),
                errors: check.errors,
                findings: check.findings ?? [],
                rewrites: translated.rewrites,
              });
            }

            // 上游 props 里有、controls 里没露出来的,列出来供模型决定要不要提成参数
            const declared = new Set([...finalSource.matchAll(/\bkey:\s*["']([^"']+)["']/g)].map((m) => m[1]));
            const suggestedControls = suggestControls(finalSource).filter((s) => !declared.has(s.key));

            fs.writeFileSync(target, finalSource, 'utf8');

            /*
             * 盖归属戳。默认 project = 只在建它的这个项目里出现 —— 这是止血的那一下:
             * 定制卡多半是给某个客户/某条片子做的,默认共享才是反直觉的那个选择。
             * 想跨项目复用,在聊天面板里把它改成「自定义素材」即可。
             * 覆盖重写(overwrite)时不动已有的档位,免得用户设过的共享被一次改卡冲掉。
             */
            {
              const m = readScopes();
              if (!m[id]) {
                m[id] = { scope: "project", createdAt: new Date().toISOString(), ...(typeof projectId === "string" && projectId ? { projectId } : {}) };
                writeScopes(m);
              }
            }
            sendJson(res, 200, {
              ok: true,
              id,
              file: `src/cards/user/${id}.tsx`,
              overwritten: already,
              rewrites: translated.rewrites,
              suggestedControls,
              // 把落盘后的源码原样回给调用方。少了这一步,模型下次想改这张卡时手上
              // 没有当前版本,只能凭记忆整篇重写 —— 实测那会让没被提到的细节每重写
              // 一次就漂一点(同一张卡的字号一路 42→56→42→32)。
              source: finalSource,
              lines: finalSource.split('\n').length,
              hint: '已写入并热更新。要再改它请用 edit_card 做局部替换,不要用 create_card 整篇重写。',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}
