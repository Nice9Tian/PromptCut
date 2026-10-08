/** Isolated browser probe only. This deliberately supplies availability but no Agent server. */
import React from "react";
import { createRoot } from "react-dom/client";
import { createAccountClient, type CloudAccountClient } from "../../account/client";
import { cloudConsentState, setCloudConsentSource } from "./consent";
import { hasCloudIdentity } from "./identity";
import { CloudAiPanel } from "../../editor/right/CloudAiPanel";
import { getQueue } from "../chatQueue";
import { bootApiGuard } from "../../online/apiGuard";

bootApiGuard(true, { base: "/editor/" });
let client: CloudAccountClient | null = null;
const root = createRoot(document.getElementById("root")!);
(window as unknown as { __pcConsentProbe: unknown }).__pcConsentProbe = {
  async mount() {
    client = createAccountClient({ online: true, origin: location.origin,
      device: { deviceId: `consent-browser-${crypto.randomUUID()}`, deviceName: "consent probe" } });
    const account = await client.restore();
    if (!account) throw Error("login-required");
    setCloudConsentSource({ client, accountId: account.id });
    root.render(<CloudAiPanel tabId="consent-probe" cloud={{ available: true, enabled: true,
      url: `${location.origin}/agent/v1`, projectId: `sp_${"a".repeat(26)}`, identityVersion: 0,
      accountMode: true, accountId: account.id }} />);
    return { accountId: account.id, oldDelegation: hasCloudIdentity() };
  },
  async logout() { if (!client) throw Error("not-mounted"); await client.logout(); },
  status() { const state = cloudConsentState(); return { accountId: state.accountId, accepted: state.accepted, pending: state.pending,
    queued: getQueue(`cloud:consent-probe:${state.accountId ?? "none"}:${state.bindingVersion}:sp_${"a".repeat(26)}`).length }; },
  close() { setCloudConsentSource(null); root.unmount(); },
};
