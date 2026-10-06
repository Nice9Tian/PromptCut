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
import { allCards, cardsRegistryGen, getCard, syncedUserCardsGen, unknownCardClipIds, userCardSources } from "../kernel/registry";
import { localOnlyClipIds, onlineBrowserMode } from "../render/placeholderHost";
import { cardSourceVersion } from "../render/cardSourceVersion.mjs";
import { builtinCardSourceFiles, cardSourceFilesVersion } from "../render/cardSourceFiles.mjs";
import { clipCostIndex, clipCostNodes } from "../render/pipelinePlan.mjs";

export interface ClipIdentity {
  /** clipId → `cardCostKey(node, sourceVersion, fps, durationFrames)` */
  identityKeys: Record<string, string>;
  /** clipId → 声明的帧模式（`direct` / `stateful`）。没有成本记录时的兜底分派用 */
  frameModes: Record<string, string>;
  /** clipId → 这个节点的能力表（`canvasHeavy` / `compositing` / `frameMode`） */
  capabilities: Map<string, Record<string, unknown>>;
}

const EMPTY: ClipIdentity = { identityKeys: {}, frameModes: {}, capabilities: new Map() };

/*
 * 源码版本表本身也记忆化(C6.6 集成,T4):它只取决于注册表里的卡、定制卡源码、卡片源码表,和项目无关。
 * 以前每次项目变动(挪片段、改参数)都整张重算 —— 每张内置卡都要拿正则扫一遍全部源码文件找入口,
 * 一次 40 ms 上下,加上别的就成了 > 50 ms 的长任务。三样任何一样换了(注册表重装、定制卡源码换了、
 * 源码表热更新)就重算。
 */
let versionsMemo: { reg: number; files: number; user: unknown; out: Record<string, string> } | null = null;

/** 源码版本，照 `ExportView.tsx` 的 `__pcCardPlan` 那份算法（user 卡带 dependencies） */
export function sourceVersionsOf(): Record<string, string> {
  const user = userCardSources();
  const reg = cardsRegistryGen();
  const files = cardSourceFilesVersion();
  if (versionsMemo && versionsMemo.reg === reg && versionsMemo.files === files && versionsMemo.user === user) return versionsMemo.out;
  const out: Record<string, string> = {};
  for (const card of allCards()) {
    const file = user.fileOf[card.id];
    out[card.id] = file && user.files[file] !== undefined
      ? `user:${cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, `/src/cards/user/${file}.tsx`)}`
      : `builtin:${cardSourceVersion(card, builtinCardSourceFiles)}`;
  }
  versionsMemo = { reg, files, user, out };
  return out;
}

let cachedProject: Project | null = null;
let cached: ClipIdentity = EMPTY;
/** 记忆化的另外两个键:在线浏览器模式开没开、同步用户卡表的代数(决定哪些片段本机跑不了) */
let cachedLocalKey = "";

/**
 * 在线浏览器模式下这台设备跑不了的片段(用户卡、图卡;C10 契约第 9 节)不给身份:页面不测它们(`probeRunner` 按身份挑卡)、
 * 分派表查不到成本记录也查不到声明的帧模式,一律按重卡(`clipWeight` 的 `declared-heavy`)—— 旧的 L2 里哪怕留着
 * 以前在后台舞台上测过的记录也不认;舞台拿不到它们的身份,停下也就不追;不把它们的记录转写进文档服务。
 * 桌面(模式关着)照旧。
 */
function dropLocalOnly(project: Project, id: ClipIdentity): ClipIdentity {
  return dropClips(id, localOnlyClipIds(project.tracks.flatMap((tr) => tr.clips)));
}

/**
 * 两边都没有定义的卡片段(未知卡片,`registry.unknownCardClipIds`;桌面与在线一致)也不给身份:舞台不画它们,测量不该挑它们
 * (以前会在后台舞台上测一张空卡、记一条成本记录)。分派表那一侧另由 `planDispatch` 把它们整个去掉(不当重卡、不进预渲染集合)。
 */
function dropUnknown(project: Project, id: ClipIdentity): ClipIdentity {
  return dropClips(id, unknownCardClipIds(project.tracks.flatMap((tr) => tr.clips)));
}

function dropClips(id: ClipIdentity, local: ReadonlySet<string>): ClipIdentity {
  if (!local.size) return id;
  const identityKeys: Record<string, string> = {};
  const frameModes: Record<string, string> = {};
  const capabilities = new Map<string, Record<string, unknown>>();
  for (const [k, v] of Object.entries(id.identityKeys)) if (!local.has(k)) identityKeys[k] = v;
  for (const [k, v] of Object.entries(id.frameModes)) if (!local.has(k)) frameModes[k] = v;
  for (const [k, v] of id.capabilities) if (!local.has(k)) capabilities.set(k, v);
  return { identityKeys, frameModes, capabilities };
}

/**
 * 有声动效卡(画面是组件、另写了 `audio()`)片段自己的图卡节点算它的成本身份节点(`pipelinePlan.mjs` 的 `clipCostNodes`):
 * 它的画面就是一张普通的 DOM 卡,和别的卡一样第一次要用时就测、测完按结果判轻重。2026-10-06 之前它没有身份
 * (图卡那一支合成的节点不带 `clipId`),从不测量,画面在桌面与在线都永远按重卡。
 *
 * 画面由 `card()` 出的图卡、只有 `audio()` 的音频图卡不算,照旧没有身份:测量用的是只留这一个片段的缩水项目
 * (`probeRunner.ts` 的 `shrinkProject`,不带素材与卡片图节点),图卡的输入在那里取不到;音频图卡没有画面。
 */
function ownsVisual(node: { cardId?: unknown }): boolean {
  const def = typeof node.cardId === "string" ? getCard(node.cardId) : undefined;
  return !!def && !!def.Component && typeof def.card !== "function";
}

/**
 * 摊成图。卡片图里有悬空输入时 `projectCardGraph` 会抛(删片段不清 `cardNodes`):以前这一轮整个项目都没有身份,
 * 全部卡不测、按声明兜底(没声明 `direct` 的一律按重)。现在退一步只按片段自己的卡再摊一遍(不带卡片图节点、
 * 不看片段的 `nodeId`):普通卡与有声动效卡的节点内容与完整的图里相同,身份照给、照测;坏掉的图卡链路本来就没有身份。
 * 这一遍也抛才当作没有身份。
 */
function costGraph(project: Project): ReturnType<typeof projectCardGraph> {
  try {
    return projectCardGraph(project, getCard);
  } catch {
    const bare = { ...project, cardNodes: [], tracks: project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.nodeId ? { ...c, nodeId: undefined } : c)) })) };
    return projectCardGraph(bare as Project, getCard);
  }
}

export function clipIdentityOf(project: Project | null): ClipIdentity {
  if (!project) return EMPTY;
  // 注册表与同步表的代数也进键:卡片定义到了(热更新、同步到了),未知卡片变成认得的卡,身份跟着给
  const localKey = `${onlineBrowserMode() ? "on" : "off"}:${syncedUserCardsGen()}:${cardsRegistryGen()}`;
  if (project === cachedProject && localKey === cachedLocalKey) return cached;
  let out = EMPTY;
  try {
    // 一张坏卡不该让探针和分派表整个停摆:图摊不出来时退一步只按片段自己的卡摊(`costGraph`);那也不成才当作「没有身份」
    const graph = costGraph(project);
    const versions = sourceVersionsOf();
    const own = { ownNode: ownsVisual };
    const { identityKeys, frameModes } = clipCostIndex(project, graph, (node) => versions[(node as { cardId?: string }).cardId ?? ""] ?? null, own);
    const capabilities = new Map<string, Record<string, unknown>>();
    for (const [clipId, node] of clipCostNodes(project, graph, own)) capabilities.set(clipId, (node.capabilities ?? {}) as Record<string, unknown>);
    out = { identityKeys, frameModes, capabilities };
    if (onlineBrowserMode()) out = dropLocalOnly(project, out);
    out = dropUnknown(project, out);
  } catch {
    out = EMPTY;
  }
  cachedProject = project;
  cachedLocalKey = localKey;
  cached = out;
  return out;
}

/** 测试用 */
export function resetClipIdentityCache(): void {
  cachedProject = null;
  cachedLocalKey = "";
  cached = EMPTY;
  versionsMemo = null;
}
