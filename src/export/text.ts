/**
 * 在线页面逐帧导出的文案(`docs/plan/c10a-contract.md` 第 14 节表 C,照抄)。
 * 「等待上传方」那一条沿用 C6.6(`src/render/mediaTier.ts` 的 `awaitingUploaderMessage`,带缺的素材名)。
 */
export const ONLINE_EXPORT_TEXT = {
  /** 导出：重卡缺预渲染原尺寸 */
  missingOriginals: (n: number) => `还有 ${n} 个重卡片段没有预渲染原尺寸，等渲染节点做完再导出。`,
  /** 导出：浏览器不支持这个尺寸的编码 */
  unsupportedSize: "这个浏览器不能导出这个尺寸的视频，请在电脑上的桌面版或浏览器里导出。",
  /** 导出：没有音频编码 */
  noAudio: "这台设备不能编码声音，导出的视频将没有声音。继续导出？",
  /** 导出：开始 */
  start: "导出期间请保持页面在前台、不要锁屏。",
  progress: (x: number, y: number) => `已导出 ${x}/${y} 帧`,
  done: "导出完成",
  cancelled: "导出已取消",
  failed: (reason: string) => `导出失败：${reason}`,
} as const;
