import { useEffect, useRef } from "react";
import { tsParticles, setRandom, type Container } from "@tsparticles/engine";
import { loadSlim } from "@tsparticles/slim";
import type { CardDef, CardProps } from "../../kernel/types";

/**
 * 粒子背景:tsParticles(MIT)画在 canvas 上的漂浮粒子,可选连线。
 *
 * 这是第一张 canvas 卡,它能进导出靠的是三件事,缺一个都不行:
 *   1. 随机数:tsParticles 在模块加载时就把 Math.random 抓走存起来了(engine/Utils/MathUtils.js
 *      的 _random),导出页里对 Math.random 的钉死够不着它。所以每次挂载都调 setRandom 把它
 *      接回「调用时的」全局 Math.random —— 导出页里那是带种子的,每次重挂载拨回起点。
 *   2. 帧循环:它用调用时的 requestAnimationFrame,走的是 exportClock 包过的那层,时间戳被钉到
 *      导出毫秒。同一帧里多次 tick 时间戳相同 → delta 为 0 → 不动;跨帧 delta 恰好一格。
 *   3. 截图窗口:导出脚本截图期间关掉脚本执行,那段自由跑的虚拟时间里粒子不会再多走几步。
 * 静态跳过的探针看到可见的 canvas 就不判静止,所以这张卡每帧都真截。
 */

interface Params {
  config: string;
  color: string;
  quantity: number;
  speed: number;
  size: number;
  links: string;
  seed: number;
}

/** 引擎插件只装一次,多张粒子卡共用 */
let engineReady: Promise<void> | null = null;

/** 不管配置怎么写,这几项一律按我们的来:铺在卡片层里、不响应鼠标、不按 DPR 放大、透明底 */
function forceOurs(opts: Record<string, any>): Record<string, any> {
  return {
    ...opts,
    fullScreen: { enable: false },
    detectRetina: false,
    background: { ...(opts.background || {}), color: "transparent" },
    interactivity: {
      ...(opts.interactivity || {}),
      events: { ...((opts.interactivity && opts.interactivity.events) || {}), onHover: { enable: false }, onClick: { enable: false }, resize: { enable: false } },
    },
  };
}

function simpleOptions(params: Params): Record<string, any> {
  return {
    fpsLimit: 60,
    particles: {
      number: { value: Math.max(0, params.quantity | 0), density: { enable: false } },
      color: { value: params.color },
      opacity: { value: 0.8 },
      size: { value: Math.max(0.5, params.size) },
      move: { enable: true, speed: Math.max(0, params.speed), outModes: { default: "out" } },
      links: { enable: params.links === "yes", color: params.color, distance: 160, opacity: 0.45, width: 1.5 },
    },
  };
}

/** config 参数:以 { 开头就是内联 JSON,否则当 URL 去取;空串就用上面几个简单参数 */
async function resolveOptions(params: Params): Promise<Record<string, any>> {
  const c = params.config.trim();
  if (!c) return simpleOptions(params);
  if (c.startsWith("{")) return JSON.parse(c);
  const r = await fetch(c);
  if (!r.ok) throw new Error(`拉取粒子配置失败 ${r.status}: ${c}`);
  return r.json();
}

function ParticlesCard({ params }: CardProps<Params>) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let container: Container | undefined;
    let dead = false;

    // 见文件头第 1 条。导出页里 __pcResetRandom 存在,按这张卡的 seed 拨一次;编辑器里是真随机
    setRandom(() => Math.random());
    window.__pcResetRandom?.(params.seed | 0 || 1);

    engineReady ??= loadSlim(tsParticles);
    Promise.all([engineReady, resolveOptions(params)])
      .then(([, opts]) => {
        if (dead || !box.current) return undefined;
        // 随机种子在配置取回之后再拨一次:取配置是异步的,中间别的卡可能已经抽过随机数
        window.__pcResetRandom?.(params.seed | 0 || 1);
        return tsParticles.load({ element: box.current, options: forceOurs(opts) });
      })
      .then((c) => {
        if (dead) c?.destroy();
        else container = c;
      })
      .catch((e) => console.warn("[particles] 启动失败:", e));

    return () => {
      dead = true;
      container?.destroy();
    };
  }, [params.config, params.color, params.quantity, params.speed, params.size, params.links, params.seed]);

  return <div ref={box} className="absolute inset-0" />;
}

export const particlesCard: CardDef<Params> = {
  id: "particles",
  name: "粒子背景",
  description: "漂浮的粒子,可带连线,铺满整个画面",
  useWhen: "整段画面需要一层动态的科技感 / 星空感底纹时用,通常放最底层、盖住整段时长。两种用法:不填 config 就用颜色/数量/速度几个简单参数;要雪花、星空、气泡这类现成效果,把 config 填成素材目录里的 URL(见 card_authoring_guide 末尾「粒子配置」一节),此时简单参数不起作用。粒子位置由 seed 决定,同一个 seed 每次导出都一样;想换一种排布就换 seed。它是背景不是主角,别指望它传达信息;要强调数字或文字用别的卡叠在上面。",
  tags: ["粒子", "背景", "科技", "星空", "雪花", "canvas"],
  source: "native",
  defaults: { config: "", color: "#8ab4ff", quantity: 80, speed: 1.2, size: 3, links: "yes", seed: 1 },
  controls: [
    { key: "config", label: "现成配置(URL 或 JSON)", type: "text", hint: "填了就用它,下面的颜色/数量/速度不起作用;素材目录:/catalog/particles/<name>.json" },
    { key: "color", label: "颜色", type: "color" },
    { key: "quantity", label: "数量", type: "number", min: 0, max: 400, step: 10 },
    { key: "speed", label: "速度", type: "number", min: 0, max: 10, step: 0.2 },
    { key: "size", label: "大小(px)", type: "number", min: 0.5, max: 20, step: 0.5 },
    { key: "links", label: "连线", type: "select", options: [{ value: "yes", label: "有" }, { value: "no", label: "无" }] },
    { key: "seed", label: "随机种子", type: "number", min: 1, max: 99999, step: 1, hint: "换一个数就换一种排布;同一个数每次导出都一样" },
  ],
  Component: ParticlesCard,
};
