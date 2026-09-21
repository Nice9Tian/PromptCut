// 页面侧的 fMP4 解封装 + 上下拼合合成，给 G0-b 的 (4)(5)(9) 三支探针共用。
// 对应 G5「自写 fMP4 解封装」「VideoFrame 直接 texImage2D，片元着色器拆两半」。
//
// 注入方式：page.addScriptTag({ path: 'scripts/probes/stream-demux-browser.js' })
// 暴露 window.PCStream。
(() => {
  'use strict';

  // ── MP4 box ────────────────────────────────────────────────────────────────
  function boxes(view, start, end) {
    const out = [];
    let off = start;
    while (off + 8 <= end) {
      let size = view.getUint32(off);
      const type = String.fromCharCode(view.getUint8(off + 4), view.getUint8(off + 5), view.getUint8(off + 6), view.getUint8(off + 7));
      let header = 8;
      if (size === 1) { size = Number(view.getBigUint64(off + 8)); header = 16; }
      else if (size === 0) size = end - off;
      if (size < header || off + size > end) break;
      out.push({ type, start: off, end: off + size, header });
      off += size;
    }
    return out;
  }

  const CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts'];

  function findBox(view, type, start, end) {
    for (const b of boxes(view, start, end)) {
      if (b.type === type) return b;
      let innerStart = null;
      if (CONTAINERS.includes(b.type)) innerStart = b.start + b.header;
      else if (b.type === 'stsd') innerStart = b.start + b.header + 8;
      else if (b.type === 'avc1' || b.type === 'avc3') innerStart = b.start + b.header + 78;
      if (innerStart != null) {
        const inner = findBox(view, type, innerStart, b.end);
        if (inner) return inner;
      }
    }
    return null;
  }

  /** init.mp4 -> { codec, description(avcC 原样), width, height, timescale } */
  function parseInit(buf) {
    const view = new DataView(buf);
    const avcC = findBox(view, 'avcC', 0, buf.byteLength);
    if (!avcC) throw new Error('init.mp4 里没有 avcC');
    const desc = new Uint8Array(buf, avcC.start + avcC.header, avcC.end - avcC.start - avcC.header);
    const hex = (n) => n.toString(16).padStart(2, '0');
    const codec = `avc1.${hex(desc[1])}${hex(desc[2])}${hex(desc[3])}`;
    const avc1 = findBox(view, 'avc1', 0, buf.byteLength);
    let width = null, height = null;
    if (avc1) {
      const p = avc1.start + avc1.header;
      width = view.getUint16(p + 24); height = view.getUint16(p + 26);
    }
    const mdhd = findBox(view, 'mdhd', 0, buf.byteLength);
    let timescale = null;
    if (mdhd) {
      const p = mdhd.start + mdhd.header;
      timescale = view.getUint8(p) === 1 ? view.getUint32(p + 20) : view.getUint32(p + 12);
    }
    return { codec, description: desc, width, height, timescale, naluLengthSize: (desc[4] & 3) + 1 };
  }

  /**
   * 一个分段（moof+mdat）-> 样本列表。`default-base-is-moof` 下样本偏移基准是 moof 起点。
   * 返回 [{ offset, size, isSync, duration }]。
   */
  function parseSegment(buf) {
    const view = new DataView(buf);
    const top = boxes(view, 0, buf.byteLength);
    const moof = top.find((b) => b.type === 'moof');
    if (!moof) throw new Error('分段里没有 moof');
    const tfhd = findBox(view, 'tfhd', moof.start + moof.header, moof.end);
    const trun = findBox(view, 'trun', moof.start + moof.header, moof.end);
    const tfdt = findBox(view, 'tfdt', moof.start + moof.header, moof.end);
    if (!tfhd || !trun) throw new Error('分段里没有 tfhd/trun');

    let defDur = 0, defSize = 0, defFlags = 0;
    {
      const p = tfhd.start + tfhd.header;
      const flags = view.getUint32(p) & 0xffffff;
      let o = p + 8;
      if (flags & 0x000001) o += 8;
      if (flags & 0x000002) o += 4;
      if (flags & 0x000008) { defDur = view.getUint32(o); o += 4; }
      if (flags & 0x000010) { defSize = view.getUint32(o); o += 4; }
      if (flags & 0x000020) { defFlags = view.getUint32(o); o += 4; }
    }
    let baseDecodeTime = 0;
    if (tfdt) {
      const p = tfdt.start + tfdt.header;
      baseDecodeTime = view.getUint8(p) === 1 ? Number(view.getBigUint64(p + 4)) : view.getUint32(p + 4);
    }

    const p = trun.start + trun.header;
    const flags = view.getUint32(p) & 0xffffff;
    const count = view.getUint32(p + 4);
    let o = p + 8;
    let dataOffset = 0;
    if (flags & 0x000001) { dataOffset = view.getInt32(o); o += 4; }
    let firstSampleFlags = null;
    if (flags & 0x000004) { firstSampleFlags = view.getUint32(o); o += 4; }

    let cursor = moof.start + dataOffset; // default-base-is-moof
    const samples = [];
    for (let i = 0; i < count; i++) {
      let dur = defDur, size = defSize, sflags = i === 0 && firstSampleFlags != null ? firstSampleFlags : defFlags;
      if (flags & 0x000100) { dur = view.getUint32(o); o += 4; }
      if (flags & 0x000200) { size = view.getUint32(o); o += 4; }
      if (flags & 0x000400) { sflags = view.getUint32(o); o += 4; }
      if (flags & 0x000800) o += 4; // composition time offset
      samples.push({ offset: cursor, size, duration: dur, isSync: (sflags & 0x00010000) === 0 });
      cursor += size;
    }
    return { samples, baseDecodeTime };
  }

  /** 分段 -> EncodedVideoChunk[]，时间戳按 G5：(分段号 × perSeg + 序号) × 1e6 / fps。 */
  function chunksOf(buf, { segmentIndex = 0, fps = 30, perSegment = 15 } = {}) {
    const { samples } = parseSegment(buf);
    const step = 1e6 / fps;
    return samples.map((s, i) => new EncodedVideoChunk({
      type: s.isSync ? 'key' : 'delta',
      timestamp: Math.round((segmentIndex * perSegment + i) * step),
      duration: Math.round(step),
      data: new Uint8Array(buf, s.offset, s.size),
    }));
  }

  // ── WebGL：上下拼合 -> 带透明 ─────────────────────────────────────────────
  // docs/async-track-playback.md §4.2：alphaTop = (H + 8) / (2H + 16)，half = H / (2H + 16)
  // 色半区存的是**预乘**色（r75-05 第 2 条），所以直接输出、不做 rgb × a。
  const VS = `attribute vec2 p; varying vec2 uv;
    void main(){ uv = vec2((p.x+1.0)*0.5, (1.0-p.y)*0.5); gl_Position = vec4(p,0.0,1.0); }`;
  const FS = `precision mediump float; uniform sampler2D tex; uniform float alphaTop; uniform float half_;
    varying vec2 uv;
    void main(){
      vec3 rgb = texture2D(tex, vec2(uv.x, uv.y * half_)).rgb;
      float a  = texture2D(tex, vec2(uv.x, alphaTop + uv.y * half_)).r;
      gl_FragColor = vec4(rgb, a);   // 预乘口径：不再乘 a
    }`;

  function makeCompositor(canvas, { premultipliedAlpha = true } = {}) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha, alpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('拿不到 WebGL 上下文');
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const uAlphaTop = gl.getUniformLocation(prog, 'alphaTop');
    const uHalf = gl.getUniformLocation(prog, 'half_');

    return {
      gl,
      /** frame: VideoFrame（上下拼合）；H = 内容高度（不含各自 8 行填充）。 */
      draw(frame, H) {
        const total = frame.displayHeight ?? frame.codedHeight;
        canvas.width = frame.displayWidth ?? frame.codedWidth;
        canvas.height = H;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform1f(uAlphaTop, (H + 8) / total);
        gl.uniform1f(uHalf, H / total);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      /** 读回 RGBA（预乘）。WebGL 的 (0,0) 在左下，这里翻回左上。 */
      readPixels() {
        const w = canvas.width, h = canvas.height;
        const flipped = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
        const out = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) out.set(flipped.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        return { data: out, width: w, height: h };
      },
    };
  }

  window.PCStream = { boxes, findBox, parseInit, parseSegment, chunksOf, makeCompositor };
})();
