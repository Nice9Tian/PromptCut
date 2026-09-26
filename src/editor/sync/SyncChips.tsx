/**
 * 顶栏上的同步小部件:
 * - 「同步已暂停」:离线批次的第一条被拒、用户关掉了离线对话框(暂不决定)时一直显示,点它重新打开对话框
 *   (c65-design.md 第 8 节裁定);
 * - 「离线」:连不上文档服务时的提示(修改照常,先攒在本机);
 * - 共享项目:成员按钮(MembersPanel)。
 */
import { setOfflineOpen, useSync } from "./syncManager";
import { MembersButton } from "./MembersPanel";
import "./sync.css";

export function SyncChips() {
  const status = useSync((v) => v.status);
  const active = useSync((v) => v.active);
  const blocked = useSync((v) => v.blocked);
  if (!active || blocked) return null;
  return (
    <>
      {status === "paused" ? (
        <button type="button" className="pc-sync-chip pc-sync-chip--paused" data-pc="sync-paused" title="断网期间项目有新改动，点开决定怎么处理" onClick={() => setOfflineOpen(true)}>
          <span className="pc-sync-chip-dot" />
          同步已暂停
        </button>
      ) : status === "offline" ? (
        <span className="pc-sync-chip pc-sync-chip--offline" data-pc="sync-offline" title="连不上文档服务：修改照常，先攒在本机，恢复后按顺序提交">
          <span className="pc-sync-chip-dot" />
          离线
        </span>
      ) : null}
      <MembersButton />
    </>
  );
}
