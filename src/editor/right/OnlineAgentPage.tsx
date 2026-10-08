import { useEffect, useState, type ReactNode } from "react";
import { onLowMemoryChange, lowMemoryMode } from "../../online/lowMemory";
import { useCloudAgent } from "../../ai/cloud/useCloud";
import { CloudAiPanel } from "./CloudAiPanel";

/**
 * 在线浏览器模式的 Agent 页(契约 `docs/plan/cloud-agent-contract.md` 9.5)。
 *
 * - 普通档(宽屏):挂「云端」接入方式的 AI 栏,对话与工具由云节点上的 Agent 服务执行,页面只打同源的 `/agent/v1/*`;
 * - 低内存档(手机、iPad 浏览器,含 Chrome 的手机仿真):仍是原来的占位(`placeholder`),一个请求都不发。
 *   判定用现成的 `lowMemoryMode`,不另造宽度阈值;运行中被改判成低内存档也会换回占位。
 */
export function OnlineAgentPage(props: { tabId: string; active: boolean; placeholder: ReactNode }) {
  const [low, setLow] = useState(() => lowMemoryMode(true));
  useEffect(() => onLowMemoryChange(setLow), []);
  if (low) return <>{props.placeholder}</>;
  return <OnlineCloudPanel tabId={props.tabId} active={props.active} />;
}

function OnlineCloudPanel(props: { tabId: string; active: boolean }) {
  const cloud = useCloudAgent();
  return <CloudAiPanel tabId={props.tabId} active={props.active} cloud={cloud} />;
}
