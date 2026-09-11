import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import "./WindowTitleBar.css";

type WindowApi = {
  minimize?: () => Promise<unknown>;
  toggleMaximize?: () => Promise<unknown>;
  close?: () => Promise<unknown>;
};

type TauriGlobal = {
  window?: { getCurrentWindow?: () => WindowApi };
  core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

type MenuId = "file" | "edit" | "view" | "help";

const menus: Array<{ id: MenuId; label: string; items: Array<{ label: string; command?: string; shortcut?: string; separator?: boolean }> }> = [
  {
    id: "file",
    label: "文件",
    items: [
      { label: "新建项目", command: "new-project", shortcut: "Ctrl N" },
      { label: "打开项目…", command: "open-project", shortcut: "Ctrl O" },
      { label: "保存项目", command: "save-project", shortcut: "Ctrl S" },
      { label: "导出视频", command: "export-video", shortcut: "Ctrl E" },
      { label: "打开导出文件夹", command: "open-export", separator: true },
      { label: "打开数据目录", command: "open-data" },
      { label: "返回首页", command: "go-home", separator: true },
      { label: "退出", command: "quit" },
    ],
  },
  {
    id: "edit",
    label: "编辑",
    items: [
      { label: "撤销", command: "undo", shortcut: "Ctrl Z" },
      { label: "重做", command: "redo", shortcut: "Ctrl ⇧ Z" },
    ],
  },
  {
    id: "view",
    label: "视图",
    items: [
      { label: "皮肤…", command: "open-skin" },
      { label: "配音设置…", command: "open-voice" },
      { label: "合并 Skill 结果…", command: "merge-project", separator: true },
      { label: "语音识别引擎（库目录）", command: "open-pylibs" },
      { label: "语音模型目录", command: "open-models" },
      { label: "重置 Python 库", command: "reset-pylibs" },
    ],
  },
  {
    id: "help",
    label: "帮助",
    items: [
      { label: "快捷键", command: "shortcuts" },
      { label: "查看运行日志", command: "open-logs" },
      { label: "关于 PromptCut", command: "about", separator: true },
    ],
  },
];

function tauriWindow(): WindowApi | null {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t?.window?.getCurrentWindow?.() ?? null;
}

function sendCommand(command: string) {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (["open-export", "open-data", "open-pylibs", "open-models", "open-logs", "reset-pylibs", "about", "quit"].includes(command)) {
    const invoke = t?.core?.invoke;
    if (invoke) {
      void invoke("desktop_titlebar_command", { command }).catch(() => {});
      return;
    }
  }
  window.dispatchEvent(new CustomEvent("pc-titlebar-command", { detail: command }));
}

/**
 * 无边框桌面窗口的标题栏。菜单和窗口按钮都在 WebView 里绘制，颜色直接读取皮肤
 * 的 --ui-* 变量，因此切换皮肤时标题栏会和编辑器同步变化。
 */
export function WindowTitleBar(): JSX.Element {
  const [open, setOpen] = useState<MenuId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const canUseWindowApi = Boolean((window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.window?.getCurrentWindow);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const choose = (command?: string) => {
    setOpen(null);
    if (command) sendCommand(command);
  };

  return (
    <header ref={rootRef} className={`pc-titlebar${canUseWindowApi ? " is-desktop" : ""}`} data-tauri-drag-region={canUseWindowApi ? "deep" : undefined}>
      <nav className="pc-titlebar-menus" aria-label="应用菜单">
        {menus.map((menu) => (
          <div className="pc-titlebar-menu-wrap" key={menu.id}>
            <button
              type="button"
              className={`pc-titlebar-menu-button${open === menu.id ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={open === menu.id}
              onClick={() => setOpen((current) => current === menu.id ? null : menu.id)}
              onMouseEnter={() => open && setOpen(menu.id)}
            >
              {menu.label}
            </button>
            {open === menu.id && (
              <div className="pc-titlebar-menu" role="menu">
                {menu.items.map((item) => (
                  <div key={item.label}>
                    {item.separator && <div className="pc-titlebar-menu-separator" role="separator" />}
                    <button type="button" role="menuitem" className="pc-titlebar-menu-item" onClick={() => choose(item.command)}>
                      <span>{item.label}</span>
                      {item.shortcut && <kbd>{item.shortcut}</kbd>}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="pc-titlebar-spacer" data-tauri-drag-region />
      <div className="pc-titlebar-window-controls" aria-label="窗口控制">
        <button type="button" className="pc-window-control" aria-label="最小化" onClick={() => void tauriWindow()?.minimize?.()}>−</button>
        <button type="button" className="pc-window-control" aria-label="最大化" onClick={() => void tauriWindow()?.toggleMaximize?.()}>□</button>
        <button type="button" className="pc-window-control pc-window-control--close" aria-label="关闭" onClick={() => void tauriWindow()?.close?.()}>×</button>
      </div>
    </header>
  );
}
