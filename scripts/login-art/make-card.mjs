/**
 * 从 `src/start/BrandCanvas.tsx` 生成一张**用户卡**，好让 PromptCut 自己的渲染器把登录页左栏那段
 * 极光预渲染成循环视频（用户 2026-10-24 定：「左侧为渲染器经过预渲染的动画」，用视频循环、出两个版本）。
 *
 *   node scripts/login-art/make-card.mjs
 *   → 写出 src/cards/user/login-art.tsx
 *
 * **为什么是生成的，不是手写的。** 屏幕上那一版（`BrandCanvas.tsx`，做视频放不出来时的兜底）
 * 和预渲染那一版必须画同一段 GLSL，手抄两份迟早各自漂。卡片又不能跨层 import `src/start/`
 * （分层守门会拦，用户卡还要能整份序列化进 .proc），所以这里把 GLSL 原样抄进生成的文件，
 * 并在文件头写明「别手改，改 BrandCanvas.tsx 再重跑这个脚本」。
 *
 * 取三样：`VERT`、`FRAG` 两段模板字符串，和 `LOOK` 那个对象字面量。
 * uniform 的上传代码按约定自动生成 —— FRAG 里每个 `uniform float uFoo` 都对应 `LOOK.foo`
 * （首字母小写），这条约定由下面的 `assertMapping` 当场核对，对不上就报错退出，不会悄悄少传一个。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src/start/BrandCanvas.tsx');
const OUT = path.join(ROOT, 'src/cards/user/login-art.tsx');
/** 画布大小。极光是一片软渐变，不需要很高的分辨率；小一点导出快得多 */
const W = Number(process.env.LOGIN_ART_W || 600);
const H = Number(process.env.LOGIN_ART_H || 800);

const text = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function grabTemplate(name) {
  const m = new RegExp(`export const ${name} = \`(.*?)\`;`, 's').exec(text);
  if (!m) throw new Error(`${SRC} 里没找到 export const ${name} = \`...\``);
  return m[1];
}
const VERT = grabTemplate('VERT');
const FRAG = grabTemplate('FRAG');

const lookBody = /export const LOOK = \{(.*?)\n\};/s.exec(text);
if (!lookBody) throw new Error(`${SRC} 里没找到 export const LOOK = { ... }`);
/** LOOK 里的键（只认顶层两空格缩进那一层，注释和嵌套不算） */
const lookKeys = [...new Set([...lookBody[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1]))];

/** FRAG 里声明的 uniform：[类型, 名字] */
const uniforms = [];
for (const m of FRAG.matchAll(/uniform\s+(float|vec2|vec3)\s+([^;]+);/g)) {
  for (const n of m[2].split(',')) uniforms.push([m[1], n.trim()]);
}

/** 每帧单独传的那几个，不从 LOOK 取 */
const PER_FRAME = new Set(['uRes', 'uLoop', 'uPxScale']);
/** 颜色：卡片参数给，不读 CSS 变量（导出要可重放，不能依赖页面上的 --ui-accent） */
const COLORS = new Set(['uCool', 'uWarm']);
const lookNameOf = (u) => u[1].toLowerCase() + u.slice(2);

function assertMapping() {
  const missing = uniforms
    .filter(([ty, n]) => ty === 'float' && !PER_FRAME.has(n) && !lookKeys.includes(lookNameOf(n)))
    .map(([, n]) => n);
  if (missing.length) throw new Error(`这些 uniform 在 LOOK 里找不到对应的键：${missing.join(', ')}`);
  for (const need of ['loopSeconds', 'swirl']) {
    if (!lookKeys.includes(need)) throw new Error(`LOOK 里缺 ${need}：无缝循环要用它`);
  }
}
assertMapping();

const floatUploads = uniforms
  .filter(([ty, n]) => ty === 'float' && !PER_FRAME.has(n))
  .map(([, n]) => `    gl.uniform1f(at(${JSON.stringify(n)}), LOOK.${lookNameOf(n)});`)
  .join('\n');

const card = `/* 本文件由 scripts/login-art/make-card.mjs 生成，别手改。
 * 要改画面就去改 src/start/BrandCanvas.tsx（屏幕上那一版），再重跑一次生成脚本，
 * 两边画的才是同一段 GLSL。生成时间不写进文件，免得每次重跑都产生无谓的 diff。
 *
 * 这张卡只为一件事存在：让 PromptCut 自己的渲染器把登录页左栏那段极光**预渲染成循环视频**
 * （用户 2026-10-24 定）。画面写成帧时钟 t 的函数，不自己跑帧循环，符合 server/card-authoring-guide.md。
 * uLoop = (t / 循环秒数) 的小数部分，走满一圈逐字节回到起点，所以第一帧和最后一帧接得上。
 */
import { useLayoutEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

interface Params {
  /** 冷色那一侧（屏幕上那一版取主题强调色；这里写死，导出要可重放） */
  cool: string;
  /** 暖色那一侧 */
  warm: string;
  /** 循环一圈多少秒 */
  loopSeconds: number;
}

const WIDTH = ${W};
const HEIGHT = ${H};

const LOOK = {${lookBody[1]}
};

const VERT = \`${VERT.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\`;

const FRAG = \`${FRAG.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\`;

function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function LoginArt({ params, t = 0 }: CardProps<Params>) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    // WebGL2 起不来就画一块底色，别让整张卡炸掉
    if (!gl) {
      const c2 = canvas.getContext("2d");
      if (c2) { c2.fillStyle = "#111016"; c2.fillRect(0, 0, WIDTH, HEIGHT); }
      return;
    }
    const make = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, make(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);
    const at = (n: string) => gl.getUniformLocation(prog, n);

${floatUploads}
    gl.uniform3f(at("uCool"), ...hexToRgb(params.cool, [0.149, 0.776, 0.902]));
    gl.uniform3f(at("uWarm"), ...hexToRgb(params.warm, [0.886, 0.451, 0.122]));
    gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
    gl.uniform1f(at("uPxScale"), 1);
    // 走满一圈回到起点：t 到了 loopSeconds 这一帧和 t = 0 那一帧算出来一样
    const secs = Math.max(0.001, params.loopSeconds);
    gl.uniform1f(at("uLoop"), ((t % secs) + secs) % secs / secs);

    gl.viewport(0, 0, WIDTH, HEIGHT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.deleteProgram(prog);
  }, [t, params.cool, params.warm, params.loopSeconds]);
  return <canvas ref={ref} width={WIDTH} height={HEIGHT} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}

export const loginArt: CardDef<Params> = {
  id: "pc-login-art",
  name: "登录页左栏极光",
  description: "登录页左边那块流动的极光。画面是帧时钟的函数，走满一圈回到起点，专门用来预渲染成无缝循环的视频。",
  source: "user",
  useWhen: "只给「把登录页左栏渲成循环视频」这一件事用；别的场合要流动背景请另写一张。",
  tags: ["背景", "极光", "着色器", "登录页"],
  frameMode: "direct",
  defaults: { cool: "#26c6e6", warm: "#e2731f", loopSeconds: LOOK.loopSeconds },
  controls: [
    { key: "cool", label: "冷色", type: "color" },
    { key: "warm", label: "暖色", type: "color" },
    { key: "loopSeconds", label: "循环秒数", type: "number", min: 4, max: 600, step: 1 },
  ],
  Component: LoginArt,
};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, card, 'utf8');
console.log(`写出 ${path.relative(ROOT, OUT)}`);
console.log(`  GLSL ${FRAG.length} 字符，自动上传 ${floatUploads.split('\n').length} 个 float uniform`);
console.log(`  画布 ${W}×${H}，循环 ${/loopSeconds:\s*(\d+)/.exec(lookBody[1])?.[1] ?? '?'} 秒`);
