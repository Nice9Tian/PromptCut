/**
 * 项目版本模块（契约 `docs/plan/docservice-contract.md` 第 1 节）。
 *
 * 页面每次改完项目，把项目内容的摘要报上来（`project.announce`）；摘要变了，本模块就发下一个 `projectRev`、
 * 记一行版本日志，并在 `project:<projectId>` 频道上广播 `project.rev`。打开项目（`project.open`）即订阅这个频道。
 *
 * 这是 D1 之前的过渡：本阶段文档服务**不持有项目内容**，页面仍是项目的真身，这里只做编号与通知
 * （语义 `docs/semantics/architecture/document-service.md`「版本与身份」）。操作格式、撤销与重做留给后续阶段，
 * 届时由操作日志取代本模块。
 *
 * 写入者身份取建连时的 principal，消息里自报的 `userId` 一律不认；`session` 是页面自报的会话标识，只作记录。
 * 版本号从 1 起、只增不减，跨重启保持：第一次用到某个项目时从日志回放一次，之后只在内存里维护。
 */
import { createMemoryStore } from '../store/index.mjs';

export const PROJECT_MODULE = 'project';

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST_RE = /^[0-9a-f]{16,128}$/;

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }

function checkProjectId(v) {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('projectId 不合法');
  return v;
}

function checkDigest(v) {
  if (typeof v !== 'string' || !DIGEST_RE.test(v)) bad('digest 必须是 16～128 位小写十六进制');
  return v;
}

/** `session` 可选：没给（或 null）记为 null；给了就得是 1～128 个字符的字符串 */
function checkSession(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad('session 必须是 1～128 个字符的字符串');
  return v;
}

const streamOf = (projectId) => `projects/${projectId}`;
const channelOf = (projectId) => `project:${projectId}`;

/**
 * @param {object} [options]
 * @param {{ append(stream: string, record: object): void, read(stream: string): object[] }} [options.store]
 *   日志存储（`../store/index.mjs`）；缺省用内存存储，不跨重启
 * @param {() => number} [options.now] 缺省用 `ctx.now()`
 */
export function projectModule({ store = createMemoryStore(), now } = {}) {
  /** projectId → { projectRev, digest, at }；第一次用到时从日志回放 */
  const projects = new Map();
  /** connId → principal */
  const principals = new Map();

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function stateOf(projectId) {
    let st = projects.get(projectId);
    if (st) return st;
    st = { projectRev: 0, digest: null, at: null };
    for (const rec of store.read(streamOf(projectId))) {
      // 同一个文件里可能混进只差大小写的项目（Windows 文件名不分大小写），按记录自己的键过滤
      if (rec.projectId !== projectId) continue;
      if (!Number.isSafeInteger(rec.rev) || rec.rev <= st.projectRev) continue;
      if (typeof rec.digest !== 'string') continue;
      st = { projectRev: rec.rev, digest: rec.digest, at: Number.isFinite(rec.at) ? rec.at : null };
    }
    projects.set(projectId, st);
    return st;
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function open(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const st = stateOf(projectId);
    ctx.subscribe(connId, channelOf(projectId));
    reply(ctx, connId, { type: 'project.state', projectId, projectRev: st.projectRev, digest: st.digest, at: st.at }, reqId);
  }

  function announce(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const digest = checkDigest(msg.digest);
    const session = checkSession(msg.session);
    const st = stateOf(projectId);
    if (st.digest === digest) {
      return reply(ctx, connId, { type: 'project.announced', projectId, projectRev: st.projectRev, changed: false }, reqId);
    }
    const principal = principals.get(connId);
    const actor = { userId: principal?.userId ?? null, session };
    const at = clock(ctx);
    const rev = st.projectRev + 1;
    // 先落日志再改内存：落盘失败时状态不变，核心回 internal
    store.append(streamOf(projectId), { projectId, rev, digest, actor, at });
    projects.set(projectId, { projectRev: rev, digest, at });
    reply(ctx, connId, { type: 'project.announced', projectId, projectRev: rev, changed: true }, reqId);
    ctx.publish(channelOf(projectId), { type: 'project.rev', projectId, projectRev: rev, digest, actor, at }, { coalesceKey: `project-rev:${projectId}` });
  }

  function close(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    ctx.unsubscribe(connId, channelOf(projectId));
    reply(ctx, connId, { type: 'project.closed', projectId }, reqId);
  }

  const HANDLERS = { 'project.open': open, 'project.announce': announce, 'project.close': close };

  return {
    name: PROJECT_MODULE,
    types: ['project.'],
    channels: ['project'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      // 频道订阅由核心在断开时清掉
      principals.delete(connId);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '项目版本模块不支持这种消息' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    describe() {
      return {
        projects: [...projects.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([projectId, st]) => ({ projectId, ...st })),
      };
    },
  };
}

/** 别名：与其它工厂的命名习惯对齐 */
export const createProjectModule = projectModule;
export default projectModule;
