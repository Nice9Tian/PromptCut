/**
 * 顶栏「保存项目」「打包保存」的流程(从 `TopBar.tsx` 搬出来,好在 node 里测;界面只管按钮和提示)。
 *
 * 两条规矩照旧:
 *   - 「另存为」要用户手势,挑落点必须是点击后的第一个 await;
 *   - 用户在「另存为」里点取消就整个不算保存:草稿不写、脏标记不清。
 *
 * 依赖都从参数进来(`SaveDeps`),缺省接真东西的那一份在 TopBar 里拼。
 */
import type { SaveOutcome } from "./proc";

export interface PackResultLike {
  blob: Blob;
  missing: readonly unknown[];
}

export interface SaveDeps {
  /** 写 `.proc`:挑落点(或沿用上次的),再调 `produce` 取内容,写盘。即 `proc.ts` 的 `writeProcToDisk` */
  writeProc(produce: () => Promise<string>, fileName: string): Promise<SaveOutcome>;
  /** 等文档服务确认完所有本地修改,超时抛错(即 syncManager 的 `whenSaved`) */
  settle(timeoutMs: number): Promise<void>;
  /** 当前项目 → `.proc` 文本 */
  serialize(): string;
  /** 本地草稿跟着更新 */
  saveDraft(): Promise<void>;
  /** 清脏标记、记下文件名 */
  markSaved(fileName: string): void;
  /** 给用户的一句话(成功的附带说明、失败的原因) */
  notify(message: string): void;
}

export interface PackDeps extends Omit<SaveDeps, "writeProc" | "serialize" | "saveDraft" | "markSaved"> {
  /** 挑 `.procp` 的落点;没有文件系统访问 API 时回 null(退回浏览器下载)。用户取消抛 AbortError */
  pick(fileName: string): Promise<FileSystemFileHandle | null>;
  /** 装包 */
  pack(): Promise<PackResultLike>;
  /** 没有落点时退回浏览器下载 */
  download(blob: Blob, fileName: string): void;
  /** 包里缺了哪些素材的那句话 */
  missingMessage(missing: readonly unknown[]): string;
}

/** 等文档服务确认的上限(毫秒) */
export const SETTLE_TIMEOUT_MS = 10_000;

export const SETTLE_TIMEOUT_TEXT = "还有修改没等到文档服务确认（可能离线、连接慢，或同步已暂停），这次没有保存。等连上、处理完再保存。";

/** 等文档服务确认所有本地修改;超时(离线、连接慢、同步已暂停)就不写,告诉用户为什么 */
async function settledOrExplain(deps: Pick<SaveDeps, "settle">): Promise<void> {
  try {
    await deps.settle(SETTLE_TIMEOUT_MS);
  } catch {
    throw new Error(SETTLE_TIMEOUT_TEXT);
  }
}

export type SaveResult = "saved" | "downloaded" | "cancelled" | "failed";

/** 保存 `.proc` */
export async function saveProcFile(fileName: string, deps: SaveDeps): Promise<SaveResult> {
  try {
    // 挑好落点之后、写之前:等文档服务确认完所有本地修改(语义「页面只在拿到确认之后才写」),再序列化
    const outcome = await deps.writeProc(async () => {
      await settledOrExplain(deps);
      return deps.serialize();
    }, fileName);
    if (outcome.kind === "cancelled") return "cancelled";
    await deps.saveDraft();
    // 存完就不脏了,否则「首页」「新建项目」每次都要多问一句
    deps.markSaved(fileName);
    if (outcome.kind === "downloaded") {
      // 这个 WebView 没有文件选择 API,至少告诉用户文件去哪了
      deps.notify(`当前环境不支持选择目录，已保存到浏览器的下载位置：${outcome.where}`);
      return "downloaded";
    }
    return "saved";
  } catch (e) {
    deps.notify(String((e as Error).message));
    return "failed";
  }
}

/**
 * 打包保存:.procp = 编排 + 项目用到的素材(A1)。
 *
 * 和保存项目同一条规矩 —— 挑落点必须是第一个 await,装包(从本地内容库按哈希取素材)只能排在挑好落点之后。
 */
export async function savePackedFile(fileName: string, deps: PackDeps): Promise<SaveResult> {
  let target: FileSystemFileHandle | null = null;
  try {
    target = await deps.pick(fileName);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return "cancelled"; // 用户取消,不是错误
    deps.notify(String((e as Error).message));
    return "failed";
  }
  try {
    await settledOrExplain(deps);
    // 没有哈希的老素材先补入库;补完仍进不了包的(文件真的不在了)在最后列给用户,不许悄悄漏掉
    const { blob, missing } = await deps.pack();
    let result: SaveResult = "saved";
    if (target) {
      const writable = await target.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      deps.download(blob, fileName);
      deps.notify(`当前环境不支持选择目录，已保存到浏览器的下载位置：${fileName}`);
      result = "downloaded";
    }
    if (missing.length) deps.notify(deps.missingMessage(missing));
    return result;
  } catch (e) {
    deps.notify(String((e as Error).message));
    return "failed";
  }
}
