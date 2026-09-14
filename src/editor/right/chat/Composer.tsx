import type { KeyboardEvent, RefObject } from "react";
import { ModelBar } from "../ModelBar";
import { IconPlus } from "../../../ui/icons";
import type { AiProvider, ChatAttachment, ProviderInfo, PublicAiConfig } from "../../../ai/types";
import type { Role } from "../../../ai/roles";
import { attachIcon } from "./attachIcon";
import { usePopover } from "./usePopover";
import "./chat.css";

/** 「✦」菜单里的几样:不常点、但一点就改变这一轮怎么跑的东西,原来挤在顶栏上 */
export interface ComposerMenuProps {
  teamMode: boolean;
  /** 「分工模式」那一项的悬停说明;没配 API 直连时是降级说明(见 AiPanel 里 teamModeHint 的注释) */
  teamModeHint: string;
  onSetTeamMode: (on: boolean) => void;
  /** 「一键配特效」依次跑的角色,只用来写悬停说明 */
  workflowRoles: Role[];
  onRunWorkflow: () => void;
  /** 有对话才出得了诊断报告 */
  canDiagnose: boolean;
  onOpenDiagnostics: () => void;
  onNewChat: () => void;
}

export interface ComposerProps {
  /** 草稿文字。状态在 AiPanel:预览右键引用卡片、空状态的示例句都要往里写 */
  text: string;
  onTextChange: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachments: ChatAttachment[];
  uploading: boolean;
  /** 点「+」:AiPanel 去点它自己那个隐藏的 file input */
  onPickFiles: () => void;
  onRetryAttachment: (id: string, srcPath: string | null) => void;
  onRemoveAttachment: (idx: number) => void;
  /**
   * Enter、「发送」「加入队列」按钮都走这里,交上去的是此刻输入框里的原文(没 trim)。
   * 直接发还是进队列由 AiPanel 看这一页忙不忙决定
   */
  onSubmit: (text: string) => void;
  /** 运行中「■ 停止」 */
  onStop: () => void;
  streaming: boolean;
  /** 快捷键被别处接管(对话框开着之类)时 Enter 只是换行 */
  hotkeysOff?: boolean;
  /** 这一页不在前台时 Enter 也只是换行 */
  active?: boolean;
  provider: AiProvider | null;
  providers: ProviderInfo[];
  onSetProvider: (p: AiProvider) => void;
  config: PublicAiConfig | null;
  menu: ComposerMenuProps;
}

function providerLabel(p: ProviderInfo): string {
  return p.label || (p.id === "claude" ? "Claude Code" : p.id === "agy" ? "Antigravity" : p.id === "codex" ? "Codex" : p.id);
}

/** 工具条上的「✦」菜单 */
function ComposerMenu(props: ComposerMenuProps & { streaming: boolean }) {
  const { teamMode, teamModeHint, onSetTeamMode, workflowRoles, onRunWorkflow, canDiagnose, onOpenDiagnostics, onNewChat, streaming } = props;
  const pop = usePopover();
  /** 点了一项就收起菜单。「分工模式」是开关,不走这里 —— 留着让用户看见勾上了 */
  const pick = (fn: () => void) => () => {
    pop.setOpen(false);
    fn();
  };
  return (
    <div className="ai-pop-anchor" ref={pop.anchorRef}>
      <button
        type="button"
        className="pc-icon-btn ai-bar-btn ai-spark-btn"
        data-pc="ai-menu"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-label="更多操作"
        title={teamMode ? "更多操作(分工模式开着)" : "更多操作:分工模式、一键配特效、诊断报告、新对话"}
        onClick={pop.toggle}
      >
        <span aria-hidden="true">✦</span>
        {/* 分工模式收进菜单之后就看不见了,开着的时候在按钮上挂个点 */}
        {teamMode && <i className="ai-bar-dot" aria-hidden="true" />}
      </button>
      <div className="ai-pop ai-menu" role="menu" aria-label="更多操作" data-pop style={{ display: pop.open ? undefined : "none" }}>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={teamMode}
          className="ai-menu-item"
          data-pc="ai-team-mode"
          title={teamModeHint}
          onClick={() => onSetTeamMode(!teamMode)}
        >
          <span className="ai-menu-icon" aria-hidden="true">{teamMode ? "✓" : ""}</span>
          分工模式
        </button>
        <button
          type="button"
          role="menuitem"
          className="ai-menu-item"
          data-pc="ai-auto-workflow"
          title={`依次跑：${workflowRoles.map((r) => r.name).join(" → ")}`}
          disabled={streaming}
          onClick={pick(onRunWorkflow)}
        >
          <span className="ai-menu-icon" aria-hidden="true" />
          一键配特效
        </button>
        <button
          type="button"
          role="menuitem"
          className="ai-menu-item"
          data-pc="ai-diagnostics"
          title="把这段对话和每一步执行事件收成 JSON(不含密钥),在子窗口里复制 / 存文件 / 提交"
          disabled={!canDiagnose}
          onClick={pick(onOpenDiagnostics)}
        >
          <span className="ai-menu-icon" aria-hidden="true">⎘</span>
          诊断报告
        </button>
        <div className="ai-menu-sep" role="separator" />
        <button type="button" role="menuitem" className="ai-menu-item" data-pc="ai-new-chat" onClick={pick(onNewChat)}>
          <span className="ai-menu-icon" aria-hidden="true">＋</span>
          新对话
        </button>
      </div>
    </div>
  );
}

/**
 * 输入区,占面板高度的 1/3:附件卡片在最上,输入框填满中间(不自动增高,超出在里面滚),
 * 底部一条 36px 工具条 —— 左边 附件「+」、「✦」菜单、驱动方式 + 模型、「⋯」运行选项,右边发送 / 停止。
 *
 * 这里不直接碰 useAiChat:发送、停止都交给 onSubmit / onStop,草稿也是受控的,
 * 发什么、什么时候清空由 AiPanel 决定。
 */
export function Composer(props: ComposerProps) {
  const {
    text,
    onTextChange,
    textareaRef,
    attachments,
    uploading,
    onPickFiles,
    onRetryAttachment,
    onRemoveAttachment,
    onSubmit,
    onStop,
    streaming,
    hotkeysOff,
    active = true,
    provider,
    providers,
    onSetProvider,
    config,
    menu,
  } = props;

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (hotkeysOff || !active) return;
    // 输入法还在拼字时按的 Enter 是「上屏」,不是发送
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit(text);
    }
  };

  return (
    <div className="ai-composer" data-pc="ai-composer">
      {attachments.length > 0 && (
        <div className="ai-attachments">
          {attachments.map((a, idx) => (
            <div
              key={a.id || idx}
              className={`ai-attachment-chip${a.status === "importing" ? " is-importing" : ""}${a.status === "error" ? " is-error" : ""}`}
              title={a.status === "error" ? (a.error || "导入失败") : a.name}
              onClick={() => {
                if (a.status !== "error") return;
                // 失败的卡片点一下重试:先变回导入中,再重新走一遍导入
                if (a.id) onRetryAttachment(a.id, a.srcPath ?? null);
              }}
            >
              {a.status === "importing" ? <span className="ai-spinner" aria-hidden /> : <span aria-hidden="true">{attachIcon(a.kind)}</span>}
              <span className="ai-attachment-name">{a.name}</span>
              {a.status === "importing" ? " · 导入中…" : a.status === "error" ? " · 导入失败,点击重试" : ""}
              <button
                type="button"
                className="ai-attachment-remove"
                aria-label={`移除 ${a.name}`}
                onClick={(e) => { e.stopPropagation(); onRemoveAttachment(idx); }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="ai-composer-input"
        data-pc="ai-input"
        aria-label="给 AI 发消息"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={uploading ? "正在导入..." : streaming ? "Agent 正在运行,Enter 加入队列,Shift+Enter 换行" : "输入消息,Enter 发送,Shift+Enter 换行"}
        disabled={uploading}
      />

      <div className="ai-composer-bar">
        <div className="ai-composer-tools">
          <button
            type="button"
            className="pc-icon-btn ai-bar-btn"
            data-pc="ai-attach"
            title="添加附件"
            aria-label="添加附件"
            onClick={onPickFiles}
            disabled={uploading}
          >
            <IconPlus size={16} />
          </button>
          <ComposerMenu {...menu} streaming={streaming} />
          {/* 当前用哪个驱动是这一页的身份,再窄也留在工具条上 */}
          <select
            className="ai-bar-select ai-provider-select"
            data-pc="ai-provider"
            aria-label="AI 驱动方式"
            title="驱动方式"
            value={provider || ""}
            onChange={(e) => onSetProvider(e.target.value as AiProvider)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available} title={p.available ? "" : "未安装"}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
          <ModelBar provider={provider} config={config} disabled={streaming} />
        </div>
        {streaming ? (
          <>
            {/* 运行中还能接着写:有内容就给「加入队列」(Enter 也是),这一轮落定后按顺序自动发 */}
            {(text.trim().length > 0 || attachments.length > 0) && (
              <button type="button" className="pc-btn-primary ai-send-btn" data-pc="ai-enqueue" title="Agent 这一轮完成后自动发送(Enter)" onClick={() => onSubmit(text)}>
                加入队列
              </button>
            )}
            <button type="button" className="pc-btn-primary ai-send-btn is-stop" data-pc="ai-stop" title="停止这一轮,已完成的修改保留;排队中的消息暂停发送" onClick={onStop}>
              ■ 停止
            </button>
          </>
        ) : (
          <button type="button" className="pc-btn-primary ai-send-btn" data-pc="ai-send" title="发送(Enter)" onClick={() => onSubmit(text)}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
