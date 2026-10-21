/**
 * 账号模式的预渲染重试(`docs/semantics/product/agent.md`「发出任务后可以离开」「出错留痕」;机制同旧路
 * `server/agent/service/render-request.mjs`,契约 `docs/plan/cloud-agent-contract.md` 第 16 节)。
 *
 * 账号模式一条任务一个进程,一轮收尾这一代进程就关了;渲染要等渲染节点认领、做完,常常比一轮长。所以发布与跟进放在
 * 常驻的**主服务**里,任务进程只报「这一轮写到了哪些要预渲染的片段」:
 *
 * - 任务进程在每次写入落地后发一条 `render_request { clips, rev, userCards, judged? }` 事件(`account-runner.mjs`),和别的事件一样
 *   经主服务的内部口交上来;主服务每条都回文档服务核过是哪个项目、哪条任务(`worker-event-internal.mjs`)。
 * - `judged` 是任务进程那次判轻重的摘要(`render-clips.mjs`「只发重卡」):主服务原样核过形状后记一条日志
 *   `agent.render.judged`,线上从主服务的日志里就看得到每次判了几张、判重几张、为什么(任务进程自己的日志不一定有人收)。
 *   一张重的都没有时任务进程也发一条片段为空、只带摘要的事件:只记日志,不发布。旧任务进程不带摘要,照旧只发布。
 *   这里**只用核过的那份绑定里的项目号**,事件里的字段改不了项目:一条任务只能让本项目的片段被发布。
 * - 主服务以**托管方的服务身份**(Agent 服务的服务私钥,控制连接)要只能发布的连接票据、发清单计划(`render-publisher.mjs`),
 *   任务进程拿不到这把私钥,也拿不到任何成员的凭证。
 * - 结果(`published` / `progress` / `done` / `failed` / `unavailable` / `off`)记成这个对话的 `render` 事件,
 *   挂在写入它的那一轮名下(事件库按那一轮的绑定追加)。一轮先收尾,渲染结果之后补进对话,不拖住这一轮。
 * - 「生成轨道流」关着(`streams === false`):不发,记 `off`,对话里如实说云端没有预渲染(`src/ai/cloud/events.ts`)。
 * - 没配发布通道(节点没给主服务配本机文档服务地址或服务私钥):每次都记 `unavailable`,不悄悄丢。
 *
 * 每个对话一个目录(`<dir>/<项目与对话的哈希>/`):`binding.json`(最近一次写到的那一轮的绑定,追加事件用)与
 * `pending-render.json`(没渲完的清单,进程重启后重发)。对话被删就整个删掉。本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRenderRequests } from '../agent/service/render-request.mjs';
import { JUDGED_CLIP_IDS } from '../agent/service/render-clips.mjs';
import { createQueuePublisher } from './render-publisher.mjs';
import { WORKER_EVENT_BINDING_FIELDS } from './worker-event-internal.mjs';

/** 任务进程报「写到了要预渲染的片段」的事件类型 */
export const RENDER_REQUEST_EVENT = 'render_request';
/** 一轮收尾的事件:攒着的马上发 */
const RUN_END_EVENTS = new Set(['runner_done', 'end']);
const OWNER = 'account';
const MAX_CLIPS = 2000;
const ref = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const clipOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 && ![...v].some((ch) => ch.charCodeAt(0) < 32);
const countOk = (v) => Number.isSafeInteger(v) && v >= 0;
/** 判定摘要只留认得的几项(都来自任务进程,形状不对的项不记):张数、为什么、判轻的片段 id(截前 `JUDGED_CLIP_IDS` 个) */
function judgedOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const k of ['candidates', 'heavy', 'light', 'records', 'estimated']) if (countOk(v[k])) out[k] = v[k];
  if (typeof v.why === 'string' && /^[a-z-]{1,32}$/.test(v.why)) out.why = v.why;
  if (Array.isArray(v.lightClips)) out.lightClips = v.lightClips.filter(clipOk).slice(0, JUDGED_CLIP_IDS);
  return countOk(out.candidates) ? out : null;
}

/** 没配发布通道时用的:渲染节点永远「不可用」,每次如实记一条 */
export const UNAVAILABLE_PUBLISHER = Object.freeze({
  availability: () => ({ available: false, enabled: false }),
  open: async () => { throw Object.assign(new Error('没有发布通道'), { reason: 'unavailable' }); },
});

/**
 * @param {object} o
 * @param {string} o.dir 主服务自己的数据目录下的一个子目录
 * @param {{ append: Function }} o.eventStore 主服务的事件库(`account-run-events.mjs`)
 * @param {object | null} [o.publisher] 形状见 `render-request.mjs` 文件头;null 用 `UNAVAILABLE_PUBLISHER`
 */
export function createAccountRenderRequests({ dir, eventStore, publisher = null, now = () => Date.now(), limits = {}, log = () => {} } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || typeof eventStore?.append !== 'function')
    throw Object.assign(new Error('account-render-configuration'), { status: 503, code: 'account-render-configuration' });
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志不影响预渲染重试 */ } };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyOf = (projectId, id) => createHash('sha256').update(`${projectId}\n${id}`, 'utf8').digest('hex').slice(0, 40);
  const dirOf = (projectId, id) => path.join(dir, keyOf(projectId, id));
  const readBinding = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'binding.json'), 'utf8')); } catch { return null; } };
  const bindingOf = (row) => {
    const b = Object.fromEntries(WORKER_EVENT_BINDING_FIELDS.map((k) => [k, row?.[k]]));
    return ref(b.projectId) && ref(b.conversationId) && ref(b.runGrantId) && ref(b.runId) ? b : null;
  };
  function writeBinding(binding) {
    const d = dirOf(binding.projectId, binding.conversationId);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const file = path.join(d, 'binding.json');
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(binding), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // `render-request.mjs` 要的「对话记录」:这里只有绑定与事件库
  const store = {
    dirOf: (projectId, _owner, id) => dirOf(projectId, id),
    get(projectId, _owner, id) {
      const binding = readBinding(dirOf(projectId, id));
      return binding && binding.projectId === projectId && binding.conversationId === id ? { binding } : null;
    },
    emit(conv, event) {
      void Promise.resolve().then(() => eventStore.append({ binding: conv.binding, eventId: `render:${randomUUID()}`, event }))
        .catch((error) => say('agent.render.event-failed', { code: error?.code ?? String(error?.message ?? error).slice(0, 60) }));
    },
    *walk() {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const d = path.join(dir, name);
        const binding = readBinding(d);
        if (binding && ref(binding.projectId) && ref(binding.conversationId) && keyOf(binding.projectId, binding.conversationId) === name)
          yield { projectId: binding.projectId, ownerKey: OWNER, id: binding.conversationId, dir: d };
      }
    },
  };
  const render = createRenderRequests({ publisher: publisher ?? UNAVAILABLE_PUBLISHER, store, now, limits, log: say });
  const refOf = (binding) => ({ projectId: binding.projectId, ownerKey: OWNER, id: binding.conversationId });

  return {
    /**
     * 主服务收下一条任务进程交来的事件之后调(`appendWorker` 的回执)。回执里的绑定是文档服务核过的:项目号只从这里取。
     */
    observe(receipt) {
      const row = receipt?.row;
      const event = row?.event;
      if (!event || typeof event.type !== 'string') return;
      const binding = bindingOf(row);
      if (!binding) return;
      if (event.type === RENDER_REQUEST_EVENT) {
        const judged = judgedOf(event.judged);
        if (judged) say('agent.render.judged', { projectId: binding.projectId, runId: binding.runId, ...judged });
        const clips = Array.isArray(event.clips) ? event.clips.filter(clipOk).slice(0, MAX_CLIPS) : [];
        if (!clips.length || !Number.isSafeInteger(event.rev)) return;
        try { writeBinding(binding); } catch (error) { say('agent.render.binding-failed', { code: error?.code ?? 'io' }); return; }
        render.noteWrite(refOf(binding), { clips, rev: event.rev, runId: binding.runId, userCards: event.userCards === true });
      } else if (RUN_END_EVENTS.has(event.type)) {
        void render.flush(refOf(binding));
      }
    },
    /** 进程起来后:按盘上没渲完的清单重发 */
    restore: () => render.restore(),
    /** 对话被删:不再跟它的清单(已经发出去的计划照常渲完),目录清掉 */
    forget(projectId, conversationId) {
      if (!ref(projectId) || !ref(conversationId)) return;
      render.forget({ projectId, ownerKey: OWNER, id: conversationId });
      try { fs.rmSync(dirOf(projectId, conversationId), { recursive: true, force: true }); } catch { /* 下次再清 */ }
    },
    describe: () => render.describe(),
    /** 测试:等这个对话手头的发布做完 */
    _settled: (projectId, conversationId) => render._settled({ projectId, ownerKey: OWNER, id: conversationId }),
    _watchdog: () => render._watchdog(),
    close: () => render.close(),
  };
}

/**
 * 账号模式主服务的发布通道:托管方服务身份的控制连接(`server/auth/service-client.mjs`,服务名 `agent`)订目录,
 * 知道每个项目渲染节点开没开、「生成轨道流」开没开;发布连接见 `render-publisher.mjs`。
 * 目录没到过或项目不在目录里时答「不可用」(不猜「关着」)。
 */
export function createAccountRenderPublisher({ client, docUrl, root, now = () => Date.now(), log = () => {}, publisherOptions = {} } = {}) {
  if (typeof client?.watch !== 'function' || typeof client.publishTicket !== 'function') throw new TypeError('createAccountRenderPublisher: 要服务客户端');
  const projects = new Map();
  let synced = false;
  const put = (item) => {
    if (!item || typeof item.projectId !== 'string') return;
    if (item.removed === true) { projects.delete(item.projectId); return; }
    const r = item.hosted?.render ?? {};
    const enabled = r.enabled === true;
    projects.set(item.projectId, { available: r.available === true, enabled, streams: enabled && r.streams === true });
  };
  const watching = client.watch({
    onProjects(list) { projects.clear(); for (const item of list ?? []) put(item); synced = true; },
    onProject: put,
  });
  void Promise.resolve(watching).catch(() => {});
  const publisher = createQueuePublisher({
    client, docUrl, root, now, log,
    renderState: (projectId) => projects.get(projectId) ?? { available: false, enabled: false },
    ...publisherOptions,
  });
  return {
    publisher,
    describe: () => ({ synced, projects: projects.size, connected: client.connected === true, publisher: publisher.describe() }),
    close() { publisher.close(); },
  };
}
