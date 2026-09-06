import { actions, getState } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";
import { snapTime, timeOfX } from "./utils";

/**
 * 拖播放头(scrub)。卡尺和播放头本体共用这一份:
 * - 卡尺:按下就把播放头挪到指针处,按住不放接着拖(jumpToPointer)
 * - 播放头本体:按下不跳,保持抓取时的偏移
 * 两者都在拖动过程中实时 seek,画面跟着走,不是松手才跳一下。
 *
 * 时间原点统一取轨道区(trackArea)的左边——卡尺和播放头都在它里面,
 * 各自元素的左边并不是 0 秒。
 */
export interface ScrubOptions {
  /** 按下就跳到指针处(卡尺用);false 表示保持抓取偏移(拖播放头本体用) */
  jumpToPointer: boolean;
}

export function useScrub() {
  const { pxPerSec, trackAreaRef } = useTimelineContext();

  return (e: React.PointerEvent, opts: ScrubOptions) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.currentTarget as HTMLElement;
    const secAt = (clientX: number) => {
      const left = trackAreaRef.current?.getBoundingClientRect().left ?? 0;
      return Math.max(0, timeOfX(clientX - left, pxPerSec));
    };
    // 播放中拖播放头会被播放循环拽回去,先停下来
    if (getState().playing) actions.pause();

    // -1:不要把播放头自己当吸附点,否则拖动时会黏在原地
    const snap = (raw: number, altKey: boolean) =>
      Math.max(0, snapTime(raw, altKey, getState().project, -1, undefined, pxPerSec));

    const offset = opts.jumpToPointer ? 0 : getState().t - secAt(e.clientX);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 指针已经不在了(比如合成事件、鼠标已松开),照样能拖,只是没有捕获
    }
    actions.seek(snap(secAt(e.clientX) + offset, e.altKey));

    const onMove = (ev: PointerEvent) => {
      actions.seek(snap(secAt(ev.clientX) + offset, ev.altKey));
    };
    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // 指针已经被别处接管,忽略
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };
}
