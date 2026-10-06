/**
 * 编辑页面这一侧合出每张同步卡的运行状态(`docs/plan/online-card-exec-contract.md` 第 8 节的十种)。纯函数。
 *
 * 先后(前面的条件成立就不看后面的):
 *   1. 低内存档 → `low-memory`;
 *   2. 本页不能执行(站点总开关关了、没有隔离环境)→ `not-isolated`;
 *   3. 这张卡的入口转译不成 → 转译给的状态(`unsupported-syntax` / `missing-module` / `load-error`);
 *   4. 舞台报了这张卡的状态 → 用舞台的(`ready`、`load-error`、`gpu`、`media`、`runtime-error`……);
 *      两个舞台都报了且不一样时取不是 `ready` 的那个(一台运行不了就按运行不了处理,两台画面才一致);
 *   5. 转译成了、舞台还没报 → `loading`;
 *   6. 还没轮到转译(源码刚取到)→ `loading`。
 * 结果写进 `registry.setCardRunStates`;参数面板、时间轴徽标、轻重判定读那里。
 */
import type { CardRunState, SyncedUserCard } from "../../kernel/registry.ts";
import type { BundleResult } from "../../online/cardRuntime/protocol.ts";

export interface EditorRunStateInput {
  /** 同步表(静态解析出来的卡;`source` 是入口文件的键) */
  cards: Iterable<SyncedUserCard>;
  lowMemory: boolean;
  /** 本页能不能执行(`gate.ts` 的 `cardExecAvailable()`) */
  available: boolean;
  /** 不能执行时的说明(站点关了那一句);没有就不写 */
  blockedDetail?: string | null;
  /** 转译的结果(每个入口一条) */
  bundles: readonly BundleResult[];
  /** 各舞台报来的状态(卡片 id → 状态);没报过的舞台不在里面 */
  stages?: Iterable<ReadonlyMap<string, CardRunState> | null | undefined>;
}

export function editorRunStates(input: EditorRunStateInput): Map<string, CardRunState> {
  const out = new Map<string, CardRunState>();
  const byEntry = new Map(input.bundles.map((b) => [b.entry, b]));
  const stages = [...(input.stages ?? [])].filter((m): m is ReadonlyMap<string, CardRunState> => !!m);
  for (const card of input.cards) {
    if (!card || typeof card.id !== "string" || out.has(card.id)) continue;
    if (input.lowMemory) { out.set(card.id, { state: "low-memory" }); continue; }
    if (!input.available) { out.set(card.id, { state: "not-isolated", ...(input.blockedDetail ? { detail: input.blockedDetail } : {}) }); continue; }
    const bundle = card.source ? byEntry.get(card.source) : undefined;
    if (bundle && !bundle.ok) { out.set(card.id, bundle.state); continue; }
    if (!bundle) { out.set(card.id, { state: "loading" }); continue; }
    const reported = stages.map((m) => m.get(card.id)).filter((s): s is CardRunState => !!s);
    if (!reported.length) { out.set(card.id, { state: "loading" }); continue; }
    out.set(card.id, reported.find((s) => s.state !== "ready") ?? reported[0]);
  }
  return out;
}

/** 参数面板的说明(契约第 8 节的表);`ready`、`loading` 不出说明 */
export function runStateMessage(s: CardRunState | undefined): string | null {
  if (!s) return null;
  const d = s.detail ? s.detail : "";
  const where = s.file ? `,${s.file.replace(/^src\/cards\/user\//, "")}` : "";
  switch (s.state) {
    case "ready": case "loading": return null;
    case "unsupported-syntax": return `在线浏览器不能运行这张卡:用了在线页面不支持的写法${d ? `(${d}${where})` : ""}。画面由渲染节点提供。`;
    case "missing-module": return `在线浏览器不能运行这张卡:引用了在线页面里没有的模块${d ? ` ${d}` : ""}。画面由渲染节点提供。`;
    case "load-error": return `在线浏览器不能运行这张卡:载入时出错${d ? `(${d})` : ""}。`;
    case "gpu": return "这台设备的图形能力不够,图卡的画面由渲染节点提供。";
    case "media": return "这台设备解不了这段素材,图卡的画面由渲染节点提供。";
    case "runtime-error": return "这张卡在在线浏览器里运行出错,本次改由渲染节点提供画面。";
    case "not-isolated": return d ? `${d},用户卡与图卡的画面由渲染节点提供。` : "这个页面没有隔离的运行环境,用户卡与图卡的画面由渲染节点提供。";
    case "low-memory": return "这台设备在低内存档,不运行用户卡与图卡的代码。";
    default: return null;
  }
}
