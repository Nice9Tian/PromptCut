import type { ComponentType } from "react";

/** 参数面板控件描述。原型阶段只支持这几种。 */
export type Control =
  | { key: string; label: string; type: "text" }
  | { key: string; label: string; type: "number"; min?: number; max?: number; step?: number }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[] }
  | { key: string; label: string; type: "color" };

export interface CardProps<P> {
  params: P;
  /** 每次重播 +1。卡片组件用 key={playToken} 挂载,所以组件内部不需要读它;保留给需要手动重置的卡。 */
  playToken: number;
}

/** 卡片契约。所有卡片(自家写的、Magic UI 适配的)都长这样。 */
export interface CardDef<P = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  /** 来源标签,给面板分组:"magicui" | "native" */
  source: "magicui" | "native";
  defaults: P;
  controls: Control[];
  Component: ComponentType<CardProps<P>>;
}

/** 时间轴上的一张卡 */
export interface Clip {
  id: string;
  cardId: string;
  start: number; // 秒
  end: number; // 秒
  params: Record<string, unknown>;
}

export interface Timeline {
  width: number;
  height: number;
  fps: number;
  duration: number; // 秒
  clips: Clip[];
}
