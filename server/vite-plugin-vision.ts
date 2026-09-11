import { frameService, renderProject } from "./vite-plugin-frames";
import { postFrame } from "./png-post.mjs";
import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fork, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { cardsOnly, extractArgs, mediaLayersAt } from "./vision-compose.mjs";
import { mediaDir } from "./vite-plugin-media";
import { isInside, overLimit } from "./http-guard.mjs";
import { isPrerender } from "./render-role.mjs";
import { exportsRunning, onPoolChange } from "./render-pool-state.mjs";
import { proxyToPrerender } from "./prerender-client.mjs";
import { cardCodeHash, onCardSourceChange } from "./card-overrides.mjs";

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

/*
 * 给模型看的图:缩到长边 768、透明处铺中间调棋盘格。实现和理由都搬到了 server/png-post.mjs ——
 * 那是逐像素的同步活,由渲染 worker 在自己的进程里做,不再占这个进程的事件循环。
 *
 * 为什么是棋盘格而不是纯色底(原来的说明,留在这里):以前垫的是近黑的纯色,**深色的卡片贴上去
 * 等于消失**,"什么都没有"和"有一张深色的卡"长得一模一样。真实案例(诊断报告
 * 对话诊断-20260909-045354):一张深色金属的三维 logo 卡,模型连着看了 20 次 see_frames,
 * 以为卡没渲出来,把同样的 5 次调用原样重复了三轮。换成棋盘格,透明的地方才露出格子。
 */
/** 单次渲染的墙钟上限:起 Chrome + 预热 + 一帧,超了就是卡住了 */
const RENDER_TIMEOUT_MS = 120000;
/** ffmpeg 抽一帧的上限:本地文件按关键帧定位,正常两三秒 */
const EXTRACT_TIMEOUT_MS = 30000;
/**
 * 叫 worker 取消之后等它回话的上限。它停在两帧之间(一帧约 20~30 ms)或者开完页就停,
 * 正常几十毫秒;冷启动 Chrome 最慢约 6 秒。超过这个数就当它卡死了,整台杀掉。
 */
const CANCEL_GRACE_MS = 15000;

/**
 * 烘焙时把片段挪到第几秒开始(起跑线)。理由和实测数据见 bakeTarget 里那段长注释。
 *
 * 不能是 0:预热在 t=0 上走四帧再重挂载卡片,压着第 0 帧的段会多经历这一段,画出来不一样
 * (实测 step-timeline 差 15164 个像素)。0.5 秒 = 15 帧,推过去约 0.24 秒,买的是
 * 「34/34 张卡挪位置逐字节相同」。
 */
const BAKE_LEAD = 0.5;

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

/** 用 ffmpeg 把素材的第 seconds 秒抽成 w×h 的 RGBA PNG(object-fit: cover),写到 opts.out */
function extractFrame(ffmpeg: string, opts: { file: string; kind: string; seconds: number; width: number; height: number; opacity: number; filter?: string; out: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, extractArgs(opts), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg 抽帧超时")); }, EXTRACT_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg 退出码 ${code}${err ? `:${err.trim().slice(-300)}` : ""}`));
      resolve();
    });
  });
}

/**
 * 素材层:第 t 秒画面里的每一段视频 / 图片各抽一帧。抽不到的(文件没了、ffmpeg 不在)
 * 在 notes 里如实说,那一层留空 —— 别让模型对着一张缺层的图得出「视频没进来」。
 *
 * 返回的是抽出来的 PNG **文件路径**(从下到上),不在这里解码:合成由渲染 worker 做
 * (server/png-post.mjs),这个进程只管调度。
 */
async function renderMediaLayers(root: string, project: any, t: number, dir: string, notes: string[]): Promise<string[]> {
  const layers = mediaLayersAt(project, t);
  if (layers.length === 0) return [];
  const ffmpeg = ffmpegCommand();
  if (!ffmpeg) {
    notes.push("这台机器上找不到 ffmpeg,画面里素材那一层是空的(不是素材的问题)。");
    return [];
  }
  const width = project.width || 1920;
  const height = project.height || 1080;
  const out: string[] = [];
  let i = 0;
  for (const layer of layers) {
    const file = mediaFileOf(root, layer.media);
    if (!file) {
      notes.push(`素材「${layer.media.name || layer.media.id}」的文件服务端取不到,画面里它那一层是空的。`);
      continue;
    }
    try {
      // 帧号带进文件名:renderFrames 一趟抽好几个时刻的素材层,都落在同一个目录里
      const layerOut = path.join(dir, `layer-${Math.round(t * 1000)}-${i++}.png`);
      await extractFrame(ffmpeg, {
        file, kind: layer.media.kind, seconds: Math.max(0, layer.mediaTime), width, height, opacity: layer.opacity, filter: layer.filter,
        out: layerOut,
      });
      out.push(layerOut);
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
interface RenderJob { run: () => Promise<any>; ok: (v: any) => void; fail: (e: any) => void; priority: number; queueTimer?: NodeJS.Timeout }
const renderWaiting: RenderJob[] = [];
/**
 * 正在渲的:键 → 那次渲染的 promise。同一个键同时被要好几次时共用一次渲染。
 * 并行池之前不需要它(串行天然错开),之后才需要 —— 见 bakeOne 里的说明。
 */
const bakeInFlight = new Map<string, { promise: Promise<any>; priority: number }>();
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

/**
 * **永远给前台留一个槽位。**
 *
 * 插队(priority)只解决「谁先排」,解决不了「有没有位子」:空闲预烘会把池子填满,
 * 于是用户改完一张卡、正盯着屏幕等的那一张,得先等某个没人等的活跑完才有槽位。
 * 实测过一次 13.6 秒 —— 插队是生效的,可它前面那 7 个都已经在跑了,插队插不进正在跑的。
 *
 * 所以后台(priority 0)最多只能用到 `max - 1`,剩下那个槽位专门空着等前台。
 * 代价是吞吐少了 1/7,换来的是**用户永远不用等一个没人等的活**。
 *
 * 只有一个槽位的机器留不出来(留了就没人干活了),那时退化成原来的行为。
 */
function pumpRenderQueue() {
  const max = maxConcurrentRenders();
  /*
   * 导出也占槽位(它自己起 Chrome,不走这个队列,见 render-pool-state.mjs)。
   * 按计划 3.3 节:导出期间**空闲预烘整个暂停** —— 预烘是给 3D 视图猜着先烘的,导出时用户多半
   * 不在看;Agent 的活照常,还能用上导出之外的全部槽位(导出最多占 max - 1 个,默认按资源自动分片)。
   */
  const exporting = exportsRunning();
  while (renderWaiting.length) {
    // 队列是按优先级插好序的,队头就是下一个最该跑的
    const next = renderWaiting[0];
    if (next.priority <= 0 && exporting > 0) break;
    const limit = next.priority > 0 ? max : Math.max(1, max - 1);
    if (renderRunning + exporting >= limit) break;
    const item = renderWaiting.shift()!;
    // 排队看门狗只管排队那一段;真开跑了就归 runExport 的 RENDER_TIMEOUT_MS 管
    if (item.queueTimer) clearTimeout(item.queueTimer);
    renderRunning++;
    Promise.resolve()
      .then(item.run)
      .then(item.ok, item.fail)
      .finally(() => { renderRunning--; pumpRenderQueue(); });
  }
}

/**
 * priority 越大越先跑。前台(用户正等着看的)传 1,空闲预烘用默认的 0。
 *
 * `queueTimeoutMs`:**排队等太久就别等了。**
 *
 * runExport 的 `RENDER_TIMEOUT_MS` 是从「派活那一刻」起算的,盖不住前面排队的那一段。
 * 于是一个活可以在队列里躺任意久而没有任何看门狗上膛 —— 上层(见 mcp-tools.mjs 里
 * see_frames 的 timeoutMs)先到点放弃等待,回一句「超过 N 秒没有返回」,而这句话
 * 什么都没解释:到底是渲染卡住了,还是压根没轮到它?两者的下一步完全不同。
 * 给排队单独上一个看门狗,超时就把它从队里摘掉并说清是**排队**排掉的。
 */
/** 调用方不要了(连接断开 / 被取消)时抛的错。带 cancelled,调用方据此不当成渲染失败 */
function cancelError(): Error {
  return Object.assign(new Error("请求方已经不要这张图了,渲染已取消"), { cancelled: true });
}

// 导出一结束,被暂停的预烘接着派
onPoolChange(() => pumpRenderQueue());

/**
 * `signal`:调用方断开连接(或者 Agent 那边已经放弃等待)就拨它。
 * 还在排队的直接摘掉;已经开跑的由 job 自己看同一个 signal 去叫停 worker(见 runOnWorker)。
 * 以前服务端从不看断开:页面那边掐了请求,活照样留在队里、照样渲完,白占一个 Chrome。
 */
function enqueue<T>(job: () => Promise<T>, priority = 0, queueTimeoutMs = 0, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((ok, fail) => {
    if (signal?.aborted) return fail(cancelError());
    const item: RenderJob = { run: job, ok, fail, priority };
    signal?.addEventListener("abort", () => {
      const at = renderWaiting.indexOf(item);
      if (at < 0) return; // 已经开跑了,交给 job 自己停
      renderWaiting.splice(at, 1);
      if (item.queueTimer) clearTimeout(item.queueTimer);
      fail(cancelError());
    }, { once: true });
    if (queueTimeoutMs > 0) {
      item.queueTimer = setTimeout(() => {
        const at = renderWaiting.indexOf(item);
        if (at < 0) return; // 已经开跑了,轮不到这里管
        renderWaiting.splice(at, 1);
        fail(new Error(
          `排队等渲染超过 ${Math.round(queueTimeoutMs / 1000)} 秒还没轮到(前面有 ${renderRunning} 个正在渲)。`
          + `不是这张卡的问题 —— 过一会儿再看,或者等手上的导出 / 预烘跑完。`,
        ));
      }, queueTimeoutMs);
    }
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

/**
 * 这个请求的调用方断开时拨一下的 signal。
 *
 * `res` 的 close 在两种时候都会触发:正常回完话,和对面先断了。只有后一种(还没 end)才算「不要了」。
 * 以前服务端从不看断开:页面那边掐了请求(3D 视图换了时刻、Agent 超时放弃),活照样留在队里、
 * 照样渲完,白占一个 Chrome —— 前面排着的真正要看的那张就得多等。
 */
function abortOnClose(res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  return ac.signal;
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
 * 默认路径通过 FramePipeline 在同一个 Chrome 页面里渲染完整 FrameScene；视频只在目标截图帧
 * 挂载并 seek。显式选择旧 ffmpeg 兼容旁路时，才会把素材层单独抽帧并合到卡片下面。
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
  /*
   * **把这一段挪到固定的起跑线上再烘。**
   *
   * 以前是照着它在时间轴上的原位渲的,两笔账都记在这上头:
   *
   * 1. **延迟和它排得多靠后成正比。** 导出脚本从第 0 帧顺推(确定性要求),而实测**推一个
   *    「画面上什么都没有」的空帧和推一个实帧一样贵**(约 16ms):一张卡摆在第 10 秒,
   *    烘它第一帧要 9014ms,其中 4803ms 全花在推 0~299 这 300 个空帧上。
   * 2. **挪一下位置,它烘好的十来个时刻全部作废。** 缓存键里带着 start/end 的绝对值,
   *    而画面根本没变 —— 用户只是把卡拖了个位置,参数一个字没改,却要干等重烘一遍。
   *
   * 挪到起跑线上之后,同一张卡同一个**片内相对时刻**永远算出同一个键、渲同一趟,
   * 两笔账一起消掉:推帧距离只剩 BAKE_LEAD + 片内偏移,和它排在哪儿无关。
   *
   * ## 凭什么敢挪:34 张卡逐字节验过
   *
   * 挪位置要成立,前提是卡片画出来和绝对位置无关。逐卡对过账(同一片内时刻,一份摆在
   * 0.5 秒处、一份摆在 12 秒处,比 PNG 的 sha1):**34/34 逐字节相同**。
   *
   * 验的过程里咬出两件事,都在这一版里处理了:
   *
   * - **mu-word-rotate 原来真的会随位置变**:摆在 0/0.5/1 秒处和摆在 2/3/4/6/12 秒处
   *   烘出来是两张不同的图,差 22599 个像素、最大通道差 250(板子上显示的是上一个词还是
   *   下一个词)。根因在卡片那边(轮播用 `now - lastTick` 累加、命中后把相位挪到当前帧),
   *   已经改成 `floor(elapsed / duration)`,见 vendor/word-rotate.tsx。
   * - **第 0 帧是特殊的,所以起跑线不能是 0。** 预热(warmUp)在 t=0 上走四帧再重挂载卡片,
   *   于是「片段正好压着第 0 帧」的卡会多经历这一段:实测摆在 0 秒处 vs 摆在别处,
   *   step-timeline 差 15164 个像素、mu-word-rotate 差一整个词。留半秒的起跑距离就绕开了
   *   ——  实测 0.5 秒处和 12 秒处 34/34 逐字节相同。代价是每趟多推 15 帧(约 0.24 秒)。
   */
  /*
   * **片内位置一律用「第几帧」表示,不用「差多少秒」。**
   *
   * 时刻的格子本来就是相对片段起点的(`bakeTime.ts` 的 `pickBakeT` 返回 `clip.start + 格子`),
   * 所以直觉上 `t - clip.start` 就把绝对位置减掉了。但那是**浮点减法**:一段摆在 3 秒处时
   * `3.25 - 3 = 0.25` 逐位精确,摆在 17.3 秒处时 `17.55 - 17.3 = 0.2500000000000018`。
   * 键是拿这个数哈希出来的,于是"挪一下位置就全部作废"会以另一种形式活下来 ——
   * 而且只在位置不是整数的时候发作,最难查。(同一类坑 bakeTime.ts 里记过一次:
   * step=1/30 时累加和 floor 再乘差 2.8e-17,后果是"预烘出来的图显示端一张都问不到"。)
   *
   * 换成整数帧号就没有这回事:同一个帧号必然算出同一个 double,而渲染那一侧
   * (`Math.round(at * fps)`)本来就只认帧号,一点信息都没丢。
   */
  const fps = project.fps || 30;
  // 至少留一帧:零长度的段推不出任何一帧,烘出来是空图而且不报错
  const lenFrames = Math.max(1, Math.round(((iso.clip.end ?? 0) - (iso.clip.start ?? 0)) * fps));
  const len = lenFrames / fps;
  const { frame: _dropFrame, ...bare } = iso.clip;
  /*
   * 键就是从这个 plainClip 算的,所以**这里挪了位置,键才真的和位置无关**。
   * 只改 at、不改 clip 上的 start/end 是不够的 —— 那两个字段照样会进哈希。
   */
  const plainClip = { ...bare, start: BAKE_LEAD, end: BAKE_LEAD + len };
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
  /*
   * **两个尺寸,不能混为一谈。**
   *
   *   renderBox —— 按什么尺寸**排版**,也就是输出多大。必须是这张卡在成片里真实的容器大小。
   *
   * 原来这两个是同一个值(直接按贴图尺寸去渲),后果是**卡片按别的宽度重新排了版**:
   * 卡片用的是绝对 px,容器从 1920 变成 1024,字就相对变大、要换行、底块被撑满。
   * 实测同一张 blur-text:在 1024×576 上渲,内容框占画布 100%×70.1%(换行);
   * 在真实的 1920×1080 上渲是 66.5%×28.1%(一行)—— 后者才和 2D 预览一致。
   * 也就是说 3D 板子上贴的根本不是 2D 那张画面,而且不报错。
   *
   * square 那一档不受影响:它**本来就是**要在正方形容器里排版(贴到立体表面上,
   * 16:9 会被拉变形),所以它的 renderBox 就是那个正方形。
   */
  const renderBox = fit === "box" ? { width: box.w, height: box.h } : { width: px, height: px };
  // 没给时间就取这一段的中点 —— 起止两端常卡在进场 / 退场动画上,烘出来是个半透明中间态
  const relFrames = Number.isFinite(t)
    ? Math.min(lenFrames, Math.max(0, Math.round(((t as number) - (iso.clip.start ?? 0)) * fps)))
    : Math.round(lenFrames / 2);
  /** 真正渲第几帧:起跑线 + 片内第几帧。**键和渲染都用它**,所以和绝对位置无关 */
  const at = BAKE_LEAD + relFrames / fps;
  /**
   * 回给调用方的 t —— **必须是它问的那个绝对时刻**,不是上面那个挪过的。
   *
   * 3D 视图和预烘都拿 `clipId + t` 当贴图的账本键(momentId),回一个挪过的时刻就会
   * 对不上号:`batch.find(x => x.t === b.t)` 全部落空,于是「明明烘出来了却当成没烘」,
   * 一直重烘同一张,而且不报错。
   */
  const askedT = Number.isFinite(t) ? (t as number) : (iso.clip.start + iso.clip.end) / 2;
  const rgb = typeof bg === "string" ? /^#?([0-9a-f]{6})$/i.exec(bg.trim()) : null;

  /*
   * code:这张卡此刻代码的哈希(定义文件 + 依赖闭包的生效内容,见 card-overrides.mjs)。
   * 没有它的时候改了卡片源码,预烘的旧图照样命中,3D 视图里贴的一直是改之前的样子。
   */
  const key = createHash("sha1")
    .update(JSON.stringify({ clip: plainClip, theme: project.themeId, at, renderBox, fit, bg: rgb ? rgb[1].toLowerCase() : null, code: cardCodeHash(iso.clip.cardId) }))
    .digest("hex").slice(0, 12);
  // 文件名带上 clipId 只是为了在素材目录里认得出来;真正保证唯一的是后面那段输入哈希
  const name = `bake-${clipId.replace(/[^\w.-]/g, "_")}-${key}.png`;
  const url = `/@media/${encodeURIComponent(name)}`;
  /**
   * 渲这一趟用的项目。**只在这里拼一次**:烘单张和烘一批以前各拼一份,
   * 两处都要记得改 duration、改 tracks、按 renderBox 排版 —— 漏一处就是
   * 「单张烘的和批量烘的不是同一张图」,而且不报错。
   *
   * duration 必须跟着挪过的位置重算(原来那个是整条片子的长度,而这里只剩一段),
   * 多给一帧的余量:renderFrames 会把帧号夹进 duration*fps-1,正好卡在末尾时会少一帧。
   */
  const target = {
    ...iso.project,
    // **按真实容器尺寸排版**,不是按贴图尺寸(见上面那段说明)
    width: renderBox.width,
    height: renderBox.height,
    duration: BAKE_LEAD + len + 1 / fps,
    tracks: iso.project.tracks.map((tr: any) => ({ ...tr, clips: tr.clips.map(() => plainClip) })),
  };
  return { iso, plainClip, renderBox, target, at, askedT, rgb, key, name, url };
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
  /**
   * 已经渲好的那一帧(已经按 bg 压过底色、数过透明像素)。给 bakeClip 用:它一趟渲出同一张卡的好几个时刻,
   * 然后把每一张交回这里走**同一套**缓存键、原子落盘和返回值 ——
   * 两条路各写一套的话,迟早会出现「单张烘的和批量烘的不是同一张图」,而且不报错。
   */
  pre?: FrameResult,
  /** signal:调用方断开就取消;runner:谁来跑(不给是渲染池,界面的热备渲染器会传自己的) */
  o: { signal?: AbortSignal; runner?: Runner } = {},
): Promise<any> {
  const { target, at, askedT, rgb, key, name, url, renderBox } = bakeTarget(project, clipId, t, size, bg, fit);
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
    return { clipId, url, t: askedT, width: renderBox.width, height: renderBox.height, bytes: st.size, cached: true, hint, note };
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
  /*
   * 搭车等同键的那一趟,有两个例外:
   *   - **自己更急就不搭**:Agent 的 bake_card(优先级 1)撞上一趟排在队尾的预烘(优先级 0)时,
   *     跟着等就是排在所有预烘后面、直到工具超时 —— 优先级倒挂。自己渲一趟,落盘是原子改名,两份不冲突。
   *   - **那一趟被取消了**(是它的请求方断开,不是这张图渲不出来):再看一眼,别的等待者可能已经接着渲了,
   *     有就跟那一趟;没有才自己来。见过的就不再跟,免得在同一个已经失败的 promise 上打转。
   */
  const seen = new Set<Promise<any>>();
  for (;;) {
    const flying = bakeInFlight.get(key);
    if (!flying || seen.has(flying.promise) || priority > flying.priority) break;
    seen.add(flying.promise);
    try {
      return await flying.promise;
    } catch (e: any) {
      if (!e?.cancelled || o.signal?.aborted) throw e;
    }
  }

  const work = bakeAndWrite();
  bakeInFlight.set(key, { promise: work, priority });
  try {
    return await work;
  } finally {
    if (bakeInFlight.get(key)?.promise === work) bakeInFlight.delete(key);
  }

  async function bakeAndWrite() {
  /*
   * 底色决定贴上去是什么观感,而这个选择只该在**烘的时候**做一次:
   *   不传 bg → 透明底,物体在卡片没画的地方也透空(挖空观感,适合标志 / 招牌);
   *   传了 bg → 压平成不透明,实心物体表面印着这张卡。
   * 压底色和数透明像素都在渲染 worker 里做(post.bg / post.stats,见 server/png-post.mjs),
   * 这个进程只收字节、落盘。
   */
  const post = { bg: rgb ? rgb[1].toLowerCase() : null, stats: true };
  const r = pre ?? (o.runner
    ? await renderOneFrame(root, origin, target, at, [], priority, { signal: o.signal, runner: o.runner, post })
    : await enqueue(() => renderOneFrame(root, origin, target, at, [], priority, { signal: o.signal, post }), priority, 0, o.signal));

  /*
   * 先写临时名再改名。改名在同一个卷上是原子的,所以**读的人要么看不到这个文件、
   * 要么看到完整的一张**,不会读到写了一半的。直接往目标名写会留一个能读到半张的窗口,
   * 而半张 PNG 贴不上,看起来就是「这块板子一直是色块」,还查不出原因。
   */
  const tmp = `${file}.${process.pid}-${counter++}.tmp`;
  await fsp.writeFile(tmp, r.buf);
  await fsp.rename(tmp, file);
  return {
    clipId, url, t: askedT, width: r.width ?? renderBox.width, height: r.height ?? renderBox.height, bytes: r.buf.length, cached: false,
    ...(r.transparentRatio !== undefined ? { transparentRatio: r.transparentRatio } : {}),
    hint, note,
  };
  }
}

/**
 * 烘**同一张卡的若干个时刻**。没烘过的合成一趟渲完,烘过的直接命中缓存。
 *
 * 为什么按卡分组而不是把所有请求平铺开:导出脚本从第 0 帧顺推(确定性要求),所以
 * 「烘第 F 帧」这件事已经把 0..F 全推了一遍 —— 同一张卡里**所有 ≤F 的时刻都是顺路白捡的**,
 * 多截一张 78ms,而单独开一趟要 4400ms。
 *
 * **这不牺牲「先烘播放头附近」**:批次的先后仍然由调用方按离播放头的距离排,这里只是把
 * 同一张卡的其余时刻捎上。最坏情况是那个最近的时刻在一趟里排在后面几张,晚几十毫秒。
 */
async function bakeClip(
  root: string,
  origin: string,
  project: any,
  clipId: string,
  times: number[],
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
  priority = 0,
  o: { signal?: AbortSignal; runner?: Runner } = {},
): Promise<any[]> {
  const uniq = [...new Set(times.map(Number).filter(Number.isFinite))];
  if (uniq.length <= 1) {
    return [await bakeOne(root, origin, project, clipId, uniq[0], size, bg, fit, priority, undefined, o)];
  }

  // 哪几个时刻还没落盘。已经有的不进这一趟 —— 它们在 bakeOne 里一次 fs.access 就返回了
  const dir = mediaDir(root);
  const missing: { t: number; at: number }[] = [];
  for (const t of uniq) {
    const tg = bakeTarget(project, clipId, t, size, bg, fit);
    try { await fsp.stat(path.join(dir, tg.name)); } catch { missing.push({ t, at: tg.at }); }
  }
  if (missing.length < 2) {
    return await Promise.all(uniq.map((t) => bakeOne(root, origin, project, clipId, t, size, bg, fit, priority, undefined, o)));
  }

  /*
   * 排版尺寸对同一张卡是固定的(只看 clip 的框),所以一趟里所有时刻共用同一个 target 项目。
   * 时刻不同的只是「渲第几帧」,由 renderFrames 的 target-frames 决定。
   */
  const { target, rgb } = bakeTarget(project, clipId, missing[0].t, size, bg, fit);
  const fps = target.fps || 30;
  // 底色和透明统计在渲染 worker 里一并做掉(和单张那条路同一套 post),交回 bakeOne 的已经是成品
  const post = { bg: rgb ? rgb[1].toLowerCase() : null, stats: true };
  const atList = missing.map((m) => m.at);
  const shots = o.runner
    ? await renderFrames(root, origin, target, atList, [], priority, { signal: o.signal, runner: o.runner, post })
    : await enqueue(() => renderFrames(root, origin, target, atList, [], priority, { signal: o.signal, post }), priority, 0, o.signal);

  // 渲好的按帧号交回 bakeOne,缓存键、落盘、返回值全走那一套
  const byT = new Map<number, FrameResult>();
  for (const m of missing) {
    const f = Math.max(0, Math.round(m.at * fps));
    const r = shots.get(f);
    if (r) byT.set(m.t, r);
  }
  return await Promise.all(uniq.map((t) => bakeOne(root, origin, project, clipId, t, size, bg, fit, priority, byT.get(t), o)));
}

/** 一趟烘焙要告诉渲染进程的全部东西。字段名和 export-frames 的 opts 一致 */
interface RenderJobOpts {
  url: string;
  out: string;
  frames: string;
  fps: number;
  /** 只截这几帧(离散取样)。不给就是 frames 那个连续区间 */
  targetFrames?: number[];
}

/**
 * # 常驻渲染 worker 池
 *
 * 以前每烘一次就 spawn 一个 node、起一个 Chrome、烘完整个进程退掉。**这笔固定开销比烘焙本身
 * 大一个数量级**,实测(1920×1080,只要第 0 帧,vite 和 Chrome 都已经热着):
 *
 * ```
 *   162ms  Launching Puppeteer...        ← 进程启动 + import puppeteer 只要 155ms
 *   643ms  Warm-up 3 frames...
 *  1109ms  Export finished in 0.4s.      ← 活儿到这里就干完了
 *  4030ms  进程退出                       ← 剩下的 2.9 秒全是 browser.close() 在等 Chrome 收摊
 * ```
 *
 * 也就是说四秒里只有一秒在干活,**将近三秒是在等一个 Chrome 关机** —— 而且这三秒结结实实
 * 压在用户身上:runExport 是 `child.on("close")` 才 resolve 的。
 *
 * 换成常驻之后,同一份活实测 **4030ms → 810ms**(首趟 1261ms,含起 Chrome)。省下的既不是
 * 起进程也不是加载页面,就是那个「开机 + 关机」。
 *
 * ## 复用的确定性靠什么保证
 *
 * 不是这里保证的,是 export-frames 里 `bakery.reset()` 保证的:每趟开一个**全新的 page**
 * (全新 renderer,从没被启用过虚拟时间,和全新起一个浏览器等价),旧 page 立刻关掉。
 * 那边有逐字节比对过的实测数据(复用烘的 vs 全新起浏览器烘的,四趟两两 6/6 全 0 帧)。
 * 这里只负责**别把一个可疑的 worker 继续用下去**:超时、崩了、报过错的一律杀掉重开
 * (worker 自己那边还有一层,见 render-worker.mjs 的「三条自保规矩」)。
 *
 * ## 为什么 worker 数不用另算一遍
 *
 * 并发上限由 `enqueue` 那个池子把着(见 maxConcurrentRenders),走到这里的活本来就不会超过它。
 * 所以这里只要「有空闲的就用,没有就再开一个」,不必再算一次 —— 两处各算各的,迟早会
 * 出现「池子说能跑 7 个,worker 只有 3 个」这种对不上账的事。多出来的 worker 由它自己的
 * 闲置超时收掉。
 */
interface RenderWorker {
  child: import("node:child_process").ChildProcess;
  busy: boolean;
  /** 这个 worker 上还没回来的活:请求 id → 结果回调。`started` 是它有没有真的开跑 */
  pending: Map<number, { ok: (result?: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout | null; started: boolean }>;
  /**
   * 手上有一张备好的空页(worker 回过 hot):下一趟来活只需把项目灌进去,约 3~4 ms 就能开渲。
   * 界面那对热备渲染器按它挑「谁是热的」(docs/decoupling-plan.md 第 3.2 节)。
   */
  hot: boolean;
  /** 忙着的时候收到的 hot:收尾放掉 busy 时再算热(hot 常和 done 同一轮到达,见 spawnWorker) */
  hotPending?: boolean;
  /** 收到过几次 hot、最近一次什么时候(热备状态的明细,排查用) */
  hotMsgs?: number;
  lastHotAt?: number;
  /** 最近一次被热备巡检催着预热是什么时候(同一台 5 秒内不重复催) */
  warmingAt?: number;
  /** 变热时的回调(热备调度用来派待办) */
  onHot?: () => void;
  /** stdout/stderr 的最后几行,出错时当错误信息用 */
  tail: string[];
  /** 已经不能再派活了(超时杀掉 / 自己退了) */
  dead: boolean;
  /**
   * 前台专用。**后台的活一律不许碰它。**
   *
   * 池子按并发上限分配槽位本来就给前台留了一格,但那只解决「有没有位子」,解决不了
   * 「位子上那个 Chrome 是不是热的」:后台预烘会把所有已有的 worker 占满,于是用户
   * 松手要图时只能现开一个 —— 又是一次开机。留一个专属的、预热好的、永不闲置退出的,
   * 用户拖到哪儿松手都有人立刻接住。
   */
  reserved: boolean;
}

const renderWorkers: RenderWorker[] = [];
let renderJobSeq = 0;
/**
 * 最近一次渲染用的源地址。预热要一个能打开的导出页地址,而预热发生在「还没有活」的时候,
 * 手上没有任何 opts.url 可用 —— 记一个下来就够,反正整个开发服务器只有一个源。
 */
let lastRenderOrigin: string | null = null;

/** 从池子里摘掉一个 worker 并杀掉它;它身上没回来的活全部判失败 */
function killWorker(w: RenderWorker, why: Error) {
  if (w.dead) return;
  w.dead = true;
  const at = renderWorkers.indexOf(w);
  if (at >= 0) renderWorkers.splice(at, 1);
  for (const p of w.pending.values()) { clearTimeout(p.timer); p.fail(why); }
  w.pending.clear();
  // 渲染进程自己还拉着一个 Chrome,只杀它会留孤儿
  if (process.platform === "win32" && w.child.pid) spawn("taskkill", ["/PID", String(w.child.pid), "/T", "/F"], { stdio: "ignore" });
  else w.child.kill("SIGKILL");
}

function spawnWorker(root: string, reserved = false): RenderWorker {
  const child = fork(path.resolve(root, "scripts/render-worker.mjs"), [], {
    cwd: root,
    // stdout/stderr 留着当错误信息;协议走第四条 ipc 通道,不和日志混在一起
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    // 前台那个常驻不许闲置退出(0 = 永不),否则用户去改会儿参数回来又要等一次开机
    env: reserved ? { ...process.env, PROMPTCUT_WORKER_IDLE_MS: "0" } : process.env,
  });
  const w: RenderWorker = { child, busy: false, pending: new Map(), tail: [], dead: false, reserved, hot: false };
  const keep = (chunk: Buffer) => { w.tail.push(chunk.toString()); if (w.tail.length > 20) w.tail.shift(); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("message", (msg: any) => {
    if (msg?.type === "hot") {
      w.hotMsgs = (w.hotMsgs ?? 0) + 1;
      w.lastHotAt = Date.now();
      /*
       * worker 只在手上没活时才报 hot。但它往往紧跟着「done」一起到:两条消息同一轮连着派发,
       * 这时 runOnWorker 还没来得及把 busy 放掉。忙着的时候先记下来,收尾放掉 busy 时再算热
       * (见 runOnWorker)—— 直接丢掉的话,「热」就一直停在 0。
       */
      if (w.busy) {
        w.hotPending = true;
        return;
      }
      w.hot = true;
      w.onHot?.();
      return;
    }
    const p = msg ? w.pending.get(msg.id) : undefined;
    if (!p) return;
    if (msg.type === "started") { p.started = true; return; }
    if (msg.type !== "done" && msg.type !== "error") return;
    w.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    // busy 由派活的那一方在整趟(渲染 + 后处理)结束后放掉,见 runOnWorker
    if (msg.type === "done") p.ok(msg.result);
    else {
      /*
       * worker 报错时它自己已经把那个 bakery 丢掉了(见 render-worker 的第 1 条规矩),
       * 进程本身还是干净的,所以**不杀**,下一趟它会重新开一个浏览器。
       * 被取消的(cancelled)连 bakery 都没丢,只是换一张页。
       */
      p.fail(Object.assign(new Error(String(msg.message || "渲染失败")), { cancelled: !!msg.cancelled }));
    }
  });
  const bury = (code: number | null) => {
    if (w.dead) return;
    const msg = w.tail.join("").trim().slice(-600);
    killWorker(w, new Error(code === 3221225794
      ? "渲染进程启动失败(0xC0000142)。同时开着的浏览器实例太多,等导出跑完再看图。"
      : `渲染进程异常退出(代码 ${code})${msg ? `:${msg}` : ""}`));
  };
  child.on("error", (e) => { if (!w.dead) killWorker(w, e instanceof Error ? e : new Error(String(e))); });
  child.on("exit", bury);
  renderWorkers.push(w);
  // 前台那个一生下来就把 Chrome 开起来 —— 等用户松手才开机,他就要多等约 1.3 秒
  if (reserved && lastRenderOrigin) child.send({ type: "prewarm", url: `${lastRenderOrigin}/?export=1` });
  return w;
}

/**
 * 挑一个 worker 干活。**前台和后台走两条路。**
 *
 *   前台(用户松手正等着看的那一张)—— 只用 reserved 那个:它是热的、专属的、永不闲置退出,
 *     后台再忙也占不到它。派走之后**立刻再备一个热的**,免得用户连着拖两次时第二次没人接。
 *   后台(空闲预烘)—— 只用非 reserved 的,没有空闲的就再开一个。
 *     **绝不碰 reserved**:预烘一个活五六秒,占住它这套东西就白做了。
 *
 * 池子的并发上限(见 pumpRenderQueue)管的是「有没有位子」,这里管的是
 * 「位子上那个 Chrome 是不是热的」—— 两件事,缺一个用户都得干等一次开机。
 */
function pickWorker(root: string, priority: number): RenderWorker {
  if (priority > 0) {
    const w = renderWorkers.find((x) => x.reserved && !x.busy && !x.dead) ?? spawnWorker(root, true);
    w.busy = true;
    ensureSpareWorker(root);
    return w;
  }
  const w = renderWorkers.find((x) => !x.reserved && !x.busy && !x.dead) ?? spawnWorker(root, false);
  w.busy = true;
  return w;
}

/** 手上没有空闲的前台 worker 了就再开一个并预热 —— 「开烘之后立刻备一个」的落点 */
function ensureSpareWorker(root: string) {
  if (renderWorkers.some((x) => x.reserved && !x.busy && !x.dead)) return;
  spawnWorker(root, true);
}

/**
 * 跑一趟烘焙。单张和批量共用同一套超时 / 报错处理。
 *
 * 超时的处理和以前一样是**杀进程**,但杀的是整个 worker(连它守着的 Chrome)——
 * 卡住的页面留着比重开一个贵:下一趟在它上面烘出来的东西不可信,而且不报错。
 */
/** 一帧交出去之前的像素活,由渲染 worker 做(server/png-post.mjs 的 postFrame) */
interface PostItem {
  cards: string;
  layers?: string[];
  out: string;
  bg?: string | null;
  stats?: boolean;
  shrink?: boolean;
}

/**
 * 一趟渲染活:先烘帧(opts),再可选地做后处理(post 在烘帧结束后才调,那时素材层也抽好了)。
 * post 返回 null = 什么都不用做,调用方直接读帧文件。
 */
interface RenderJob2 {
  opts: RenderJobOpts;
  post?: () => Promise<PostItem[] | null>;
}

/** 谁来跑一趟活:渲染池(runExport)或界面那对热备渲染器(uiRenderer.run) */
type Runner = (job: RenderJob2, signal?: AbortSignal) => Promise<any[] | null>;

/**
 * 给一个 worker 发一条消息,等它回话。超时就连 worker 带 Chrome 一起杀掉
 * (卡住的页面留着比重开一个贵:下一趟在它上面烘出来的东西不可信,而且不报错)。
 *
 * `signal` 拨了就不等了:烘帧那一种顺手叫 worker 停下(它在两帧之间停,只换页不换浏览器),
 * 这边立刻返回「已取消」。worker 那边随后回来的那条 error 找不到等它的人,直接丢掉。
 */
function callWorker(
  w: RenderWorker,
  msg: { type: string; id: number; [k: string]: any },
  timeoutMs: number,
  signal?: AbortSignal,
  entry: { ok: (r?: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout | null; started: boolean } =
    { ok: () => {}, fail: () => {}, timer: null, started: false },
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = msg.id;
    entry.ok = resolve;
    entry.fail = reject;
    entry.timer = setTimeout(() => {
      w.pending.delete(id);
      killWorker(w, new Error(`渲染超时(${timeoutMs / 1000} 秒)。`));
      reject(new Error(`渲染超时(${timeoutMs / 1000} 秒)。`));
    }, timeoutMs);
    w.pending.set(id, entry);
    if (signal?.aborted) {
      // 还没发出去就不要了:干脆不发,也不发 cancel(发了 worker 那边会记一个永远用不上的 id)
      w.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      return reject(cancelError());
    }
    /*
     * 取消:叫 worker 停下,但**不在这里放手** —— 要等它回话(它停在两帧之间,或者开完页一看已取消),
     * 这台 worker 才真的空出来。以前这里立刻 reject,busy 马上变 false:渲染池的在跑计数偏小、Chrome 超发,
     * 下一趟活派到同一台上还得排在旧活后面,热备的「打断」也腾不出真正空闲的那台。
     * 后处理(post)很快,不取消,让它做完。worker 迟迟不回话就当它卡死了,整台杀掉。
     */
    const onAbort = () => {
      if (!w.pending.has(id) || msg.type !== "bake") return;
      w.child.send({ type: "cancel", id }, () => {});
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        if (!w.pending.has(id)) return;
        w.pending.delete(id);
        killWorker(w, new Error(`取消之后 ${CANCEL_GRACE_MS / 1000} 秒 worker 还没停下`));
        reject(cancelError());
      }, CANCEL_GRACE_MS);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    w.child.send(msg, (e) => {
      if (!e) return;
      w.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      killWorker(w, e);
      reject(e);
    });
  });
}

/**
 * 在这个 worker 上跑完一整趟:烘帧,然后(需要的话)后处理。**同一个 worker 做两步**:
 * 帧文件就在它刚写的目录里,而且整趟算一个槽位,调度那边不用拆开记账。
 * 结束时放掉 busy —— 不管成功、失败还是取消。
 */
async function runOnWorker(w: RenderWorker, job: RenderJob2, signal?: AbortSignal): Promise<any[] | null> {
  w.hot = false;
  w.hotPending = false;
  try {
    const entry = { ok: () => {}, fail: () => {}, timer: null, started: false };
    try {
      await callWorker(w, { type: "bake", id: ++renderJobSeq, opts: job.opts }, RENDER_TIMEOUT_MS, signal, entry);
    } catch (e: any) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { notStarted: !entry.started });
    }
    if (!job.post) return null;
    // 烘完帧才发现调用方已经不要了:后处理就不做了
    if (signal?.aborted) throw cancelError();
    const items = await job.post();
    if (!items || !items.length) return null;
    return await callWorker(w, { type: "post", id: ++renderJobSeq, items }, RENDER_TIMEOUT_MS, signal);
  } finally {
    w.busy = false;
    // 忙着的时候 worker 已经报过 hot(备用页好了、手上没活):现在放手了,补上
    if (w.hotPending && !w.dead) {
      w.hotPending = false;
      w.hot = true;
      w.onHot?.();
    }
  }
}

/**
 * 在渲染池里跑一趟。单张和批量共用同一套超时 / 报错处理。
 */
async function runExport(root: string, job: RenderJob2, priority = 0, signal?: AbortSignal, retry = true): Promise<any[] | null> {
  try { lastRenderOrigin = new URL(job.opts.url).origin; } catch { /* 地址不合法就不记,预热那一步自然跳过 */ }
  const w = pickWorker(root, priority);
  try {
    return await runOnWorker(w, job, signal);
  } catch (e: any) {
    /*
     * **没开跑的活重发一次。** 只有一种成因:派活的那一刻这个 worker 正好闲置超时自己退了
     * (IPC 是异步的,谁也拦不住这个瞬间)。不重试的话,用户每隔一阵子就会随机撞上一次
     * 「渲染进程异常退出」,而下一次点又好了 —— 最难查的那种偶发。
     *
     * 开跑之后失败的**不**重发:那时候可能已经落了一半的盘,而 worker 那边已经把出过错的
     * bakery 丢掉了,下一趟本来就是干净的。被取消的当然也不重发。
     */
    if (retry && e?.notStarted && !e?.cancelled) return await runExport(root, job, priority, signal, false);
    throw e;
  }
}

/** 一帧交出去的结果。width / height / transparentRatio 只在做过后处理时才有 */
interface FrameResult {
  buf: Buffer;
  width?: number | null;
  height?: number | null;
  transparentRatio?: number;
}

/** 渲染的附加选项 */
interface RenderOpts {
  /** 调用方不要了就拨它:排队的摘掉,在跑的叫停 */
  signal?: AbortSignal;
  /** 交出去之前的像素活:shrink = 给模型看的缩图;bg = 压底色(六位十六进制);stats = 数透明像素 */
  post?: { shrink?: boolean; bg?: string | null; stats?: boolean };
  /** 谁来跑:不给就是渲染池 */
  runner?: Runner;
}

/**
 * 单帧就是只要一个时刻的 renderFrames:两条路截出来的画面逐字节相同(单张走 frames `F-F`
 * 也是从第 0 帧推到 F,见 renderFrames 的说明),合成一条就不会出现「单张和批量不是同一张图」。
 */
async function renderOneFrame(root: string, origin: string, project: any, t: number, notes: string[], priority = 0, o: RenderOpts = {}): Promise<FrameResult> {
  const m = await renderFrames(root, origin, project, [t], notes, priority, o);
  const first = m.values().next().value;
  if (!first) throw new Error("一帧都没渲出来");
  return first;
}

/**
 * 一趟渲**同一份项目的若干个时刻**。返回「帧号 → PNG」。
 *
 * 和 renderOneFrame 的唯一区别是「一趟出几张」。为什么值得单开一条路:导出脚本不管要第几帧
 * 都从第 0 帧顺推(确定性要求 —— 动画的锚点是「首次出现那一帧」,跳着推就没有锚点),
 * 所以烘一张卡的 N 个时刻,分 N 趟就是 N 次重复顺推,是 O(N²);一趟推过去沿途截,推进只付一次。
 *
 * 实测(1920x1080、同一张卡的 7 个时刻):分 7 趟 31.0s → 一趟 2.7s,**11.4 倍**,而且
 * 7 张逐字节相同。单价拆开是:推一帧约 18~23ms,截一张约 78ms,而单独起一趟要 4.0~5.0s。
 * 也就是说同一张卡的第 2 个时刻起,成本从 4400ms 掉到 78ms。
 */
async function renderFrames(root: string, origin: string, project: any, times: number[], notes: string[], priority = 0, o: RenderOpts = {}): Promise<Map<number, FrameResult>> {
  if (!o.runner) {
    const service = frameService(root, origin);
    const normalized = renderProject(project);
    const entry = await service.entry(normalized);
    const frames = await service.see_frames(normalized, times, { signal: o.signal, lane: "agent" });
    const result = new Map<number, FrameResult>();
    for (const [frame, value] of frames) {
      if (o.post && (o.post.shrink || o.post.bg || o.post.stats)) {
        const file = path.join(entry.dir, "frames", String(frame).padStart(6, "0") + ".png");
        const out = path.join(entry.dir, "post-" + process.pid + "-" + counter++ + ".png");
        try {
          const info = await postFrame({ cards: file, layers: [], out, bg: o.post.bg ?? null, shrink: !!o.post.shrink, stats: !!o.post.stats });
          result.set(frame, { ...info, buf: await fsp.readFile(out) });
        } finally { await fsp.rm(out, { force: true }); }
      } else result.set(frame, { buf: value.buf, width: project.width, height: project.height });
    }
    return result;
  }

  // 带上 pid:编辑器进程(热备渲染器)和预渲染进程往同一个 out/ 里写,各自的 counter 都从 0 数
  const id = `vision-${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const dir = path.resolve(outRoot(root), `export-${id}`);
  await fsp.mkdir(dir, { recursive: true });

  const fps = project.fps || 30;
  // 帧号必须落在项目时长内,否则脚本会去渲一个空舞台,模型看到一片空白还以为卡没生效
  const maxFrame = Math.max(0, Math.floor((project.duration || 0) * fps) - 1);
  const frames = [...new Set(times.map((t) => Math.min(maxFrame, Math.max(0, Math.round(t * fps)))))].sort((a, b) => a - b);
  const pad = (f: number) => String(f).padStart(6, "0");
  const frameFile = (f: number) => path.join(dir, "frames", `${pad(f)}.png`);
  const finalFile = (f: number) => path.join(dir, `final-${pad(f)}.png`);

  try {
    // 素材层按帧各抽各的,和起 Chrome 渲卡片并行跑(卡片的隔离项目通常没有素材层,这里多半是空的)
    const layersPromises = frames.map(() => Promise.resolve([]));
    await fsp.writeFile(path.join(dir, "project.json"), JSON.stringify(project, null, 2), "utf8");
    const relOut = process.env.PROMPTCUT_EXPORT_DIR ? dir : `out/export-${id}`;
    const wantPost = !!(o.post && (o.post.shrink || o.post.bg || o.post.stats));
    const job: RenderJob2 = {
      opts: {
        url: `${origin}/?export=1&timeline=/@export/${id}/project.json`,
        out: relOut,
        frames: `0-${frames[frames.length - 1]}`,
        targetFrames: frames,
        fps,
      },
      /*
       * 烘完帧再决定要不要后处理:素材层这时也抽好了。**什么都不用做就返回 null**,
       * 下面直接读帧文件交出去 —— 原来没有素材层时也要解码再原样编码一遍,纯属白烧。
       */
      post: async () => {
        const layers = await Promise.all(layersPromises);
        if (!wantPost && layers.every((l) => l.length === 0)) return null;
        return frames.map((f, i) => ({
          cards: frameFile(f), layers: layers[i], out: finalFile(f),
          bg: o.post?.bg ?? null, stats: !!o.post?.stats, shrink: !!o.post?.shrink,
        }));
      },
    };
    const run: Runner = o.runner ?? ((j, s) => runExport(root, j, priority, s));
    const results = await run(job, o.signal);

    const out = new Map<number, FrameResult>();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const r = results ? results[i] : null;
      const buf = await fsp.readFile(r ? finalFile(f) : frameFile(f));
      out.set(f, {
        buf,
        width: r?.width ?? null,
        height: r?.height ?? null,
        ...(r && r.transparentRatio !== undefined ? { transparentRatio: r.transparentRatio } : {}),
      });
    }
    return out;
  } finally {
    // 看一眼就够了,不留垃圾;删不掉也不该让这次调用失败
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/*
 * ===================== 编辑器这一端:常驻热备渲染器(A / B) =====================
 *
 * 用户的前台烘焙(3D 视图当前时刻的贴图、拖动播放头时要的那一帧)**不进预渲染池**,由编辑器
 * 自己守着的两台 Chrome 专门处理(docs/decoupling-plan.md 第 3.2 节「交互界面」)。原话:
 * 「交互端需要留两个 chrome 渲染,永远保持一个是热状态……A 正在渲染,这时候接到了新的任务,
 * 立刻交给热状态的 B,同时清空 A,之后 B 在渲染,A 热状态待机」。
 *
 * 为什么要两台:一台 Chrome 被打断之后要换一张新页才能再用(约 310 ms,冷启动 5.6 s,
 * 往就绪的空页里灌项目只要 3~4 ms,见 hybrid-sampling-plan.md E0)。两台轮换,新请求永远落在热的
 * 那台上,换页的钱放到后台去付。两台是两个独立进程:一台崩了另一台照样顶着。
 *
 * 调度规则:
 *   1. 有热的(或至少空着的)那台就交给它;
 *   2. 两台都在忙:正在渲的那台如果才做了一小段(< UI_INTERRUPT_MS)就打断它,腾出来接新的;
 *      做了不少就让它渲完 —— 结果照样进缓存(bakeOne 落盘),拖回去直接命中;
 *   3. 两台都腾不出来:新请求进「待办」,只留最新一个,先来的直接回「被新请求替换」;
 *   4. 第 2 条的门槛必不可少:拖动播放头每秒几十个请求,每来一个都打断的话,两台会一直在
 *      「打断 → 换页」之间来回,一张图都出不来。
 * 请求方断开也按第 2 条判:才开始的就停,做了不少的渲完进缓存。
 */

/** 正在渲的那一趟做了多久以内才允许打断(毫秒,估计值,按实测再调) */
const UI_INTERRUPT_MS = 150;

interface UiRequest {
  job: RenderJob2;
  signal?: AbortSignal;
  resolve: (v: any[] | null) => void;
  reject: (e: Error) => void;
  /** 已经换一台重试过一次(非取消的失败只重试一次) */
  retried?: boolean;
}

function createUiRenderer(root: string, originFn: () => string) {
  const slots: RenderWorker[] = [];
  const running = new Map<RenderWorker, { ac: AbortController; startedAt: number }>();
  let pending: UiRequest | null = null;

  const ensure = () => {
    for (let i = slots.length - 1; i >= 0; i--) if (slots[i].dead) slots.splice(i, 1);
    while (slots.length < 2) {
      // 预热要一个能打开的导出页地址:就是编辑器自己的源
      lastRenderOrigin = originFn();
      const w = spawnWorker(root, true);
      w.onHot = () => dispatch();
      slots.push(w);
    }
  };

  /*
   * **巡检:永远保持热着**(用户原话「永远保持一个是热状态,才能随时响应」)。
   *
   * 「热」靠 worker 报 hot 维持,但有几种情形它不会再报:活失败后 worker 丢了浏览器(bakery 为空,
   * 不会自己重开);卡片连着改几次,备用页被扔了又开、中途开失败。实测完整跑一遍端到端之后,
   * 两台都停在「空闲、不热」,最后一次 hot 在 45 秒前。
   * 每 2 秒看一眼:空闲却不热的那台发一次预热(没浏览器就开一个,有就换页、备好备用页,好了会报 hot)。
   * 同一台 5 秒内不重复催。热着的时候什么都不做,不花钱。
   */
  const keepWarm = setInterval(() => {
    const now = Date.now();
    for (const w of slots) {
      if (w.dead || w.busy || w.hot) continue;
      if (w.warmingAt && now - w.warmingAt < 5000) continue;
      w.warmingAt = now;
      try { w.child.send({ type: "prewarm", url: `${originFn()}/?export=1` }, () => {}); } catch { /* 送不到的下一轮 ensure 会换掉 */ }
    }
  }, 2000);
  keepWarm.unref?.();

  /** 挑一台:热的优先,其次空着的(还在换页 / 刚起的也行,worker 里会等备用页就绪) */
  const freeSlot = () => slots.find((w) => !w.dead && !w.busy && w.hot) ?? slots.find((w) => !w.dead && !w.busy);

  const start = (w: RenderWorker, req: UiRequest) => {
    const ac = new AbortController();
    const startedAt = Date.now();
    // 请求方断开:才开始的就停;做了不少的让它渲完,结果进缓存
    const onOuter = () => { if (Date.now() - startedAt < UI_INTERRUPT_MS) ac.abort(); };
    req.signal?.addEventListener("abort", onOuter, { once: true });
    w.busy = true;
    running.set(w, { ac, startedAt });
    runOnWorker(w, req.job, ac.signal)
      .then(req.resolve, (e: any) => {
        /*
         * 不是被取消、也没被请求方放弃的失败,换一台再试一次。实测连着打断、换页时偶尔会撞上
         * 「Browser target is not found」(这台背后的浏览器没了;worker 已经把它丢掉,巡检几秒内重开)。
         * 用户正盯着这张图,别让这种一次性的失败漏到界面上。只重试一次,第二次还失败就如实报。
         */
        if (!e?.cancelled && !req.retried && !req.signal?.aborted) {
          // 带着 retried 重新交进去:第二次再失败就走下面的 reject,不会一直重试下去
          submit({ ...req, retried: true });
          return;
        }
        req.reject(e);
      })
      .finally(() => {
        running.delete(w);
        req.signal?.removeEventListener("abort", onOuter);
        dispatch();
      });
  };

  const dispatch = () => {
    if (!pending) return;
    ensure();
    const w = freeSlot();
    if (!w) return;
    const req = pending;
    pending = null;
    start(w, req);
  };

  /** 交一个请求进来:有空的就跑,否则按规则 2 / 3 打断或排进待办。重试也走这里(带着 retried) */
  const submit = (req: UiRequest) => {
    ensure();
    if (req.signal?.aborted) return req.reject(cancelError());
    const w = freeSlot();
    if (w) return start(w, req);
    // 规则 2:打断一台才开始的
    for (const [, r] of running) {
      if (Date.now() - r.startedAt < UI_INTERRUPT_MS) { r.ac.abort(); break; }
    }
    // 规则 3:只留最新的一个
    if (pending) pending.reject(Object.assign(new Error("被更新的请求替换了"), { cancelled: true }));
    pending = req;
    req.signal?.addEventListener("abort", () => {
      if (pending !== req) return;
      pending = null;
      req.reject(cancelError());
    }, { once: true });
  };

  const run: Runner = (job, signal) => new Promise((resolve, reject) => submit({ job, signal, resolve, reject }));

  return {
    run,
    prewarm: ensure,
    /** 服务关掉时停掉巡检(vite 在同一个进程里重启时,旧的这一份不该还在往死掉的 worker 发消息) */
    stop: () => clearInterval(keepWarm),
    status: () => ({
      workers: slots.filter((w) => !w.dead).length,
      hot: slots.filter((w) => !w.dead && w.hot && !w.busy).length,
      busy: slots.filter((w) => !w.dead && w.busy).length,
      pending: pending ? 1 : 0,
      // 每台的明细:排查「热」为什么没回来时看它
      detail: slots.map((w) => ({
        pid: w.child.pid, dead: w.dead, hot: w.hot, busy: w.busy, hotPending: !!w.hotPending,
        hotMsgs: w.hotMsgs ?? 0, lastHotAgoMs: w.lastHotAt ? Date.now() - w.lastHotAt : null,
      })),
    }),
  };
}

/** 卡片源码一变,告诉本进程所有渲染 worker 扔掉备用页(里面是旧模块) */
function invalidateWorkers() {
  for (const w of renderWorkers) {
    if (w.dead) continue;
    w.hot = false;
    try { w.child.send({ type: "invalidate" }, () => {}); } catch { /* 送不到的 worker 下一趟本来就会重开 */ }
  }
}

/**
 * 编辑器这一端的 vision 接口。
 *
 * 渲染池、导出、Agent 看图都在预渲染进程里(vite.prerender.config.ts),这里只留:
 *   - /api/ui-render/bake-batch:用户前台烘焙,走上面那对热备渲染器;
 *   - 老地址(/api/vision/*、/api/ai/visual):原样转给预渲染,给还没改成直连的调用方兜底。
 */
function registerEditorSide(server: ViteDevServer, root: string) {
  const ui = createUiRenderer(root, () => originOf(server));
  server.httpServer?.on("close", () => ui.stop());
  server.httpServer?.once("listening", () => {
    // 一开机就把两台热备起好 —— 等用户第一次拖动才开机,他要多等几秒
    setTimeout(() => { try { ui.prewarm(); } catch { /* 起不来就等第一次用的时候再起 */ } }, 1000);
  });

  server.middlewares.use("/api/ui-render/status", (_req, res) => sendJson(res, 200, { ok: true, ...ui.status() }));

  server.middlewares.use("/api/ui-render/bake-batch", (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
    let body = "";
    let over = false;
    req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
    req.on("end", async () => {
      if (over) return;
      try {
        const { project, clips, size, bg } = JSON.parse(body || "{}");
        if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
        if (!Array.isArray(clips) || !clips.length) return sendJson(res, 400, { ok: false, error: "缺少 clips" });
        const resolved = resolveMediaUrls(project).project;
        const signal = abortOnClose(res);
        const byClip = new Map<string, number[]>();
        for (const c of clips) {
          if (!c || typeof c.clipId !== "string") continue;
          const arr = byClip.get(c.clipId);
          if (arr) arr.push(Number(c.t)); else byClip.set(c.clipId, [Number(c.t)]);
        }
        const baked: any[] = [];
        const failed: any[] = [];
        /*
         * **同一个请求里的几张卡按顺序渲**,一张渲完再交下一张。
         *
         * 热备渲染器的打断 / 挤掉规则是给「用户又换了一个时刻」用的:新请求来了,旧请求才开始的那张就不要了。
         * 要是把同一批的几张一起交出去,它们会互相打断、互相挤掉 —— 实测一批 N 张只成两三张,其余回
         * 「被新请求替换」,3D 视图还会弹一句「N 张没烘出来」。一个请求的几张是一体的,不该互相竞争。
         * 顺序渲不慢:热备是为「立刻有人接」,不是为一批里的并行。
         */
        for (const [clipId, ts] of byClip) {
          if (signal.aborted) {
            failed.push({ clipId, error: "请求方已经不要了", cancelled: true });
            continue;
          }
          try {
            baked.push(...await bakeClip(root, originOf(server), resolved, clipId, ts, size, bg, "box", 1, { signal, runner: ui.run }));
          } catch (e: any) {
            failed.push({ clipId, error: e?.message || String(e), cancelled: !!e?.cancelled });
          }
        }
        sendJson(res, 200, { ok: true, baked, failed });
      } catch (e: any) {
        sendJson(res, 500, { ok: false, error: e?.message || String(e) });
      }
    });
  });

  // 老地址兜底:原样转给预渲染(断开会传过去,预渲染按断开摘掉排队的活)
  server.middlewares.use("/api/vision", (req, res) => proxyToPrerender(req, res));
  server.middlewares.use("/api/ai/visual", (req, res) => proxyToPrerender(req, res));
}

export function visionPlugin(): Plugin {
  return {
    name: "promptcut-vision",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      // 卡片源码一变,两端各自的渲染 worker 都要扔掉备用页
      onCardSourceChange(() => invalidateWorkers());
      /*
       * 服务关掉(包括改了配置依赖、vite 在同一个进程里重启)就把这个进程拉起的渲染 worker 全杀掉。
       * 重启会重新加载这个模块,旧模块手里的 worker 就没人管了 —— 常驻的那几个(热备、前台)永不闲置退出,
       * 每重启一次漏两个 Chrome。
       */
      server.httpServer?.on("close", () => {
        for (const w of [...renderWorkers]) killWorker(w, new Error("服务已关闭"));
      });

      if (!isPrerender) {
        registerEditorSide(server, root);
        return;
      }

      // 编辑器那一端靠它判断预渲染起来了没有(vite-plugin-prerender 的就绪检查)
      server.middlewares.use("/api/prerender/health", (_req, res) => sendJson(res, 200, {
        ok: true, role: "prerender", concurrency: maxConcurrentRenders(), running: renderRunning, exporting: exportsRunning(),
      }));

      /*
       * POST /api/vision/sheet { media, start, end, grid } —— see_frames 素材模式(source: "media")用的镜头拼图。
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

      /*
       * /api/ai/visual —— 聊天栏里「看得见的工具结果」(执行这一侧见 src/ai/mcpExecutor.ts 的 withVisual)。
       *
       *   POST /                    { tool, images?, clipId?, before?, after?, render? } → { visualId, … }
       *   GET  /<visualId>.json     这条记录
       *   GET  /file/<name>         存下来的位图(see_frames 当时返回的那几张)
       *   GET  /gif/<key>.gif       一张卡的 8 帧动图
       *
       * 动图**用户点开时才渲**:POST 只存「怎么渲」(那张卡当时的样子,isolateClip 之后的迷你工程),
       * 第一次 GET 才排队渲染、编码、落盘,之后读缓存。渲染走后台优先级(0),不和模型正阻塞等着的
       * see_frames 抢槽位 —— Agent 调工具只多一次本地写文件。get_gif 是模型自己要的,走前台优先级(1)。
       */
      const visualLib = () => import(new URL("./ai-visual.mjs", import.meta.url).href);
      const visualDir = () => path.join(outRoot(root), "ai-visual");
      const gifInflight = new Map<string, Promise<{ gif: string; grid: string; times: number[] }>>();

      async function saveCardSpec(project: any, clipId: string) {
        const visual = await visualLib();
        const iso = isolateClip(resolveMediaUrls(project).project, clipId);
        if (!iso) return null;
        const times = visual.sampleTimes(iso.clip);
        const key = visual.specKey(iso.project, clipId);
        const dir = visualDir();
        await visual.writeJson(dir, visual.gifPaths(dir, key).spec, { project: iso.project, clipId, times });
        return { key, clip: iso.clip, gif: `/api/ai/visual/gif/${key}.gif` };
      }

      function ensureGif(key: string, priority: number) {
        const running = gifInflight.get(key);
        if (running) return running;
        const job = (async () => {
          const visual = await visualLib();
          const dir = visualDir();
          const p = visual.gifPaths(dir, key);
          const spec = await visual.readJson(dir, p.spec);
          if (!spec) throw Object.assign(new Error("找不到这张动图的渲染规格(可能是清理过 out/ai-visual)"), { status: 404 });
          if (fs.existsSync(p.gif) && fs.existsSync(p.grid)) return { gif: p.gif, grid: p.grid, times: spec.times };
          const ffmpeg = ffmpegCommand();
          if (!ffmpeg) throw new Error("这台机器上找不到 ffmpeg,做不了动图");
          const notes: string[] = [];
          const fps = spec.project.fps || 30;
          const maxFrame = Math.max(0, Math.floor((spec.project.duration || 0) * fps) - 1);
          const frameOf = (t: number) => Math.min(maxFrame, Math.max(0, Math.round(t * fps)));
          const frames = await enqueue(() => renderFrames(root, originOf(server), spec.project, spec.times, notes, priority), priority, priority > 0 ? 25000 : 0);
          const bufs = spec.times.map((t: number) => frames.get(frameOf(t))?.buf).filter(Boolean) as Buffer[];
          if (!bufs.length) throw new Error("一帧都没渲出来");
          // 给用户看的动图裁到这张卡出现过的区域(整屏缩到一百来像素宽字就看不清了);交给 Agent 的拼图照旧整屏
          const crop = await visual.contentCrop(bufs).catch(() => null);
          await visual.encodeGif({ ffmpeg, frames: bufs, outGif: p.gif, outGrid: p.grid, crop });
          return { gif: p.gif, grid: p.grid, times: spec.times };
        })().finally(() => gifInflight.delete(key));
        gifInflight.set(key, job);
        return job;
      }

      server.middlewares.use("/api/ai/visual", (req, res) => {
        const url = String(req.url || "/").split("?")[0];
        const fail = (e: any) => sendJson(res, e?.status || 500, { ok: false, error: e?.message || String(e) });

        if (req.method === "GET") {
          (async () => {
            const visual = await visualLib();
            const dir = visualDir();
            let m: RegExpExecArray | null;
            if ((m = /^\/(v-[0-9a-z]{6,40})\.json$/.exec(url))) {
              const rec = await visual.readJson(dir, `${m[1]}.json`);
              return rec ? sendJson(res, 200, { ok: true, record: rec }) : sendJson(res, 404, { ok: false, error: "没有这条可视化记录" });
            }
            if ((m = /^\/file\/([^/]+)$/.exec(url))) {
              const name = visual.safeFileName(m[1]);
              const file = name && path.join(dir, name);
              if (!file || !fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: "没有这个文件" });
              const ext = path.extname(file).slice(1);
              res.setHeader("Content-Type", ext === "jpg" ? "image/jpeg" : `image/${ext}`);
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
              return fs.createReadStream(file).pipe(res);
            }
            if ((m = /^\/gif\/([0-9a-f]{16})\.gif$/.exec(url))) {
              const g = await ensureGif(m[1], 0);
              res.setHeader("Content-Type", "image/gif");
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
              return fs.createReadStream(g.gif).pipe(res);
            }
            sendJson(res, 404, { ok: false, error: "没有这个接口" });
          })().catch(fail);
          return;
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / POST only" });

        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const visual = await visualLib();
            const dir = visualDir();
            const { tool, images, clipId, before, after, render } = JSON.parse(body || "{}");
            const record: any = { tool: String(tool || ""), createdAt: new Date().toISOString() };
            if (Array.isArray(images) && images.length) {
              record.images = [];
              for (const im of images.slice(0, 16)) {
                if (!im?.base64) continue;
                const saved = await visual.saveImage(dir, { mime: im.mime, base64: im.base64 });
                record.images.push({ url: saved.url, label: String(im.label || "") });
              }
            }
            let afterSpec: any = null;
            if (typeof clipId === "string" && clipId) {
              record.clipId = clipId;
              const beforeSpec = before && Array.isArray(before.tracks) ? await saveCardSpec(before, clipId) : null;
              afterSpec = after && Array.isArray(after.tracks) ? await saveCardSpec(after, clipId) : null;
              if (beforeSpec) record.before = { gif: beforeSpec.gif };
              if (afterSpec) record.after = { gif: afterSpec.gif };
              if (beforeSpec && afterSpec) record.diff = visual.diffClips(beforeSpec.clip, afterSpec.clip);
            }
            const visualId = visual.newVisualId();
            await visual.writeJson(dir, `${visualId}.json`, record);

            if (render) {
              if (!afterSpec) return sendJson(res, 404, { ok: false, error: `时间轴上没有 id 为 ${clipId} 的片段。` });
              const g = await ensureGif(afterSpec.key, 1);
              const grid = (await fsp.readFile(g.grid)).toString("base64");
              return sendJson(res, 200, { ok: true, visualId, gifUrl: afterSpec.gif, times: g.times, grid });
            }
            sendJson(res, 200, { ok: true, visualId });
          } catch (e: any) {
            fail(e);
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
            const { project, t, clipId, times } = JSON.parse(body || "{}");
            // 调用方断开(Agent 那边放弃等待、页面掐了请求)就不渲了:排队的摘掉,在跑的叫停
            const signal = abortOnClose(res);
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
            /*
             * times:一次看多个时刻,**合成一趟渲**(renderFrames:从第 0 帧顺推,沿途截这几帧)。
             *
             * 以前前端逐个时刻调本接口,每张都从第 0 帧重推 —— 看 8 个时刻就推 8 遍。
             * 推进才是大头:一帧约 20ms,第 19 秒就是 570 帧;而准备一趟(常驻 worker 里换页)只要约 0.3 秒。
             * 一趟推到最晚那个时刻,成本从「各时刻帧数之和」降到「最大帧数」。
             * 截出来的画面和逐张渲逐字节相同:单张走的 frames `F-F` 同样是从第 0 帧推到 F。
             */
            const list = Array.isArray(times) ? times.map(Number).filter(Number.isFinite).slice(0, 10) : [];
            if (list.length) {
              const maxFrame = Math.round(lastT * fpsOf);
              const clamped = list.map((x) => Math.min(Math.max(0, x), lastT));
              if (clamped.some((x, i) => x !== list[i])) {
                notes.push(`有的时刻超出了片子的长度(${target.duration} 秒),按最后一帧 ${lastT.toFixed(2)} 秒渲。`);
              }
              // 缩图在渲染 worker 里做(post.shrink),这里拿到的就是给模型看的那张,只做 base64
              const shots = await enqueue(
                () => renderFrames(root, originOf(server), target, clamped, notes, 1, { signal, post: { shrink: true } }),
                1, 25000, signal,
              );
              const frames: any[] = [];
              const images: any[] = [];
              clamped.forEach((x, i) => {
                const r = shots.get(Math.min(maxFrame, Math.max(0, Math.round(x * fpsOf))));
                if (!r) return;
                frames.push({ t: x, clipId: clipId || null, width: r.width, height: r.height });
                images.push({ mime: "image/png", base64: r.buf.toString("base64"), label: `t=${list[i]}s` });
              });
              return sendJson(res, 200, {
                ok: true,
                frames,
                // 素材层按帧各抽各的,取不到文件时每一帧都会记一条同样的话 —— 去重
                note: [`${images.length} 张画面按 times 的顺序排列,每张标着时刻。`, ...new Set(notes)].join(" "),
                __images: images,
              });
            }
            /*
             * **前台优先级(1),不是默认的 0。**
             *
             * see_frames 是模型正阻塞着等的那一张 —— 前台里最前台的。可它原来用默认
             * priority,于是掉进 pumpRenderQueue 给后台留的那道限制里:后台只能用到
             * `max - 1` 个槽位,而且要和空闲预烘按先来后到排。也就是说,那个「永远给
             * 前台留一个槽位」的设计恰好把真正的前台挡在了外面。
             *
             * 排队看门狗给 25 秒:加上渲染自己的 120 秒上限,合起来 145 秒,刚好落在
             * see_frames 那 150 秒工具上限之内 —— 保证超时之前一定能给出一句
             * **说得清原因**的话,而不是让上层回一句无从下手的「没有返回」。
             */
            const shot = await enqueue(
              () => renderOneFrame(root, originOf(server), target, at, notes, 1, { signal, post: { shrink: true } }),
              1, 25000, signal,
            );
            const { width, height } = shot;
            const base64 = shot.buf.toString("base64");

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
            // 预烘那边一换计划就会掐掉在飞的批次:断开之后这一批还没开渲的全部摘掉,别占着 Chrome
            const signal = abortOnClose(res);
            /*
             * **先按卡分组。** 同一张卡的几个时刻合成一趟渲(见 bakeClip):导出脚本从第 0 帧顺推,
             * 「烘第 F 帧」已经把 0..F 推了一遍,同一张卡里其余 ≤F 的时刻是顺路白捡的。
             * 实测同一张卡 7 个时刻:分趟 31.0s → 一趟 2.7s,而且逐字节相同。
             *
             * 分组**不改批次的先后**:调用方按离播放头的距离排好序发过来,这里用 Map 保持首次出现的
             * 顺序,所以最近的那张卡仍然第一个开渲 —— 「先烘播放头附近」这条没有被牺牲。
             */
            const byClip = new Map<string, number[]>();
            for (const c of clips) {
              if (!c || typeof c.clipId !== "string") continue;
              const arr = byClip.get(c.clipId);
              if (arr) arr.push(Number(c.t)); else byClip.set(c.clipId, [Number(c.t)]);
            }
            /*
             * **一次全放进去,让渲染池去并行**,不要在这儿一张张 await。
             * 一张失败不拖垮整批,所以用 allSettled —— 3D 视图那边拿到几张就先贴几张。
             */
            const settled = await Promise.allSettled(
              [...byClip].map(([clipId, ts]) => bakeClip(root, originOf(server), resolved, clipId, ts, size, bg, "box", pri, { signal })
                .then((r) => r, (e) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { clipId }); })),
            );
            for (const s of settled) {
              if (s.status === "fulfilled") baked.push(...s.value);
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
            /*
             * concurrency:池子多大,预烘按它决定一次发几张才喂得满。
             * running:此刻真有几个渲染在跑。后台最多用到 concurrency-1(留一个给前台),
             *   所以这两个数是「槽位有没有留住」唯一可信的观测口。
             *
             * 别拿 out/export-vision-* 的目录数去数并发:那些目录是 fire-and-forget 删的
             * (见 renderOneFrame 的 finally),跑完还没删掉的会和在跑的叠在一起 ——
             * 实测 7 个槽位数出来 10 个,那是量具错了,不是并发超了。
             */
            sendJson(res, 200, {
              ok: true, items, orphans, totalBytes, fileCount: onDisk.size,
              concurrency: maxConcurrentRenders(), running: renderRunning,
              // 常驻 worker 有几个活着。冷的时候是 0,烘过之后应该稳定在并发用到的那个数上;
              // 要是它一直等于 running 又不停变,说明 worker 在被反复杀掉重开(见 killWorker)
              workers: renderWorkers.length,
              // 前台专属的那个热 Chrome 在不在。它应该长期是 1 —— 掉到 0 就说明常驻没留住
              reservedWorkers: renderWorkers.filter((w) => w.reserved && !w.dead).length,
            });
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
            // 和 /snapshot 同理:bake_card 是模型正阻塞着等的一次调用,在预渲染池里排最前(priority 1),
            // 不该排在空闲预烘后面。fit 保持默认的 square —— 贴图要正方形
            const signal = abortOnClose(res);
            const out = await bakeOne(root, originOf(server), resolveMediaUrls(project).project, clipId, Number(t), size, bg, "square", 1, undefined, { signal });
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
