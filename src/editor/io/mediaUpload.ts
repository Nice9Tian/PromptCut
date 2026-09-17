import { actions, getState } from "../../store/project";

/**
 * 导入 = 先入库再引用(A1)。
 *
 * **为什么不在页面里算哈希**:素材键是文件内容的 sha256,4 GB 的视频在主线程上读一遍
 * 就是几秒的长任务,连 Worker 里读也要把整份字节搬进页面内存。这里改成把 File 直接
 * 交给 fetch 当 body —— 浏览器从磁盘流式发出去,页面一份字节都不持有;服务端
 * (server/vite-plugin-media.ts 的 storeMediaStream)边落盘边 update sha256,同样是
 * 常数内存、没有长任务。算完回一个 `<hash>`,素材地址就是 /@media/<hash>。
 * 于是主线程和 dev server 的事件循环在整个导入期间都是空的,时间轴照常能编辑。
 *
 * 上传期间素材先挂 `pending: true`、`url: ""`:素材层画「上传中」占位,
 * 不会再出现一个渲染进程 / 导出进程够不着的 blob: 地址。
 */

export interface UploadedMedia {
  hash: string;
  ext: string;
  name: string;
  /** 本地内容库里的绝对路径(迁移期的老代码还在看它) */
  path?: string;
  /** /@media/<hash> */
  url: string;
  bytes: number;
  /** 库里本来就有同样内容 */
  deduped?: boolean;
}

/** 把一个 File 流进本地内容库,拿回它的内容哈希。失败给 null(调用方负责提示) */
export async function uploadMediaFile(file: File): Promise<UploadedMedia | null> {
  try {
    const res = await fetch(`/api/media/upload/${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    if (!res.ok) {
      console.warn(`[io] 上传素材失败(HTTP ${res.status}): ${file.name}`);
      return null;
    }
    const data = await res.json();
    if (!data?.ok || typeof data.hash !== "string") {
      console.warn(`[io] 上传素材没拿到内容哈希: ${file.name}`);
      return null;
    }
    return {
      hash: data.hash,
      ext: String(data.ext || ""),
      name: String(data.name || file.name),
      path: typeof data.path === "string" ? data.path : undefined,
      url: String(data.url || `/@media/${data.hash}`),
      bytes: Number(data.bytes) || file.size,
      deduped: !!data.deduped,
    };
  } catch (err) {
    console.warn(`[io] 上传素材异常: ${file.name}`, err);
    return null;
  }
}

/**
 * 给一个**已经在服务端素材目录里**的文件补算内容键(素材收集下载好的那种)。
 *
 * 不上传 —— 文件本来就在服务端,几百 MB 再往回传一遍纯属浪费;服务端就地流式
 * 算 sha256 并把它挂进内容库(见 vite-plugin-media.ts 的 adoptMediaFile)。
 * 失败给 null,那条素材就按没有 hash 的迁移期素材走(仍然能按文件名播)。
 */
export async function adoptServerMedia(filePath: string): Promise<UploadedMedia | null> {
  try {
    const res = await fetch(`/api/media/adopt?path=${encodeURIComponent(filePath)}`, { method: "POST" });
    if (!res.ok) {
      console.warn(`[io] 补算素材哈希失败(HTTP ${res.status}): ${filePath}`);
      return null;
    }
    const data = await res.json();
    if (!data?.ok || typeof data.hash !== "string") return null;
    return {
      hash: data.hash,
      ext: String(data.ext || ""),
      name: String(data.name || ""),
      path: typeof data.path === "string" ? data.path : filePath,
      url: String(data.url || `/@media/${data.hash}`),
      bytes: Number(data.bytes) || 0,
      deduped: !!data.deduped,
    };
  } catch (err) {
    console.warn(`[io] 补算素材哈希异常: ${filePath}`, err);
    return null;
  }
}

/**
 * 入库结果写回素材表。
 *
 * store 里没有「改一条素材的任意字段」这种动作,而现在能改素材又不进撤销栈的只有
 * setMediaPath(撤销管的是时间轴,不该把「素材传完了」这件事也收进去)。所以这里
 * 先就地写进那条记录,再用 setMediaPath 把整张表重新发一遍(它会 `{...m, path}`
 * 拷一份新对象,刚写的字段一起带上),订阅方照常收到通知。
 *
 * 传失败时不退回 blob: —— 那种地址渲染进程和导出进程都打不开,留着只会在更远的
 * 地方炸(见 importAssets.ts 的说明)。素材留空地址、pending 落回 false,
 * 素材层就是透明的,用户重新导入即可。
 */
export function applyUploadedMedia(mediaId: string, up: UploadedMedia | null): void {
  const media = getState().project.media.find((m) => m.id === mediaId);
  if (!media) return;
  if (up) {
    media.url = up.url;
    media.hash = up.hash;
    media.ext = up.ext || undefined;
    media.size = up.bytes || undefined;
  }
  media.pending = undefined;
  actions.setMediaPath(mediaId, up?.path ?? media.path ?? "");
}
