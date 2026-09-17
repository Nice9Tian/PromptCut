/**
 * 这一帧的素材(视频 seek / 图片加载)。
 *
 * 原来写在 `scripts/frame-media.mjs`、由 puppeteer 的 `evaluateOnNewDocument` 注入;现在是页面
 * bundle 的一部分(J1),但 `window.__pcHideFrameMedia` / `window.__pcPrepareFrameMedia` 这两个
 * 名字和语义原样不动 —— `scripts/frame-media.mjs` 的 `prepareFrameMedia`(Node 侧)和
 * `scripts/capture-snapshot.mjs` 还是照旧调它们。
 *
 * 必须在 React 之前装好:推进动画的过程中一律不给素材赋 URL。
 */
export function installFrameMedia(): void {
  window.__pcHideFrameMedia = () => {
    for (const v of document.querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")) {
      v.style.visibility = "hidden";
      if (v.hasAttribute("src")) {
        if (v.tagName === "VIDEO") (v as HTMLVideoElement).pause();
        v.removeAttribute("src");
        if (v.tagName === "VIDEO") (v as HTMLVideoElement).load();
      }
    }
  };
  window.__pcPrepareFrameMedia = async () => {
    const scope: ParentNode = document.getElementById("pc-frame-snapshot") || document;
    await Promise.all([...scope
      .querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")]
      .map((el) => new Promise<void>((resolve, reject) => {
        if (el.tagName === "IMG") {
          const v = el as HTMLImageElement;
          const loaded = () => finishImage();
          const failed = () => finishImage(new Error(`Image load failed: ${v.dataset.pcMediaSrc}`));
          const finishImage = (error?: Error) => {
            clearTimeout(timer);
            v.removeEventListener("load", loaded); v.removeEventListener("error", failed);
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(() => finishImage(new Error(`Image load timed out: ${v.dataset.pcMediaSrc}`)), 20000);
          v.addEventListener("load", loaded, { once: true });
          v.addEventListener("error", failed, { once: true });
          v.style.visibility = v.dataset.pcMediaHidden === "true" ? "hidden" : "visible";
          v.src = v.dataset.pcMediaSrc!;
          if (v.complete && v.naturalWidth) { clearTimeout(timer); finishImage(); }
          return;
        }
        const v = el as HTMLVideoElement;
        let sought = false, finished = false, presented = false, frameRequest = 0;
        let target: number | null = null;
        const events = ["loadedmetadata", "loadeddata", "seeked", "canplay", "error"];
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          v.cancelVideoFrameCallback?.(frameRequest);
          events.forEach((e) => v.removeEventListener(e, check));
          error ? reject(error) : resolve();
        };
        const check = () => {
          if (v.error) return finish(new Error(`Video decode failed: ${v.dataset.pcMediaSrc} (${v.error.code})`));
          if (v.readyState < 1) return;
          const requested = Number(v.dataset.pcMediaTime);
          target = Math.max(0, Math.min(requested, Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.000001) : requested));
          if (!sought) {
            sought = true;
            if (Math.abs(v.currentTime - target) > 0.000001) { v.currentTime = target; return; }
          }
          if (!v.seeking && v.readyState >= 2 && presented) finish();
        };
        // readyState/seeked only mean the frame is decoded. The compositor gets
        // it a few BeginFrames later; a screenshot in between has a transparent
        // video layer (Tokyo project: the first captured frame of a run, and
        // sparse frames 1500/1510 on every attempt). The presented-frame callback
        // is the signal that the settled frame reached the compositor. Measured
        // under beginFrame control, it also fires for covered, hidden, offscreen
        // and zero-size videos.
        // Judge a presentation by its media time, not by seeking/readyState when
        // the callback runs: the sought frame can be presented before `seeked`
        // (observed: mediaTime 12.095 for target 12.1 while readyState was 1),
        // and a paused video presents nothing afterwards. The frame covering the
        // target starts at or just before it; 0.25 s admits sources down to 4 fps.
        const rejected: string[] = [];
        const onPresented: VideoFrameRequestCallback = (_now, meta) => {
          if (finished) return;
          // A frame may be presented before check() has seen metadata.
          const want = target ?? Math.max(0, Number(v.dataset.pcMediaTime));
          if (meta.mediaTime <= want + 0.002 && want - meta.mediaTime < 0.25) { presented = true; check(); }
          else {
            rejected.push(`${meta.mediaTime.toFixed(3)}@rs${v.readyState}${v.seeking ? "S" : ""}`);
            frameRequest = v.requestVideoFrameCallback(onPresented);
          }
        };
        frameRequest = v.requestVideoFrameCallback(onPresented);
        const timer = setTimeout(() => {
          const state = `target=${v.dataset.pcMediaTime} current=${v.currentTime} readyState=${v.readyState} seeking=${v.seeking} rejectedPresentations=[${rejected.slice(-4).join(",")}]`;
          finish(new Error(v.readyState >= 2 && !v.seeking
            ? `Video frame was not presented (${state}): ${v.dataset.pcMediaSrc}`
            : `Video seek timed out (${state}): ${v.dataset.pcMediaSrc}`));
        }, 20000);
        events.forEach((e) => v.addEventListener(e, check));
        v.style.visibility = v.dataset.pcMediaHidden === "true" ? "hidden" : "visible";
        v.preload = "auto";
        v.src = v.dataset.pcMediaSrc!;
        v.load();
        check();
      })));
    document.dispatchEvent(new Event("pc:frame-media-ready"));
  };
}
