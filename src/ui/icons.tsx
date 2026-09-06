import type { SVGProps } from "react";

/**
 * 按钮图标(设计稿「工具栏组件表」第 04 节)。
 * 统一规格:24 画幅、18px 显示、1.5 描边、方头端点、fill 走 none;颜色一律 currentColor,
 * 由按钮的文字色决定(常态次文字、悬浮主文字、主按钮跟随按钮前景)。
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Stroked({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 播放:唯一的实心图标 */
export function IconPlay({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <path d="M7 4l13 8-13 8z" />
    </svg>
  );
}

/** 暂停:设计稿没给,按播放的实心规格补一个(播放/暂停是同一个按钮的两态) */
export function IconPause({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <path d="M8 5h3v14H8z" />
      <path d="M13 5h3v14h-3z" />
    </svg>
  );
}

export function IconReplay(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M11 9l4 3-4 3z" />
    </Stroked>
  );
}

export function IconUndo(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
    </Stroked>
  );
}

export function IconRedo(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9a5 5 0 0 0 0 10h4" />
    </Stroked>
  );
}

export function IconImport(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 3v10" />
      <path d="M8 9l4 4 4-4" />
      <path d="M4 16v4h16v-4" />
    </Stroked>
  );
}

export function IconOpen(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M3 8V5h6l2 2h8v3" />
      <path d="M3 8h18l-2 11H5z" />
    </Stroked>
  );
}

export function IconSave(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M8 4v5h7V4" />
      <path d="M8 14h8" />
    </Stroked>
  );
}

export function IconExport(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 20V9" />
      <path d="M8 13l4-4 4 4" />
      <path d="M4 4h16" />
    </Stroked>
  );
}

export function IconNewChat(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M4 5h16v11H9l-5 4z" />
      <path d="M12 8v5" />
      <path d="M9.5 10.5h5" />
    </Stroked>
  );
}

export function IconClock(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </Stroked>
  );
}
