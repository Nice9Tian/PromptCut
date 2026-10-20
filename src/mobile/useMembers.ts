/**
 * 成员与 Agent 的数目和名单,给预览右上角的成员按钮和成员面板用。数据和桌面的成员按钮同源:
 * 账号项目取 `accountProjectMembers()`(展开时每 3 秒、收着时每 15 秒,页签在后台不取,同 `AccountMembersPanel`);
 * 凭口令的共享项目取同步状态里的成员行(`MembersPanel` 的同一套过滤)。
 */
import { useCallback, useEffect, useState } from "react";
import type { AccountMembersSnapshot } from "../account/client";
import { MEMBERS_POLL_CLOSED_MS, MEMBERS_POLL_OPEN_MS } from "../account/AccountMembersPanel";
import { accountProjectMembers, useSync } from "../editor/sync/syncManager";
import { cloudAgentConns, cloudAgentLabel, isCloudAgentOnly, isCloudAgentRunning, splitMembers, visibleMembers } from "../editor/sync/hostedServices";
import { useCloudRunning } from "../editor/sync/presence";

export interface MemberLine {
  key: string;
  name: string;
  sub: string;
  me: boolean;
  creator: boolean;
  online: boolean;
  agent: boolean;
}

export interface MembersInfo {
  /** 读不到名单(账号项目的成员服务暂时不可用) */
  unavailable: boolean;
  people: number;
  agents: number;
  lines: MemberLine[];
}

export function useMembers(open: boolean): MembersInfo {
  const shared = useSync((v) => v.shared);
  const rows = useSync((v) => v.members);
  const device = useSync((v) => v.device);
  const running = useCloudRunning();
  const account = !!shared?.accountId;
  const [snap, setSnap] = useState<AccountMembersSnapshot | null>(null);
  const refresh = useCallback(() => {
    if (!account) return;
    accountProjectMembers().then(setSnap, () => setSnap(null));
  }, [account]);
  useEffect(() => { setSnap(null); refresh(); }, [refresh, shared?.projectId, shared?.accountId]);
  useEffect(() => {
    if (!account) return;
    const id = window.setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, open ? MEMBERS_POLL_OPEN_MS : MEMBERS_POLL_CLOSED_MS);
    return () => window.clearInterval(id);
  }, [account, open, refresh]);

  if (!shared) return { unavailable: true, people: 0, agents: 0, lines: [] };
  if (account) {
    if (!snap) return { unavailable: true, people: 0, agents: 0, lines: [] };
    const lines: MemberLine[] = [];
    let agents = 0;
    for (const m of snap.members) {
      const devs = snap.devices.filter((d) => d.accountId === m.accountId);
      const online = devs.some((d) => d.conns.some((c) => c.role === "page"));
      const me = m.accountId === shared.accountId;
      lines.push({ key: m.accountId, name: `${m.accountName ?? m.accountId}${me ? "（自己）" : ""}`, sub: online ? "编辑中" : "离线", me, creator: m.accountId === snap.creatorAccountId, online, agent: false });
      for (const d of devs) for (const c of d.conns) {
        if (c.role !== "agent") continue;
        agents++;
        lines.push({ key: `${d.deviceId}:${c.conversation ?? agents}`, name: c.service === "agent" ? cloudAgentLabel(m.accountName ?? m.accountId) : `${m.accountName ?? m.accountId} · Agent${c.conversation !== undefined ? ` · 对话 ${c.conversation}` : ""}`, sub: c.service === "agent" ? "云端" : "本机", me: false, creator: false, online: true, agent: true });
      }
    }
    return { unavailable: false, people: lines.filter((l) => !l.agent && l.online).length, agents, lines };
  }
  const people = visibleMembers(splitMembers(rows).people, running);
  const lines: MemberLine[] = [];
  let agents = 0;
  for (const r of people) {
    const me = r.username === shared.username && r.deviceId === device?.deviceId;
    const cloudOnly = isCloudAgentOnly(r, running);
    lines.push({ key: `${r.username}@${r.deviceId}`, name: `${r.displayName || r.username}${me ? "（自己）" : ""}`, sub: cloudOnly ? "离线，Agent 在跑" : r.tags.editing ? "编辑中" : "在看", me, creator: r.creator, online: !cloudOnly, agent: false });
    const local = r.conns.filter((c) => c.role === "agent" && c.service !== "agent");
    const cloud = isCloudAgentRunning(r, running) ? cloudAgentConns(r.conns) : [];
    local.forEach((c, i) => { agents++; lines.push({ key: `${r.username}@${r.deviceId}:a${i}`, name: `${r.displayName || r.username} · Agent${c.conversation !== undefined ? ` · 第 ${c.conversation} 个对话` : ""}`, sub: "本机", me: false, creator: false, online: true, agent: true }); });
    cloud.forEach((_c, i) => { agents++; lines.push({ key: `${r.username}@${r.deviceId}:c${i}`, name: cloudAgentLabel(r.displayName || r.username), sub: "云端", me: false, creator: false, online: true, agent: true }); });
  }
  return { unavailable: false, people: Math.max(1, lines.filter((l) => !l.agent && l.online).length), agents, lines };
}
