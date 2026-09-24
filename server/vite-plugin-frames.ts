import type { Plugin } from "vite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { captureCode, frameCode, invalidateFrameCode } from "./frame-code.mjs";
import { FramePipeline } from "./frame-pipeline.mjs";
import { unpackFrameArchive } from "./frame-archive.mjs";
import { overLimit } from "./http-guard.mjs";
import { prerenderState, proxyToPrerender } from "./prerender-client.mjs";
import { isPrerender } from "./render-role.mjs";
import { ensureMirror } from "./vite-plugin-mirror";

import { latestPlayhead, ensureMirror as ensureMirrorVersion, reportReadySession } from "./vite-plugin-mirror";
import { snapshotTier } from "./snapshot-store.mjs";
import { readySessionOf } from "./ready-index.mjs";
import { mediaSourceOf } from "./vision/ffmpeg-frames";

const services = new Map<string, FramePipeline>();
function requestSignal(req: any, res: any) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.("aborted", abort);
  res.once?.("close", () => { if (!res.writableEnded) abort(); });
  return controller.signal;
}
export function frameService(root: string, origin: string) {
  root = path.resolve(root);
  let service = services.get(root);
  if (!service) {
    service = new FramePipeline({ root: path.join(process.env.PROMPTCUT_EXPORT_DIR || path.join(root, "out"), "frame-library"), origin: () => origin,
      code: () => frameCode(root), captureCode: () => captureCode(root),
      // 成本记录和可调系数跟 vite-plugin-costs 同一个根(帧库目录不是它们的家)
      dataRoot: root,
      /*
       * D5 的 `interactive`(R7 的原子切换把编辑器进程这一侧翻了过来)。
       *
       * **预渲染进程 `true`**:热池在它这里,改叫 `streamPool`,给 G 的分段和 C2 锚帧用;
       * `?preview=legacy` 的服务端旧调度器(`acquireUser` / `updatePlayback`)也留在它这里 ——
       * legacy 页面照今天的方式发 `user` / `playback` lane,只是打到预渲染的源上
       * (`frameClient` 的缺省 `target` 已经是 `"prerender"`),服务端不另读开关。
       *
       * **编辑器进程 `false`**:不再养那对无头 Chrome。`user` / `playback` 两条 lane
       * 立即回 `USE_PRERENDER`、不进 `acquireUser`,两处 `prewarmUser` 都不调。
       * 页面侧的热渲染是可见舞台 iframe,和 Node 侧的热池不是一回事(总规则倒数第二条)。
       */
      interactive: isPrerender,
      /** C4:`wanted` 从镜像插件读(frame-pipeline 是 .mjs,镜像插件是 .ts) */
      playhead: () => latestPlayhead(),
      /** 没有内容哈希的素材打戳时向素材服务发 HEAD 的地址(基址按 asset-client.ts 定,不读素材目录) */
      mediaUrl: (m: any) => mediaSourceOf(m),
    });
    services.set(root, service);
    /*
     * R8:轨道流分段的读口挂在下面的 `/api/frames/*` 上 —— 生产者要读口接上了才开工、才发 `stream` 层
     * (`StreamProducer.routeAttached`)。编辑器进程(`interactive: false`)没有生产者,这里是空操作。
     */
    service.streamProducer()?.attachRoute();
    /*
     * F5:预渲染进程起来先扫盘重建「键 → 区间」。只挂在键上,不发 `layer` ——
     * `clipId` 要等项目到位、重算 card plan 之后才反查得出来(`adoptCardPlan`)。
     */
    void service.rescanSnapshots().catch(() => {});
  }
  return service;
}
export function renderProject(project: any) {
  return { ...project, media: (project.media || []).map((m: any) => {
    // .proc files from older versions may contain a bare filename (and some
    // callers still send blob URLs).  The renderer cannot resolve either
    // form; the durable server path is the source of truth for both.
    // A legacy .proc may say /@media/<name> while the actual file lives in
    // the shared Videos/PromptCut/media folder.  Resolve through the guarded
    // media endpoint so the export/Agent page sees the same file as the editor.
    //
    // A1: a hash IS the asset's identity.  Media that carries one is served by
    // /@media/<hash> (vite-plugin-media resolves it in the local content store,
    // with the right Content-Type and Range support), so leave that address
    // alone — rewriting it by path would pin the renderer to one machine's
    // file layout and, from step 5 on, defeat tier switching.  Only migration
    // era media (no hash) is still rewritten by its durable path.  A hashed
    // asset that somehow still carries a page-private address (blob: / data:,
    // or nothing at all) gets the hash address instead — same rule as
    // vite-plugin-vision.ts's resolveMediaUrls, so both paths agree.
    if (m.hash) {
      const u = String(m.url || "");
      return !u || u.startsWith("blob:") || u.startsWith("data:") ? { ...m, url: `/@media/${m.hash}` } : m;
    }
    if (m.path && (!m.url || m.url.startsWith("blob:") || !m.url.startsWith("/@export/"))) {
      return { ...m, url: "/api/media/file?path=" + encodeURIComponent(String(m.path)) };
    }
    return m;
  }) };
}
export function framesPlugin(): Plugin {
  return { name: "promptcut-frames", configureServer(server) {
    const root = path.resolve(server.config.root);
    let remoteLease: { owner: string; url: string; at: number; ready: boolean } | null = null;
    const borrow = async (owner: string) => {
      const remote = prerenderState();
      if (isPrerender || !remote.ready || !remote.url) return false;
      if (remoteLease?.owner === owner && remoteLease.url === remote.url && Date.now() - remoteLease.at < 1000) return remoteLease.ready;
      try {
        const response = await fetch(remote.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, ttl: 5000 }), signal: AbortSignal.timeout(2000) });
        const result = await response.json();
        remoteLease = { owner, url: remote.url, at: Date.now(), ready: response.ok && result.yielded === true };
      } catch { remoteLease = { owner, url: remote.url, at: Date.now(), ready: false }; }
      return remoteLease.ready;
    };
    const release = async (owner: string) => {
      if (remoteLease?.owner !== owner) return;
      const lease = remoteLease; remoteLease = null;
      await fetch(lease.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, ttl: 0 }), signal: AbortSignal.timeout(1500) }).catch(() => {});
    };
    server.watcher.on("change", file => { if (/^(src|scripts)\//.test(path.relative(root, file).replaceAll("\\", "/"))) invalidateFrameCode(root); });
    server.httpServer?.once("close", () => { const s = services.get(root); services.delete(root); void s?.close(); });
    /*
     * D4(b) `/api/cards/layout`:Agent 的 `get_layout` —— 按 t 在**整场景**上实测实体框
     * (pinned 架构 4:Agent 的 query 跑预渲染进程;用户交互的 query 走自己的离屏舞台,不走这里)。
     * body `{ session, localRev, t, clipIds? }`,项目来路和 `/preload` / `/playback` / `/see`
     * 同一套(A7 的镜像前奏,迁移期仍收 `project`)。
     *
     * **只在预渲染进程里答**(T1a 审查 #14;cloud-task.md I4(c):`/api/cards/layout` 只服务 Agent 的
     * `get_layout`,走 `'agent'` 角色)。编辑器进程收到就原样转给预渲染进程,转不过去回
     * `503 NO_AGENT_LANE` —— 以前这里直接调本进程的 `FramePipeline.layout`,会在编辑器这一侧开查询 Chrome。
     * 预渲染进程里经 `runAgentTask` 借 agent lane 的 bakery,和 `see_frames` 的 agent 批排同一条队。
     */
    server.middlewares.use("/api/cards/layout", (req, res, next) => {
      if (req.method !== "POST") return next();
      if (!isPrerender) return proxyToPrerender(req, res, { unavailable: { status: 503, code: "NO_AGENT_LANE",
        error: "编辑器进程没有 Agent lane,/api/cards/layout 只在预渲染进程里答,而预渲染进程现在够不着" } });
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Layout request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body || "{}");
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `镜像里没有这一版项目(session=${input.session}, localRev=${input.localRev})，请整份重推后重试。`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          if (input.t !== undefined && !Number.isFinite(input.t)) throw new Error("t 要是秒数");
          if (input.clipIds !== undefined && input.clipIds !== null && (!Array.isArray(input.clipIds) || input.clipIds.some((id: unknown) => typeof id !== "string")))
            throw new Error("clipIds 要是字符串数组");
          const service = frameService(root, origin);
          return json(200, await service.layout(project, { t: Number(input.t) || 0, clipIds: input.clipIds ?? null, signal: requestSignal(req, res) }));
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          json(status, { ok: false, code: timedOut ? "FRAME_TIMEOUT" : cancelled ? "FRAME_CANCELLED" : (error?.code || "LAYOUT_ERROR"),
            retryable: timedOut || status >= 500, error: error?.message || "实体框测量失败" });
        }
      });
    });
    server.middlewares.use("/api/frames", (req, res, next) => {
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const service = frameService(root, origin);
      const url = new URL(req.url || "/", origin);
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      /*
       * C3 就绪索引的 SSE。**页面直连预渲染进程**(和 J3 的快照字节同源,同走
       * `PROMPTCUT_CORS_ORIGINS`);编辑器进程不代理 —— D5 的 `/api/frames/*`
       * 保留清单里没有它,这里的中间件对不认识的路径一律 `next()`。
       *
       * 连上先灌 `reset` + 每层一条全量 `layer`(已经 done 的再补一条 `done`),
       * 之后增量。断线由页面按 1s / 2s / 4s / 8s 退避重连同一条 SSE(J3),
       * 重连就是再走一次这里 —— 和 F5 共用一条恢复路径,没有轮询端点。
       */
      if (req.method === "GET" && url.pathname === "/ready") {
        // Item 4:按 `session` 分片订阅,只收自己这个页面会话的层(不带 session 的是缺省会话)
        const session = readySessionOf(url.searchParams.get("session") ?? undefined);
        if (session === null) return json(400, { error: "session 参数不合法" });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        // 反向代理和 vite 的 compression 都可能攒着不发,SSE 攒一下就等于断线
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        const send = (message: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`); };
        const off = service.ready.subscribe(session, send);
        // 空闲连接被中间的代理掐掉之前先说句话(注释行不是事件,页面收不到)
        const beat = setInterval(() => { if (!res.writableEnded) res.write(": beat\n\n"); }, 15000);
        beat.unref?.();
        const stop = () => { clearInterval(beat); off(); };
        req.on("close", stop);
        res.on("close", stop);
        return;
      }
      /*
       * 诊断读口:A3c 的超限帧(卡 id、字节数)和 C4 的批次插队。预渲染进程的
       * stdout 被编辑器进程收走了,端到端探针只能从这里看这两件事。
       */
      if (req.method === "GET" && url.pathname === "/diagnostics") {
        return json(200, { ok: true, ...service.diagnostics() });
      }
      if (req.method === "GET") {
        /*
         * R8 轨道流的字节(清单 / init / 分段),和快照字节同源、同走 `PROMPTCUT_CORS_ORIGINS`。
         * 只有预渲染进程(`interactive: true`)有生产者;编辑器进程这里是 null,不答。
         */
        const producer = service.streamProducer();
        if (producer && producer.handle(req, res, url.pathname)) return;
        /*
         * J3 / C3 的快照字节:`GET /api/frames/snapshot/<kind>/<key>/<localFrame>`。
         * `kind` 为 `local` 时 `key` = `<entry.key>/<共享键>`,所以有两个键段。
         * 键是内容寻址的,所以可以 immutable 缓存一年。
         */
        const snapshot = /^\/snapshot\/(html|local)\/([a-f0-9]{64})(?:\/([a-f0-9]{64}))?\/(\d{1,8})$/.exec(url.pathname);
        if (snapshot) {
          const local = snapshot[1] === "local";
          if (local && !snapshot[3]) return json(404, { error: "本地档的键是 <entry.key>/<共享键>" });
          void service.snapshots().readSnapshot({
            tier: local ? "local" : "shared",
            entryKey: local ? snapshot[2] : undefined,
            key: local ? snapshot[3] : snapshot[2],
            localFrame: Number(snapshot[4]),
          }).then((html: string | null) => {
            if (html === null) return json(404, { error: "Snapshot is not ready" });
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.end(html);
          }, () => json(404, { error: "Snapshot is not ready" }));
          return;
        }
        const control = /^\/control\/([a-f0-9]{64})\/(\d{1,8})$/.exec(url.pathname);
        if (control) {
          void fsp.readFile(path.join(service.root, 'controls', control[1], 'mov', 'frames', control[2].padStart(6, '0') + '.png')).then(buf => {
            res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'private,max-age=31536000,immutable'); res.end(buf);
          }, () => json(404, { error: 'Control frame is not ready' })); return;
        }
        // The final cumulative render is used by the editor, while the
        // cumulative track renders are useful to callers that want to rebuild
        // only the edited upper part.  Keep both forms behind fixed-length
        // hexadecimal keys; no user supplied path segment reaches the disk.
        const final = /^\/([a-f0-9]{64})\/(preview\.mp4|mov\/full\.mov|mov\/playback-[a-f0-9-]{36}\.mov|mov\/frames\/\d{6}\.png|frames\/\d{6}\.png|preview-frames\/\d{6}\.png)$/.exec(url.pathname);
        const track = /^\/([a-f0-9]{64})\/tracks\/([a-f0-9]{64})\/(preview\.mp4|frames\/\d{6}\.png)$/.exec(url.pathname);
        if (!final && !track) return next();
        const file = final
          ? path.join(service.root, final[1], final[2])
          : path.join(service.root, track![1], "tracks", track![2], track![3]);
        void fsp.stat(file).then(stat => {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(stat.size - 1, Number(range[2])) : stat.size - 1;
          if (start > end || start >= stat.size) { res.statusCode = 416; return res.end(); }
          res.statusCode = range ? 206 : 200;
          res.setHeader("Content-Type", file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".mov") ? "video/quicktime" : "image/png");
          if (file.includes("playback-")) res.setHeader("Cache-Control", "no-store");
          res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Length", end - start + 1);
          if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
        }, () => json(404, { error: "Frame is not ready" }));
        return;
      }
      /*
       * K1:**探针推过的帧直接存成死素材**。后台舞台第一趟(全局时钟逐帧推)每生成
       * 一帧快照就把 `{ session, localRev, clipId, localFrame, html }` 报上来,经编辑器
       * 进程转到这里。`kind` / `key` 由**预渲染进程**按镜像里的项目用 A3a 的规则算
       * (共享键要 `card-identity.mjs` 的 `digest`,本地模式里页面不算它)。
       *
       * **只存审阅表 `independent` 的卡**(pinned 渲染 5 末句):`sourceDependent`
       * (链上的源在缩水项目里没有)和 `belowDependent` / `unknown`(没有下层背景)
       * 在缩水项目里都拿不到输入,存下去等于把错画面当死素材发出去;它们的本地档
       * 仍由 C2 的整场景路产。
       *
       * 写进同一棵目录、进 C3 的索引,预渲染不再重新预渲染这些帧。
       */
      if (req.method === "PUT" && url.pathname === "/snapshot") {
        let probeBody = "", probeOver = false;
        req.on("data", chunk => { if (!probeOver) { probeBody += chunk; probeOver = overLimit(req, res, probeBody.length, 32 * 1024 * 1024, "Probe snapshot too large"); } });
        req.on("end", async () => {
          if (probeOver) return;
          try {
            const input = JSON.parse(probeBody || "{}");
            if (!isPrerender) {
              // 编辑器进程只转发,不存 —— 快照库在预渲染进程那一侧
              const remote = prerenderState();
              if (!remote.ready || !remote.url) return json(503, { ok: false, code: "PRERENDER_UNAVAILABLE", error: "预渲染进程还没就绪" });
              const forwarded = await fetch(remote.url + "/api/frames/snapshot", { method: "PUT", headers: { "Content-Type": "application/json" },
                body: probeBody, signal: AbortSignal.timeout(10000) });
              return json(forwarded.status, await forwarded.json().catch(() => ({ ok: forwarded.ok })));
            }
            const clipId = String(input.clipId || "");
            const localFrame = Number(input.localFrame);
            const html = typeof input.html === "string" ? input.html : null;
            if (!clipId || !Number.isInteger(localFrame) || localFrame < 0 || html === null) throw new Error("探针帧要带 clipId / localFrame / html");
            const version = await ensureMirrorVersion(String(input.session || ""), input.localRev);
            if (!version) return json(409, { ok: false, code: "MIRROR_MISSING", retryable: true, error: "镜像里没有这一版项目" });
            const entry = await service.entry(renderProject(version.project));
            // 键从 card plan 反查(`control.clipId` ↔ `control.snapshotKey`)。plan 要
            // 浏览器才算得出来,还没算过就先不存 —— 下一次预渲染自己会产这一帧。
            const control = (entry.cardPlan || []).find((item: any) => item.clipId === clipId);
            if (!control?.snapshotKey) return json(202, { ok: false, code: "PLAN_PENDING", stored: false, error: "card plan 还没算出来" });
            const compositing = control.capabilities?.compositing;
            const tier = snapshotTier(control.capabilities);
            if (compositing !== "independent" || tier !== "shared") return json(200, { ok: true, stored: false, reason: "NOT_INDEPENDENT" });
            // M4(契约 E.6):测量帧产自用户的浏览器,和预渲染进程的 Chrome 不是同一种环境。共享键
            // 已乘上预渲染 Chrome 的环境指纹,把别的环境的帧写进这个键,等于在同一层里混环境拼帧
            // (「不同环境的结果不混用」)。所以请求体必须带着与这张卡的指纹相同的 `envFingerprint`
            // 才存;不带或不等回 200 `ENV_MISMATCH`,不写盘、不发层 —— 这些帧由预渲染进程自己补渲。
            // 页面(`probeRunner.ts`)只在意 404,回 200 不影响它。
            if (typeof input.envFingerprint !== "string" || input.envFingerprint !== control.envFingerprint)
              return json(200, { ok: true, stored: false, reason: "ENV_MISMATCH" });
            // #9:写帧、判体积、并 index 一步做。A3c:超限的探针帧同样不进就绪索引(记进 `oversize`,R6-14)
            const index = await service.snapshots().commitSnapshots({ tier: "shared", key: control.snapshotKey, clipId,
              capabilities: control.capabilities, items: [{ localFrame, html }] });
            if (!index.written.length) return json(200, { ok: true, stored: true, indexed: false, reason: "OVER_LIMIT" });
            // 同样过 Item 4 的闸:只进当前版本正是这个 entry 的会话
            service.publishLayer(entry, control, tier, index.frames);
            return json(200, { ok: true, stored: true, indexed: true, count: index.count });
          } catch (error: any) {
            json(400, { ok: false, code: "PROBE_SNAPSHOT_ERROR", error: error?.message || "探针帧没存下" });
          }
        });
        return;
      }
      if (req.method !== "POST") return next();
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Frame request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body);
          // Item 4:preload 一进门就替它的会话领号(在等镜像之前),乱序完成时按到达顺序定谁赢
          let preloadSession: string | null = null, preloadTicket: number | undefined;
          if (url.pathname === "/preload") {
            preloadSession = readySessionOf(input.session);
            if (preloadSession === null) throw new Error("session 参数不合法");
            preloadTicket = service.ready.request(preloadSession);
          }
          if (url.pathname === "/yield") {
            if (typeof input.owner !== "string" || input.owner.length > 100) throw new Error("Invalid playback owner");
            if (input.ttl === 0) await service.resumeBackground(input.owner);
            else await service.yieldBackground(input.owner, 5000);
            return json(200, { yielded: input.ttl !== 0 });
          }
          /*
           * 项目从哪儿来(A7)。body 里带 `project` 的是迁移期的调用方(脚本、只读观看页、
           * 舞台页、导出页)—— 照旧用它。编辑页只带 `{session, localRev}`:按这个键从
           * **本进程**的镜像插件取,本进程没有就按 PROMPTCUT_EDITOR_URL 回拉一次。
           * 还是取不到就回 409 MIRROR_MISSING,页面整份重推之后重试。
           */
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `镜像里没有这一版项目(session=${input.session}, localRev=${input.localRev})，请整份重推后重试。`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          const entry = await service.entry(project);
          if (url.pathname === "/playback") {
            if (typeof input.owner !== "string" || input.owner.length > 100 || !Number.isSafeInteger(input.sequence)
              || !Number.isFinite(input.t) || typeof input.playing !== "boolean" || (input.rate !== undefined && (!Number.isFinite(input.rate) || input.rate <= 0 || input.rate > 8))
              || (input.deliveryMs !== undefined && (!Number.isFinite(input.deliveryMs) || input.deliveryMs < 0 || input.deliveryMs > 5000))) throw new Error("Invalid playback clock");
            return json(200, await service.updatePlayback(project, input, { borrow, release }));
          }
          if (url.pathname === "/see") {
            const lane = input.lane === "agent" ? "agent" : input.lane === "background" ? "background" : "user";
            const frames = await service.see_frames(project, input.times || [0], { lane, signal: requestSignal(req, res) });
            const movReady = await fsp.access(path.join(entry.dir, "mov", "full.mov")).then(() => true, () => false);
            return json(200, { key: entry.key, incomplete: [...frames.values()].some((value: any) => value.incomplete),
              frames: [...frames].map(([frame, value]: any) => ({ frame, source: value.source, incomplete: !!value.incomplete, missing: value.missing || [],
                url: `/api/frames/${entry.key}/${value.incomplete ? 'preview-frames' : value.source === "mov" ? "mov/frames" : "frames"}/${String(frame).padStart(6, "0")}.png` })), mov: movReady ? `/api/frames/${entry.key}/mov/full.mov` : null });
          }
          // 会话「当前版本」的唯一来源(Item 4):页面的 preload 带着它的 `{ session, localRev }`
          if (url.pathname === "/preload") {
            await service.preload(project, { session: preloadSession!, localRev: input.localRev, ticket: preloadTicket });
            // 报给编辑器进程登记(方案 A):这个进程崩溃重启后,由编辑器照表重放 preload。
            // 只报这个会话此刻真正认下的版本 —— 被更新的 preload 取代了的请求不报
            if (preloadSession && service.ready.current(preloadSession) === entry.key) reportReadySession(preloadSession, input.localRev);
          }
          else if (url.pathname === "/import" && typeof input.snapshots === "string") {
            try {
              // Restore the control index together with the HTML.  It is built from
              // the same snapshots and lets callers address a component at its
              // local frame without sampling the whole project again.
              const archive = unpackFrameArchive(input.snapshots, entry.key, { spillDir: path.join(entry.dir, "html-cache") });
              entry.html = archive.frames;
              entry.controls = archive.controls;
              entry.createControl = archive.createControl;
              entry.disposeArchive?.(); entry.disposeArchive = archive.dispose;
              entry.recordVersion = (entry.recordVersion || 0) + 1;
              await service.save(entry);
            }
            catch { return json(200, { discarded: true }); }
          } else if (url.pathname === "/archive") {
            const snapshots = await service.portableArchive(entry);
            return json(200, { key: entry.key, snapshots, localOnly: snapshots === null });
          } else if (url.pathname !== "/status") return json(404, { error: "Unknown frame operation" });
          await entry.mov?.ready;
          const videoReady = await fsp.access(path.join(entry.dir, "preview.mp4")).then(() => true, () => false);
          const movReady = await fsp.access(path.join(entry.dir, "mov", "full.mov")).then(() => true, () => false);
          return json(200, { key: entry.key, status: entry.status, sampled: entry.html.size, movSampled: entry.mov ? [...(entry.mov.frames || [])].length : 0, total: Math.max(1, Math.floor(project.duration * (project.fps || 30))), error: entry.error,
            video: videoReady ? `/api/frames/${entry.key}/preview.mp4` : null,
            mov: movReady ? `/api/frames/${entry.key}/mov/full.mov` : null });
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          const code = timedOut ? "FRAME_TIMEOUT" : error?.superseded ? "FRAME_SUPERSEDED" : cancelled ? "FRAME_CANCELLED" : (error?.code || "FRAME_ERROR");
          if (status >= 500) console.error(`[frames] ${code}:`, error?.stack || error?.message || error);
          json(status, {
            ok: false,
            code,
            retryable: timedOut || status >= 500,
            error: error?.message || "帧渲染失败",
          });
        }
      });
    });
  } };
}
