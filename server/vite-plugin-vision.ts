import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { cardsOnly, composeFrame, extractArgs, mediaLayersAt } from "./vision-compose.mjs";
import { mediaDir } from "./vite-plugin-media";
import { isInside, overLimit } from "./http-guard.mjs";

/**
 * 给模型一双眼睛:把「时间轴第 t 秒长什么样」渲染成一张图交回去。
 *
 * 为什么不在浏览器里截:编辑器的预览是一个 iframe(?stage=1),页面脚本没有任何
 * 办法把 iframe 的画面读成位图。所以只能在服务端渲染。
 *
 * 为什么直接复用 scripts/export-frames.mjs 而不是自己再起一个 puppeteer:
 * 那个脚本里那套虚拟时钟、动画钉位、素材预热的做法是导出确定性的**全部**依据
 * (见它文件头的说明)。另起一套的话「模型看到的画面」和「用户导出的画面」会
 * 悄悄分叉 —— 那比没有视觉更糟:模型会照着一张不存在的画面去改。代价是每次要起
 * 一个 Chrome(几秒),对一次调用几次的看图来说可以接受。
 */

/** 回给模型的图的最大边长。再大对判断画面没有帮助,只是白烧 token。 */
const MAX_EDGE = 768;
/**
 * 渲染出来的帧是**透明底**(导出时要叠在素材层上),给模型看之前得垫一个底。
 *
 * 以前垫的是一块近黑的纯色(#111318)。那个选择有个致命的地方:**深色的卡片贴上去等于消失**,
 * 而画面里"什么都没有"和"有一张深色的卡"长得一模一样 —— 模型没法区分这两种情况。
 *
 * 真实案例(诊断报告 对话诊断-20260909-045354):一张深色金属的三维 logo 卡,模型连着看了
 * 20 次 see_preview,思考里写的是 "Diagnosing blank logo card rendering" —— 它以为卡没渲出来,
 * 于是把同样的 5 次调用原样重复了三轮,一直没拿到新信息。卡其实是好的,只是黑的贴在黑的上面。
 *
 * 换成**棋盘格**:透明的地方才露出格子,卡片盖住的地方一格都看不见。于是
 * "这块是透明的"和"这块是深色的"一眼就分得开 —— 这正是图像编辑器用了几十年的老办法。
 * 中间调而不是黑白:深色卡和浅色卡都能从它上面浮出来。
 */
const CHECKER_A: [number, number, number] = [0x6b, 0x70, 0x7b];
const CHECKER_B: [number, number, number] = [0x8b, 0x91, 0x9c];
/** 格子边长(输出像素)。跟着输出走而不是跟着原图,缩放到多大格子都一样清楚 */
const CHECKER_PX = 16;
/** 单次渲染的墙钟上限:起 Chrome + 预热 + 一帧,超了就是卡住了 */
const RENDER_TIMEOUT_MS = 120000;
/** ffmpeg 抽一帧的上限:本地文件按关键帧定位,正常两三秒 */
const EXTRACT_TIMEOUT_MS = 30000;

/**
 * ffmpeg 在哪:PATH 上的优先;没有就用 winget 装的那份(和 scripts/export-frames.mjs 同一个兜底);
 * 都没有返回 null,素材那一层就不画、在 note 里说清楚。结果缓存,别每次看图都 spawn 一遍 -version。
 */
let ffmpegResolved: string | null | undefined;
function ffmpegCommand(): string | null {
  if (ffmpegResolved !== undefined) return ffmpegResolved;
  const candidates = [
    process.env.PROMPTCUT_FFMPEG,
    "ffmpeg",
    path.join(process.env.LOCALAPPDATA || os.homedir(), "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-9.0.1-full_build", "bin", "ffmpeg.exe"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-version"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
      if (r.status === 0) return (ffmpegResolved = c);
    } catch { /* 下一个 */ }
  }
  return (ffmpegResolved = null);
}

/**
 * 素材文件在磁盘上的位置:导入时记的 path 优先,没有就按文件名去媒体目录找。
 *
 * `m` 来自**请求体**(`/api/vision/sheet` 的 media、snapshot 的 project.media),所以 `m.path`
 * 是外面递进来的字符串,不是我们自己算出来的。曾经只判 `fs.existsSync` 就直接用:
 * 递一个 `{"path":"C:\\Users\\...\\任意文件"}` 进来,服务端就会对那个文件跑 ffmpeg 抽帧,
 * 再把画面 base64 塞进响应 —— 等于给 MCP 那边的 agent(本该只操作封装)开了一条读盘的路。
 * 跨源有 vite-plugin-api-guard 挡着,所以不是远程漏洞,但本机这道边界当时是空的。
 *
 * 现在按白名单收口:只认落在**素材目录**里的绝对路径,别的一律退回「按文件名去素材目录找」。
 * 这不影响正常素材 —— 导入和素材收集都只往 mediaDir 写(见 vite-plugin-media.ts 的
 * handleMediaUpload、vite-plugin-collect.ts:181),path 字段本来就只可能指到那里。
 */
function mediaFileOf(root: string, m: any): string | null {
  const dir = mediaDir(root);
  const direct = m?.path ? String(m.path) : "";
  if (direct && isInside(direct, dir) && fs.existsSync(direct)) return direct;
  const base = String(m?.url || m?.path || "").split(/[/\\]/).pop() || "";
  if (!base) return null;
  // decodeURIComponent 之后还要再判一次:`a%2F..%2F..%2Fx` 按 / 和 \ 切是切不开的
  // (斜杠是编码过的),解码完却成了 `a/../../x`,path.join 会顺着它走出素材目录。
  const local = path.join(dir, decodeURIComponent(base));
  return isInside(local, dir) && fs.existsSync(local) ? local : null;
}

/** 用 ffmpeg 把素材的第 seconds 秒抽成 w×h 的 RGBA PNG(object-fit: cover) */
function extractFrame(ffmpeg: string, opts: { file: string; kind: string; seconds: number; width: number; height: number; opacity: number; out: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, extractArgs(opts), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg 抽帧超时")); }, EXTRACT_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg 退出码 ${code}${err ? `:${err.trim().slice(-300)}` : ""}`));
      fsp.readFile(opts.out).then(resolve, reject);
    });
  });
}

/**
 * 素材层:第 t 秒画面里的每一段视频 / 图片各抽一帧。抽不到的(文件没了、ffmpeg 不在)
 * 在 notes 里如实说,那一层留空 —— 别让模型对着一张缺层的图得出「视频没进来」。
 */
async function renderMediaLayers(root: string, project: any, t: number, dir: string, notes: string[]): Promise<PNG[]> {
  const layers = mediaLayersAt(project, t);
  if (layers.length === 0) return [];
  const ffmpeg = ffmpegCommand();
  if (!ffmpeg) {
    notes.push("这台机器上找不到 ffmpeg,画面里素材那一层是空的(不是素材的问题)。");
    return [];
  }
  const width = project.width || 1920;
  const height = project.height || 1080;
  const out: PNG[] = [];
  let i = 0;
  for (const layer of layers) {
    const file = mediaFileOf(root, layer.media);
    if (!file) {
      notes.push(`素材「${layer.media.name || layer.media.id}」的文件服务端取不到,画面里它那一层是空的。`);
      continue;
    }
    try {
      const png = await extractFrame(ffmpeg, {
        file, kind: layer.media.kind, seconds: Math.max(0, layer.mediaTime), width, height, opacity: layer.opacity,
        out: path.join(dir, `layer-${i++}.png`),
      });
      out.push(PNG.sync.read(png));
    } catch (e: any) {
      notes.push(`素材「${layer.media.name || layer.media.id}」第 ${layer.mediaTime.toFixed(2)} 秒抽帧失败(${e?.message || e}),画面里它那一层是空的。`);
    }
  }
  return out;
}

let counter = 0;

/**
 * 渲染池:**并行跑几个,但有上限**,而且分两档优先级。
 *
 * # 为什么有上限,而不是敞开跑
 *
 * 每次渲染都要起一个 Chrome。这台机器上吃过一个亏:导出时并发的浏览器实例一多,渲染进程
 * 直接以 **0xC0000142**(STATUS_DLL_INIT_FAILED)退出 —— 连 DLL 都没加载起来,
 * 报不出任何有用的信息(vite-plugin-export.ts 里还留着专门解释这个错误码的提示)。
 * 所以这里的上限不是保守,是**踩过的坑**:敞开跑换来的不是快,是一批莫名其妙失败的渲染。
 *
 * 上限按机器定(见 maxConcurrentRenders),可以用 `PROMPTCUT_RENDER_CONCURRENCY` 覆盖。
 *
 * # 为什么分优先级
 *
 * 原来这里是一条 promise 链,严格先来后到 —— 那时候队里只有用户自己触发的请求,先来后到
 * 就是对的。有了空闲预烘之后队里长期排着一堆没人等的活,用户一拖进度条,他正盯着的那张
 * 就得排在它们后面:实测跳到一个新位置要 **19.5 秒**才出画面,而单张只要 4 秒。
 *
 * 插队只插**还没开始**的:正在跑的那几个 Chrome 不打断(打断等于白烧几秒)。
 * 所以前台最坏等一个槽位空出来,而不是等整条队。
 */
interface RenderJob { run: () => Promise<any>; ok: (v: any) => void; fail: (e: any) => void; priority: number }
const renderWaiting: RenderJob[] = [];
/**
 * 正在渲的:键 → 那次渲染的 promise。同一个键同时被要好几次时共用一次渲染。
 * 并行池之前不需要它(串行天然错开),之后才需要 —— 见 bakeOne 里的说明。
 */
const bakeInFlight = new Map<string, Promise<any>>();
let renderRunning = 0;

/**
 * 同时能跑几个渲染。
 *
 * 每个渲染 = 一个 node + 一个 Chrome,既吃核也吃内存(实测一个约 300~500MB)。
 * 所以两头都要卡:按核心数算一份,按**空闲内存**再算一份,取小的。
 * 上限 8 是人为的天花板 —— 再多的收益已经很小,而 0xC0000142 的风险是随实例数涨的。
 */
function maxConcurrentRenders(): number {
  const override = Number(process.env.PROMPTCUT_RENDER_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) return Math.min(16, Math.floor(override));
  const byCpu = Math.floor((os.cpus()?.length || 4) / 4);
  // 给每个实例留 700MB 余量,并且始终给系统留 2GB
  const byMem = Math.floor((os.freemem() - 2 * 1024 ** 3) / (700 * 1024 * 1024));
  return Math.max(1, Math.min(8, byCpu, Number.isFinite(byMem) ? byMem : 8));
}

function pumpRenderQueue() {
  while (renderRunning < maxConcurrentRenders() && renderWaiting.length) {
    const item = renderWaiting.shift()!;
    renderRunning++;
    Promise.resolve()
      .then(item.run)
      .then(item.ok, item.fail)
      .finally(() => { renderRunning--; pumpRenderQueue(); });
  }
}

/** priority 越大越先跑。前台(用户正等着看的)传 1,空闲预烘用默认的 0 */
function enqueue<T>(job: () => Promise<T>, priority = 0): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const item: RenderJob = { run: job, ok, fail, priority };
    // 插在所有优先级不低于它的之后 —— 同级之间仍然先来后到
    const at = renderWaiting.findIndex((w) => w.priority < priority);
    if (at < 0) renderWaiting.push(item); else renderWaiting.splice(at, 0, item);
    pumpRenderQueue();
  });
}

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function outRoot(root: string): string {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
}

/**
 * 把素材的 blob: 地址换成渲染进程够得着的 /@media/<文件名>。
 *
 * 编辑器里刚导入的素材,url 是 URL.createObjectURL 出来的 blob: —— 那是编辑器
 * 那个页面私有的,渲染进程打不开。不换的话画面里视频那一层是空的,而模型会照着
 * 这张图得出「视频没进来」的结论 —— 让它看一张假画面,比不给它看更糟。
 * 好在导入时文件已经上传到服务端并记了 path(见 src/editor/io/index.ts),
 * 按文件名走 /@media 就能取到,和项目载入时做的换算是同一套。
 *
 * 换不成的(既是 blob: 又没有 path)如实说出来,别让模型以为那里本来就是黑的。
 */
function resolveMediaUrls(project: any): { project: any; unresolved: string[] } {
  const unresolved: string[] = [];
  const media = (project.media || []).map((m: any) => {
    const url = String(m?.url || "");
    if (!url || (!url.startsWith("blob:") && !url.startsWith("data:"))) return m;
    const base = m?.path ? String(m.path).split(/[/\\]/).pop() : "";
    if (!base) {
      unresolved.push(m?.name || m?.id || "(未命名素材)");
      return { ...m, url: "" };
    }
    return { ...m, url: `/@media/${encodeURIComponent(base)}` };
  });
  return { project: { ...project, media }, unresolved };
}

/**
 * 只留下 clipId 那一段,其余全部拿掉。
 *
 * 「只看单张卡」的用处是把它和背景、和别的卡分开看:一张卡颜色不对,可能是它自己
 * 的问题,也可能是被上面压着的另一张卡盖住了。单独渲一遍就能分辨。
 * 保留它所在轨道的位置(叠放顺序不重要了,因为只剩一层),清空素材避免白等预热。
 */
function isolateClip(project: any, clipId: string): { project: any; clip: any } | null {
  for (const track of project.tracks || []) {
    for (const clip of track.clips || []) {
      if (clip.id !== clipId) continue;
      const keepMedia = clip.mediaId ? (project.media || []).filter((m: any) => m.id === clip.mediaId) : [];
      return {
        clip,
        project: {
          ...project,
          media: keepMedia,
          tracks: [{ ...track, hidden: false, clips: [clip] }],
        },
      };
    }
  }
  return null;
}

/**
 * 等比缩到 MAX_EDGE 以内,同时把透明底合成掉。
 *
 * 用 pngjs 手写而不是拉 sharp / 再起一个 ffmpeg:这一步只是把一张图缩小,
 * 为它引入一个原生依赖或者又一个子进程不划算。盒式平均对「看清楚画面上有什么」
 * 足够,而且缩小时它比取点采样更不容易把细字抖没。
 */
function shrink(png: PNG): { png: PNG; width: number; height: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(png.width, png.height));
  const w = Math.max(1, Math.round(png.width * scale));
  const h = Math.max(1, Math.round(png.height * scale));
  const out = new PNG({ width: w, height: h });

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * png.height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * png.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * png.width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * png.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * png.width + sx) << 2;
          // 先按各自的 alpha 预乘再平均,否则透明像素里的垃圾颜色会把边缘染脏
          const al = png.data[i + 3] / 255;
          r += png.data[i] * al; g += png.data[i + 1] * al; b += png.data[i + 2] * al;
          a += al; n++;
        }
      }
      const o = (y * w + x) << 2;
      const cover = a / n;
      // 合成到棋盘格上:out = 前景(已预乘) + 格子色 × (1 - 覆盖率)。
      // 卡片盖住的地方 cover=1,格子一点都露不出来;只有真透明的地方才看得见格子。
      const matte = (((x / CHECKER_PX) | 0) + ((y / CHECKER_PX) | 0)) % 2 === 0 ? CHECKER_A : CHECKER_B;
      out.data[o] = Math.round(r / n + matte[0] * (1 - cover));
      out.data[o + 1] = Math.round(g / n + matte[1] * (1 - cover));
      out.data[o + 2] = Math.round(b / n + matte[2] * (1 - cover));
      out.data[o + 3] = 255;
    }
  }
  return { png: out, width: w, height: h };
}

/**
 * 渲染进程该从哪个地址回连 dev server。
 *
 * 不能像导出那样写死 127.0.0.1:vite 默认只绑 localhost,而 Windows 上 localhost
 * 可能只解析到 ::1 —— 那种配置下 127.0.0.1 直接 ECONNREFUSED,Chrome 打不开页面,
 * 报出来的还是一句难懂的 goto 失败。直接问 httpServer 它到底绑在哪。
 */
function originOf(server: ViteDevServer): string {
  const addr = server.httpServer?.address() as AddressInfo | null;
  const port = server.config.server.port || addr?.port || 5190;
  const host = addr?.address;
  if (!host || host === "0.0.0.0" || host === "127.0.0.1") return `http://127.0.0.1:${port}`;
  // ::（全网卡）也走 ::1，本机回连不需要走外部地址
  if (addr?.family === "IPv6") return `http://[${host === "::" ? "::1" : host}]:${port}`;
  return `http://${host}:${port}`;
}

/**
 * 跑一次单帧渲染,拿到那一帧的 PNG 字节。
 *
 * 页面里**只渲卡片**(素材段全部拿掉):导出脚本逐帧推进虚拟时间,有 <video> 在画面里时
 * 每帧都要等一次真实的 seek,看第 12 秒要走 360 帧、六七分钟,see_preview 因此超时
 * (实测)。没有素材时帧帧静止,几秒就到。素材那一层由 ffmpeg 抽那一帧,在
 * vision-compose.mjs 里按同样的规则合成到卡片下面。
 */
/**
 * 磁盘上现有的烘焙文件。键就是文件名尾巴上那 12 位输入哈希(见 bakeTarget)。
 *
 * 预烘焙的调度要先知道「哪些已经有了、各自多大」才能排队和算占用 ——
 * 而这个答案只有服务端有:浏览器那边关一次页面就忘了,上次开着编辑器烘出来的文件
 * 它一个都不认识。
 */
async function listBakes(root: string): Promise<{ key: string; name: string; bytes: number }[]> {
  const dir = mediaDir(root);
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out: { key: string; name: string; bytes: number }[] = [];
  for (const name of names) {
    if (!/^bake-.*\.png$/.test(name)) continue;
    /*
     * 认不出键的也要收进来,**用文件名当键**。
     *
     * 键的格式换过(早先是 8 位哈希,现在 12 位),目录里现在就躺着 9 个老格式的文件。
     * 要是只认当前格式,这些文件**永远列不出来、也就永远删不掉** —— 一个只进不出的角落。
     * 收进来之后它们必然对不上任何一张卡,于是自动进 orphans,下一轮就被清掉。
     */
    const m = /^bake-.*-([0-9a-f]{12})\.png$/.exec(name);
    try { out.push({ key: m ? m[1] : name, name, bytes: (await fsp.stat(path.join(dir, name))).size }); } catch { /* 刚被删掉,跳过 */ }
  }
  return out;
}

/**
 * 删掉指定的烘焙文件。**只认键,不认路径。**
 *
 * 客户端传来的键要和服务端**自己列出来的目录**逐个比对,只有对得上的才删。
 * 所以传什么进来都跑不出 out/media,也碰不到烘焙以外的文件 ——
 * 安全性来自「拿列表比对」,不来自对字符串长什么样的猜测。
 */
async function evictBakes(root: string, keys: unknown): Promise<{ deleted: string[]; freedBytes: number }> {
  const want = new Set((Array.isArray(keys) ? keys : []).filter((k): k is string => typeof k === "string" && k.length > 0));
  const deleted: string[] = [];
  let freedBytes = 0;
  if (!want.size) return { deleted, freedBytes };
  const dir = mediaDir(root);
  for (const f of await listBakes(root)) {
    if (!want.has(f.key)) continue;
    try { await fsp.unlink(path.join(dir, f.name)); deleted.push(f.key); freedBytes += f.bytes; } catch { /* 已经没了 */ }
  }
  return { deleted, freedBytes };
}

/**
 * 算出「这次烘焙对应磁盘上哪个文件」,以及烘它需要的那几样东西。**不碰文件系统。**
 *
 * 单独拆出来是因为除了烘焙本身,还有两个地方要问同一个问题:
 * 「这张卡烘过没有、那个文件多大」(bake-status)和「哪些文件是过期的、该删」(bake-evict)。
 * 这三方只要有一方把键算得不一样,就会出现「明明烘过却当成没烘」或者「把正在用的文件删了」——
 * 而且都不会报错,只会莫名其妙地慢下来或者闪一下。所以键只有这一处算得出来。
 */
export function bakeTarget(
  project: any,
  clipId: string,
  t: number,
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
) {
  const iso = isolateClip(project, clipId);
  if (!iso) throw new Error(`时间轴上没有 id 为 ${clipId} 的片段。`);
  if (iso.clip.mediaId) throw new Error("这是素材段(视频 / 图片),本来就是位图,直接把它的 URL 当纹理用即可,不用烘。");

  /*
   * **把 frame 摘掉再烘。**
   *
   * frame 是「这张卡摆在整个画幅的哪儿、怎么转」,是相对项目画幅(比如 1920×1080)写的。
   * 而烘焙要换一个画布(正方形贴图 / 卡片自己的框),坐标对不上 —— 一张 x:960 的卡
   * 放到 512×512 的画布上就整个跑到画外,烘出来是**一张全透明的空图,而且不报错**。
   * (实测:带 frame 的卡烘出来 transparentRatio = 1、1096 字节,三种不同变换烘出来还一模一样,
   * 因为它们都是同一张空图。)
   *
   * 摘掉之后卡片铺满画布、按画布尺寸重新排版 —— 卡片本来就是响应式的,这正是我们要的
   * 「这张卡自己长什么样」。位置和三维变换由用它的那一方去做:
   * scene-3d 贴到物体表面,3D 视图贴到代表这张卡的那块板子上。烘的时候再带一遍就是叠两次。
   */
  const { frame: _dropFrame, ...plainClip } = iso.clip;
  const box = {
    w: Math.max(1, Math.round(iso.clip?.frame?.w ?? project.width)),
    h: Math.max(1, Math.round(iso.clip?.frame?.h ?? project.height)),
  };
  const px = Math.min(2048, Math.max(256, Math.round(Number(size) || 1024)));
  /*
   * 画幅两种:
   *   square —— 正方形。贴到立体表面上用(bake_card 的默认):原始 16:9 会被拉变形。
   *   box    —— 卡片自己那个框的尺寸。3D 视图用:那边的板子就是这个框,
   *             一比一贴上去才不会拉伸,而且排版和舞台上完全一致。
   */
  const scale = fit === "box" ? Math.min(1, px / Math.max(box.w, box.h)) : 1;
  const canvas = fit === "box"
    ? { width: Math.max(16, Math.round(box.w * scale)), height: Math.max(16, Math.round(box.h * scale)) }
    : { width: px, height: px };
  // 没给时间就取这一段的中点 —— 起止两端常卡在进场 / 退场动画上,烘出来是个半透明中间态
  const at = Number.isFinite(t) ? t : (iso.clip.start + iso.clip.end) / 2;
  const rgb = typeof bg === "string" ? /^#?([0-9a-f]{6})$/i.exec(bg.trim()) : null;

  const key = createHash("sha1")
    .update(JSON.stringify({ clip: plainClip, theme: project.themeId, at, canvas, fit, bg: rgb ? rgb[1].toLowerCase() : null }))
    .digest("hex").slice(0, 12);
  // 文件名带上 clipId 只是为了在素材目录里认得出来;真正保证唯一的是后面那段输入哈希
  const name = `bake-${clipId.replace(/[^\w.-]/g, "_")}-${key}.png`;
  const url = `/@media/${encodeURIComponent(name)}`;
  return { iso, plainClip, canvas, at, rgb, key, name, url };
}

/**
 * 烘一张卡成图片,**按输入做缓存**。单张 bake_card 和 3D 视图的批量都走这里。
 *
 * 缓存键是「输入」的哈希 —— 卡片内容 + 时刻 + 尺寸 + 底色 + 主题。所以同一张卡同样的参数
 * 只会真渲一次(4.7~6.5 秒),之后命中就是一次 fs.access,零成本。
 * 这正是「一般来说用户都是烘焙好的、不用代理」能成立的前提:代理只覆盖第一次那几秒。
 *
 * 键里**不能**用输出的哈希:那要先渲出来才知道叫什么,等于永远不命中。
 */
async function bakeOne(
  root: string,
  origin: string,
  project: any,
  clipId: string,
  t: number,
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
  /** 1 = 用户正等着看的,插队;0 = 空闲预烘,排队尾 */
  priority = 0,
): Promise<any> {
  const { iso, plainClip, canvas, at, rgb, key, name, url } = bakeTarget(project, clipId, t, size, bg, fit);
  const dir = mediaDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);

  const hint = rgb
    ? "不透明贴图:贴上去是「实心物体表面印着这张卡」。把 url 填进 scene-3d 的 texture 参数。"
    : "透明底贴图:贴上去物体在卡片没画的地方也是透空的,内容像浮在空间里(适合标志 / 招牌)。想要「实心立方体表面印着这张卡」就重烘一次并传 bg(比如 bg:\"#0b0f17\")。";
  const note = "这是一张**快照**:卡片的动画定格在 t 这一帧,之后改卡片参数贴图不会跟着变,要重新烘。";

  // 缓存命中:同样的输入烘过了,直接给 URL
  try {
    const st = await fsp.stat(file);
    return { clipId, url, t: at, width: canvas.width, height: canvas.height, bytes: st.size, cached: true, hint, note };
  } catch { /* 没烘过,往下渲 */ }

  /*
   * **同一个键正在渲,就等它,别再渲一遍。**
   *
   * 渲染改成并行池之后才需要这个:以前是串行的,同一个键的第二个请求必然排在第一个之后,
   * 那时文件已经落盘 → 走上面的缓存命中。现在它们可以同时在飞,于是都 stat 落空、
   * 都起一个 Chrome、最后都往**同一个路径** writeFile。
   *
   * 实测:同时发 4 个完全一样的请求 → 真渲了 4 次,白烧 3 个 Chrome(每个约 4 秒)。
   * 更糟的是那几个 write 会重叠,中间有个窗口能被读到半张 —— 而浏览器正好可能在这时候
   * 来取这张图,拿到半张 PNG 就是贴不上,表现成「这块板子怎么一直是色块」。
   */
  const flying = bakeInFlight.get(key);
  if (flying) return flying;

  const work = bakeAndWrite();
  bakeInFlight.set(key, work);
  try {
    return await work;
  } finally {
    bakeInFlight.delete(key);
  }

  async function bakeAndWrite() {
  const target = {
    ...iso.project,
    width: canvas.width,
    height: canvas.height,
    tracks: iso.project.tracks.map((tr: any) => ({ ...tr, clips: tr.clips.map(() => plainClip) })),
  };
  let raw = await enqueue(() => renderOneFrame(root, origin, target, at, []), priority);

  /*
   * 底色决定贴上去是什么观感,而这个选择只该在**烘的时候**做一次:
   *   不传 bg → 透明底,物体在卡片没画的地方也透空(挖空观感,适合标志 / 招牌);
   *   传了 bg → 压平成不透明,实心物体表面印着这张卡。
   * 放在这里而不是放到卡片上,是因为卡片那边只能对整张贴图开或关 transparent,
   * 分不清「这块本来就该透」和「这块只是卡片没画」。
   */
  if (rgb) {
    const v = parseInt(rgb[1], 16);
    const [br, bgc, bb] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    const img = PNG.sync.read(raw);
    for (let i = 0; i < img.data.length; i += 4) {
      const a = img.data[i + 3] / 255;
      img.data[i] = Math.round(img.data[i] * a + br * (1 - a));
      img.data[i + 1] = Math.round(img.data[i + 1] * a + bgc * (1 - a));
      img.data[i + 2] = Math.round(img.data[i + 2] * a + bb * (1 - a));
      img.data[i + 3] = 255;
    }
    raw = PNG.sync.write(img);
  }

  const png = PNG.sync.read(raw);
  let clear = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] === 0) clear++;
  /*
   * 先写临时名再改名。改名在同一个卷上是原子的,所以**读的人要么看不到这个文件、
   * 要么看到完整的一张**,不会读到写了一半的。直接往目标名写会留一个能读到半张的窗口,
   * 而半张 PNG 贴不上,看起来就是「这块板子一直是色块」,还查不出原因。
   */
  const tmp = `${file}.${process.pid}-${counter++}.tmp`;
  await fsp.writeFile(tmp, raw);
  await fsp.rename(tmp, file);
  return {
    clipId, url, t: at, width: png.width, height: png.height, bytes: raw.length, cached: false,
    transparentRatio: Math.round((clear / (png.width * png.height)) * 1000) / 1000,
    hint, note,
  };
  }
}

/** 跑一次 export-frames 子进程。单张和批量共用同一套超时 / 报错处理 */
function runExport(root: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root });
    const tail: string[] = [];
    const keep = (chunk: Buffer) => { tail.push(chunk.toString()); if (tail.length > 20) tail.shift(); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
      reject(new Error(`渲染超时(${RENDER_TIMEOUT_MS / 1000} 秒)。`));
    }, RENDER_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const msg = tail.join("").trim().slice(-600);
      reject(new Error(code === 3221225794
        ? "渲染进程启动失败(0xC0000142)。同时开着的浏览器实例太多,等导出跑完再看图。"
        : `渲染进程异常退出(代码 ${code})${msg ? `:${msg}` : ""}`));
    });
  });
}

async function renderOneFrame(root: string, origin: string, project: any, t: number, notes: string[]): Promise<Buffer> {
  const id = `vision-${Date.now().toString(36)}-${counter++}`;
  const dir = path.resolve(outRoot(root), `export-${id}`);
  await fsp.mkdir(dir, { recursive: true });

  const fps = project.fps || 30;
  // 帧号必须落在项目时长内,否则脚本会去渲一个空舞台,模型看到一片空白还以为卡没生效
  const maxFrame = Math.max(0, Math.floor((project.duration || 0) * fps) - 1);
  const frame = Math.min(maxFrame, Math.max(0, Math.round(t * fps)));

  try {
    // 素材层和卡片层互不依赖:ffmpeg 抽帧和起 Chrome 渲卡片并行跑
    const layersPromise = renderMediaLayers(root, project, frame / fps, dir, notes);
    await fsp.writeFile(path.join(dir, "project.json"), JSON.stringify(cardsOnly(project), null, 2), "utf8");
    const relOut = process.env.PROMPTCUT_EXPORT_DIR ? dir : `out/export-${id}`;
    const args = [
      "scripts/export-frames.mjs",
      "--url", `${origin}/?export=1&timeline=/@export/${id}/project.json`,
      "--out", relOut,
      "--frames", `${frame}-${frame}`,
      "--fps", String(fps),
      "--no-video",
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root });
      const tail: string[] = [];
      const keep = (chunk: Buffer) => { tail.push(chunk.toString()); if (tail.length > 20) tail.shift(); };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      const timer = setTimeout(() => {
        // 渲染进程自己还会拉起 Chrome,只杀它会留孤儿
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill("SIGKILL");
        reject(new Error(`渲染超时(${RENDER_TIMEOUT_MS / 1000} 秒)。`));
      }, RENDER_TIMEOUT_MS);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const msg = tail.join("").trim().slice(-600);
        reject(new Error(code === 3221225794
          ? "渲染进程启动失败(0xC0000142)。同时开着的浏览器实例太多,等导出跑完再看图。"
          : `渲染进程异常退出(代码 ${code})${msg ? `:${msg}` : ""}`));
      });
    });

    const cards = PNG.sync.read(await fsp.readFile(path.join(dir, "frames", `${String(frame).padStart(6, "0")}.png`)));
    const layers = await layersPromise;
    if (layers.length === 0) return PNG.sync.write(cards);
    return PNG.sync.write(composeFrame(cards.width, cards.height, layers, cards));
  } finally {
    // 看一眼就够了,不留垃圾;删不掉也不该让这次调用失败
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function visionPlugin(): Plugin {
  return {
    name: "promptcut-vision",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;

      /*
       * POST /api/vision/sheet { media, start, end, grid } —— see_sequences 用的镜头拼图。
       * 一个镜头一张 JPEG:从 start 到 end 等间隔抽 grid 帧(4 = 2×2,9 = 3×3),每格 480 宽,
       * ffmpeg 一趟做完(fps 滤镜取帧 + tile 拼格),不落中间帧。按文件、修改时间、区间、格数缓存在
       * out/sheets 下,翻页回看不重抽。media 是项目里那条素材记录(和 snapshot 收 project 一样,
       * 文件按 path / 媒体目录解析,不接受任意路径)。
       */
      server.middlewares.use("/api/vision/sheet", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 1024 * 1024, "请求体超过 1MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { media, start, end, grid } = JSON.parse(body || "{}");
            const file = mediaFileOf(root, media);
            if (!file) return sendJson(res, 404, { ok: false, error: "素材文件服务端取不到,重新导入一次再试" });
            const s0 = Number(start), s1 = Number(end);
            if (!Number.isFinite(s0) || !Number.isFinite(s1) || s1 <= s0) return sendJson(res, 400, { ok: false, error: "start / end 要是秒数且 end > start" });
            const g = grid === 9 ? 9 : 4;
            const cols = g === 9 ? 3 : 2;
            const ffmpeg = ffmpegCommand();
            if (!ffmpeg) return sendJson(res, 500, { ok: false, error: "这台机器上找不到 ffmpeg" });
            const eps = 0.05;
            const dur = Math.max(0.1, s1 - s0 - eps);
            const stamp = fs.statSync(file).mtimeMs;
            const key = createHash("sha1").update(`${file}|${stamp}|${s0.toFixed(2)}|${s1.toFixed(2)}|${g}`).digest("hex").slice(0, 20);
            const dir = path.join(outRoot(root), "sheets");
            await fsp.mkdir(dir, { recursive: true });
            const out = path.join(dir, `${key}.jpg`);
            let cached = fs.existsSync(out);
            if (!cached) {
              await new Promise<void>((resolve, reject) => {
                const args = [
                  "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                  "-ss", (s0 + eps).toFixed(3), "-t", dur.toFixed(3), "-i", file,
                  // fps 取 grid 帧、缩到 480 宽、tile 拼成 cols 列;不够 grid 帧(镜头太短)时剩下的格子留底色
                  "-vf", `fps=${(g / dur).toFixed(6)},scale=480:-2:flags=fast_bilinear,tile=${cols}x${cols}:padding=2:margin=2:color=0x111318`,
                  "-frames:v", "1", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", out,
                ];
                const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
                let err = "";
                child.stderr.on("data", (c) => { err += c; });
                const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg 拼图超时")); }, EXTRACT_TIMEOUT_MS * 2);
                child.on("error", (e) => { clearTimeout(timer); reject(e); });
                child.on("close", (code) => {
                  clearTimeout(timer);
                  if (code !== 0 || !fs.existsSync(out)) return reject(new Error(`ffmpeg 退出码 ${code}${err ? `:${err.trim().slice(-300)}` : ""}`));
                  resolve();
                });
              });
            }
            const base64 = (await fsp.readFile(out)).toString("base64");
            const frames = Array.from({ length: g }, (_, k) => Math.round((s0 + eps + (dur * k) / g) * 100) / 100);
            sendJson(res, 200, { ok: true, grid: g, cols, frames, cached, __image: { mime: "image/jpeg", base64 } });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      server.middlewares.use("/api/vision/snapshot", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, t, clipId } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) {
              return sendJson(res, 400, { ok: false, error: "缺少 project" });
            }

            const resolved = resolveMediaUrls(project);
            let target = resolved.project;
            let at = Number(t);
            const notes: string[] = [];
            if (resolved.unresolved.length) {
              notes.push(`这些素材服务端取不到文件,画面里它们那一层是空的(不是卡片的问题):${resolved.unresolved.join("、")}。`);
            }
            if (clipId) {
              const iso = isolateClip(target, clipId);
              if (!iso) return sendJson(res, 404, { ok: false, error: `时间轴上没有 id 为 ${clipId} 的片段。` });
              target = iso.project;
              // 没指定时间就取这一段的中点:起止两端常常正卡在进场 / 退场动画上,
              // 拿那一帧去判断「这张卡长什么样」会看到一个半透明的中间态。
              if (!Number.isFinite(at)) at = (iso.clip.start + iso.clip.end) / 2;
              notes.push(`只渲染了片段 ${clipId},其余轨道和卡片都不在画面里。`);
            }
            if (!Number.isFinite(at)) at = 0;

            /*
             * 先把 at 夹到项目时长内,**再**拿去渲、也拿它回话。
             *
             * renderOneFrame 内部本来就会夹(帧号超出时长会渲到一个空舞台),但以前回话里的
             * `t` 回的是**入参**。于是「你要 t=30、实际渲的是片尾那一帧」时,返回值还理直气壮地
             * 说 t:30 —— 模型对着一张不是它要的画面,却没有任何线索知道发生了截断,
             * 只会以为「这一刻长这样」。报一个渲另一个,是最难查的那种错。
             */
            const fpsOf = target.fps || 30;
            const lastT = Math.max(0, Math.floor((target.duration || 0) * fpsOf) - 1) / fpsOf;
            if (at > lastT) {
              notes.push(`要看的 ${at} 秒超过了整条片子的长度(${target.duration} 秒),实际渲的是最后一帧 ${lastT.toFixed(2)} 秒。`);
              at = lastT;
            }

            notes.push("画面里的灰色棋盘格是**透明**,不是画面内容 —— 那里什么都没画。卡片盖住的地方看不到格子。") ;
            const raw = await enqueue(() => renderOneFrame(root, originOf(server), target, at, notes));
            const { png, width, height } = shrink(PNG.sync.read(raw));
            const base64 = PNG.sync.write(png).toString("base64");

            sendJson(res, 200, {
              ok: true,
              t: at,
              clipId: clipId || null,
              width,
              height,
              note: notes.join(" "),
              // 这个形状是和 harness/agent.mjs(以及走 CLI 那条路的 mcp-server.mjs)
              // 约好的:看到 __image 就把它当图片块送进上下文,而不是让 base64
              // 混在工具结果的 JSON 文本里 —— 那样模型看不见画面,还白烧几十万字符。
              __image: { mime: "image/png", base64 },
            });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /**
       * POST /api/vision/bake { project, clipId, t, size } —— 把一张卡烘成透明底 PNG 存进素材库。
       *
       * 和 /snapshot 是同一条渲染管线(isolateClip + renderOneFrame),差别只有两点:
       * 不缩图(纹理要原尺寸),以及把结果**落盘**成 `/@media/<name>.png` 而不是塞进上下文给模型看。
       *
       * # 为什么这条路不会让预览和导出分叉
       *
       * 因为烘焙是**一次性的、发生在更早**的一步:画这张图的就是导出成片的那个渲染器
       * (scripts/export-frames.mjs)。之后预览和导出都只是加载同一个文件,谁都不做栅格化。
       * 「浏览器里没有 DOM → 位图的原语」这句话是对的,但它推不出「所以做不了」——
       * 只要不要求**当场**栅格化,服务端这条管线本来就产得出那张位图。
       *
       * # 它是快照,不是活的
       *
       * 卡片的动画定格在 t 那一帧;卡片参数改了纹理不会跟着变,要重新烘。
       * 这个限制看得见(画面明显停住),所以可以接受 —— 静默的分叉才是不能接受的那种。
       */
      /**
       * POST /api/vision/bake-batch { project, clips: [{clipId, t}], size, bg } —— 一次问一批。
       *
       * 给 3D 视图用的(不是 MCP 工具,Agent 那边用单张的 bake_card 就够)。
       * 实现上就是**顺着烘**,快在缓存:文件名按「输入」算哈希(卡片内容 + t + size + bg),
       * 所以同一张卡同样的参数只会真渲一次,之后开多少次 3D 视图都是文件已存在、直接返回。
       *
       * 试过把 N 张摊进一个项目的 N 个时间槽、一趟渲完,实测 4 张 18.7 秒,而单张 4.7~6.5 秒 ——
       * 一点没快:瓶颈不是起 Chrome,是那条路要**逐帧走完整条时间轴**(4 张卡摊开就是 120 帧),
       * 而 export-frames 的 --frames 只收连续区间,挑不出那 4 帧。所以那条路撤掉了,
       * 真正的快法是命中缓存 —— 用户手里的卡大多是烘过的,这也正是「一般不用代理」的前提。
       */
      server.middlewares.use("/api/vision/bake-batch", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clips, size, bg, priority } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
            if (!Array.isArray(clips) || !clips.length) return sendJson(res, 400, { ok: false, error: "缺少 clips" });
            const resolved = resolveMediaUrls(project).project;
            const baked: any[] = [];
            const failed: any[] = [];
            const pri = Number(priority) > 0 ? 1 : 0;
            /*
             * **一次全放进去,让渲染池去并行**,不要在这儿一张张 await。
             *
             * 原来是串行的:一批 8 张就是 8×4 秒。但这台机器 28 个核,一次只跑一个 Chrome
             * 等于闲着。真正该管并发的是 enqueue 那个池(它有上限,见 maxConcurrentRenders)——
             * 在这里串行只是把池饿着,一个槽位都用不满。
             *
             * 一张失败不拖垮整批,所以用 allSettled 而不是 all:3D 视图那边
             * 拿到几张就先贴几张,失败的继续显示占位色块。
             */
            const settled = await Promise.allSettled(
              clips
                .filter((c: any) => c && typeof c.clipId === "string")
                .map((c: any) => bakeOne(root, originOf(server), resolved, c.clipId, Number(c.t), size, bg, "box", pri)
                  .then((r) => r, (e) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { clipId: c.clipId }); })),
            );
            for (const s of settled) {
              if (s.status === "fulfilled") baked.push(s.value);
              else failed.push({ clipId: (s.reason as any)?.clipId, error: (s.reason as any)?.message || String(s.reason) });
            }
            sendJson(res, 200, { ok: true, baked, failed });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });
      /**
       * POST /api/vision/bake-status { project, clips: [{clipId, t}], size, bg } —— 预烘焙的「盘点」。
       *
       * 只查不烘:告诉调度器**哪些已经烘好了、各自多大**,以及磁盘上还躺着哪些
       * 这个项目里已经用不到的旧文件(orphans)。
       *
       * 为什么必须由服务端来答:缓存在磁盘上,而浏览器关一次页面就全忘了 ——
       * 上次开编辑器烘出来的文件,前端一个都不认识。要是让前端只按自己这次的记录算占用,
       * 那 out/media 会一直涨,因为没人认领的文件永远不会被数到,也就永远不会被删。
       *
       * 键的算法只有 bakeTarget 一处(烘焙、盘点、清理三方共用),所以不会出现
       * 「明明烘过却当成没烘」或者「把正在用的文件删了」这种对不上账的事。
       */
      server.middlewares.use("/api/vision/bake-status", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clips, size, bg } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
            const resolved = resolveMediaUrls(project).project;
            const onDisk = new Map((await listBakes(root)).map((f) => [f.key, f]));
            const items: any[] = [];
            const mine = new Set<string>();
            for (const c of Array.isArray(clips) ? clips : []) {
              if (!c || typeof c.clipId !== "string") continue;
              try {
                const { key, name, url } = bakeTarget(resolved, c.clipId, Number(c.t), size, bg, "box");
                mine.add(key);
                const hit = onDisk.get(key);
                items.push({ clipId: c.clipId, t: Number(c.t), key, name, url, bytes: hit ? hit.bytes : null });
              } catch (e: any) {
                // 素材段之类烘不了的,如实报出来,别让调度器一直重试
                items.push({ clipId: c.clipId, t: Number(c.t), key: null, bytes: null, error: e?.message || String(e) });
              }
            }
            /*
             * 这个项目当前用不到的文件。绝大多数是**改过参数之后留下的旧版本** ——
             * 缓存键是卡片内容的哈希,改一次参数就多一个文件,旧的再也不会被命中。
             * 编辑期这才是文件数增长的主因,比「片子太长装不下」常见得多。
             */
            const orphans = [...onDisk.values()].filter((f) => !mine.has(f.key));
            const totalBytes = [...onDisk.values()].reduce((s, f) => s + f.bytes, 0);
            // concurrency 一并告诉前端:预烘该一次发几张才能把渲染池喂满(见 maxConcurrentRenders)
            sendJson(res, 200, { ok: true, items, orphans, totalBytes, fileCount: onDisk.size, concurrency: maxConcurrentRenders() });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /**
       * POST /api/vision/bake-evict { keys: ["a1b2c3d4e5f6", ...] } —— 删掉这些烘焙文件。
       *
       * 传的是键(12 位哈希),不是路径:要删哪个文件由服务端列目录比对,
       * 所以这个口子碰不到 out/media 以外的东西,也碰不到烘焙以外的文件。
       */
      server.middlewares.use("/api/vision/bake-evict", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 4 * 1024 * 1024, "请求体超过 4MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { keys } = JSON.parse(body || "{}");
            const out = await evictBakes(root, keys);
            sendJson(res, 200, { ok: true, ...out });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      server.middlewares.use("/api/vision/bake", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clipId, t, size, bg } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
            if (!clipId) return sendJson(res, 400, { ok: false, error: "缺少 clipId:烘焙只能对着一张卡" });
            const out = await bakeOne(root, originOf(server), resolveMediaUrls(project).project, clipId, Number(t), size, bg);
            sendJson(res, 200, { ok: true, ...out });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}

export default visionPlugin;
