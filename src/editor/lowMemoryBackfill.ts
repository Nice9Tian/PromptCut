/**
 * 低内存档的补渲(c10a 契约第 17 节;语义 `mechanism/rendering.md`「低内存档」的补渲、`product/document-service.md`
 * 「渲染任务队列」的「补渲排在后面」):低内存档按界限搜索判轻重(`lowMemorySearch.ts`),发现**判重**的层在素材服务里没有产物
 * (按清单判:不在渲染节点写的层表里)时,向队列发布补渲任务 —— 一种带片段清单的计划任务,标 `priority: 'backfill'`。
 * 判轻的卡不发(播放时一直占位,停下时画出,导出时本机逐帧渲;契约 `c10-contract.md` 第 18 节第 8 条)。
 * 界限搜索做完之前不发(还不知道谁重)。
 *
 * - 同一批还在等的不重发:发过的片段在 `BACKFILL_RESEND_MS` 之内、项目版本没变(或刚变不到 `BACKFILL_REV_GRACE_MS`)
 *   都算「还在等」;产物到了(进了层表)就忘掉它;
 * - 页面只发布,不认领(只发 `publisher.hello` 与 `task.publish`,从不发 `node.hello`);
 * - 用户卡、图卡不发(这台设备本来就不显示它们,常驻「需要本地 PC 渲染辅助」)。
 *
 * 任务的形状与队列侧 `server/render-queue/messages.mjs` 的 `backfillPlanTaskOf` 逐字段相同(单测对拍);
 * 这里照抄一份,不从 server 引 —— 页面构建不带服务端模块。
 */
import type { Project } from "../kernel/project";

/** 发过的一批多久之内算「还在等」(不重发);过了还缺就按同一份清单再发一次(幂等,队列里还在的只合并) */
export const BACKFILL_RESEND_MS = 120_000;
/** 项目版本变了之后,旧版本发出去的那一批再等这么久;还缺就按新版本另发(旧版本的项目快照多半已经取不到) */
export const BACKFILL_REV_GRACE_MS = 10_000;
/** 父页多久核一次缺哪些层 */
export const BACKFILL_CHECK_MS = 3_000;

const BACKFILL_KEY_MARK = "#backfill:";

/** 片段清单的签名:与 `server/render-queue/messages.mjs` 的 `backfillSig` 同一个算法(FNV-1a 两轮,base36) */
export function backfillSig(clips: readonly string[]): string {
  const text = [...new Set(clips)].map(String).sort().join("\n");
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  return fnv(0x811c9dc5).toString(36) + fnv(0x2f4a7c15).toString(36);
}

export interface BackfillPlanTask {
  id: string;
  kind: "plan";
  resultKey: string;
  range: null;
  source: { projectId: string; projectRev: number };
  input: { clips: string[] };
  weight: { class: "medium"; estMs: null; frames: null };
  requires: Record<string, never>;
  priority: "backfill";
}

/** 补渲计划任务:`plan:<projectId>@<projectRev>#backfill:<sig>`,带片段清单,标 backfill,不带 requires */
export function backfillPlanTask({ projectId, projectRev, clips }: { projectId: string; projectRev: number; clips: readonly string[] }): BackfillPlanTask {
  const list = [...new Set(clips)].map(String).filter(Boolean).sort();
  const resultKey = `${projectId}@${projectRev}${BACKFILL_KEY_MARK}${backfillSig(list)}`;
  return {
    id: `plan:${resultKey}`, kind: "plan", resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list }, weight: { class: "medium", estMs: null, frames: null },
    requires: {}, priority: "backfill",
  };
}

/**
 * 缺产物的判重层:项目里可见的卡片段里页面判重的(`heavy`,界限搜索的结果;契约 `c10-contract.md` 第 18 节第 8 条:
 * 判轻的卡不发补渲),减去层表里列着的(有产物的)、减去本机渲染不了的(用户卡、图卡)。升序。
 * 不给 `heavy` 按全部判重算(C10a 过渡做法的口径,只剩单测用)。
 */
export function missingLayers({ project, layerClipIds, unsupported, heavy }: {
  project: Pick<Project, "tracks">;
  layerClipIds: ReadonlySet<string>;
  unsupported: (clip: { id: string; cardId?: string }) => boolean;
  heavy?: ReadonlySet<string>;
}): string[] {
  const out: string[] = [];
  for (const tr of project.tracks ?? []) {
    if (tr.hidden) continue;
    for (const clip of tr.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      if (!(Number(clip.end) > Number(clip.start))) continue;
      if (heavy && !heavy.has(clip.id)) continue;
      if (layerClipIds.has(clip.id)) continue;
      if (unsupported(clip)) continue;
      out.push(clip.id);
    }
  }
  return [...new Set(out)].sort();
}

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

export interface BackfillSyncResult {
  /** 这一次发出去的那一批(任务 id 与片段);没发回 null */
  published: { id: string; clips: string[]; projectRev: number } | null;
  /** 还在等的片段(发过、没到) */
  waiting: string[];
  /** 发了但没成(连不上、队列拒了)时的原因 */
  error?: string;
}

/**
 * 补渲的发布方。只发布、不认领。`sync` 由父页定时调(`BACKFILL_CHECK_MS`),传此刻缺产物的层;同时只跑一次。
 */
export class BackfillPublisher {
  private readonly request: Request;
  private readonly now: () => number;
  private readonly publisherId: string;
  /** 片段 → 它所在的那一批(任务 id、项目版本、发出时刻) */
  private readonly sent = new Map<string, { id: string; rev: number; at: number }>();
  private helloOk = false;
  private busy = false;
  /** 诊断:发过的每一批(最多留 20 条) */
  readonly log: { at: number; id: string; clips: string[]; projectRev: number; created: boolean | null; error?: string }[] = [];

  constructor(deps: { request: Request; publisherId: string; now?: () => number }) {
    this.request = deps.request;
    this.publisherId = deps.publisherId;
    this.now = deps.now ?? Date.now;
  }

  /** 连接换了(重连、换项目):重新报到,还缺的按新连接重发(队列只在内存里,重启后要重新发布) */
  reset(): void {
    this.helloOk = false;
    this.sent.clear();
  }

  async sync({ projectId, projectRev, missing }: { projectId: string | null; projectRev: number | null; missing: readonly string[] }): Promise<BackfillSyncResult> {
    const now = this.now();
    const want = new Set(missing);
    // 产物到了(进了层表)的片段忘掉;下次再缺(内容改了)按新的一批发
    for (const clip of [...this.sent.keys()]) if (!want.has(clip)) this.sent.delete(clip);
    const waiting: string[] = [];
    const need: string[] = [];
    for (const clip of [...want].sort()) {
      const s = this.sent.get(clip);
      const fresh = !!s && now - s.at < BACKFILL_RESEND_MS && (s.rev === projectRev || now - s.at < BACKFILL_REV_GRACE_MS);
      (fresh ? waiting : need).push(clip);
    }
    if (!need.length || !projectId || !Number.isSafeInteger(projectRev) || this.busy) return { published: null, waiting };
    const rev = projectRev as number;
    this.busy = true;
    const task = backfillPlanTask({ projectId, projectRev: rev, clips: need });
    try {
      if (!this.helloOk) {
        const hello = await this.request({ type: "publisher.hello", publisherId: this.publisherId });
        if (hello?.type !== "publisher.welcome") throw new Error(`publisher.hello:${String(hello?.reason ?? hello?.type ?? "no-reply")}`);
        this.helloOk = true;
      }
      const reply = await this.request({ type: "task.publish", tasks: [task] });
      if (reply?.type !== "task.published") {
        // not-registered 之类:下次重新报到
        this.helloOk = false;
        throw new Error(`task.publish:${String(reply?.reason ?? reply?.type ?? "no-reply")}`);
      }
      const results = Array.isArray(reply.results) ? (reply.results as { id?: string; error?: string; created?: boolean; state?: string }[]) : [];
      const r = results.find((x) => x?.id === task.id);
      if (!r || r.error) throw new Error(`task.publish:${r?.error ?? "no-result"}`);
      // 已经失败过的同一批(没过队列的留存期):不算在等,下次按当前版本另起
      if (r.state !== "failed") for (const clip of need) this.sent.set(clip, { id: task.id, rev, at: now });
      this.note({ at: now, id: task.id, clips: need, projectRev: rev, created: r.created ?? null });
      return { published: { id: task.id, clips: need, projectRev: rev }, waiting };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      if (/连接断了|没连上|没有回应/.test(error)) this.helloOk = false;
      this.note({ at: now, id: task.id, clips: need, projectRev: rev, created: null, error });
      return { published: null, waiting, error };
    } finally {
      this.busy = false;
    }
  }

  private note(entry: BackfillPublisher["log"][number]) {
    this.log.push(entry);
    if (this.log.length > 20) this.log.splice(0, this.log.length - 20);
  }

  debug() {
    return {
      publisherId: this.publisherId,
      helloOk: this.helloOk,
      waiting: [...this.sent.entries()].map(([clip, s]) => ({ clip, id: s.id, rev: s.rev, at: s.at })),
      log: this.log.slice(),
    };
  }
}
