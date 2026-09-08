import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 左栏统一的方形预览卡:动效卡片、转场、视频、图像都长这样。
 *
 * 一张卡 = 正方形的画面区 + 压在底边的标题条 + (可选)贴着底边的强调色进度条。
 * 画面区放什么由调用方决定(`preview`),这里只负责壳:尺寸、悬停、拖拽、右键、
 * 标题、进度条、错误提示。悬停状态由这里维护并回传(`onHover`),视频要在悬停时
 * 才播、动效卡要在悬停时才起动画,都靠这一个信号。
 *
 * 样式在 left.css 的 .pc-pcard*。**不复用** `.cursor-grab.bg-neutral-900` 那套皮肤规则:
 * 它悬停时往卡片左边画一道 3px 的强调色内阴影,预览一铺满就成了漏进画面里的一条色边
 * (用户截图里那道瑕疵就是它),这里的悬停态只描边、不画内阴影。
 */
export interface PreviewCardProps {
  title: string;
  subtitle?: string;
  /** 画面区内容。null 时只显示标题和说明(动效卡不悬停时就是这样) */
  preview: ReactNode;
  /** 0..1,给底边画强调色进度条;null / undefined 不画 */
  progress?: number | null;
  /** 悬停延迟(毫秒):动效卡要等一下再起动画,免得鼠标扫过去就全体开演 */
  hoverDelayMs?: number;
  onHover?: (hot: boolean) => void;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  /** 一闪而过的错误提示(比如「没有动效轨」),非空就显示 */
  error?: string | null;
  /** 画面区下面再接一行(转场页的操作按钮) */
  footer?: ReactNode;
  /** 挂在根节点上的 data-* 之类,自动化测试靠它们定位 */
  attrs?: Record<string, string>;
  titleAttr?: string;
  /** 标题条什么时候显示:一直 / 只在悬停时(动效卡不悬停时名字已经写在画面区里) */
  caption?: "always" | "hover";
}

export function PreviewCard(props: PreviewCardProps) {
  const { title, subtitle, preview, progress, hoverDelayMs = 0, onHover, onClick, onContextMenu, draggable, onDragStart, onDragEnd, error, footer, attrs, titleAttr, caption = "always" } = props;
  const [hot, setHot] = useState(false);
  const timer = useRef<number | null>(null);
  const hotRef = useRef(false);

  const setHotBoth = (v: boolean) => {
    if (hotRef.current === v) return;
    hotRef.current = v;
    setHot(v);
    onHover?.(v);
  };

  const enter = () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (hoverDelayMs > 0) {
      timer.current = window.setTimeout(() => setHotBoth(true), hoverDelayMs);
    } else {
      setHotBoth(true);
    }
  };
  const leave = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHotBoth(false);
  };

  // 卸载时别留着定时器,也别让父级以为还悬停着
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const showCaption = caption === "always" || hot;
  const pct = typeof progress === "number" && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null;

  return (
    <div className="pc-pcard-wrap">
      <div
        {...attrs}
        className={`pc-pcard${hot ? " is-hot" : ""}${draggable ? " is-grab" : ""}`}
        draggable={draggable}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onDragStart={(e) => { leave(); onDragStart?.(e); }}
        onDragEnd={onDragEnd}
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={titleAttr}
      >
        <div className="pc-pcard-view">{preview}</div>
        {showCaption && (
          <div className="pc-pcard-cap">
            <div className="pc-pcard-title">{title}</div>
            {subtitle && <div className="pc-pcard-sub">{subtitle}</div>}
          </div>
        )}
        {pct !== null && (
          <div className="pc-pcard-bar" aria-hidden="true">
            <div className="pc-pcard-bar-fill" style={{ width: `${pct * 100}%` }} />
          </div>
        )}
        {error && <div className="pc-pcard-err">{error}</div>}
      </div>
      {footer}
    </div>
  );
}
