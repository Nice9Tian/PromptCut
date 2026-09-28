import { mediaTierPolicy, remoteMediaUrl } from "../mediaTier";

/**
 * 卡片自己引用的素材地址:桌面原样(`/@media/<hash>`);在线浏览器模式没有本机编辑器进程,换成远程素材服务上的
 * 原尺寸(带只读票据;卡片画进画布、导出都要原尺寸)。远程地址还没就绪时给 "",解码当场失败,不发请求。
 * (图卡在在线的预览里不挂,常驻「需要本地 PC 渲染辅助」;这里管的是其余会走到这条路的调用。)
 */
function cardMediaUrl(url: string): string {
  const p = mediaTierPolicy();
  if (!p.online) return url;
  return p.remote ? remoteMediaUrl(url, p.remote) : "";
}

/** A decoder belongs to one card canvas. Seeking it never touches a timeline
 * media element or another card's source cursor. GPU registration can therefore
 * sample video locally without a server round trip or per-frame PNG transfer. */
export class CardMediaSource {
  private sources = new Map<string, Promise<HTMLVideoElement | HTMLImageElement>>();
  private disposed = false;
  async frame(media: { url: string; kind?: string; type?: string; duration?: number }, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
    if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!this.sources.has(media.url)) {
      const image = media.kind === 'image' || media.type?.startsWith('image') || /\.(png|jpg|jpeg|webp|gif|svg)(?:[?#]|$)/i.test(media.url);
      const source = image ? new Image() : document.createElement('video');
      if (source instanceof HTMLVideoElement) { source.muted = true; source.preload = 'auto'; source.playsInline = true; }
      const ready = new Promise<HTMLVideoElement | HTMLImageElement>((resolve, reject) => {
        const event = image ? 'load' : 'loadeddata';
        source.addEventListener(event, () => resolve(source), { once: true });
        source.addEventListener('error', () => reject(new Error('Card media could not be decoded: ' + media.url)), { once: true });
        const src = cardMediaUrl(media.url);
        if (!src) { reject(new Error('Card media is not reachable yet: ' + media.url)); return; }
        source.src = src;
      });
      this.sources.set(media.url, ready);
    }
    const source = await this.sources.get(media.url)!;
    if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (source instanceof HTMLVideoElement) {
      const target = Math.max(0, Math.min(Number.isFinite(source.duration) ? Math.max(0, source.duration - .0001) : time, time));
      if (Math.abs(source.currentTime - target) > .00001) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { source.removeEventListener('seeked', done); source.removeEventListener('error', failed); signal?.removeEventListener('abort', cancelled); };
        const done = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Card video seek failed')); };
        const cancelled = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
        source.addEventListener('seeked', done, { once: true }); source.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', cancelled, { once: true });
        source.currentTime = target;
      });
    }
    return createImageBitmap(source, { premultiplyAlpha: 'none' });
  }
  dispose() {
    this.disposed = true;
    for (const promise of this.sources.values()) void promise.then(source => {
      if (source instanceof HTMLVideoElement) source.pause(); source.removeAttribute('src');
      if (source instanceof HTMLVideoElement) source.load();
    }, () => {});
    this.sources.clear();
  }
}
