import { useEffect, useState } from "react";
import { useLayoutMode } from "../layoutMode";
import { DockHost } from "../dock/DockHost";
import { DockPages } from "../dock/DockPages";
import { RailBar } from "../dock/RailBar";
import { useSideVisible } from "../dock/railStore";
import { connectMcpExecutor } from "../../ai/mcpExecutor";
import { VoiceSettingsDialog } from "../../voice/VoiceSettingsDialog";

import { CollectLoginDialog } from "./CollectLoginDialog";
import { AgentBrowserFrame } from "./AgentBrowserFrame";

import { editorApi } from "../../mcp/api";

export function RightPanel() {
  const [mcpConnected, setMcpConnected] = useState(false);

  useEffect(() => {
    const cleanup = connectMcpExecutor(() => editorApi, (s) => setMcpConnected(s.connected));
    return cleanup;
  }, []);

  // 右栏整列:左边一张宿主卡片(显示右侧 rail 选中项的页面),右边贴窗口边缘的竖向 rail(侧边自由布局,editor/dock/)。
  // 对话式布局下右侧一个 AI 类项都没有时整列不显示 —— 只是 display:none,RightPanel 和里面的一切照旧挂着
  const mode = useLayoutMode();
  const showRight = useSideVisible("right", mode);

  return (
    <>
      <div className="pc-right" data-pc="right" style={{ display: showRight ? undefined : "none" }}>
        <DockHost side="right" />
        <RailBar side="right" />
      </div>
      {/*
        所有页面(五个分区、剧本页、各 AiPanel)在这里各渲染一次,portal 进各自的固定节点,两侧宿主只挪 DOM 节点。
        RightPanel 在 Editor 网格里永远占同一个兄弟槽位、从不卸载,所以拖动 / 切换 / 收起 / 换布局模式都不会让 AiPanel 卸载重建。
        排在宿主后面:宿主的布局效应先跑、先登记,页面内容的布局效应跑的时候节点已经挂进文档
      */}
      <DockPages mcpConnected={mcpConnected} />
      {/* 站点登录框:开始页的卡和 collect_login 工具都会打开它,挂在这里才能在编辑台里出现 */}
      <CollectLoginDialog />
      {/* 配音设置子窗口:顶栏的「配音设置」按钮开它 */}
      <VoiceSettingsDialog />
      {/* 桌面壳模式下 agent 交出浏览器时的浮层(Chrome 方案下永远不会打开) */}
      <AgentBrowserFrame />
    </>
  );
}
