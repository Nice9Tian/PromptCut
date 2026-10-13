// 合并流评估 · 第 4 问的页面一侧（merged-stream-play.mjs 把它连同 stream-demux-browser.js 一起发给无头浏览器）。
//
// 一次运行 = K 个层按 fps 播 seconds 秒，用 rAF 驱动（和产品一样：播放头不等解码，这一拍要的帧没到就留着上一张）。
// 四种做法：
//   'per'        现状：每层一个 VideoDecoder + 每层画布一个 WebGL 上下文（照 src/render/streamPlayer.ts 的 PlaneCompositor）；
//   'per-shared' 不合并流，但所有层共用一个 WebGL 上下文：各解码器的帧依次上传、画进一张图集，再用 2D 画布从图集裁给各层；
//   'merged-crop'合并流：一个解码器解大画面，给每格做一个裁剪视图（new VideoFrame(big, { visibleRect })，不拷像素），
//                各层照旧用自己的 WebGL 上下文画；
//   'merged-shared' 合并流 + 共用一个 WebGL 上下文：大画面只上传一次，一趟画成图集，2D 画布裁给各层。
(() => {
  const VS = 'attribute vec2 p; varying vec2 uv; uniform vec4 dst; void main(){ uv = vec2((p.x+1.0)*0.5, 1.0-(p.y+1.0)*0.5); vec2 q = dst.xy + (p*0.5+0.5)*dst.zw; gl_Position = vec4(q*2.0-1.0, 0.0, 1.0); }';
  // src：这一格在纹理里的位置（u0, v0, 宽, 高，都是 0..1）；格内上半是预乘色、下半是不透明度，alphaTop / half 是格内的比例
  const FS = 'precision mediump float; varying vec2 uv; uniform sampler2D tex; uniform vec4 src; uniform float alphaTop; uniform float half_; void main(){ vec3 rgb = texture2D(tex, vec2(src.x + uv.x*src.z, src.y + (uv.y*half_)*src.w)).rgb; float a = texture2D(tex, vec2(src.x + uv.x*src.z, src.y + (alphaTop + uv.y*half_)*src.w)).r; gl_FragColor = vec4(min(rgb, vec3(a)), a); }';

  function makeGl(canvas) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return null;
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); return x; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const u = (n) => gl.getUniformLocation(prog, n);
    return { gl, uSrc: u('src'), uDst: u('dst'), uAlphaTop: u('alphaTop'), uHalf: u('half_') };
  }

  /** 一个解码器：按需喂、手里最多留 LIMIT 帧（产品的硬约束是单个解码器同时持有 ≤ 8 帧） */
  class Feed {
    constructor(init, segs, fps, hw) {
      this.fps = fps; this.frames = new Map(); this.pending = 0; this.next = 0; this.error = null; this.format = null; this.decoded = 0;
      this.chunks = [];
      segs.forEach((s) => { const { samples } = PCStream.parseSegment(s); for (const smp of samples) this.chunks.push({ key: smp.isSync, data: new Uint8Array(s, smp.offset, smp.size) }); });
      this.dec = new VideoDecoder({
        output: (f) => { this.pending--; this.decoded++; this.format = f.format; const i = Math.round((f.timestamp * fps) / 1e6); if (i < this.want) f.close(); else this.frames.set(i, f); this.pump(); },
        error: (e) => { this.error = String(e.message || e); },
      });
      this.dec.configure({ codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: hw, optimizeForLatency: true });
      this.want = 0;
    }
    pump() {
      while (!this.error && this.dec.state === 'configured' && this.pending + this.frames.size < 6) {
        const i = this.next++;
        const c = this.chunks[i % this.chunks.length];
        this.pending++;
        this.dec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: Math.round((i * 1e6) / this.fps), data: c.data }));
      }
    }
    /** 这一拍要第 t 帧：有就给（调用方画完自己不关，由这里在下一次 take 时关），没有回 null */
    take(t) {
      this.want = t;
      for (const [i, f] of this.frames) if (i < t) { f.close(); this.frames.delete(i); }
      this.pump();
      return this.frames.get(t) ?? null;
    }
    close() { for (const f of this.frames.values()) f.close(); this.frames.clear(); try { this.dec.close(); } catch { /* 已关 */ } }
  }

  async function load(base, nSeg) {
    const get = async (u) => (await fetch(u)).arrayBuffer();
    const init = PCStream.parseInit(await get(`${base}/init.mp4`));
    const segs = [];
    for (let i = 0; i < nSeg; i++) segs.push(await get(`${base}/seg${i}.m4s`));
    return { init, segs };
  }

  /**
   * opts: { mode, layers: K, cellW, cellH（格的编码尺寸：宽、2×(高+8)）, singles: [url…]（per 模式每层一条）,
   *         merged: [{ url, cols, cells }]（merged 模式：每条合并流几列、装几格）, nSeg, fps, seconds, hw, snapshotAt }
   */
  window.runPlay = async (opts) => {
    const { mode, layers: K, cellW, cellH, fps, seconds, nSeg } = opts;
    const hw = opts.hw || 'prefer-hardware';
    const cardH = cellH / 2 - 8;
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#223;overflow:hidden';
    const shared = mode === 'per-shared' || mode === 'merged-shared';
    const lost = { count: 0 };
    const layers = [];
    for (let i = 0; i < K; i++) {
      const c = document.createElement('canvas');
      c.width = cellW; c.height = cardH;
      // 各层错开摆在 1920×1080 的视口里（互相压着，都要参加合成）
      c.style.cssText = `position:absolute;left:${(i * 37) % Math.max(1, 1920 - cellW + 1)}px;top:${(i * 53) % Math.max(1, 1080 - cardH + 1)}px;width:${cellW}px;height:${cardH}px`;
      document.body.appendChild(c);
      c.addEventListener('webglcontextlost', () => { lost.count++; });
      layers.push(shared ? { canvas: c, ctx: c.getContext('2d') } : { canvas: c, g: makeGl(c) });
    }
    // 共用上下文的图集：每层一格（宽 cellW、高 cardH），一行最多 atlasCols 格
    let atlas = null;
    if (shared) {
      const atlasCols = Math.max(1, Math.min(K, Math.floor(8192 / cellW)));
      const canvas = new OffscreenCanvas(atlasCols * cellW, Math.ceil(K / atlasCols) * cardH);
      atlas = { canvas, g: makeGl(canvas), cols: atlasCols, rows: Math.ceil(K / atlasCols) };
    }
    const noGl = layers.filter((l) => !shared && !l.g).length;

    // 解码器
    const feeds = [];
    const cellOf = []; // 第 i 层：{ feed, x, y }（在那条流的编码画面里的位置）
    if (mode.startsWith('per')) {
      const cache = new Map();
      for (let i = 0; i < K; i++) {
        const url = opts.singles[i % opts.singles.length];
        if (!cache.has(url)) cache.set(url, await load(url, nSeg));
        const s = cache.get(url);
        const feed = new Feed(s.init, s.segs, fps, hw);
        feeds.push(feed); cellOf.push({ feed, x: 0, y: 0, w: s.init.width, h: s.init.height });
      }
    } else {
      let i = 0;
      const cache = new Map();
      for (const m of opts.merged) {
        if (!cache.has(m.url)) cache.set(m.url, await load(m.url, nSeg));
        const s = cache.get(m.url);
        const feed = new Feed(s.init, s.segs, fps, hw);
        feeds.push(feed);
        for (let k = 0; k < m.cells && i < K; k++, i++) cellOf.push({ feed, x: (k % m.cols) * cellW, y: Math.floor(k / m.cols) * cellH, w: s.init.width, h: s.init.height });
      }
    }
    for (const f of feeds) f.pump();

    const drawCell = (g, frame, srcRect, dstRect) => {
      const gl = g.gl;
      gl.uniform4f(g.uSrc, srcRect[0], srcRect[1], srcRect[2], srcRect[3]);
      gl.uniform4f(g.uDst, dstRect[0], dstRect[1], dstRect[2], dstRect[3]);
      gl.uniform1f(g.uAlphaTop, (cardH + 8) / cellH);
      gl.uniform1f(g.uHalf, cardH / cellH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const upload = (g, frame) => { g.gl.texImage2D(g.gl.TEXTURE_2D, 0, g.gl.RGBA, g.gl.RGBA, g.gl.UNSIGNED_BYTE, frame); };

    const total = Math.round(fps * seconds);
    const stat = { drawMs: [], rafGaps: [], exact: 0, held: 0, ticks: 0, uploads: 0 };
    let lastDrawn = -1;
    const everDrawn = new Array(K).fill(false);

    const tick = (t) => {
      const t0 = performance.now();
      const got = new Map();
      for (const f of feeds) got.set(f, f.take(t));
      let all = true;
      for (const f of feeds) if (!got.get(f)) all = false;
      if (!all) { stat.held++; return false; }
      if (shared) {
        const gl = atlas.g.gl;
        gl.viewport(0, 0, atlas.canvas.width, atlas.canvas.height);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        let cur = null;
        for (let i = 0; i < K; i++) {
          const c = cellOf[i];
          const frame = got.get(c.feed);
          if (cur !== frame) { upload(atlas.g, frame); stat.uploads++; cur = frame; }
          drawCell(atlas.g, frame, [c.x / c.w, c.y / c.h, cellW / c.w, cellH / c.h],
            [(i % atlas.cols) / atlas.cols, 1 - (Math.floor(i / atlas.cols) + 1) / atlas.rows, 1 / atlas.cols, 1 / atlas.rows]);
        }
        for (let i = 0; i < K; i++) {
          const l = layers[i];
          l.ctx.clearRect(0, 0, cellW, cardH);
          l.ctx.drawImage(atlas.canvas, (i % atlas.cols) * cellW, Math.floor(i / atlas.cols) * cardH, cellW, cardH, 0, 0, cellW, cardH);
          everDrawn[i] = true;
        }
      } else {
        for (let i = 0; i < K; i++) {
          const l = layers[i], c = cellOf[i];
          if (!l.g || l.g.gl.isContextLost()) continue;
          const frame = got.get(c.feed);
          const gl = l.g.gl;
          gl.viewport(0, 0, cellW, cardH);
          gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          if (mode === 'merged-crop') {
            // 裁剪视图：不拷像素，只是同一块解码缓冲的另一个可见矩形
            const view = new VideoFrame(frame, { visibleRect: { x: c.x, y: c.y, width: cellW, height: cellH } });
            upload(l.g, view); stat.uploads++;
            view.close();
            drawCell(l.g, null, [0, 0, 1, 1], [0, 0, 1, 1]);
          } else {
            upload(l.g, frame); stat.uploads++;
            drawCell(l.g, null, [0, 0, 1, 1], [0, 0, 1, 1]);
          }
          everDrawn[i] = true;
        }
      }
      stat.drawMs.push(performance.now() - t0);
      stat.exact++;
      return true;
    };

    // 起播前等每个解码器都出了第一帧（不算进播放统计）
    const tWait = performance.now();
    while (feeds.some((f) => !f.frames.size && !f.error) && performance.now() - tWait < 20000) await new Promise((r) => setTimeout(r, 5));
    const startupMs = performance.now() - tWait;

    if (opts.snapshotAt != null) {
      // 只画指定的那一帧（给各做法比像素用）：等它解出来再画一次，不走播放循环
      const tSnap = performance.now();
      while (!tick(opts.snapshotAt) && performance.now() - tSnap < 20000) await new Promise((r) => setTimeout(r, 5));
      lastDrawn = stat.exact ? opts.snapshotAt : -1;
    } else await new Promise((resolve) => {
      let start = null, prev = null;
      const step = (now) => {
        if (start == null) start = now;
        if (prev != null) stat.rafGaps.push(now - prev);
        prev = now;
        const t = Math.floor(((now - start) * fps) / 1000);
        if (t >= total) return resolve();
        stat.ticks++;
        if (t !== lastDrawn) { if (tick(t)) lastDrawn = t; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    // 取一小块像素（第 0 层和最后一层的中间 48×48）给探针比对各做法画得是否一样
    const patches = [];
    for (const i of [0, K - 1]) {
      const l = layers[i];
      const x = (cellW / 2 - 24) | 0, y = (cardH / 2 - 24) | 0;
      try {
        // getImageData 给的是直通色，readPixels 给的是预乘色：这里乘回去再比
        if (shared) { const d = l.ctx.getImageData(x, y, 48, 48).data; const pm = []; for (let k = 0; k < d.length; k += 4) { const a = d[k + 3]; pm.push(Math.round((d[k] * a) / 255), Math.round((d[k + 1] * a) / 255), Math.round((d[k + 2] * a) / 255), a); } patches.push(pm); }
        else if (l.g && !l.g.gl.isContextLost()) { const px = new Uint8Array(48 * 48 * 4); l.g.gl.readPixels(x, cardH - y - 48, 48, 48, l.g.gl.RGBA, l.g.gl.UNSIGNED_BYTE, px); const flip = []; for (let r = 47; r >= 0; r--) for (let k = 0; k < 48 * 4; k++) flip.push(px[r * 48 * 4 + k]); patches.push(flip); } else patches.push(null);
      } catch (e) { patches.push(null); }
    }
    const lostNow = layers.filter((l) => l.g && l.g.gl.isContextLost()).length;
    const errors = [...new Set(feeds.map((f) => f.error).filter(Boolean))];
    const formats = [...new Set(feeds.map((f) => f.format))];
    for (const f of feeds) f.close();
    const sorted = (a) => [...a].sort((x, y) => x - y);
    const q = (a, p) => { const s = sorted(a); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null; };
    const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
    return {
      mode, layers: K, decoders: feeds.length, fps, wanted: total, exact: stat.exact, heldTicks: stat.held,
      drawMs: { mean: mean(stat.drawMs), p95: q(stat.drawMs, 0.95), max: q(stat.drawMs, 1) },
      raf: { count: stat.rafGaps.length, meanGap: mean(stat.rafGaps), p95Gap: q(stat.rafGaps, 0.95), over25ms: stat.rafGaps.filter((g) => g > 25).length },
      uploadsPerDraw: stat.exact ? +(stat.uploads / stat.exact).toFixed(1) : null,
      contextsLostEvents: lost.count, contextsLostAtEnd: lostNow, layersWithoutGl: noGl, layersNeverDrawn: everDrawn.filter((d) => !d).length,
      decoderErrors: errors, frameFormats: formats, startupMs: +startupMs.toFixed(0), lastDrawn, patches,
    };
  };
})();
