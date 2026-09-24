/**
 * 渲染任务队列的消息格式：入站校验、出站构造、任务 id。
 *
 * 契约见 `docs/plan/render-queue-contract.md` A.4、A.6、A.11，卡片级指纹锁见 F.1。入站消息一律先整体校验再交给状态机：
 * 格式不对的整条不生效（C6），所以校验不能有副作用，也不能「校验到一半先改一部分状态」。
 * 校验通过后返回的是规范化、深拷贝过的副本：之后调用方再改原消息，影响不到队列里存的东西。
 */

const KINDS = new Set(['plan', 'snapshot', 'stream']);
const TIERS = new Set(['shared', 'local']);
const RANGE_UNITS = new Set(['localFrame', 'segment']);
const WEIGHT_CLASSES = new Set(['light', 'medium', 'heavy']);
const PROFILES = new Set(['pc', 'host', 'browser']);
/** 参与卡片级指纹锁的任务种类（F.1）：plan 不产结果，不锁 */
const LOCK_KINDS = new Set(['snapshot', 'stream']);

/** 只有节点连接能发的消息（A.5） */
export const NODE_TYPES = new Set(['queue.watch', 'task.claim', 'task.progress', 'task.complete', 'task.release', 'task.fail']);
/**
 * 只有发布连接能发的消息（A.5）。`card.lock`（F.1）也在这里：文档服务按这个集合把消息路由给队列，
 * 加进来就不用改文档服务。
 */
export const PUBLISHER_TYPES = new Set(['task.publish', 'task.unsubscribe', 'card.lock']);

/**
 * 任务 id 由内容决定（设计第 2 节）：同一个结果只会有一个任务，重复发布才能幂等合并。
 * `plan` 任务没有范围，id 就是 `plan:<projectId>@<projectRev>`。
 */
export function taskIdOf({ kind, resultKey, range }) {
  if (kind === 'plan') return `plan:${resultKey}`;
  return `${kind}:${resultKey}:${range.from}-${range.to}`;
}

/**
 * 卡片级指纹锁的锁键（F.1）：`<kind>:<input.contentKey>`，一张卡的一种结果一把锁。
 * 只有快照和轨道流有；没有内容键的任务不参与锁，返回 null。入站任务、TaskView、队列内部的任务都能传。
 */
export function lockKeyOf(task) {
  if (!isObj(task) || !LOCK_KINDS.has(task.kind)) return null;
  const contentKey = isObj(task.input) ? task.input.contentKey : undefined;
  return typeof contentKey === 'string' && contentKey !== '' ? `${task.kind}:${contentKey}` : null;
}

/** 出站消息：类型 + 字段 + epoch（C6），回包再带上入站的 reqId。字段深拷贝，收件方改它不影响队列。 */
export function makeMessage(epoch, type, fields, reqId) {
  const msg = { type, ...structuredClone(fields ?? {}), epoch };
  if (reqId !== undefined) msg.reqId = reqId;
  return msg;
}

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isReqId = (v) => typeof v === 'string' || isNum(v);

function str(v, name) {
  if (typeof v !== 'string') bad(`${name} 必须是字符串`);
  return v;
}
function nonEmpty(v, name) {
  if (typeof v !== 'string' || v === '') bad(`${name} 必须是非空字符串`);
  return v;
}
function int(v, name) {
  if (!isInt(v)) bad(`${name} 必须是整数`);
  return v;
}
function oneOf(v, set, name) {
  if (!set.has(v)) bad(`${name} 必须是 ${[...set].join(' / ')} 之一`);
  return v;
}
/** 可选字段：undefined 与 null 都算没给 */
const absent = (v) => v === undefined || v === null;
function optStr(v, name) { return absent(v) ? null : str(v, name); }
function optInt(v, name) { return absent(v) ? null : int(v, name); }
/** 可选的布尔：只有 undefined 算没给，null 和其它类型都算格式错误（同 task.fail 的 retryable） */
function optBool(v, name) {
  if (v !== undefined && typeof v !== 'boolean') bad(`${name} 必须是布尔值`);
  return v === true;
}
function optNumOrNull(v, name) {
  if (absent(v)) return null;
  if (!isNum(v)) bad(`${name} 必须是数或 null`);
  return v;
}
function strArray(v, name) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(`${name} 必须是字符串数组`);
  return [...v];
}
/** 「原样保存」的对象：深拷贝一份，拷不了（函数、循环里的怪东西）就当格式错误 */
function plainObject(v, name) {
  if (!isObj(v)) bad(`${name} 必须是对象`);
  try { return structuredClone(v); } catch { return bad(`${name} 无法复制`); }
}

function parseRange(v, name) {
  if (!isObj(v)) bad(`${name} 必须是对象`);
  const unit = oneOf(v.unit, RANGE_UNITS, `${name}.unit`);
  const from = int(v.from, `${name}.from`);
  const to = int(v.to, `${name}.to`);
  if (from < 0 || from > to) bad(`${name} 须满足 0 <= from <= to`);
  return { unit, from, to };
}

function parseWeight(v, name) {
  const w = plainObject(v, name);
  oneOf(w.class, WEIGHT_CLASSES, `${name}.class`);
  optNumOrNull(w.estMs, `${name}.estMs`);
  optNumOrNull(w.frames, `${name}.frames`);
  return w;
}

function parseTaskInput(v, i) {
  const at = `tasks[${i}]`;
  if (!isObj(v)) bad(`${at} 不是对象`);
  const id = nonEmpty(v.id, `${at}.id`);
  const kind = oneOf(v.kind, KINDS, `${at}.kind`);
  const resultKey = nonEmpty(v.resultKey, `${at}.resultKey`);
  // tier 只对 snapshot 有意义：snapshot 必填，其余忽略（不校验也不保存）
  const tier = kind === 'snapshot' ? oneOf(v.tier, TIERS, `${at}.tier`) : null;
  if (!isObj(v.source)) bad(`${at}.source 必须是对象`);
  const projectId = nonEmpty(v.source.projectId, `${at}.source.projectId`);
  const projectRev = int(v.source.projectRev, `${at}.source.projectRev`);
  const derivedFrom = optStr(v.source.derivedFrom, `${at}.source.derivedFrom`);
  let range = null;
  if (kind === 'plan') {
    if (!absent(v.range)) bad(`${at}.range：plan 任务没有范围，必须是 null`);
    if (resultKey !== `${projectId}@${projectRev}`) bad(`${at}.resultKey 必须等于 source 的 projectId@projectRev`);
  } else {
    range = parseRange(v.range, `${at}.range`);
  }
  const expected = taskIdOf({ kind, resultKey, range });
  if (id !== expected) bad(`${at}.id 必须是 ${expected}`);
  return {
    // takeover 只决定这一次发布怎么处理锁（F.1），不存进任务，TaskView 里也没有
    takeover: optBool(v.takeover, `${at}.takeover`),
    id, kind, tier, resultKey, range,
    // source 里自报的 userId / tenantId / publisher / publishedAt 在这里就丢掉，由队列按连接填（A.4）
    source: { projectId, projectRev, derivedFrom },
    input: absent(v.input) ? {} : plainObject(v.input, `${at}.input`),
    weight: absent(v.weight) ? null : parseWeight(v.weight, `${at}.weight`),
    requires: absent(v.requires) ? {} : plainObject(v.requires, `${at}.requires`),
    priority: absent(v.priority) ? 0 : int(v.priority, `${at}.priority`),
  };
}

function parseResume(v) {
  if (absent(v)) return [];
  if (!Array.isArray(v)) bad('resume 必须是数组');
  return v.map((r, i) => {
    if (!isObj(r)) bad(`resume[${i}] 不是对象`);
    return { id: str(r.id, `resume[${i}].id`), token: int(r.token, `resume[${i}].token`) };
  });
}

/** 令牌类消息（progress / complete / release / fail）共有的两个字段 */
function tokenFields(m) {
  return { id: str(m.id, 'id'), token: int(m.token, 'token') };
}

const PARSERS = new Map([
  ['node.hello', (m) => ({
    nodeId: nonEmpty(m.nodeId, 'nodeId'),
    profile: oneOf(m.profile, PROFILES, 'profile'),
    envFingerprint: optStr(m.envFingerprint, 'envFingerprint'),
    capabilities: absent(m.capabilities) ? {} : plainObject(m.capabilities, 'capabilities'),
    codeVersions: absent(m.codeVersions) ? [] : strArray(m.codeVersions, 'codeVersions'),
    maxConcurrent: optInt(m.maxConcurrent, 'maxConcurrent'),
    resume: parseResume(m.resume),
  })],
  ['publisher.hello', (m) => ({ publisherId: nonEmpty(m.publisherId, 'publisherId') })],
  ['queue.watch', (m) => ({
    projects: m.projects === 'all' ? 'all' : strArray(m.projects, "projects（或 'all'）"),
  })],
  ['task.publish', (m) => {
    if (!Array.isArray(m.tasks) || m.tasks.length === 0) bad('tasks 必须是非空数组');
    return { tasks: m.tasks.map(parseTaskInput) };
  }],
  ['task.unsubscribe', (m) => {
    const byIds = m.ids !== undefined;
    const byProject = m.projectId !== undefined || m.projectRev !== undefined;
    if (byIds === byProject) bad('ids 与 projectId(+projectRev) 二选一');
    if (byIds) return { ids: strArray(m.ids, 'ids'), projectId: null, projectRev: null };
    return { ids: null, projectId: nonEmpty(m.projectId, 'projectId'), projectRev: optInt(m.projectRev, 'projectRev') };
  }],
  ['card.lock', (m) => ({
    kind: oneOf(m.kind, LOCK_KINDS, 'kind'),
    contentKey: nonEmpty(m.contentKey, 'contentKey'),
    envFingerprint: nonEmpty(m.envFingerprint, 'envFingerprint'),
    takeover: optBool(m.takeover, 'takeover'),
  })],
  ['task.claim', (m) => ({ id: str(m.id, 'id'), expectVersion: int(m.expectVersion, 'expectVersion') })],
  // done 可以是 null：节点会话在还没报过进度时续约，发的就是 done: null（契约 B.5）
  ['task.progress', (m) => ({ ...tokenFields(m), done: optNumOrNull(m.done, 'done') })],
  ['task.complete', (m) => ({ ...tokenFields(m), result: absent(m.result) ? null : plainObject(m.result, 'result') })],
  ['task.release', (m) => ({ ...tokenFields(m), reason: optStr(m.reason, 'reason') })],
  ['task.fail', (m) => {
    if (m.retryable !== undefined && typeof m.retryable !== 'boolean') bad('retryable 必须是布尔值');
    return { ...tokenFields(m), error: optStr(m.error, 'error'), retryable: m.retryable !== false };
  }],
]);

/**
 * 校验一条入站消息。
 * 成功：`{ ok: true, type, reqId, body }`，`body` 是规范化的深拷贝；
 * 失败：`{ ok: false, reqId, detail }`，`reqId` 只在它本身合法时带回。
 */
export function parseInbound(message) {
  if (!isObj(message)) return { ok: false, reqId: undefined, detail: '消息不是对象' };
  const reqId = isReqId(message.reqId) ? message.reqId : undefined;
  try {
    if (message.reqId !== undefined && reqId === undefined) bad('reqId 只能是字符串或数字');
    const parse = typeof message.type === 'string' ? PARSERS.get(message.type) : undefined;
    if (!parse) bad(`未知的 type：${typeof message.type === 'string' ? message.type : `（${typeof message.type}）`}`);
    return { ok: true, type: message.type, reqId, body: parse(message) };
  } catch (err) {
    if (err instanceof BadMessage) return { ok: false, reqId, detail: err.message };
    throw err;
  }
}
