/**
 * 从一份卡片源码(`src/cards/user/*.tsx` 的原文)里取出它定义的卡片的 id 与名字,**不执行源码**。
 *
 * 用处(C10 契约第 9 节「识别」):在线浏览器模式的页面经文档服务读到内容库里同步来的卡片源码,但本机不能运行它们;
 * 页面只需要知道「这个 id 是一张用户卡、叫什么名字」,时间轴标真名、预览按本机跑不了的卡处理。
 *
 * 判据照 `src/cards/user/index.ts` 的 `isCardDef`,只是换成读源码:具名导出(含 `export default`、`export { a as b }`)
 * 的值是一个对象字面量,顶层写着字符串的 `id` 与 `name`,并写了 `defaults`、`controls`,以及 `Component` / `card` /
 * `audio` 之一(属性、简写、方法都算)。`id` / `name` 也认同一文件顶层 `const X = "..."` 定义的常量。
 * 值不是字面量(函数返回、展开别的对象)的认不出来,当它不是卡。
 *
 * 为此带一个够用的 TSX 词法器:字符串、模板字符串(含 `${}` 嵌套)、注释、正则字面量、JSX(文字里的撇号不当字符串)。
 * 纯函数,浏览器与 Node 同一份。
 */

const PUNCT3 = ["...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??="];
const PUNCT2 = ["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
/** 这些关键字之后是表达式开头(`/` 是正则,`<` 是 JSX) */
const EXPR_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof", "default", "export"]);
/** 这些标点之后是表达式开头 */
const EXPR_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "?", "=", "=>", "==", "===", "!=", "!==", "+", "-", "*", "%", "&", "|", "^", "!", "~",
  "<", ">", "<=", ">=", "&&", "||", "??", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "...", "}"]);

const isIdStart = (c) => /[\p{ID_Start}$_]/u.test(c);
const isIdPart = (c) => /[\p{ID_Continue}$‌‍]/u.test(c);

/** 解码字符串字面量的正文(不含引号) */
function decodeString(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "v") out += "\v";
    else if (n === "0" && !/[0-9]/.test(raw[i + 1] ?? "")) out += "\0";
    else if (n === "x") { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16) || 0); i += 2; }
    else if (n === "u") {
      if (raw[i + 1] === "{") {
        const end = raw.indexOf("}", i);
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16) || 0);
        i = end;
      } else { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16) || 0); i += 4; }
    } else if (n === "\r") { if (raw[i + 1] === "\n") i++; }
    else if (n === "\n" || n === " " || n === " ") { /* 续行 */ }
    else out += n;
  }
  return out;
}

/**
 * 词法器。`tokens` 只收最外层上下文的记号(模板里的 `${}`、JSX 里的 `{}` 整个吞掉,不出记号);
 * 每个记号带它所在的花括号 / 圆括号 / 方括号深度 `depth`。
 * 记号:`{ t: 'word' | 'punct' | 'string' | 'template' | 'number' | 'regex' | 'jsx', v, depth }`,
 * `string` 的 `v` 是解码后的值,不带替换的模板字符串的 `v` 也是它的值(带替换的 `v` 为 null)。
 */
class Lexer {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.last = null;
  }

  peek(k = 0) { return this.s[this.i + k]; }

  exprStart() {
    const t = this.last;
    if (!t) return true;
    if (t.t === "punct") return EXPR_PUNCT.has(t.v);
    if (t.t === "word") return EXPR_KEYWORDS.has(t.v);
    return false;
  }

  skipSpace() {
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) return;
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "﻿" || c === " " || c === " " || c === " ") { this.i++; continue; }
      if (c === "/" && this.s[this.i + 1] === "/") {
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
        continue;
      }
      if (c === "/" && this.s[this.i + 1] === "*") {
        const end = this.s.indexOf("*/", this.i + 2);
        this.i = end < 0 ? this.s.length : end + 2;
        continue;
      }
      return;
    }
  }

  readQuoted(q) {
    const start = ++this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") { this.i += 2; continue; }
      if (c === q) break;
      if (c === "\n") break;
      this.i++;
    }
    const raw = this.s.slice(start, this.i);
    this.i++;
    return decodeString(raw);
  }

  /** 模板字符串;回它的值(带替换时回 null) */
  readTemplate() {
    this.i++;
    let raw = "";
    let plain = true;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") { raw += c + (this.s[this.i + 1] ?? ""); this.i += 2; continue; }
      if (c === "`") { this.i++; break; }
      if (c === "$" && this.s[this.i + 1] === "{") {
        plain = false;
        this.i += 2;
        this.skipBalanced();
        continue;
      }
      raw += c;
      this.i++;
    }
    return plain ? decodeString(raw) : null;
  }

  /** 吞到与已经吃掉的那个 `{` 配对的 `}`(含);里面的字符串、模板、JSX、正则照常识别 */
  skipBalanced() {
    const saved = this.last;
    this.last = { t: "punct", v: "{" };
    let depth = 1;
    while (this.i < this.s.length) {
      const tok = this.token();
      if (!tok) break;
      if (tok.t === "punct") {
        if (tok.v === "{" || tok.v === "(" || tok.v === "[") depth++;
        else if (tok.v === "}" || tok.v === ")" || tok.v === "]") {
          depth--;
          if (depth === 0) break;
        }
      }
    }
    this.last = saved;
  }

  readRegex() {
    this.i++;
    let inClass = false;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") { this.i += 2; continue; }
      if (c === "\n") break;
      if (inClass) { if (c === "]") inClass = false; }
      else if (c === "[") inClass = true;
      else if (c === "/") { this.i++; break; }
      this.i++;
    }
    while (this.i < this.s.length && isIdPart(this.s[this.i])) this.i++;
  }

  /** `<` 后面像不像 JSX(不是 TS 泛型箭头函数 `<T,>` / `<T extends X>`) */
  looksLikeJsx() {
    const s = this.s;
    let j = this.i + 1;
    if (s[j] === ">") return true;
    if (!isIdStart(s[j] ?? "")) return false;
    while (j < s.length && (isIdPart(s[j]) || s[j] === "." || s[j] === "-" || s[j] === ":")) j++;
    const name = s.slice(this.i + 1, j);
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] === ",") return false;
    if (/^extends\b/.test(s.slice(j, j + 8)) && /^[A-Z]/.test(name)) return false;
    return true;
  }

  /** 吞一个 JSX 元素或片段(从 `<` 起) */
  skipJsx() {
    const s = this.s;
    this.i++;
    // 片段 `<>`
    if (s[this.i] === ">") { this.i++; this.skipJsxChildren(); return; }
    while (this.i < s.length && (isIdPart(s[this.i]) || s[this.i] === "." || s[this.i] === "-" || s[this.i] === ":")) this.i++;
    // 属性
    for (;;) {
      this.skipSpace();
      const c = s[this.i];
      if (c === undefined) return;
      if (c === "/" && s[this.i + 1] === ">") { this.i += 2; return; }
      if (c === ">") { this.i++; this.skipJsxChildren(); return; }
      if (c === "{") { this.i++; this.skipBalanced(); continue; }
      if (c === "\"" || c === "'") { this.readQuoted(c); continue; }
      if (c === "=") {
        this.i++;
        this.skipSpace();
        const v = s[this.i];
        if (v === "\"" || v === "'") this.readQuoted(v);
        else if (v === "{") { this.i++; this.skipBalanced(); }
        else if (v === "<") this.skipJsx();
        continue;
      }
      if (isIdPart(c) || c === "-" || c === ":") { while (this.i < s.length && (isIdPart(s[this.i]) || s[this.i] === "-" || s[this.i] === ":" || s[this.i] === ".")) this.i++; continue; }
      this.i++;
    }
  }

  skipJsxChildren() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "<" && s[this.i + 1] === "/") {
        const end = s.indexOf(">", this.i);
        this.i = end < 0 ? s.length : end + 1;
        return;
      }
      if (c === "<") { this.skipJsx(); continue; }
      if (c === "{") { this.i++; this.skipBalanced(); continue; }
      this.i++;
    }
  }

  /** 下一个记号;到头回 null */
  token() {
    this.skipSpace();
    const s = this.s;
    const c = s[this.i];
    if (c === undefined) return null;
    let tok;
    if (c === "\"" || c === "'") tok = { t: "string", v: this.readQuoted(c) };
    else if (c === "`") tok = { t: "template", v: this.readTemplate() };
    else if (c === "/" && this.exprStart()) { this.readRegex(); tok = { t: "regex", v: null }; }
    else if (c === "<" && this.exprStart() && this.looksLikeJsx()) { this.skipJsx(); tok = { t: "jsx", v: null }; }
    else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[this.i + 1] ?? ""))) {
      const start = this.i;
      while (this.i < s.length && /[0-9a-zA-Z_.]/.test(s[this.i])) this.i++;
      tok = { t: "number", v: s.slice(start, this.i) };
    } else if (isIdStart(c) || c === "#") {
      const start = this.i++;
      while (this.i < s.length && isIdPart(s[this.i])) this.i++;
      tok = { t: "word", v: s.slice(start, this.i) };
    } else {
      const three = s.slice(this.i, this.i + 3), two = s.slice(this.i, this.i + 2);
      const v = PUNCT3.includes(three) ? three : PUNCT2.includes(two) ? two : c;
      this.i += v.length;
      tok = { t: "punct", v };
    }
    this.last = tok;
    return tok;
  }

  /** 整份源码的记号表(带深度) */
  all() {
    const out = [];
    let depth = 0;
    for (;;) {
      const tok = this.token();
      if (!tok) break;
      if (tok.t === "punct" && (tok.v === "}" || tok.v === ")" || tok.v === "]")) depth = Math.max(0, depth - 1);
      tok.depth = depth;
      out.push(tok);
      if (tok.t === "punct" && (tok.v === "{" || tok.v === "(" || tok.v === "[")) depth++;
    }
    return out;
  }
}

/** 从 `open`(一个 `{` 记号)起配对到它的 `}`,回 `}` 的下标 */
function closeOf(tokens, open) {
  const d = tokens[open].depth;
  for (let k = open + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth === d && t.t === "punct" && (t.v === "}" || t.v === ")" || t.v === "]")) return k;
  }
  return tokens.length;
}

/**
 * 对象字面量(`open` 是它的 `{`)的顶层属性:`Map<键, 值的记号数组>`;简写属性与方法的值记成 null。
 * 展开(`...x`)记在 `spreads` 里(同文件顶层对象的名字;别的表达式记 null)。
 */
function objectProps(tokens, open) {
  const end = closeOf(tokens, open);
  const inner = tokens[open].depth + 1;
  const props = new Map();
  /** 展开的顶层标识符(`...base`),按出现先后;展开别的表达式时记 null */
  const spreads = [];
  let k = open + 1;
  while (k < end) {
    const t = tokens[k];
    if (t.depth !== inner) { k++; continue; }
    if (t.t === "punct" && t.v === ",") { k++; continue; }
    if (t.t === "punct" && t.v === "...") {
      const src = tokens[k + 1];
      const tail = tokens[k + 2];
      spreads.push(src && src.t === "word" && (!tail || tail.depth !== inner || (tail.t === "punct" && (tail.v === "," || tail.v === "}"))) ? { name: src.v, at: props.size } : null);
      while (k < end && !(tokens[k].depth === inner && tokens[k].t === "punct" && tokens[k].v === ",")) k++;
      continue;
    }
    // 键:标识符、字符串、数字;`get` / `set` / `async` 修饰的方法跳过修饰词
    let keyTok = t;
    if (t.t === "word" && (t.v === "get" || t.v === "set" || t.v === "async") && tokens[k + 1] && tokens[k + 1].depth === inner
      && (tokens[k + 1].t === "word" || tokens[k + 1].t === "string")) { k++; keyTok = tokens[k]; }
    let key = null;
    if (keyTok.t === "word" || keyTok.t === "number") key = keyTok.v;
    else if (keyTok.t === "string") key = keyTok.v;
    else if (keyTok.t === "template" && keyTok.v !== null) key = keyTok.v;
    const after = tokens[k + 1];
    if (key !== null && after && after.t === "punct" && after.v === ":" && after.depth === inner) {
      // `key: value` —— 值吃到下一个同层逗号或对象结尾
      const from = k + 2;
      let to = from;
      while (to < end && !(tokens[to].depth === inner && tokens[to].t === "punct" && tokens[to].v === ",")) to++;
      if (!props.has(key)) props.set(key, tokens.slice(from, to));
      k = to;
      continue;
    }
    if (key !== null && (!after || after.depth !== inner || (after.t === "punct" && (after.v === "," || after.v === "}")) || k + 1 >= end)) {
      // 简写
      if (!props.has(key)) props.set(key, null);
      k++;
      continue;
    }
    if (key !== null && after && after.t === "punct" && (after.v === "(" || after.v === "<" || after.v === "?")) {
      // 方法 `key(...) {...}` / `key<T>(...)`
      if (!props.has(key)) props.set(key, null);
      let to = k + 1;
      while (to < end && !(tokens[to].depth === inner && tokens[to].t === "punct" && tokens[to].v === ",")) to++;
      k = to;
      continue;
    }
    // 计算键 `[x]: v` 之类:跳到下一个同层逗号
    while (k < end && !(tokens[k].depth === inner && tokens[k].t === "punct" && tokens[k].v === ",")) k++;
  }
  return { props, spreads, end };
}

/**
 * 对象的顶层属性,展开的同文件顶层对象(`...base`)并进来;写在展开后面的属性覆盖展开进来的(简化:展开的属性只补缺,
 * 与卡片源码里「先展开、后覆盖」的常见写法一致)。展开链有环时停。
 */
function mergedProps(tokens, objects, at, seen = new Set()) {
  if (seen.has(at)) return new Map();
  seen.add(at);
  const { props, spreads } = objectProps(tokens, at);
  const out = new Map(props);
  for (const sp of spreads) {
    if (!sp) continue;
    const src = objects.get(sp.name);
    if (src === undefined) continue;
    for (const [k, v] of mergedProps(tokens, objects, src, seen)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/** 一个值的记号数组 → 字符串(字面量、无替换模板、同文件顶层字符串常量);认不出回 null */
function stringValue(valueTokens, consts) {
  if (!valueTokens || !valueTokens.length) return null;
  const first = valueTokens[0];
  // 允许尾随 `as const` / `satisfies X` / `as string`
  const rest = valueTokens.slice(1);
  if (rest.length && !(rest[0].t === "word" && (rest[0].v === "as" || rest[0].v === "satisfies"))) return null;
  if (first.t === "string") return first.v;
  if (first.t === "template" && first.v !== null) return first.v;
  if (first.t === "word" && consts.has(first.v)) return consts.get(first.v);
  return null;
}

/** 顶层声明:`const|let|var NAME [: 类型] = <初值>`,回 `{ name, valueAt }`(初值第一个记号的下标) */
function declarationAt(tokens, k) {
  const kw = tokens[k];
  if (!kw || kw.t !== "word" || !(kw.v === "const" || kw.v === "let" || kw.v === "var")) return null;
  const nameTok = tokens[k + 1];
  if (!nameTok || nameTok.t !== "word") return null;
  let j = k + 2;
  const d = kw.depth;
  if (tokens[j] && tokens[j].t === "punct" && tokens[j].v === ":") {
    // 跳过类型注解,直到同层的 `=`(类型里的 `<>` 也算一层)
    let angle = 0;
    j++;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t.depth === d && t.t === "punct") {
        if (t.v === "<") angle++;
        else if (t.v === ">") angle = Math.max(0, angle - 1);
        else if (t.v === ">>") angle = Math.max(0, angle - 2);
        else if (t.v === "=" && angle === 0) break;
        else if (t.v === ";" && angle === 0) return null;
      }
      j++;
    }
  }
  if (!tokens[j] || tokens[j].t !== "punct" || tokens[j].v !== "=") return null;
  return { name: nameTok.v, valueAt: j + 1 };
}

/**
 * 一份卡片源码里定义的卡:`[{ id, name }]`,按源码里的先后;同一个 id 只留第一张。认不出任何卡回空数组,不抛。
 */
export function parseCardSource(source) {
  if (typeof source !== "string" || !source) return [];
  let tokens;
  try { tokens = new Lexer(source).all(); } catch { return []; }
  const consts = new Map();
  /** 顶层对象字面量:名字 → `{` 的下标 */
  const objects = new Map();
  /** 导出的名字(`export const`、`export { a as b }` 的 a、`export default a`) */
  const exported = [];
  const exportedObjects = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth !== 0) continue;
    const isExport = t.t === "word" && t.v === "export";
    const declAt = isExport ? k + 1 : k;
    const decl = declarationAt(tokens, declAt);
    if (decl && tokens[declAt].depth === 0) {
      const v = tokens[decl.valueAt];
      if (v && (v.t === "string" || (v.t === "template" && v.v !== null))) {
        const after = tokens[decl.valueAt + 1];
        if (!after || after.depth !== 0 || (after.t === "punct" && after.v === ";") || (after.t === "word" && (after.v === "as" || after.v === "satisfies"))
          || after.t === "word") consts.set(decl.name, v.v);
      }
      if (v && v.t === "punct" && v.v === "{") {
        objects.set(decl.name, decl.valueAt);
        if (isExport) exported.push(decl.name);
      }
      continue;
    }
    if (!isExport) continue;
    const next = tokens[k + 1];
    if (!next) continue;
    if (next.t === "word" && next.v === "default") {
      const v = tokens[k + 2];
      if (v && v.t === "punct" && v.v === "{") exportedObjects.push(k + 2);
      else if (v && v.t === "word") exported.push(v.v);
      continue;
    }
    if (next.t === "punct" && next.v === "{") {
      // export { a, b as c }(不管 `from`:从别处转出的认不出来)
      const end = closeOf(tokens, k + 1);
      const from = tokens[end + 1];
      if (from && from.t === "word" && from.v === "from") continue;
      for (let j = k + 2; j < end; j++) {
        const n = tokens[j];
        if (n.t === "word" && n.v !== "as" && n.v !== "type" && !(tokens[j - 1]?.t === "word" && tokens[j - 1].v === "as")) exported.push(n.v);
      }
    }
  }
  for (const name of exported) {
    const at = objects.get(name);
    if (at !== undefined) exportedObjects.push(at);
  }
  exportedObjects.sort((a, b) => a - b);
  const out = [];
  const seen = new Set();
  const usedAt = new Set();
  for (const at of exportedObjects) {
    if (usedAt.has(at)) continue;
    usedAt.add(at);
    const props = mergedProps(tokens, objects, at);
    const id = stringValue(props.get("id"), consts);
    const name = stringValue(props.get("name"), consts);
    if (typeof id !== "string" || !id || typeof name !== "string") continue;
    if (!props.has("defaults") || !props.has("controls")) continue;
    if (!props.has("Component") && !props.has("card") && !props.has("audio")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** 内容库里的卡片源码键是不是一张用户卡的入口文件(同 `src/cards/user/index.ts` 的 glob `./*.tsx`) */
export function isUserCardEntryKey(key) {
  return typeof key === "string" && /^src\/cards\/user\/[^/]+\.tsx$/.test(key);
}
