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
/**
 * 一个节点在父坐标系里的框。
 *
 * 卡片级的父坐标系就是舞台(原点左上角、单位像素),所以卡片的 frame 既是「组内相对」
 * 也是「画面绝对」。将来部件级的 frame 相对的是所在卡片的框,画面绝对位置由
 * kernel/layout.ts 逐级合成出来、**从不落盘** —— 只存一种坐标,另一种永远推导,
 * 两边才不会漂。
 *
 * 位置指的是**锚点**所在的位置,不是左上角:anchor [0.5,0.5] + x,y = 960,540 就是居中。
 * 缩放和旋转也绕锚点。没有 frame = 铺满父坐标系(向后兼容,老项目一个字节不变)。
 */
export interface ClipFrame {
  /** 锚点所在的父坐标系位置(像素) */
  x: number;
  y: number;
  /** 框的尺寸(像素)。省略 = 父坐标系的尺寸。注意这是卡片的**画布**,大多数卡按 1920×1080 设计,
   *  缩小画布不等于缩小内容 —— 要整体缩小用 scale */
  w?: number;
  h?: number;
  /** x,y 定位的是框内哪个点:[0,0] 左上、[0.5,0.5] 中心、[1,1] 右下。默认 [0,0] */
  anchor?: [number, number];
  /** 默认 1,绕锚点 */
  scale?: number;
  /** 度,顺时针,默认 0,绕锚点 */
  rotate?: number;
}

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
  /** 卡片在舞台上的框(位置/尺寸/锚点/缩放/旋转)。没有就铺满舞台。见 ClipFrame */
  frame?: ClipFrame;
  /**
   * 淡入 / 淡出时长(秒)。两段素材在时间上重叠、各自带上淡出淡入,就是交叉溶解——
   * 转场不是独立的对象,而是「重叠 + 淡化」的结果,所以不用往模型里塞 transition 类型。
   * 同一条序列内不允许重叠,所以交叉溶解必然发生在两条序列之间。
   * 卡片 clip 也吃这三个字段(Stage 按 cardOpacityAt 算),以前只有视频层吃。
   */
  fadeIn?: number;
  fadeOut?: number;
  /** 整体不透明度(0-1,默认 1)。音频段用它当音量。 */
  opacity?: number;
}

export interface Timeline {
  width: number;
  height: number;
  fps: number;
  duration: number; // 秒
  clips: Clip[];
}
