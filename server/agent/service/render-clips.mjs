/**
 * 云端 Agent 一次写入落地后,要发布预渲染的片段(`render-request.mjs` 的清单计划用)。
 *
 * 顶层片段照旧按这次写到的片段 id 挑(`renderableClips`)。剪辑段里的卡(用户 2026-10-21 定:剪辑段里的卡和没有剪辑段时一样,
 * 重卡各自走轨道流)在计划一侧是摊平视图里的虚拟片段(`src/kernel/cutFlatten.mjs`,id `<段 id>~…~<卡的片段 id>`),渲染节点
 * 按这个 id 产流。所以还要收:
 *   - 路径上有这次写到的片段 id 的虚拟片段(改了被引用剪辑里的卡、改了某一层剪辑段;任意深度,同一剪辑被引用几次就有几份);
 *   - 和上一次相比内容变了或新出现的虚拟片段(`before`:上一次写入之后的签名表)。别的剪辑里的改动、切换激活剪辑这类写入,
 *     ops 里点不出激活剪辑里的片段 id,只能靠比对摊平视图看出来。没有上一次的签名表时(这一代进程的第一次写入)全部收,
 *     宁可多发(渲染节点已经有的流照锁复用,不重产)。
 * 素材片段不收。没有剪辑段的项目结果与 `renderableClips` 逐项相同。挑出来的只是候选,判轻的再去掉(下面「只发重卡」)。
 *
 * 摊平视图的内核函数(`flatPlanProject` 等)由宿主经 ssr-host 的载入缝取来、注入(`kernel` 参数;独立入口不直接引用 `src/`,
 * `server/test/accept-018-rest-ssr-seam.test.mjs`)。没注入时只按片段 id 挑顶层片段,和原来一样。
 */
import { MEDIA_CARD_IDS, renderableClips } from './render-request.mjs';

/** 摊平视图要的内核函数在 `src/` 里的位置(宿主用 `loadModule` 载) */
export const FLAT_KERNEL_MODULE = '/src/kernel/cutFlatten.mjs';

/** 激活剪辑摊平视图里每张剪辑段里的卡(虚拟片段)的内容签名;没有剪辑段回空表 */
export function flatCardSigs(project, kernel = null) {
  const out = new Map();
  if (!project || !kernel || !kernel.hasFlatSegments(project)) return out;
  const { flatPlanProject, isFlatClipId } = kernel;
  for (const tr of flatPlanProject(project).tracks ?? []) {
    if (!tr || tr.hidden || tr.sourceOnly) continue;
    for (const c of tr.clips ?? []) {
      if (!c || !isFlatClipId(c.id) || typeof c.cardId !== 'string' || !c.cardId || MEDIA_CARD_IDS.has(c.cardId)) continue;
      out.set(c.id, JSON.stringify(c));
    }
  }
  return out;
}

/**
 * @param {any} project 写入之后的项目
 * @param {string[]} clipIds 这次写到的片段 id(`user-editing.mjs` 的 `clipIdsOfOps`)
 * @param {{ kernel?: object | null, before?: Map<string, string> | null, sigs?: Map<string, string> }} [o]
 */
export function renderClipsOf(project, clipIds, { kernel = null, before = null, sigs = flatCardSigs(project, kernel) } = {}) {
  const out = renderableClips(project, clipIds);
  if (!sigs.size) return out;
  const want = new Set(Array.isArray(clipIds) ? clipIds : []);
  const seen = new Set(out);
  for (const [id, sig] of sigs) {
    const hit = id.split(kernel.FLAT_SEP).some((part) => want.has(part)) || !before || before.get(id) !== sig;
    if (hit && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/*
 * ---------------------------------------------------------------- 只发重卡
 *
 * 语义 `product/agent.md`「发出任务后可以离开」:托管方的渲染节点生成的是**被改动的重卡**给成员预览用的轨道流。渲染节点把清单里的
 * 片段一律当重卡产流(`server/render-node/local-node.mjs` 的 `listPlanOverrides`),所以轻卡不能进清单。轻重的判定照在线页面同一套
 * (`src/editor/agentHeavyClips.ts`):文档服务里的共享成本记录 + `planPipelines`;没有记录的卡按页面测完之前的兜底(声明 `direct` 判轻,其余判重)。
 *
 * 判定不在写入那一刻做,在写入攒满 `delayMs`(取预渲染重试同一个防抖,`render-request.mjs` 的 `debounceMs`)之后做:Agent 改了参数,
 * 卡的成本身份就变了,要等在线成员的页面把新身份测完、写进文档服务才有记录;没人在线时等不到,按没有记录办。
 * 一轮收尾时(`flush`)不再等,攒着的马上判、马上交出去。
 *
 * 退路(都按原来的做法:候选片段全部交出去):判定模块载不了;成本记录取不到(连不上、旧文档服务不许 Agent 读成本记录)。
 */

/** 判定模块在 `src/` 里的位置(宿主用 `loadModule` 载;先载注册表,卡片定义靠 import 时的副作用登记) */
export const HEAVY_JUDGE_MODULE = '/src/editor/agentHeavyClips.ts';
const HEAVY_JUDGE_PRELOAD = ['/src/cards/index.ts', '/src/parts/index.ts'];

/** 经载入缝载判定函数 `judgeHeavyClips(project, records, candidates) → { heavy, light }`;载不了抛 */
export async function loadHeavyJudge(loadModule) {
  for (const id of HEAVY_JUDGE_PRELOAD) await loadModule(id);
  const mod = await loadModule(HEAVY_JUDGE_MODULE);
  if (typeof mod?.judgeHeavyClips !== 'function') throw new Error('判定模块没有 judgeHeavyClips');
  return mod.judgeHeavyClips;
}

/**
 * 写入 → 攒 `delayMs` → 判轻重 → 只把判重的交给 `emit`。一个对话(账号模式:一条任务进程)一份。
 *
 * @param {object} o
 * @param {{ pick(project, clipIds): string[] }} o.picker `createRenderClipPicker` 的结果(写入那一刻挑候选,签名表按写入记)
 * @param {() => ({ project: any, rev?: number } | null)} o.replica 此刻的项目副本与版本
 * @param {() => (Function | null)} o.judge 判定函数(`loadHeavyJudge` 的结果);还没载好、载不了回 null
 * @param {() => Promise<object[] | null>} o.records 本项目的共享成本记录;取不到回 null
 * @param {(clips: string[], info: { rev: number | null }) => void} o.emit 交出判重的片段
 * @param {number} o.delayMs
 */
export function createHeavyRenderGate({ picker, replica, judge = () => null, records = async () => null, emit, delayMs, log = () => {} }) {
  let pending = new Set();
  let timer = null;
  let closed = false;
  let chain = Promise.resolve();
  const say = (event, fields) => { try { log(event, fields); } catch { /* 日志不影响发布 */ } };
  const current = () => { try { return replica() ?? null; } catch { return null; } };

  async function judgeNow() {
    if (!pending.size) return;
    const candidates = [...pending];
    pending = new Set();
    let clips = candidates;
    let light = [];
    let why = 'no-judge';
    let count = null;
    const fn = (() => { try { return judge(); } catch { return null; } })();
    if (typeof fn === 'function' && current()?.project) {
      let recs = null;
      try { recs = await records(); } catch { recs = null; }
      if (Array.isArray(recs)) {
        count = recs.length;
        try {
          const r = fn(current()?.project ?? null, recs, candidates);
          clips = r.heavy;
          light = r.light;
          why = 'judged';
        } catch (err) {
          why = 'judge-failed';
          say('agent.render.judge-failed', { message: String(err?.message ?? err).slice(0, 120) });
        }
      } else why = 'no-records';
    }
    say('agent.render.judged', { candidates: candidates.length, heavy: clips.length, light: light.length, why, ...(count === null ? {} : { records: count }) });
    if (!clips.length) return;
    const rev = current()?.rev;
    emit(clips, { rev: Number.isSafeInteger(rev) ? rev : null });
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    chain = chain.then(judgeNow).catch((err) => say('agent.render.judge-failed', { message: String(err?.message ?? err).slice(0, 120) }));
    return chain;
  }

  return {
    /** 一次写入落地了:按此刻的项目挑候选,攒着 */
    note(clipIds) {
      if (closed) return;
      for (const id of picker.pick(current()?.project ?? null, clipIds)) pending.add(id);
      if (!pending.size) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, Math.max(0, Number(delayMs) || 0));
      timer.unref?.();
    },
    /** 一轮收尾:攒着的马上判、马上交出去 */
    flush,
    /** 收场:停表,攒着的不再交 */
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      pending.clear();
    },
    /** 诊断、测试 */
    pending: () => [...pending],
  };
}

/**
 * 有状态的挑法:记着上一次写入之后的签名表(一个对话 / 一个任务进程一份)。`kernel` 可以是模块本身,也可以是一个回模块的函数
 * (宿主异步载完以后才有;还没载好时按没注入办)。
 */
export function createRenderClipPicker(kernel = null) {
  let before = null;
  const k = () => (typeof kernel === 'function' ? kernel() : kernel) ?? null;
  return {
    pick(project, clipIds) {
      const sigs = flatCardSigs(project, k());
      const clips = renderClipsOf(project, clipIds, { kernel: k(), before, sigs });
      before = sigs;
      return clips;
    },
    /** 先记一份(绑定之后、第一次写入之前),第一次写入就只收变了的 */
    prime(project) { before = flatCardSigs(project, k()); },
  };
}
