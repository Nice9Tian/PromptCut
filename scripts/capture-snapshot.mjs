import { prepareFrameMedia } from './frame-media.mjs';

/** A, B->C and export all rasterize the same frozen HTML in the same document. */
export async function captureSnapshot(bakery, html, screenshot = { format: 'png', optimizeForSpeed: true }) {
  await bakery.page.evaluate(h => {
    const root = document.getElementById('root');
    if (root) { root.dataset.pcDisplay = root.style.display; root.style.display = 'none'; }
    const box = document.createElement('div');
    box.id = 'pc-frame-snapshot';
    box.style.cssText = 'position:absolute;left:0;top:0';
    const template = document.createElement('template');
    template.innerHTML = h;
    // Portable snapshots are data, never an executable page restored from a .proc file.
    template.content.querySelectorAll('script,iframe,object,embed,base,meta,link').forEach(el => el.remove());
    for (const element of template.content.querySelectorAll('*')) {
      for (const attr of [...element.attributes]) {
        if (/^on/i.test(attr.name) || /^(?:javascript|vbscript):/i.test(attr.value.trim())) element.removeAttribute(attr.name);
      }
    }
    box.appendChild(template.content);
    document.body.appendChild(box);
  }, html);
  try {
    await bakery.page.evaluate(async () => {
      const box = document.getElementById('pc-frame-snapshot');
      // A missing optional image should render as an empty layer, just like the
      // live export page.  `decode()` rejects for a broken URL; letting that
      // reject the whole frame would make one unavailable asset block every
      // other track and would diverge from the normal browser preview.
      await Promise.all([...box.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
      await document.fonts.ready;
    });
    await prepareFrameMedia(bakery);
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await bakery.beginFrame({ screenshot });
      if (result.screenshotData) break;
      await new Promise(resolve => setTimeout(resolve, 8));
    }
    if (!result.screenshotData) throw new Error('Chrome did not return the requested frame');
    return Buffer.from(result.screenshotData, 'base64');
  } finally {
    await bakery.page.evaluate(() => {
      const box = document.getElementById('pc-frame-snapshot');
      for (const v of box?.querySelectorAll('video') || []) { v.removeAttribute('src'); v.load(); }
      box?.remove();
      const root = document.getElementById('root');
      if (root) { root.style.display = root.dataset.pcDisplay || ''; delete root.dataset.pcDisplay; }
    });
  }
}
