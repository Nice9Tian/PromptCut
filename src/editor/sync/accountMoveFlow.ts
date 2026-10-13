/**
 * 账号办法的「搬到云端」接到编辑器上(流程本身在 `accountMove.ts`,这里只给它要用的东西):
 * 桌面版的账号客户端(登录恢复凭证在桌面外壳的保险箱里)、当前打开的项目或协作房间、内容的上传与读回、
 * 关掉本机协作(`collab.ts` 的 `disableCollab`,就是「取消多用户协作」走的那条路)、进云端项目(`enterAccountProject`)、
 * 素材交给上传队列(`collab.ts` 的 `queueExistingMedia`,先小尺寸、再原尺寸)。
 *
 * 只在桌面版里用:在线页面没有本机项目可搬(用户 2026-10-13 定这一版在线浏览器不做)。
 */
import { ONLINE } from "../../online/mode";
import { createAccountClient, projectLink, type Account, type CloudAccountClient } from "../../account/client";
import { desktopAccountBridge } from "../../account/desktopVault";
import { createEmptyProject, type Project } from "../../kernel/project";
import { getState } from "../../store/project";
import { hostedWsUrlOf } from "../../online/invite";
import { originalHashOf, smallHashOf } from "../../render/mediaTier";
import { remoteAssetBase } from "../media/assetTiers";
import { getActiveDraftId, saveDraft, setActiveDraftId } from "../io/drafts";
import { forgetSaveTarget } from "../io/proc";
import { adminOp, dismissToast, ensureDevice, enterAccountProject, getSyncView, pushToast, whenSaved } from "./syncManager";
import { disableCollab, localCollab, pullOriginals, queueExistingMedia } from "./collab";
import { hosted } from "./sharedApi";
import {
  ACCOUNT_MOVE_TEXT, createAttemptStore, isAccountCloudTarget, moveToAccountCloud, readProjectContent, uploadProjectContent,
  type ContentLinkOptions, type MoveAttempt, type MoveResult, type MoveSource, type MoveStage,
} from "./accountMove";

/* ---------------- 桌面版的账号云端 ---------------- */

export interface AccountCloud { origin: string; client: CloudAccountClient }

let cloud: Promise<AccountCloud | null> | null = null;

/**
 * 这台桌面版配置的账号云端与账号客户端(整个页面一份)。没有账号桥(在线页面、没有桌面外壳的开发服务器)回 null ——
 * 那时「搬到云端」照旧办法走,不显示账号这一套。
 */
export function accountCloud(): Promise<AccountCloud | null> {
  if (ONLINE) return Promise.resolve(null);
  if (cloud) return cloud;
  const task = (async (): Promise<AccountCloud | null> => {
    const device = await ensureDevice();
    if (!device) return null;
    let origin: string;
    try { origin = new URL((await desktopAccountBridge("configuration") as { origin: string }).origin).origin; }
    catch { return null; }
    return { origin, client: createAccountClient({ online: false, origin, device: { deviceId: device.deviceId, deviceName: device.deviceName }, native: desktopAccountBridge }) };
  })().catch(() => null);
  cloud = task;
  // 没取到(设备信息还没好、没有账号桥)不记住:下次再问
  void task.then((value) => { if (!value && cloud === task) cloud = null; });
  return task;
}

/** 界面上填的云端地址(或房间登记用的那个)指的是不是账号云端 */
export function targetsAccountCloud(serviceUrl: string | null | undefined, c: AccountCloud | null): boolean {
  return !!c && isAccountCloudTarget(serviceUrl, c.origin, hosted.DEFAULT_HOSTED_URL);
}

/** 当前登录的账号(手里没有就凭保险箱里的恢复凭证取一次);没登录回 null;连不上抛错 */
export async function accountCloudLogin(c: AccountCloud): Promise<Account | null> {
  return c.client.account ?? await c.client.restore();
}

/** 在设置里登录(和开始页的登录是同一个保险箱:这里登了,开始页也是登录的) */
export async function accountCloudSignIn(c: AccountCloud, name: string, password: string): Promise<Account> {
  return c.client.login(name, password, false);
}

/* ---------------- 现在打开的是什么 ---------------- */

/** 能搬的两种:没开协作的本地项目;旧办法在本机开的协作房间(当前连着)。别的(已经是云端项目、协作身份还没恢复)不能搬 */
export function moveSource(): MoveSource | null {
  if (ONLINE) return null;
  const v = getSyncView();
  const contentId = getState().project.id ?? "";
  if (!contentId) return null;
  if (v.shared) return !v.shared.accountId && v.shared.where === "lan" ? { kind: "room", contentId, creator: v.shared.creator } : null;
  if (v.association || v.kind !== "local") return null;
  return { kind: "local", contentId };
}

const attempts = createAttemptStore(typeof localStorage === "undefined" ? null : localStorage);

/** 上一次没做完、云端已经建好项目的那次搬迁(设置里据此提示「接着做」);没有回 null */
export function pendingMove(accountId: string): MoveAttempt | null {
  const contentId = getState().project.id ?? "";
  const a = contentId ? attempts.get(accountId, contentId) : null;
  return a?.projectId ? a : null;
}

/* ---------------- 素材 ---------------- */

async function localHave(hashes: string[]): Promise<Set<string>> {
  const got = new Set<string>();
  for (let i = 0; i < hashes.length; i += 40) {
    const r = await fetch(`/api/media/local?hashes=${hashes.slice(i, i + 40).join(",")}`, { cache: "no-store" });
    const j = (await r.json()) as { hashes?: string[] };
    for (const h of j.hashes ?? []) got.add(h);
  }
  return got;
}

/**
 * 协作房间里、搬的人不在主机那台电脑上时:项目引用的素材字节在主机的素材服务上,这台电脑的内容库里可能只有一部分。
 * 关掉本机协作之后就再也取不到了,所以先拉齐(两档都拉)。本机就是主机(没有远程素材服务)时什么都不用做。
 */
async function pullRoomMedia(project: Project): Promise<{ ok: boolean; missing: number }> {
  if (!remoteAssetBase()) return { ok: true, missing: 0 };
  const hashes = [...new Set((project.media ?? []).flatMap((m) => [originalHashOf(m), smallHashOf(m)]).filter((h): h is string => !!h))];
  if (!hashes.length) return { ok: true, missing: 0 };
  if (await pullOriginals(hashes)) return { ok: true, missing: 0 };
  let have = 0;
  try { have = (await localHave(hashes)).size; } catch { /* 问不到:按都没有算 */ }
  return { ok: false, missing: Math.max(1, hashes.length - have) };
}

/** 素材还在后台上传的提示:队列空了换成「已全部传到云端」;离开这个项目就收掉 */
function watchUploads(projectId: string, count: number) {
  const toast = pushToast(ACCOUNT_MOVE_TEXT.uploading(count), "info", Infinity);
  let idle = 0;
  const timer = setInterval(() => {
    void (async () => {
      if (getSyncView().shared?.projectId !== projectId) { clearInterval(timer); dismissToast(toast); return; }
      let left: number;
      try {
        const r = await fetch("/api/media/upload-queue", { cache: "no-store" });
        const j = (await r.json()) as { queue?: { items?: unknown[] } | null };
        left = j.queue?.items?.length ?? 0;
      } catch { return; }
      idle = left === 0 ? idle + 1 : 0;
      // 连着两次是空的才算传完(小尺寸还在转码的素材是转完才进队的)
      if (idle < 2) return;
      clearInterval(timer);
      dismissToast(toast);
      pushToast(ACCOUNT_MOVE_TEXT.uploaded, "info", 8000);
    })();
  }, 3000);
}

/* ---------------- 搬 ---------------- */

export interface MoveRequest {
  /** 云端项目名 */
  name: string;
  /** 协作房间:创建者密码(本机存着的不用填) */
  creatorPassword?: string;
  onStage?: (stage: MoveStage) => void;
}

export type MoveOutcome = MoveResult & { kind: "local" | "room" };

let moving: Promise<MoveOutcome> | null = null;

/** 把当前打开的本地项目或本机协作房间搬到账号云端。同一时间只做一次;不抛错 */
export function moveCurrentToAccountCloud(c: AccountCloud, request: MoveRequest): Promise<MoveOutcome> {
  if (moving) return moving;
  const task = run(c, request).finally(() => { if (moving === task) moving = null; });
  moving = task;
  return task;
}

async function run(c: AccountCloud, request: MoveRequest): Promise<MoveOutcome> {
  const { client, origin } = c;
  const kind = moveSource()?.kind ?? "local";
  const shared = getSyncView().shared;
  const password = request.creatorPassword || (shared ? localCollab(shared.projectId)?.creatorPassword : "") || "";
  const url = hostedWsUrlOf(`${origin}/hosted/`);
  const linkTo = (projectId: string): ContentLinkOptions => ({
    url,
    // 每建一个会话取一张票据;背后的访问令牌至少还剩一分钟(传到一半到期的,连接按断线重建、凭新票据接着传)
    ticket: async () => (await client.session(projectId, { minRemainingMs: 60_000 })).connectionTicket,
  });
  const result = await moveToAccountCloud({
    source: moveSource,
    account: () => accountCloudLogin(c),
    create: (name, stub, requestId) => client.create(name, stub, requestId),
    snapshot: async () => { await whenSaved(10_000); return structuredClone(getState().project); },
    current: () => getState().project,
    upload: (projectId, snapshot) => uploadProjectContent(linkTo(projectId), projectId, snapshot),
    read: async (projectId) => (await readProjectContent(linkTo(projectId), projectId, getState().project)).project,
    checkCreator: async (pw) => {
      const r = await adminOp("list-bans", { password: pw });
      return r.ok ? { ok: true } : { ok: false, error: r.error === "rate-limited" ? "rate-limited" : r.error === "offline" ? "network" : "bad-password" };
    },
    pullMedia: pullRoomMedia,
    closeRoom: (pw) => disableCollab(pw),
    saveLocal: async () => { const id = getActiveDraftId(); if (id) await saveDraft(id); },
    enter: async ({ projectId, name, snapshot, kind: from }) => {
      await enterAccountProject({ client, origin, projectId, name, initial: snapshot,
        enteredText: from === "room" ? ACCOUNT_MOVE_TEXT.toastRoom : ACCOUNT_MOVE_TEXT.toastLocal });
      // 之后的「保存」不再写回本机那份草稿或文件(它留作普通的本地项目);与从开始页进云端项目一致
      setActiveDraftId(null);
      forgetSaveTarget();
    },
    queueMedia: async () => {
      const r = await queueExistingMedia();
      const projectId = getSyncView().shared?.projectId;
      if (r && r.queued > 0 && projectId) watchUploads(projectId, r.queued);
      return r;
    },
    attempts,
    newRequestId: () => `move-${crypto.randomUUID()}`,
    // 占位内容:一份完整的空白项目(只有 `{ tracks: [] }` 的话编辑器打不开);项目号沿用本机那一份的
    stub: (name, contentId) => ({ ...createEmptyProject(name), id: contentId }),
    linkOf: (projectId) => projectLink(origin, projectId),
    onStage: request.onStage,
  }, { name: request.name, creatorPassword: password });
  return { ...result, kind };
}
