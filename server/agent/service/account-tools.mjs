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
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createToolJobs } from './tool-jobs.mjs';
import { reapOrphan, removeDirFully, REV_FILE } from '../../web/hosted/session.mjs';
import { createShotsTools, readShotsConfig } from './perception/shots.mjs';
import { createSubjectTools, readSubjectConfig } from './perception/subject.mjs';
import { createSttTools } from './perception/stt.mjs';
import { createTrackTools, TRACK_ERROR_TEXT } from './perception/track.mjs';
import { createMotionTools } from './hosted-motion.mjs';
import { createWorkflowTools } from './hosted-workflow.mjs';
import { createHostedBrowserTools, hostedBrowserDir, hostedBrowserRoot } from './hosted-browser.mjs';
import { createPageControlTools } from './page-bridge.mjs';
import { createHandoffTools } from './hosted-handoff.mjs';
import { createCollectBridge, COLLECT_BRIDGE_TEXT } from './collect-bridge.mjs';
import { readCollectConfig } from './hosted-collect.mjs';
import { CLOUD_PROVIDER_FAMILIES } from './cloud-tools.mjs';
import { ACCOUNT_TOOL_SETTING_KEYS, validateAccountToolSettings } from '../../agent-service/account-tool-settings.mjs';

export const ACCOUNT_TOOL_DEFAULTS = Object.freeze({
  /** 一轮说完话以后,最多等它名下还没做完的后台作业多久(各作业自己另有时限;这只是防卡死的兜底) */
  settleMs: 60 * 60_000,
  /** 等后台作业时多久数一次账本(只读本进程里的账本,不问文档服务) */
  settlePollMs: 2_000,
  /** 等后台作业时多久向文档服务核一次「这一轮还算数」 */
  settleAuthMs: 30_000,
  /** 核的时候文档服务一时答不上:隔这么久再核,一次比一次久;答不上不算「不算数」,作业接着做 */
  settleAuthBackoffMs: Object.freeze([2_000, 5_000, 15_000, 30_000]),
  /** 开工时顺手清别的对话留着记号的浏览器数据,一次最多看几个 */
  sweepMax: 64,
});

/** 代下没开放时,登录那两个工具回给模型的话(委托那一包原来的两句会说「之后由他的电脑带着登录态下载」,这时不成立) */
export const LOGIN_WITHOUT_DELEGATE_TEXT = Object.freeze({
  already: '发起人的电脑上已经有这个站点没过期的登录态,不用再登录。注意:云端的 collect_download 这一版用不到他电脑上的登录态,仍按未登录的画质下载;要登录后的画质,得由他在自己电脑上的 PromptCut 里下载。',
  checked: '发起人的电脑上已经登录,登录态只留在他的电脑上。注意:云端的 collect_download 这一版用不到它,仍按未登录的画质下载;要登录后的画质,得由他在自己电脑上的 PromptCut 里下载。',
});

/** 后台作业的账本打不开时,用到作业的工具回给模型的话 */
export const TOOL_JOBS_BROKEN_TEXT = '这个对话的后台作业记录在云节点上打不开(文件坏了或读不了),语音识别、镜头识别、主体识别、运动追踪和一键流程这次用不了。不要重试,告诉用户这一步云端现在做不了,能换做法就换;别的工具照常用。';

// 设置文件里 `tools` 一节认的键与形状检查:和 root 入口共用一张名单(`account-tool-settings.mjs`),这里只是转出
export { ACCOUNT_TOOL_SETTING_KEYS, validateAccountToolSettings };

const coded = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const absoluteFile = (value) => typeof value === 'string' && path.isAbsolute(value) && fs.existsSync(value);

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
  const delegate = env.PROMPTCUT_AGENT_COLLECT_DELEGATE;
  if (delegate !== undefined && !['0', '1'].includes(delegate)) bad('PROMPTCUT_AGENT_COLLECT_DELEGATE 只能是 0 或 1');
  return { shots, subject, stt, track, browser, collect, collectDelegate: delegate === '1', ...(optionalStages ? { workflow: { optionalStages } } : {}) };
}

/** 这个对话放工具状态(账本、追踪结果、委托记录)的目录 */
export const accountToolStateDir = (dataDir, projectId, conversationId) =>
  path.join(dataDir, 'tenants', projectId, 'conversations', conversationId, 'tools');

/**
 * 「这个对话的浏览器数据要清」的记号,放在这个对话的浏览器目录里。
 *
 * 谁留、谁清:主服务(对话转私有、对话或项目被删时)留记号;**清由任务用户一侧做**——生产上主服务和任务进程是两个系统用户、
 * 同在一个组里,浏览器在用户数据目录下建的子目录只有属主进得去(0700),主服务删不动。主服务留完记号也顺手删一次,
 * 删得动就删(同一个用户的机器、测试),删不动不算错:任务进程在这个对话下一次用浏览器之前照记号清,
 * 别的对话的任务进程开工时也顺手清(`sweepMarkedBrowsers`)。
 * 所以记号必须组内读得到(0660),读不到不许当成「没有记号」。
 */
export const BROWSER_PURGE_MARK = 'purge.json';
const PURGE_ALL_REASONS = Object.freeze(['conversation-deleted', 'project-deleted']);

/** 留记号:先写临时文件再改名(读的一方不会读到半截),组内可读写 */
export function writeBrowserPurgeMark(dir, reason, at = Date.now()) {
  const file = path.join(dir, BROWSER_PURGE_MARK);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ reason, at }), { mode: 0o660 });
  // 进程的 umask 比部署说明要求的(0007)严时,上面那一下会少给权限:这里补到组内可读写
  try { fs.chmodSync(tmp, 0o660); } catch { /* 改不了:读的一方会照「读不到」报出来 */ }
  fs.renameSync(tmp, file);
}

/**
 * 读一个浏览器目录里的记号。没有记号回 null;有记号回 `{ reason }`;记号在但读不到、读不懂回 `{ reason: 'private', unreadable: true, code }`
 * ——照「要清」办(留着数据等于没清),并由调用方记日志。
 */
export function readBrowserPurgeMarkIn(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, BROWSER_PURGE_MARK), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    return { reason: 'private', unreadable: true, code: typeof error?.code === 'string' ? error.code : 'error' };
  }
  try {
    const mark = JSON.parse(text);
    if (mark && typeof mark.reason === 'string') return { reason: mark.reason, ...(Number.isFinite(mark.at) ? { at: mark.at } : {}) };
  } catch { /* 下面按读不懂办 */ }
  return { reason: 'private', unreadable: true, code: 'bad-mark' };
}
export const readBrowserPurgeMark = (dataDir, scope) => readBrowserPurgeMarkIn(hostedBrowserDir(dataDir, scope));

/**
 * 照记号清一个浏览器目录:除了记号和清单版本的计数,别的先删;全删掉了才撤记号(删到一半停下、或有删不动的,记号还在,下次接着清)。
 * 中途发现记号没了(别的进程已经清完)就停手,不去删它之后新建的东西。`all`:对话或项目没了,连计数和目录本身一起删。
 * 调用方先确认没有浏览器进程占着这个目录。回「是不是清干净了」。
 */
export async function removeMarkedBrowserData(dir, { all = false, timeoutMs = 8_000 } = {}) {
  const mark = path.join(dir, BROWSER_PURGE_MARK);
  let names;
  try { names = fs.readdirSync(dir); } catch (error) { return error?.code === 'ENOENT'; }
  let ok = true;
  for (const name of names) {
    if (name === BROWSER_PURGE_MARK || name === REV_FILE) continue;
    if (!fs.existsSync(mark)) return true;
    ok = await removeDirFully(path.join(dir, name), { timeoutMs }) && ok;
  }
  if (!ok) return false;
  if (all) return removeDirFully(dir, { timeoutMs });
  // 记号的位置上不管是什么(正常是个文件)都撤掉
  try { fs.rmSync(mark, { force: true, recursive: true }); } catch { return false; }
  return !fs.existsSync(mark);
}

/**
 * 对话被删以后,这个对话在任务用户一侧还留着的东西要全清:云端浏览器的整个目录,以及对话目录
 * (`tenants/<项目>/conversations/<对话>/`:模型历史,和里面 `tools/` 下的作业账本、追踪结果、委托记录)。
 * 这些都是任务用户的文件(对话目录是 0700),主服务够不到。办法和上面的记号是一个:主服务把「这个对话要清」记进一张待清的单子
 * (`<共用数据目录>/conversation-purges/`,一个对话一个小文件,组内可读写),自己尽力删一次;删不动的由任务用户一侧清——
 * 任何一条任务的进程开工时都会照单子清(`sweepMarkedBrowsers`),所以被删的对话再也没有任务也清得掉。
 * 进程不归这里管:对话被删时还在跑的任务已经被文档服务叫停、由 root 把整组进程关掉了。
 */
export const CONVERSATION_PURGE_DIR = 'conversation-purges';
const purgeSeg = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !/^\.+$/.test(value);
const purgeEntryFile = (dataDir, scope) => path.join(dataDir, CONVERSATION_PURGE_DIR, `${sha256(`${scope.projectId}\n${scope.conversationId}`).slice(0, 40)}.json`);

/** 把一个被删的对话记进待清的单子(主服务调)。同一个对话再记一次只是覆盖 */
export function queueConversationPurge(dataDir, scope, at = Date.now()) {
  if (!purgeSeg(scope?.projectId) || !purgeSeg(scope?.conversationId)) throw coded('conversation-purge-invalid');
  const file = purgeEntryFile(dataDir, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o770 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ projectId: scope.projectId, conversationId: scope.conversationId, at }), { mode: 0o660 });
  try { fs.chmodSync(tmp, 0o660); } catch { /* 改不了:读的一方会照「读不到」报出来 */ }
  fs.renameSync(tmp, file);
}

/** 待清的单子。读不到、读不懂的那几条照实回 `{ unreadable: true, code }`(不知道是哪个对话,清不了,由调用方记日志) */
export function listConversationPurges(dataDir) {
  const dir = path.join(dataDir, CONVERSATION_PURGE_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{40}\.json$/.test(name)).sort(); }
  catch (error) { return error?.code === 'ENOENT' ? [] : [{ unreadable: true, code: typeof error?.code === 'string' ? error.code : 'error' }]; }
  return names.map((name) => {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (purgeSeg(row?.projectId) && purgeSeg(row.conversationId) && purgeEntryFile(dataDir, row) === path.join(dir, name)) return { projectId: row.projectId, conversationId: row.conversationId };
      return { unreadable: true, code: 'bad-entry' };
    } catch (error) { return { unreadable: true, code: typeof error?.code === 'string' ? error.code : 'bad-entry' }; }
  });
}

/**
 * 清一个被删的对话在共用数据目录里留着的东西(见上)。全清掉了就把它从单子上划掉。谁都可以调:任务用户一侧调是真的清;
 * 主服务调是「顺手删一次」,删不动(回 `removed: false`)不算错。浏览器正被一个活着的任务进程用着时不动它(`held`)。
 * @returns {Promise<{ removed: boolean, held: boolean }>}
 */
export async function purgeConversationData(dataDir, scope, { timeoutMs = 8_000 } = {}) {
  if (!purgeSeg(scope?.projectId) || !purgeSeg(scope?.conversationId)) throw coded('conversation-purge-invalid');
  /** 确实不在了才算(够不到、看不见不算「不在」) */
  const gone = (target) => { try { fs.lstatSync(target); return false; } catch (error) { return error?.code === 'ENOENT'; } };
  let held = false;
  let browser = null;
  try { browser = hostedBrowserDir(dataDir, scope); } catch { browser = null; }
  if (browser && !gone(browser)) {
    try {
      const reaped = await reapOrphan(browser, { timeoutMs, respectLiveOwner: true });
      held = reaped.liveOwner === true || reaped.stillHeld === true;
      if (!held) await removeDirFully(browser, { timeoutMs });
    } catch { /* 下面按「还在」办 */ }
  }
  const conversation = path.join(dataDir, 'tenants', scope.projectId, 'conversations', scope.conversationId);
  if (!gone(conversation)) { try { await removeDirFully(conversation, { timeoutMs }); } catch { /* 下面按「还在」办 */ } }
  const removed = (!browser || gone(browser)) && gone(conversation);
  if (removed) { try { fs.rmSync(purgeEntryFile(dataDir, scope), { force: true }); } catch { /* 划不掉:下次再来一遍,什么都不剩也不报错 */ } }
  return { removed, held };
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

  /** 这次工具调用的事件上下文(落地的写入记在它上面,宿主据此发预渲染重试计划)。按调用各一份:并行的工具调用互不相扰 */
  const trackScope = new AsyncLocalStorage();
  const callTrack = () => trackScope.getStore() ?? {};

  // 后台作业的账本。打不开(文件坏了、读不了)不拖垮这条任务:用到作业的那几族换成一个只会如实回「用不了」的替身,
  // 网页操作、发起人页面那几族和不用工具的对话照常。
  let jobs = null;
  try {
    jobs = createToolJobs({ databasePath: path.join(stateDir, 'tool-jobs.db'), authorize, verifyFence, now });
    closers.push(() => jobs.close());
  } catch (error) {
    skipped.jobs = typeof error?.code === 'string' ? error.code : 'error';
    say('agent.account-tools.ledger-broken', { code: skipped.jobs, detail: String(error?.message ?? '').slice(0, 160) });
  }
  /** 账本打不开时顶上去的替身:这一族的工具全认,一律回同一句明确的话;没有要收的东西 */
  const brokenLedger = (family) => Object.freeze({
    handles: new Set(CLOUD_PROVIDER_FAMILIES[family] ?? []),
    call: async () => ({ ok: false, cloudUnavailable: true, code: 'TOOL_JOBS_UNAVAILABLE', error: TOOL_JOBS_BROKEN_TEXT }),
    close: async () => ({ childrenClosed: true, streamsClosed: true, workPending: 0 }),
  });
  const withJobs = (family, build) => mount(family, jobs ? build : () => brokenLedger(family));

  const stt = withJobs('stt', () => createSttTools({ resources: trackedResources, assets, jobs, workspace: workspaceFor, commitTranscript,
    runtime: config.stt ?? {}, limits: { engines: ['faster-whisper'], ...(limitsIn.stt ?? {}) }, now }));
  const shots = withJobs('shots', () => createShotsTools({ config: config.shots ?? null, resources: trackedResources, assets, jobs, workspace: workspaceFor,
    project, kernel, limits: limitsIn.shots ?? {}, now, log }));
  const subject = withJobs('subject', () => createSubjectTools({ config: config.subject ?? null, resources: trackedResources, assets, jobs, workspace: workspaceFor,
    project, egress, kernel, limits: limitsIn.subject ?? {}, now, log }));
  const track = withJobs('track', () => createTrackTools({ contextAccess: trackedResources.contextAccess, resources: trackedResources, jobs, assets, workspace: workspaceFor,
    databasePath: path.join(stateDir, 'track-results.db'), python: config.track ?? null,
    readProject: async (ctx) => { same(ctx); return (await snapshot()).project; },
    // 云端不替用户安装拓展:缺省不开(部署者要开得另给出网闸与锁定清单,这一期不接)
    install: { enabled: false, env: {} }, egress, limits: limitsIn.track ?? {}, now }));
  withJobs('motion', () => (track ? createMotionTools({ contextAccess: trackedResources.contextAccess, tracks: track,
    commit: ({ context: ctx, fenceRevision, tool, apply }) => { same(ctx); return commit(tool, apply, { fenceRevision, track: callTrack() }); } }) : null));
  withJobs('workflow', () => createWorkflowTools({ resources: trackedResources, jobs, workspace: workspaceFor,
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
    // 采集登录与代下:委托逻辑在这个进程里(它要用这条任务的「项目素材」与写权限核对),经薄客户端问主服务的反向通道。
    // 登录那两个工具照常接(登录窗口开在发起人自己的桌面上,他看得见);代下缺省不交出去,见下面的 `collectDelegate`
    try {
      collectBridge = createCollectBridge({ bridge: pageBridge, databasePath: path.join(stateDir, 'collect-delegations.sqlite'),
        assets: { verifyRef: (ctx, ref) => projectAssets.verifyRef(ctx, ref) }, authorize,
        register: (ctx, entry) => { same(ctx); return registerCollected(entry); }, now, log });
      for (const name of CLOUD_PROVIDER_FAMILIES.collect ?? []) byTool.set(name, 'collect');
    } catch (error) { skipped.collect = typeof error?.code === 'string' ? error.code : 'error'; say('agent.account-tools.skipped', { family: 'collect', code: skipped.collect }); }
  } else {
    for (const family of ['page', 'handoff', 'collect']) skipped[family] = 'no-internal-channel';
  }
  const delegateDownload = config.collectDelegate === true;
  const names = Object.freeze(new Set(byTool.keys()));

  /* ---------- 调用 ---------- */

  /** 宿主的工具调用号 → 提供者要的请求号(8～64 个安全字符);没有调用号就现起一个(那次调用不幂等) */
  const requestIdOf = (callId) => {
    const raw = typeof callId === 'string' ? callId.replace(/[^A-Za-z0-9_-]/g, '') : '';
    if (raw.length >= 8 && raw.length <= 64) return raw;
    return raw ? `c${sha256(`${context.runGrantId}\n${callId}`).slice(0, 40)}` : `c${randomUUID().replace(/-/g, '')}`;
  };
  const USAGE_VENDOR = { web: 'chromium', stt: 'python', shots: 'ffmpeg', subject: 'python', track: 'python', motion: 'builtin', workflow: 'builtin' };

  const browserDir = hostedBrowserDir(dataDir, scope);
  const closeMs = Number.isFinite(limitsIn.web?.closeMs) ? limitsIn.web.closeMs : 8_000;
  /**
   * 这个对话的浏览器数据要不要先清(主服务在对话转私有、对话或项目被删时留的记号;也可能是上一个进程没清完)。
   * 这个进程是任务用户:这里是一定删得动的那一方。先把这个对话的浏览器关掉、确认没有残留进程占着,再照记号清。
   */
  async function purgeBrowserIfMarked() {
    const mark = readBrowserPurgeMarkIn(browserDir);
    if (!mark) return false;
    if (mark.unreadable) say('agent.account-tools.purge-mark-unreadable', { code: mark.code });
    const all = PURGE_ALL_REASONS.includes(mark.reason);
    // 关不成(这个进程里的浏览器已经整体收掉了等)不挡后面:下面按进程号再确认一遍没有残留的占着
    if (web) { try { await web.closeConversation(scope, { reason: all ? mark.reason : 'private', removeProfile: false }); } catch { /* 见上 */ } }
    const reaped = await reapOrphan(browserDir, { timeoutMs: closeMs });
    const removed = reaped.stillHeld === true ? false : await removeMarkedBrowserData(browserDir, { all, timeoutMs: closeMs });
    say('agent.account-tools.browser-purged', { reason: mark.reason, removed, ...(reaped.stillHeld === true ? { held: true } : {}) });
    return removed;
  }

  /**
   * 别的对话留着记号的浏览器数据:主服务删不动的那些(见 `BROWSER_PURGE_MARK` 的说明),由碰巧在跑的任务进程顺手清掉,
   * 这样对话或项目被删以后,即使那个对话再也没有任务,数据也不会一直留在盘上。正被别的任务进程用着的不动(它自己会清)。
   */
  async function sweepMarkedBrowsers() {
    let seen = 0, removed = 0, unreadable = 0;
    // 先照「被删的对话」那张单子清(浏览器目录、对话目录连同作业账本);自己正在跑的这个对话不动(被删的对话不会再有任务,这里只是稳妥)
    let deleted = 0, deletedRemoved = 0;
    for (const entry of listConversationPurges(dataDir).slice(0, limits.sweepMax)) {
      if (fencing || closing) break;
      if (entry.unreadable) { unreadable += 1; continue; }
      if (entry.projectId === context.projectId && entry.conversationId === context.conversationId) continue;
      deleted += 1;
      try { if ((await purgeConversationData(dataDir, entry, { timeoutMs: closeMs })).removed) deletedRemoved += 1; } catch { /* 这一个下次再清 */ }
    }
    const report = () => { if (seen || deleted || unreadable) say('agent.account-tools.browser-swept', { marked: Math.min(seen, limits.sweepMax), removed, ...(deleted ? { conversations: deleted, conversationsRemoved: deletedRemoved } : {}), ...(unreadable ? { unreadable } : {}) }); };
    let projects = [];
    try { projects = fs.readdirSync(hostedBrowserRoot(dataDir), { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { report(); return { seen, removed }; }
    outer: for (const project of projects) {
      let conversations = [];
      try { conversations = fs.readdirSync(path.join(hostedBrowserRoot(dataDir), project.name), { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { continue; }
      for (const conversation of conversations) {
        if (fencing || closing) break outer;
        const dir = path.join(hostedBrowserRoot(dataDir), project.name, conversation.name);
        if (dir === browserDir) continue;
        const mark = readBrowserPurgeMarkIn(dir);
        if (!mark) continue;
        if (++seen > limits.sweepMax) break outer;
        if (mark.unreadable) unreadable += 1;
        try {
          const reaped = await reapOrphan(dir, { timeoutMs: closeMs, respectLiveOwner: true });
          if (reaped.liveOwner === true || reaped.stillHeld === true) continue;
          if (await removeMarkedBrowserData(dir, { all: PURGE_ALL_REASONS.includes(mark.reason), timeoutMs: closeMs })) removed += 1;
        } catch { /* 这一个下次再清 */ }
      }
    }
    report();
    return { seen, removed };
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
      const out = await trackScope.run(trackCtx ?? {}, () => (family === 'web' || family === 'motion'
        ? provider.call(tool, args ?? {}, context)
        : provider.call(tool, args ?? {}, context, { requestId })));
      if (out && typeof out === 'object' && out.ok === false) ok = false;
      return out;
    } catch (error) { ok = false; throw error; }
    finally {
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
  let sweeping = null;
  /**
   * 文档服务的控制(种类)→ 浏览器数据的去留,照网页操作那一包原来的规矩(`hosted-browser.mjs` 文件头的表):
   * 停止、Agent 被关、发起人被踢或退出登录:浏览器进程关掉,数据留着;对话转私有:删(留清单版本的计数);项目被删:全删。
   */
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
      await step('jobs', async () => { if (!jobs) return 'ledger-broken'; if (lastFence === null) return 'no-fence-seen'; await jobs.cancelForFence(context, lastFence); return 'cancelled'; });
      await step('browser', async () => {
        if (!web) return 'unmounted';
        const reason = browserReason(kind);
        const remove = reason === 'private' || reason === 'project-deleted';
        const out = await web.closeConversation(scope, { reason, removeProfile: remove });
        // 该删而没删干净(进程一时没退完):留记号,这个对话的下一条任务、或别的任务进程开工时接着清
        if (remove && out.profileRemoved !== true && fs.existsSync(browserDir)) { try { writeBrowserPurgeMark(browserDir, reason, now()); } catch { /* 目录刚好没了 */ } }
        return { wasOpen: out.wasOpen, exited: out.exited, profileRemoved: out.profileRemoved };
      });
      say('agent.account-tools.fenced', { kind, ...Object.fromEntries(Object.entries(results).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : v])) });
      return results;
    })();
    return fencing;
  }

  /**
   * 这一轮说完话了:等它名下还没做完的后台作业(转写、镜头、主体、追踪、一键流程)做完再往下收。
   *
   * 每隔几秒数一次本进程里的账本(不问文档服务)。另外每隔半分钟向文档服务核一次「这一轮还算数」:
   * 文档服务**明确说不算数了**才停止等待(随后的收尾会把还在跑的作业中断);它一时答不上(断线、重启、超时)不算拒绝,
   * 隔一会儿再核、一次比一次久,作业接着做。`signal` 触发(这一轮被叫停)或到了兜底时限(一小时)也不再等。
   */
  async function settle(signal = null) {
    if (!jobs) return { waited: true, pending: 0 };
    const deadline = now() + limits.settleMs;
    const backoff = Array.isArray(limits.settleAuthBackoffMs) && limits.settleAuthBackoffMs.length ? limits.settleAuthBackoffMs : [limits.settleAuthMs];
    let nextAuthAt = now() + limits.settleAuthMs;
    let authFailures = 0;
    let ledgerFailures = 0;
    const nap = (ms) => new Promise((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      const done = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); };
      const timer = setTimeout(done, ms); timer.unref?.();
      signal?.addEventListener?.('abort', done, { once: true });
    });
    for (;;) {
      if (signal?.aborted || fencing || closing) return { waited: false, reason: 'cancelled' };
      let pending;
      try { pending = await jobs.pending(context); ledgerFailures = 0; }
      catch (error) {
        // 账本一时读不了:再试几次;一直读不了就不等了(如实记下),免得这条任务永远收不了尾
        if (++ledgerFailures >= 5) { say('agent.account-tools.settle-ledger', { code: typeof error?.code === 'string' ? error.code : 'error' }); return { waited: false, reason: 'ledger-unavailable' }; }
        await nap(limits.settlePollMs);
        continue;
      }
      if (!pending) return { waited: true, pending: 0 };
      if (now() > deadline) { say('agent.account-tools.settle-timeout', { pending }); return { waited: false, reason: 'timeout', pending }; }
      if (now() >= nextAuthAt) {
        try {
          const auth = await authorize(context, 'read');
          if (auth?.allowed !== true || !['active', 'retained'].includes(auth.grantState)) { say('agent.account-tools.settle-revoked', { pending }); return { waited: false, reason: 'unauthorized', pending }; }
          authFailures = 0;
          nextAuthAt = now() + limits.settleAuthMs;
        } catch (error) {
          // 明确的拒绝(这一轮已经被收回、不认这个上下文)才停;别的都当暂时性故障
          if (['run-access-denied', 'tool-context-untrusted', 'tool-context-invalid'].includes(error?.code) || [401, 403].includes(error?.status)) {
            say('agent.account-tools.settle-revoked', { pending, code: error?.code ?? null });
            return { waited: false, reason: 'unauthorized', pending };
          }
          const wait = backoff[Math.min(authFailures, backoff.length - 1)];
          authFailures += 1;
          nextAuthAt = now() + wait;
          say('agent.account-tools.settle-auth-retry', { pending, failures: authFailures, code: typeof error?.code === 'string' ? error.code : 'error', retryInMs: wait });
        }
      }
      await nap(limits.settlePollMs);
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
      if (web) await shut('web', () => web.close(reason));
      // 浏览器已经关了;主服务留了「要清」的记号(这一轮跑着的时候对话被转成了私有)就在这里清掉。清不成记号还在,下一轮开头再清
      try { await purgeBrowserIfMarked(); } catch (error) { say('agent.account-tools.browser-purge-failed', { code: typeof error?.code === 'string' ? error.code : 'error' }); }
      if (sweeping) await sweeping.catch(() => {});
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
  // 别的对话留着记号、主服务删不动的浏览器数据:不挡这条任务,在后面慢慢清;收尾时等它清完
  sweeping = sweepMarkedBrowsers().catch(() => ({ seen: 0, removed: 0 }));
  say('agent.account-tools.mounted', { families: [...providers.keys(), ...(collectBridge ? ['collect'] : [])].join(','), skipped: Object.keys(skipped).join(','),
    ledger: Boolean(jobs), delegateDownload: delegateDownload && Boolean(collectBridge) });

  return Object.freeze({
    names,
    handles: (tool) => names.has(tool),
    familyOf: (tool) => byTool.get(tool) ?? null,
    call,
    /** 交给 `hosted-collect.mjs` 的委托口子(这一轮的);没建出来是 null */
    collectDelegate: () => {
      if (!collectBridge || fencing || closing) return null;
      const full = collectBridge.forRun(context);
      // 代下缺省不开:只交登录那两样,`collect_download` 照旧只在云端按未登录的身份下
      if (delegateDownload) return full;
      const honest = (out) => (out?.hint === COLLECT_BRIDGE_TEXT.loginAlready ? { ...out, hint: LOGIN_WITHOUT_DELEGATE_TEXT.already }
        : out?.hint === COLLECT_BRIDGE_TEXT.loginChecked ? { ...out, hint: LOGIN_WITHOUT_DELEGATE_TEXT.checked } : out);
      return Object.freeze({ login: async (...a) => honest(await full.login(...a)), loginCheck: async (...a) => honest(await full.loginCheck(...a)) });
    },
    /** 这个进程里代下开没开(部署配置显式打开、并且采集那一族建出来了) */
    delegateDownload: () => delegateDownload && Boolean(collectBridge),
    /** 运行资源登记器的回执要的「这条任务名下的浏览器进程树是不是确实没了」 */
    treeClosed: async (ctx) => (web ? web.treeClosed(ctx) : true),
    fence, settle, close,
    describe: () => ({ mounted: [...new Set(byTool.values())], skipped: { ...skipped }, tools: names.size, lastFence, ledger: Boolean(jobs), delegateDownload: delegateDownload && Boolean(collectBridge),
      web: web ? { configured: web.describe().configured, open: web.describe().open } : null }),
  });
}
