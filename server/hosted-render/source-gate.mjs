/**
 * 托管方渲染服务隔离工作进程的「同步文件预检」（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节）。
 *
 * 项目带来的卡片文件（`.tsx` / `.ts` / `.css`，只在 `src/cards/`、`src/parts/` 下）由工作进程里的 Vite 与 Tailwind **在 Node 一侧**处理
 * 之后才交给渲染用的 Chrome。Node 一侧的处理会按文件里写的路径去读盘、甚至载入脚本：
 *
 *   - 样式里的 `@import "<路径>"`：Node 一侧把那个文件读进来并进这份样式（任意路径；内容随样式到页面，或随报错的代码框到页面）；
 *   - 样式里的 `@plugin` / `@config`：Tailwind 把那个文件当构建插件**在 Node 里执行**；`@source`：扫那个目录；`@reference`：同 `@import`；
 *   - 样式里的 `url(<路径>?inline)`：Node 一侧把文件读成 data URI；
 *   - 脚本里的 `import.meta.glob("<模式>")`：Node 一侧按模式列文件名（模式可以用 `..` 走出检出目录）；
 *     带变量的动态 `import()` 与 `new URL(模板, import.meta.url)` 被 Vite 改写成同样的列目录；
 *   - `sourceMappingURL` 注释：转译器按它去读「原始映射」文件；`@jsxImportSource` 注释：把一个任意路径变成导入。
 *
 * 浏览器一侧再去取文件有 Vite 的 `server.fs.strict` 与页面请求闸挡着；上面这些发生在 Node 里，那两道挡不住。所以在这里按白名单预检，
 * 不过的文件**不装**（卡片同步回「被拒」，这张卡的代码身份对不上，任务不认领），装进了改动层的也**不交给 Vite**（加载钩子换成一段报错的桩）。
 *
 * 只在托管方的工作进程里用（`hostedWorkerKind()` 非空）；桌面版与普通的独立渲染主机不经过这里，行为不变。
 *
 * 规则（路径一律按仓库相对路径算，`rel` 是这个文件自己的）：
 *   样式：
 *     - `@` 规则只许白名单里的（`CSS_AT_ALLOW`）；`@import` 另算：只许 `@import "<相对路径>.css";`，目标仍在 `src/cards/` 或 `src/parts/` 里；
 *       `@plugin`、`@config`、`@source`、`@reference`、`@tailwind` 等一律不许；`@` 规则名里不许有转义；
 *     - 每个 `url(…)`（出现 `image-set(` 时连同每个字符串）：不许反斜杠；带协议的只许 `data:`、`http:`、`https:`、`blob:`；`/` 开头的不许 `/@…`、不许 `..`；
 *       相对路径算下来必须还在 `src/` 里。
 *   脚本：
 *     - 静态导入导出、`import("字面量")`：包名（不许有 `.`、`..` 段）；`node:` / `data:` / `http(s):` / `blob:`；`/src/…`；相对路径算下来在 `src/` 里；
 *     - 动态 `import()` 的参数必须是字符串字面量；
 *     - `import.meta.glob`：只能直接调用，模式是字符串字面量（或它们的数组），算下来在 `src/` 里；不许 `base` 选项；
 *     - `new URL(x, import.meta.url)`：`x` 是字符串字面量，算下来在 `src/` 里。
 *   两者：不许出现 `sourceMappingURL`；脚本不许 `@jsxImportSource`。
 */
import path from 'node:path';
import ts from 'typescript';

/** 托管方工作进程的种类：管理进程起工作进程时给（`resident` / `isolated`）；不是托管方的工作进程回 null */
export const HOSTED_WORKER_ENV = 'PROMPTCUT_HOSTED_WORKER';
export function hostedWorkerKind(env = process.env) {
  const v = String(env?.[HOSTED_WORKER_ENV] ?? '').trim();
  return v === 'resident' || v === 'isolated' ? v : null;
}

/** 样式里许可的 `@` 规则（不碰文件系统的那些）；`@import` 另有规则 */
export const CSS_AT_ALLOW = Object.freeze(new Set([
  'charset', 'namespace', 'media', 'supports', 'container', 'layer', 'scope', 'starting-style',
  'keyframes', '-webkit-keyframes', '-moz-keyframes', 'font-face', 'font-feature-values', 'font-palette-values',
  'property', 'counter-style', 'page', 'position-try', 'view-transition',
  // Tailwind 里只在编译期改写样式、不读文件的几条
  'apply', 'theme', 'utility', 'variant', 'custom-variant', 'slot',
]));

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const URL_SCHEMES = new Set(['data:', 'http:', 'https:', 'blob:']);
const IMPORT_SCHEMES = new Set(['node:', 'data:', 'http:', 'https:', 'blob:']);

const stripQuery = (s) => s.split(/[?#]/)[0];

/** `target` 相对 `rel` 所在目录算出的仓库相对路径（正斜杠）；走出仓库根的回以 `../` 开头的串 */
function resolveRel(rel, target) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
}
const inside = (p, dirs) => dirs.some((d) => p === d.slice(0, -1) || p.startsWith(d));

/**
 * 一个路径形的值（样式里的字符串、`url()`；脚本里的相对或根相对说明符）落在哪：回 null 表示可以，否则回原因。
 * @param {string} rel 文件自己的仓库相对路径
 * @param {string} raw
 * @param {{ schemes: Set<string>, roots: string[], rootAbsolute: 'src' | 'any' }} o
 */
function pathProblem(rel, raw, { schemes, roots, rootAbsolute }) {
  const value = String(raw).trim();
  if (value === '') return null;
  if (value.includes('\\')) return '带反斜杠';
  if (value.includes('\0')) return '带空字符';
  if (value.startsWith('#')) return null;
  if (SCHEME_RE.test(value)) {
    const scheme = value.slice(0, value.indexOf(':') + 1).toLowerCase();
    return schemes.has(scheme) ? null : `不许的协议 ${scheme}`;
  }
  if (value.startsWith('//')) return null; // 别的主机：Node 一侧不取，浏览器一侧由出口限制管
  const bare = stripQuery(value);
  if (bare.startsWith('/')) {
    if (bare.startsWith('/@')) return '指向开发服务器的内部路径（/@…）';
    if (bare.split('/').some((seg) => seg === '..')) return '根路径里带 ..';
    if (rootAbsolute === 'src' && !bare.startsWith('/src/')) return '根路径只许 /src/ 下的';
    return null;
  }
  const at = resolveRel(rel, bare);
  if (at.startsWith('../') || at === '..' || !inside(at, roots)) return `走出了 ${roots.map((r) => r.slice(0, -1)).join(' 或 ')}`;
  return null;
}

/* ------------------------------------------------------------------ 样式 */

/**
 * 样式的粗词法：跳过注释，取出字符串、`url(…)` 的内容与 `@` 规则（名字、它后面到 `;` 或 `{` 为止的原文）。
 * 不求把样式完全解析对，只求**不比真正处理它的工具少看见东西**：拿不准的一律算进来。
 */
export function scanCss(source) {
  const s = String(source);
  const strings = [];
  const urls = [];
  const atRules = [];
  let i = 0;
  const readString = (quote) => {
    let out = '';
    i += 1;
    while (i < s.length && s[i] !== quote) {
      if (s[i] === '\\' && i + 1 < s.length) { out += s[i] + s[i + 1]; i += 2; continue; }
      if (s[i] === '\n') break;
      out += s[i];
      i += 1;
    }
    i += 1;
    return out;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') { const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 2; continue; }
    if (c === '"' || c === "'") { strings.push(readString(c)); continue; }
    if (c === '@') {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_\\-]/.test(s[j])) j += 1;
      const name = s.slice(i + 1, j);
      // 规则的头：到 `;`、`{` 或文件尾（字符串与注释里的不算）
      let k = j;
      let head = '';
      while (k < s.length && s[k] !== ';' && s[k] !== '{' && s[k] !== '}') {
        if (s[k] === '/' && s[k + 1] === '*') { const end = s.indexOf('*/', k + 2); k = end < 0 ? s.length : end + 2; head += ' '; continue; }
        if (s[k] === '"' || s[k] === "'") { const q = s[k]; let m = k + 1; while (m < s.length && s[m] !== q && s[m] !== '\n') m += s[m] === '\\' ? 2 : 1; head += s.slice(k, m + 1); k = m + 1; continue; }
        head += s[k];
        k += 1;
      }
      atRules.push({ name, head: head.trim() });
      i = j;
      continue;
    }
    if ((c === 'u' || c === 'U') && /^url\(/i.test(s.slice(i, i + 4)) && !/[A-Za-z0-9_-]/.test(s[i - 1] ?? ' ')) {
      i += 4;
      while (i < s.length && /\s/.test(s[i])) i += 1;
      if (s[i] === '"' || s[i] === "'") { const v = readString(s[i]); urls.push(v); strings.push(v); }
      else {
        let v = '';
        while (i < s.length && s[i] !== ')') { v += s[i]; i += 1; }
        urls.push(v.trim());
      }
      continue;
    }
    i += 1;
  }
  return { strings, urls, atRules };
}

const CSS_ROOTS = ['src/cards/', 'src/parts/'];

function checkCss(rel, source, errors, { rootHas = null } = {}) {
  const { strings, urls, atRules } = scanCss(source);
  for (const at of atRules) {
    const name = at.name.toLowerCase();
    if (name === '') continue; // 孤立的 @（选择器里的转义等）：不是规则
    if (at.name.includes('\\')) { errors.push(`@ 规则名里有转义：@${at.name}`); continue; }
    if (name === 'import') {
      const m = /^(?:"([^"\\]*)"|'([^'\\]*)')$/.exec(at.head);
      const target = m ? (m[1] ?? m[2]) : null;
      if (target === null) { errors.push(`@import 只许写成 @import "<相对路径>.css";（没有 url()、layer、媒体条件）：@import ${at.head.slice(0, 80)}`); continue; }
      if (!/^\.\.?\//.test(target) || !/\.css$/.test(target) || /[?#]/.test(target)) { errors.push(`@import 只许相对路径的 .css 文件：${target.slice(0, 80)}`); continue; }
      const at2 = resolveRel(rel, target);
      if (!inside(at2, CSS_ROOTS)) errors.push(`@import 的目标走出了 src/cards 或 src/parts：${target.slice(0, 80)}`);
      continue;
    }
    if (!CSS_AT_ALLOW.has(name)) errors.push(`不许的 @ 规则：@${at.name}`);
  }
  // 普通字符串（`content: "\201C"` 之类）不是路径，不查；只有 `image-set("a.png" 1x)` 把裸字符串当地址，出现它时才连字符串一起查
  const asPaths = /image-set\s*\(/i.test(source) ? [...strings, ...urls] : urls;
  for (const value of [...new Set(asPaths)]) {
    let why = pathProblem(rel, value, { schemes: URL_SCHEMES, roots: ['src/'], rootAbsolute: 'any' });
    /*
     * 以 / 开头的地址：开发服务器先当「相对项目根」找，找不到再当**文件系统的绝对路径**找（Linux 上 url(/etc/x.svg)、
     * url(/tmp/x?inline) 会被 Node 一侧读进来变成 data URI）。所以只认项目根下确实有的那个文件（public/ 里的同样算）；
     * 没给 rootHas（单测）时只认 /src/ 下的。
     */
    const bare = stripQuery(String(value).trim());
    if (!why && bare.startsWith('/') && !bare.startsWith('//')) {
      const inRoot = rootHas ? (rootHas(bare.slice(1)) || rootHas('public' + bare)) : bare.startsWith('/src/');
      if (!inRoot) why = rootHas ? '指向项目根下没有的文件（会被当成文件系统的绝对路径）' : '根路径只许 /src/ 下的';
    }
    if (why) errors.push(`样式里的路径${why}：${value.slice(0, 80)}`);
  }
}

/* ------------------------------------------------------------------ 脚本 */

const literalText = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

const isImportMeta = (node) => !!node && ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta';
/** `import.meta.<name>` 或 `import.meta["<name>"]`：回 name，不是就回 null */
function importMetaMember(node) {
  if (!node) return null;
  if (ts.isPropertyAccessExpression(node) && isImportMeta(node.expression)) return node.name.text;
  if (ts.isElementAccessExpression(node) && isImportMeta(node.expression)) return literalText(node.argumentExpression) ?? '?';
  return null;
}

function specifierProblem(rel, spec) {
  const value = String(spec);
  if (value.includes('\\') || value.includes('\0')) return '带反斜杠或空字符';
  if (SCHEME_RE.test(value)) {
    const scheme = value.slice(0, value.indexOf(':') + 1).toLowerCase();
    return IMPORT_SCHEMES.has(scheme) ? null : `不许的协议 ${scheme}`;
  }
  if (value.startsWith('.') || value.startsWith('/')) {
    if (value.startsWith('//')) return '协议相对的地址';
    return pathProblem(rel, value, { schemes: IMPORT_SCHEMES, roots: ['src/'], rootAbsolute: 'src' });
  }
  // 包名：不许带 .、.. 段（`pkg/../../x` 会走出 node_modules）
  if (stripQuery(value).split('/').some((seg) => seg === '.' || seg === '..' || seg === '')) return '包名里带 . 或 .. 段';
  return null;
}

function checkScript(rel, source, errors) {
  if (/@jsxImportSource\b/.test(source)) errors.push('不许 @jsxImportSource 注释');
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const bad = (node, message) => errors.push(`第 ${lineOf(node)} 行：${message}`);
  const checkSpec = (node, what) => {
    const text = literalText(node);
    if (text === null) return bad(node, `${what}要是字符串字面量`);
    const why = specifierProblem(rel, text);
    if (why) bad(node, `${what}${why}：${text.slice(0, 80)}`);
  };
  const globCalls = new Set();
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) checkSpec(node.moduleSpecifier, '导入的模块');
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) checkSpec(node.moduleReference.expression, '导入的模块');
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length < 1) bad(node, '动态 import() 没有参数');
        else checkSpec(node.arguments[0], '动态 import() 的参数');
      } else {
        const member = importMetaMember(node.expression);
        if (member !== null && /^glob/i.test(member)) {
          globCalls.add(node.expression);
          const first = node.arguments[0];
          const patterns = first && ts.isArrayLiteralExpression(first) ? [...first.elements] : first ? [first] : [];
          if (patterns.length === 0) bad(node, 'import.meta.glob 没有模式');
          for (const p of patterns) {
            const text = literalText(p);
            if (text === null) { bad(p, 'import.meta.glob 的模式要是字符串字面量'); continue; }
            const body = text.startsWith('!') ? text.slice(1) : text;
            if (!(body.startsWith('./') || body.startsWith('../') || body.startsWith('/src/'))) { bad(p, `import.meta.glob 的模式只许 ./、../ 或 /src/ 开头：${text.slice(0, 80)}`); continue; }
            const why = pathProblem(rel, body, { schemes: new Set(), roots: ['src/'], rootAbsolute: 'src' });
            if (why) bad(p, `import.meta.glob 的模式${why}：${text.slice(0, 80)}`);
          }
          const opts = node.arguments[1];
          if (opts) {
            if (!ts.isObjectLiteralExpression(opts)) bad(opts, 'import.meta.glob 的选项要是对象字面量');
            else for (const prop of opts.properties) {
              const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
              if (name === null || name === 'base') bad(prop, 'import.meta.glob 不许 base 选项、展开或计算出来的键');
            }
          }
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && (node.arguments?.length ?? 0) >= 2) {
      const base = node.arguments[1];
      if (importMetaMember(base) === 'url') {
        const text = literalText(node.arguments[0]);
        if (text === null) bad(node, 'new URL(…, import.meta.url) 的第一个参数要是字符串字面量');
        else {
          const why = specifierProblem(rel, text.startsWith('.') || text.startsWith('/') ? text : `./${text}`);
          if (why) bad(node, `new URL(…, import.meta.url) 的路径${why}：${text.slice(0, 80)}`);
        }
      }
    }
    // `import.meta.glob` 不是直接调用（赋给变量、传给别的函数）：开发服务器只认直接调用，别的写法一律不许
    const member = importMetaMember(node);
    if (member !== null && /^glob/i.test(member) && !globCalls.has(node)) {
      const parent = node.parent;
      if (!(parent && ts.isCallExpression(parent) && parent.expression === node)) bad(node, 'import.meta.glob 只能直接调用');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/* ------------------------------------------------------------------ 入口 */

/** 同步文件的大小上限（字节）；超过的不装（卡片同步自己另有上限，这里兜底） */
export const SOURCE_GATE_MAX_BYTES = 512 * 1024;

/**
 * 一个同步来的文件能不能交给 Node 一侧处理。
 * @param {string} rel 仓库相对路径（正斜杠）
 * @param {string} source
 * @param {{ rootHas?: (relFromRoot: string) => boolean }} [o] rootHas：项目根下有没有这个文件（样式里以 / 开头的地址据此判，见 checkCss）
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkSyncedSource(rel, source, o = {}) {
  const errors = [];
  const file = String(rel).replace(/\\/g, '/');
  const text = String(source ?? '');
  if (!(file.startsWith('src/cards/') || file.startsWith('src/parts/')) || file.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    return { ok: false, errors: [`不在 src/cards 或 src/parts 下：${file.slice(0, 120)}`] };
  }
  if (Buffer.byteLength(text, 'utf8') > SOURCE_GATE_MAX_BYTES) errors.push(`超过 ${SOURCE_GATE_MAX_BYTES / 1024} KB`);
  if (/sourceMappingURL/.test(text)) errors.push('不许出现 sourceMappingURL');
  if (text.includes('\0')) errors.push('带空字符');
  try {
    if (/\.css$/.test(file)) checkCss(file, text, errors, o);
    else if (/\.tsx?$/.test(file)) checkScript(file, text, errors);
    else errors.push('只收 .tsx、.ts、.css');
  } catch (err) {
    errors.push(`预检出错：${String(err?.message ?? err).slice(0, 200)}`);
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 20) };
}

/** 预检不过的文件交给 Vite 时用的桩：脚本抛错（这张卡载入失败），样式是一段空注释 */
export function rejectedStub(rel, errors, { raw = false } = {}) {
  const why = `托管方渲染服务没有载入这个文件（同步文件预检不过）：${rel} —— ${errors.slice(0, 3).join('；')}`;
  if (raw) return `export default ${JSON.stringify(`/* ${why.replace(/\*\//g, '* /')} */`)}`;
  if (/\.css$/.test(rel)) return `/* ${why.replace(/\*\//g, '* /')} */\n`;
  return `throw new Error(${JSON.stringify(why)});\nexport {};\n`;
}
