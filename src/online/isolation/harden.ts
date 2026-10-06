/**
 * 舞台加固(契约 `docs/plan/online-card-exec-contract.md` 第 3.4 节;主会话 2026-10-06 选甲)。
 *
 * 只在**跨源舞台**(在线构建的 `stage.html`)里装,在任何卡片代码之前。桌面运行环境、同源单舞台、编辑器页、导出页都不装。
 *
 * # 它是什么、不是什么
 *
 * 拦 WebRTC 的**浏览器层面**的办法是响应头 `Connection-Allowlist`(`stagePolicy.mjs`;Chrome 152 起生效,WebRTC 缺省整个拦下)。
 * 这里是**脚本层面**的加固:在不认那个头的浏览器上,它是 WebRTC 唯一的一道拦;在认的浏览器上,它是第二道。
 * 脚本加固不是浏览器保证 —— 卡片代码与它在同一个脚本环境里,堵的是已知的路,不能证明没有别的路。
 * 万一被绕过,带得走的是本项目的内容与素材;凭证与票据不在舞台的脚本环境里(跨源、HttpOnly cookie),带不走。
 *
 * # 做什么
 *
 * 1. `RTCPeerConnection`、`webkitRTCPeerConnection`、`mozRTCPeerConnection` 改成不可改的 `undefined`。
 * 2. 不让舞台里出现子框架(子框架是同源的新脚本环境,里面有原装的构造器):
 *    - Trusted Types 的缺省策略拒掉带 `iframe` / `frame` / `frameset` / `object` / `embed` / `portal` / `fencedframe` 的 HTML 串,
 *      也拒掉带 `<!ENTITY` 的(XML 的实体展开能在源文本里不出现标签名的情况下造出元素);策略头只许这一个策略;
 *    - `createElement` / `createElementNS` / `customElements.define` 不给造这几种元素;
 *    - DOM 的插入入口(`appendChild`、`insertBefore`、`replaceChild`、`append`、`prepend`、`before`、`after`、`replaceWith`、
 *      `replaceChildren`、`insertAdjacentElement`、`moveBefore`、`Range.insertNode`、`Range.surroundContents`)插入前查一遍子树;
 *    - 删掉 `XSLTProcessor`(它能在不经 Trusted Types 的情况下生成元素);
 *    - `XMLHttpRequest` 不给以文档类型取回(`responseType = "document"`、`responseXML`):那样解析出来的文档不经 Trusted Types;
 *    - `document.execCommand` 一律不做。
 * 3. `document.cookie` 与 `cookieStore` 只读不写:舞台用不着写 cookie,卡片代码也不该能往父域种 cookie。
 * 4. 兜底:`MutationObserver` 发现子框架就摘掉,并向父页报一次(`pc-stage-isolation` 的 `breach`),父页本次会话不再执行用户卡。
 *
 * 钩子里用到的内置方法在安装时全部先取下来存在闭包里,之后不经原型查找(卡片代码改 `Element.prototype.querySelector`、
 * `Function.prototype.call` 之类不影响钩子)。
 */

/** 会开出新脚本环境的元素(小写本地名) */
export const FRAME_TAGS: readonly string[] = Object.freeze(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);

const FRAME_HTML = /<\s*(?:[A-Za-z_][\w.-]*:)?(?:iframe|frame|frameset|object|embed|portal|fencedframe)(?![\w-])/i;
const ENTITY_DECL = /<!ENTITY/i;

/** 一段 HTML / XML 串里有没有会造出子框架的标签(或能绕过字面检查的实体声明)。纯函数,单测逐条核 */
export function htmlHasFrame(html: unknown): boolean {
  const s = typeof html === "string" ? html : String(html ?? "");
  return FRAME_HTML.test(s) || ENTITY_DECL.test(s);
}

/** 一个元素名(可带前缀、大小写不限)是不是子框架类元素。纯函数 */
export function isFrameName(name: unknown): boolean {
  const s = String(name ?? "");
  const i = s.lastIndexOf(":");
  const local = (i >= 0 ? s.slice(i + 1) : s).toLowerCase().trim();
  for (let k = 0; k < FRAME_TAGS.length; k++) if (FRAME_TAGS[k] === local) return true;
  return false;
}

export interface HardenReport {
  /** 装过了(重复调用只装一次) */
  installed: boolean;
  /** 本文档里 `RTCPeerConnection` 已经是 `undefined` */
  webrtcRemoved: boolean;
  /**
   * Trusted Types:`enforced` = 缺省策略建好、而且实测带子框架的 HTML 串被拒;`created` = 策略建好但浏览器没在强制
   * (策略头没到);`unsupported` = 浏览器没有这个接口;`failed` = 建策略时出错
   */
  trustedTypes: "enforced" | "created" | "unsupported" | "failed";
  /** 装上的钩子数 */
  hooks: number;
  /** 没装上的项(诊断) */
  errors: string[];
}

export type BreachKind = "html" | "create" | "insert" | "observed" | "define";

interface TrustedTypesLike {
  createPolicy(name: string, rules: Record<string, (s: string) => string>): unknown;
  defaultPolicy?: unknown;
}

let report: HardenReport | null = null;

/** 上一次安装的结果;没装过给 null */
export function hardenReport(): HardenReport | null {
  return report;
}

const BLOCKED = "PromptCut 舞台:不允许子框架类元素";

/**
 * 装加固。`onBreach`:有代码试图造子框架(被哪一层拦下的)—— 调用方据此向父页上报。同一个文档只装一次。
 */
export function installStageHardening(opts: { onBreach?: (kind: BreachKind) => void; win?: Window & typeof globalThis } = {}): HardenReport {
  if (report) return report;
  const w = (opts.win ?? window) as Window & typeof globalThis & Record<string, unknown>;
  const errors: string[] = [];
  let hooks = 0;

  /* ---------- 先把要用的内置方法取下来 ---------- */
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const strLower = String.prototype.toLowerCase;
  const strLastIndexOf = String.prototype.lastIndexOf;
  const strSlice = String.prototype.slice;
  const reExec = RegExp.prototype.exec;
  const NodeP = w.Node.prototype, ElementP = w.Element.prototype, DocumentP = w.Document.prototype, FragmentP = w.DocumentFragment.prototype;
  const getter = (proto: object, key: string) => getOwnPropertyDescriptor(proto, key)?.get as ((this: unknown) => unknown) | undefined;
  const nodeTypeOf = getter(NodeP, "nodeType")!;
  const localNameOf = getter(ElementP, "localName")!;
  const firstElementChildOfEl = getter(ElementP, "firstElementChild")!;
  const firstElementChildOfFrag = getter(FragmentP, "firstElementChild")!;
  const firstElementChildOfDoc = getter(DocumentP, "firstElementChild")!;
  const qsEl = ElementP.querySelector, qsFrag = FragmentP.querySelector, qsDoc = DocumentP.querySelector;
  const removeEl = ElementP.remove;
  const SELECTOR = FRAME_TAGS.join(",");
  // 自己的正则不经原型上的 exec(卡片代码改 `RegExp.prototype.exec` 不影响判定)
  const frameRe = new RegExp(FRAME_HTML.source, "i"), entityRe = new RegExp(ENTITY_DECL.source, "i");
  const hit = (re: RegExp, s: string) => apply(reExec, re, [s]) !== null;

  let reporting = false;
  const breach = (kind: BreachKind) => {
    if (reporting) return;
    reporting = true;
    try { opts.onBreach?.(kind); } catch { /* 上报失败不影响拦截 */ } finally { reporting = false; }
  };

  const frameName = (name: unknown): boolean => {
    const s = typeof name === "string" ? name : `${name as string}`;
    const i = apply(strLastIndexOf, s, [":"]) as number;
    const local = apply(strLower, i >= 0 ? apply(strSlice, s, [i + 1]) : s, []) as string;
    for (let k = 0; k < FRAME_TAGS.length; k++) if (FRAME_TAGS[k] === local) return true;
    return false;
  };

  /** 这个节点自己是、或它的子树里有子框架类元素 */
  const carriesFrame = (node: unknown): boolean => {
    if (node === null || (typeof node !== "object" && typeof node !== "function")) return false;
    let type: unknown;
    try { type = apply(nodeTypeOf, node, []); } catch { return false; } // 不是节点:让原方法自己报错
    try {
      if (type === 1) {
        if (frameName(apply(localNameOf, node, []))) return true;
        return apply(firstElementChildOfEl, node, []) !== null && apply(qsEl, node, [SELECTOR]) !== null;
      }
      if (type === 11) return apply(firstElementChildOfFrag, node, []) !== null && apply(qsFrag, node, [SELECTOR]) !== null;
      if (type === 9) return apply(firstElementChildOfDoc, node, []) !== null && apply(qsDoc, node, [SELECTOR]) !== null;
    } catch { return true; } // 查不了就当有:宁可拦错
    return false;
  };

  const lock = (target: object, key: string, value: unknown) => {
    defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false });
  };

  /* ---------- 1. WebRTC 的构造器 ---------- */
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"]) {
    try { defineProperty(w, k, { value: undefined, writable: false, configurable: false, enumerable: false }); } catch (e) { errors.push(`${k}:${(e as Error).message}`); }
  }
  const webrtcRemoved = typeof w.RTCPeerConnection === "undefined" && typeof w.webkitRTCPeerConnection === "undefined";

  /* ---------- 2. Trusted Types 的缺省策略 ---------- */
  let trustedTypes: HardenReport["trustedTypes"] = "unsupported";
  const tt = (w as unknown as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  if (tt && typeof tt.createPolicy === "function") {
    try {
      tt.createPolicy("default", {
        createHTML: (s: string) => {
          const text = typeof s === "string" ? s : `${s as string}`;
          if (hit(frameRe, text) || hit(entityRe, text)) { breach("html"); throw new TypeError(BLOCKED); }
          return text;
        },
        // 执行转译结果(`new Function`)与起 blob Worker 要经这两条;出口由内容安全策略管,这里原样放行
        createScript: (s: string) => s,
        createScriptURL: (s: string) => s,
      });
      trustedTypes = "created";
    } catch (e) {
      trustedTypes = "failed";
      errors.push(`trustedTypes:${(e as Error).message}`);
    }
  }

  /* ---------- 3. 不给造子框架类元素 ---------- */
  const wrapCreate = (key: "createElement" | "createElementNS", nameIndex: number) => {
    try {
      const orig = DocumentP[key] as (...a: unknown[]) => unknown;
      lock(DocumentP, key, function (this: Document) {
        // eslint-disable-next-line prefer-rest-params
        const args = arguments;
        if (frameName(args[nameIndex])) { breach("create"); throw new TypeError(BLOCKED); }
        const opt = args[nameIndex + 1] as { is?: unknown } | string | undefined;
        if (opt && typeof opt === "object" && opt.is !== undefined && frameName(opt.is)) { breach("create"); throw new TypeError(BLOCKED); }
        return apply(orig, this, args as unknown as unknown[]);
      });
      hooks++;
    } catch (e) { errors.push(`${key}:${(e as Error).message}`); }
  };
  wrapCreate("createElement", 0);
  wrapCreate("createElementNS", 1);
  try {
    const CER = w.CustomElementRegistry.prototype;
    const orig = CER.define as (...a: unknown[]) => unknown;
    lock(CER, "define", function (this: CustomElementRegistry) {
      // eslint-disable-next-line prefer-rest-params
      const args = arguments;
      const o = args[2] as { extends?: unknown } | undefined;
      if (o && o.extends !== undefined && frameName(o.extends)) { breach("define"); throw new TypeError(BLOCKED); }
      return apply(orig, this, args as unknown as unknown[]);
    });
    hooks++;
  } catch (e) { errors.push(`customElements.define:${(e as Error).message}`); }

  /* ---------- 4. 插入入口 ---------- */
  /** `which`:第几个实参是要插进去的新节点;`"all"` = 每个实参都是(可变参数的那几个)。参照节点、被换下的旧节点不查 */
  const wrapInsert = (proto: object | undefined, key: string, which: number | "all" = "all") => {
    if (!proto) return;
    const d = getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== "function") return; // 这个浏览器没有这个方法
    const orig = d.value as (...a: unknown[]) => unknown;
    try {
      lock(proto, key, function (this: unknown) {
        // eslint-disable-next-line prefer-rest-params
        const args = arguments;
        if (which === "all") { for (let i = 0; i < args.length; i++) if (carriesFrame(args[i])) { breach("insert"); throw new TypeError(BLOCKED); } }
        else if (carriesFrame(args[which])) { breach("insert"); throw new TypeError(BLOCKED); }
        return apply(orig, this, args as unknown as unknown[]);
      });
      hooks++;
    } catch (e) { errors.push(`${key}:${(e as Error).message}`); }
  };
  for (const k of ["appendChild", "insertBefore", "replaceChild"]) wrapInsert(NodeP, k, 0);
  for (const k of ["append", "prepend", "before", "after", "replaceWith", "replaceChildren"]) wrapInsert(ElementP, k);
  wrapInsert(ElementP, "insertAdjacentElement", 1);
  wrapInsert(ElementP, "moveBefore", 0);
  for (const k of ["append", "prepend", "replaceChildren"]) { wrapInsert(DocumentP, k); wrapInsert(FragmentP, k); }
  wrapInsert(DocumentP, "moveBefore", 0); wrapInsert(FragmentP, "moveBefore", 0);
  for (const k of ["before", "after", "replaceWith"]) { wrapInsert(w.CharacterData?.prototype, k); wrapInsert(w.DocumentType?.prototype, k); }
  for (const k of ["insertNode", "surroundContents"]) wrapInsert(w.Range?.prototype, k, 0);

  /* ---------- 5. 不经 Trusted Types 的解析入口 ---------- */
  try { defineProperty(w, "XSLTProcessor", { value: undefined, writable: false, configurable: false, enumerable: false }); hooks++; } catch (e) { errors.push(`XSLTProcessor:${(e as Error).message}`); }
  try {
    const XP = w.XMLHttpRequest.prototype;
    const rt = getOwnPropertyDescriptor(XP, "responseType");
    if (rt?.get && rt.set) {
      const get = rt.get, set = rt.set;
      defineProperty(XP, "responseType", {
        configurable: false, enumerable: rt.enumerable,
        get(this: XMLHttpRequest) { return apply(get, this, []); },
        set(this: XMLHttpRequest, v: unknown) {
          if ((apply(strLower, `${v as string}`, []) as string) === "document") throw new TypeError("PromptCut 舞台:不能以文档类型取回");
          apply(set, this, [v]);
        },
      });
      hooks++;
    }
    defineProperty(XP, "responseXML", { configurable: false, enumerable: true, get() { return null; } });
    hooks++;
  } catch (e) { errors.push(`XMLHttpRequest:${(e as Error).message}`); }
  try { lock(DocumentP, "execCommand", function () { return false; }); hooks++; } catch (e) { errors.push(`execCommand:${(e as Error).message}`); }

  /* ---------- 6. cookie 只读 ---------- */
  try {
    const cd = getOwnPropertyDescriptor(DocumentP, "cookie");
    if (cd?.get) {
      const get = cd.get;
      defineProperty(DocumentP, "cookie", { configurable: false, enumerable: cd.enumerable, get(this: Document) { return apply(get, this, []); }, set() { /* 舞台不写 cookie */ } });
      hooks++;
    }
    const CS = (w as unknown as { CookieStore?: { prototype: object } }).CookieStore?.prototype;
    if (CS) for (const k of ["set", "delete"]) {
      if (typeof (CS as Record<string, unknown>)[k] === "function") { lock(CS, k, function () { return Promise.reject(new TypeError("PromptCut 舞台:不能写 cookie")); }); hooks++; }
    }
  } catch (e) { errors.push(`cookie:${(e as Error).message}`); }

  /* ---------- 7. 兜底:真出现了就摘掉并上报 ---------- */
  try {
    const sweep = (node: Node) => {
      let type: unknown;
      try { type = apply(nodeTypeOf, node, []); } catch { return; }
      if (type !== 1) return;
      const el = node as Element;
      const found: Element[] = [];
      if (frameName(apply(localNameOf, el, []))) found.push(el);
      else {
        const list = apply(ElementP.querySelectorAll, el, [SELECTOR]) as NodeListOf<Element>;
        for (let i = 0; i < list.length; i++) found.push(list[i]);
      }
      for (let i = 0; i < found.length; i++) { try { apply(removeEl, found[i], []); } catch { /* 已经不在了 */ } }
      if (found.length) breach("observed");
    };
    new w.MutationObserver((list) => {
      for (let i = 0; i < list.length; i++) {
        const added = list[i].addedNodes;
        for (let k = 0; k < added.length; k++) sweep(added[k]);
      }
    }).observe(w.document, { childList: true, subtree: true });
    hooks++;
  } catch (e) { errors.push(`MutationObserver:${(e as Error).message}`); }

  /* ---------- 实测 Trusted Types 在不在强制 ---------- */
  if (trustedTypes === "created") {
    try {
      const probe = apply(DocumentP.createElement, w.document, ["div"]) as HTMLElement;
      let threw = false;
      const before = opts.onBreach;
      opts.onBreach = undefined; // 自己这一下试探不算有人试图造子框架
      try { probe.innerHTML = "<iframe></iframe>"; } catch { threw = true; } finally { opts.onBreach = before; }
      if (threw) trustedTypes = "enforced";
    } catch { /* 留在 created */ }
  }

  report = { installed: true, webrtcRemoved, trustedTypes, hooks, errors };
  return report;
}

/** 单测用:忘掉「装过了」(不撤钩子) */
export function resetHardenReportForTest(): void {
  report = null;
}
