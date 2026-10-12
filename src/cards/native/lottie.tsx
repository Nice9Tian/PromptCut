import { useEffect, useRef } from "react";
import lottie, { type AnimationItem } from "lottie-web";
import type { CardDef, CardProps } from "../../kernel/types";
import { assetOptions } from "../catalogAssets";
import { isExportMode } from "../../kernel/clock";
import { beginFrameWork } from "../../kernel/frameReady";
import { withSeededRandom } from "../../kernel/pinEntropy";

/**
 * Lottie 卡:把一段 Lottie 动画(After Effects 导出的 JSON)放到舞台上,按时间轴逐帧定位。
 *
 * 为什么它天生适合确定性导出:lottie-web 的 goToAndStop(frame, true) 是「跳到第几帧并渲染」,
 * 每一帧都是 t 的纯函数,不靠任何时钟自己往前走。所以这张卡**读 t**,每帧把 t 换算成帧号
 * 直接跳过去;不用 autoplay,导出页里再把 lottie 的 rAF 循环冻住(它只服务 autoplay 的动画,
 * 这里没有)。
 *
 * 数据两个来源:json(内联的 JSON 文本,优先)或 src(URL)。内联的没有网络,导出最稳;
 * src 走 fetch,导出脚本的 pauseIfNetworkFetchesPending 会等它加载完再推进虚拟时间。
 *
 * 素材许可证:lottie-web 本身是 MIT,但 LottieFiles 上的动画文件各有各的许可,用之前逐个看。
 */

interface Params {
  json: string;
  src: string;
  speed: number;
  loop: string;
  fit: string;
}

/** 内置的演示动画:一个圆角方块从左滑到右、转一圈、淡入。手写的,没有第三方素材许可问题。 */
const DEMO_JSON = JSON.stringify({
  v: "5.7.4", fr: 30, ip: 0, op: 60, w: 1920, h: 1080, nm: "demo", ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: "box", sr: 1, ao: 0, ip: 0, op: 60, st: 0, bm: 0,
    ks: {
      o: { a: 1, k: [{ t: 0, s: [0], e: [100], i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } }, { t: 20, s: [100] }] },
      r: { a: 1, k: [{ t: 0, s: [0], e: [360], i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } }, { t: 60, s: [360] }] },
      p: { a: 1, k: [{ t: 0, s: [400, 540, 0], e: [1520, 540, 0], i: { x: 0.4, y: 1 }, o: { x: 0.6, y: 0 } }, { t: 60, s: [1520, 540, 0] }] },
      a: { a: 0, k: [0, 0, 0] },
      s: { a: 0, k: [100, 100, 100] },
    },
    shapes: [{
      ty: "gr",
      it: [
        { ty: "rc", d: 1, s: { a: 0, k: [240, 240] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 40 } },
        { ty: "fl", c: { a: 0, k: [0.37, 0.55, 1, 1] }, o: { a: 0, k: 100 } },
        { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ],
    }],
  }],
});

/*
 * ── 画面只由素材、参数、帧号决定(原型,两个开关,缺省都关)──
 *
 * 要的是:从头顺着推到第 N 帧,和新建一份直接跳到第 N 帧,画面相同;和页面里别的卡取过几次随机数无关。
 * 播放库(lottie-web 5.13.0)里有三处让它做不到。前两处是随机数,归开关一;第三处和随机数无关,归开关二。
 * 实测与数字见 `scripts/probes/lottie-seed-probe.mjs` 和 docs/reports/AGENT-lottie-seed.md。
 *
 * ── 开关一:覆盖随机数种子(2026-10-12 用户:「我觉得可以覆盖随机数种子。」)──
 *
 *   1. 每个带表达式的属性在**建图层时**取一个 `randSeed = Math.floor(Math.random() * 1000000)`(不管表达式里用没用随机),
 *      表达式里出现 `random` 这个词的,每次求值先按 `randSeed + 时间` 重新播种。`Math.random` 是全页共用的那一串
 *      (kernel/pinEntropy.ts),所以 randSeed 跟「这份实例建的时候,页面里已经取过几次随机数」有关。
 *   2. 表达式里**只有 `wiggle()`、没有 `random` 这个词**的,求值前不重新播种,直接从播放库内部那一串
 *      (`BMMath.random`,全页所有 Lottie 共用)接着取。取到什么跟之前推过哪些帧、别的 Lottie 推过什么有关。
 *
 * 做法:
 *   - 种子 = 素材内容的散列(`lottieSeedOf`)。同一份 JSON 无论从哪个地址来、在哪台机器上、换行符是哪种,种子相同。
 *     速度、循环、适配不进种子:它们只决定「t 对应第几帧」和怎么摆,不该改变某一帧的内容。
 *   - 建实例包在 `withSeededRandom(种子, …)` 里:各属性的 randSeed 从这份种子起按建图层的固定顺序取完
 *     (`progressiveLoad: false` 时播放库在装载完成那一下把所有图层、连同嵌套合成里的一次建好,不是用到才建),
 *     全页那一串不被它挪动。字体或外部数据没到齐时,建图层发生在播放库自己的定时器回调里,
 *     所以把这份实例的 `checkLoaded` 也包进去。
 *   - 每次跳帧前,把播放库内部那一串按「种子 + 帧号」重新播种(`BMMath.seedrandom`),再包在
 *     `withSeededRandom` 里跳。这样第 2 条里的 wiggle 拿到的数只跟帧号有关。
 *   - `BMMath` 播放库没有导出。表达式的代码是在它的作用域里求值的,能看到它(名字是 `Math`)和 `globalData`,
 *     所以建一份只有一个空图层的一次性动画,让它的表达式把 `Math` 挂到 `globalData` 上,取出来就销毁。
 *     全页只取一次。取不到(播放库换了版本、关了表达式)就只做前两步,并在控制台说一声。
 *
 * 没管到的:文字图层的「随机顺序」动画器(播放库在文字内容变化时直接调 `Math.random()` 打乱字符顺序)。
 * 它在 `withSeededRandom` 里,同一次调用里只有一个这样的图层时是确定的;多个时仍可能和推帧路径有关。自带素材里没有。
 *
 * ── 开关二:属性值不留旧数(任务书没要求,查自带素材 happy2016 那 0.0036% 的像素差时找到的)──
 *
 *   3. 播放库更新一个属性的值时,新值和手里的旧值差不到 0.00001 就**不更新**(`setVValue`)。顺着推时值一点点变,
 *      最后几步每步都不到这个门槛,就停在离终点差一点的地方;直接跳过去拿到的是准确的终点。两边差不到 0.00001,
 *      但落到变换矩阵上是 `1.0000001192092896` 对 `1`,光栅化出来有几十个边缘像素不同。和随机数无关,开关一管不到。
 *
 * 做法:播放库自己就是靠换掉 `PropertyFactory.getProp` 来给属性加表达式的,这里用同一个口子(`lottie.__getFactory`)
 * 再包一层:本开关开着的实例在建属性时,把它的 `setVValue` 换成「不相等就更新」。别的实例不受影响。
 */

/** 读一个开关:`window[key]` 是布尔就用它,否则看页面地址里的同名参数是不是 1。缺省关 */
function flagOf(key: "__pcLottieSeed" | "__pcLottieExact", query: string): boolean {
  if (typeof window === "undefined") return false;
  const flag = (window as unknown as Record<string, unknown>)[key];
  if (typeof flag === "boolean") return flag;
  try { return new URLSearchParams(window.location.search).get(query) === "1"; } catch { return false; }
}

/** 开关一:缺省关。开法:页面地址带 `lottieSeed=1`,或在建实例之前设 `window.__pcLottieSeed = true`(设成 false 压过地址) */
export function lottieSeedEnabled(): boolean {
  return flagOf("__pcLottieSeed", "lottieSeed");
}

/** 开关二:缺省关。开法:页面地址带 `lottieExact=1`,或在建实例之前设 `window.__pcLottieExact = true`(设成 false 压过地址) */
export function lottieExactEnabled(): boolean {
  return flagOf("__pcLottieExact", "lottieExact");
}

/** 素材内容 → 32 位种子(FNV-1a)。要在交给播放库**之前**算:播放库会原地改这份数据 */
export function lottieSeedOf(data: unknown): number {
  const text = typeof data === "string" ? data : JSON.stringify(data) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

interface LottieMath { seedrandom(seed: string): unknown }
let lottieMath: LottieMath | null | undefined;

/** 取播放库内部的随机源(见上)。全页只做一次;自己那一个表达式取的 randSeed 不算进全页那一串 */
function captureLottieMath(): LottieMath | null {
  if (lottieMath !== undefined) return lottieMath;
  lottieMath = null;
  try {
    withSeededRandom(0, () => {
      const a = lottie.loadAnimation({
        container: document.createElement("div"),
        renderer: "svg",
        loop: false,
        autoplay: false,
        animationData: {
          v: "5.7.4", fr: 30, ip: 0, op: 1, w: 1, h: 1, nm: "pc-seed", ddd: 0, assets: [],
          layers: [{
            ddd: 0, ind: 1, ty: 3, nm: "pc-seed", sr: 1, ao: 0, ip: 0, op: 1, st: 0, bm: 0,
            ks: {
              o: { a: 0, k: 100, x: "var $bm_rt;\nglobalData.__pcLottieMath = Math;\n$bm_rt = value;" },
              r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
            },
          }],
        },
        rendererSettings: { progressiveLoad: false },
      });
      a.goToAndStop(0, true);
      const g = (a as unknown as { renderer?: { globalData?: { __pcLottieMath?: LottieMath } } }).renderer?.globalData;
      if (g?.__pcLottieMath && typeof g.__pcLottieMath.seedrandom === "function") lottieMath = g.__pcLottieMath;
      a.destroy();
    });
  } catch { /* 取不到按没取到办 */ }
  if (!lottieMath) console.warn("[lottie] 取不到播放库内部的随机源:只有 wiggle() 的表达式仍会和推帧路径有关");
  return lottieMath;
}

/** 播放库里一个属性对象上本原型用到的那几样 */
interface LottieProp { propType?: string; mult: number; v: number | number[] | Float32Array; _mdf: boolean; setVValue?: (val: any) => void }

/** 播放库 setVValue 的「不相等就更新」版:原版是差不到 0.00001 就不更新(见上第 3 条) */
function setVValueExact(this: LottieProp, val: any): void {
  if (this.propType === "unidimensional") {
    const next = val * this.mult;
    if (this.v !== next) { this.v = next; this._mdf = true; }
    return;
  }
  const v = this.v as number[] | Float32Array;
  for (let i = 0; i < v.length; i++) {
    const next = val[i] * this.mult;
    if (v[i] !== next) { v[i] = next; this._mdf = true; }
  }
}

/** 正在建的这份实例开没开开关二。只在建属性的那一段同步代码里为 true */
let exactBuilding = false;
let propertyFactoryHooked: boolean | undefined;

/** 在播放库建属性的口子上包一层(见上)。全页只包一次;`exactBuilding` 为 false 时原样放行 */
function hookPropertyFactory(): boolean {
  if (propertyFactoryHooked !== undefined) return propertyFactoryHooked;
  propertyFactoryHooked = false;
  try {
    const factory = (lottie as unknown as { __getFactory?: (name: string) => { getProp?: (...args: unknown[]) => LottieProp } | null }).__getFactory?.("propertyFactory");
    const inner = factory?.getProp;
    if (factory && typeof inner === "function") {
      factory.getProp = function getPropExact(this: unknown, ...args: unknown[]) {
        const prop = inner.apply(this, args);
        if (exactBuilding && prop && typeof prop.setVValue === "function") prop.setVValue = setVValueExact;
        return prop;
      };
      propertyFactoryHooked = true;
    }
  } catch { /* 包不上按没包上办 */ }
  if (!propertyFactoryHooked) console.warn("[lottie] 包不上播放库建属性的口子:属性值仍会留旧数,顺着推和直接跳可能差一点");
  return propertyFactoryHooked;
}

/** 两个开关各开没开 */
export interface LottieMode { seed: boolean; exact: boolean }

/** 一份建好的动画:跳帧一律走 goTo。seed 为 null 表示没开「覆盖随机数种子」 */
export interface LottieHandle {
  anim: AnimationItem;
  seed: number | null;
  exact: boolean;
  goTo(frame: number): void;
}

/**
 * 建一份动画实例。两个开关都关着(缺省)时就是原来那两句:`lottie.loadAnimation` 和 `goToAndStop(frame, true)`,
 * 一个字不多。开着时照上面那段说明办。
 */
export function loadLottie(container: HTMLElement, data: any, fit: string, mode: LottieMode = { seed: lottieSeedEnabled(), exact: lottieExactEnabled() }): LottieHandle {
  const seed = mode.seed ? lottieSeedOf(data) : null;
  const exact = mode.exact && hookPropertyFactory();
  const build = () => lottie.loadAnimation({
    container,
    // 画在 SVG 上,不用画布(2026-10-10 用户定):自带素材里带遮罩层的那一个用画布画出来是错的,SVG 兼容性更好;
    // 要像素时把 SVG 直接变成像素,速度够用。实测见 docs/plan/render-standard.md「Lottie 动效」
    renderer: "svg",
    loop: false,
    autoplay: false,
    animationData: data,
    rendererSettings: {
      preserveAspectRatio: fit === "cover" ? "xMidYMid slice" : "xMidYMid meet",
      progressiveLoad: false,
    },
  });
  if (seed === null && !exact) {
    const anim = build();
    return { anim, seed, exact, goTo: (frame) => anim.goToAndStop(frame, true) };
  }
  const math = seed === null ? null : captureLottieMath();
  /** 播放库里可能建图层、可能画一帧的同步代码都从这里过:建实例、装载完成、跳帧 */
  const guarded = <T,>(frame: number, fn: () => T): T => {
    const outer = exactBuilding;
    exactBuilding = exact;
    try {
      if (seed === null) return fn();
      math?.seedrandom(`${seed}:${frame}`);
      return withSeededRandom(seed, fn);
    } finally {
      exactBuilding = outer;
    }
  };
  // 装载完成那一下播放库会自己画一次「当前帧」(这时是第 0 帧),所以这里按第 0 帧播种
  const anim = guarded(0, build);
  if (!anim.isLoaded) {
    // 字体 / 外部数据没到齐:建图层和第一次画都在播放库的定时器回调里,把这份实例的 checkLoaded 包进来。
    // 那时画的是之前 goToAndStop 记下的那一帧,按它播种
    const item = anim as unknown as { checkLoaded: () => void; currentRawFrame: number };
    const original = item.checkLoaded;
    item.checkLoaded = function checkLoadedGuarded(this: unknown) {
      return guarded(Number(item.currentRawFrame) || 0, () => original.call(this));
    };
  }
  return { anim, seed, exact, goTo: (frame) => guarded(frame, () => anim.goToAndStop(frame, true)) };
}

/** LottieView 的输入:和卡片参数同名,素材封装卡(src/cards/assets)把 src 固定后也用它 */
export interface LottieViewProps {
  json: string;
  src: string;
  speed: number;
  loop: string;
  fit: string;
  t?: number;
}

/**
 * 渲染核心:给定数据来源和 t,把动画定位到对应帧。这是「函数翻译」那一层的产物 ——
 * 素材目录里的每个 Lottie 文件都通过它变成一张封装卡,卡片之间只差 src。
 */
export function LottieView(params: LottieViewProps) {
  const t = params.t ?? 0;
  const box = useRef<HTMLDivElement>(null);
  const anim = useRef<LottieHandle | null>(null);
  const meta = useRef({ fr: 30, total: 0 });
  /** 最新的 t。装载是异步的(src 要 fetch),装完那一刻得知道「现在该停在哪一帧」 */
  const wantT = useRef(t);
  wantT.current = t;

  /** t → 帧号。装载完成时和 t 变化时都要算,所以只写一处 */
  const frameAt = (sec: number) => {
    const { fr, total } = meta.current;
    const f = sec * fr * (params.speed > 0 ? params.speed : 1);
    return params.loop === "yes" ? f % total : Math.min(f, total - 1);
  };

  // 加载 / 换素材
  useEffect(() => {
    let dead = false;
    const ready = beginFrameWork('lottie');
    const mount = (data: any) => {
      if (dead || !box.current) return;
      anim.current?.anim.destroy();
      box.current.innerHTML = "";
      // 建实例和跳帧都经 loadLottie:两个开关都关着时就是原来的 loadAnimation / goToAndStop(见上)
      const handle = loadLottie(box.current, data, params.fit);
      const a = handle.anim;
      meta.current = { fr: Number(data.fr) || 30, total: Math.max(0, (Number(data.op) || 0) - (Number(data.ip) || 0)) };
      anim.current = handle;
      /*
       * **停在当前 t,不是第 0 帧。**
       *
       * 装载是异步的(src 要 fetch),而下面那个「t 变了就跳帧」的 effect 只在 t 真的变的时候跑。
       * 装完得比最后一次 t 变化还晚,它就再也不会被触发 —— 动画从此钉死在第 0 帧,
       * 而且不报错。实测 lottie-adrock 在 t=3.0s:导出是角色站定的最后一帧,预览只剩背景和影子。
       * 导出那边踩不到这个坑:虚拟时钟会等挂着的网络请求(pauseIfNetworkFetchesPending),
       * JSON 一定在推帧之前就位。
       */
      handle.goTo(meta.current.total ? frameAt(wantT.current) : 0);
      const finish = () => {
        if (dead) return;
        handle.goTo(meta.current.total ? frameAt(wantT.current) : 0);
        ready.ready();
      };
      if (a.isLoaded) finish();
      else a.addEventListener('DOMLoaded', finish);
      a.addEventListener('data_failed', () => ready.fail(new Error('Lottie data failed to load')));
      // 导出页里 lottie 自己的 rAF 循环只会空转(没有 autoplay 的动画),冻住它省得每帧都被判成「在变」
      // freeze() 是 lottie-web 公开 API,只是类型声明里漏了
      if (isExportMode()) (lottie as unknown as { freeze?: () => void }).freeze?.();
    };
    const inline = params.json.trim();
    if (inline) {
      try { mount(JSON.parse(inline)); } catch (e) { ready.fail(e); console.warn("[lottie] json 参数不是合法的 Lottie JSON:", e); }
    } else if (params.src.trim()) {
      fetch(params.src.trim()).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(mount).catch((e) => { ready.fail(e); console.warn("[lottie] 加载失败:", params.src, e); });
    } else ready.ready();
    return () => {
      dead = true;
      ready.dispose();
      anim.current?.anim.destroy();
      anim.current = null;
    };
  }, [params.json, params.src, params.fit]);

  // 跟着时间轴走:t → 帧号
  useEffect(() => {
    const a = anim.current;
    if (!a || !meta.current.total) return;
    a.goTo(frameAt(t));
  }, [t, params.speed, params.loop]);

  return <div ref={box} className="absolute inset-0" />;
}

function LottieCard({ params, t = 0 }: CardProps<Params>) {
  return <LottieView json={params.json} src={params.src} speed={params.speed} loop={params.loop} fit={params.fit} t={t} />;
}

export const lottieCard: CardDef<Params> = {
  id: "lottie",
  name: "Lottie 动画",
  description: "播放一段 Lottie(AE 导出的 JSON)动画,跟着时间轴逐帧走",
  useWhen: "要放一段现成的 Lottie 动画时用。软件自带几段素材(片头字标、角色亮相、节日装饰等),列在 src 控件的 options 里,把那个 URL 填进 src 就行;手上有别的 Lottie 文件(LottieFiles 下载的、设计师用 AE 导出的)也可以直接用。把 JSON 文本贴进 json 参数,或者给一个 URL。它不会自己「播」,是按 clip 时间逐帧定位:clip 多长动画就走多长,speed 调快慢,loop 决定到头了循环还是停在最后一帧。不适合自己从零画动效 —— 那用别的卡。素材文件的许可证要自己核对。",
  tags: ["lottie", "动画文件", "AE", "素材"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: { json: DEMO_JSON, src: "", speed: 1, loop: "no", fit: "contain" },
  controls: [
    { key: "json", label: "Lottie JSON 文本(优先)", type: "text", hint: "整个 .json 文件的内容;留空则用 src" },
    { key: "src", label: "或素材 / URL", type: "asset", kind: "lottie", options: assetOptions("lottie"), hint: "从素材目录里挑一个(options 里的 URL),或填别的 JSON URL;json 参数留空时才用它" },
    { key: "speed", label: "速度倍率", type: "number", min: 0.1, max: 8, step: 0.1 },
    { key: "loop", label: "到头后", type: "select", options: [{ value: "no", label: "停在最后一帧" }, { value: "yes", label: "循环" }] },
    { key: "fit", label: "适配", type: "select", options: [{ value: "contain", label: "完整显示" }, { value: "cover", label: "铺满裁切" }] },
  ],
  parts: [{ id: "animation", label: "动画", role: "media", params: ["json", "src", "speed", "loop", "fit"] }],
  lifecycle: { after: "hold", exit: ["fade"] },
  timing: (p) => ({ after: p.loop === "yes" ? "loop" : "hold" }),
  Component: LottieCard,
};
