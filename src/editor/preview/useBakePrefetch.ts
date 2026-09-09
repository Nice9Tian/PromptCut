import { useEffect, useRef, useState } from "react";
import { planBakes, defaultBudgetBytes, type BakeMoment } from "./bakePlan";

/**
 * 空闲时把贴图预先烘好。排队规则见 bakePlan.ts,这里只管**什么时候动手**。
 *
 * # 三条不能破的规矩
 *
 * 1. **不跟用户抢。** 烘一张要起一个 Chrome、四五秒,而且服务端那条渲染路是**串行**的
 *    (enqueue)。所以用户正在看的那张要是排在预烘后面,就得干等 —— 本来是来提速的,
 *    反而卡了一下。于是:只在浏览器空闲时发,而且前台一有烘焙请求就立刻让路(见下面那道闸)。
 * 2. **一次只烘一张。** 并发发过去也是在服务端排队,只会让「让路」变得不可能。
 * 3. **拖动时不动手。** 拖进度条会连续改 t,每一格都重排一次队没有意义。
 *    等它停下来一会儿再说(IDLE_MS)。
 *
 * # 为什么盘点要问服务端
 *
 * 缓存在磁盘上,浏览器关一次页面就全忘了 —— 上次开编辑器烘出来的文件,前端一个都不认识。
 * 所以每轮先问一次 /api/vision/bake-status:哪些已经有了、各自多大、还有哪些是没人认领的旧文件。
 * 不问的话占用永远算不准,out/media 只会一直涨。
 *
 * 顺带解决了另一件事:**键只认服务端算的那一个**。烘焙、盘点、清理三方共用 `bakeTarget`,
 * 前端不自己算一套 —— 两处各算各的,迟早会「明明烘过却当成没烘」,而且不报错。
 *
 * # 烘哪几个时刻不由这里决定
 *
 * 一张卡在它那几秒里是会动的,要烘的是**若干个时刻**;挑哪几个是 `bakeTime.ts` 的事,
 * 由调用方算好了传进来。这里只管「什么时候动手」和「按什么顺序、留多少」。
 */

/** 用户停手多久算「空闲」 */
const IDLE_MS = 600;
/** 一轮做完歇多久再盘点下一轮 —— 别把服务端和磁盘一直吵醒 */
const REST_MS = 4000;
/**
 * 没活干的时候歇多久。
 *
 * 全烘完之后如果还按 REST_MS 去问,就是**每 4 秒列一次目录、stat 上百个文件,一直到关页面为止**。
 * 实测就是这样:界面上什么都没发生,网络面板里 bake-status 一条接一条。
 * 所以没活干就逐次翻倍往后退,退到一分钟一次;用户一改东西立刻退回 REST_MS(见 backoff 的重置)。
 */
const IDLE_MAX_MS = 60000;

/**
 * 前台烘焙的让路闸。
 *
 * 3D 视图看到缺贴图会自己发一次烘焙请求(那是用户正盯着的),
 * 而服务端渲染是串行的。前台开工前后各调一次,预烘就会停下来等它。
 */
let foreground = 0;
export function beginForegroundBake() { foreground++; }
export function endForegroundBake() { foreground = Math.max(0, foreground - 1); }

/** 要烘的一个时刻。哪几个时刻由调用方挑(见 bakeTime.ts 的 sampleTimesFor) */
export interface WantedMoment {
  clipId: string;
  t: number;
  start: number;
  end: number;
}

export interface PrefetchStatus {
  /**
   * 已经烘好的:`<clipId>@<t>` → 贴图 URL。
   * 键带上时刻,因为同一张卡会烘好几个时刻,只按 clipId 存会互相覆盖。
   */
  ready: Map<string, string>;
  /** 已经烘好的文件一共占多少磁盘(实测字节) */
  footprintBytes: number;
  budgetBytes: number;
  fileCount: number;
  /** 正在烘的那张(给状态条显示) */
  baking: { clipId: string; phase: string } | null;
  /** 还排着多少张 */
  queued: number;
  /** 这一轮删掉了几个过期文件 */
  evicted: number;
  error: string | null;
}

const EMPTY: PrefetchStatus = {
  ready: new Map(), footprintBytes: 0, budgetBytes: 0, fileCount: 0,
  baking: null, queued: 0, evicted: 0, error: null,
};

/** 浏览器空闲时回调;没有 requestIdleCallback 的就退化成一个短 timeout */
function onIdle(fn: () => void, timeout = 2000): () => void {
  const ric = (globalThis as any).requestIdleCallback;
  if (typeof ric === "function") {
    const id = ric(fn, { timeout });
    return () => (globalThis as any).cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 200);
  return () => clearTimeout(id);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `ready` 里认这一刻的键:同一张卡的不同时刻是不同的图,只按 clipId 存会互相盖掉。
 *
 * 格式是**约定**:`<clipId>@<t>`,拆的时候从后往前找 `@`(clipId 里不会有)。
 * Scene3DView 就是这么拆回去的 —— 这里要是改了格式,那边会**静默**对不上号,
 * 表现成「预烘明明烘好了,板子上还是色块」。要改就两处一起改。
 */
export const momentId = (clipId: string, t: number) => `${clipId}@${t}`;

export function useBakePrefetch({
  project,
  t,
  moments,
  enabled,
  budgetBytes,
}: {
  project: any;
  t: number;
  /** 整条片子要烘的所有时刻。调用方算好传进来(bakeTime.ts 的 sampleTimesFor) */
  moments: WantedMoment[];
  enabled: boolean;
  budgetBytes?: number;
}): PrefetchStatus {
  const [status, setStatus] = useState<PrefetchStatus>(EMPTY);
  /*
   * project / t / moments 走 ref:它们每拖一下都在变,进 effect 依赖会让整轮调度不停重启,
   * 结果就是永远停在「盘点」那一步,一张也烘不出来。
   * effect 只认 enabled,循环里每次都读最新值。
   */
  const projRef = useRef(project);
  projRef.current = project;
  const tRef = useRef(t);
  tRef.current = t;
  const momentsRef = useRef(moments);
  momentsRef.current = moments;
  /** 最后一次改动的时刻 —— 用来判断用户是不是还在拖 */
  const touchedAt = useRef(Date.now());
  useEffect(() => { touchedAt.current = Date.now(); }, [project, t]);

  const budget = budgetBytes ?? defaultBudgetBytes((navigator as any)?.deviceMemory);

  useEffect(() => {
    if (!enabled) { setStatus(EMPTY); return; }
    let dead = false;
    let cancelIdle: (() => void) | null = null;
    const ready = new Map<string, string>();

    /** 等到「浏览器空闲」且「用户停手」且「前台没在烘」 */
    const waitIdle = () => new Promise<void>((resolve) => {
      const attempt = () => {
        if (dead) return resolve();
        const quiet = Date.now() - touchedAt.current >= IDLE_MS;
        if (quiet && foreground === 0) return resolve();
        cancelIdle = onIdle(attempt);
      };
      cancelIdle = onIdle(attempt);
    });

    const post = async (url: string, payload: unknown) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `${url} 失败(HTTP ${res.status})`);
      return data;
    };

    /** 没活干就往后退,有活干或用户动了就退回最短 */
    let backoff = REST_MS;

    (async () => {
      while (!dead) {
        let didSomething = false;
        const roundStartedAt = touchedAt.current;
        try {
          await waitIdle();
          if (dead) return;

          const proj = projRef.current;
          const now = tRef.current;
          const wanted = momentsRef.current;
          if (!wanted.length) { await sleep(backoff); backoff = Math.min(IDLE_MAX_MS, backoff * 2); continue; }

          /* ① 盘点:哪些已经有了、各自多大、还有哪些没人认领 */
          const st = await post("/api/vision/bake-status", {
            project: proj,
            clips: wanted.map((m) => ({ clipId: m.clipId, t: m.t })),
            size: 1024,
          });
          if (dead) return;

          /*
           * 键一律用服务端算的那个(bakeTarget)。前端不自己算一套 ——
           * 两处各算各的,迟早会「明明烘过却当成没烘」,而且不报错,只是白白多等五秒。
           * 盘点是按 (clipId, t) 一一对应回来的,所以顺序就是 wanted 的顺序。
           */
          const known = new Map<string, number>();
          const planMoments: BakeMoment[] = [];
          for (const it of st.items ?? []) {
            // 烘不了的(素材段之类)服务端会带 error 回来,跳过,别一直重试
            if (!it.key) continue;
            const w = wanted.find((m) => m.clipId === it.clipId && m.t === it.t);
            if (!w) continue;
            planMoments.push({ clipId: w.clipId, t: w.t, start: w.start, end: w.end, key: it.key });
            if (typeof it.bytes === "number") {
              known.set(it.key, it.bytes);
              if (it.url) ready.set(momentId(w.clipId, w.t), it.url);
            }
          }
          // 没人认领的旧文件也计入占用 —— 不数它们的话,磁盘上的东西永远删不掉
          for (const o of st.orphans ?? []) known.set(o.key, o.bytes);

          /* ② 排队:眼前 → 两侧 → 从 0 铺;同一份名单顺便算出该删哪些 */
          const plan = planBakes({ moments: planMoments, t: now, budgetBytes: budget, known });

          /* ③ 先删再烘:腾出来的空间这一轮就能用上 */
          let evicted = 0;
          if (plan.evict.length) {
            // 键全是服务端给的,它那边还会再拿目录比对一次,删不到 out/media 以外的东西
            const gone = await post("/api/vision/bake-evict", { keys: plan.evict });
            evicted = gone.deleted?.length ?? 0;
            for (const k of gone.deleted ?? []) known.delete(k);
            if (evicted) didSomething = true;
          }
          if (dead) return;

          let footprint = plan.footprintBytes;
          setStatus({
            ready: new Map(ready), footprintBytes: footprint, budgetBytes: budget,
            fileCount: st.fileCount ?? 0, baking: null, queued: plan.jobs.length, evicted, error: null,
          });

          /*
           * ④ **一批一批烘**,每批填满服务端的渲染池。
           *
           * 以前是一张一张发的,而服务端一次能并行跑好几个(28 核的机器上是 7 个)——
           * 一张一张发等于让池子空着 6 个槽位干等。批的大小跟着服务端报的 concurrency 走,
           * 别在前端猜:那个数是按机器的核心数和空闲内存算的,只有服务端知道。
           *
           * 批不宜再大:一批发出去就不能中途改主意了,而用户随时可能拖走 ——
           * 刚好填满池子,既不浪费槽位,也不会让「回去重排」等太久。
           */
          const lot = Math.max(1, Math.min(8, Number(st.concurrency) || 1));
          let done = 0;
          for (let i = 0; i < plan.jobs.length; i += lot) {
            const batch = plan.jobs.slice(i, i + lot);
            const job = batch[0];
            if (dead) return;
            /*
             * 满了就停。**最多超出一个文件**(几十 KB)—— 因为没烘出来之前不知道它多大,
             * 而为了这几十 KB 去估一个大小,反而会把整套东西建在猜测上。
             */
            if (footprint >= budget) break;
            await waitIdle();
            if (dead) return;
            // 用户在这期间动过了 → 队伍已经不对了,回去重排
            if (Date.now() - touchedAt.current < IDLE_MS) break;

            didSomething = true;
            setStatus((s) => ({ ...s, baking: { clipId: job.clipId, phase: job.phase }, queued: plan.jobs.length - done }));
            try {
              const out = await post("/api/vision/bake-batch", {
                project: projRef.current,
                clips: batch.map((j) => ({ clipId: j.clipId, t: j.t })),
                size: 1024,
              });
              for (const b of out.baked ?? []) {
                /*
                 * 按「卡 + 时刻」存,而且时刻用**服务端回的那个**:一批里有好几张,
                 * 拿 batch[0] 的 t 去认会把整批都记成同一刻(而且不报错,只是贴图对不上)。
                 */
                ready.set(momentId(b.clipId, b.t), b.url);
                if (typeof b.bytes === "number") footprint += b.bytes;
              }
            } catch (e: any) {
              // 一批烘不出来不该让整轮停摆,下一轮盘点会重新遇到它们
              if (!dead) setStatus((s) => ({ ...s, error: String(e?.message || e) }));
            }
            done += batch.length;
            setStatus((s) => ({
              ...s,
              ready: new Map(ready),
              footprintBytes: footprint,
              baking: null,
              queued: Math.max(0, plan.jobs.length - done),
            }));
          }
        } catch (e: any) {
          if (!dead) setStatus((s) => ({ ...s, baking: null, error: String(e?.message || e) }));
        }
        /*
         * 这一轮干了活,或者用户在这期间动过东西 → 下一轮马上来;
         * 否则说明已经烘齐了,逐次翻倍往后退,免得空转着一直问服务端。
         */
        backoff = didSomething || touchedAt.current !== roundStartedAt
          ? REST_MS
          : Math.min(IDLE_MAX_MS, backoff * 2);
        await sleep(backoff);
      }
    })();

    return () => { dead = true; cancelIdle?.(); };
  }, [enabled, budget]);

  return status;
}
