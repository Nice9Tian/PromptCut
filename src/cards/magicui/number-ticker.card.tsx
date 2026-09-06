import type { CardDef, CardProps } from "../../kernel/types";
import { NumberTicker } from "./vendor/number-ticker";

interface Params {
  value: number;
  label: string;
  unit: string;
  accent: string;
}

function NumberTickerCard({ params }: CardProps<Params>) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-transparent">
      <div className="flex items-baseline gap-4" style={{ color: params.accent }}>
        <NumberTicker
          value={params.value}
          className="font-bold leading-none drop-shadow-lg"
          style={{ fontSize: 200 }}
          startImmediately={true}
        />
        <span className="font-bold drop-shadow-md" style={{ fontSize: 60 }}>{params.unit}</span>
      </div>
      <p className="mt-8 text-white drop-shadow-md" style={{ fontSize: 60 }}>{params.label}</p>
    </div>
  );
}

export const numberTickerCard: CardDef<Params> = {
  id: "mu-number-ticker",
  name: "数字滚动",
  description: "数字从0滚动到目标值",
  source: "magicui",
  defaults: { value: 100, label: "已完成目标", unit: "%", accent: "#ffffff" },
  controls: [
    { key: "value", label: "目标值", type: "number" },
    { key: "label", label: "说明文字", type: "text" },
    { key: "unit", label: "单位", type: "text" },
    { key: "accent", label: "主色", type: "color" },
  ],
  Component: NumberTickerCard,
};
