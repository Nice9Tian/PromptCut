/**
 * 在线浏览器的新版本提示条（语义 `docs/semantics/product/platforms.md` 与 `docs/semantics/mechanism/platforms.md`「在线浏览器」的「新版本提示」）：
 * - 只在在线构建（`ONLINE`）且当前文档为编辑器页（开始页或项目内，排除 `?stage`、`stage.html`、`?export`、`?audioMix`、`?proto`）时挂载并启动检查；
 * - 检测到远端 `version.json` 的 `codeVersion` 与本页 `CODE_VERSION` 不同时，在底部常驻显示「有新版本，刷新后使用。」与「刷新」按钮；
 * - 点「刷新」时若存在只在本页、关页面就会丢失的未提交离线改动（`unsentAtRisk`），原地切换为二次确认（「仍要刷新」/「先不刷新」），不用原生弹窗。
 *
 * 模块顶层无副作用：舞台与导出页即使载入本模块也不会建节点或发请求。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ONLINE } from "../../online/mode";
import { CODE_VERSION } from "../../online/buildInfo";
import { isStageEntryPath } from "../../online/isolation/stageGuard";
import { startUpdateCheck, type UpdateCheckController } from "../../online/updateCheck";
import { useSync } from "./syncManager";
import { unsentAtRisk } from "./onlineStatus";
import "../../ui/toolbar.css";
import "./updateNotice.css";

/** 新版本提示条的固定文案（探针与测试按此核对） */
export const UPDATE_NOTICE_TEXT = {
  notice: "有新版本，刷新后使用。",
  refresh: "刷新",
  risk: "还有只在这个页面里、没提交的改动，刷新会丢失。",
  force: "仍要刷新",
  cancel: "先不刷新",
} as const;

function UpdateNotice({ ctl }: { ctl: UpdateCheckController }) {
  const state = useSyncExternalStore(ctl.subscribe, ctl.getState, ctl.getState);
  const atRisk = useSync((v) => unsentAtRisk(v.status, v.unconfirmed, v.offlineStore));
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!atRisk && confirming) setConfirming(false);
  }, [atRisk, confirming]);

  if (!state.hasUpdate) return null;

  const step = confirming && atRisk ? "confirm" : "notice";

  if (step === "confirm") {
    return (
      <div className="pc-update-notice pc-update-notice--warn" role="status" data-pc="update-notice" data-step="confirm">
        <span className="pc-update-notice-text">{UPDATE_NOTICE_TEXT.risk}</span>
        <div className="pc-update-notice-actions">
          <button
            type="button"
            className="pc-btn pc-btn--primary pc-update-notice-btn"
            data-pc="update-notice-force"
            onClick={() => location.reload()}
          >
            {UPDATE_NOTICE_TEXT.force}
          </button>
          <button
            type="button"
            className="pc-btn pc-update-notice-btn"
            data-pc="update-notice-cancel"
            onClick={() => setConfirming(false)}
          >
            {UPDATE_NOTICE_TEXT.cancel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-update-notice" role="status" data-pc="update-notice" data-step="notice">
      <span className="pc-update-notice-text">{UPDATE_NOTICE_TEXT.notice}</span>
      <button
        type="button"
        className="pc-btn pc-btn--primary pc-update-notice-btn"
        data-pc="update-notice-refresh"
        onClick={() => {
          if (atRisk) {
            setConfirming(true);
          } else {
            location.reload();
          }
        }}
      >
        {UPDATE_NOTICE_TEXT.refresh}
      </button>
    </div>
  );
}

let mounted = false;

/**
 * 在编辑器页根挂载后调用一次；内部自行判断是否为在线构建的编辑器页，整页只启动一次。
 */
export function mountUpdateNotice(): void {
  if (mounted) return;
  if (!ONLINE) return;
  if (typeof window === "undefined" || typeof document === "undefined" || typeof location === "undefined") return;
  if (isStageEntryPath(location.pathname)) return;
  const q = new URLSearchParams(location.search);
  if (q.has("stage") || q.has("export") || q.has("audioMix") || q.has("proto")) return;
  mounted = true;

  const ctl = startUpdateCheck({
    base: import.meta.env.BASE_URL,
    codeVersion: CODE_VERSION,
    visibility: document,
    fetch: (url, init) => window.fetch(url, init),
  });

  let host = document.getElementById("pc-update-notice-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "pc-update-notice-root";
    document.body.appendChild(host);
  }
  createRoot(host).render(<UpdateNotice ctl={ctl} />);
}
