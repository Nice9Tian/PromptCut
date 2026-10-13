import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 云端对话被删以后，Agent 服务一侧(主服务能够到的)还留着这个对话文字的地方，一次清干净(2026-10-13 用户定：清干净)。
 *
 * 清哪些(都按「项目 × 对话」)：
 *   事件库   run_events、accepted_messages(已接受消息的原文)、conversation_heads、run_bindings、任务进程交上来的来源包
 *   已读意向 read_intents(含提示词原文)
 *   模型历史 <共用数据目录>/tenants/<项目>/conversations/<对话>(history.json 等)
 *   工作目录 <共用数据目录>/work/<项目>/<主人键>/<对话>(含用户上传的附件、工具下载的文件)
 * 清不到的(各代任务进程自己的本机状态、用量流水里的号)见 docs/reports/AGENT-v18-chats.md「删干净那张表」。
 *
 * 幂等：一遍清完再来一遍什么都不剩也不报错；任何一处清失败就抛错(调用方回页面 503，页面用同一个请求号重试，会再清一遍)。
 */
const safeSeg = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !/^\.+$/.test(value);
export const accountConversationOwnerKey = (projectId, conversationId) =>
  createHash('sha256').update(`account-v2\n${projectId}\n${conversationId}`).digest('hex').slice(0, 32);

export function createConversationPurger({ eventStore = null, readIntents = null, sharedDataDir = null, log = () => {} } = {}) {
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志不影响清理 */ } };
  const rmdir = dir => {
    const existed = fs.existsSync(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    if (fs.existsSync(dir)) throw Object.assign(new Error('purge-incomplete'), { status: 503, code: 'purge-incomplete' });
    return existed;
  };
  return {
    async purge({ projectId, conversationId }) {
      if (!safeSeg(projectId) || !safeSeg(conversationId)) throw Object.assign(new Error('purge-invalid'), { status: 400, code: 'purge-invalid' });
      const out = { runEvents: null, readIntents: null, history: false, workspace: false };
      try {
        if (eventStore?.purgeConversation) out.runEvents = eventStore.purgeConversation({ projectId, conversationId });
        if (readIntents?.purgeConversation) out.readIntents = readIntents.purgeConversation({ projectId, conversationId });
        if (sharedDataDir) {
          out.history = rmdir(path.join(sharedDataDir, 'tenants', projectId, 'conversations', conversationId));
          const work = path.join(sharedDataDir, 'work', projectId);
          let owners = [];
          try { owners = fs.readdirSync(work); } catch { /* 这个项目没有工作区 */ }
          for (const owner of owners) if (rmdir(path.join(work, owner, conversationId))) out.workspace = true;
        }
      } catch (error) {
        say('agent.conversation.purge-failed', { code: error?.code ?? 'purge-failed' });
        throw Object.assign(new Error(error?.code ?? 'purge-failed'), { status: 503, code: 'purge-failed' });
      }
      say('agent.conversation.purged', { projectId, runEvents: out.runEvents?.rows ?? 0, readIntents: out.readIntents?.rows ?? 0 });
      return out;
    },
  };
}
