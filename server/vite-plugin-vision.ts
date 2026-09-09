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
/** 渲染出来的帧是透明底(导出要叠底用),合成到这个颜色上再给模型看 */
const MATTE: [number, number, number] = [0x11, 0x13, 0x18];
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
 * 渲染排队,一次只放一个进去。
 *
 * 每次渲染都要起一个 Chrome。分工模式下多个角色是并行跑的,它们同时看画面就会同时
 * 起好几个 Chrome —— 这台机器上已经吃过这个亏:导出时并发的浏览器实例一多,渲染进程
 * 直接以 0xC0000142(DLL 初始化失败)退出,而且报不出任何有用的信息。排队慢一点,
 * 但看图本来就不是热路径,一次拿不到画面比等几秒糟得多。
 */
let renderQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  // 前一个失败也要继续排下一个,所以先 catch 掉再接
  const next = renderQueue.then(job, job);
  renderQueue = next.catch(() => {});
  return next;
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
      // 合成到不透明底色上:out = 前景(已预乘) + 底色 × (1 - 覆盖率)
      out.data[o] = Math.round(r / n + MATTE[0] * (1 - cover));
      out.data[o + 1] = Math.round(g / n + MATTE[1] * (1 - cover));
      out.data[o + 2] = Math.round(b / n + MATTE[2] * (1 - cover));
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
): Promise<any> {
  const iso = isolateClip(project, clipId);
  if (!iso) throw new Error(`时间轴上没有 id 为 ${clipId} 的片段。`);
  if (iso.clip.mediaId) throw new Error("这是素材段(视频 / 图片),本来就是位图,直接把它的 URL 当纹理用即可,不用烘。");

  // 画布改成正方形:纹理贴到立体表面上,原始 16:9 会被拉变形。
  // 卡片按新画幅重新排版(它们本来就是响应式的),所以这不是裁切,是重排。
  const px = Math.min(2048, Math.max(256, Math.round(Number(size) || 1024)));
  // 没给时间就取这一段的中点 —— 起止两端常卡在进场 / 退场动画上,烘出来是个半透明中间态
  const at = Number.isFinite(t) ? t : (iso.clip.start + iso.clip.end) / 2;
  const rgb = typeof bg === "string" ? /^#?([0-9a-f]{6})$/i.exec(bg.trim()) : null;

  const key = createHash("sha1")
    .update(JSON.stringify({ clip: iso.clip, theme: project.themeId, at, px, bg: rgb ? rgb[1].toLowerCase() : null }))
    .digest("hex").slice(0, 12);
  const name = `bake-${clipId.replace(/[^w.-]/g, "_")}-${key}.png`;
  const dir = mediaDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const url = `/@media/${encodeURIComponent(name)}`;

  const hint = rgb
    ? "不透明贴图:贴上去是「实心物体表面印着这张卡」。把 url 填进 scene-3d 的 texture 参数。"
    : "透明底贴图:贴上去物体在卡片没画的地方也是透空的,内容像浮在空间里(适合标志 / 招牌)。想要「实心立方体表面印着这张卡」就重烘一次并传 bg(比如 bg:\"#0b0f17\")。";
  const note = "这是一张**快照**:卡片的动画定格在 t 这一帧,之后改卡片参数贴图不会跟着变,要重新烘。";

  // 缓存命中:同样的输入烘过了,直接给 URL
  try {
    const st = await fsp.stat(file);
    return { clipId, url, t: at, width: px, height: px, bytes: st.size, cached: true, hint, note };
  } catch { /* 没烘过,往下渲 */ }

  let raw = await enqueue(() => renderOneFrame(root, origin, { ...iso.project, width: px, height: px }, at, []));

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
  await fsp.writeFile(file, raw);
  return {
    clipId, url, t: at, width: png.width, height: png.height, bytes: raw.length, cached: false,
    transparentRatio: Math.round((clear / (png.width * png.height)) * 1000) / 1000,
    hint, note,
  };
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
            const { project, clips, size, bg } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
            if (!Array.isArray(clips) || !clips.length) return sendJson(res, 400, { ok: false, error: "缺少 clips" });
            const resolved = resolveMediaUrls(project).project;
            const baked: any[] = [];
            const failed: any[] = [];
            for (const c of clips) {
              if (!c || typeof c.clipId !== "string") continue;
              try {
                baked.push(await bakeOne(root, originOf(server), resolved, c.clipId, Number(c.t), size, bg));
              } catch (e: any) {
                // 一张失败不拖垮整批 —— 3D 视图那边继续给它显示代理色块
                failed.push({ clipId: c.clipId, error: e?.message || String(e) });
              }
            }
            sendJson(res, 200, { ok: true, baked, failed });
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
