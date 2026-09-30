/**
 * 打开项目后的后台补入库(`io/mediaUpload.ts` 的 `startTierBackfill`)要挂的两件事,由 `Preview` 传进去:
 *
 * - `shared`:共享项目里不给素材标「(缺失)」—— 本机取不取得到是这台机器的事,标记会经文档服务同步给别的成员;
 * - `afterIngest`:项目已经「放云端」时,后台补上哈希的素材交给上传队列,补不上的用同步气泡列给用户
 *   (与开启放云端时 `collab.ts` 的 `queueExistingMedia` 同一句话、同一种提示)。
 *
 * 单独成一个文件:`mediaUpload.ts` 不能引同步层(`syncManager` 在 Node 单测里加载不了,io 也不该反过来依赖 sync)。
 */
import type { BackfillHooks } from "../io/mediaUpload";
import { getState } from "../../store/project";
import { queueBackfilledMedia } from "../media/assetTiers";
import { getSyncView, pushToast } from "./syncManager";
import { postEnqueue, uploadMissingMessage } from "./collab";

const shared = () => !!getSyncView().shared;

export const backfillHooks: BackfillHooks = {
  shared,
  afterIngest: (r) => queueBackfilledMedia(r, getState().project.media ?? [], {
    post: postEnqueue,
    shared,
    notify: (names) => {
      console.warn("[collab] 这些素材传不上去:", names);
      pushToast(uploadMissingMessage(names), "warn", Infinity);
    },
  }),
};
