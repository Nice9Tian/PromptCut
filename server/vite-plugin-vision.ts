import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { cardsOnly, composeFrame, extractArgs, mediaLayersAt } from "./vision-compose.mjs";
import { mediaDir } from "./vite-plugin-media";

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

/** 素材文件在磁盘上的位置:导入时记的 path 优先,没有就按文件名去媒体目录找 */
function mediaFileOf(root: string, m: any): string | null {
  const direct = m?.path ? String(m.path) : "";
  if (direct && fs.existsSync(direct)) return direct;
  const base = String(m?.url || m?.path || "").split(/[/\\]/).pop() || "";
  if (!base) return null;
  const local = path.join(mediaDir(root), decodeURIComponent(base));
  return fs.existsSync(local) ? local : null;
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

      server.middlewares.use("/api/vision/snapshot", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 64 * 1024 * 1024) req.destroy(); });
        req.on("end", async () => {
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
    },
  };
}

export default visionPlugin;
