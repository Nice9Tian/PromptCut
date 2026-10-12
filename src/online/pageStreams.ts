/**
 * 本页产流的**编排**(任务书 `docs/plan/render-refactor-task.md`「甲二」;做法与〔裁〕见 `docs/plan/browser-stream-task.md`「本页产流」)。
 *
 * 线上没有能切分的节点时,身份为电脑的在线页面在后台舞台闲时自己生成单卡轨道流、推到素材服务、自己播;产物和经队列产的是同一种东西
 * (键、清单、层表里的那一行都相同,计划在 `pageStreamPlan.ts`,与服务端对拍),别的成员的页面、之后上线的桌面应用和渲染主机直接用。
 *
 * 本模块只有判据与次序,不碰舞台、网络、存储:它们由宿主(`src/editor/browserNodeHost.ts`)经 `deps` 注入。宿主每拍调一次 `tick()`。
 *
 * # 什么时候轮到本页自己产(〔裁〕)
 *
 *   1. 本页是浏览器节点(当节点的条件全部成立、拿到了指纹、探到了编码器)—— 身份为手机的页面、低内存档不当节点,也就不产;
 *   2. 本页这一版的清单计划已经发出去(清单 = 本页自己判重的片段:只为自己打开的项目、自己要播的卡),其中有本页能产的单卡流还没有产物;
 *   3. **线上没有能切分的节点接这份计划**:计划发出去满 `PAGE_STREAM_WAIT_MS` 仍然没人认领(队列里它还是 `open`)。怎么知道:把同一个计划任务
 *      再发布一次(队列对同一个结果键只合并,不另起任务),回包里带它此刻的状态;有活要做的期间每 `PAGE_STREAM_POLL_MS` 问一次。
 *      状态是 `claimed` / `done` 就是有节点接了活:不产;正在产的做完当前这一帧就停(已经推完的分段按任务 id 留着,切分方把同一个任务
 *      发进队列后本页的节点认领它,只补缺的)。`failed`(切分方试过、做不成)与 `open` 同样对待;
 *   4. 闲(`deps.isIdle()`:宿主的闲的判据,再加本页的节点手里没有认领)。
 *
 * # 先查,没有才产
 *
 * 每一段任务动手之前查两处:本页自己的键在内容库里有没有覆盖这一段的清单、块都在素材服务上(另一个同指纹的页面、上一次打开时产的);
 * 层表里这张卡、这个内容键的流有没有别的候选(桌面应用、渲染主机、别的指纹的页面),它的清单覆盖这一段、块都在。查到就直接用,不产。
 * 产的途中每 `PAGE_STREAM_RECHECK_MS` 再查一次,别处已经产出来了就做完当前这一帧停下,改用现成的。
 *
 * # 层表
 *
 * 没有切分方时层表没人写:本页开工前把自己的那一行并进内容库里的层表(`mergeLayerStreams`,只动 `streams` 里自己这几行),
 * 之后每隔 `PAGE_STREAM_ROWS_MS` 核对一次还在不在(两个页面同时写,后写的会盖掉先写的)。有切分方接了活之后不再写(层表归它)。
 *
 * # 让路
 *
 * 规矩同浏览器节点认领任务(`browserNode.ts` 的 D8):播放、拖动、后台舞台来了更急的活 —— 当前这一帧做完就停,`YIELD_FRAME_MAX_MS` 之内
 * 做不完就中止;页面隐藏不等当前帧,马上中止。已经推完的分段留着,闲下来接着补缺的。
 *
 * # 给以后留的口子
 *
 * 用户已定轨道流先产「每 15 帧一张的稀疏版」再补满密度、稀疏版在打开项目测量时就产(`docs/plan/html-snapshot-removal-dryrun.md`
 * 第 4.2、4.3 节,等用户确认)。这里现在只产满密度的一趟、只在闲时产,但不把这两样写死:
 *   - 产几趟、每趟多密由 `passes` 定(现在是 `[{ name: 'dense', stride: 1 }]`),`produce` 拿到这一趟的 `stride`,宿主的编码那一段照它取帧;
 *   - 什么时候可以动手由 `deps.isIdle()` 与 `deps.planState()` 两个注入的判据定,换触发时机(测量时就产)换这两个函数,不用改这里的次序。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor。
 */
import type { NodeTask } from "./browserNode.ts";
import { YIELD_FRAME_MAX_MS, type YieldCause } from "./browserNode.ts";
import { layerStreamCandidates, mergeLayerStreams, pageStreamRow, pageStreamTasks, type PageStreamRow, type PageStreamSpec } from "./pageStreamPlan.ts";

/** 清单计划发出去之后没人认领,等这么久本页才自己产(三级数字;空闲的切分方认领计划在一秒以内,留出它正忙着别的活的余量) */
export const PAGE_STREAM_WAIT_MS = 5000;
/** 有活要做的期间,多久问一次计划的状态 */
export const PAGE_STREAM_POLL_MS = 2000;
/** 产的途中多久查一次「别处产出来了没有」 */
export const PAGE_STREAM_RECHECK_MS = 5000;
/** 多久核对一次本页的那几行还在不在层表里 */
export const PAGE_STREAM_ROWS_MS = 20_000;
/** 一段任务连着做不成几次就不再试(这一版里) */
export const PAGE_STREAM_ATTEMPTS = 3;

/** 队列里这一版清单计划的状态;`none` = 问不到(没发出去、连接断着) */
export type PlanState = "none" | "open" | "claimed" | "done" | "failed";

/** 本页最近发成的那一版清单计划(`planPublisher.ts` 的 `current()`) */
export interface PublishedPlan {
  /** 计划任务的 id(`plan:<项目>@<版本>#clips:<签名>`) */
  id: string;
  projectId: string;
  projectRev: number;
  /** 清单:本页自己判重的片段 */
  clips: readonly string[];
  /** 发成的时刻 */
  at: number;
}

/** 一趟产流:`stride` 是每几帧取一张(1 = 每帧都取,满密度) */
export interface PageStreamPass { name: string; stride: number }

export interface PageStreamsDeps {
  now: () => number;
  /** 本页此刻能不能产流:是浏览器节点、拿到了指纹、探到了编码器、有代码指纹 */
  capable: () => boolean;
  /** 闲不闲(宿主的闲的判据,再加本页的节点手里没有认领) */
  isIdle: () => boolean;
  /** 本页最近发成的那一版清单计划;没有回 null */
  plan: () => PublishedPlan | null;
  /** 问队列这一版计划此刻的状态;问不到回 `none` */
  planState: () => Promise<PlanState>;
  /** 这一版里本页能产的单卡流(`pageStreamPlan.ts` 的 `planPageStreams`,宿主按那一版的已确认项目算);算不出回 null(过一会儿再算) */
  specs: (plan: PublishedPlan) => Promise<{ specs: PageStreamSpec[]; skipped: Record<string, string>; project: unknown } | null>;
  /** 嵌在页面里的代码版本(写进任务的 `requires.codeVersion`,与切分方出的任务同形) */
  codeVersion?: string | null;
  /** 先查之一:本页自己的键,这一段的清单在内容库里、块都在素材服务上 */
  lookupOwn: (task: NodeTask) => Promise<boolean>;
  /** 先查之二:别的候选的结果键,这一段的清单在内容库里、块都在素材服务上 */
  lookupOther: (resultKey: string, range: { from: number; to: number }) => Promise<boolean>;
  /** 内容库里现有的层表(没有回 null);读不到抛 */
  readLayerMap: (project: unknown) => Promise<unknown | null>;
  /** 把整张层表写回内容库 */
  writeLayerMap: (project: unknown, body: Record<string, unknown>) => Promise<void>;
  /**
   * 产一段:逐帧向后台舞台要像素、送编码器、推分段,全部分段齐了写清单。每帧前问 `yielding()`,为真就做完当前帧停手、回 `yielded`;
   * `signal` 中止时尽早停手(抛)。`stride` 是这一趟每几帧取一张。
   */
  produce: (job: { task: NodeTask; project: unknown; stride: number; signal: AbortSignal; yielding: () => boolean }) => Promise<"done" | "yielded">;
  /** 这个结果键有了可用的流(本页产的、先查查到的):宿主叫在线来源认它、马上重取层表 */
  onAlive?: (resultKey: string) => void;
  /** 产几趟、每趟多密;缺省只产满密度的一趟 */
  passes?: readonly PageStreamPass[];
  waitMs?: number;
  pollMs?: number;
  recheckMs?: number;
  rowsMs?: number;
}

type TaskState = "todo" | "produced" | "have" | "elsewhere" | "failed";
interface Job { task: NodeTask; spec: PageStreamSpec; pass: PageStreamPass; state: TaskState; fails: number; retryAt: number; via: string | null }
interface Ctx {
  plan: PublishedPlan;
  specs: PageStreamSpec[] | null;
  skipped: Record<string, string>;
  project: unknown;
  jobs: Job[];
  /** 本页有份的流(产了、在产、或查到自己的键已经有):层表里要有本页的那一行 */
  mine: Set<string>;
  rowsAt: number;
  specsAt: number;
  probe: { state: PlanState; at: number; flying: boolean };
}
interface Run {
  job: Job;
  controller: AbortController;
  yieldCause: YieldCause | null;
  yieldAt: number | null;
  /** 不是让路的停手原因:`splitter`(有切分方接了活)、`elsewhere`(别处产出来了)、`plan-changed`、`stopped` */
  stop: string | null;
  recheckAt: number;
  rechecking: boolean;
}

export interface PageStreamsDebug {
  /** `off` 不产(不是节点、没有计划)、`planning` 在算这一版的流、`none` 这一版没有本页能产的、`waiting` 在等有没有切分方、
   *  `taken` 有切分方接了活、`checking` 在先查、`producing` 在产、`idle-wait` 等闲、`done` 都有了 */
  state: "off" | "planning" | "none" | "waiting" | "taken" | "checking" | "producing" | "idle-wait" | "done";
  planId: string | null;
  planState: PlanState;
  /** 计划发出去多久了 */
  waitedMs: number | null;
  streams: { clipId: string; contentKey: string; streamKey: string; firstSegment: number; lastSegment: number; mine: boolean }[];
  jobs: { id: string; clipId: string; pass: string; state: TaskState; via: string | null; fails: number }[];
  skipped: Record<string, string>;
  running: { id: string; yield: string | null; stop: string | null } | null;
  counters: {
    /** 本页产完的任务数、先查查到自己的键已有的、查到别的候选已有的 */
    produced: number; have: number; elsewhere: number; failed: number;
    /** 开工次数(每次进 `produce` 记一次,让路后回来再记一次) */
    starts: number;
    yields: Record<string, number>;
    stops: Record<string, number>;
    aborts: number;
    probes: number; rowsWritten: number; rowsFailed: number;
  };
  lastError: string | null;
}

export interface PageStreams {
  tick(): void;
  /** 让路(规矩同浏览器节点):`hidden` 马上中止,其余做完当前这一帧就停 */
  yieldFor(cause: YieldCause): void;
  /** 此刻有没有在产(宿主据此不让节点同时认领:两条路共用后台舞台的同一份活) */
  running(): boolean;
  /** 下线、换项目:停下、清掉这一版的记账 */
  stop(reason?: string): void;
  debug(): PageStreamsDebug;
}

export function createPageStreams(deps: PageStreamsDeps): PageStreams {
  const passes: readonly PageStreamPass[] = deps.passes?.length ? deps.passes : [{ name: "dense", stride: 1 }];
  const waitMs = deps.waitMs ?? PAGE_STREAM_WAIT_MS, pollMs = deps.pollMs ?? PAGE_STREAM_POLL_MS;
  const recheckMs = deps.recheckMs ?? PAGE_STREAM_RECHECK_MS, rowsMs = deps.rowsMs ?? PAGE_STREAM_ROWS_MS;
  let ctx: Ctx | null = null;
  let run: Run | null = null;
  /** 在算流、在先查、在写层表:一次只做一件 */
  let working = false;
  let phase: "planning" | "checking" | null = null;
  let lastError: string | null = null;
  const counters: PageStreamsDebug["counters"] = { produced: 0, have: 0, elsewhere: 0, failed: 0, starts: 0, yields: {}, stops: {}, aborts: 0, probes: 0, rowsWritten: 0, rowsFailed: 0 };
  const bump = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };
  const fail = (e: unknown) => { lastError = String((e as Error)?.message ?? e).slice(0, 200); };
  const alive = (key: string) => { try { deps.onAlive?.(key); } catch { /* 宿主坏了 */ } };

  const stopRun = (reason: string, abort = false) => {
    const r = run;
    if (!r) return;
    if (!r.stop) r.stop = reason;
    if (abort) r.controller.abort();
  };

  /** 把本页有份的那几行并进层表;没有变化不写 */
  const syncRows = async (c: Ctx): Promise<void> => {
    c.rowsAt = deps.now();
    const rows: PageStreamRow[] = (c.specs ?? []).filter((s) => c.mine.has(s.streamKey)).map((s) => pageStreamRow(c.project, s));
    if (!rows.length) return;
    try {
      const existing = await deps.readLayerMap(c.project);
      if (ctx !== c) return;
      const body = mergeLayerStreams(existing, { project: c.project as Record<string, any>, rows, now: deps.now() });
      if (!body) return;
      await deps.writeLayerMap(c.project, body);
      counters.rowsWritten++;
    } catch (e) {
      counters.rowsFailed++;
      fail(e);
      // 没写成:下一拍再核对
      c.rowsAt = -Infinity;
    }
  };

  /** 先查:这一段的结果在不在。回查到的结果键(自己的或别的候选的),没有回 null */
  const check = async (c: Ctx, job: Job): Promise<{ resultKey: string; own: boolean } | null> => {
    const range = { from: job.task.range!.from, to: job.task.range!.to };
    if (await deps.lookupOwn(job.task).catch(() => false)) return { resultKey: job.task.resultKey, own: true };
    let map: unknown = null;
    try { map = await deps.readLayerMap(c.project); } catch { return null; }
    for (const cand of layerStreamCandidates(map, job.spec.topClipId, job.spec.contentKey)) {
      if (cand.resultKey === job.task.resultKey) continue;
      if (await deps.lookupOther(cand.resultKey, range).catch(() => false)) return { resultKey: cand.resultKey, own: false };
    }
    return null;
  };

  const settle = (c: Ctx, job: Job, found: { resultKey: string; own: boolean }) => {
    job.state = found.own ? "have" : "elsewhere";
    job.via = found.resultKey;
    if (found.own) { counters.have++; c.mine.add(job.spec.streamKey); } else counters.elsewhere++;
    alive(found.resultKey);
  };

  const loadSpecs = async (c: Ctx) => {
    working = true;
    phase = "planning";
    c.specsAt = deps.now();
    try {
      const got = await deps.specs(c.plan);
      if (ctx !== c || !got) return;
      c.specs = got.specs;
      c.skipped = got.skipped;
      c.project = got.project;
      c.jobs = passes.flatMap((pass) => got.specs.flatMap((spec) => pageStreamTasks(spec, { projectId: c.plan.projectId, projectRev: c.plan.projectRev, codeVersion: deps.codeVersion ?? null, derivedFrom: c.plan.id })
        .map((task): Job => ({ task, spec, pass, state: "todo", fails: 0, retryAt: -Infinity, via: null }))));
    } catch (e) {
      fail(e);
    } finally {
      working = false;
      phase = null;
    }
  };

  const taken = (c: Ctx) => c.probe.state === "claimed" || c.probe.state === "done";

  const pollPlan = (c: Ctx) => {
    const now = deps.now();
    // `done` 是终态:切分方接了这一版,不用再问(再发布过了保留期的任务会把它重新建出来)
    if (c.probe.flying || c.probe.state === "done" || now - c.probe.at < pollMs) return;
    c.probe.flying = true;
    c.probe.at = now;
    counters.probes++;
    void deps.planState().then((s) => { if (ctx === c) c.probe.state = s; }, () => { if (ctx === c) c.probe.state = "none"; }).finally(() => { c.probe.flying = false; });
  };

  const start = (c: Ctx, job: Job) => {
    const r: Run = { job, controller: new AbortController(), yieldCause: null, yieldAt: null, stop: null, recheckAt: deps.now() + recheckMs, rechecking: false };
    run = r;
    counters.starts++;
    let work: Promise<"done" | "yielded">;
    try {
      work = deps.produce({ task: job.task, project: c.project, stride: job.pass.stride, signal: r.controller.signal, yielding: () => r.yieldCause !== null || r.stop !== null });
    } catch (e) { work = Promise.reject(e); }
    work.then((out) => {
      if (out === "done") {
        job.state = "produced";
        job.via = job.task.resultKey;
        counters.produced++;
        alive(job.task.resultKey);
        // 这一段的清单进了内容库:马上核对一次层表里本页的那一行
        if (ctx === c) c.rowsAt = -Infinity;
      } else if (r.stop) bump(counters.stops, r.stop);
      else bump(counters.yields, r.yieldCause ?? "urgent");
    }, (e) => {
      if (r.controller.signal.aborted) {
        counters.aborts++;
        if (r.stop) bump(counters.stops, r.stop); else bump(counters.yields, r.yieldCause ?? "hidden");
        return;
      }
      fail(e);
      job.fails++;
      // 做不成:退避后再试,连着不成就放下这一段(这一版里)
      if (job.fails >= PAGE_STREAM_ATTEMPTS || (e as { retryable?: boolean })?.retryable === false) { job.state = "failed"; counters.failed++; }
      else job.retryAt = deps.now() + 2000 * job.fails;
    }).finally(() => { if (run === r) run = null; });
  };

  /** 挑下一段:先查,查不到、还闲、还没人接活才开工 */
  const step = async (c: Ctx) => {
    working = true;
    phase = "checking";
    try {
      const now = deps.now();
      const job = c.jobs.find((j) => j.state === "todo" && now >= j.retryAt);
      if (!job) return;
      const found = await check(c, job);
      if (ctx !== c) return;
      if (found) { settle(c, job, found); if (found.own) await syncRows(c); return; }
      if (taken(c) || !deps.isIdle() || !deps.capable()) return;
      // 开工前把这一行写进层表:别的页面(和本页的在线来源)据此找这条流的清单
      if (!c.mine.has(job.spec.streamKey)) { c.mine.add(job.spec.streamKey); await syncRows(c); }
      if (ctx !== c || run || taken(c) || !deps.isIdle()) return;
      start(c, job);
    } catch (e) {
      fail(e);
    } finally {
      working = false;
      phase = null;
    }
  };

  /** 产的途中再查一次:别处已经有了就做完当前帧停下,改用现成的 */
  const recheck = (c: Ctx, r: Run) => {
    const now = deps.now();
    if (r.rechecking || r.stop || now < r.recheckAt) return;
    r.rechecking = true;
    r.recheckAt = now + recheckMs;
    void check(c, r.job).then((found) => {
      if (!found || run !== r || ctx !== c || r.job.state !== "todo") return;
      stopRun("elsewhere");
      settle(c, r.job, found);
    }, () => {}).finally(() => { r.rechecking = false; });
  };

  const drop = (reason: string) => {
    stopRun(reason, true);
    ctx = null;
  };

  return {
    tick() {
      const now = deps.now();
      const plan = deps.plan();
      let capable = false;
      try { capable = deps.capable() === true; } catch { capable = false; }
      if (!plan || !capable) { if (ctx || run) drop(!plan ? "no-plan" : "incapable"); return; }
      if (!ctx || ctx.plan.id !== plan.id) {
        // 换了一版(或清单变了):旧一版在产的马上停(那一版的流多半已经过期)
        if (run) stopRun("plan-changed", true);
        ctx = { plan, specs: null, skipped: {}, project: null, jobs: [], mine: new Set(), rowsAt: -Infinity, specsAt: -Infinity, probe: { state: "none", at: -Infinity, flying: false } };
      }
      const c = ctx;
      const r = run;
      // 让路之后当前帧迟迟做不完(播放、拖动时后台活的门关了):不再等,中止
      if (r && r.yieldAt !== null && now - r.yieldAt >= YIELD_FRAME_MAX_MS && !r.controller.signal.aborted) r.controller.abort();
      if (!c.specs) { if (!working && now - c.specsAt >= 1000) void loadSpecs(c); return; }
      if (!c.jobs.length) return;
      const pending = c.jobs.some((j) => j.state === "todo");
      // 没活了就不再问队列(一条消息也不多发)
      if (pending || r) pollPlan(c);
      if (taken(c)) { if (r) stopRun("splitter"); return; }
      // 本页的那几行还在不在层表里(后写的会盖掉先写的)
      if (!working && c.mine.size && now - c.rowsAt >= rowsMs) { working = true; void syncRows(c).finally(() => { working = false; }); return; }
      if (r) { recheck(c, r); return; }
      if (!pending || working) return;
      if (c.probe.state !== "open" && c.probe.state !== "failed") return;
      if (now - c.plan.at < waitMs) return;
      let idle = false;
      try { idle = deps.isIdle() === true; } catch { idle = false; }
      if (!idle) return;
      void step(c);
    },
    yieldFor(cause) {
      const r = run;
      if (!r) return;
      if (cause === "hidden") { if (!r.yieldCause) r.yieldCause = cause; r.controller.abort(); return; }
      if (!r.yieldCause) { r.yieldCause = cause; r.yieldAt = deps.now(); }
    },
    running: () => run !== null,
    stop(reason = "stopped") { drop(reason); },
    debug() {
      const c = ctx;
      const now = deps.now();
      let state: PageStreamsDebug["state"] = "off";
      if (c) {
        if (!c.specs) state = "planning";
        else if (!c.jobs.length) state = "none";
        else if (run) state = "producing";
        else if (taken(c)) state = "taken";
        else if (!c.jobs.some((j) => j.state === "todo")) state = "done";
        else if (phase === "checking") state = "checking";
        else if ((c.probe.state !== "open" && c.probe.state !== "failed") || now - c.plan.at < waitMs) state = "waiting";
        else state = "idle-wait";
      }
      return {
        state, planId: c?.plan.id ?? null, planState: c?.probe.state ?? "none", waitedMs: c ? now - c.plan.at : null,
        streams: (c?.specs ?? []).map((s) => ({ clipId: s.topClipId, contentKey: s.contentKey, streamKey: s.streamKey, firstSegment: s.firstSegment, lastSegment: s.lastSegment, mine: c!.mine.has(s.streamKey) })),
        jobs: (c?.jobs ?? []).map((j) => ({ id: j.task.id, clipId: j.spec.topClipId, pass: j.pass.name, state: j.state, via: j.via, fails: j.fails })),
        skipped: { ...(c?.skipped ?? {}) },
        running: run ? { id: run.job.task.id, yield: run.yieldCause, stop: run.stop } : null,
        counters: { ...counters, yields: { ...counters.yields }, stops: { ...counters.stops } },
        lastError,
      };
    },
  };
}
