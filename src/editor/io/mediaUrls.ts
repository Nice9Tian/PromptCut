import type { MediaAsset } from "../../kernel/project";

/**
 * 素材地址在「存盘 → 再打开」之间怎么保持能播。
 *
 * 编辑器里刚导入的素材,url 是 URL.createObjectURL 出来的 blob: —— 只在当前这个页面活着,
 * 存进 .proc 之后再打开就是一个死地址。能跨会话找回文件的只有 path:导入时上传到服务端
 * 素材目录(见 index.ts 的 importVideoFiles / importVideoFromServer),按文件名走
 * /@media/<文件名> 就能取到。
 *
 * 以前只有旧格式导入 importProjectFile 做这步换算;.proc 改走 parseProc 之后这步被绕开,
 * 打开项目后 url 是一个裸文件名,<video> 拿到的是 index.html:预览里视频层是空的,
 * 导出页等不到视频就绪,导出卡在第 0 帧。所以两条路现在都调这里,只有一份规则。
 *
 * 这个文件不引任何运行时模块,单测可以直接加载(见 mediaUrls.test.mjs)。
 */

/** 服务端素材目录里这个文件的地址。没有 path 返回 null */
export function mediaUrlFromPath(path: string | undefined): string | null {
  const base = path ? path.split(/[/\\]/).pop() : "";
  return base ? `/@media/${encodeURIComponent(base)}` : null;
}

/** 不随页面失效的地址:网络地址、data:、同源绝对路径(/@media/...) */
function isDurable(url: string): boolean {
  return /^(https?:|data:)/.test(url) || url.startsWith("/");
}

const MISSING = "(缺失) ";

/**
 * 从文件里读回来的素材表 → 能播的素材表。不改入参。
 *
 * - 有 path:换成 /@media/<文件名>(和旧格式导入一样,path 优先);
 * - 没 path 但地址本来就能用:原样;
 * - 其余(死掉的 blob:、裸文件名):清空 url、名字前面标「(缺失)」,并记进 missing ——
 *   空 url 的素材预览和导出都会跳过,不会再拿一个打不开的地址去等。
 */
export function restoreMediaUrls(media: MediaAsset[]): { media: MediaAsset[]; missing: MediaAsset[] } {
  const missing: MediaAsset[] = [];
  const out = media.map((m) => {
    const fromPath = mediaUrlFromPath(m.path);
    if (fromPath) return { ...m, url: fromPath };
    const url = m.url || "";
    if (!url || isDurable(url)) return m;
    missing.push(m);
    return { ...m, url: "", name: m.name.startsWith(MISSING) ? m.name : `${MISSING}${m.name}` };
  });
  return { media: out, missing };
}
