import type { Control } from "../../kernel/types";

export interface HudParams {
  theme: "dark" | "light";
  position: "center" | "bottom" | "left" | "right";
  accent: string;
}

export const hudControls: Control[] = [
  {
    key: "theme",
    label: "主题",
    type: "select",
    options: [
      { value: "dark", label: "深色" },
      { value: "light", label: "浅色" },
    ],
  },
  {
    key: "position",
    label: "位置",
    type: "select",
    options: [
      { value: "center", label: "居中" },
      { value: "bottom", label: "底部" },
      { value: "left", label: "靠左" },
      { value: "right", label: "靠右" },
    ],
  },
  { key: "accent", label: "主色", type: "color" },
];

export const hudDefaults: HudParams = {
  theme: "dark",
  position: "center",
  accent: "#4f8cff",
};

export const easeExpoOut: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function getPositionClass(position: string) {
  switch (position) {
    case "bottom":
      return "hud-pos-bottom";
    case "left":
      return "hud-pos-left";
    case "right":
      return "hud-pos-right";
    case "center":
    default:
      return "hud-pos-center";
  }
}
