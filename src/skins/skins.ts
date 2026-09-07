import { palettes, semantic, type Palette, type PaletteSide } from "./palettes";

/**
 * 窗口皮肤 = 一组 --ui-* 变量,运行时由 useSkin 写到 <html> 上;skins.css 只负责把界面的
 * 工具类和组件类名映射到这些变量。主题库的十套(五套调色板 × 深/浅)由 palettes.ts 生成,
 * 「更多」组里是几套不在设计稿里的额外皮肤。
 */
export type SkinMode = "dark" | "light";

export interface Skin {
  id: string;
  name: string;
  /** 分组:主题库 / 更多 */
  group: string;
  mode: SkinMode;
  description: string;
  vars: Record<string, string>;
}

const mix = (a: string, b: string, pa: number) => `color-mix(in oklab, ${a} ${pa}%, ${b})`;

/** #rrggbb 的相对亮度(WCAG),只用来给片段挑黑字还是白字 */
function relLuminance(hex: string): number {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** 在 sRGB 里把 a 按 pa% 的比例混向 b,返回 #rrggbb */
function mixHex(a: string, b: string, pa: number): string {
  const rgb = (h: string) => {
    const n = parseInt(/^#?([\da-f]{6})$/i.exec(h.trim())![1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [ra, ga, ba] = rgb(a);
  const [rb, gb, bb] = rgb(b);
  const k = pa / 100;
  const ch = [ra * k + rb * (1 - k), ga * k + gb * (1 - k), ba * k + bb * (1 - k)];
  return "#" + ch.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

const contrast = (l1: number, l2: number) =>
  (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/**
 * 片段上的字用什么颜色。
 *
 * 不能按深浅皮肤一刀切:深色皮肤的轨道色是亮色系(黑字更清楚),浅色皮肤的多是
 * 深色系(白字更清楚),但浅色的琥珀 #A5762A 偏亮,又反过来要黑字。所以逐个色算。
 *
 * 片段底色是渐变(顶 8% 提亮、底 12% 压暗),两端对比度不一样,所以取两端里较差的
 * 那个来判定;先试带一点色相的浓字(好看),不够 4.5:1 就一路退到纯黑 / 纯白。
 */
function trackInk(track: string): string {
  const ends = [mixHex(track, "#ffffff", 92), mixHex(track, "#000000", 88)].map(relLuminance);
  const worst = (ink: string) => {
    const li = relLuminance(ink);
    return Math.min(...ends.map((le) => contrast(le, li)));
  };
  const toward = worst("#000000") >= worst("#ffffff") ? "#000000" : "#ffffff";
  for (const amount of [22, 14, 7]) {
    const candidate = mixHex(track, toward, amount);
    if (worst(candidate) >= 4.5) return candidate;
  }
  return toward;
}

function sideToVars(side: PaletteSide, mode: SkinMode): Record<string, string> {
  const [l0, l1, l2, l3, l4] = side.surfaces;
  const dark = mode === "dark";
  const sem = semantic[mode];
  // 设计稿单独标了值的主题(钢蓝·深)直接用,其余照旧由表面推导
  const borderStrong = side.borderStrong ?? side.border ?? mix(l4, side.fg, 84);
  const border = side.hairline ?? (dark ? mix(l3, l4, 45) : mix(borderStrong, "#ffffff", 55));
  return {
    "ui-bg": l0,
    "ui-bg-2": l1,
    "ui-panel": l2,
    "ui-panel-2": l3,
    "ui-float": l4,
    "ui-border": border,
    "ui-border-strong": borderStrong,
    "ui-fg": side.fg,
    "ui-fg-muted": side.fgMuted,
    "ui-fg-faint": side.fgFaint ?? mix(side.fgMuted, l1, 62),
    "ui-accent": side.accent,
    // 悬停往哪边混要看强调色本身的明度。原来一律往白里混,那是按「深色主题的
    // 强调色总是中等饱和」写的;换成淡色强调(比如浅青)之后,再往白里混就几乎
    // 看不出变化,按钮悬停等于没反应。淡色就反过来往黑里混。
    "ui-accent-hover": relLuminance(side.accent) > 0.55
      ? mix(side.accent, "#000000", 88)
      : mix(side.accent, "#ffffff", dark ? 82 : 78),
    "ui-accent-press": relLuminance(side.accent) > 0.55
      ? mix(side.accent, "#000000", 76)
      : mix(side.accent, "#000000", dark ? 78 : 74),
    "ui-accent-fg": dark ? l0 : "#ffffff",
    "ui-accent-soft": dark ? mix(side.accent, l1, 24) : mix(side.accent, "#ffffff", 14),
    "ui-danger": sem.danger,
    "ui-warn": sem.warn,
    "ui-success": sem.success,
    "ui-info": side.accent,
    "ui-track-video": side.tracks.video,
    "ui-track-audio": side.tracks.audio,
    "ui-track-image": side.tracks.image,
    "ui-track-text": side.tracks.text,
    "ui-track-fx": side.tracks.fx,
    "ui-track-transition": side.tracks.transition,
    "ui-track-sticker": side.tracks.sticker,
    "ui-track-ink-video": trackInk(side.tracks.video),
    "ui-track-ink-audio": trackInk(side.tracks.audio),
    "ui-track-ink-image": trackInk(side.tracks.image),
    "ui-track-ink-text": trackInk(side.tracks.text),
    "ui-track-ink-fx": trackInk(side.tracks.fx),
    "ui-track-ink-transition": trackInk(side.tracks.transition),
    "ui-track-ink-sticker": trackInk(side.tracks.sticker),
    "ui-radius": "4px",
    "ui-shadow": dark ? "0 6px 18px rgba(0, 0, 0, 0.45)" : "0 8px 24px rgba(20, 22, 24, 0.14)",
    "ui-glow": `0 0 10px ${mix(side.accent, "transparent", 45)}`,
    "ui-font": "ui-sans-serif, system-ui, sans-serif",
    "ui-font-mono": "ui-monospace, SFMono-Regular, monospace",
    "ui-backdrop": dark ? mix(l0, "transparent", 72) : "rgba(20, 22, 24, 0.35)",
    "ui-scroll-thumb": borderStrong,
    "ui-scroll-thumb-hover": side.fgMuted,
  };
}

function paletteSkins(p: Palette): Skin[] {
  return [
    { id: `${p.id}-dark`, name: `${p.name} · 深 (${p.en})`, group: "主题库", mode: "dark", description: p.blurb, vars: sideToVars(p.dark, "dark") },
    { id: `${p.id}-light`, name: `${p.name} · 浅 (${p.en})`, group: "主题库", mode: "light", description: p.blurb, vars: sideToVars(p.light, "light") },
  ];
}

/** 额外皮肤:只给基础变量,其余(悬浮层、强调色状态、语义色、轨道色)按钢蓝深色补齐 */
function extra(id: string, name: string, description: string, vars: Record<string, string>): Skin {
  const base = sideToVars(palettes[0].dark, "dark");
  return { id, name, group: "更多", mode: "dark", description, vars: { ...base, ...vars } };
}

export const skins: Skin[] = [
  ...palettes.flatMap(paletteSkins),
  extra("aurora", "极光 (Aurora)", "深海军蓝底,青绿主色", {
    "ui-bg": "#070b14", "ui-bg-2": "#0c1220", "ui-panel": "#121b2d", "ui-panel-2": "#1a263c", "ui-float": "#22304a",
    "ui-border": "#283854", "ui-border-strong": "#3d557f", "ui-fg": "#e2ebf8", "ui-fg-muted": "#8da4c8", "ui-fg-faint": "#56719b",
    "ui-accent": "#14b8a6", "ui-accent-hover": "#2fd0bd", "ui-accent-press": "#0f9384", "ui-accent-fg": "#031311", "ui-accent-soft": "rgba(20, 184, 166, 0.2)",
    "ui-info": "#14b8a6", "ui-radius": "6px", "ui-glow": "0 0 12px rgba(20, 184, 166, 0.6)", "ui-backdrop": "rgba(7, 11, 20, 0.7)",
    "ui-scroll-thumb": "#283854", "ui-scroll-thumb-hover": "#3d557f",
  }),
  extra("amber", "琥珀 (Amber)", "暖黑底,橙金主色", {
    "ui-bg": "#1e1510", "ui-bg-2": "#251a14", "ui-panel": "#2a1e16", "ui-panel-2": "#3a2a1f", "ui-float": "#46342a",
    "ui-border": "#543c2c", "ui-border-strong": "#785640", "ui-fg": "#fdf8f4", "ui-fg-muted": "#bba291", "ui-fg-faint": "#7a6659",
    "ui-accent": "#f59e0b", "ui-accent-hover": "#fbbf3f", "ui-accent-press": "#c47f08", "ui-accent-fg": "#1a1613", "ui-accent-soft": "rgba(245, 158, 11, 0.2)",
    "ui-info": "#f59e0b", "ui-glow": "0 0 8px rgba(245, 158, 11, 0.5)", "ui-backdrop": "rgba(18, 15, 13, 0.7)",
    "ui-scroll-thumb": "#543c2c", "ui-scroll-thumb-hover": "#785640",
  }),
  extra("neon", "霓虹 (Neon)", "近黑底,高对比强辉光", {
    "ui-bg": "#08080a", "ui-bg-2": "#0f0f14", "ui-panel": "#171720", "ui-panel-2": "#222230", "ui-float": "#2b2b3c",
    "ui-border": "#3a123e", "ui-border-strong": "#631d68", "ui-fg": "#ffffff", "ui-fg-muted": "#9e9eb8", "ui-fg-faint": "#5a5a75",
    "ui-accent": "#ec4899", "ui-accent-hover": "#f472b6", "ui-accent-press": "#be2f78", "ui-accent-fg": "#08080a", "ui-accent-soft": "rgba(236, 72, 153, 0.2)",
    "ui-info": "#ec4899", "ui-radius": "0px", "ui-shadow": "0 4px 16px rgba(0, 0, 0, 0.8)", "ui-glow": "0 0 16px rgba(236, 72, 153, 0.8)",
    "ui-backdrop": "rgba(8, 8, 10, 0.8)", "ui-scroll-thumb": "#3a123e", "ui-scroll-thumb-hover": "#ec4899",
  }),
];

export const DEFAULT_SKIN = "indigo-dark";

export function getSkin(id: string): Skin {
  return skins.find((s) => s.id === id) ?? skins[0];
}

/** 皮肤分组,给选择器的 optgroup 用 */
export function skinGroups(): { group: string; items: Skin[] }[] {
  const out: { group: string; items: Skin[] }[] = [];
  for (const s of skins) {
    let g = out.find((x) => x.group === s.group);
    if (!g) out.push((g = { group: s.group, items: [] }));
    g.items.push(s);
  }
  return out;
}
