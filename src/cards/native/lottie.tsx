import { useEffect, useRef } from "react";
import lottie, { type AnimationItem } from "lottie-web";
import type { CardDef, CardProps } from "../../kernel/types";
import { isExportMode } from "../../kernel/clock";

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

function LottieCard({ params, t = 0 }: CardProps<Params>) {
  const box = useRef<HTMLDivElement>(null);
  const anim = useRef<AnimationItem | null>(null);
  const meta = useRef({ fr: 30, total: 0 });

  // 加载 / 换素材
  useEffect(() => {
    let dead = false;
    const mount = (data: any) => {
      if (dead || !box.current) return;
      anim.current?.destroy();
      box.current.innerHTML = "";
      const a = lottie.loadAnimation({
        container: box.current,
        renderer: "svg",
        loop: false,
        autoplay: false,
        animationData: data,
        rendererSettings: {
          preserveAspectRatio: params.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet",
          progressiveLoad: false,
        },
      });
      meta.current = { fr: Number(data.fr) || 30, total: Math.max(0, (Number(data.op) || 0) - (Number(data.ip) || 0)) };
      anim.current = a;
      a.goToAndStop(0, true);
      // 导出页里 lottie 自己的 rAF 循环只会空转(没有 autoplay 的动画),冻住它省得每帧都被判成「在变」
      // freeze() 是 lottie-web 公开 API,只是类型声明里漏了
      if (isExportMode()) (lottie as unknown as { freeze?: () => void }).freeze?.();
    };
    const inline = params.json.trim();
    if (inline) {
      try { mount(JSON.parse(inline)); } catch (e) { console.warn("[lottie] json 参数不是合法的 Lottie JSON:", e); }
    } else if (params.src.trim()) {
      fetch(params.src.trim()).then((r) => r.json()).then(mount).catch((e) => console.warn("[lottie] 加载失败:", params.src, e));
    }
    return () => {
      dead = true;
      anim.current?.destroy();
      anim.current = null;
    };
  }, [params.json, params.src, params.fit]);

  // 跟着时间轴走:t → 帧号
  useEffect(() => {
    const a = anim.current;
    const { fr, total } = meta.current;
    if (!a || !total) return;
    let f = t * fr * (params.speed > 0 ? params.speed : 1);
    f = params.loop === "yes" ? f % total : Math.min(f, total - 1);
    a.goToAndStop(f, true);
  }, [t, params.speed, params.loop]);

  return <div ref={box} className="absolute inset-0" />;
}

export const lottieCard: CardDef<Params> = {
  id: "lottie",
  name: "Lottie 动画",
  description: "播放一段 Lottie(AE 导出的 JSON)动画,跟着时间轴逐帧走",
  useWhen: "手上有现成的 Lottie 文件(LottieFiles 下载的、设计师用 AE 导出的)想直接放进视频时用。把 JSON 文本贴进 json 参数,或者给一个 URL。它不会自己「播」,是按 clip 时间逐帧定位:clip 多长动画就走多长,speed 调快慢,loop 决定到头了循环还是停在最后一帧。不适合自己从零画动效 —— 那用别的卡。素材文件的许可证要自己核对。",
  tags: ["lottie", "动画文件", "AE", "素材"],
  source: "native",
  defaults: { json: DEMO_JSON, src: "", speed: 1, loop: "no", fit: "contain" },
  controls: [
    { key: "json", label: "Lottie JSON 文本(优先)", type: "text", hint: "整个 .json 文件的内容;留空则用 src" },
    { key: "src", label: "或 JSON 的 URL", type: "text" },
    { key: "speed", label: "速度倍率", type: "number", min: 0.1, max: 8, step: 0.1 },
    { key: "loop", label: "到头后", type: "select", options: [{ value: "no", label: "停在最后一帧" }, { value: "yes", label: "循环" }] },
    { key: "fit", label: "适配", type: "select", options: [{ value: "contain", label: "完整显示" }, { value: "cover", label: "铺满裁切" }] },
  ],
  Component: LottieCard,
};
