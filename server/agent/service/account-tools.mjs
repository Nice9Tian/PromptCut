/**
 * 账号模式下一条任务的工具提供者(0.7.18「云端 Agent 工具表接线」,计划 `docs/plan/cloud-agent-tools-implementation.md` 拆包表最后一行)。
 *
 * 八个工具包(镜头识别、语音转写、运动追踪与贴运动、主体识别、后台作业状态与一键流程、网页操作、发起人页面的反向通道、
 * 采集登录与代下)各自交了一个提供者模块。这里把它们建在**真正跑这条任务的进程**里:
 *
 *   - 用的是执行器给这条任务的那一份可信运行上下文(八个字段,由文档服务当前的任务授权算出),以及同一个运行资源登记器、
 *     同一份「项目素材」、同一份作业账本;工具参数里的项目、路径、页面号一律不认;
 *   - 项目一侧的读写(素材记录、镜头、主体、文字稿、落卡、贴运动)接到这条任务的项目副本上:读副本,写入在进程级的锁里改、
 *     算差异、带期望版本提交给文档服务(`agent-exec.mjs` 的 `mutate`),写之前再向文档服务核一次这条任务此刻能写;
 *   - 前端代码只经 `ssr-host.mjs` 的载入缝取(内核函数经各工厂的 `kernel` 注入),本文件不引用 `src/`;
 *   - 发起人页面的反向通道登记表在主服务,这里只有一个薄客户端(`worker-page-client.mjs`);没有给它的配置(没有内部通道)
 *     就不建那一族,工具照旧回「发起方不在线」,不拿别的东西冒充;
 *   - 一族建不出来(缺依赖、缺配置)只是那一族不算「已接上」,别的族照常。节点没装 Python、ffmpeg、浏览器不算建不出来:
 *     提供者照样建,工具照样交给模型,由它如实回「这台节点没配 / 用不了」。
 *
 * 一条任务一份:随任务建、随任务收。账本与追踪结果、委托记录放在这个对话自己的目录里(`<数据目录>/tenants/<项目>/conversations/<对话>/tools/`),
 * 同一个对话同一时刻只有一条任务在跑,所以「打开时把上一个进程没收尾的作业标成被中断」不会碰到别的活着的进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createToolJobs } from './tool-jobs.mjs';
import { createShotsTools, readShotsConfig } from './perception/shots.mjs';
import { createSubjectTools, readSubjectConfig } from './perception/subject.mjs';
import { createSttTools } from './perception/stt.mjs';
import { createTrackTools, TRACK_ERROR_TEXT } from './perception/track.mjs';
import { createMotionTools } from './hosted-motion.mjs';
import { createWorkflowTools } from './hosted-workflow.mjs';
import { createHostedBrowserTools, hostedBrowserDir } from './hosted-browser.mjs';
import { createPageControlTools } from './page-bridge.mjs';
import { createHandoffTools } from './hosted-handoff.mjs';
import { createCollectBridge, collectPageTools } from './collect-bridge.mjs';
import { readCollectConfig } from './hosted-collect.mjs';
import { CLOUD_PROVIDER_FAMILIES } from './cloud-tools.mjs';

export const ACCOUNT_TOOL_DEFAULTS = Object.freeze({
  /** 一轮说完话以后,最多等它名下还没做完的后台作业多久(各作业自己另有时限;这只是防卡死的兜底) */
  settleMs: 60 * 60_000,
  /** 等后台作业时多久看一次账本 */
  settlePollMs: 500,
});

/** 设置文件里 `tools` 一节认的键(部署者写;都是这台节点上的路径与开关,不是模型给的) */
export const ACCOUNT_TOOL_SETTING_KEYS = Object.freeze([
  'PROMPTCUT_FFMPEG', 'PROMPTCUT_FFPROBE',
  'PROMPTCUT_AGENT_SHOTS_PYTHON', 'PROMPTCUT_AGENT_SHOTS_MODELS', 'PROMPTCUT_AGENT_SHOTS_PYLIBS',
  'PROMPTCUT_AGENT_SUBJECT_PYTHON', 'PROMPTCUT_AGENT_SUBJECT_MODELS', 'PROMPTCUT_AGENT_SUBJECT_PYLIBS',
  'PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS', 'PROMPTCUT_AGENT_SUBJECT_WHEELHOUSE',
  'PROMPTCUT_AGENT_STT_PYTHON', 'PROMPTCUT_AGENT_STT_MODELS', 'PROMPTCUT_AGENT_STT_PYLIBS',
  'PROMPTCUT_AGENT_STT_REQUIREMENTS', 'PROMPTCUT_AGENT_STT_INDEX_URL',
  'PROMPTCUT_AGENT_TRACK_PYTHON', 'PROMPTCUT_AGENT_TRACK_MODELS', 'PROMPTCUT_AGENT_TRACK_PYLIBS',
  'PROMPTCUT_AGENT_BROWSER', 'PROMPTCUT_AGENT_BROWSER_ARGS',
  'PROMPTCUT_AGENT_COLLECT_PYTHON',
  'PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES',
]);

const coded = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const absoluteFile = (value) => typeof value === 'string' && path.isAbsolute(value) && fs.existsSync(value);

/** 形状检查:只许上面列的键,值都是不带换行的字符串。回整理过的那一份;不合规矩抛错(入口据此拒绝启动) */
export function validateAccountToolSettings(tools) {
  if (tools === undefined || tools === null) return {};
  if (typeof tools !== 'object' || Array.isArray(tools)) throw coded('account-worker-settings-tools');
  const out = {};
  for (const [key, value] of Object.entries(tools)) {
    if (!ACCOUNT_TOOL_SETTING_KEYS.includes(key) || typeof value !== 'string' || !value || value.length > 2000 || /[\r\n\0]/.test(value))
      throw coded('account-worker-settings-tools', `tools 里的 ${String(key).slice(0, 60)} 不认或值不对`);
    out[key] = value;
  }
  return out;
}

/**
 * 把设置里的 `tools` 一节读成各工具包要的节点配置。写了但不对(路径不存在等)抛错:入口拒绝启动,不悄悄变成「没配」。
 * 没写的族是 null:提供者照样建,工具自己回「这台节点没配」。
 * @param {Record<string, string>} tools `validateAccountToolSettings` 认的那份
 */
export function readAccountToolConfig(tools, { root }) {
  const env = validateAccountToolSettings(tools);
  const bad = (detail) => { throw coded('account-worker-settings-tools', detail); };
  const shots = readShotsConfig(env, { root });
  if (shots?.error) bad(shots.error);
  const subject = readSubjectConfig(env, { root });
  if (subject?.error) bad(subject.error);
  const ffmpegDir = env.PROMPTCUT_FFMPEG && path.isAbsolute(env.PROMPTCUT_FFMPEG) ? path.dirname(env.PROMPTCUT_FFMPEG) : null;
  const dirOrNull = (name) => {
    const value = env[name];
    if (!value) return null;
    if (!path.isAbsolute(value)) bad(`${name} 要是绝对路径`);
    return value;
  };
  let stt = null;
  if (env.PROMPTCUT_AGENT_STT_PYTHON) {
    if (!absoluteFile(env.PROMPTCUT_AGENT_STT_PYTHON)) bad('PROMPTCUT_AGENT_STT_PYTHON 要是存在的解释器的绝对路径');
    const requirements = env.PROMPTCUT_AGENT_STT_REQUIREMENTS;
    if (requirements && !absoluteFile(requirements)) bad('PROMPTCUT_AGENT_STT_REQUIREMENTS 要是存在的清单文件的绝对路径');
    stt = { pythonPath: env.PROMPTCUT_AGENT_STT_PYTHON, sourceRoot: path.join(root, 'python'),
      ...(dirOrNull('PROMPTCUT_AGENT_STT_PYLIBS') ? { pylibs: dirOrNull('PROMPTCUT_AGENT_STT_PYLIBS') } : {}),
      ...(dirOrNull('PROMPTCUT_AGENT_STT_MODELS') ? { modelsDir: dirOrNull('PROMPTCUT_AGENT_STT_MODELS') } : {}),
      ...(ffmpegDir ? { ffmpegDir } : {}),
      ...(requirements ? { requirements: { 'faster-whisper': requirements } } : {}),
      ...(env.PROMPTCUT_AGENT_STT_INDEX_URL ? { indexUrl: env.PROMPTCUT_AGENT_STT_INDEX_URL } : {}) };
  }
  let track = null;
  if (env.PROMPTCUT_AGENT_TRACK_PYTHON) {
    if (!absoluteFile(env.PROMPTCUT_AGENT_TRACK_PYTHON)) bad('PROMPTCUT_AGENT_TRACK_PYTHON 要是存在的解释器的绝对路径');
    track = { executable: env.PROMPTCUT_AGENT_TRACK_PYTHON, packageRoot: path.join(root, 'python'),
      ...(dirOrNull('PROMPTCUT_AGENT_TRACK_PYLIBS') ? { pylibs: dirOrNull('PROMPTCUT_AGENT_TRACK_PYLIBS') } : {}),
      ...(dirOrNull('PROMPTCUT_AGENT_TRACK_MODELS') ? { models: dirOrNull('PROMPTCUT_AGENT_TRACK_MODELS') } : {}),
      ...(env.PROMPTCUT_FFMPEG ? { ffmpeg: env.PROMPTCUT_FFMPEG } : {}) };
  }
  let browser = {};
  if (env.PROMPTCUT_AGENT_BROWSER) {
    if (!absoluteFile(env.PROMPTCUT_AGENT_BROWSER)) bad('PROMPTCUT_AGENT_BROWSER 要是存在的浏览器可执行文件的绝对路径');
    browser = { executablePath: env.PROMPTCUT_AGENT_BROWSER,
      ...(env.PROMPTCUT_AGENT_BROWSER_ARGS ? { extraArgs: env.PROMPTCUT_AGENT_BROWSER_ARGS.split(/\s+/).filter(Boolean) } : {}) };
  }
  const collect = readCollectConfig(env, { root });
  if (collect?.error) bad(collect.error);
  const stages = env.PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES;
  const optionalStages = stages ? stages.split(',').map((name) => name.trim()).filter(Boolean) : null;
  if (optionalStages && optionalStages.some((name) => !['transcribe', 'shots', 'subjects', 'compose', 'prerender'].includes(name)))
    bad('PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES 只能是 transcribe、shots、subjects、compose、prerender 里的几个,用逗号隔开');
  return { shots, subject, stt, track, browser, collect, ...(optionalStages ? { workflow: { optionalStages } } : {}) };
}

/** 这个对话放工具状态(账本、追踪结果、委托记录)的目录 */
export const accountToolStateDir = (dataDir, projectId, conversationId) =>
  path.join(dataDir, 'tenants', projectId, 'conversations', conversationId, 'tools');

/** 主服务(或别的进程)留给这个对话的「浏览器数据要清」记号。放在浏览器目录里,清的时候一起没 */
export const BROWSER_PURGE_MARK = 'purge.json';
export function readBrowserPurgeMark(dataDir, scope) {
  try {
    const mark = JSON.parse(fs.readFileSync(path.join(hostedBrowserDir(dataDir, scope), BROWSER_PURGE_MARK), 'utf8'));
    return mark && typeof mark.reason === 'string' ? mark : null;
  } catch { return null; }
}

/**
 * @param {object} o
 * @param {string} o.root 仓库根目录
 * @param {string} o.dataDir 各代任务进程共用的数据目录
 * @param {object} o.context 这条任务的可信运行上下文(执行器给的,`resources.contextFor`)
 * @param {object} o.resources 运行资源登记器(`run-resources.mjs`)
 * @param {object} o.projectAssets 这条任务的「项目素材」(`project-assets.mjs`)
 * @param {object} o.workspaces 工作区(`workspace.mjs`),`ownerKey` 是这个对话的那一个
 * @param {object} o.egress 出网闸
 * @param {() => object} o.exec 这条任务的工具执行器(`agent-exec.mjs`;项目副本绑好之后才能取)
 * @param {() => Promise<object>} o.host `ssr-host.mjs`
 * @param {object} [o.config] `readAccountToolConfig` 读出来的节点配置
 * @param {object | null} [o.pageBridge] 反向通道的薄客户端(`worker-page-client.mjs`);没有内部通道就是 null
 * @param {(row: object) => void} [o.record] 记一行用量(`usage.mjs` 的 `kind: 'service'` 那一种)
 * @param {(t: number) => void} [o.onPlayhead] `seek` 做成后告诉宿主这个对话的播放头变了
 */
export async function createAccountToolset({ root, dataDir, context, resources, projectAssets, workspaces, ownerKey, egress,
  exec, host, config = {}, pageBridge = null, record = () => {}, onPlayhead = null, identity = {},
  limits: limitsIn = {}, now = Date.now, log = () => {} } = {}) {
  if (typeof root !== 'string' || typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !context || typeof context.projectId !== 'string' ||
      typeof resources?.authorize !== 'function' || typeof resources.register !== 'function' || typeof projectAssets?.openRead !== 'function' ||
      typeof workspaces?.open !== 'function' || typeof exec !== 'function' || typeof host !== 'function')
    throw coded('account-tools-configuration');
  const limits = { ...ACCOUNT_TOOL_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  const scope = Object.freeze({ projectId: context.projectId, conversationId: context.conversationId });
  const agentKey = context.conversationId;
  const stateDir = accountToolStateDir(dataDir, context.projectId, context.conversationId);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const workspace = () => workspaces.open({ projectId: context.projectId, ownerKey, conversationId: context.conversationId });
  const workspaceFor = (ctx) => { if (ctx?.runGrantId !== context.runGrantId) throw coded('tool-context-untrusted'); return workspace(); };

  /* ---------- 授权:记下最近一次看到的栅栏版本(这一轮被收回后,账本里的作业要凭它标成「随任务取消」) ---------- */

  let lastFence = null;
  let cancelling = false;
  const authorize = async (ctx, action) => {
    const out = await resources.authorize(ctx, action);
    if (ctx?.runGrantId === context.runGrantId && Number.isSafeInteger(out?.fenceRevision)) lastFence = out.fenceRevision;
    return out;
  };
  const trackedResources = Object.freeze({ ...resources, authorize, contextAccess: Object.freeze({ ...(resources.contextAccess ?? {}), authorize }) });
  /** 账本要的「这个栅栏版本此刻算不算数」:平时现问文档服务;宿主叫停这一轮时(授权已经不在了)认最后看到的那一个 */
  const verifyFence = async (ctx, revision) => {
    try { return (await authorize(ctx, 'read')).fenceRevision === revision; }
    catch (error) {
      if (cancelling && ctx?.runGrantId === context.runGrantId && error?.code !== 'run-authority-unavailable') return lastFence === revision;
      throw error;
    }
  };

  /* ---------- 项目一侧 ---------- */

  const originalHash = (media) => media?.tiers?.original ?? media?.hash ?? null;
  /** 取字节时文档服务给的素材版本 → 那一份字节是谁(素材号、哈希)。写回时凭它核「还是同一份素材」 */
  const seenRevs = new Map();
  const assets = Object.freeze({ ...projectAssets,
    async openRead(ctx, mediaId, options) {
      const read = await projectAssets.openRead(ctx, mediaId, options);
      if (typeof read?.mediaRev === 'string' && typeof read.assetRef?.hash === 'string') {
        seenRevs.set(read.mediaRev, { mediaId, hash: read.assetRef.hash });
        if (seenRevs.size > 256) seenRevs.delete(seenRevs.keys().next().value);
      }
      return read;
    } });
  const same = (ctx) => { if (ctx?.runGrantId !== context.runGrantId || ctx.projectId !== context.projectId) throw coded('tool-context-untrusted'); };
  const snapshot = async () => exec().snapshot(agentKey);
  const mediaIn = (project, mediaId) => (Array.isArray(project?.media) ? project.media.find((m) => m?.id === mediaId) : null) ?? null;

  /**
   * 在项目副本上改一处并提交。提交之前向文档服务核这条任务此刻能写;调用方带了它刚核过的栅栏版本时,与此刻的对一遍账
   * (对不上就不提交)。文档服务拒绝过期的写入时如实抛出去,不覆盖别人的改动。
   */
  async function commit(tool, apply, { fenceRevision = null, track = {} } = {}) {
    const auth = await authorize(context, 'write');
    if (fenceRevision !== null && auth.fenceRevision !== fenceRevision) throw coded('fence-changed', '这条任务的授权在提交前变了,没有写进项目。');
    return exec().mutate(tool, agentKey, track ?? {}, apply);
  }

  const project = {
    async getMedia(ctx, mediaId) {
      same(ctx);
      const media = mediaIn((await snapshot()).project, mediaId);
      if (!media) return null;
      return { ...media, mediaRev: sha256(JSON.stringify([context.projectId, media.id, originalHash(media), media.size ?? null])) };
    },
    async getStage(ctx) {
      same(ctx);
      const p = (await snapshot()).project;
      return { width: p?.width, height: p?.height };
    },
    async getTimeline(ctx) {
      same(ctx);
      const snap = await snapshot();
      return { projectRev: snap.rev, tracks: (snap.project?.tracks ?? []).map((t) => ({ id: t.id,
        clips: (t.clips ?? []).map((c) => ({ id: c.id, mediaId: c.mediaId, start: c.start, end: c.end, mediaOffset: c.mediaOffset })) })) };
    },
    async setMediaShots(ctx, { mediaId, expectedMediaRev, shots }) { same(ctx); return writeMedia('detect_shots', mediaId, expectedMediaRev, (h) => h.media.setShots(mediaId, shots)); },
    async setMediaSubjects(ctx, { mediaId, expectedMediaRev, subjects }) { same(ctx); return writeMedia('detect_subjects', mediaId, expectedMediaRev, (h) => h.media.setSubjects(mediaId, subjects)); },
    /** 一键流程落卡:整份全进或全不进(一次提交)。版本对不上抛 `project-changed`,由调用方重读重算 */
    async applyEdits(ctx, input) {
      same(ctx);
      const snap = await snapshot();
      if (input.expectedProjectRev !== snap.rev) throw coded('project-changed');
      const placed = [];
      let captionClipId = null;
      let out;
      try {
        out = await commit('auto_workflow', (h) => {
          for (const card of input.cards ?? []) {
            const clip = h.workflow.addCardClip(card.cardId, card.start, { duration: card.duration, params: card.params });
            placed.push(clip ? { clipId: clip.id, start: clip.start, end: clip.end } : null);
          }
          if (input.caption) {
            // 字幕单独一条序列,建在最上层(与桌面版相同)
            const captionTrack = h.workflow.ensureCaptionTrack();
            const clip = h.workflow.addCardClip('caption-track', input.caption.start, { duration: input.caption.duration, trackId: captionTrack.id, params: input.caption.params });
            captionClipId = clip?.id ?? null;
          }
          const p = h.getProject();
          const end = Math.max(0, ...(p.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => c.end)));
          if (end > p.duration) h.workflow.setProjectMeta({ duration: end });
          return { ok: true };
        }, { fenceRevision: Number.isSafeInteger(input.fenceRevision) ? input.fenceRevision : null });
      } catch (error) {
        // 文档服务说期间有人改过(过期的写入被拒):按「版本对不上」交回去
        if (error?.name === 'StaleWriteError' || error?.code === 'stale') throw coded('project-changed');
        throw error;
      }
      return { projectRev: Number.isSafeInteger(out?.rev) ? out.rev : (await snapshot()).rev, clips: placed, captionClipId };
    },
  };
  async function writeMedia(tool, mediaId, expectedMediaRev, write) {
    const expected = seenRevs.get(expectedMediaRev) ?? null;
    const out = await commit(tool, (h) => {
      const media = mediaIn(h.getProject(), mediaId);
      if (!media) throw coded('media-missing');
      // 取字节之后素材被换成了别的内容:这次的结果是旧画面的,不写
      if (!expected || expected.mediaId !== mediaId || originalHash(media) !== expected.hash) throw coded('media-changed');
      write(h);
      return { ok: true };
    });
    return { projectRev: out?.rev };
  }
  async function commitTranscript(ctx, { mediaId, assetHash, transcript }) {
    same(ctx);
    await commit('transcribe_media', (h) => {
      const media = mediaIn(h.getProject(), mediaId);
      if (!media) throw coded('media-missing');
      if (originalHash(media) !== assetHash) throw coded('media-changed');
      h.media.setTranscript(mediaId, transcript);
      return { ok: true };
    });
    return { committed: true };
  }

  /**
   * 代下的回执核实过之后,把那份已经在本项目素材库里的字节登记进项目(不再传字节)。视频照导入的规矩接在现有内容后面放一段。
   * 同一个登记请求号不登记两次。时长、宽高是发起人的电脑报的,这里原样记,没有再量。
   */
  const registered = new Map();
  async function registerCollected(entry) {
    const key = String(entry?.requestId ?? '');
    if (registered.has(key)) return registered.get(key);
    const ref = entry?.assetRef;
    if (!key || ref?.projectId !== context.projectId || typeof ref.hash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.hash) ||
        !['video', 'audio', 'image'].includes(entry.kind) || typeof entry.name !== 'string' || !entry.name) throw coded('collect-register-invalid');
    let media = null, clip = null;
    await commit('collect_download', (h) => {
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
      media = h.addMedia({ kind: entry.kind, name: entry.name.slice(0, 200), url: `/@media/${ref.hash}`, hash: ref.hash,
        ...(typeof entry.ext === 'string' && /^[a-z0-9]{1,8}$/.test(entry.ext) ? { ext: entry.ext } : {}), size: ref.size, tiers: { original: ref.hash },
        ...(num(entry.duration) ? { duration: num(entry.duration) } : {}), ...(num(entry.width) ? { width: num(entry.width) } : {}), ...(num(entry.height) ? { height: num(entry.height) } : {}) });
      if (entry.kind === 'video') clip = h.addMediaClip(media.id, h.contentEnd(), {});
      return { ok: true };
    });
    const out = { mediaId: media.id, kind: entry.kind, ...(clip ? { clipId: clip.id } : {}) };
    registered.set(key, out);
    return out;
  }

  /* ---------- 建提供者 ---------- */

  const kernel = (await host()).kernel;
  const providers = new Map();      // 族 → 提供者
  const byTool = new Map();         // 工具名 → 族
  const closers = [];               // 收的顺序与建的顺序相反的那一批,另按下面 close() 里写死的次序
  const skipped = {};
  const mount = (family, build) => {
    try {
      const provider = build();
      if (!provider) return null;
      const names = CLOUD_PROVIDER_FAMILIES[family] ?? [];
      // 表里这一族的工具它得全认;认不全说明两边对不上,这一族不算接上
      if (names.some((name) => !provider.handles?.has?.(name))) throw coded('account-tools-family-mismatch');
      providers.set(family, provider);
      for (const name of names) byTool.set(name, family);
      return provider;
    } catch (error) {
      skipped[family] = typeof error?.code === 'string' ? error.code : 'error';
      say('agent.account-tools.skipped', { family, code: skipped[family] });
      return null;
    }
  };

  const jobs = createToolJobs({ databasePath: path.join(stateDir, 'tool-jobs.db'), authorize, verifyFence, now });
  closers.push(() => jobs.close());

  const stt = mount('stt', () => createSttTools({ resources: trackedResources, assets, jobs, workspace: workspaceFor, commitTranscript,
    runtime: config.stt ?? {}, limits: { engines: ['faster-whisper'], ...(limitsIn.stt ?? {}) }, now }));
  const shots = mount('shots', () => createShotsTools({ config: config.shots ?? null, resources: trackedResources, assets, jobs, workspace: workspaceFor,
    project, kernel, limits: limitsIn.shots ?? {}, now, log }));
  const subject = mount('subject', () => createSubjectTools({ config: config.subject ?? null, resources: trackedResources, assets, jobs, workspace: workspaceFor,
    project, egress, kernel, limits: limitsIn.subject ?? {}, now, log }));
  const track = mount('track', () => createTrackTools({ contextAccess: trackedResources.contextAccess, resources: trackedResources, jobs, assets, workspace: workspaceFor,
    databasePath: path.join(stateDir, 'track-results.db'), python: config.track ?? null,
    readProject: async (ctx) => { same(ctx); return (await snapshot()).project; },
    // 云端不替用户安装拓展:缺省不开(部署者要开得另给出网闸与锁定清单,这一期不接)
    install: { enabled: false, env: {} }, egress, limits: limitsIn.track ?? {}, now }));
  mount('motion', () => (track ? createMotionTools({ contextAccess: trackedResources.contextAccess, tracks: track,
    commit: ({ context: ctx, fenceRevision, tool, apply }) => { same(ctx); return commit(tool, apply, { fenceRevision, track: callTrack() }); } }) : null));
  mount('workflow', () => createWorkflowTools({ resources: trackedResources, jobs, workspace: workspaceFor,
    providers: { stt: stt ?? null, shots: shots ?? null, subject: subject ?? null }, project,
    // 「发布预渲染任务」这一阶段保持注入的接缝,这一期不配(渲染那一带另有改动):阶段标「用不了」,不算失败
    prerender: null, kernel: { getCard: kernel.getCard }, errorTexts: { 'track.': TRACK_ERROR_TEXT },
    limits: { ...(config.workflow ?? {}), ...(limitsIn.workflow ?? {}) }, now, log }));
  const web = mount('web', () => createHostedBrowserTools({ resources: trackedResources, egress, dataDir, runtime: config.browser ?? {},
    limits: limitsIn.web ?? {}, log, now }));
  let collectBridge = null;
  if (pageBridge) {
    mount('page', () => createPageControlTools({ bridge: pageBridge, now,
      onPlayhead: (ctx, t) => { if (ctx?.runGrantId === context.runGrantId) { try { onPlayhead?.(t); } catch { /* 宿主的事 */ } } } }));
    mount('handoff', () => (web ? createHandoffTools({ bridge: pageBridge, browser: web, now }) : null));
    // 采集登录与代下:委托逻辑在这个进程里(它要用这条任务的「项目素材」与写权限核对),经薄客户端问主服务的反向通道
    try {
      collectBridge = createCollectBridge({ bridge: pageBridge, databasePath: path.join(stateDir, 'collect-delegations.sqlite'),
        assets: { verifyRef: (ctx, ref) => projectAssets.verifyRef(ctx, ref) }, authorize,
        register: (ctx, entry) => { same(ctx); return registerCollected(entry); }, now, log });
      for (const name of CLOUD_PROVIDER_FAMILIES.collect ?? []) byTool.set(name, 'collect');
    } catch (error) { skipped.collect = typeof error?.code === 'string' ? error.code : 'error'; say('agent.account-tools.skipped', { family: 'collect', code: skipped.collect }); }
  } else {
    for (const family of ['page', 'handoff', 'collect']) skipped[family] = 'no-internal-channel';
  }
  const names = Object.freeze(new Set(byTool.keys()));

  /* ---------- 调用 ---------- */

  /** 这次工具调用的事件上下文(落地的写入记在它上面,宿主据此发补渲计划);同一时刻只有一个工具调用在进锁前后用它 */
  let currentTrack = null;
  const callTrack = () => currentTrack ?? {};
  /** 宿主的工具调用号 → 提供者要的请求号(8～64 个安全字符);没有调用号就现起一个(那次调用不幂等) */
  const requestIdOf = (callId) => {
    const raw = typeof callId === 'string' ? callId.replace(/[^A-Za-z0-9_-]/g, '') : '';
    if (raw.length >= 8 && raw.length <= 64) return raw;
    return raw ? `c${sha256(`${context.runGrantId}\n${callId}`).slice(0, 40)}` : `c${randomUUID().replace(/-/g, '')}`;
  };
  const USAGE_VENDOR = { web: 'chromium', stt: 'python', shots: 'ffmpeg', subject: 'python', track: 'python', motion: 'builtin', workflow: 'builtin' };

  /** 浏览器数据要不要先清(主服务在对话转私有、Agent 被关时留的记号;也可能是上一个进程没清完) */
  async function purgeBrowserIfMarked() {
    if (!web) return;
    const mark = readBrowserPurgeMark(dataDir, scope);
    if (!mark) return;
    const reason = ['conversation-deleted', 'project-deleted'].includes(mark.reason) ? mark.reason : 'private';
    const out = await web.closeConversation(scope, { reason, removeProfile: true });
    say('agent.account-tools.browser-purged', { reason: mark.reason, removed: out.profileRemoved === true });
  }

  async function call(tool, args, { callId, track: trackCtx = null } = {}) {
    const family = byTool.get(tool);
    if (!family) throw coded('account-tool-unmounted', `这个进程里没有 ${tool} 的提供者`);
    if (family === 'collect') throw coded('account-tool-unmounted', 'collect 的两个登录工具由采集那一份执行');
    const provider = providers.get(family);
    const requestId = requestIdOf(callId);
    const t0 = now();
    let ok = true;
    try {
      if (family === 'web') await purgeBrowserIfMarked();
      currentTrack = trackCtx;
      const out = family === 'web' || family === 'motion'
        ? await provider.call(tool, args ?? {}, context)
        : await provider.call(tool, args ?? {}, context, { requestId });
      if (out && typeof out === 'object' && out.ok === false) ok = false;
      return out;
    } catch (error) { ok = false; throw error; }
    finally {
      currentTrack = null;
      // 用量:照外部服务调用的那一种记法,每次调用一行(不占模型额度);操作发起人页面的那一族不产生托管方的开销,不记
      if (USAGE_VENDOR[family]) {
        try {
          record({ t: now(), projectId: context.projectId, userId: context.senderAccountId, username: identity.username ?? '',
            conversationId: context.conversationId, runId: context.runId, kind: 'service', service: family === 'motion' ? 'track' : family,
            vendor: USAGE_VENDOR[family], model: tool, units: 1, unit: 'calls', ok, ms: now() - t0 });
        } catch { /* 记用量失败不影响结果 */ }
      }
    }
  }

  /* ---------- 收场 ---------- */

  let fencing = null;
  let closing = null;
  /** 文档服务的控制(种类)→ 浏览器数据的去留。停止、发起人被踢或退出登录:留(登录态还在);转私有、Agent 被关、删除:删 */
  const browserReason = (kind) => (kind === 'private' ? 'private' : kind === 'delete' ? 'project-deleted' : kind === 'agent-disabled' ? 'agent-off' : 'stop');

  /**
   * 这一轮被文档服务叫停(停止、对话转私有、Agent 被关、发起人被踢、项目被删)。**无条件**做完下面每一样,不看这一轮用没用过哪个工具:
   * 账本里这一轮没结束的作业标成取消;在等发起人页面的请求作废;在等的代下委托收掉;这个对话的浏览器关掉,
   * 该删用户数据目录的删。子进程树由运行资源登记器的 `abortForFence` 杀(执行器同时在做),这里不重复。
   */
  function fence({ kind = 'stop' } = {}) {
    fencing ??= (async () => {
      cancelling = true;
      const results = {};
      const step = async (name, fn) => { try { results[name] = await fn(); } catch (error) { results[name] = { error: typeof error?.code === 'string' ? error.code : 'error' }; } };
      await step('pageRequests', async () => pageBridge?.cancelRun?.(scope) ?? 0);
      await step('delegations', async () => collectBridge?.cancelRun(scope) ?? 0);
      await step('jobs', async () => { if (lastFence === null) return 'no-fence-seen'; await jobs.cancelForFence(context, lastFence); return 'cancelled'; });
      await step('browser', async () => {
        if (!web) return 'unmounted';
        const reason = browserReason(kind);
        const out = await web.closeConversation(scope, { reason, removeProfile: reason !== 'stop' });
        return { wasOpen: out.wasOpen, exited: out.exited, profileRemoved: out.profileRemoved };
      });
      say('agent.account-tools.fenced', { kind, ...Object.fromEntries(Object.entries(results).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : v])) });
      return results;
    })();
    return fencing;
  }

  /**
   * 这一轮说完话了:等它名下还没做完的后台作业(转写、镜头、主体、追踪、一键流程)做完再往下收。
   * `signal` 触发(这一轮被叫停)、到了兜底时限、或授权已经不在时不再等。
   */
  async function settle(signal = null) {
    const deadline = now() + limits.settleMs;
    for (;;) {
      if (signal?.aborted || fencing || closing) return { waited: false, reason: 'cancelled' };
      let open;
      try { open = await jobs.active(context); } catch { return { waited: false, reason: 'unauthorized' }; }
      if (!open.length) return { waited: true, pending: 0 };
      if (now() > deadline) { say('agent.account-tools.settle-timeout', { pending: open.length }); return { waited: false, reason: 'timeout', pending: open.length }; }
      await new Promise((resolve) => { const timer = setTimeout(resolve, limits.settlePollMs); timer.unref?.(); });
    }
  }

  /** 这条任务收尾:先停一键流程,再停感知各族,再关浏览器与委托,最后关账本。回执里任何一族没关干净都如实写 */
  function close(reason = 'run-drained') {
    closing ??= (async () => {
      if (fencing) await fencing.catch(() => {});
      const receipts = {};
      const shut = async (family, fn) => { try { receipts[family] = await fn(); } catch (error) { receipts[family] = { childrenClosed: false, streamsClosed: false, workPending: 1, error: typeof error?.code === 'string' ? error.code : 'error' }; } };
      for (const family of ['workflow', 'motion', 'track', 'subject', 'shots', 'stt']) {
        const provider = providers.get(family);
        if (provider) await shut(family, () => provider.close(reason));
      }
      if (collectBridge) await shut('collect', () => collectBridge.close(reason));
      if (web) {
        await shut('web', () => web.close(reason));
        // 上一步把浏览器关了;主服务留了「要清」的记号(这一轮跑着的时候对话被转成了私有)就在这里清掉
        try { if (readBrowserPurgeMark(dataDir, scope)) await web.closeConversation(scope, { reason: 'private', removeProfile: true }); } catch { /* 下一轮开头再清 */ }
      }
      for (const family of ['handoff', 'page']) { const provider = providers.get(family); if (provider) await shut(family, () => provider.close(reason)); }
      if (pageBridge) await shut('pageBridge', async () => pageBridge.close(reason));
      for (const closer of closers.reverse()) { try { await closer(); } catch { /* 账本关不上:下面的回执照实 */ } }
      const all = Object.values(receipts);
      return { childrenClosed: all.every((r) => r?.childrenClosed !== false), streamsClosed: all.every((r) => r?.streamsClosed !== false),
        workPending: all.reduce((sum, r) => sum + (Number(r?.workPending) || 0), 0), receipts };
    })();
    return closing;
  }

  // 上一个进程没来得及清的浏览器数据(主服务留了记号):开工前先清
  try { await purgeBrowserIfMarked(); } catch (error) { say('agent.account-tools.browser-purge-failed', { code: typeof error?.code === 'string' ? error.code : 'error' }); }
  if (web) void web.ready?.catch?.(() => {});
  say('agent.account-tools.mounted', { families: [...providers.keys(), ...(collectBridge ? ['collect'] : [])].join(','), skipped: Object.keys(skipped).join(',') });

  return Object.freeze({
    names,
    handles: (tool) => names.has(tool),
    familyOf: (tool) => byTool.get(tool) ?? null,
    call,
    /** 交给 `hosted-collect.mjs` 的委托口子(这一轮的);没建出来是 null */
    collectDelegate: () => (collectBridge && !fencing && !closing ? collectBridge.forRun(context) : null),
    /** 运行资源登记器的回执要的「这条任务名下的浏览器进程树是不是确实没了」 */
    treeClosed: async (ctx) => (web ? web.treeClosed(ctx) : true),
    fence, settle, close,
    describe: () => ({ mounted: [...new Set(byTool.values())], skipped: { ...skipped }, tools: names.size, lastFence,
      web: web ? { configured: web.describe().configured, open: web.describe().open } : null }),
  });
}
