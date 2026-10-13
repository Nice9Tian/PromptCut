/**
 * 删除一个云端对话以后，把账本里各处还带着这个对话文字的地方清掉(2026-10-13 用户定：「清干净」)。
 *
 * 账本里除了对话行本身(`conversationsV2`，删除时整行拿掉)，还有几类记录带着这个对话的文字：
 * 每次发送与切换的幂等结果(`conversationRequestsV2`，里面有标题)、每一轮的运行授权与它的领取、已读、结束请求的结果
 * (`runGrantsV2`、`runRequestsV2`、`runReadRequestsV2`、`runFinishRequestsV2` 等，里面有整条消息、选区快照)。
 * 运行授权、控制记录、结清回执是停止、结清、审计要用的，不能整条拿掉(别的记录按号引用它们)，所以这里不删记录、只清文字：
 * 凡是记着「这个项目的这个对话」(`projectId` 与 `conversationId`，或对话自己的 `id`)的对象，把带文字的字段拿掉。
 * 只留号、状态、摘要这类不含文字的字段(消息内容的摘要 `contentDigest` 是哈希，不是文字，保留)。
 */
const TEXT_FIELDS = ['content', 'prompt', 'title', 'text', 'delta', 'message', 'messages', 'selectionSnapshot', 'attachments'];

export function scrubConversationInState(state, projectId, conversationId) {
  const seen = new Set();
  let scrubbed = 0;
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node) && node.projectId === projectId && (node.conversationId === conversationId || node.id === conversationId)) {
      for (const key of TEXT_FIELDS) if (key in node) { delete node[key]; scrubbed++; }
    }
    for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value);
  };
  // 墓碑表自己不带文字，不必走；还没弹的通知(conversationNoticesV2)要靠标题把话说清楚，弹完回执时整条删，所以也不在这里清
  for (const [key, value] of Object.entries(state)) if (key !== 'conversationTombstonesV2' && key !== 'conversationNoticesV2') walk(value);
  return scrubbed;
}
