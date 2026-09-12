import { waitFrameReady } from './frame-ready.mjs';

/** A compositor tick can acknowledge beginFrame before a surface is ready.
 * Retry at the same timeline time, bounded to four attempts. Never reset the
 * animation or return the previous frame when Chrome has not supplied pixels.
 */
export async function captureFrame(bakery, screenshot, signal) {
  if (bakery.page) await waitFrameReady(bakery, signal);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
    const result = await bakery.beginFrame({ screenshot });
    if (result.screenshotData) return Buffer.from(result.screenshotData, 'base64');
    // Distinguish a compositor/surface failure from unfinished control loads.
    // Only query on failure; the normal screenshot path stays small.
    if (bakery.page) {
      const state = await bakery.page.evaluate(() => ({
        time: window.__pcExportMs, fonts: document.fonts.status,
        controls: window.__pcFrameWorkStatus?.() || [],
        images: [...document.images].filter(img => img.getAttribute('src') && !img.complete).length,
        videos: [...document.querySelectorAll('video[src]')].map(v => ({ readyState: v.readyState, seeking: v.seeking })),
      }));
      console.warn('[capture-frame] empty compositor screenshot', { attempt: attempt + 1, hasDamage: result.hasDamage, ...state });
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 8));
  }
  throw new Error('Chrome did not return the requested frame after 4 compositor ticks');
}
