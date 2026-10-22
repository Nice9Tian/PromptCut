/**
 * 聊天页的假对话。**只给 UI 用**,等业务层接上就整个删掉。
 *
 * 待办(业务层):对话记录存在云节点上、按网站账号编号归属,读写要按共有/私有过滤
 * (`product/agent.md`「对话记录」);第一次用云端 Agent 前还要弹一次「托管方能读到你和云端 Agent 的
 * 对话记录,包括私有对话」的告知框,选了「我知道了」才能用,按账号记住(同一本「告知托管方能读」)。
 */

export interface MockMessage {
  id: string;
  from: "me" | "agent";
  text: string;
  /** 这一轮 Agent 做过的事。编辑器里那一栏叫「Agent 操作」,这里沿用同一个说法 */
  actions?: string[];
}

/** 按对话号取;没有写过的对话给一段通用的开场,这样每条都点得开 */
const SCRIPTS: Record<string, MockMessage[]> = {
  "a-01": [
    { id: "m1", from: "me", text: "这支片子的字幕太素了，能不能跟着品牌色走？主色是青蓝。" },
    {
      id: "m2",
      from: "agent",
      text: "看过这一版的画面了。字幕现在是纯白加黑描边，压在浅色产品图上基本看不清。我按品牌色改了三处：字体色换成青蓝的浅一档，描边改成同色系的深色，关键词加一层很淡的底。",
      actions: ["看了第 3、7、11 秒的画面", "改了 2 张字幕卡的样式", "把「限时」两个字单独提了一档"],
    },
    { id: "m3", from: "me", text: "底色那一层去掉，太花了。" },
    {
      id: "m4",
      from: "agent",
      text: "去掉了。现在只有字色和描边跟着品牌色，重点词靠字重区分。你看一下第 7 秒那一处，浅色背景上对比度刚好够。",
      actions: ["去掉了 2 张字幕卡的底色", "把重点词从加底改成加粗"],
    },
  ],
  "a-02": [
    { id: "m1", from: "me", text: "结尾那三秒太仓促了，收不住。" },
    {
      id: "m2",
      from: "agent",
      text: "现在是画面直接切黑。我试了两种收法：一种是最后一个镜头多留 0.6 秒再淡出，另一种是把店铺名那张卡提前 0.4 秒进场、和画面叠一下。要哪种？",
      actions: ["量了结尾三秒的节奏", "做了两版收尾给你比"],
    },
  ],
  "a-07": [
    { id: "m1", from: "me", text: "这个分组里四支片子的片尾都要换成新的店铺名卡，能一起改吗？" },
    {
      id: "m2",
      from: "agent",
      text: "可以。四支片子的片尾都是同一张卡的不同参数，我把名字那一行统一换掉，时长和位置都不动。改完我会把四个首帧贴回来给你看。",
      actions: ["翻了分组里 4 个项目的末尾一张卡", "确认它们用的是同一张卡"],
    },
  ],
};

const OPENING: MockMessage[] = [
  {
    id: "m1",
    from: "agent",
    text: "这条对话还没说过话。说一句你想让我做的事 —— 比如「把开头两秒去掉」「字幕换成品牌色」「这一段配上音乐」。",
  },
];

export function messagesOf(chatId: string): MockMessage[] {
  return SCRIPTS[chatId] ?? OPENING;
}

/**
 * 一次操作。类别用的是软件里那一套说法(`src/editor/right/chat/iconRuns.ts` 的 `KIND_LABEL`:
 * 新增 / 删除 / 修改 / 读取 / 查看 / 收集 / 界面操作 / 多 Agent / 等待 / 处理),
 * 一行写「类别 · 工具名 · 耗时」,和编辑器里操作详情的头一行同一个写法。
 */
export interface MockChange {
  id: string;
  kind: "新增" | "删除" | "修改" | "读取" | "查看" | "收集" | "界面操作" | "处理";
  tool: string;
  /** 耗时(毫秒) */
  ms: number;
  /** 结果里的那句话 */
  note?: string;
  /** 有改前改后画面可比的才给 true */
  hasDiff?: boolean;
}

const CHANGES: Record<string, MockChange[]> = {
  "a-01": [
    { id: "c1", kind: "查看", tool: "look_frame", ms: 820, note: "第 3 秒：字幕压在浅色产品图上" },
    { id: "c2", kind: "修改", tool: "edit_card", ms: 310, note: "字幕卡：字色换成青蓝浅一档", hasDiff: true },
    { id: "c3", kind: "修改", tool: "edit_card", ms: 290, note: "描边改成同色系的深色", hasDiff: true },
    { id: "c4", kind: "修改", tool: "edit_card", ms: 240, note: "去掉底色，重点词改成加粗", hasDiff: true },
  ],
  "a-02": [
    { id: "c1", kind: "读取", tool: "read_timeline", ms: 90, note: "结尾三秒：一个镜头加一张店铺名卡" },
    { id: "c2", kind: "处理", tool: "make_variant", ms: 1460, note: "做了两版收尾", hasDiff: true },
  ],
  "a-07": [
    { id: "c1", kind: "读取", tool: "read_timeline", ms: 160, note: "四个项目的末尾用的是同一张卡" },
  ],
};

export function changesOf(chatId: string): MockChange[] {
  return CHANGES[chatId] ?? [];
}

/** 发出去之后顶上来的那一条:只说明这一版不会真的回复,不编造 Agent 的回答 */
export const PENDING_REPLY =
  "待办：这里要接云端 Agent 服务（`product/agent.md`「运行位置」）。界面预览阶段不会真的回复，也不会改动任何项目。";
