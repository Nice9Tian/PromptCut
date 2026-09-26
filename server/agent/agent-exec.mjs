/**
 * Agent 服务端的工具执行器(C6.5 设计稿 `docs/plan/c65-design.md` 第 5、7 节;`cloud-task.md` D1、D2、D4)。
 *
 * **写工具在项目副本上执行**(D1):`side: "agent"` 的工具不再经页面。执行器在一把串行锁里
 *   1. 把副本(`doc-link.mjs`)的当前内容放进服务端 store(`ssr-host.mjs`),
 *   2. 跑 `src/mcp/handlers` 里同一份实现,
 *   3. `diffProject(副本, 跑完的项目)` 算出操作,以这个 Agent 对话的连接(写入身份 = agent + 对话号)提交,
 *      `expectRev` 取**这个对话最后一次读到的版本**(读工具回包里的 `rev`、上一次写入落地的版本);
 *   4. 落地就把操作交给副本,工具回包带新的 `rev`;被拒(`stale`)就回错,附上期间谁改了哪些实体,让 Agent 重读后再改。
 *   handler 抛错时这次的改动整个作废(不提交)。
 *
 * **读工具在副本上执行**(D4):`get_project`、`get_layout`、`see_frames`(成片)、`get_gif`、`bake_card`、
 *   `inspect_card_dom` 读副本、问预渲染进程,不经页面;回包带 `rev`,并记成这个对话读到的版本(读后写一致)。
 *
 * **工具调用事件**(D2):每个工具调用经这个对话的连接向文档服务的 `events` 模块发「创建」与「完成」两条,
 *   完整参数进内容库 `event-detail`;写入了项目的,「完成」里带这次写入的 `opId`、`rev` 与逆操作(`write`),
 *   页面 AI 栏「撤销这一步」据此以页面自己的身份提交逆操作并带 `undoOf`(设计稿第 8 节)。
 *
 * 不依赖 vite:工具实现经 `loadHost()`(`ssr-host.mjs`)拿到,预渲染经 `prerenderPost` 问,都由调用方注入。
 */
import { randomUUID } from 'node:crypto';

export const AGENT_EXEC_DEFAULTS = Object.freeze({
  /** 被拒(stale)后等副本追上文档服务的当前版本,Agent 马上重读就能读到最新的 */
  staleWaitMs: 2_000,
  /** 项目在文档服务里还没有真身(页面刚接上、还没把项目写进去)时最多等多久 */
  bodyWaitMs: 5_000,
  /** 写入落地后等副本追上这一版 */
  landWaitMs: 5_000,
  /** 页面侧工具写了项目:等这些提交出现在副本里 */
  pageWritesWaitMs: 3_000,
  /** 聊天栏「看得见的结果」:交可视化记录最多等多久 */
  visualTimeoutMs: 3_000,
  /** 事件里参数摘要的上限(字符,事件模块 `ARGS` 的上限) */
  eventArgsMax: 2048,
  /** 完整参数超过这么多字节就不存 event-detail(内容库单条上限 256 KiB) */
  detailMaxBytes: 200 * 1024,
  /** 逆操作超过这么多字节就不放进「完成」事件(事件模块 `EVENTS_LIMITS.INVERSE`) */
  inverseMaxBytes: 256 * 1024,
  /** 一次提交的上限(文档服务 `PROJECT_LIMITS.MAX_OPS_BYTES`);超过就把这次改动换成根替换、走 `project.upload` */
  maxOpsBytes: 256 * 1024,
  /** `project.upload` 每片的字符数(UTF-8 最坏 4 字节,≤ 文档服务每片 512 KiB 的上限;与页面 DocSync 相同) */
  uploadPartChars: 128 * 1024,
  /** `project.upload` 最多几片(文档服务 `PROJECT_LIMITS.UPLOAD_MAX_PARTS`) */
  uploadMaxParts: 64,
  /** 向页面要页面状态最多等多久 */
  pageStateTimeoutMs: 10_000,
  /** stale 摘要里最多列几次提交、每次最多列几个实体 */
  staleShowCommits: 8,
  staleShowEntities: 6,
});

/** 改卡 / 删卡 / 建卡的工具:聊天栏要画前后两张卡(和页面 mcpExecutor 的 withVisual 同一份判据) */
const CLIP_EDIT_TOOLS = new Set([
  'update_clip', 'set_clip', 'set_position', 'set_rect', 'align', 'nudge', 'set_emphasis',
  'add_part', 'set_part', 'remove_part', 'move_part',
]);
const CLIP_CREATE_TOOLS = new Set(['add_clip', 'duplicate_clip', 'add_composite']);

/**
 * 既读页面独有状态、又写项目的工具(c65-integ2 裁定:违反 D1 判据,改为写入在 Agent 服务端以 agent 身份执行,
 * 所需的页面状态向页面要一次,经现有 SSE 页面通道取只读值)。值是要向页面要的键:
 *   - `t`:页面播放头。切剪辑(`switch_cut`、缺省会切过去的 `add_cut`、删当前剪辑的 `remove_cut`)要把它存回被停放的那条剪辑;
 *   - `track`:页面内存里 `track_points` 跑出来的轨迹(`attach_clip_motion` 读它算逐帧坐标)。
 * `set_project_meta` 不读页面状态(`duration` 的手动截断值由页面收到远端改动时按项目自己推出来,见
 * `src/store/remotePageState.ts`),所以不在这张表里,直接在服务端执行。
 * 页面状态的「写」(切剪辑后页面的播放头、选区、停播)同样由页面收到远端改动时自己做,不经这条通道。
 */
export const PAGE_STATE_TOOLS = Object.freeze({
  switch_cut: Object.freeze(['t']),
  add_cut: Object.freeze(['t']),
  remove_cut: Object.freeze(['t']),
  attach_clip_motion: Object.freeze(['track']),
});

/** 在服务端另有实现、不走路由表的读工具 */
export const SERVER_READ_TOOLS = Object.freeze(['get_project', 'get_layout', 'see_frames', 'get_gif', 'bake_card', 'inspect_card_dom']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');

export class StaleWriteError extends Error {
  constructor(message, info) {
    super(message);
    this.code = 'stale';
    this.stale = info;
  }
}

/** 写入身份 → 给人看的一句话 */
export function describeActor(actor) {
  if (!actor || typeof actor !== 'object') return '未知的写入方';
  if (actor.role === 'agent') return `Agent 对话 ${actor.conversation ?? '?'}${actor.session ? `(${actor.session})` : ''}`;
  if (actor.role === 'page') return `页面${actor.userId && actor.userId !== 'local' ? `(${actor.userId})` : ''}`;
  if (actor.role === 'render') return '渲染节点';
  return actor.userId ? `用户 ${actor.userId}` : '未知的写入方';
}

/** stale 回包 → 工具的报错文字(谁、改了哪些实体) */
export function staleMessage({ expectRev, currentRev, since = [], sinceComplete = true }, limits = AGENT_EXEC_DEFAULTS) {
  const shown = since.slice(-limits.staleShowCommits);
  const lines = shown.map((s) => {
    const ents = Array.isArray(s.entities) && s.entities.length ? s.entities : (Array.isArray(s.paths) ? s.paths : []);
    const list = ents.slice(0, limits.staleShowEntities).join('、') + (ents.length > limits.staleShowEntities ? ` 等 ${ents.length} 处` : '');
    return `  rev ${s.rev}:${describeActor(s.actor)}${s.undoOf ? '(撤销)' : ''}改了 ${list || '(没有实体变化)'}`;
  });
  const omitted = since.length - shown.length;
  return [
    `项目在你上次读取之后被改过:你读到的是 rev ${expectRev},现在是 rev ${currentRev}。这次写入没有落地。`,
    ...(lines.length ? ['期间的改动:', ...lines] : []),
    ...(omitted > 0 || !sinceComplete ? [`  (更早的还有 ${omitted > 0 ? omitted : '若干'} 次没列出)`] : []),
    '请先重新读取(get_project、get_clip、get_layout 等)确认现状,再决定怎么改。',
  ].join('\n');
}

/**
 * Agent 在服务端的一次写入之后,项目总时长该是多少(C6.5 收尾裁定:总时长的连带更新随这次写入的同一批 ops 提交,
 * 页面收到后不再补写 —— 否则页面补写的那一次是页面身份的写入,这个对话紧接着的下一次写入会因版本不符被拒一次)。
 *
 * 规则是页面现成的那一条(`src/kernel/duration.ts`;页面侧由时间轴的 effect 按 `effectiveDuration` 算、
 * `syncDuration` 写,至少 1 s),这里只是在服务端副本上把它跑一遍:
 *   - 手动截断值服务端没有(页面状态),按项目自己推:这次写入改了总时长(`set_project_meta` 截断)就按改后的推,
 *     否则按改前的推 —— 与页面收到远端改动时 `pageStateAfterRemote` 推手动值是同一条 `manualDurationFor`;
 *   - 只在片段或总时长变了时才算(页面时间轴的 effect 也只跟着这两样跑),只改名之类的写入不碰总时长。
 * 回应该提交的项目:不用改时原样回 `after`。
 *
 * @param {object} before 改前的副本
 * @param {object} after  handler 跑完的项目
 * @param {{ contentEndOf: Function, effectiveDuration: Function, manualDurationFor: Function }} rules `src/kernel/duration.ts`
 */
export function settleDuration(before, after, rules) {
  if (!isPlainObject(after) || !isPlainObject(before) || !rules) return after;
  if (after.tracks === before.tracks && after.duration === before.duration) return after;
  const current = Number(after.duration);
  if (!Number.isFinite(current)) return after;
  const end = rules.contentEndOf(after.tracks ?? []);
  const manual = after.duration !== before.duration
    ? rules.manualDurationFor(current, end)
    : rules.manualDurationFor(Number(before.duration), rules.contentEndOf(before.tracks ?? []));
  const target = rules.effectiveDuration(end, current, manual);
  // 与时间轴 effect + `syncDuration` 相同的门槛:差不到 1e-6 不写,写时至少 1 s
  if (Math.abs(target - current) <= 1e-6) return after;
  const val = Math.max(1, target);
  if (Math.abs(val - current) < 1e-6) return after;
  return { ...after, duration: val };
}

/** 工具回包带上版本号;数组、非对象原样返回(不改变它们的形状) */
function withRev(result, rev) {
  if (!isPlainObject(result) || Object.hasOwn(result, 'rev')) return result;
  return { ...result, rev };
}

/** get_project 的回包形状(和页面 handlers/project.ts 的 getProject 相同:文字稿只给摘要) */
export function projectView(project) {
  return {
    ...project,
    media: (project.media || []).map((m) => (m?.transcript ? {
      ...m,
      transcript: {
        engine: m.transcript.engine, model: m.transcript.model, language: m.transcript.language,
        createdAt: m.transcript.createdAt, segments: m.transcript.segments?.length ?? 0,
        hint: '完整文字稿请用 get_transcript',
      },
    } : m)),
  };
}

function targetOf(args) {
  if (!isPlainObject(args)) return null;
  for (const k of ['clipId', 'trackId', 'mediaId', 'filterId', 'pixelMapId', 'fxId', 'transitionId', 'cutId', 'cardId', 'partInstanceId']) {
    if (typeof args[k] === 'string' && args[k]) return `${k}:${args[k]}`.slice(0, 512);
  }
  return null;
}

/**
 * @param {object} options
 * @param {ReturnType<import('./doc-link.mjs').createAgentLink>} options.link
 * @param {() => Promise<object>} options.loadHost  `ssr-host.mjs` 的 `loadSsrHost` 绑好 `load` 的版本
 * @param {(path: string, body: object, opts?: object) => Promise<any>} [options.prerenderPost]
 * @param {() => number} [options.playhead] 页面播放头(秒);get_layout / see_frames 没给时刻时用
 * @param {Record<string, string>} [options.toolGroups] 工具名 → 分组名(事件的 icon)
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {(tool: string, args: object, keys: readonly string[]) => Promise<object | null>} [options.pageState]
 *   向页面要一次只读的页面状态(`PAGE_STATE_TOOLS`);没有页面时回 null 或抛错,执行器退回用 `playhead()`
 */
export function createAgentExecutor({
  link,
  loadHost,
  prerenderPost = null,
  playhead = () => 0,
  pageState = null,
  toolGroups = {},
  log = () => {},
  limits: limitsIn = {},
  newOpId = (session) => `${session}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`,
} = {}) {
  if (!link) throw new TypeError('createAgentExecutor: 要 link');
  if (typeof loadHost !== 'function') throw new TypeError('createAgentExecutor: 要 loadHost');
  const limits = { ...AGENT_EXEC_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  const projectId = link.projectId;
  const bootId = Date.now().toString(36);

  /** agentKey('' 表示没带对话 id 的调用) → 对话记录 */
  const convs = new Map();
  let nextNumber = 1;
  let lock = Promise.resolve();
  const stats = { executed: 0, committed: 0, stale: 0, rejected: 0, noop: 0, events: 0, eventErrors: 0, pageStates: 0, uploads: 0 };

  function conversationOf(agentKey = '') {
    const key = typeof agentKey === 'string' ? agentKey : '';
    let c = convs.get(key);
    if (!c) {
      c = { key, n: nextNumber++, session: `agent:${key || 'default'}`.slice(0, 128), lastRead: null, eventSeq: 0 };
      convs.set(key, c);
      // 登记这个对话的连接(用到时才连);第一个登记的兼做副本的订阅
      link.conversation(c.n);
    }
    return c;
  }

  /** 串行锁:服务端 store 只有一份,放项目、跑 handler、取结果必须一气呵成 */
  function serial(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  }

  async function replicaReady() {
    await link.ready();
    const r = link.replica;
    if (r.hasBody) return;
    // 页面刚接上、还没把项目写进文档服务:等它一会儿
    const t0 = Date.now();
    while (!r.hasBody && Date.now() - t0 < limits.bodyWaitMs) await r.waitRev(r.rev + 1, 250);
    if (!r.hasBody) {
      throw Object.assign(new Error(`项目 ${projectId} 在文档服务里还没有内容(页面还没把项目写进去),稍后再试。`), { code: 'no-body' });
    }
  }

  function markRead(conv, rev) {
    if (conv.lastRead === null || rev > conv.lastRead) conv.lastRead = rev;
  }

  /* ---------------- 可视化记录(聊天栏) ---------------- */

  async function withVisual(tool, args, result, before, after) {
    if (!prerenderPost || !isPlainObject(result) || result.ok === false) return result;
    let body = null;
    if (CLIP_CREATE_TOOLS.has(tool)) {
      const id = result.id || result.clipId;
      if (id) body = { tool, clipId: id, after };
    } else if (tool === 'remove_clip') {
      if (args?.clipId) body = { tool, clipId: args.clipId, before };
    } else if (CLIP_EDIT_TOOLS.has(tool)) {
      if (args?.clipId) body = { tool, clipId: args.clipId, before, after };
    }
    if (!body) return result;
    try {
      const v = await prerenderPost('/api/ai/visual', body, { timeoutMs: limits.visualTimeoutMs });
      if (v?.ok && v.visualId) return { visualId: v.visualId, ...result };
    } catch { /* 可视化是附带的,交不上就算了 */ }
    return result;
  }

  /* ---------------- 写工具:在副本上跑 handler ---------------- */

  /**
   * 向页面要这次工具要的页面状态(`PAGE_STATE_TOOLS`),只要一次。要不到(编辑台没打开、超时)时:
   * 播放头退回服务端记着的页面播放头(`playhead()`,页面推给数据镜像的那个);轨迹没有替代,直接回错。
   */
  async function pageStateFor(tool, args) {
    const keys = PAGE_STATE_TOOLS[tool];
    if (!keys) return null;
    let got = null;
    if (typeof pageState === 'function') {
      let timer;
      try {
        got = await Promise.race([
          Promise.resolve(pageState(tool, args ?? {}, keys)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`页面 ${limits.pageStateTimeoutMs} ms 内没有回页面状态`)), limits.pageStateTimeoutMs); timer.unref?.(); }),
        ]);
      } catch (err) {
        say('agent.page-state-failed', { tool, message: String(err?.message ?? err) });
        got = null;
      } finally {
        clearTimeout(timer);
      }
    }
    stats.pageStates += 1;
    const out = {};
    if (keys.includes('t')) out.t = typeof got?.t === 'number' && Number.isFinite(got.t) ? got.t : (Number(playhead()) || 0);
    if (keys.includes('track')) {
      const mediaId = typeof args?.mediaId === 'string' ? args.mediaId : null;
      if (mediaId && (!got || typeof got !== 'object')) {
        throw Object.assign(new Error('编辑台没有打开(或没有回应),读不到页面里的追踪结果;打开编辑台后再试。'), { code: 'no-page' });
      }
      const tr = got?.track && typeof got.track === 'object' ? got.track : {};
      out.track = mediaId ? { mediaId, result: tr.result ?? null, running: tr.running === true } : null;
    }
    return out;
  }

  /** 超过单次上限的改动:把跑完的整份项目分片传上去(`project.upload`),回引用它的那一条根替换 */
  async function uploadRoot(conn, opId, after) {
    const text = JSON.stringify(after);
    const count = Math.ceil(text.length / limits.uploadPartChars);
    if (count > limits.uploadMaxParts) {
      stats.rejected += 1;
      throw Object.assign(new Error(`这次改动太大(整份项目序列化后约 ${text.length} 个字符,超过分片上传的上限),文档服务不收。请拆成几次小的修改。`), { code: 'too-large' });
    }
    const uploadId = `up.${opId}`.slice(0, 128);
    for (let index = 0; index < count; index += 1) {
      const reply = await conn.request(
        { type: 'project.upload', projectId, uploadId, index, count, data: text.slice(index * limits.uploadPartChars, (index + 1) * limits.uploadPartChars) },
        (m) => m.type === 'project.uploaded' || m.type === 'error',
      );
      if (reply.type === 'error') {
        stats.rejected += 1;
        throw Object.assign(new Error(`分片上传被文档服务拒绝(${reply.reason ?? 'error'})${reply.detail ? `:${reply.detail}` : ''}`), { code: reply.reason ?? 'error' });
      }
    }
    stats.uploads += 1;
    return { wire: [{ op: 'set', path: '', upload: uploadId }], local: [{ op: 'set', path: '', value: JSON.parse(text) }] };
  }

  async function runRoute(tool, args, conv, ctx) {
    await replicaReady();
    const host = await loadHost();
    if (!host.routeOf(tool)) throw new Error(`未知工具: ${tool}`);
    const ps = await pageStateFor(tool, args);
    const prepared = await serial(async () => {
      const replica = link.replica;
      const base = replica.project;
      const baseRev = replica.rev;
      host.setProject(base);
      const cleanup = ps && typeof host.setPageState === 'function' ? host.setPageState(ps) : null;
      let result;
      let after;
      try {
        result = await host.callRoute(tool, args);
      } finally {
        // 先把跑完的项目取出来,再把 store 放回副本;handler 抛错时这次的改动整个作废(不提交)
        after = host.getProject();
        host.setProject(base);
        cleanup?.();
      }
      if (after === base) return { result, base, baseRev, ops: [], inverse: [] };
      // 总时长跟着内容走的那一下在这里一并做,随同一批 ops 提交(页面收到后不再补写)
      after = settleDuration(base, after, host.durationRules);
      const { ops, inverse } = host.diffProject(base, after);
      return { result, base, baseRev, ops, inverse, after };
    });
    const { result, base, baseRev, ops, inverse } = prepared;
    if (!ops.length) {
      stats.noop += 1;
      markRead(conv, baseRev);
      return withRev(result, baseRev);
    }
    const expectRev = conv.lastRead ?? baseRev;
    const opId = newOpId(conv.session);
    const conn = link.conversation(conv.n);
    // 文档服务一次提交的上限是 256 KiB(c65-integ2 裁定):更大的改动换成「根替换 = 跑完的整份项目」,
    // 整份项目经 `project.upload` 分片传上去,提交里只引用它;逆操作仍用差异算的那份(撤得回来)
    let wireOps = ops;
    let landedOps = ops;
    if (bytesOf(ops) > limits.maxOpsBytes) {
      const up = await uploadRoot(conn, opId, prepared.after);
      wireOps = up.wire;
      landedOps = up.local;
    }
    const reply = await conn.request(
      { type: 'project.op', projectId, opId, session: conv.session, expectRev, ops: wireOps },
      (m) => m.type === 'project.op.ok' || m.type === 'project.op.rejected' || m.type === 'error',
    );
    if (reply.type === 'project.op.ok') {
      stats.committed += 1;
      link.replica.offer(reply.rev, landedOps, { opId, actor: { role: 'agent', conversation: conv.n, session: conv.session }, session: conv.session });
      await link.replica.waitRev(reply.rev, limits.landWaitMs);
      markRead(conv, reply.rev);
      ctx.write = { opId, rev: reply.rev, inverse, overwrote: reply.overwrote ?? [] };
      say('agent.write', { tool, conversation: conv.n, opId, rev: reply.rev, ops: ops.length });
      const shown = await withVisual(tool, args, result, base, prepared.after);
      return withRev(shown, reply.rev);
    }
    if (reply.type === 'project.op.rejected' && reply.reason === 'stale') {
      stats.stale += 1;
      // 等副本追上当前版本:Agent 马上重读时能读到期间落地的改动
      if (Number.isSafeInteger(reply.currentRev)) await link.replica.waitRev(reply.currentRev, limits.staleWaitMs);
      const info = { expectRev, currentRev: reply.currentRev, since: reply.since ?? [], sinceComplete: reply.sinceComplete !== false };
      say('agent.stale', { tool, conversation: conv.n, expectRev, currentRev: reply.currentRev, since: info.since.length });
      throw new StaleWriteError(staleMessage(info, limits), info);
    }
    stats.rejected += 1;
    const reason = reply.reason ?? 'error';
    const detail = reply.detail ? `:${reply.detail}` : '';
    throw Object.assign(new Error(`文档服务没有接受这次写入(${reason})${detail}`), { code: reason });
  }

  /* ---------------- 读工具:读副本 ---------------- */

  async function readSnapshot(conv) {
    await replicaReady();
    const r = link.replica;
    const snap = { project: r.project, rev: r.rev };
    markRead(conv, snap.rev);
    return snap;
  }

  async function getLayout(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const host = await loadHost();
    const frames = await serial(async () => {
      host.setProject(snap.project);
      const all = (snap.project.tracks || []).flatMap((tr) => (tr.clips || []).map((c) => c.id));
      if (args?.clipId && !all.includes(args.clipId)) throw new Error(`找不到 clip ${args.clipId}`);
      const ids = args?.clipId ? [args.clipId] : all;
      return { ids, stage: host.stageSize(), layout: Object.fromEntries(ids.map((id) => [id, host.frameLayoutOf(id)])) };
    });
    let measured = null;
    let note = null;
    if (prerenderPost && frames.ids.length) {
      try {
        const data = await prerenderPost('/api/cards/layout', { project: snap.project, t: playhead(), clipIds: frames.ids }, { timeoutMs: toolDef?.timeoutMs || 60_000 });
        if (data && data.ok !== false && isPlainObject(data.clips)) measured = data.clips;
        else note = `预渲染没量出实体框:${data?.error ?? '没有结果'}`;
      } catch (err) {
        note = `预渲染没回应,量不到实体框:${err?.message ?? err}`;
      }
    }
    const clips = {};
    for (const id of frames.ids) {
      const m = measured?.[id] ?? { contentBox: null, ...(note ? { contentNote: note } : {}) };
      clips[id] = { ...frames.layout[id], contentBox: m.contentBox ?? null, ...(m.contentNote ? { contentNote: m.contentNote } : {}) };
    }
    if (args?.clipId) return withRev(clips[args.clipId], snap.rev);
    return { stage: frames.stage, clips, rev: snap.rev };
  }

  async function seeFrames(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const { source, ...rest } = args || {};
    const times = Array.isArray(rest.times) ? rest.times.filter((x) => typeof x === 'number').slice(0, 10) : [];
    const body = times.length
      ? { project: snap.project, times, clipId: rest.clipId }
      : { project: snap.project, t: typeof rest.t === 'number' ? rest.t : (rest.clipId ? undefined : playhead()), clipId: rest.clipId };
    const data = await prerenderPost('/api/vision/snapshot', body, { timeoutMs: toolDef?.timeoutMs || 180_000 });
    if (!data?.ok) throw new Error(data?.error || '渲染画面失败');
    let result = times.length ? { ok: true, frames: data.frames, note: data.note, __images: data.__images } : data;
    const images = [];
    if (data.__image?.base64) images.push({ mime: data.__image.mime, base64: data.__image.base64, label: typeof data.t === 'number' ? `t=${data.t}s` : '' });
    for (const im of Array.isArray(data.__images) ? data.__images : []) if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? '' });
    if (images.length) {
      const v = await prerenderPost('/api/ai/visual', { tool: 'see_frames', images }, { timeoutMs: 5000 }).catch(() => null);
      if (v?.ok && v.visualId) result = { visualId: v.visualId, ...result };
    }
    return withRev(result, snap.rev);
  }

  async function getGif(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const timeoutMs = toolDef?.timeoutMs || 180_000;
    const spec = await prerenderPost('/api/ai/visual', { tool: 'get_gif', clipId: args.clipId, after: snap.project }, { timeoutMs });
    if (!spec?.ok) throw new Error(spec?.error || '做动图失败');
    if (!spec.gifKey) throw new Error(`时间轴上没有 id 为 ${args.clipId} 的片段。`);
    const data = await prerenderPost('/api/ai/visual/render', { key: spec.gifKey }, { timeoutMs });
    if (!data?.ok) throw new Error(data?.error || '做动图失败');
    return {
      visualId: spec.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
      note: '拼图 4×2,第 k 格对应 times 的第 k 个时刻(按行从左到右)。用户在聊天栏点开这一步能看到动图。',
      ...(data.grid ? { __image: { mime: 'image/png', base64: data.grid } } : {}),
      rev: snap.rev,
    };
  }

  async function bakeCard(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const data = await prerenderPost('/api/vision/bake', { project: snap.project, clipId: args.clipId, t: args.t, size: args.size, bg: args.bg }, { timeoutMs: toolDef?.timeoutMs || 150_000 });
    if (!data?.ok) throw new Error(data?.error || '渲染失败');
    return withRev(data, snap.rev);
  }

  async function inspectCardDom(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const ref = typeof args.ref === 'string' ? Number(String(args.ref).replace(/^ref_/, '')) : args.ref;
    const data = await prerenderPost('/api/cards/dom', { project: snap.project, clipId: args.clipId, t: args.t, ref, depth: args.depth }, { timeoutMs: toolDef?.timeoutMs || 60_000 });
    if (!data?.ok) throw new Error(data?.error || '读不到 DOM 树');
    return withRev(data, snap.rev);
  }

  /* ---------------- 事件(D2) ---------------- */

  function sendEvent(conv, message, accept = (m) => m.type === 'events.ack' || m.type === 'error') {
    const conn = link.conversation(conv.n);
    return conn.request({ ...message, projectId, session: conv.session }, accept).then((reply) => {
      if (reply?.type === 'error') {
        stats.eventErrors += 1;
        say('agent.event-rejected', { type: message.type, reason: reply.reason, detail: reply.detail });
      } else stats.events += 1;
      return reply;
    }, (err) => {
      stats.eventErrors += 1;
      say('agent.event-failed', { type: message.type, message: String(err?.message ?? err) });
      return null;
    });
  }

  function argsSummary(args) {
    let text;
    try { text = JSON.stringify(args ?? {}); } catch { text = '(参数无法序列化)'; }
    return text.length > limits.eventArgsMax ? `${text.slice(0, limits.eventArgsMax - 1)}…` : text;
  }

  function resultSummary(result, error) {
    if (error) return String(error?.message ?? error).slice(0, 2048);
    let text;
    try {
      text = JSON.stringify(result, (k, v) => (k === '__image' || k === '__images' || k === 'base64' ? undefined : v));
    } catch { text = ''; }
    return (text ?? '').slice(0, 2048) || null;
  }

  /** 完成事件里的写入信息:成功的写才有;逆操作太大(超过事件模块的上限)时不带,那一步就撤不了 */
  function writeFields(write) {
    if (!write) return {};
    const out = { opId: write.opId, rev: write.rev };
    if (bytesOf(write.inverse) <= limits.inverseMaxBytes) out.inverse = write.inverse;
    return out;
  }

  /** 完成时补写的 event-detail:参数、结果摘要、写入信息;超过内容库上限就依次去掉逆操作、参数 */
  function completeDetail(tool, args, summary, fields) {
    const full = { tool, args: args ?? {}, summary, ...fields };
    if (bytesOf(full) <= limits.detailMaxBytes) return full;
    const { inverse: _i, ...noInverse } = full;
    if (bytesOf(noInverse) <= limits.detailMaxBytes) return { ...noInverse, inverseOmitted: true };
    return { tool, summary, ...(fields.opId ? { opId: fields.opId, rev: fields.rev, inverseOmitted: true } : {}), argsOmitted: true };
  }

  /* ---------------- 对外 ---------------- */

  const READERS = { get_layout: getLayout, see_frames: seeFrames, get_gif: getGif, bake_card: bakeCard, inspect_card_dom: inspectCardDom };

  return {
    projectId,
    conversationOf,

    /**
     * 执行一个 `side: "agent"` 的工具。回 `undefined` 表示服务端不接(交给页面):目前只有 `see_frames` 的素材拼图。
     * `ctx` 由 `track` 传进来,执行器把这次写入(`write`)记在上面。
     */
    async execute(tool, args, agentKey, toolDef, ctx = {}) {
      const conv = conversationOf(agentKey);
      stats.executed += 1;
      const required = toolDef?.inputSchema?.required ?? [];
      const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
      if (missing.length) throw new Error(`缺少必填参数：${missing.join('、')}。请补齐后重试。`);
      if (tool === 'get_project') {
        const snap = await readSnapshot(conv);
        return { ...projectView(snap.project), rev: snap.rev };
      }
      if (tool === 'see_frames' && args?.source !== undefined && args.source !== 'timeline') return undefined;
      const reader = READERS[tool];
      if (reader) {
        if (!prerenderPost && tool !== 'get_layout') return undefined;
        return reader(args ?? {}, conv, toolDef);
      }
      return runRoute(tool, args ?? {}, conv, ctx);
    },

    /**
     * 一次工具调用前后各发一条事件(不论这个工具在哪一侧执行)。`run(ctx)` 执行工具;事件发不出去不影响工具。
     * `meta.callId` 是模型那一侧这次工具调用的 id(Claude Code 的 `_meta["claudecode/toolUseId"]`、API 直连的
     * tool_use id):两条事件都带上,页面 AI 栏按它把事件对上聊天记录里的那次工具调用。
     */
    async track(tool, args, agentKey, run, meta = {}) {
      const conv = conversationOf(agentKey);
      const eventId = `${conv.session}.${bootId}.${++conv.eventSeq}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
      const detailFits = bytesOf(args ?? {}) <= limits.detailMaxBytes;
      const callId = typeof meta?.callId === 'string' && meta.callId && meta.callId.length <= 128 ? meta.callId : null;
      const callField = callId ? { callId } : {};
      sendEvent(conv, {
        type: 'events.create', eventId, tool, ...callField,
        icon: toolGroups[tool] ?? null, target: targetOf(args), args: argsSummary(args),
        ...(detailFits ? { detail: { tool, args: args ?? {} } } : {}),
      });
      const t0 = Date.now();
      const ctx = { write: null };
      let result;
      let error = null;
      try {
        result = await run(ctx);
        return result;
      } catch (err) {
        error = err;
        throw err;
      } finally {
        // 只有成功落地的写带 opId、rev 与逆操作;读工具、被拒的写不带(主会话裁定)
        const fields = error ? {} : writeFields(ctx.write);
        const summary = resultSummary(result, error);
        sendEvent(conv, {
          type: 'events.complete', eventId, ...callField,
          status: error ? 'error' : 'ok',
          summary,
          durationMs: Date.now() - t0,
          ...fields,
          detail: completeDetail(tool, args, summary, fields),
        });
      }
    },

    /** 文字回复整条完成时推一条(D2) */
    text(agentKey, text) {
      if (typeof text !== 'string' || !text.trim()) return;
      const conv = conversationOf(agentKey);
      const eventId = `${conv.session}.${bootId}.${++conv.eventSeq}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
      sendEvent(conv, { type: 'events.text', eventId, text: text.slice(0, 64 * 1024) });
    },

    /**
     * 留在页面的工具写了项目(页面回包带它提交的 `opIds`):等这些提交进副本;若这个对话上次读到的版本之后
     * 只有这些提交,就把读到的版本推进过去 —— 否则 Agent 紧接着的写入会因为它自己让页面做的改动而被拒。
     */
    async notePageWrites(agentKey, opIds) {
      if (!Array.isArray(opIds) || !opIds.length) return;
      const conv = conversationOf(agentKey);
      const r = link.replica;
      const t0 = Date.now();
      let revs = [];
      while (Date.now() - t0 < limits.pageWritesWaitMs) {
        revs = opIds.map((id) => r.revOfOpId(id));
        if (revs.every((v) => v !== null)) break;
        await r.waitRev(r.rev + 1, 200);
      }
      if (revs.some((v) => v === null) || conv.lastRead === null) return;
      const top = Math.max(...revs);
      if (top <= conv.lastRead) return;
      const between = r.between(conv.lastRead, top);
      if (between && between.every((h) => opIds.includes(h.opId))) conv.lastRead = top;
    },

    /** 这个对话最后读到的版本(测试与诊断) */
    lastRead(agentKey) {
      return convs.get(typeof agentKey === 'string' ? agentKey : '')?.lastRead ?? null;
    },

    describe() {
      return {
        projectId,
        conversations: [...convs.values()].map((c) => ({ key: c.key, conversation: c.n, session: c.session, lastRead: c.lastRead })),
        stats: { ...stats },
        link: link.describe(),
      };
    },
  };
}
