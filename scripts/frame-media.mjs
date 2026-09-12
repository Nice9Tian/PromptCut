/** Installed before React. No media URLs are assigned during animation advancement. */
export function installFrameMedia() {
  window.__pcHideFrameMedia = () => {
    for (const v of document.querySelectorAll('video[data-pc-media-src], img[data-pc-media-src]')) {
      v.style.visibility = 'hidden';
      if (v.hasAttribute('src')) {
        if (v.tagName === 'VIDEO') v.pause();
        v.removeAttribute('src');
        if (v.tagName === 'VIDEO') v.load();
      }
    }
  };
  window.__pcPrepareFrameMedia = async () => {
    await Promise.all([...(document.getElementById('pc-frame-snapshot') || document).querySelectorAll('video[data-pc-media-src], img[data-pc-media-src]')].map(v => new Promise((resolve, reject) => {
      if (v.tagName === 'IMG') {
        const loaded = () => finishImage();
        const failed = () => finishImage(new Error(`Image load failed: ${v.dataset.pcMediaSrc}`));
        const finishImage = error => {
          clearTimeout(timer);
          v.removeEventListener('load', loaded); v.removeEventListener('error', failed);
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finishImage(new Error(`Image load timed out: ${v.dataset.pcMediaSrc}`)), 20000);
        v.addEventListener('load', loaded, { once: true });
        v.addEventListener('error', failed, { once: true });
        v.style.visibility = v.dataset.pcMediaHidden === 'true' ? 'hidden' : 'visible';
        v.src = v.dataset.pcMediaSrc;
        if (v.complete && v.naturalWidth) { clearTimeout(timer); finishImage(); }
        return;
      }
      let sought = false, finished = false;
      const events = ['loadedmetadata', 'loadeddata', 'seeked', 'canplay', 'error'];
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        events.forEach(e => v.removeEventListener(e, check));
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (v.error) return finish(new Error(`Video decode failed: ${v.dataset.pcMediaSrc} (${v.error.code})`));
        if (v.readyState < 1) return;
        const requested = Number(v.dataset.pcMediaTime);
        const target = Math.max(0, Math.min(requested, Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.000001) : requested));
        if (!sought) {
          sought = true;
          if (Math.abs(v.currentTime - target) > 0.000001) { v.currentTime = target; return; }
        }
        if (!v.seeking && v.readyState >= 2) finish();
      };
      const timer = setTimeout(() => finish(new Error(`Video seek timed out: ${v.dataset.pcMediaSrc}`)), 20000);
      events.forEach(e => v.addEventListener(e, check));
      v.style.visibility = v.dataset.pcMediaHidden === 'true' ? 'hidden' : 'visible';
      v.preload = 'auto';
      v.src = v.dataset.pcMediaSrc;
      v.load();
      check();
    })));
    document.dispatchEvent(new Event('pc:frame-media-ready'));
  };
}

export async function prepareFrameMedia(bakery) {
  // The decoder can need compositor ticks to deliver loadeddata/seeked in headless-shell.
  let done = false;
  let failure;
  const pending = bakery.page.evaluate(() => window.__pcPrepareFrameMedia?.())
    .catch(e => { failure = e; }).finally(() => { done = true; });
  while (!done) {
    await bakery.beginFrame();
    if (!done) await new Promise(r => setTimeout(r, 4));
  }
  await pending;
  if (failure) throw failure;
  // Commit the decoded/seeked media before requesting a screenshot. A paused
  // video hidden behind another layer may never fire requestVideoFrameCallback;
  // waiting on that callback would deadlock otherwise valid timeline frames.
  await bakery.beginFrame();
}
