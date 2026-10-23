import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadStorageProviders,
  loadConnections,
  connectStorage,
  disconnectStorage,
  importFromStorage,
  storageImportSupported,
  type StorageProviderConfig,
  type StorageConnection,
} from "../io/storageImport";
import { getDriveToken, pickDriveFiles, requestDriveAuthCode, forgetDriveToken } from "../io/googlePicker";

/**
 * 素材页的「从网盘导入」(任务书 `docs/plan/drive-connector-task.md` 第 5 节)。
 *
 * 单独一个组件,`LibrarySection` 里只加一行引用 —— 那个文件同期还有别人在改,这样冲突面最小。
 *
 * # 两条凭据路在界面上怎么体现
 *
 * - **不托管(A3)**:点「Google Drive」→ 授权 → Picker 选文件。那张票一小时就过期,关掉页面就没了。
 * - **托管(A2)**:在「已连接的网盘」里点一次「连接」,长期授权就交给编辑器进程保管。之后导入时
 *   **拉取不再依赖页面手里那张票** —— 几个 G 的大文件拉一小时也不会半路断掉。
 *
 * **Picker 本身总是要一张当场的票**(它要在页面里列出文件),所以托管与否都会走一次 `getDriveToken`;
 * 区别只在「拉字节」那一段用谁的票。
 *
 * 字节不经过页面:页面只递文件 id,拉取与入库都在编辑器进程里做。
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
  const [connections, setConnections] = useState<StorageConnection[]>([]);
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const refreshConnections = useCallback(async () => {
    setConnections(await loadConnections());
  }, []);

  useEffect(() => {
    if (!storageImportSupported) return;
    let alive = true;
    void loadStorageProviders().then((list) => { if (alive) setProviders(list); });
    void loadConnections().then((rows) => { if (alive) setConnections(rows); });
    return () => { alive = false; };
  }, []);

  // 点别处关掉菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setManaging(false); }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const connectedOf = (kind: string) => connections.find((c) => c.provider === kind) ?? null;

  const runImport = useCallback(async (cfg: StorageProviderConfig) => {
    setOpen(false);
    setBusy(true);
    try {
      // Picker 要一张当场的票才能列出文件,托管与否都要
      const { token } = await getDriveToken(cfg);
      const picked = await pickDriveFiles(cfg, token);
      if (!picked || picked.length === 0) return;           // 用户取消,什么都不说

      // 已托管就不把票递下去:拉取方用它自己保管的凭据换票,不受这张票过期的影响
      const managed = !!connectedOf(cfg.kind);
      flash(`从 ${cfg.label} 导入 ${picked.length} 个文件…${managed ? "（托管授权）" : ""}`);

      let firstKind: "video" | "audio" | "image" | null = null;
      const failed: string[] = [];
      for (const file of picked) {
        try {
          await importFromStorage(cfg.kind, managed ? null : token, file);
          if (!firstKind) firstKind = guessKind(file.mimeType, file.name);
        } catch (e) {
          failed.push(`${file.name}:${e instanceof Error ? e.message : String(e)}`);
          if (e instanceof Error && /401|授权/.test(e.message)) forgetDriveToken();
        }
      }
      if (failed.length) alert(`这些没导进来:\n${failed.join("\n")}`);
      const ok = picked.length - failed.length;
      if (ok > 0) {
        flash(`已从 ${cfg.label} 导入 ${ok} 个`);
        if (firstKind) onImported?.(firstKind);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/关闭|popup_closed|取消/.test(msg)) alert(`从网盘导入失败:${msg}`);
    } finally {
      setBusy(false);
    }
  }, [connections, flash, onImported]);

  const runConnect = useCallback(async (cfg: StorageProviderConfig) => {
    setBusy(true);
    try {
      const got = await requestDriveAuthCode(cfg);
      if (!got) return;                                     // 用户关了授权窗口
      await connectStorage(cfg.kind, got.code, got.codeVerifier);
      await refreshConnections();
      flash(`${cfg.label} 的授权已交给本机保管`);
    } catch (e) {
      alert(`连接失败:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [flash, refreshConnections]);

  const runDisconnect = useCallback(async (cfg: StorageProviderConfig) => {
    if (!confirm(`断开 ${cfg.label}？\n\n保管的授权会被删掉，并向 ${cfg.label} 撤销。已经导入的素材不受影响。`)) return;
    setBusy(true);
    try {
      const out = await disconnectStorage(cfg.kind);
      await refreshConnections();
      flash(out.revoked
        ? `已断开 ${cfg.label}`
        : `本机保管的授权已删掉，但 ${cfg.label} 那边没撤成（${out.why ?? "原因不明"}），请到账号页再撤一次`);
    } catch (e) {
      alert(`断开失败:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [flash, refreshConnections]);

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
        onClick={() => { setOpen((v) => !v); setManaging(false); }}
      >
        <IconCloud size={16} />
        <span>{busy ? "从网盘导入中…" : "从网盘导入"}</span>
      </button>

      {open && (
        <div className="pc-storage-menu" role="menu">
          {list.length === 0 && <div className="pc-storage-note">读不到网盘配置</div>}

          {!managing && list.map((p) => {
            const conn = connectedOf(p.kind);
            return (
              <button
                key={p.kind}
                type="button"
                role="menuitem"
                className="pc-storage-item"
                disabled={!p.configured}
                title={p.configured ? undefined : p.reason}
                onClick={() => { if (p.kind === "google-drive") void runImport(p); }}
              >
                <span>{p.label}</span>
                {!p.configured
                  ? <span className="pc-storage-tag">{p.kind === "dropbox" ? "待开放" : "未配置"}</span>
                  : conn ? <span className="pc-storage-tag">已托管</span> : null}
              </button>
            );
          })}

          {!managing && anyConfigured && (
            <>
              <div className="pc-storage-sep" />
              <button type="button" role="menuitem" className="pc-storage-item" onClick={() => setManaging(true)}>
                <span>已连接的网盘…</span>
                <span className="pc-storage-tag">{connections.length}</span>
              </button>
            </>
          )}

          {managing && (
            <>
              <div className="pc-storage-note">
                把长期授权交给本机保管之后，关掉页面也能继续传。授权只覆盖你当场选中的文件。
              </div>
              {list.filter((p) => p.configured).map((p) => {
                const conn = connectedOf(p.kind);
                return (
                  <div key={p.kind} className="pc-storage-row">
                    <div className="pc-storage-rowmain">
                      <span>{p.label}</span>
                      <span className="pc-storage-tag">
                        {conn ? `连接于 ${new Date(conn.createdAt).toLocaleDateString()}` : p.canManage ? "未连接" : "不支持托管"}
                      </span>
                    </div>
                    {conn
                      ? <button type="button" className="pc-storage-act" disabled={busy} onClick={() => void runDisconnect(p)}>断开</button>
                      : <button type="button" className="pc-storage-act" disabled={busy || !p.canManage} title={p.canManage ? undefined : p.manageReason} onClick={() => void runConnect(p)}>连接</button>}
                  </div>
                );
              })}
              <div className="pc-storage-sep" />
              <button type="button" className="pc-storage-item" onClick={() => setManaging(false)}><span>返回</span></button>
            </>
          )}

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
