/**
 * 导入 / 导出。
 * 【占位实现,导入导出任务负责填充。对外只暴露下面四个函数,不要改签名。】
 */
import type { Project } from "../../kernel/project";

/** 选一个或多个视频文件,登记成 MediaAsset(blob URL + 探测时长/宽高),并放到视频轨播放头处。返回登记的素材 id。 */
export async function importVideoFiles(_files: FileList | File[]): Promise<string[]> {
  throw new Error("importVideoFiles 待实现");
}

/** 读取 .promptcut.json(或兼容的 overlay 编排 JSON)并载入 store。返回 Project。 */
export async function importProjectFile(_file: File): Promise<Project> {
  throw new Error("importProjectFile 待实现");
}

/** 把当前项目序列化成 JSON 字符串(blob URL 换成相对路径) */
export function exportProjectJson(): string {
  throw new Error("exportProjectJson 待实现");
}

/**
 * 导出视频:把当前项目交给渲染内核(scripts/export-frames.mjs)逐帧渲染。
 * 浏览器里没法直接起 puppeteer,所以走 dev server 的 /api/export 接口(vite 插件,由本任务实现),
 * 返回一个进度回调可订阅的 job。
 */
export async function exportVideo(_opts: { onProgress?: (done: number, total: number) => void } = {}): Promise<{ outDir: string }> {
  throw new Error("exportVideo 待实现");
}
