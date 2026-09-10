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

/**
 * 「手正按在播放头上」的对外信号。
 *
 * # 为什么烘焙那边需要知道这件事
 *
 * 3D 视图看到板子缺这一刻的贴图就会立刻发一次前台烘焙。拖动时播放头每跨过一个格子
 * (0.25 秒)就换一个时刻,于是**按着不放拖过去一路就是一串烘焙请求** —— 每一个都会
 * 占住一个 Chrome 好几秒,而它们烘的都是用户一闪而过、根本没停下来看的位置。
 * 前一个还没跑完下一个就来了,池子被这些注定作废的活占满,等用户真的松手停在某处,
 * 反而得排在它们后面等。
 *
 * 所以:**按着的时候一张都不烘,松手那一刻再烘**。这比"防抖 N 毫秒"准 ——
 * 松手是一个明确的事件,不用猜多久算停下;而点一下卡尺跳过去(按下即松开)也不会
 * 因此多等,因为松手立刻就发生了。
 *
 * 走模块级 + useSyncExternalStore,理由和 bakeCoverage 那个小仓库一样:时间轴和预览面板
 * 在组件树上离得很远,中间那一整条链路没有一个组件需要这个值。
 *
 * # 记的是「哪几根指头按着」,不是一个计数
 *
 * 计数器有一个致命的失败模式:**漏掉一次松手,烘焙就永久停摆**。而漏是会发生的 ——
 * 指针被别的元素接管、拖到一半元素被卸载、浏览器把 pointerup 送到了别处。
 * 那时候界面看上去一切正常,只是再也不烘了,而且不报错。
 *
 * 所以按 pointerId 存进 Set(重复 add / 重复 delete 都是幂等的),并且**在 window 上收尾**:
 * 不管松手发生在哪个元素上都算数,窗口失焦时直接全清。哪怕某一次真的漏了,
 * 下一次点任何地方的 pointerup 都会把它清掉,不会烂在那儿。
 */
const scrubbers = new Set<number>();
const scrubListeners = new Set<() => void>();
export function isScrubbing(): boolean { return scrubbers.size > 0; }
export function subscribeScrub(fn: () => void): () => void {
  scrubListeners.add(fn);
  return () => { scrubListeners.delete(fn); };
}
function notifyScrub() { for (const fn of scrubListeners) fn(); }
function beginScrub(id: number) {
  if (scrubbers.has(id)) return;
  scrubbers.add(id);
  notifyScrub();
}
function endScrub(id: number) {
  if (!scrubbers.delete(id)) return;
  notifyScrub();
}
if (typeof window !== "undefined") {
  // 收尾一律挂在 window 上:松手落在哪个元素上都算,漏不掉
  window.addEventListener("pointerup", (e) => endScrub(e.pointerId), true);
  window.addEventListener("pointercancel", (e) => endScrub(e.pointerId), true);
  // 拖着拖着切走了窗口,pointerup 可能永远不来 —— 失焦就当全松了
  window.addEventListener("blur", () => {
    if (!scrubbers.size) return;
    scrubbers.clear();
    notifyScrub();
  });
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
    // 手按下了 —— 从这一刻起前台烘焙让路,直到松手。收尾挂在 window 上(见上面 isScrubbing)
    beginScrub(e.pointerId);
    const onUp = (ev: PointerEvent) => {
      endScrub(ev.pointerId);
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
