import { useTimelineContext } from "./TimelineContext";
import { useStore, actions } from "../../store/project";

export function Ruler() {
  const { pxPerSec } = useTimelineContext();
  const duration = useStore((s) => Math.max(s.project.duration, s.t + 10));

  const ticks = [];
  // dynamically choose tick interval based on pxPerSec
  let step = 1;
  if (pxPerSec < 20) step = 5;
  if (pxPerSec < 10) step = 10;
  if (pxPerSec > 200) step = 0.5;
  if (pxPerSec > 400) step = 0.1;

  for (let i = 0; i <= duration; i += step) {
    ticks.push(i);
  }

  const handleClick = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    actions.seek(Math.max(0, x / pxPerSec));
  };

  return (
    <div className="relative h-8 bg-neutral-900 border-b border-neutral-800 cursor-pointer overflow-hidden select-none" onClick={handleClick}>
      {ticks.map((tick) => {
        const isMajor = tick % Math.max(1, step * 5) === 0 || tick === 0;
        return (
          <div
            key={tick}
            className="absolute top-0 flex flex-col items-center"
            style={{ left: `${tick * pxPerSec}px`, transform: "translateX(-50%)" }}
          >
            <div className={`w-[1px] bg-neutral-600 ${isMajor ? "h-3" : "h-2"}`} />
            {isMajor && <span className="text-[10px] text-neutral-400 mt-1">{tick}s</span>}
          </div>
        );
      })}
    </div>
  );
}
