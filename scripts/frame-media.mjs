/** Installed before React. No media URLs are assigned during animation advancement. */
export function installFrameMedia() {
  window.__pcHideFrameMedia = () => {
    for (const v of document.querySelectorAll('video[data-pc-media-src]')) {
      v.style.visibility = 'hidden';
      if (v.hasAttribute('src')) {
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
    }
  };
  window.__pcPrepareFrameMedia = async () => {
    await Promise.all([...(document.getElementById('pc-frame-snapshot') || document).querySelectorAll('video[data-pc-media-src]')].map(v => new Promise((resolve, reject) => {
      let sought = false;
      const events = ['loadedmetadata', 'loadeddata', 'seeked', 'canplay', 'error'];
      const finish = error => {
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
      v.style.visibility = 'visible';
      v.preload = 'auto';
      v.src = v.dataset.pcMediaSrc;
      v.load();
      check();
    })));
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
}
