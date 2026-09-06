import type { Timeline } from "./kernel/types";

/**
 * 演示时间轴:预览和导出共用。
 * 卡片作者把自己的卡加进 clips(每张 2 秒,顺序排),params 留空即用 defaults。
 */
export const demoTimeline: Timeline = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 20,
  clips: [
    { id: "probe", cardId: "probe", start: 0, end: 2, params: {} }
  ],
};
