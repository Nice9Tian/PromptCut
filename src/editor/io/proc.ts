import { snapshotsFor, restoreSnapshots, frameRequest } from "../../render/frameClient";
import { actions, getState } from "../../store/project";
import { createEmptyProject, newProjectId } from "../../kernel/project";
import type { Project } from "../../kernel/project";
import { exportProjectJson } from "./index";
import { bundledCardsOf, collectProjectCards, restoreProjectCards, type BundledCard } from "./procCards";
import { restoreMediaUrls } from "./mediaUrls";
import { collectProjectAi, applyProjectAi, resetProjectAi, type ProjectAi } from "../../ai/projectAi";
import { getSkillSnapshot } from "../../skill/skillMode";

/**
 * 存盘时给项目盖一个「这是 SKILL 模式下的产物」的戳。不在 SKILL 模式就不写这一段。
 *
 * 一度打算让 /api/skill/start 那边在建任务时注入,由我这边只读不写 —— 后来那条线的
 * 所有权作废了(有第三方在重构 vite-plugin-skill.ts),所以还是在这里写。
 * 只有一个写入方,不会出现两处各写各的。
 */
function skillStamp(): { active: boolean; jobId?: string | null; at?: string } | undefined {
  const { state } = getSkillSnapshot();
  if (!state.active) return undefined;
  return { active: true, jobId: state.jobId, at: new Date().toISOString() };
}

/**
 * `.proc` —— PromptCut 自己的项目文件。
 *
 * 里面就是一层薄壳加一份编排:壳记住格式和版本,方便以后改结构时认得出老文件。
 * 兼容读入旧的 `.promptcut.json`(那时候是裸的 Project),所以 `parseProc` 两种都吃。
 *
 * 素材本身不进 .proc,只记地址和服务端 path —— 一份编排几十 KB,塞进视频就没法发给别人了。
 * 读回来时 parseProc 按 path 把地址换回 /@media/<文件名>(见 mediaUrls.ts)。
 *
 * 一条不变量:**读回来的 clip.params 必须原样保留,这里绝不补默认值。**
 * clip.params 现在是写入时物化的(store 的 addCardClip / setClipCard 会把 defaults
 * 展开成全量存进 clip),所以文件里存的就是全套真值;这里再合一次 defaults 只会
 * 把用户改过的值悄悄盖回去。Stage 里那层 {...defaults, ...params} 只是给
 * 「卡片后来新增了参数、老 clip 缺这个键」兜底,不是这里的职责。
 * 已验证:内存往返和过磁盘往返,params 都逐字节相同。
 */

export const PROC_EXT = ".proc";
export const PROC_FORMAT = "promptcut-project";
export const PROC_VERSION = 1;

export interface ProcFile {
  format: typeof PROC_FORMAT;
  version: number;
  savedAt: string;
  /** 列表里的封面,留给以后填;现在一律 null */
  thumbnail: string | null;
  project: Project;
  /**
   * 剧本和这段 AI 对话。和 project 平级而不是塞进 project 里 ——
   * project 会被 get_project 原样返回给模型,把对话记录放进去等于每次调用
   * 都让它把自己说过的话再读一遍。旧文件没有这一段,读的时候按空处理。
   */
  ai?: ProjectAi;
  /**
   * 这份编排是不是在 SKILL 模式下产生的,以及属于哪个任务。
   *
   * 只是**留在项目文件里的痕迹**,不是运行时开关 —— 真正决定"现在能不能操作"的是
   * server/skill-gate.mjs 那个状态文件。理由:无头实例、Rust 壳、用户这份是三个进程,
   * 而 .proc 随时可能被另存到别处、被拷走;拿一份会跑的文件当三方共享状态,
   * 迟早出现两边看到的模式不一样。这里记下来是为了事后看得出"这段是谁改的"。
   */
  skill?: { active: boolean; jobId?: string | null; at?: string };
  /**
   * 这个项目用到的定制卡(Agent 用 create_card 写的那种)的源码。
   *
   * 素材不进 .proc,卡片代码却要进:素材是用户自己的文件,还在原处;定制卡活在这台机器的
   * src/cards/user/ 全局目录里,拷走 .proc、换台机器、被别的项目同名卡覆盖,片子里就只剩一个
   * 找不到的 cardId。打开时装回本机,规矩见 procCards.ts。没有定制卡就不写这一段。
   */
  cards?: BundledCard[];
  /** Disposable frame deltas, encoded as one gzip/base64 block. */
  snapshots?: string;
}

/** 当前项目 → .proc 文本 */
export function serializeProc(thumbnail: string | null = null): string {
  const project = JSON.parse(exportProjectJson()) as Project;
  const cards = collectProjectCards(project);
  const doc: ProcFile = {
    format: PROC_FORMAT,
    version: PROC_VERSION,
    savedAt: new Date().toISOString(),
    thumbnail,
    snapshots: snapshotsFor(getState().project),
    project,
    ai: collectProjectAi(),
    skill: skillStamp(),
    cards: cards.length ? cards : undefined,
  };
  return JSON.stringify(doc, null, 2);
}

/** Collect whatever B has completed. Missing/corrupt caches must never prevent saving the project. */
export async function withFrameSnapshots(text: string): Promise<string> {
  try {
    const doc = JSON.parse(text) as ProcFile;
    if (doc.format !== PROC_FORMAT) return text;
    const result = await frameRequest("archive", doc.project, {}, AbortSignal.timeout(2500));
    doc.snapshots = result.snapshots;
    return JSON.stringify(doc, null, 2);
  } catch { return text; }
}

export interface ParseProcOptions {
  /**
   * 老文件没有 project.id 时顶上的身份。从草稿打开时传草稿 id —— 归属表里的老条目
   * 记的就是草稿 id,这样它名下的定制卡照样认得出来。
   */
  legacyId?: string;
}

/** .proc 文本 → Project。旧的裸 Project JSON 也认 */
export function parseProc(text: string, opts: ParseProcOptions = {}): Project {
  const doc = JSON.parse(text);
  const project = doc?.format === PROC_FORMAT ? doc.project : doc;
  if (!project || typeof project !== "object" || !Array.isArray(project.tracks)) {
    throw new Error("这不是一个 PromptCut 项目文件");
  }
  const id = typeof project.id === "string" && project.id ? project.id : opts.legacyId || newProjectId();
  const full: Project = { ...createEmptyProject(), ...project, id };
  // 存下来的素材地址是死的 blob: 或裸文件名,按 path 换回能播的 /@media 地址(见 mediaUrls.ts)
  // A .proc can have been created by the desktop build, where the media file
  // lives in the shared Videos/PromptCut/media folder rather than this source
  // checkout's out/media.  Keep the absolute path behind the server's guarded
  // media endpoint so old projects remain playable after moving installations.
  const { media, missing } = restoreMediaUrls(full.media || [], { externalPathUrl: true });
  for (const m of missing) console.warn(`[proc] 缺失素材: ${m.name} (${m.url})`);
  return { ...full, media };
}

/**
 * .proc 文本 → Project,**并把里面的剧本和对话灌回去**。
 *
 * 打开项目走这个,不要直接用 parseProc:后者只解析文档本身,AI 那一段会被漏掉,
 * 于是新打开的项目里还留着上一个项目的对话。旧的 .proc 没有 ai 段,按空处理 ——
 * 也就是会清掉当前对话,这正是「每个项目一份对话」该有的样子。
 */
export function loadProc(text: string, opts: ParseProcOptions = {}): Project {
  const project = parseProc(text, opts);
  let doc: ProcFile | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.format === PROC_FORMAT) doc = parsed;
  } catch {
    /* parseProc 已经验过一遍,走到这儿说明是裸 Project,没有 ai 段 */
  }
  applyProjectAi(doc?.ai ?? null);
  restoreSnapshots(project, doc?.snapshots);
  // 项目里带的定制卡装回本机。不等它:装完 vite 热更新,卡自己出现在舞台和卡库里
  if (doc) void restoreProjectCards(bundledCardsOf(doc), project.id ?? null);
  return project;
}

/** 当前项目名,拿来当默认文件名 */
export function currentProjectName(): string {
  return getState().project.name || "未命名";
}

/** 新建一个空项目并载入(顶栏「新建项目」和开始页「开始创作」都走这里) */
export function newProject(name = "未命名"): Project {
  // 新项目还没有落点,别让它覆盖上一个项目的文件
  forgetSaveTarget();
  // 新项目从空白开始,剧本和对话都不该跟过来
  resetProjectAi();
  const project = createEmptyProject(name);
  actions.loadProject(project, `${name}${PROC_EXT}`);
  return project;
}

/* ── 存到哪儿 ────────────────────────────────────────────────────
 * 以前是造一个 <a download> 点一下,浏览器不问直接丢进「下载」——用户根本
 * 没机会选目录,也不知道文件去哪了。改成用文件系统访问 API 弹真正的「另存为」。
 *
 * 句柄记住一份:第一次保存问一次路径,之后同一个项目的保存直接覆盖那个文件,
 * 不再每次都弹窗(和正经编辑器一致)。**换项目时必须清掉**,否则会把新项目
 * 覆盖到上一个项目的文件上 —— newProject / openDraft 都会调 forgetSaveTarget。
 */

/** lib.dom 里还没有 showSaveFilePicker,只声明我们用到的这一点 */
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

function pickerFn(): SaveFilePicker | null {
  const fn = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof fn === "function" ? fn : null;
}

/**
 * 通用的「另存为」:让用户挑一个落点,拿不到 API 就返回 null 由调用方兜底。
 *
 * 和 writeProcToDisk 共用同一个能力探测,免得项目里出现两套判断。
 * 一样要在用户手势里**第一个** await 它。用户点取消会抛 AbortError。
 */
export async function pickSaveTarget(
  suggestedName: string,
  description: string,
  accept: Record<string, string[]>,
): Promise<FileSystemFileHandle | null> {
  const picker = pickerFn();
  if (!picker) return null;
  return picker({ suggestedName, types: [{ description, accept }] });
}

let saveTarget: FileSystemFileHandle | null = null;

/** 换项目、换草稿时调用:下次保存重新问路径 */
export function forgetSaveTarget(): void {
  saveTarget = null;
}

export type SaveOutcome =
  | { kind: "saved"; where: string }
  /** 用户在「另存为」对话框里点了取消 */
  | { kind: "cancelled" }
  /** 这个 WebView 没有文件系统访问 API,只能退回浏览器下载 */
  | { kind: "downloaded"; where: string };

/**
 * 把 .proc 写到磁盘。
 *
 * `askAlways` 为真时强制弹对话框(「另存为」用),否则沿用上次选的位置。
 * 注意调用时机:showSaveFilePicker 需要用户手势,所以点击处理函数里要**先**
 * 调它,别先 await 别的东西,不然手势过期会抛 SecurityError。
 */
export async function writeProcToDisk(
  text: string,
  defaultName: string,
  { askAlways = false }: { askAlways?: boolean } = {},
): Promise<SaveOutcome> {
  const picker = pickerFn();
  if (!picker) {
    text = await withFrameSnapshots(text);
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(a.href);
    return { kind: "downloaded", where: defaultName };
  }

  if (askAlways || !saveTarget) {
    try {
      saveTarget = await picker({
        suggestedName: defaultName,
        types: [{ description: "PromptCut 项目", accept: { "application/json": [PROC_EXT] } }],
      });
    } catch (e) {
      // 用户点取消是正常操作,不是错误,不要弹报错框
      if ((e as Error)?.name === "AbortError") return { kind: "cancelled" };
      throw e;
    }
  }

  text = await withFrameSnapshots(text);
  const writable = await saveTarget.createWritable();
  await writable.write(text);
  await writable.close();
  return { kind: "saved", where: saveTarget.name };
}
