/**
 * 断网待发的浏览器探针用(`scripts/probes/cloud-offline-queue-probe.mjs`)。只在探针自己起的页面里加载,不进任何构建入口。
 *
 * 挂的是真的 `CloudAiPanel`(账号模式;`?ui=mobile` 时是手机版的 `AgentChat`):告知、身份、选区三样换成本页的假来源(告知走 `/probe-account/consent`,断网时同样取不到),
 * Agent 服务由探针的 HTTP 服务模拟。断网用浏览器的离线模式(应用层,不碰宿主机网络)。
 */
import { createRoot } from "react-dom/client";
import "../../index.css";
import "../../skins/skins.css";
import { setCloudConsentSource } from "./consent";
import { setCloudIdentity } from "./identity";
import { setSelectionLink } from "../../editor/sync/selectionPresence";
import { CloudAiPanel } from "../../editor/right/CloudAiPanel";
import { AgentChat } from "../../mobile/AgentChat";
import type { CloudAccountClient } from "../../account/client";

const params = new URLSearchParams(location.search);
const ACCOUNT = params.get("account") ?? "acc-a";
const PROJECT = params.get("project") ?? `sp_${"a".repeat(26)}`;
const TAB = "offline-probe";

const fakeClient = {
  account: { id: ACCOUNT, name: "探针 A" },
  subscribeAuth: () => () => {},
  async cloudAgentConsent() {
    const res = await fetch("/probe-account/consent", { cache: "no-store" });
    if (!res.ok) throw Object.assign(new Error("account-unavailable"), { status: res.status });
    return res.json();
  },
} as unknown as CloudAccountClient;
setCloudConsentSource({ client: fakeClient, accountId: ACCOUNT });
setCloudIdentity({ getTicket: () => "probe-ticket", getGrant: () => undefined });
setSelectionLink({ request: async (m: Record<string, unknown>) => ({ type: "selection.ok", selectionRevision: m.revision, projectId: m.projectId, pageId: m.pageId }) },
  PROJECT, { readSelection: () => [], subscribe: () => () => {} });

document.body.style.margin = "0";
const host = document.getElementById("root")!;
const cloud = { available: true, enabled: true, url: `${location.origin}/agent/v1`, projectId: PROJECT,
  identityVersion: 0, accountMode: true, accountId: ACCOUNT };
// `?ui=mobile`:手机版的 Agent 分页(真的 AgentChat),外框照 MobileEditor 的摆法;缺省是桌面右栏的 CloudAiPanel
if (params.get("ui") === "mobile") {
  void import("../../mobile/mobile.css");
  createRoot(host).render(
    <div className="pcm" data-pc="mobile-ui">
      <div className="editor" data-pcm="editor" data-page="agent">
        <div className="pane-agent"><div className="agent-page">
          <AgentChat tabId={TAB} shown cloud={cloud} counts={{ current: new Map() }} />
        </div></div>
      </div>
    </div>,
  );
} else {
  host.style.cssText = "width:420px;height:760px;display:flex;flex-direction:column;border-right:1px solid var(--ui-border,#333)";
  createRoot(host).render(<CloudAiPanel tabId={TAB} cloud={cloud} />);
}
