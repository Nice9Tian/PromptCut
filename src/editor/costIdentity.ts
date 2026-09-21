/**
 * 「片段 → `cardCostKey` / 声明的帧模式 / 审阅表能力」这一段（K1 / K2）。
 *
 * 两个调用方要的是**同一份**：
 *   - `probeRunner.ts` 用 `identityKeys` 判「这张卡测过没有」；
 *   - `planDispatch.ts` 用同一份喂 `planPipelines`（R4a 报告 §8 第 2 条把它从
 *     `planPipelines` 里拆出来，就是因为它要卡片注册表和源码版本，两样都不是项目数据）。
 * 两处各算一遍的话，探针写进去的记录和分派表查的键会在「源码版本怎么算」这种地方走偏。
 *
 * 按 `project` 的**对象引用**记忆化：store 是不可变更新，引用没变就什么都没变，
 * 而 `cardSourceVersion` 要把每张卡的源码过一遍，不缓存的话每次项目变动都白算一次。
 */
import type { Project } from "../kernel/project";
import { projectCardGraph } from "../kernel/cardGraph.mjs";
import { allCards, getCard, userCardSources } from "../kernel/registry";
import { cardSourceVersion } from "../render/cardSourceVersion.mjs";
import { builtinCardSourceFiles } from "../render/cardSourceFiles.mjs";
import { clipCostIndex } from "../render/pipelinePlan.mjs";

export interface ClipIdentity {
  /** clipId → `cardCostKey(node, sourceVersion, fps, durationFrames)` */
  identityKeys: Record<string, string>;
  /** clipId → 声明的帧模式（`direct` / `stateful`）。没有成本记录时的兜底分派用 */
  frameModes: Record<string, string>;
  /** clipId → 这个节点的能力表（`canvasHeavy` / `compositing` / `frameMode`） */
  capabilities: Map<string, Record<string, unknown>>;
}

const EMPTY: ClipIdentity = { identityKeys: {}, frameModes: {}, capabilities: new Map() };

/** 源码版本，照 `ExportView.tsx` 的 `__pcCardPlan` 那份算法（user 卡带 dependencies） */
export function sourceVersionsOf(): Record<string, string> {
  const user = userCardSources();
  const out: Record<string, string> = {};
  for (const card of allCards()) {
    const file = user.fileOf[card.id];
    out[card.id] = file && user.files[file] !== undefined
      ? `user:${cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, `/src/cards/user/${file}.tsx`)}`
      : `builtin:${cardSourceVersion(card, builtinCardSourceFiles)}`;
  }
  return out;
}

let cachedProject: Project | null = null;
let cached: ClipIdentity = EMPTY;

export function clipIdentityOf(project: Project | null): ClipIdentity {
  if (!project) return EMPTY;
  if (project === cachedProject) return cached;
  let out = EMPTY;
  try {
    // projectCardGraph 对悬空输入会 throw（删片段不清 cardNodes）——
    // 一张坏卡不该让探针和分派表整个停摆，那一轮当作「没有身份」，按声明兜底
    const graph = projectCardGraph(project, getCard);
    const versions = sourceVersionsOf();
    const { identityKeys, frameModes } = clipCostIndex(project, graph, (node) => versions[(node as { cardId?: string }).cardId ?? ""] ?? null);
    const capabilities = new Map<string, Record<string, unknown>>();
    for (const node of graph.nodes ?? []) {
      if (typeof node.clipId === "string" && !capabilities.has(node.clipId)) {
        capabilities.set(node.clipId, (node.capabilities ?? {}) as Record<string, unknown>);
      }
    }
    out = { identityKeys, frameModes, capabilities };
  } catch {
    out = EMPTY;
  }
  cachedProject = project;
  cached = out;
  return out;
}

/** 测试用 */
export function resetClipIdentityCache(): void {
  cachedProject = null;
  cached = EMPTY;
}
