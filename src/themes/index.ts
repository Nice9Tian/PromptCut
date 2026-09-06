/**
 * 主题。每套主题是一组 CSS 变量,挂在舞台根元素(.pc-stage)和编辑器根元素上。
 * 卡片只读变量、不写死颜色:
 *   --pc-accent        主色
 *   --pc-fg            前景文字
 *   --pc-fg-muted      次级文字
 *   --pc-fg-faint      更弱的文字/分隔线
 *   --pc-glass-bg      玻璃底(带透明度的颜色)
 *   --pc-glass-border  玻璃边线
 *   --pc-glass-blur    backdrop-filter 模糊量,如 "16px"
 *   --pc-radius        卡片圆角
 *   --pc-font          标题字体栈
 *   --pc-font-mono     等宽字体栈
 *   --pc-shadow        卡片投影
 * 【占位实现,主题任务负责填充】
 */
export interface Theme {
  id: string;
  name: string;
  description: string;
  /** 变量名 → 值,不带 "--pc-" 前缀 */
  vars: Record<string, string>;
}

export const themes: Theme[] = [
  {
    id: "midnight",
    name: "午夜",
    description: "深色玻璃底,冷蓝主色",
    vars: {
      accent: "#4f8cff",
      fg: "#f5f7fa",
      "fg-muted": "rgba(245,247,250,0.72)",
      "fg-faint": "rgba(245,247,250,0.38)",
      "glass-bg": "rgba(12,14,20,0.58)",
      "glass-border": "rgba(255,255,255,0.12)",
      "glass-blur": "16px",
      radius: "20px",
      font: '"Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      "font-mono": '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
      shadow: "0 24px 60px rgba(0,0,0,0.45)",
    },
  },
];

export function getTheme(id: string): Theme {
  return themes.find((t) => t.id === id) ?? themes[0];
}

/** 转成 style 对象,挂到任意元素上 */
export function themeStyle(id: string): Record<string, string> {
  const t = getTheme(id);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.vars)) out[`--pc-${k}`] = v;
  return out;
}
