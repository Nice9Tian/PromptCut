export const agentTools = [
  // ── 多 Agent 并行(AI 面板的分页,每页一个 Agent 同时改同一个项目) ──
  {
    name: "declare_scope",
    description: "开工第一步:声明你这一轮打算改的范围,格式「剪辑X->序列X」(多个用逗号分开,如「剪辑1->序列2,剪辑1->序列3」)。会显示在你的页签上,其他 Agent 也会收到通知;返回里列出别的 Agent 和它们的范围,有重叠会给 warning,先 send_message 商量好再动手。范围变了就再声明一次。",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "「剪辑X->序列X」,多个用逗号分开" },
        note: { type: "string", description: "一句话说明打算做什么(可选)" }
      },
      required: ["scope"]
    },
    side: "page"
  },
  {
    name: "list_agents",
    description: "看现在有哪些 Agent 在同一个项目上并行(每个的对话 ID、页签名、声明的范围、忙不忙)。you 是你自己的对话 ID。要给谁发消息先用它拿 ID。",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "send_message",
    description: "给另一个 Agent 发一段话协调分工(比如「序列2 我来改,你别动」「我改完了序列3,你可以接着放字幕」)。to 是对方的对话 ID(list_agents 里的 id),写 all 就发给所有其他 Agent。对方空闲时这段话会立刻作为一条消息发给它;它正忙就等它这一轮结束再送。连续互发有层数上限,超过就留在对方信箱里等用户下次开口时带上,所以不要用它来回闲聊,说清楚一次就够。",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "收件 Agent 的对话 ID,或 all" },
        text: { type: "string", description: "要说的话" }
      },
      required: ["to", "text"]
    },
    side: "page"
  },
  {
    name: "check_messages",
    description: "看看有没有别的 Agent 给你的消息、以及自上次以来别人改了哪些「剪辑->序列」(不取走)。一般不用主动调:这些内容会在你每一轮开始时自动附在提示词前面;只在长任务中途想确认一下时用。",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  }
];
