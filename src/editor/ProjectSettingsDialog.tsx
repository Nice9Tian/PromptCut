import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actions, useStore } from "../store/project";

export interface ProjectSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type AspectRatio = "16:9" | "4:3";
type Orientation = "horizontal" | "vertical";

const RESOLUTION_MAP: Record<AspectRatio, Record<Orientation, { width: number; height: number }>> = {
  "16:9": {
    horizontal: { width: 1920, height: 1080 },
    vertical: { width: 1080, height: 1920 },
  },
  "4:3": {
    horizontal: { width: 1440, height: 1080 },
    vertical: { width: 1080, height: 1440 },
  },
};

/** 根据当前画幅尺寸反推比例与方向,推导失败默认 16:9 横版 */
function inferSettings(w: number, h: number): { ratio: AspectRatio; orientation: Orientation } {
  if (w === 1920 && h === 1080) return { ratio: "16:9", orientation: "horizontal" };
  if (w === 1080 && h === 1920) return { ratio: "16:9", orientation: "vertical" };
  if (w === 1440 && h === 1080) return { ratio: "4:3", orientation: "horizontal" };
  if (w === 1080 && h === 1440) return { ratio: "4:3", orientation: "vertical" };
  if (w > 0 && h > 0) {
    const isHorizontal = w >= h;
    const r = isHorizontal ? w / h : h / w;
    if (Math.abs(r - 16 / 9) < 0.05) {
      return { ratio: "16:9", orientation: isHorizontal ? "horizontal" : "vertical" };
    }
    if (Math.abs(r - 4 / 3) < 0.05) {
      return { ratio: "4:3", orientation: isHorizontal ? "horizontal" : "vertical" };
    }
  }
  return { ratio: "16:9", orientation: "horizontal" };
}

/**
 * 项目设置对话框:配置视频画幅比例与方向,实时预览分辨率。
 */
export function ProjectSettingsDialog({ open, onClose }: ProjectSettingsDialogProps) {
  const curW = useStore((s) => s.project.width);
  const curH = useStore((s) => s.project.height);

  const [ratio, setRatio] = useState<AspectRatio>("16:9");
  const [orientation, setOrientation] = useState<Orientation>("horizontal");

  const currentRes = RESOLUTION_MAP[ratio][orientation];

  const handleConfirm = () => {
    actions.setProjectMeta({ width: currentRes.width, height: currentRes.height });
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  const confirmRef = useRef(handleConfirm);
  const cancelRef = useRef(handleCancel);

  // 照 ConfirmDialog.tsx 的做法:在无依赖的 useEffect 里同步 ref,不在 render 期间产生副作用
  useEffect(() => {
    confirmRef.current = handleConfirm;
    cancelRef.current = handleCancel;
  });

  useEffect(() => {
    if (open) {
      const initial = inferSettings(curW, curH);
      setRatio(initial.ratio);
      setOrientation(initial.orientation);
    }
  }, [open, curW, curH]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirmRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="pc-dialog-mask" onClick={handleCancel}>
      <div
        className="pc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-dialog-title-settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="pc-dialog-title-settings" className="pc-dialog-title">
          项目设置
        </div>
        <div className="pc-dialog-body">
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">画幅比例</span>
            <div className="pc-dialog-options">
              <button
                type="button"
                className={`pc-dialog-opt${ratio === "16:9" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setRatio("16:9")}
              >
                16:9
              </button>
              <button
                type="button"
                className={`pc-dialog-opt${ratio === "4:3" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setRatio("4:3")}
              >
                4:3
              </button>
            </div>
          </div>
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">画幅方向</span>
            <div className="pc-dialog-options">
              <button
                type="button"
                className={`pc-dialog-opt${orientation === "horizontal" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setOrientation("horizontal")}
              >
                横版
              </button>
              <button
                type="button"
                className={`pc-dialog-opt${orientation === "vertical" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setOrientation("vertical")}
              >
                竖版
              </button>
            </div>
          </div>
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">应用分辨率</span>
            <span className="pc-dialog-res">
              {currentRes.width} × {currentRes.height}
            </span>
          </div>
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-btn" onClick={handleCancel}>
            取消
          </button>
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            onClick={handleConfirm}
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
