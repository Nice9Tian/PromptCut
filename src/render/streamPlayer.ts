/**
 * 轨道流的页面侧:自写 fMP4 解封装、`VideoDecoder` 硬解、WebGL 拆两半合成(R8,任务书 G5)。
 *
 * **只在 `front` 角色的舞台文档里跑**(解码器和解码帧预算都在 `front`;`back` 不建 decoder、不画,K5)。
 * 画在 `Stage` 已经渲好的兄弟平面上 —— 单卡流是包裹层里的 `<canvas data-pc-stream-plane>`,
 * 组流是舞台根下的 `<canvas data-pc-group-plane>`;这里只往那块画布上画、按清单设它的位置和尺寸,
 * **不做外部 `insertBefore`**(任务书「不做」)。
 *
 * # 硬约束(G0-b 定的数)
 *
 *   - **单个 `VideoDecoder` 同时持有的 `VideoFrame` ≤ 8 帧**:攒到 11～12 帧解码器就死锁、`flush()`
 *     永不返回,这是帧数上限、与分辨率无关;
 *   - 在这之上解码帧预算**按字节算**:总量 ≤ 80 MB(上下拼合的编码画面,NV12 按 1.5 字节 / 像素),
 *     每流保底 3 帧;
 *   - 同时活跃的解码器 ≤ 6(超出的平面不建解码器 —— `planesWithinBudget`,父页用同一个函数;
 *     那一层从兜底顺序第 3 步起:最近快照,再没有就占位符);
 *   - 每流最多 2 个在途请求,分段整段拉;
 *   - `codec` 从 `avcC` 拼(真实 SPS 的 level 随内容变,不能写死);`isConfigSupported` 不校验 level
 *     与分辨率,不拿它当能力判据。
 *
 * # 画法
 *
 * 色半区存的是**预乘色**(G3),上下文按 `premultipliedAlpha: true` 输出,不再做 `rgb × a`;
 * 着色器**钳一次 `rgb = min(rgb, vec3(a))`**(G0-b (5):不钳时透明区的编码噪声原样输出)。
 * 纹理坐标按 `alphaTop = (H + 8) / (2H + 16)`、`half = H / (2H + 16)` 拆两半。
 *
 * # 时间
 *
 * 流按**全局帧号**分段:第 F 帧在第 `floor(F / 15)` 段的第 `F % 15` 个样本,
 * `EncodedVideoChunk.timestamp = F × 1e6 / fps`(微秒,取整)。这一拍要的帧没解出来时,
 * 最近 3 帧内画过的那一帧留着不动(「沿用旧的预渲染结果」是允许的退化),再远就清空流平面、这一拍落到兜底顺序的下一步(父页垫着的快照,没有就占位符) ——
 * **播放头从不为它停**。
 */

export const SEGMENT_FRAMES = 15;
/** G0-b (4):单个解码器同时持有的帧数上限(硬约束) */
export const MAX_FRAMES_PER_DECODER = 8;
/** G5:解码帧总预算 */
export const DECODED_BYTES_BUDGET = 80 * 1024 * 1024;
/** G5:每流保底 */
export const MIN_FRAMES_PER_STREAM = 3;
/** G1 / G0-b (4):同时活跃的解码器预算 */
export const DECODER_BUDGET = 6;
/** G5:每流最多 2 个在途请求 */
export const MAX_INFLIGHT_PER_STREAM = 2;
/** 这一拍的帧没到时,最近这么多帧内画过的那张留着 */
export const HOLD_FRAMES = 3;
/** 清单多久可以再问一次(分段会被替换:稀疏 → 满密度) */
export const MANIFEST_REFRESH_MS = 2000;

export interface StreamRect { x: number; y: number; w: number; h: number }

/** 父页经 `setStreamPlanes` 发来的一条(C3:由就绪索引里 `kind: 'stream'` 的层合成) */
export interface StreamPlaneRequest {
  /** 长度 1 = 单卡流;> 1 = 组流(按画家顺序,最后一个在最上面) */
  clipIds: string[];
  /** 流键(就绪索引里那一层的 `key`) */
  key?: string;
  /** 就绪的**分段号**闭区间(C3 的 `stream` 表单位是分段号) */
  ranges?: Array<[number, number]>;
}

export interface StreamManifest {
  streamKey: string;
  kind: "card" | "group";
  plane: "local" | "stage";
  clipIds: string[];
  fps: number;
  segmentFrames: number;
  bound: StreamRect;
  tight: StreamRect | null;
  inits: Record<string, { codec: string; width: number; height: number; rect: StreamRect }>;
  segments: Record<string, { init: string; file: string; stride: number; samples: number }>;
}

/* ======================================================================== *
 * fMP4 解封装
 * ======================================================================== */

interface Box { type: string; start: number; end: number; header: number }

function boxesOf(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
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

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "mvex", "edts"]);

function findBox(view: DataView, type: string, start: number, end: number): Box | null {
  for (const b of boxesOf(view, start, end)) {
    if (b.type === type) return b;
    let inner: number | null = null;
    if (CONTAINERS.has(b.type)) inner = b.start + b.header;
    else if (b.type === "stsd") inner = b.start + b.header + 8;
    else if (b.type === "avc1" || b.type === "avc3") inner = b.start + b.header + 78;
    if (inner !== null) {
      const hit = findBox(view, type, inner, b.end);
      if (hit) return hit;
    }
  }
  return null;
}

/** init.mp4 → 解码器配置要的东西。**`codec` 从 `avcC` 拼** */
export function parseInit(buf: ArrayBuffer): { codec: string; description: Uint8Array; width: number; height: number } {
  const view = new DataView(buf);
  const avcC = findBox(view, "avcC", 0, buf.byteLength);
  if (!avcC) throw new Error("init.mp4 里没有 avcC");
  const description = new Uint8Array(buf.slice(avcC.start + avcC.header, avcC.end));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
  const avc1 = findBox(view, "avc1", 0, buf.byteLength);
  let width = 0, height = 0;
  if (avc1) {
    const p = avc1.start + avc1.header;
    width = view.getUint16(p + 24);
    height = view.getUint16(p + 26);
  }
  return { codec, description, width, height };
}

export interface SegmentSample { offset: number; size: number; isSync: boolean }

/** 一个分段(moof + mdat)→ 样本表。`default-base-is-moof`:偏移以 moof 起点为基 */
export function parseSegment(buf: ArrayBuffer): SegmentSample[] {
  const view = new DataView(buf);
  const moof = boxesOf(view, 0, buf.byteLength).find((b) => b.type === "moof");
  if (!moof) throw new Error("分段里没有 moof");
  const tfhd = findBox(view, "tfhd", moof.start + moof.header, moof.end);
  const trun = findBox(view, "trun", moof.start + moof.header, moof.end);
  if (!tfhd || !trun) throw new Error("分段里没有 tfhd / trun");
  let defSize = 0, defFlags = 0;
  {
    const p = tfhd.start + tfhd.header;
    const flags = view.getUint32(p) & 0xffffff;
    let o = p + 8;
    if (flags & 0x1) o += 8;
    if (flags & 0x2) o += 4;
    if (flags & 0x8) o += 4;
    if (flags & 0x10) { defSize = view.getUint32(o); o += 4; }
    if (flags & 0x20) { defFlags = view.getUint32(o); o += 4; }
  }
  const p = trun.start + trun.header;
  const flags = view.getUint32(p) & 0xffffff;
  const count = view.getUint32(p + 4);
  let o = p + 8;
  let dataOffset = 0;
  if (flags & 0x1) { dataOffset = view.getInt32(o); o += 4; }
  let firstFlags: number | null = null;
  if (flags & 0x4) { firstFlags = view.getUint32(o); o += 4; }
  let cursor = moof.start + dataOffset;
  const samples: SegmentSample[] = [];
  for (let i = 0; i < count; i++) {
    let size = defSize;
    let sflags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
    if (flags & 0x100) o += 4;
    if (flags & 0x200) { size = view.getUint32(o); o += 4; }
    if (flags & 0x400) { sflags = view.getUint32(o); o += 4; }
    if (flags & 0x800) o += 4;
    samples.push({ offset: cursor, size, isSync: (sflags & 0x00010000) === 0 });
    cursor += size;
  }
  return samples;
}

/** G5:`timestamp = (分段号 × 15 + 样本序号) × 1e6 / fps` = 全局帧号 × 1e6 / fps */
export const chunkTimestamp = (frame: number, fps: number): number => Math.round((frame * 1e6) / fps);
export const frameOfTimestamp = (timestamp: number, fps: number): number => Math.round((timestamp * fps) / 1e6);

/** 就绪区间里有没有这一段 */
export function rangesHave(ranges: ReadonlyArray<readonly number[]> | undefined, n: number): boolean {
  for (const r of ranges ?? []) if (r[0] <= n && n <= r[1]) return true;
  return false;
}

/**
 * 父页那一侧的纯算(C3 末段):就绪索引里 `kind: 'stream'` 的层 → `setStreamPlanes` 的实参。
 * 有 `groupClipIds` 的一条 `{ clipIds: groupClipIds }`、没有的 `{ clipIds: [clipId] }`;
 * 只给**这一刻被抑制**、而且这一段已经就绪的卡(播放中贴流,K5)。
 * 父页在发 `setSuppressed(H(t))` 的同一处调它(见报告:这一处在 `src/editor/`,不在本任务可改的文件里)。
 */
export function streamPlanesFor(
  layers: Iterable<{ clipId: string; key: string; ranges: Array<[number, number]>; groupClipIds?: string[] }>,
  suppressed: ReadonlySet<string>,
  globalFrame: number,
): StreamPlaneRequest[] {
  const seg = Math.floor(Math.max(0, globalFrame) / SEGMENT_FRAMES);
  const out: StreamPlaneRequest[] = [];
  for (const layer of layers) {
    const members = layer.groupClipIds?.length ? layer.groupClipIds : [layer.clipId];
    if (!members.every((id) => suppressed.has(id))) continue;
    if (!rangesHave(layer.ranges, seg)) continue;
    out.push({ clipIds: [...members], key: layer.key, ranges: layer.ranges.map((r) => [r[0], r[1]] as [number, number]) });
  }
  return out;
}

/**
 * 解码器预算(兜底顺序第 1、2 步的预算,rendering.md「兜底顺序」):这一拍**真的会建解码器**的那几条平面。
 *
 * 只收有流键的(没有键的只占位、不解码),按传进来的顺序取前 `DECODER_BUDGET` 条 ——
 * 舞台的 `sync()` 和父页的 `streamPlanesAt` 用同一个函数,两边对「谁超预算」的判断一致:
 * 超预算的卡父页当「无流」、每拍换最近的快照(兜底顺序直接从第 3 步开始)。
 * 画布还没挂上的平面照样占着它的预算位(父页不知道画布到没到),那一拍按流 blank 处理。
 */
export function planesWithinBudget<P extends { clipIds?: readonly string[]; key?: string }>(planes: readonly P[]): P[] {
  const out: P[] = [];
  for (const p of planes) {
    if (out.length >= DECODER_BUDGET) break;
    if (!Array.isArray(p?.clipIds) || !p.clipIds.length || typeof p.key !== "string" || !p.key) continue;
    out.push(p);
  }
  return out;
}

/* ======================================================================== *
 * 字节从哪来
 * ======================================================================== */

export interface StreamSource {
  manifest(key: string, signal?: AbortSignal): Promise<StreamManifest>;
  init(key: string, id: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  segment(key: string, file: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

declare global {
  interface Window {
    /** 探针用:把流的字节源指到别处(缺省是预渲染进程,和快照字节同源) */
    __pcStreamBase?: string;
  }
}

/** 预渲染进程的源。按需 import(`prerender.ts` 带 React hook,静态 import 会把它拖进这条路) */
const defaultBase = async (): Promise<string> => {
  if (typeof window !== "undefined" && typeof window.__pcStreamBase === "string") return window.__pcStreamBase;
  return (await import("./prerender.ts")).prerenderBase();
};

/** 本地模式:直连预渲染进程的 `/api/frames/stream/…`(和 C3 的快照字节同源) */
export class HttpStreamSource implements StreamSource {
  private base: () => Promise<string>;
  constructor(base: () => Promise<string> = defaultBase) { this.base = base; }
  private async get(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch((await this.base()) + path, init);
    if (!res.ok) throw Object.assign(new Error(`轨道流还没就绪:${path}`), { status: res.status });
    return res;
  }
  async manifest(key: string, signal?: AbortSignal): Promise<StreamManifest> {
    return (await this.get(`/api/frames/stream/${encodeURIComponent(key)}/manifest`, { cache: "no-store", signal })).json();
  }
  async init(key: string, id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return (await this.get(`/api/frames/stream/${encodeURIComponent(key)}/init/${encodeURIComponent(id)}`, { cache: "force-cache", signal })).arrayBuffer();
  }
  async segment(key: string, file: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return (await this.get(`/api/frames/stream/${encodeURIComponent(key)}/seg/${encodeURIComponent(file)}`, { cache: "force-cache", signal })).arrayBuffer();
  }
}

/* ======================================================================== *
 * WebGL 合成
 * ======================================================================== */

const VS = `attribute vec2 p; varying vec2 uv;
void main(){ uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
/*
 * 色半区是预乘色:直接输出,**钳一次 rgb ≤ a**(预乘色本来就必须满足的约束;G0-b (5):
 * 不钳时透明区的编码噪声原样输出,彩色杂点最高 146/255,钳后 59)。
 */
const FS = `precision mediump float; uniform sampler2D tex; uniform float alphaTop; uniform float half_;
varying vec2 uv;
void main(){
  vec3 rgb = texture2D(tex, vec2(uv.x, uv.y * half_)).rgb;
  float a = texture2D(tex, vec2(uv.x, alphaTop + uv.y * half_)).r;
  gl_FragColor = vec4(min(rgb, vec3(a)), a);
}`;

class PlaneCompositor {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private tex: WebGLTexture;
  private uAlphaTop: WebGLUniformLocation | null;
  private uHalf: WebGLUniformLocation | null;
  private blank = true;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("轨道流拿不到 WebGL 上下文");
    this.gl = gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "program");
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.uAlphaTop = gl.getUniformLocation(prog, "alphaTop");
    this.uHalf = gl.getUniformLocation(prog, "half_");
  }
  /** 画布的位置和尺寸 = 流的矩形上界(平面坐标)。只在变了的时候写 */
  place(bound: StreamRect): void {
    const c = this.canvas;
    if (c.width !== bound.w) c.width = bound.w;
    if (c.height !== bound.h) c.height = bound.h;
    const s = c.style;
    const want: Record<string, string> = { left: `${bound.x}px`, top: `${bound.y}px`, width: `${bound.w}px`, height: `${bound.h}px` };
    for (const [k, v] of Object.entries(want)) if (s.getPropertyValue(k) !== v) s.setProperty(k, v);
  }
  /** 画一帧。`rect` 是这一帧所在变体的矩形(平面坐标),`bound` 是画布覆盖的矩形 */
  draw(frame: VideoFrame, rect: StreamRect, bound: StreamRect): void {
    const gl = this.gl;
    const total = frame.displayHeight || frame.codedHeight;
    const H = rect.h;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // WebGL 的原点在左下
    const vx = rect.x - bound.x;
    const vy = bound.y + bound.h - (rect.y + rect.h);
    gl.viewport(vx, vy, rect.w, rect.h);
    gl.uniform1f(this.uAlphaTop, (H + 8) / total);
    gl.uniform1f(this.uHalf, H / total);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.blank = false;
  }
  clear(): void {
    if (this.blank) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.blank = true;
  }
  get isBlank(): boolean { return this.blank; }
  dispose(): void {
    try { this.gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* 已经丢了 */ }
  }
}

/* ======================================================================== *
 * 一条流
 * ======================================================================== */

interface HeldFrame { frame: VideoFrame; segment: number }
interface SegmentData { buf: ArrayBuffer; samples: SegmentSample[]; init: string; file: string }

class StreamTrack {
  readonly id: string;
  plane: StreamPlaneRequest;
  canvas: HTMLCanvasElement;
  private player: StreamPlayer;
  private compositor: PlaneCompositor | null = null;
  manifest: StreamManifest | null = null;
  private manifestAt = 0;
  private manifestLoading: Promise<void> | null = null;
  private decoder: VideoDecoder | null = null;
  private configuredInit: string | null = null;
  private inits = new Map<string, { config: VideoDecoderConfig; bytesPerFrame: number }>();
  private initLoading = new Map<string, Promise<void>>();
  readonly frames = new Map<number, HeldFrame>();
  private nextFeed: number | null = null;
  private discardBefore = 0;
  private segments = new Map<number, SegmentData>();
  private fetching = new Map<number, Promise<void>>();
  private lastDrawn: number | null = null;
  private wantFrame: number | null = null;
  /** 喂进解码器、还没出来的帧数(`decodeQueueSize` 只数还没交给解码器的,解码器里正在解的不算) */
  private pending = 0;
  private pumpQueued = false;
  private disposed = false;
  bytesPerFrame = 1920 * 2176 * 1.5;
  stats = { decoded: 0, drawn: 0, holds: 0, blanks: 0, seeks: 0, errors: 0, maxHeld: 0, lastError: "" };

  constructor(player: StreamPlayer, plane: StreamPlaneRequest, canvas: HTMLCanvasElement) {
    this.player = player;
    this.plane = plane;
    this.canvas = canvas;
    this.id = planeId(plane);
  }

  get key(): string { return this.plane.key ?? ""; }
  private get fps(): number { return this.manifest?.fps || this.player.fps; }
  /** 此刻占着解码器输出池的帧:手里没关的 + 喂进去还没出来的 */
  get heldCount(): number { return this.frames.size + this.pending; }

  private ensureCompositor(): PlaneCompositor | null {
    if (this.compositor && this.compositor.canvas === this.canvas) return this.compositor;
    this.compositor?.dispose();
    try { this.compositor = new PlaneCompositor(this.canvas); }
    catch (e) { this.compositor = null; this.stats.lastError = String((e as Error)?.message || e); }
    return this.compositor;
  }

  /**
   * 异步的料(清单 / init / 分段)到了:按这一拍要的帧再走一遍 `present`。暂停 / 拖动时没有下一拍来叫它,
   * 不这样的话随机访问会停在「清单刚到、还没开始解」那一步。同一个微任务里只走一次。
   */
  private wakeQueued = false;
  private wake(): void {
    if (this.wakeQueued || this.disposed) return;
    this.wakeQueued = true;
    queueMicrotask(() => {
      this.wakeQueued = false;
      if (!this.disposed && this.wantFrame !== null) this.present(this.wantFrame);
    });
  }

  /**
   * 同一个流键的就绪区间变了(生产者发布了新分段):下一次 `present` 允许再问一次清单(疑点 G)。
   * 真的发出去了才清掉 —— 被节流挡回来的话留着,下一拍再试。
   */
  private manifestDirty = false;

  /**
   * 清单:没有就拉;`force` 时隔 2 秒以上再拉一次(分段会被替换:稀疏 → 满帧)。
   * 回这一次有没有真的发起。
   */
  private loadManifest(force = false): boolean {
    if (!this.key || this.manifestLoading) return false;
    const now = Date.now();
    if (this.manifest && !force) return false;
    if (this.manifest && now - this.manifestAt < MANIFEST_REFRESH_MS) return false;
    this.manifestAt = now;
    this.manifestLoading = this.player.source.manifest(this.key)
      .then((m) => {
        if (this.disposed) return;
        this.manifest = m;
        this.manifestAt = Date.now();
        // 清单一到就把画布摆到流的矩形上界:还没画出第一帧时,被抑制的卡也要有一块能点中的框
        this.ensureCompositor()?.place(m.bound);
        this.wake();
      })
      .catch(() => { /* 还没就绪:这一层这一拍落到兜底顺序的下一步(快照 / 占位符),下一拍再说 */ })
      .finally(() => { this.manifestLoading = null; });
    return true;
  }

  /** 一个 init(变体)的解码器配置 */
  private loadInit(id: string): void {
    if (this.inits.has(id) || this.initLoading.has(id) || !this.key) return;
    const work = this.player.source.init(this.key, id)
      .then((buf) => {
        const info = parseInit(buf);
        this.inits.set(id, {
          config: { codec: info.codec, description: info.description, codedWidth: info.width, codedHeight: info.height,
            hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
          bytesPerFrame: info.width * info.height * 1.5,
        });
        this.wake();
      })
      .catch((e) => { this.stats.lastError = String(e?.message || e); })
      .finally(() => { this.initLoading.delete(id); });
    this.initLoading.set(id, work);
  }

  /** 分段整段拉,每流最多 2 个在途 */
  private loadSegment(n: number): void {
    if (this.segments.has(n) || this.fetching.has(n) || this.fetching.size >= MAX_INFLIGHT_PER_STREAM || !this.manifest) return;
    const meta = this.manifest.segments[String(n)];
    if (!meta) return;
    const work = this.player.source.segment(this.key, meta.file)
      .then((buf) => {
        if (this.disposed) return;
        this.segments.set(n, { buf, samples: parseSegment(buf), init: meta.init, file: meta.file });
        // 留当前段和它前后各一段,别的扔掉
        for (const k of [...this.segments.keys()]) if (Math.abs(k - n) > 2) this.segments.delete(k);
        this.wake();
      })
      .catch(() => {
        // 被替换删掉了(G6)或者还没就绪:下一次按新清单拉
        this.loadManifest(true);
      })
      .finally(() => { this.fetching.delete(n); });
    this.fetching.set(n, work);
  }

  private newDecoder(): VideoDecoder | null {
    if (typeof VideoDecoder === "undefined") return null;
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        this.stats.errors++;
        this.stats.lastError = String(e?.message || e);
        if (this.decoder === decoder) { this.decoder = null; this.configuredInit = null; this.nextFeed = null; this.pending = 0; }
      },
    });
    return decoder;
  }

  private onFrame(frame: VideoFrame): void {
    if (this.pending > 0) this.pending--;
    const f = frameOfTimestamp(frame.timestamp, this.fps);
    if (this.disposed || f < this.discardBefore || this.frames.has(f)) {
      frame.close();
    } else {
      this.frames.set(f, { frame, segment: Math.floor(f / SEGMENT_FRAMES) });
      this.stats.decoded++;
      this.stats.maxHeld = Math.max(this.stats.maxHeld, this.heldCount);
      // 随机访问:目标帧出来了就立刻画,不等下一拍
      if (this.wantFrame === f) this.drawAt(f);
    }
    // 腾出了位置:接着喂(暂停态没有下一拍来叫它,随机访问要一路解到目标帧)
    if (!this.pumpQueued && !this.disposed) {
      this.pumpQueued = true;
      queueMicrotask(() => { this.pumpQueued = false; this.pump(); });
    }
  }

  /** 跳段 / 起步:从目标所在分段的 IDR 起解,目标之前的帧一出来就关 */
  private seek(f: number): void {
    this.stats.seeks++;
    for (const h of this.frames.values()) h.frame.close();
    this.frames.clear();
    if (this.decoder && this.decoder.state !== "closed") {
      try { this.decoder.reset(); } catch { /* 已经坏了 */ }
    }
    this.pending = 0;
    this.configuredInit = null;
    this.nextFeed = Math.floor(f / SEGMENT_FRAMES) * SEGMENT_FRAMES;
    this.discardBefore = f;
  }

  /** 这一帧所在分段的变体矩形 */
  private rectOf(f: number): StreamRect | null {
    const seg = this.manifest?.segments[String(Math.floor(f / SEGMENT_FRAMES))];
    const init = seg ? this.manifest!.inits[seg.init] : null;
    return init?.rect ?? null;
  }

  private drawAt(f: number): boolean {
    const held = this.frames.get(f);
    const rect = this.rectOf(f);
    const compositor = this.ensureCompositor();
    if (!held || !rect || !compositor || !this.manifest) return false;
    compositor.place(this.manifest.bound);
    compositor.draw(held.frame, rect, this.manifest.bound);
    this.lastDrawn = f;
    this.stats.drawn++;
    this.coverSnapshot(true);
    return true;
  }

  private blank(): void {
    if (this.compositor && !this.compositor.isBlank) {
      this.compositor.clear();
      this.stats.blanks++;
    }
    this.lastDrawn = null;
    this.coverSnapshot(false);
  }

  /**
   * 有流画面时把快照平面藏起来,流清空时露出来(兜底顺序:流画不出来的那一拍当场落到快照,
   * 不等下一次分派)。父页在流覆盖时照样投一张「海报」快照垫在下面(根因 C),
   * 两层同时显示会叠出重影 —— 流在上面,快照从流的透明处漏出来。
   *
   * 单卡流:同一包裹层里的快照平面。组流(画布在舞台根下):每个成员包裹层里的快照平面。
   * 只动快照平面自己的 `visibility`,React 不管这个属性,不会冲掉它。
   */
  private coverSnapshot(on: boolean): void {
    const want = on ? "hidden" : "";
    const set = (snap: HTMLElement | null | undefined) => { if (snap && snap.style.visibility !== want) snap.style.visibility = want; };
    if (this.plane.clipIds.length === 1) {
      set(this.canvas.parentElement?.querySelector<HTMLElement>(":scope > [data-pc-snapshot-plane]"));
      return;
    }
    const root = this.player.rootElement();
    if (!root) return;
    for (const id of this.plane.clipIds) {
      set(root.querySelector<HTMLElement>(`[data-pc-clip="${CSS.escape(id)}"] > [data-pc-snapshot-plane]`));
    }
  }

  /** 这一拍流画面在不在(画了、或留着最近 3 帧内的那张)。占位符 T1 按它判 */
  get showing(): boolean { return this.lastDrawn !== null; }

  /** 这一拍画的是满帧段还是稀疏段(兜底顺序第 1 / 2 步;探针按它分级)。没画面时 null */
  get level(): "dense" | "sparse" | null {
    if (this.lastDrawn === null) return null;
    const meta = this.manifest?.segments[String(Math.floor(this.lastDrawn / SEGMENT_FRAMES))];
    return (meta?.stride ?? 1) > 1 ? "sparse" : "dense";
  }

  /** 实体框(清单的收紧矩形,没有就用上界;平面坐标)。占位符的几何按它摆 */
  get box(): StreamRect | null { return this.manifest ? this.manifest.tight ?? this.manifest.bound : null; }

  /** 这一拍:画第 F 帧(或留着最近一张 / 清成透明),再往后多解几帧 */
  present(f: number): void {
    this.wantFrame = f;
    const seg = Math.floor(f / SEGMENT_FRAMES);
    if (!rangesHave(this.plane.ranges, seg)) {
      // 这一段还没就绪:流清空,这一层当拍落到兜底顺序的下一步(父页垫的快照 / 占位符),播放头不停
      this.blank();
      this.dropFrames();
      this.nextFeed = null;
      return;
    }
    this.loadManifest();
    if (!this.manifest) { this.blank(); return; }
    const meta = this.manifest.segments[String(seg)];
    if (!meta) { this.loadManifest(true); this.blank(); return; }
    /*
     * 疑点 G:以前只在分段缺失或拉取失败时才再问清单 —— 稀疏段被满帧段替换之后,生产者发的就绪区间
     * 一个字不变,页面就一直用着稀疏段(旧文件还在 HTTP 缓存里,拉取也不失败)。现在当前段是稀疏段、
     * 或者同一个流键的就绪区间变了,就按 `MANIFEST_REFRESH_MS` 的节流再问一次;换上的满帧段在
     * 分段边界接上(`pump` 里比对文件名),不在段中间换,免得接到别的编码的差分帧上。
     */
    if (this.manifestDirty || (meta.stride ?? 1) > 1) {
      if (this.loadManifest(true)) this.manifestDirty = false;
    }
    // 往回跳(比已经放掉的帧还早)或者往前跳太远(超出已喂进去的一段):从目标所在分段的 IDR 重新解
    const far = this.nextFeed === null || f < this.discardBefore || f > this.nextFeed + SEGMENT_FRAMES;
    if (far) this.seek(f);
    if (!this.drawAt(f)) {
      // 没解出来:最近 3 帧内画过的留着(允许的退化),再远就清空、落到下面垫着的快照 / 占位符
      if (this.lastDrawn === null || f < this.lastDrawn || f - this.lastDrawn > HOLD_FRAMES) this.blank();
      else this.stats.holds++;
    }
    this.releaseBefore(f);
    this.pump();
  }

  /** 放掉目标之前的帧;之后才解出来的更早的帧一出来就关(`discardBefore` 只增不减) */
  private releaseBefore(f: number): void {
    for (const [k, h] of this.frames) {
      if (k < f) { h.frame.close(); this.frames.delete(k); }
    }
    if (f > this.discardBefore) this.discardBefore = f;
  }

  private dropFrames(): void {
    for (const h of this.frames.values()) h.frame.close();
    this.frames.clear();
  }

  /** 往解码器里喂:喂到「持有 + 队列里的」达到本流的配额,或者看得够远了 */
  pump(): void {
    if (this.disposed || this.nextFeed === null || !this.manifest || this.wantFrame === null) return;
    const cap = this.player.capFor(this);
    const horizon = this.wantFrame + 2 * SEGMENT_FRAMES;
    let guard = 0;
    for (;;) {
      if (this.nextFeed === null || this.nextFeed > horizon || guard++ >= 64) break;
      // 目标帧之前的那些(随机访问从 IDR 解过来的)一出来就关,不占配额 —— 只守住单个解码器 8 帧的硬上限;
      // 目标帧及以后的要留着画,按本流的配额喂
      const limit = this.nextFeed < this.discardBefore ? MAX_FRAMES_PER_DECODER : cap;
      if (this.heldCount >= limit) break;
      const seg = Math.floor(this.nextFeed / SEGMENT_FRAMES);
      if (!rangesHave(this.plane.ranges, seg)) break;
      const meta = this.manifest.segments[String(seg)];
      if (!meta) { this.loadManifest(true); break; }
      const data = this.segments.get(seg);
      // 清单里这一段换了文件(稀疏 → 满帧,疑点 G):只在分段起点换,段中间接着用手里这份(差分帧不能跨编码)
      const replaced = !!data && data.file !== meta.file && this.nextFeed === seg * SEGMENT_FRAMES;
      if (!data || replaced) {
        if (data) this.segments.delete(seg);
        this.loadSegment(seg);
        break;
      }
      const init = this.inits.get(data.init);
      if (!init) { this.loadInit(data.init); break; }
      if (!this.decoder || this.decoder.state === "closed") {
        this.decoder = this.newDecoder();
        this.configuredInit = null;
        if (!this.decoder) break;
      }
      if (this.configuredInit !== data.init) {
        try { this.decoder.configure(init.config); }
        catch (e) {
          this.stats.errors++;
          this.stats.lastError = String((e as Error)?.message || e);
          try { this.decoder.configure({ ...init.config, hardwareAcceleration: "no-preference" }); }
          catch { break; }
        }
        this.configuredInit = data.init;
        this.bytesPerFrame = init.bytesPerFrame;
        // 换了变体必须从这一段的 IDR 起
        const segStart = seg * SEGMENT_FRAMES;
        if (this.nextFeed !== segStart) this.nextFeed = segStart;
      }
      const index = this.nextFeed - seg * SEGMENT_FRAMES;
      const sample = data.samples[index];
      if (!sample) { this.nextFeed = (seg + 1) * SEGMENT_FRAMES; continue; }
      try {
        this.pending++;
        this.stats.maxHeld = Math.max(this.stats.maxHeld, this.heldCount);
        this.decoder.decode(new EncodedVideoChunk({
          type: sample.isSync ? "key" : "delta",
          timestamp: chunkTimestamp(this.nextFeed, this.fps),
          duration: Math.round(1e6 / this.fps),
          data: new Uint8Array(data.buf, sample.offset, sample.size),
        }));
      } catch (e) {
        this.pending = Math.max(0, this.pending - 1);
        this.stats.errors++;
        this.stats.lastError = String((e as Error)?.message || e);
        this.nextFeed = null;
        break;
      }
      this.nextFeed++;
    }
  }

  setPlane(plane: StreamPlaneRequest, canvas: HTMLCanvasElement): void {
    if (plane.key !== this.plane.key) {
      this.manifest = null;
      this.segments.clear();
      this.seek(0);
      this.nextFeed = null;
    } else if (JSON.stringify(plane.ranges ?? []) !== JSON.stringify(this.plane.ranges ?? [])) {
      // 同键、就绪区间变了:生产者发布了新分段,清单可能也换了(疑点 G)
      this.manifestDirty = true;
    }
    this.plane = plane;
    if (canvas !== this.canvas) {
      this.coverSnapshot(false);
      this.canvas = canvas;
      this.lastDrawn = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.coverSnapshot(false);
    for (const h of this.frames.values()) h.frame.close();
    this.frames.clear();
    try { if (this.decoder && this.decoder.state !== "closed") this.decoder.close(); } catch { /* 已经关了 */ }
    this.decoder = null;
    this.compositor?.clear();
    this.compositor?.dispose();
    this.compositor = null;
    this.segments.clear();
  }

  diag() {
    return { id: this.id, key: this.key, held: this.frames.size, queue: this.decoder?.decodeQueueSize ?? 0,
      decoder: this.decoder?.state ?? null, nextFeed: this.nextFeed, lastDrawn: this.lastDrawn,
      segments: [...this.segments.keys()], manifest: !!this.manifest, bound: this.manifest?.bound ?? null,
      cap: this.player.capFor(this), ...this.stats };
  }
}

const planeId = (plane: StreamPlaneRequest) => `${plane.clipIds.join(",")}#${plane.key ?? ""}`;

/* ======================================================================== *
 * 舞台上的全部流
 * ======================================================================== */

export class StreamPlayer {
  readonly source: StreamSource;
  fps = 30;
  private root: () => Element | null;
  private planes: StreamPlaneRequest[] = [];
  private tracks = new Map<string, StreamTrack>();
  private proxy = false;
  private stopped = false;
  private lastFrame: number | null = null;

  constructor({ root, source = new HttpStreamSource() }: { root: () => Element | null; source?: StreamSource }) {
    this.root = root;
    this.source = source;
  }

  /** 父页的 `setStreamPlanes`。只存,下一次 `present` 才绑画布(画布要等 React 提交之后才在) */
  setPlanes(planes: readonly StreamPlaneRequest[], fps: number): void {
    this.planes = planes.filter((p) => Array.isArray(p?.clipIds) && p.clipIds.length && typeof p.key === "string" && p.key);
    this.fps = Math.max(1, fps || 30);
    this.stopped = false;
    // 不再要的流当场关掉(解码器、持有的 VideoFrame):暂停时父页发一张空表,下一拍不一定还会来
    const keep = new Set(this.planes.map(planeId));
    for (const [id, track] of this.tracks) {
      if (!keep.has(id)) { track.dispose(); this.tracks.delete(id); }
    }
  }

  /** 实体模式开着时 `.pc-proxy` 连流平面一起藏,这里停解码、不占解码帧预算(E7 第 4 条) */
  setProxy(on: boolean): void {
    this.proxy = !!on;
    if (this.proxy) this.disposeAll();
  }

  private canvasOf(plane: StreamPlaneRequest): HTMLCanvasElement | null {
    const root = this.root();
    if (!root) return null;
    if (plane.clipIds.length === 1) {
      const id = CSS.escape(plane.clipIds[0]);
      return root.querySelector<HTMLCanvasElement>(`[data-pc-clip="${id}"] > canvas[data-pc-stream-plane]`);
    }
    const group = CSS.escape(plane.clipIds.join(","));
    return root.querySelector<HTMLCanvasElement>(`canvas[data-pc-group-plane][data-pc-stream-group="${group}"]`);
  }

  /** 场景根(组流藏 / 露成员快照平面时用) */
  rootElement(): Element | null {
    return this.root();
  }

  /**
   * 把平面和画布对上:新来的建流,没了的关掉。只收 `planesWithinBudget` 放行的那几条 ——
   * 和父页同一个函数,父页当「无流」的层这里也不建解码器。
   */
  private sync(): void {
    const want = new Map<string, { plane: StreamPlaneRequest; canvas: HTMLCanvasElement }>();
    for (const plane of planesWithinBudget(this.planes)) {
      const canvas = this.canvasOf(plane);
      if (!canvas) continue;
      want.set(planeId(plane), { plane, canvas });
    }
    for (const [id, track] of this.tracks) {
      if (!want.has(id)) { track.dispose(); this.tracks.delete(id); }
    }
    for (const [id, { plane, canvas }] of want) {
      const track = this.tracks.get(id);
      if (track) track.setPlane(plane, canvas);
      else this.tracks.set(id, new StreamTrack(this, plane, canvas));
    }
  }

  /**
   * 这一拍(K4 的节拍循环、或暂停 / 拖动的 `setTime`)。同步:手里有这一帧就当场画上,
   * 没有就留着上一张或透明,再把后面几帧的解码排上 —— **从不阻塞调用方**。
   */
  present(sec: number): void {
    if (this.stopped || this.proxy) return;
    this.sync();
    const f = Math.max(0, Math.round(sec * this.fps + 1e-6));
    this.lastFrame = f;
    for (const track of this.tracks.values()) track.present(f);
  }

  /**
   * 本流的持有上限:字节预算按流均分(≤ 80 MB 总量),夹在 [3, 8] 之间 ——
   * 8 是单个解码器的硬上限(G0-b (4)),3 是每流保底(G5)。
   */
  capFor(track: StreamTrack): number {
    const n = Math.max(1, this.tracks.size);
    const share = Math.floor(DECODED_BYTES_BUDGET / n / Math.max(1, track.bytesPerFrame));
    return Math.max(MIN_FRAMES_PER_STREAM, Math.min(MAX_FRAMES_PER_DECODER, share));
  }

  private disposeAll(): void {
    for (const track of this.tracks.values()) track.dispose();
    this.tracks.clear();
  }

  /** `setRole('back')`:停下、`close()` 全部 `VideoFrame`、清掉画布(E0 的清理全集第 3 条) */
  stop(): void {
    this.stopped = true;
    this.planes = [];
    this.disposeAll();
  }

  /**
   * 这一拍流画面在的那些卡(组流算到每个成员头上)。占位符 T1:被抑制、这一拍流 blank、
   * 又没挂快照的层才显示占位符 —— 在 `present` 之后当拍读(`StageView` 的 `refreshPlaceholders`)。
   */
  showingClips(): Set<string> {
    const out = new Set<string>();
    if (this.stopped || this.proxy) return out;
    for (const track of this.tracks.values()) {
      if (!track.showing) continue;
      for (const id of track.plane.clipIds) out.add(id);
    }
    return out;
  }

  /** 这一拍每张卡的流画面是满帧段还是稀疏段(只列有画面的;探针用) */
  levels(): Map<string, "dense" | "sparse"> {
    const out = new Map<string, "dense" | "sparse">();
    if (this.stopped || this.proxy) return out;
    for (const track of this.tracks.values()) {
      const level = track.level;
      if (level) for (const id of track.plane.clipIds) out.set(id, level);
    }
    return out;
  }

  /** 单卡流的实体框(包裹层坐标 = 平面坐标)。组流的框在舞台坐标里,不回 */
  boxOf(clipId: string): StreamRect | null {
    for (const track of this.tracks.values()) {
      if (track.plane.clipIds.length === 1 && track.plane.clipIds[0] === clipId) return track.box;
    }
    return null;
  }

  /** 此刻持有的解码帧字节(验收「解码帧总内存 ≤ 80 MB」看它) */
  heldBytes(): number {
    let bytes = 0;
    for (const track of this.tracks.values()) bytes += track.heldCount * track.bytesPerFrame;
    return bytes;
  }

  diag() {
    return { stopped: this.stopped, proxy: this.proxy, fps: this.fps, lastFrame: this.lastFrame, planes: this.planes.length,
      heldBytes: this.heldBytes(), tracks: [...this.tracks.values()].map((t) => t.diag()) };
  }
}
