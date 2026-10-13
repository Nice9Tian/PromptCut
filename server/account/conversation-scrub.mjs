/**
 * 删除一个云端对话以后，把账本里各处还带着这个对话文字的地方清掉(2026-10-13 用户定：「清干净」)。
 *
 * 账本里除了对话行本身(`conversationsV2`，删除时整行拿掉)，只有下面这几张表里的记录带这个对话的文字：
 *   conversationRequestsV2   每次发送、切换、改名、停止的幂等结果(结果里有对话的标题；发送的结果里带对话摘要)
 *   runGrantsV2              每一轮的运行授权(选区快照)
 *   runRequestsV2            领取一轮的结果(整条消息原文、选区快照)
 *   runReadRequestsV2        已读确认的结果(提示词)
 *   runFinishRequestsV2、runReceiptsV2、runFinishReceiptsV2   结束的请求与回执(结果文字)
 * 运行授权、控制记录、结清回执是停止、结清、审计要用的，别的记录按号引用它们，不能整条拿掉，所以这里只清文字、不删记录。
 *
 * 只走这几张表(不遍历整本账本)，按确切的字段匹配：记录或它的 `result` 同时有 `projectId` 和 `conversationId` 都对得上，
 * 或者是对话的公开形状(`v: 2`、`id` 是这个对话号、带 `ownerAccountId`)且 `projectId` 对得上。
 * 对话号是页面自己起的，所以光凭「同项目、id 等于对话号」不够，一定要带上这些别的字段。
 * 消息内容的摘要 `contentDigest` 是哈希，不是文字，保留。
 */
const SCOPED_TABLES = ['conversationRequestsV2', 'runGrantsV2', 'runRequestsV2', 'runReadRequestsV2', 'runFinishRequestsV2',
  'runReceiptsV2', 'runFinishReceiptsV2'];
const TEXT_FIELDS = ['content', 'prompt', 'title', 'text', 'delta', 'message', 'messages', 'selectionSnapshot', 'attachments'];

const ofConversation = (node, projectId, conversationId) => !!node && typeof node === 'object' && !Array.isArray(node) &&
  node.projectId === projectId && (node.conversationId === conversationId ||
    (node.v === 2 && node.id === conversationId && typeof node.ownerAccountId === 'string'));

export function scrubConversationInState(state, projectId, conversationId) {
  let scrubbed = 0;
  const clean = node => { for (const key of TEXT_FIELDS) if (key in node) { delete node[key]; scrubbed++; } };
  for (const table of SCOPED_TABLES) for (const entry of Object.values(state[table] ?? {})) {
    for (const node of [entry, entry?.result, entry?.result?.conversation])
      if (ofConversation(node, projectId, conversationId)) clean(node);
  }
  return scrubbed;
}
