import React, { useEffect, useSyncExternalStore, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageList } from '../../../../src/editor/right/chat/MessageList';
import { getChatStore, useChatMessages } from '../../../../src/ai/liveChat';
import { useInstallJobs } from '../../../../src/ai/sttInstallStore';
import { createCloudApi } from '../../../../src/ai/cloud/cloudApi';
import { createCloudSession } from '../../../../src/ai/cloud/session';

// Only private controlled fixture values, loaded from the owner Vite endpoint.
// No fetch replacement/SSE injection/native mock. The API and Session are product code.
const config = await fetch('/fixture-config').then(r => r.json());
const store = getChatStore('visible-account-run');
const api = createCloudApi({ baseUrl: () => config.origin + '/v1', projectId: () => config.projectId,
  ticket: async () => config.ticket, grant: async () => undefined });
const session = createCloudSession({ api, store });
function Page() {
  const messages = useChatMessages(store);
  const view = useSyncExternalStore(session.subscribe, session.getView, session.getView);
  const installJobs = useInstallJobs();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { session.open(config.conversationId); return () => session.close(); }, []);
  return <main><h1>真实服务 SSE → React 消息列表</h1>
    <p>模型、工具与账号核验使用受控驱动；未验证实际模型或完整编辑器。</p>
    <button data-pc="visible-send" disabled={sent} onClick={async () => {
      try { await session.send({ prompt: 'Doc accepted original', requestId: 'visible_send' }); setSent(true); }
      catch { setError(true); }
    }}>发送一次</button>
    <button data-pc="visible-replay" onClick={() => session.open(config.conversationId)}>重新读取持久记录</button>
    <output data-pc="visible-state" data-count={messages.length} data-live={view.streaming}
      data-cursor={view.lastSeq} data-error={error || !!view.problem}>{view.connection}</output>
    <MessageList messages={messages} senders={view.senders}
      view="verbose" showThinking={true} installJobs={installJobs} expanded={new Set()} openRuns={new Set()}
      rowHandlers={{ toggleTool() {}, toggleChip() {}, toggleRun() {} }} onPickExample={() => {}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Page />);
window.addEventListener('pagehide', () => session.close(), { once: true });
