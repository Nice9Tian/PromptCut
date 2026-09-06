/**
 * 左栏:上半「素材」(卡片库 + 导入的媒体,可拖到时间轴),下半「编辑」(选中 clip 的参数:常规表单 / 代码 JSON)。
 * 【占位实现,左栏任务负责填充。对外只暴露 LeftPanel 一个组件,不要改这个导出名。】
 *
 * 拖放契约(和时间轴约定):
 *   拖卡片:e.dataTransfer.setData("application/x-promptcut-card", cardId)
 *   拖媒体:e.dataTransfer.setData("application/x-promptcut-media", mediaId)
 *   时间轴在 drop 时按类型调 actions.addCardClip / actions.addMediaClip。
 */
export function LeftPanel() {
  return (
    <div className="h-full flex flex-col text-sm text-neutral-400">
      <div className="p-3 border-b border-neutral-800">素材(待实现)</div>
      <div className="p-3">编辑(待实现)</div>
    </div>
  );
}
