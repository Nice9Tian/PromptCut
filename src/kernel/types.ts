import type { ComponentType } from "react";

/**
 * 控件的公共字段。
 * `required` 是给「没有它这张卡就没有意义」的参数用的(例如字幕轨的 lines):
 * 建卡和改参数时会校验,缺了直接报错,而不是悄悄用默认值把演示内容播出去。
 * `hint` 写给人也写给 AI —— 它会出现在 list_cards 的返回里。
 */
interface ControlBase {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
}

/** 参数面板控件描述。原型阶段只支持这几种。 */
export type Control =
  | (ControlBase & { type: "text" })
  | (ControlBase & { type: "number"; min?: number; max?: number; step?: number })
  | (ControlBase & { type: "select"; options: { value: string; label: string }[] })
  | (ControlBase & { type: "color" });

export interface CardProps<P> {
  params: P;
  /** 每次重播 +1。卡片组件用 key={playToken} 挂载,所以组件内部不需要读它;保留给需要手动重置的卡。 */
  playToken: number;
  /**
   * 自 clip 起点起的秒数(舞台每帧传入)。绝大多数卡不需要它(挂载即播);
   * 只有「跟着时间轴走」的卡(章节导航、字幕轨、口播视频 seek)才读它。
   */
  t?: number;
  /** clip 总时长(秒) */
  duration?: number;
}

/** 卡片契约。所有卡片(自家写的、Magic UI 适配的、AI 现场建的)都长这样。 */
export interface CardDef<P = Record<string, unknown>> {
  id: string;
  name: string;
  /** 一句话说清这张卡长什么样、播什么动效 */
  description: string;
  /** 来源标签,给面板分组。`user` 是 AI 或用户后来建的,存在 src/cards/user/ */
  source: "magicui" | "native" | "user";
  /**
   * 什么时候该选这张卡 —— 写给 AI 看的选卡依据,而不是描述外观。
   * 例:"口播里出现带单位的数字(3 倍、80%)时用它把数字放大成主视觉"。
   * list_cards 的摘要里会带上它,AI 靠它一次扫完所有卡就能选,不用挨个看参数。
   */
  useWhen?: string;
  /** 检索用的关键词,和 useWhen 配合让 list_cards 能按内容筛 */
  tags?: string[];
  defaults: P;
  controls: Control[];
  Component: ComponentType<CardProps<P>>;
}

/**
 * 让一张卡跟着画面里的目标走。
 *
 * 存的是**位移**而不是绝对位置：舞台按 `xy[f] - xy[anchor]` 平移整个 clip 层，
 * 所以卡片仍然待在设计时摆的地方，只是跟着目标一起挪。这样就不需要知道卡片
 * 在它那一层里把自己画在了哪儿 —— 那是卡片组件内部的事，外面看不见。
 *
 * 坐标是**舞台像素**，写入时就从素材原始像素换算好了。之所以在写入时换算而不是
 * 播放时换算：素材以后可能被替换或改分辨率，那时这条轨迹本来就该重新追，
 * 留着换算参数只会让人以为它还准。
 */
export interface ClipMotion {
  /** 轨迹来自哪段素材、哪一个查询点。只用于说明来源，播放时用不到 */
  mediaId: string;
  pointIndex: number;
  /** 逐帧位移（舞台像素），已经减掉锚点。第 0 项必为 [0, 0] */
  offsets: [number, number][];
  /** 每帧目标是否可见。跟丢的帧按 whenHidden 处理 */
  visible: boolean[];
  /** 轨迹每帧对应的时间步长（秒）。素材帧率和项目帧率不一定一样 */
  frameStep: number;
  /**
   * 目标不可见时怎么办。
   * hold = 停在最后一次看见的位置（短暂遮挡时最不打眼）；
   * hide = 整张卡不渲染（目标真的走了、卡片指着空气时用这个）。
   */
  whenHidden: "hold" | "hide";
}

/** 时间轴上的一张卡 */
export interface Clip {
  id: string;
  cardId: string;
  start: number; // 秒
  end: number; // 秒
  params: Record<string, unknown>;
  /** 绑定到一条运动轨迹。没绑就是 undefined，卡片位置固定 */
  motion?: ClipMotion;
}

export interface Timeline {
  width: number;
  height: number;
  fps: number;
  duration: number; // 秒
  clips: Clip[];
}
