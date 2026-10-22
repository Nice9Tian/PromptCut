/**
 * 「详细编辑」里那条时间轴的假数据。**只给 UI 用**,等业务层接上就整个删掉。
 *
 * 形状照软件里的编辑台(用户给的参考图):一条条**序列**,每条序列上排卡片和素材。
 * 真的时间轴是 `src/kernel/types.ts` 的 `Timeline`(clips 带 start / end / cardId),
 * 真接上去时这一份换成从 store 读当前项目。
 */

export interface MockClip {
  id: string;
  name: string;
  /** 秒 */
  start: number;
  end: number;
  /** 第几条序列(从 0 数) */
  track: number;
  kind: "卡片" | "素材";
}

/** 和 `ChatSidePanel.tsx` 的 DURATION 对齐:同一支片子 */
export const TIMELINE_DURATION = 15;

const CLIPS: Record<string, MockClip[]> = {
  "p-01": [
    { id: "t1", name: "开场特写", start: 0, end: 3.2, track: 0, kind: "素材" },
    { id: "t2", name: "产品转台", start: 3.2, end: 9.4, track: 0, kind: "素材" },
    { id: "t3", name: "店铺名卡", start: 9.4, end: 15, track: 0, kind: "卡片" },
    { id: "t4", name: "字幕 · 限时", start: 1.4, end: 6.8, track: 1, kind: "卡片" },
    { id: "t5", name: "字幕 · 收尾", start: 10.2, end: 14.2, track: 1, kind: "卡片" },
  ],
};

/** 没写过的项目给一条通用的,这样每条对话点进去都有东西可看 */
const FALLBACK: MockClip[] = [
  { id: "t1", name: "第一个镜头", start: 0, end: 6, track: 0, kind: "素材" },
  { id: "t2", name: "第二个镜头", start: 6, end: 15, track: 0, kind: "素材" },
  { id: "t3", name: "字幕", start: 2, end: 8.5, track: 1, kind: "卡片" },
];

export function clipsOf(seed: string): MockClip[] {
  return CLIPS[seed] ?? FALLBACK;
}

/** 引用进输入框时写成什么样:`@卡片名` —— 用户右键一张卡就能把它带进话里 */
export const quoteOf = (clip: MockClip): string => `@${clip.name}`;
