/**
 * 登录页左边那块的底:WebGL 着色器画的流动渐变(用户 2026-10-23 给了参考海报)。
 *
 * **先说清楚它不是光追。** 参考图那种效果是「烟雾般的渐变」,做法是在片元着色器里把分形噪声反复
 * **域扭曲**(domain warp)后映成色带 —— 路径追踪解的是光线和几何的交互,这张图里既没有几何也没有光源,
 * 拿路径追踪去做慢几十倍,出来的也不是这个样子。所以这里是着色器,不是光追。
 * 要是你要的就是「有体积、有光照衰减」的那种,我可以再加一段体积步进(单次散射),代价是帧率。
 *
 * 配色:冷的那一侧取软件主题色 `--ui-accent`(用户 2026-10-23 定:「蓝颜色部分换成本软件的主题色」),
 * 暖的那一侧是参考图里的琥珀色。换皮肤、改强调色都会跟着变 —— 每隔半秒重读一次变量。
 *
 * 省电:页面切到后台、这一块滚出视野就停;`prefers-reduced-motion` 只画一帧不动;内部分辨率按
 * 设备像素比打折(画面本来就是糊的,放大看不出来)。WebGL2 起不来、或者上下文丢了,退回
 * `BrandAurora`(CSS 那一版),不会留一块黑的。
 *
 * LOOK 里那一组数是在调参台上逐个试出来的(会话 scratchpad 的 `shader-lab.html`,同一份着色器配滑杆),
 * 不是拍脑袋写的;要再调,把那一页起起来拖滑杆,拖好把数抄回来即可。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { BrandAurora } from "./BrandAurora";
import "./brandCanvas.css";

/** 画面参数。每一条都对应着色器里的一个 uniform,改数就换花样,不用动 GLSL */
const LOOK = {
  /** 走得多慢 */
  speed: 0.065,
  /** 噪声尺度:大了碎,小了只剩一道平滑的渐变,看不出形 */
  scale: 0.9,
  /** 纵向压扁的倍数(<1 = 纹理在竖直方向拉长):参考图里那种「帘子」靠它 */
  yStretch: 0.86,
  /** 冷暖分界大概在横向哪个位置(0 左 1 右) */
  split: 0.5,
  /** 分界处那道暗脊有多深 */
  spine: 0.04,
  /** 细竖条纹的强弱(参考海报右半边那些细线) */
  streak: 0.0,
  /** 条纹毛玻璃:一屏放几条 */
  stripeN: 18.0,
  /** 条纹的倾斜(0 = 正竖直;照上一版 CSS 的 104° 略微斜一点) */
  stripeSkew: -0.22,
  /** 磨砂有多糊:条纹里的纹理被推开多少 */
  frostShift: 0.09,
  /** 磨砂条和清条的对比 */
  frost: 0.55,
  /** 颗粒 */
  grain: 0.035,
  /** 两道域扭曲各推多远 */
  warpA: 3.6,
  warpB: 4.2,
  /** 明暗曲线:次方越大暗部压得越狠 */
  gamma: 2.6,
  /** 亮部提多少 */
  gain: 3.1,
  /** 最暗处还剩多少(不给 0,全黑一片没有层次) */
  floor: 0.15,
  /** 高光滚落:越大越早压住,防止冲成霓虹 */
  roll: 0.4,
  /** 饱和度:1 不变,大于 1 更浓 */
  sat: 1.2,
  /** 内部分辨率的倍率:0.6 表示按 CSS 尺寸的六成渲染再拉大 */
  resScale: 0.6,
  /** 暖侧的颜色(参考图里的琥珀);冷侧取主题色 */
  warm: [0.886, 0.451, 0.122] as [number, number, number],
  /** 主题色读不到时的兜底 */
  coolFallback: [0.0, 0.859, 0.859] as [number, number, number],
};

const VERT = `#version 300 es
void main() {
  // 一个盖住整屏的三角形:不用顶点缓冲,靠顶点号算坐标
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uCool;
uniform vec3  uWarm;
uniform float uScale, uYStretch, uSplit, uSpine, uStreak, uGrain;
uniform float uWarpA, uWarpB, uGamma, uGain, uFloor, uRoll, uSat;
uniform float uStripeN, uStripeSkew, uFrostShift, uFrost;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

// 同一张图,只取前两层 —— 大结构一样、细节没了,这才是「糊」。
// (拿另一个尺度的噪声去混出来的是重影,不是模糊;第一版就错在这儿)
// 1.25 是把两层的幅度(0.75)归一到四层(0.9375),不然混的时候两边亮度对不上
float fbmLow(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 2; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s * 1.25;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // 按长宽比拉一下,竖着的面板里纹理才不会被压扁;再把纵向压一道,让纹理在竖直方向拉长
  vec2 p = vec2(uv.x * (uRes.x / uRes.y), uv.y * uYStretch) * uScale;
  float t = uTime;

  // 域扭曲两道:第一道把坐标推开,第二道拿推开的结果再推一次。
  // 参考图里那种「被搅过」的层次就是这么来的,一层噪声出不来
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.7));
  vec2 r = vec2(fbm(p + uWarpA * q + vec2(1.7, 9.2) + t * 0.5),
                fbm(p + uWarpA * q + vec2(8.3, 2.8) - t * 0.4));
  // 条纹毛玻璃:一道道斜条里,底下的纹理被「磨」过 —— 少一层细节、还被横向推开一点,
  // 就像隔着磨砂玻璃看;条与条之间是清的。这是上一版那层 backdrop-filter 条纹磨砂在着色器里的等价做法
  // (用户点名要的就是「流动的极光 + 条纹毛玻璃 + 噪点」这三样,不能只剩前后两样)
  float stripe = fract(uv.x * uStripeN + uv.y * uStripeSkew);
  // 条纹跑满整块(原来只在右半边,左边等于没有,看着像没生效)
  float frost = smoothstep(0.30, 0.70, stripe);
  vec2 pw = p + uWarpB * r;
  // 磨砂条:同一张图的低频版,再横向推开一点(玻璃的折射感);清条用原图
  float f = mix(fbm(pw), fbmLow(pw + vec2(uFrostShift, 0.0)), frost * uFrost);

  // 冷暖的分界大体是一条竖线,只让噪声轻轻推一下 —— 推多了两边就互相咬进去,
  // 参考图是「左冷右暖、中间一道暗」,不是搅在一起
  float split = uSplit + (r.x - 0.5) * 0.10;
  float m = smoothstep(split - 0.30, split + 0.30, uv.x);
  vec3 base = mix(uCool, uWarm, m);

  // 明暗:暗部压得很狠,所以大部分地方接近黑,颜色只在几处亮起来 —— 这是参考图的分量感
  float lum = pow(clamp(f * 1.18, 0.0, 1.0), uGamma);
  vec3 col = base * (uFloor + uGain * lum);
  // 高光滚落:直接乘出来的亮部会冲成霓虹,这一步把它压回去
  col = col / (1.0 + col * uRoll);
  // 饱和度微调
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSat);

  // 分界处那道竖着的暗脊
  float dx = (uv.x - split) / 0.085;
  col *= 1.0 - uSpine * exp(-dx * dx);

  // 磨砂那一条自己也要有一点明暗差,不然「玻璃」看不出边
  col *= 1.0 + (frost - 0.5) * 0.10;

  // 细竖条纹:按列取一个固定的随机数,越往右越明显(参考海报右半边那些细线)
  float band = hash12(vec2(floor(uv.x * 240.0), 7.0));
  col *= 1.0 + (band - 0.5) * uStreak * smoothstep(0.18, 0.9, uv.x);

  // 暗角
  vec2 d = (uv - 0.5) * vec2(1.08, 1.0);
  col *= 0.30 + 0.70 * smoothstep(1.15, 0.18, length(d));

  // 颗粒:去掉大色块的塑料感
  col += (hash12(gl_FragCoord.xy + t * 60.0) - 0.5) * uGrain;

  fragColor = vec4(max(col, 0.0), 1.0);
}`;

/** 把一个 CSS 变量解析成 0..1 的 RGB。读不到就用兜底 —— 变量可能是 color-mix(),所以让浏览器自己算 */
function readColor(name: string, fallback: [number, number, number]): [number, number, number] {
  try {
    const probe = document.createElement("span");
    probe.style.cssText = `color: var(${name}); position: absolute; opacity: 0; pointer-events: none;`;
    document.body.appendChild(probe);
    const got = getComputedStyle(probe).color;
    probe.remove();
    const m = /rgba?\(([^)]+)\)/.exec(got);
    if (!m) return fallback;
    const parts = m[1].split(/[,\s/]+/).map(Number).filter((n) => Number.isFinite(n));
    if (parts.length < 3) return fallback;
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
  } catch {
    return fallback;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // 编译不过就退回 CSS 那一版;把原因留在控制台,不然只看到一块兜底背景没法查。
    // 开发期有一个常见原因:改这个文件触发热更新会反复重挂组件,每次新建一个 WebGL 上下文,
    // 用满浏览器的上限(Chrome 约 16 个)之后新上下文一建就是坏的 —— 这时日志会是 null。
    // 整页刷新一下就好,不是着色器写错了。
    console.warn(
      "[BrandCanvas] 着色器编译失败：",
      gl.getShaderInfoLog(sh),
      "gl.getError=", gl.getError(),
      "（开发期若日志为 null，多半是热更新累积的 WebGL 上下文超了上限，整页刷新即可）",
    );
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function BrandCanvas(): JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  /** 起不来就退回 CSS 那一版 */
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const canvas = host.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      // 之后要截这一帧烘成静态图,不保留就读不到像素
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      setDead(true);
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      setDead(true);
      return;
    }
    const prog = gl.createProgram();
    if (!prog) {
      setDead(true);
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[BrandCanvas] 着色器链接失败：", gl.getProgramInfoLog(prog));
      setDead(true);
      return;
    }
    gl.useProgram(prog);

    const at = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = at("uRes");
    const uTime = at("uTime");
    const uCool = at("uCool");

    // 一次性的那些:画面参数不随帧变,设一遍就够
    gl.uniform3f(at("uWarm"), ...LOOK.warm);
    gl.uniform1f(at("uScale"), LOOK.scale);
    gl.uniform1f(at("uYStretch"), LOOK.yStretch);
    gl.uniform1f(at("uSplit"), LOOK.split);
    gl.uniform1f(at("uSpine"), LOOK.spine);
    gl.uniform1f(at("uStreak"), LOOK.streak);
    gl.uniform1f(at("uGrain"), LOOK.grain);
    gl.uniform1f(at("uWarpA"), LOOK.warpA);
    gl.uniform1f(at("uWarpB"), LOOK.warpB);
    gl.uniform1f(at("uGamma"), LOOK.gamma);
    gl.uniform1f(at("uGain"), LOOK.gain);
    gl.uniform1f(at("uFloor"), LOOK.floor);
    gl.uniform1f(at("uRoll"), LOOK.roll);
    gl.uniform1f(at("uSat"), LOOK.sat);
    gl.uniform1f(at("uStripeN"), LOOK.stripeN);
    gl.uniform1f(at("uStripeSkew"), LOOK.stripeSkew);
    gl.uniform1f(at("uFrostShift"), LOOK.frostShift);
    gl.uniform1f(at("uFrost"), LOOK.frost);

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let raf = 0;
    let visible = true;
    let frames = 0;
    const started = performance.now();

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const s = Math.min(window.devicePixelRatio || 1, 1.5) * LOOK.resScale;
      const w = Math.max(2, Math.round(box.width * s));
      const h = Math.max(2, Math.round(box.height * s));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
    };

    const draw = () => {
      resize();
      // 换皮肤、改强调色都要跟着变。每半秒重读一次就够,不必每帧都读
      if (frames % 30 === 0) gl.uniform3f(uCool, ...readColor("--ui-accent", LOOK.coolFallback));
      gl.uniform1f(uTime, still ? 0 : ((performance.now() - started) / 1000) * LOOK.speed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frames++;
    };

    const loop = () => {
      if (!visible || document.hidden) {
        raf = 0;
        return;
      }
      draw();
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (raf === 0 && visible && !document.hidden && !still) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    draw(); // 先画一帧:还没进视野、或者关了动画,至少有画面
    if (!still) start();

    // 滚出视野、切到后台就停:登录页在后台标签里不该一直占着 GPU
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) start();
      else stop();
    });
    io.observe(canvas);

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    const ro = new ResizeObserver(() => {
      draw();
      start();
    });
    ro.observe(canvas);

    // 显卡驱动重置、切换独显集显都会丢上下文;丢了就退回 CSS 那一版,别留一块黑的
    const onLost = (e: Event) => {
      e.preventDefault();
      stop();
      setDead(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  if (dead) return <BrandAurora />;
  return <canvas ref={host} className="ps-brand-canvas" data-pc="start-brand-canvas" aria-hidden="true" />;
}

/*
 * 烘成不用实时渲染的版本(用户说审核过了就做)。
 *
 * **只烘与颜色无关的那一层**,颜色仍由 `--ui-accent` 在运行时染上去 —— 这一条是硬的:
 * 用户换皮肤、在设置里改强调色,这一块必须跟着变(`src/skins/` 十套皮肤 × 深浅)。整张焗死的图
 * 换了皮肤就对不上。做法:
 *   1. 把着色器改成只输出**亮度与结构**(f、frost、band、暗角那几项合成一个单通道),不乘颜色;
 *   2. 按目标尺寸渲一帧(或一个循环)存成单通道的 WebP / AVIF,或者 H.264 / VP9 的灰度视频;
 *   3. 页面上拿它当遮罩:一个铺着 `--ui-accent` → 琥珀渐变的层,用 `mask-image`(或 `-webkit-mask`)
 *      套这张灰度图。换皮肤只换渐变那一层,遮罩不用重烘。
 *
 * 循环要无缝:现在时间是一直往前走的,**不能直接首尾相接**。要循环得把时间维换成在圆上转
 * (噪声的时间参数取 `cos/sin` 两路),或者两段交叉淡入。
 *
 * 真要「整张连颜色一起烘死」(比如要的就是参考海报那个特定配色,不跟皮肤走),那是另一个决定,
 * 得先问用户 —— 代价就是换皮肤这一块不跟着变。
 */
