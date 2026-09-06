/**
 * 底部时间轴:多轨、clip 拖动/缩放/跨轨、播放头、吸附、右键菜单、接收左栏拖来的卡片和媒体。
 * 【占位实现,时间轴任务负责填充。对外只暴露 TimelineView 一个组件,不要改这个导出名。】
 */
import { useStore, actions } from "../../store/project";

export function TimelineView() {
  const t = useStore((s) => s.t);
  const duration = useStore((s) => s.project.duration);
  const fps = useStore((s) => s.project.fps);
  return (
    <div className="h-full p-3 text-sm text-neutral-400 flex flex-col gap-2">
      <div>时间轴(待实现)</div>
      <input type="range" min={0} max={duration} step={1 / fps} value={t} onChange={(e) => actions.seek(Number(e.target.value))} />
    </div>
  );
}
