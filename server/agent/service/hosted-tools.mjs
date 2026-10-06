/**
 * 云端 Agent 在服务端实现的工具(任务书 `docs/plan/cloud-agent-task.md` J;契约 `docs/plan/cloud-agent-contract.md` 第 9 节)。
 *
 * 桌面版里这些工具由页面执行,背后打编辑器进程的 `/api/*`(入库、建卡、配音……)。云节点上没有页面、也没有编辑器进程,
 * 所以在这里各做一份服务端的实现,规矩是:
 *
 *   - **本地文件只进这个对话的工作区**(`workspace.mjs`):附件、下载、合成出来的语音都落在里面,路径由工作区核;
 *   - **按模型给的地址出网只经出网闸**(`egress.mjs`);
 *   - **素材字节经素材服务**:凭这个对话的连接向文档服务要一张素材票据(权限不超过成员本人,只读成员要不到读写的),
 *     按内容哈希分片写进 `media` 命名空间;
 *   - **项目改动经文档服务**:在项目副本上改、算差异、带期望版本提交(`agent-exec.mjs` 的 `mutate`),与路由表里的工具同一条路;
 *   - **卡片源码经文档服务的内容库**(`card-source`):建卡改卡只做静态的翻译、审查与语法检查,**不在本进程里执行卡片代码**;
 *     这张卡在别的成员的浏览器与渲染节点上执行,由那两处的隔离保护(与本机 Agent 在协作项目里建卡同一条路);
 *   - **花钱的外部调用**(配音)用托管方的配置,每次记一行用量。
 *
 * 外部的等待(下载、上传、合成)都在进程级的锁之外;进锁只做同步的改项目。
 * 本文件不引用 `src/`:前端代码只经 `ssr-host.mjs`(`ctx.host()`)。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAssetClient } from '../../asset-store/client.mjs';

const SERVER_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export const HOSTED_TOOL_DEFAULTS = Object.freeze({
  /** 按地址导入素材时单个文件的上限 */
  maxImportBytes: 512 * 1024 * 1024,
  /** 下载的时限 */
  downloadMs: 120_000,
  /** 一份卡片源码的上限 */
  maxCardBytes: 256 * 1024,
  /** 项目的卡片源码多久重列一次 */
  cardListMs: 3_000,
  /** 附件里的文本内联进提示词的上限 */
  inlineTextBytes: 64 * 1024,
});

export class HostedToolError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

/* ---------------------------------------------------------------- 素材的种类与元数据 */

const EXT_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image', svg: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', m4v: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio', opus: 'audio',
};
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
};
const KIND_LABEL = { video: '视频', image: '图片', audio: '音频' };

export const extOf = (name) => (/\.([A-Za-z0-9]{1,5})$/.exec(String(name ?? ''))?.[1] ?? '').toLowerCase();
export const kindOfName = (name) => EXT_KIND[extOf(name)] ?? null;

/** 文件名里只留安全的字符(进工作区的文件名;原名另存在回包里给模型看) */
export function safeName(name, fallback = 'file') {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.normalize('NFC').replace(/[\0-\x1f<>:"|?*\\/]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').slice(0, 96);
  return cleaned || fallback;
}

/** 读文件头认图片的宽高(PNG / JPEG / GIF / WebP);认不出回 {} */
export function imageSize(buf) {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const tag = buf.toString('latin1', 12, 16);
      if (tag === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (tag === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (tag === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* 文件头不完整 */ }
  return {};
}

/** WAV 的时长(秒);`totalSize` 是整个文件的字节数(只读了文件头时给)。不是 WAV 或读不出回 undefined */
export function wavDuration(buf, totalSize = buf.length) {
  try {
    if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return undefined;
    let i = 12;
    let byteRate = 0;
    while (i + 8 <= buf.length) {
      const id = buf.toString('latin1', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === 'fmt ') byteRate = buf.readUInt32LE(i + 16);
      if (id === 'data') return byteRate > 0 ? Math.min(size, Math.max(0, totalSize - i - 8)) / byteRate : undefined;
      i += 8 + size + (size % 2);
    }
  } catch { /* 文件头不完整 */ }
  return undefined;
}

/** 找 ffprobe(与 ffmpeg 同目录,或 PATH 上);找不到回 null。结果按进程缓存 */
let ffprobeCache;
export function findFfprobe() {
  if (ffprobeCache !== undefined) return ffprobeCache;
  const cands = [];
  if (process.env.PROMPTCUT_FFPROBE) cands.push(process.env.PROMPTCUT_FFPROBE);
  if (process.env.PROMPTCUT_FFMPEG) cands.push(path.join(path.dirname(process.env.PROMPTCUT_FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
  cands.push('ffprobe');
  ffprobeCache = null;
  for (const cand of cands) {
    try {
      const r = spawnSync(cand, ['-version'], { timeout: 5000, windowsHide: true });
      if (r.status === 0 && !r.error) { ffprobeCache = cand; break; }
    } catch { /* 下一个 */ }
  }
  return ffprobeCache;
}

/** 用 ffprobe 读时长与宽高(子进程经工作区起:工作目录与环境变量都收紧) */
function ffprobeMeta(workspace, abs) {
  const bin = findFfprobe();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = workspace.spawn(bin, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', abs], { timeoutMs: 20_000 });
    } catch { return resolve(null); }
    child.stdout.on('data', (d) => { out += d; if (out.length > 1_000_000) child.kill(); });
    child.once('error', () => resolve(null));
    child.once('exit', () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
        const d = Number(j.format?.duration);
        resolve({ duration: Number.isFinite(d) && d > 0 ? d : undefined, width: v?.width || undefined, height: v?.height || undefined });
      } catch { resolve(null); }
    });
  });
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(abs).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/* ---------------------------------------------------------------- 托管方的配音配置 */

/** 托管方的配音配置放哪(与模型配置同一个目录、同一套落盘加密) */
export function voiceConfigPaths(dataDir) {
  const dir = path.join(dataDir, 'config');
  return { file: path.join(dir, 'voice.json'), keyFile: path.join(dir, 'keys', 'voice.key') };
}

/**
 * 读托管方的配音配置;没配回 null。回的对象形状与桌面版的 `readVoiceConfig()` 相同(`apiKey` 是明文,只在进程内用)。
 * Key 文件由托管方用与模型 Key 相同的办法导入(密文落盘,`server/runners/config-crypt.mjs` 的 `voice` 一类)。
 */
export async function readHostedVoiceConfig(dataDir) {
  if (!dataDir) return null;
  const { file, keyFile } = voiceConfigPaths(dataDir);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const [{ normalizeVoiceConfig }, { openKey, sealedKind }] = await Promise.all([
    import(new URL('../../voice/voice-config.mjs', import.meta.url).href),
    import(new URL('../../runners/config-crypt.mjs', import.meta.url).href),
  ]);
  const cfg = normalizeVoiceConfig(raw);
  let apiKey = '';
  try {
    const sealed = fs.readFileSync(keyFile, 'utf8').trim();
    if (sealedKind(sealed) === 'voice') apiKey = openKey(sealed, 'voice') || '';
  } catch { /* 还没导入 */ }
  return { ...cfg, effectiveBaseUrl: cfg.baseUrl, apiKey };
}

/* ---------------------------------------------------------------- 工具 */

/**
 * 进程级的那一份(各实例共用)。
 * @param {object} o
 * @param {string} o.root 仓库根目录(读内置卡源码、建卡指南)
 * @param {(id: string) => Promise<any>} o.loadModule vite 的 `ssrLoadModule`(Node 不能直接载入 TypeScript 时用它载卡片检查)
 * @param {ReturnType<import('./workspace.mjs').createWorkspaces>} o.workspaces
 * @param {ReturnType<import('./egress.mjs').createEgressGate>} o.egress
 * @param {string | null} o.assetBase 同机素材服务的地址(`http://127.0.0.1:<端口>`);没配时导入素材、配音入库做不了
 * @param {() => Promise<object | null>} o.voiceConfig 托管方的配音配置
 * @param {(row: object) => void} o.recordService 记一行外部服务的用量
 */
export function createHostedTools({
  root,
  loadModule = null,
  workspaces,
  egress,
  assetBase = null,
  voiceConfig = async () => null,
  recordService = () => {},
  fetchImpl = globalThis.fetch,
  limits: limitsIn = {},
  log = () => {},
} = {}) {
  const limits = { ...HOSTED_TOOL_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };

  /** 卡片的翻译、审查、语法检查:纯函数,在 `server/vite-plugin-cards.ts` 里(桌面版建卡用的同一份) */
  let cardLibPromise = null;
  const cardLib = () => {
    cardLibPromise ??= import(new URL('../../vite-plugin-cards.ts', import.meta.url).href).catch(async (err) => {
      // 这台机器的 Node 不能直接载入 TypeScript:借 vite 转一下(只是转译这一个服务端文件,不碰 `src/`)
      if (typeof loadModule !== 'function') throw err;
      return loadModule('/server/vite-plugin-cards.ts');
    });
    return cardLibPromise;
  };

  /**
   * 一个对话的工具上下文。
   * @param {object} c
   * @param {{ projectId: string, userId: string, username?: string }} c.identity
   * @param {string} c.ownerKey
   * @param {string} c.conversationId
   * @param {() => object} c.side `agent-side.mjs` 的那一套(执行器、连接)
   * @param {() => Promise<object>} c.host `ssr-host.mjs`
   * @param {() => { online: boolean, t: number }} c.pageState 发起方在不在线、发消息时的播放头
   * @param {() => string | null} c.runId
   * @param {{ cards: object }} c.shared 这个实例(项目 × 成员)各对话共用的:项目的卡片源码表(`newSharedState()`)
   */
  function forConversation(c) {
    const { identity, conversationId } = c;
    const agentKey = conversationId;
    const exec = () => c.side().executor;
    const workspace = () => workspaces.open({ projectId: identity.projectId, ownerKey: c.ownerKey, conversationId });

    /* ---------- 文档服务 ---------- */

    async function docRequest(message, okTypes) {
      const reply = await exec().request(agentKey, message, (m) => okTypes.includes(m.type) || m.type === 'error');
      if (reply.type === 'error') {
        const reason = reply.reason ?? 'error';
        throw new HostedToolError(reason === 'forbidden'
          ? '文档服务拒绝了这次操作:你在这个项目里没有这个权限。'
          : `文档服务没有接受这次操作(${reason})${reply.detail ? `:${reply.detail}` : ''}`, { code: reason });
      }
      return reply;
    }

    /* ---------- 素材服务 ---------- */

    function assetClient() {
      if (!assetBase) throw new HostedToolError('这台云节点没有配置素材服务的地址,云端 Agent 暂时不能把文件入库。请联系托管方。', { code: 'no-asset-service' });
      let cached = null;
      return createAssetClient({
        base: `${assetBase.replace(/\/+$/, '')}/api/asset`,
        fetch: fetchImpl,
        // 素材票据:凭这个对话的连接现要(权限不超过成员本人;只读成员要不到读写的,文档服务回 forbidden)
        ticket: async (opts) => {
          if (cached && !opts?.refresh && cached.exp - Date.now() > 20_000) return cached.ticket;
          const reply = await docRequest({ type: 'auth.ticket', kind: 'asset', access: 'rw' }, ['auth.ticket.ok']);
          cached = { ticket: reply.ticket, exp: Number(reply.exp) < 1e12 ? Number(reply.exp) * 1000 : Number(reply.exp) };
          return cached.ticket;
        },
      });
    }

    /**
     * 动手之前先确认这位成员写得进素材(只读成员要不到读写的素材票据):下载、合成(要花钱)都排在它后面,
     * 不让只读成员的对话白白占带宽、白白花托管方的钱。
     */
    async function ensureCanWrite() {
      if (!assetBase) throw new HostedToolError('这台云节点没有配置素材服务的地址,云端 Agent 暂时不能把文件入库。请联系托管方。', { code: 'no-asset-service' });
      try {
        await docRequest({ type: 'auth.ticket', kind: 'asset', access: 'rw' }, ['auth.ticket.ok']);
      } catch (err) {
        if (err?.code === 'forbidden') throw new HostedToolError('你在这个项目里只有只读权限,云端 Agent 不能替你把素材写进项目。', { code: 'forbidden' });
        throw err;
      }
    }

    /** 把工作区里的一个文件送进素材服务(`media` 命名空间);回 `{ hash, ext, bytes }` */
    async function ingest(rel) {
      const ws = workspace();
      const abs = ws.resolve(rel);
      const st = ws.stat(rel);
      if (!st) throw new HostedToolError('工作目录里没有这个文件。', { code: 'not-found' });
      if (st.size === 0) throw new HostedToolError('这个文件是空的。');
      const hash = await sha256File(abs);
      const ext = extOf(rel);
      try {
        await assetClient().putFile('media', abs, { hash, ext });
      } catch (err) {
        if (err?.code === 'forbidden' || err?.status === 403 || err?.status === 401) {
          throw new HostedToolError('素材服务拒绝了这次写入:你在这个项目里只有只读权限,云端 Agent 不能替你导入素材。', { code: 'forbidden' });
        }
        throw err;
      }
      return { hash, ext, bytes: st.size };
    }

    /** 读一个工作区文件的种类与元数据 */
    async function probe(rel, kind) {
      const ws = workspace();
      const abs = ws.resolve(rel);
      if (kind === 'image') {
        const fd = fs.openSync(abs, 'r');
        try {
          const head = Buffer.alloc(Math.min(256 * 1024, ws.stat(rel)?.size ?? 0));
          fs.readSync(fd, head, 0, head.length, 0);
          return imageSize(head);
        } finally { fs.closeSync(fd); }
      }
      const viaProbe = await ffprobeMeta(ws, abs);
      if (viaProbe) return viaProbe;
      if (extOf(rel) === 'wav') {
        const fd = fs.openSync(abs, 'r');
        try {
          const size = ws.stat(rel)?.size ?? 0;
          const head = Buffer.alloc(Math.min(1024 * 1024, size));
          fs.readSync(fd, head, 0, head.length, 0);
          const d = wavDuration(head, size);
          return d === undefined ? { probeMissing: true } : { duration: d };
        } finally { fs.closeSync(fd); }
      }
      return { probeMissing: true };
    }

    /** 素材入库后登记进项目(可选:放上时间轴);回 `{ media, clip }` */
    async function registerMedia(track, { rel, name, kind, place = null }) {
      const [up, meta] = [await ingest(rel), await probe(rel, kind)];
      let media = null;
      let clip = null;
      await exec().mutate('import_media', agentKey, track, (host) => {
        media = host.addMedia({
          kind, name,
          url: `/@media/${up.hash}`, hash: up.hash, ...(up.ext ? { ext: up.ext } : {}), size: up.bytes,
          tiers: { original: up.hash },
          ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
          ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}),
        });
        if (place) {
          const start = typeof place.start === 'number' ? Math.max(0, place.start) : (place.atEnd ? host.contentEnd() : 0);
          clip = host.addMediaClip(media.id, start, place.trackId ? { trackId: place.trackId } : {});
          if (!clip && place.required) throw new HostedToolError(`素材已入库,但放上时间轴失败 —— trackId 不对?`);
        }
        return { ok: true };
      });
      return { media, clip, meta };
    }

    /* ---------- 导入素材 ---------- */

    /**
     * 模型给的地址 → 工作区里的文件。三种:
     *   - `work:<相对路径>`:这个对话工作区里的文件(附件清单里给的就是这种);
     *   - `/@pcwork/<对话 id>/<文件名>`:桌面版的附件地址写法,只认这个对话自己的,指到 `attachments/` 下;
     *   - `http(s)://…`:经出网闸下载到 `downloads/` 下。
     */
    async function materialize(url, nameIn) {
      const ws = workspace();
      if (typeof url !== 'string' || !url) {
        throw new HostedToolError('要传附件的地址(url)。附件用用户消息末尾清单里的地址(形如 work:attachments/<文件名>);网上的文件直接传 http(s) 地址。');
      }
      if (url.startsWith('work:')) {
        const rel = url.slice(5);
        if (!ws.exists(rel)) throw new HostedToolError(`工作目录里没有 ${rel}。附件的地址以用户消息末尾的清单为准。`, { code: 'not-found' });
        return { rel, name: nameIn || rel.split('/').pop() };
      }
      const pc = /^\/@pcwork\/([^/]+)\/([^/?#]+)$/.exec(url);
      if (pc) {
        if (decodeURIComponent(pc[1]) !== conversationId) throw new HostedToolError('这个附件不属于这个对话。', { code: 'not-found' });
        const rel = `attachments/${decodeURIComponent(pc[2])}`;
        if (!ws.exists(rel)) throw new HostedToolError('这个附件不在了,请让用户重新添加。', { code: 'not-found' });
        return { rel, name: nameIn || decodeURIComponent(pc[2]) };
      }
      if (!/^https?:\/\//i.test(url)) throw new HostedToolError('地址只能是附件清单里的地址,或 http(s) 地址。');
      let name = safeName(nameIn || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download'), 'download');
      const tmpRel = `downloads/${Date.now().toString(36)}-${name}`;
      const writer = ws.writer(tmpRel);
      let res;
      try {
        res = await egress.request(url, { maxBytes: limits.maxImportBytes, timeoutMs: limits.downloadMs, onChunk: (chunk) => writer.write(chunk) });
      } catch (err) {
        writer.abort();
        if (err?.egress) throw new HostedToolError(`取不到这个地址:${err.message}`, { code: `egress-${err.code}` });
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        writer.abort();
        throw new HostedToolError(`取文件失败(HTTP ${res.status}),地址可能不对或已失效。`);
      }
      writer.end();
      // 直链常常不带扩展名:按回包的类型补一个
      let rel = tmpRel;
      const mimeExt = MIME_EXT[String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()];
      if (mimeExt && !kindOfName(name)) {
        name = `${name}.${mimeExt}`;
        rel = `${tmpRel}.${mimeExt}`;
        fs.renameSync(ws.resolve(tmpRel), ws.resolve(rel));
      }
      return { rel, name, downloaded: true };
    }

    async function importMedia(args, track) {
      await ensureCanWrite();
      const got = await materialize(args?.url, typeof args?.name === 'string' ? args.name : '');
      const kind = kindOfName(got.rel) ?? kindOfName(got.name);
      if (!kind) {
        if (got.downloaded) workspace().remove(got.rel);
        throw new HostedToolError(`无法识别文件“${got.name}”的类型,请使用视频、音频或图片文件。`);
      }
      const ps = c.pageState();
      const { media, clip, meta } = await registerMedia(track, {
        rel: got.rel, name: got.name, kind,
        // 与桌面版相同:视频导入后直接放到视频轨上。发起方在线放在他发消息时的播放头,不在线接在现有内容后面
        place: kind === 'video' ? (ps.online ? { start: ps.t } : { atEnd: true }) : null,
      });
      if (got.downloaded) workspace().remove(got.rel);
      const base = { mediaId: media.id, name: got.name, kind, kindLabel: KIND_LABEL[kind], cardUrl: media.url };
      const missing = meta.probeMissing ? ' 这台云节点上没有 ffprobe,没读出时长与尺寸;放上时间轴时请自己给 duration。' : '';
      if (kind === 'image') {
        return { ...base, width: media.width, height: media.height, hint: `图片已进“图片”素材库(没放到时间轴)。卡片参数里要用这张图就填 cardUrl。` };
      }
      if (kind === 'audio') return { ...base, duration: media.duration, hint: `音频已进素材库(没放到时间轴)。${missing}` };
      return {
        ...base, duration: media.duration, width: media.width, height: media.height, ...(clip ? { clipId: clip.id } : {}),
        hint: `已装进素材库${clip ? '并放到视频轨上' : ''}。${missing}`,
      };
    }

    /* ---------- 配音 ---------- */

    async function voiceList() {
      const cfg = await voiceConfig();
      const presets = await import(new URL('../../voice/presets.mjs', import.meta.url).href);
      const set = !!cfg?.apiKey && !!cfg?.effectiveBaseUrl;
      return {
        provider: cfg?.provider ?? presets.PROVIDERS[0],
        apiKeySet: set,
        defaults: cfg ? { minimax: cfg.minimax, kling: cfg.kling, vidu: cfg.vidu } : {},
        systemVoices: presets.SYSTEM_VOICES,
        customVoices: (cfg?.customVoices ?? []).map((v) => ({ provider: v.provider, voiceId: v.voiceId, name: v.name, kind: v.kind, note: v.note })),
        textLimits: presets.TEXT_LIMITS,
        hint: set
          ? 'voice_generate 的 voiceId 从 systemVoices / customVoices 里挑(customVoices 要配对 provider)。云端的配音用的是托管方的配置。'
          : '托管方还没有为云端 Agent 配置配音服务,voice_generate 会失败。请告诉用户联系托管方,或在电脑上的 PromptCut 里配音。',
      };
    }

    async function voiceGenerate(args, track) {
      if (!args?.text || !String(args.text).trim()) throw new HostedToolError('text 不能是空的');
      const cfg = await voiceConfig();
      if (!cfg?.apiKey || !cfg?.effectiveBaseUrl) {
        throw new HostedToolError('托管方还没有为云端 Agent 配置配音服务。请告诉用户联系托管方,或在电脑上的 PromptCut 里配音。', { code: 'no-voice-config' });
      }
      await ensureCanWrite();
      const { generateVoice } = await import(new URL('../../voice/generate.mjs', import.meta.url).href);
      const ws = workspace();
      const outDir = path.dirname(ws.resolve('voice/x'));
      const t0 = Date.now();
      const row = (out, ok) => recordService({
        t: Date.now(), projectId: identity.projectId, userId: identity.userId, username: identity.username ?? '',
        conversationId, runId: c.runId() ?? '', kind: 'service', service: 'voice',
        vendor: out?.provider ?? String(args.provider ?? cfg.provider ?? ''), model: out?.model ?? '',
        units: out?.chars ?? [...String(args.text)].length, unit: 'chars', ok, ms: Date.now() - t0,
      });
      let out;
      try {
        out = await generateVoice({
          cfg,
          args: { text: args.text, provider: args.provider, voiceId: args.voiceId, speed: args.speed, emotion: args.emotion, name: args.name },
          outDir,
          fetch: fetchImpl,
        });
      } catch (err) {
        // 参数不对(音色不在列表里、语速越界)没有发出请求,不记用量;发出去失败了的照记(服务商可能已经计费)
        if (err?.name !== 'VoiceError' || /HTTP|接口|网关|超时/.test(String(err?.message))) row(null, false);
        throw new HostedToolError(String(err?.message ?? err).slice(0, 300));
      }
      row(out, true);
      const rel = `voice/${out.name}`;
      // 生成的文件计入工作区的总量(generateVoice 自己写的盘):超了就删掉、报错
      const usage = ws.usage();
      if (usage.bytes > workspaces.limits.maxConversationBytes) { ws.remove(rel); throw new HostedToolError('这个对话的工作目录已满,语音没有保存。'); }
      const place = typeof args.start === 'number' ? { start: args.start, trackId: args.trackId, required: true } : null;
      const { media, clip } = await registerMedia(track, { rel, name: out.name, kind: 'audio', place });
      ws.remove(rel);
      return {
        mediaId: media.id, name: out.name, duration: media.duration, ...(clip ? { clipId: clip.id } : {}),
        provider: out.provider, model: out.model, voiceId: out.voiceId, chars: out.chars,
        hint: clip
          ? '已进素材库并放到时间轴。下一段的 start 接在这段 start + duration 后面。'
          : '已进素材库(没放时间轴)。要上时间轴就传 start 再生成。',
      };
    }

    /* ---------- 卡片源码(内容库 `card-source`) ---------- */

    const CARD_KIND = 'card-source';
    const USER_PREFIX = 'src/cards/user/';
    const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    /** 这个项目内容库里的卡片源码:键 → { hash, body? };入口文件解析出的定义。实例里各对话共用一份 */
    const cards = c.shared.cards;

    async function refreshCards(force = false) {
      if (!force && Date.now() - cards.at < limits.cardListMs) return cards;
      cards.pending ??= (async () => {
        try {
          const listing = await docRequest({ type: 'content.list', kind: CARD_KIND, prefix: 'src/' }, ['content.listing']);
          const next = new Map();
          for (const it of listing.items ?? []) {
            const prev = cards.items.get(it.key);
            if (prev && prev.hash === it.hash && typeof prev.body === 'string') { next.set(it.key, prev); continue; }
            const item = await docRequest({ type: 'content.get', kind: CARD_KIND, key: it.key }, ['content.item']);
            if (item.missing || typeof item.body !== 'string') continue;
            next.set(it.key, { hash: it.hash, body: item.body });
          }
          cards.items = next;
          const host = await c.host();
          const parsed = [];
          for (const [key, v] of next) {
            if (!/^src\/cards\/user\/[^/]+\.tsx$/.test(key)) continue;
            try { for (const p of host.parseCard(v.body, { key, files: (k) => next.get(k)?.body ?? null })) parsed.push(p); } catch { /* 解析不了的不登记 */ }
          }
          cards.parsed = parsed;
          cards.at = Date.now();
        } catch (err) {
          // 读不到(连接刚断、只读权限也能读;被拒说明服务端还没开这一类)时手里的表不动
          say('agent.cards.refresh-failed', { projectId: identity.projectId, message: String(err?.message ?? err).slice(0, 120) });
          cards.at = Date.now();
        } finally {
          cards.pending = null;
        }
        return cards;
      })();
      return cards.pending;
    }

    const repoFile = (rel) => {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(path.resolve(root, 'src') + path.sep)) return null;
      try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
    };
    /** 一个文件此刻生效的源码:项目内容库里有就用它,否则是检出里的那一份 */
    const effective = (rel) => cards.items.get(rel)?.body ?? repoFile(rel);

    /** 这张卡的定义文件与它一路用到的文件 */
    async function closureOf(id) {
      const lib = await cardLib();
      const userKey = `${USER_PREFIX}${id}.tsx`;
      if (cards.items.has(userKey)) {
        const host = await c.host();
        const seen = new Set([userKey]);
        const queue = [userKey];
        while (queue.length && seen.size < 60) {
          const key = queue.shift();
          const src = effective(key);
          if (typeof src !== 'string') continue;
          for (const dep of host.cardImports(src, key)) {
            if (!seen.has(dep) && lib.isEditablePath(dep) && typeof effective(dep) === 'string') { seen.add(dep); queue.push(dep); }
          }
        }
        return { defFile: userKey, closure: [...seen], builtin: false };
      }
      const defFile = lib.findCardFile(root, id);
      if (!defFile) return null;
      return { defFile, closure: lib.importClosure(root, defFile), builtin: !defFile.startsWith(USER_PREFIX) };
    }

    async function putCard(key, source) {
      if (Buffer.byteLength(source, 'utf8') > limits.maxCardBytes) throw new HostedToolError(`源码超过 ${Math.round(limits.maxCardBytes / 1024)}KB,太大了。`);
      const stored = await docRequest({ type: 'content.put', kind: CARD_KIND, key, body: source, session: `agent:${agentKey}`.slice(0, 128) }, ['content.stored']);
      cards.items.set(key, { hash: stored.hash, body: source });
      await refreshCards(true);
    }

    async function cardGuide() {
      const lib = await cardLib();
      const guide = fs.readFileSync(path.join(SERVER_DIR, 'card-authoring-guide.md'), 'utf8');
      return `${guide}\n${lib.renderCatalog()}`;
    }

    async function getCardSource(args) {
      const id = String(args?.cardId ?? args?.id ?? '');
      if (!ID_RE.test(id)) throw new HostedToolError(`卡片 id "${id}" 不合法。`);
      await refreshCards();
      const lib = await cardLib();
      const found = await closureOf(id);
      if (!found) {
        const cat = lib.readCatalogSource(id);
        if (cat) {
          return {
            ok: true, id, file: cat.entry.file, source: cat.source, lines: cat.source.split('\n').length,
            catalog: true, tier: cat.entry.tier, blockers: cat.entry.blockers, props: cat.entry.props,
            hint: `这是 Magic UI 目录里的原始源码(MIT),还不是卡。包成 CardDef、文件头写「来源: https://magicui.design/docs/components/${cat.name}」和 MIT,再用 create_card 以 id "${id}" 建卡。${cat.entry.blockers.length ? '要先处理:' + cat.entry.blockers.join('、') : ''}`,
          };
        }
        throw new HostedToolError(`找不到卡片 "${id}" 的源码。先用 list_cards 确认 id;Magic UI 目录里还没搬的组件用 mu-<name> 读(见 card_authoring_guide 末尾的目录)。`);
      }
      const target = typeof args?.file === 'string' && args.file ? args.file : found.defFile;
      if (!found.closure.includes(target)) throw new HostedToolError(`"${target}" 不在卡片 ${id} 的源码文件里。能读的是:${found.closure.join('、')}`);
      const source = effective(target);
      if (typeof source !== 'string') throw new HostedToolError(`读不到 "${target}"。`);
      return {
        ok: true, id, file: target, source, lines: source.split('\n').length, builtin: found.builtin,
        files: found.closure.map((f) => ({ file: f, ...(cards.items.has(f) ? { inProject: true } : {}) })),
        ...(found.builtin ? { hint: '这是内置卡。改它用 edit_card:改动只进这个项目(存在项目的内容库里),别的项目不受影响。' } : {}),
      };
    }

    async function createCard(args) {
      const id = args?.id;
      const source = args?.source;
      if (typeof id !== 'string' || typeof source !== 'string') throw new HostedToolError('id 和 source 都必须是字符串');
      if (!ID_RE.test(id)) throw new HostedToolError(`卡片 id "${id}" 不合法:只能是小写字母、数字和连字符,字母开头。`);
      await refreshCards(true);
      const lib = await cardLib();
      const host = await c.host();
      const key = `${USER_PREFIX}${id}.tsx`;
      const already = cards.items.has(key);
      if (already && args.overwrite !== true) {
        throw new HostedToolError(`${key} 已存在。要改它请用 get_card_source 读回源码、再用 edit_card 改那一处;确实要整张推倒重来才传 overwrite: true。`);
      }
      if (!already && host.cardIds().includes(id)) throw new HostedToolError(`卡片 id "${id}" 和已有的内置卡重复。改个 id 再试。`);
      const translated = lib.translateCardSource(source);
      const finalSource = translated.source;
      const existing = already ? [] : [...new Set([...host.cardIds(), ...cards.parsed.map((p) => p.id)])];
      const check = lib.checkCardSource(id, finalSource, existing, { vendored: translated.rewrites.length > 0, mode: 'author', before: '' });
      if (!check.ok) {
        throw new HostedToolError(check.errors.join('\n'), { errors: check.errors, findings: check.findings ?? [], rewrites: translated.rewrites });
      }
      const declared = new Set([...finalSource.matchAll(/\bkey:\s*["']([^"']+)["']/g)].map((m) => m[1]));
      const suggestedControls = lib.suggestControls(finalSource).filter((s) => !declared.has(s.key));
      await putCard(key, finalSource);
      const known = cards.parsed.some((p) => p.id === id);
      say('agent.card.create', { projectId: identity.projectId, overwritten: already });
      return {
        ok: true, id, file: key, overwritten: already, rewrites: translated.rewrites, suggestedControls,
        ...(check.findings?.length ? { findings: check.findings } : {}),
        source: finalSource, lines: finalSource.split('\n').length,
        hint: `已存进这个项目的卡片库,所有成员都会收到。要再改它请用 edit_card 做局部替换,不要用 create_card 整篇重写。${known ? '' : ' 注意:云端没能从源码里静态读出这张卡的参数表(id、name、defaults、controls 要写成字面量),add_clip 暂时认不出它,请把它们改成字面量。'}`,
      };
    }

    async function editCard(args) {
      const { file, find, replace, replaceAll } = args ?? {};
      const id = args?.cardId ?? args?.id;
      if (typeof id !== 'string' || typeof find !== 'string' || typeof replace !== 'string') throw new HostedToolError('cardId、find、replace 都必须是字符串');
      if (!ID_RE.test(id)) throw new HostedToolError(`卡片 id "${id}" 不合法。`);
      await refreshCards(true);
      const lib = await cardLib();
      const found = await closureOf(id);
      if (!found) throw new HostedToolError(`找不到卡片 "${id}" 的源码。先用 get_card_source 确认 id 和能改的文件。`);
      const target = typeof file === 'string' && file ? file : found.defFile;
      if (!found.closure.includes(target) || !lib.isEditablePath(target)) {
        throw new HostedToolError(`"${target}" 不是卡片 ${id} 的源码文件,不能改。能改的是:${found.closure.join('、')}`);
      }
      const before = effective(target);
      if (typeof before !== 'string') throw new HostedToolError(`读不到 "${target}"。`);
      const patch = lib.applyCardPatch(before, find, replace, replaceAll === true);
      if (!patch.ok) throw new HostedToolError(patch.error);
      const isUserDef = target === found.defFile && found.defFile.startsWith(USER_PREFIX);
      const check = isUserDef ? lib.checkCardSource(id, patch.after, [], { mode: 'author', before }) : lib.checkSourceEdit(target, before, patch.after);
      if (!check.ok) throw new HostedToolError(check.errors.join('\n'), { errors: check.errors });
      await putCard(target, patch.after);
      say('agent.card.edit', { projectId: identity.projectId, builtin: found.builtin });
      return {
        ok: true, id, file: target, replaced: patch.replaced, source: patch.after, builtin: found.builtin,
        hint: found.builtin
          ? '已改写,改动存在这个项目的内容库里(只影响这个项目),所有成员都会收到。'
          : '已改写,所有成员都会收到。',
      };
    }

    const TOOLS = {
      import_media: importMedia,
      voice_list: voiceList,
      voice_generate: voiceGenerate,
      card_authoring_guide: cardGuide,
      get_card_source: getCardSource,
      create_card: createCard,
      edit_card: editCard,
    };

    return {
      has: (tool) => Object.hasOwn(TOOLS, tool),
      /** 执行一个在服务端实现的工具。`track` 是这次调用的事件上下文(落地的写入记在它上面) */
      call(tool, args, track) {
        return TOOLS[tool](args ?? {}, track ?? {});
      },
      /** 进锁前调:把这个项目的卡片源码列一遍(有变才取正文) */
      refreshCards,
      workspace,
    };
  }

  return {
    forConversation,
    /** 一个实例(项目 × 成员)里各对话共用的状态 */
    newSharedState: () => ({ cards: { at: -Infinity, items: new Map(), parsed: [], pending: null } }),
    /** 测试用:把 ffprobe 的缓存清掉 */
    _resetFfprobe() { ffprobeCache = undefined; },
  };
}

/* ---------------------------------------------------------------- 附件 */

const TEXT_EXT = new Set(['txt', 'md', 'srt', 'vtt', 'json', 'csv', 'ass', 'lrc']);

/**
 * 把页面传来的一个附件存进对话的工作区(`attachments/` 下)。回 `{ name, url, size, kind, text? }`:
 * `url` 是交给模型用的地址(`work:attachments/<文件名>`),不是磁盘路径。
 * @param {ReturnType<ReturnType<typeof import('./workspace.mjs').createWorkspaces>['open']>} workspace
 * @param {string} nameIn 页面报的文件名
 * @param {AsyncIterable<Buffer>} stream
 */
export async function saveAttachment(workspace, nameIn, stream, { maxBytes = HOSTED_TOOL_DEFAULTS.maxImportBytes, inlineTextBytes = HOSTED_TOOL_DEFAULTS.inlineTextBytes } = {}) {
  const name = safeName(nameIn, 'attachment');
  let rel = `attachments/${name}`;
  for (let i = 1; workspace.exists(rel) && i < 100; i += 1) {
    const ext = extOf(name);
    rel = `attachments/${ext ? name.slice(0, -(ext.length + 1)) : name}-${i}${ext ? `.${ext}` : ''}`;
  }
  const writer = workspace.writer(rel);
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new HostedToolError('附件太大了。', { code: 'too-large' });
      writer.write(chunk);
    }
  } catch (err) {
    writer.abort();
    throw err;
  }
  writer.end();
  if (size === 0) { workspace.remove(rel); throw new HostedToolError('附件是空的。', { code: 'bad-request' }); }
  const ext = extOf(rel);
  const out = { name: rel.slice('attachments/'.length), url: `work:${rel}`, size, kind: kindOfName(rel) ?? (TEXT_EXT.has(ext) ? 'text' : 'file') };
  if (TEXT_EXT.has(ext) && size <= inlineTextBytes) {
    try { out.text = workspace.read(rel).toString('utf8'); } catch { /* 读不出就不内联 */ }
  }
  return out;
}

/** 这条消息带的附件 → 拼进提示词的那一段(只认这个对话工作区里真有的文件;不给磁盘路径) */
export function attachmentsPrompt(workspace, attachments, { inlineTextBytes = HOSTED_TOOL_DEFAULTS.inlineTextBytes } = {}) {
  const lines = [];
  for (const a of Array.isArray(attachments) ? attachments.slice(0, 32) : []) {
    const url = typeof a?.url === 'string' ? a.url : '';
    if (!url.startsWith('work:attachments/')) continue;
    const rel = url.slice(5);
    let st = null;
    try { st = workspace.stat(rel); } catch { st = null; }
    if (!st) continue;
    const kind = kindOfName(rel);
    let line = `- [${kind ? KIND_LABEL[kind] : '文件'}] ${rel.slice('attachments/'.length)} · 地址 ${url}`;
    if (TEXT_EXT.has(extOf(rel)) && st.size <= inlineTextBytes) {
      try { line += `\n\`\`\`\n${workspace.read(rel).toString('utf8')}\n\`\`\``; } catch { /* 读不出就不内联 */ }
    }
    lines.push(line);
  }
  if (!lines.length) return '';
  return `\n\n附件(在这个对话的工作目录里,不在素材库;要剪辑、转写或配动效,先用 import_media 传它的地址装进素材库):\n${lines.join('\n')}`;
}
