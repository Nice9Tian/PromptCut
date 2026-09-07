import type { Plugin, ViteDevServer } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

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
  const lottie = read('lottie');
  if (lottie) {
    out.push(`## 附:Lottie 素材(${lottie.items.length},${lottie.license})`, '',
      '用法:`add_clip({ cardId: "lottie", params: { src: "<url>" } })`,clip 时长照着 seconds 给;想循环就加 `loop: "yes"`。', '',
      ...lottie.items.map((i: any) => `- \`${i.url}\` —— ${i.description};${i.seconds}s,${i.w}×${i.h}`), '');
  }
  const particles = read('particles');
  if (particles) {
    const featured = particles.items.filter((i: any) => i.featured);
    const rest = particles.items.filter((i: any) => !i.featured);
    out.push(`## 附:粒子配置(${particles.items.length},${particles.license})`, '',
      '用法:`add_clip({ cardId: "particles", params: { config: "<url>", seed: 1 } })`。都是背景,通常盖住整段时长放最底层;换 seed 换排布。每个都在导出管线上实跑验证过。', '',
      `### 推荐(${featured.length})`, ...featured.map((i: any) => `- \`${i.url}\` —— ${i.description}`), '',
      `### 其他(${rest.length},多是同一外观的变体)`,
      rest.map((i: any) => `\`${i.name}\`(${i.description})`).join('、'), '');
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
export function reviewCardSource(source: string, hints?: { vendored?: boolean }): CardFinding[] {
  const f: CardFinding[] = [];
  const push = (tier: CardFinding['tier'], rule: string, detail: string) => f.push({ tier, rule, detail });

  // ── 第二档:管线接不住 ──
  // canvas 和 Math.random 曾经在这一档,现在不在了:导出页把 Math.random 钉成带种子的、截图期间
  // 关掉脚本执行(exportClock.ts / export-frames.mjs 的 shoot),静态跳过的探针也看得见 canvas。
  // 实测 tsParticles 粒子卡「新鲜 vs 复用 vs 跳过」逐字节 0 差异。剩下接不住的是 WebGL 三维库。
  if (/\bWebGLRenderingContext\b|getContext\s*\(\s*["']webgl2?["']/.test(source)) {
    push(2, 'WebGL', 'WebGL 的光栅化走 GPU 路径,导出用的是软件光栅化且两次不完全一致,现在接不住。');
  }
  if (/\bfrom\s+["'](three|@react-three\/[^"']+|cobe|@react-three-fiber[^"']*)["']/.test(source)) {
    push(2, '三维库', 'three / cobe 走 WebGL,和上一条同一个问题,而且没装。');
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
        : `没装 ${spec}。能用的只有 react、motion/react、Tailwind class,以及相对路径引的 kernel/types、native/hud、magicui/vendor/*。`);
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
       * 读回一张用户卡的当前源码。
       *
       * 没有这个口子的时候,改卡只能走 create_card + overwrite —— 那是整篇重写,
       * 模型手上没有当前版本,只能凭记忆重建,没被提到的细节每轮都会漂。
       * 先读回来,才谈得上「改」。只开到 user 目录:内置卡改参数就够了,不该被改源码。
       */
      server.middlewares.use('/api/cards/source', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const id = new URL(req.url || '', 'http://x').searchParams.get('id') || '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `卡片 id "${id}" 不合法。` });
        const target = path.join(userDir, `${id}.tsx`);
        if (path.dirname(path.resolve(target)) !== path.resolve(userDir)) {
          return sendJson(res, 400, { ok: false, error: '非法的文件路径' });
        }
        if (!fs.existsSync(target)) {
          // 不在 user 目录 → 看看是不是可搬目录里的 MagicUI 组件。返回的是**上游原始源码**,
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
            error: `src/cards/user/${id}.tsx 不存在。内置卡没有单独可读的源码文件,想调整内置卡请改它的参数(list_cards 看 schema,update_clip 改值)。Magic UI 目录里的组件用 mu-<name> 读(见 card_authoring_guide 末尾的目录)。`,
          });
        }
        const source = fs.readFileSync(target, 'utf8');
        sendJson(res, 200, { ok: true, id, file: `src/cards/user/${id}.tsx`, source, lines: source.split('\n').length });
      });

      /**
       * 局部替换式改卡:给一段 find、一段 replace,只动那一处。
       *
       * 相对 create_card + overwrite 的意义不在省字数,在于**没提到的地方一定不变**。
       * 所以 find 必须唯一命中:命中 0 次说明调用方手上的版本是旧的,命中多次说明
       * 它想改哪一处根本没说清 —— 两种都该报错让它先读回源码,而不是替它猜。
       */
      server.middlewares.use('/api/cards/edit', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });

        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_SOURCE_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          try {
            const { id, find, replace, replaceAll } = JSON.parse(body || '{}');
            if (typeof id !== 'string' || typeof find !== 'string' || typeof replace !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'id、find、replace 都必须是字符串' });
            }
            if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `卡片 id "${id}" 不合法。` });

            const target = path.join(userDir, `${id}.tsx`);
            if (path.dirname(path.resolve(target)) !== path.resolve(userDir)) {
              return sendJson(res, 400, { ok: false, error: '非法的文件路径' });
            }
            if (!fs.existsSync(target)) {
              return sendJson(res, 404, { ok: false, error: `src/cards/user/${id}.tsx 不存在,edit_card 只能改用 create_card 建出来的卡。` });
            }

            const before = fs.readFileSync(target, 'utf8');
            const patch = applyCardPatch(before, find, replace, replaceAll === true);
            if (!patch.ok) return sendJson(res, 400, { ok: false, error: patch.error });
            const { after, replaced } = patch;

            // 和 create 走同一套校验:局部替换一样能把文件改到编译不过
            const check = checkCardSource(id, after, []);
            if (!check.ok) {
              return sendJson(res, 400, { ok: false, error: check.errors.join('\n'), errors: check.errors });
            }

            fs.writeFileSync(target, after, 'utf8');
            sendJson(res, 200, {
              ok: true,
              id,
              file: `src/cards/user/${id}.tsx`,
              replaced,
              source: after,
              hint: '已改写并热更新。改完用 see_preview 看一眼画面,再决定要不要接着调。',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
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
            const { id, source, existingIds, overwrite } = JSON.parse(body || '{}');
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
