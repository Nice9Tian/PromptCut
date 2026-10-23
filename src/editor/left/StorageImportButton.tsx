import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadStorageProviders,
  importFromStorage,
  storageImportSupported,
  type StorageProviderConfig,
} from "../io/storageImport";
import { getDriveToken, pickDriveFiles, forgetDriveToken } from "../io/googlePicker";

/**
 * 素材页的「从网盘导入」(任务书 `docs/plan/drive-connector-task.md` 第 5 节)。
 *
 * 单独一个组件,`LibrarySection` 里只加一行引用 —— 那个文件同期还有别人在改,这样冲突面最小。
 *
 * 流程:点开 → 选网盘 → Google 授权(弹窗)→ Picker 选文件 → 交给编辑器进程去拉。
 * **字节不经过页面**:页面只递一个文件 id 和一张一小时的票,拉取与入库都在编辑器进程里做。
 *
 * 在线浏览器构建里不显示:那边没有本机的编辑器进程,拉不了(`storageImportSupported`)。
 */
export function StorageImportButton({
  disabled = false,
  disabledTitle,
  onImported,
  flash,
}: {
  disabled?: boolean;
  disabledTitle?: string;
  /** 导入完成后把用户带到素材落地的那一组 */
  onImported?: (firstKind: "video" | "audio" | "image") => void;
  flash: (msg: string) => void;
}) {
  const [providers, setProviders] = useState<StorageProviderConfig[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!storageImportSupported) return;
    let alive = true;
    void loadStorageProviders().then((list) => { if (alive) setProviders(list); });
    return () => { alive = false; };
  }, []);

  // 点别处关掉菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const runGoogleDrive = useCallback(async (cfg: StorageProviderConfig) => {
    setOpen(false);
    setBusy(true);
    try {
      const { token } = await getDriveToken(cfg);
      const picked = await pickDriveFiles(cfg, token);
      if (!picked || picked.length === 0) return;           // 用户取消,什么都不说

      flash(`从 Google Drive 导入 ${picked.length} 个文件…`);
      let firstKind: "video" | "audio" | "image" | null = null;
      const failed: string[] = [];
      for (const file of picked) {
        try {
          await importFromStorage(cfg.kind, token, file);
          if (!firstKind) firstKind = guessKind(file.mimeType, file.name);
        } catch (e) {
          failed.push(`${file.name}:${e instanceof Error ? e.message : String(e)}`);
          // 授权过期就把手里那张票丢掉,下次重新要
          if (e instanceof Error && /401|授权/.test(e.message)) forgetDriveToken();
        }
      }
      if (failed.length) {
        alert(`这些没导进来:\n${failed.join("\n")}`);
      }
      const ok = picked.length - failed.length;
      if (ok > 0) {
        flash(`已从 Google Drive 导入 ${ok} 个`);
        if (firstKind) onImported?.(firstKind);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 用户自己关掉授权窗口不算错,不打扰
      if (!/关闭|popup_closed|取消/.test(msg)) alert(`从网盘导入失败:${msg}`);
    } finally {
      setBusy(false);
    }
  }, [flash, onImported]);

  if (!storageImportSupported) return null;

  const list = providers ?? [];
  const anyConfigured = list.some((p) => p.configured);
  const off = disabled || busy;

  return (
    <div className="pc-storage-import" ref={boxRef}>
      <button
        type="button"
        className="pc-btn-ghost is-block pc-left-primary"
        data-pc-add="storage"
        title={disabled ? disabledTitle : "从你的网盘导入素材(授权后只读你当场选中的文件)"}
        disabled={off}
        onClick={() => setOpen((v) => !v)}
      >
        <IconCloud size={16} />
        <span>{busy ? "从网盘导入中…" : "从网盘导入"}</span>
      </button>

      {open && (
        <div className="pc-storage-menu" role="menu">
          {list.length === 0 && <div className="pc-storage-note">读不到网盘配置</div>}
          {list.map((p) => (
            <button
              key={p.kind}
              type="button"
              role="menuitem"
              className="pc-storage-item"
              disabled={!p.configured}
              title={p.configured ? undefined : p.reason}
              onClick={() => { if (p.kind === "google-drive") void runGoogleDrive(p); }}
            >
              <span>{p.label}</span>
              {!p.configured && <span className="pc-storage-tag">{p.kind === "dropbox" ? "待开放" : "未配置"}</span>}
            </button>
          ))}
          {!anyConfigured && (
            <div className="pc-storage-note">
              在编辑器进程的环境变量里配好 <code>PROMPTCUT_GOOGLE_CLIENT_ID</code> 等三项后可用
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Picker 给的类型未必有,退回看扩展名。和 io/storageImport 里那份同一套判法 */
function guessKind(mimeType: string | undefined, name: string): "video" | "audio" | "image" {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  if (mt.startsWith("image/")) return "image";
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext)) return "audio";
  return "image";
}

function IconCloud({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 10.5 3.75 3.75 0 0 0 6.75 19Z" />
      <path d="M12 16v-5" />
      <path d="m9.5 13 2.5-2.5 2.5 2.5" />
    </svg>
  );
}
