import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** 镜像行里代表「⋯」按钮的那一格 */
export const MORE_KEY = "__more";

export interface ToolbarLayout {
  /** 可见控件实际占几行 */
  rows: number;
  /** 带图标的按钮是否收起文字,只留图标 */
  compact: boolean;
  /** 被收进「⋯」菜单的控件 key */
  hidden: Set<string>;
}

/**
 * 按可用宽度贪心装行,返回需要的行数。
 * 单个控件比一整行还宽时不再往下拆——它自己 nowrap,宁可溢出也不挤扁。
 */
function packRows(widths: number[], gap: number, available: number): number {
  let rows = 1;
  let used = 0;
  for (const w of widths) {
    if (used === 0) {
      used = w;
      continue;
    }
    const next = used + gap + w;
    if (next <= available) {
      used = next;
    } else {
      rows++;
      used = w;
    }
  }
  return rows;
}

/** 从镜像行里读出每个控件的自然宽度,按 data-key 索引 */
function readWidths(mirror: HTMLElement): Map<string, number> {
  const widths = new Map<string, number>();
  for (const child of Array.from(mirror.children)) {
    const key = (child as HTMLElement).dataset.key;
    if (key) widths.set(key, child.getBoundingClientRect().width);
  }
  return widths;
}

/**
 * 顶栏排布:窄了先换行,再收文字,还不够就把低优先级的控件收进「⋯」菜单。
 *
 * 不写死像素断点。宽度全部来自一行隐藏的镜像——镜像里**始终**渲染着全部控件,
 * 所以哪怕某个控件此刻正待在菜单里,也照样量得到它的宽度,面板一变宽就能算出
 * 它放得回去。以后往工具栏里加按钮,只要在 order 里排个位置,这里不用改。
 *
 * 降级顺序:
 *   1. 完整文案,一行
 *   2. 完整文案,换到 maxRows 行
 *   3. 收起图标按钮的文字(compact)
 *   4. 按 order 依次把控件收进「⋯」菜单,直到不超过 maxRows 行
 * 每一步都放不下时宁可多占一行,也绝不把控件压窄。
 *
 * @param barRef    可见工具栏容器,用来量可用宽度
 * @param mirrorRef 隐藏镜像行,子元素带 data-key,含一格 MORE_KEY
 * @param order     溢出优先级:排在前面的先进菜单;不在表里的永远留在栏上
 * @param maxRows   最多排几行,超了就开始往菜单里收,默认 2 行
 */
export function useToolbarLayout(
  barRef: RefObject<HTMLElement | null>,
  mirrorRef: RefObject<HTMLElement | null>,
  order: readonly string[],
  { maxRows = 2 }: { maxRows?: number } = {},
): ToolbarLayout {
  const [layout, setLayout] = useState<ToolbarLayout>({ rows: 1, compact: false, hidden: new Set() });
  /** 完整文案下量到的那组宽度,用来判断能不能退出 compact */
  const fullWidths = useRef<Map<string, number> | null>(null);
  const compactRef = useRef(false);
  compactRef.current = layout.compact;

  useEffect(() => {
    const bar = barRef.current;
    const mirror = mirrorRef.current;
    if (!bar || !mirror) return;

    const measure = () => {
      const available = bar.clientWidth;
      // 面板还没布局出来(宽度为 0)时量到的全是 0,这一轮跳过,等下一次回调
      if (available <= 0) return;

      const gap = parseFloat(getComputedStyle(bar).columnGap || getComputedStyle(bar).gap) || 0;
      const widths = readWidths(mirror);
      if (widths.size === 0) return;
      if (!compactRef.current) fullWidths.current = widths;

      const keys = Array.from(widths.keys()).filter((k) => k !== MORE_KEY);
      const moreWidth = widths.get(MORE_KEY) ?? 0;
      const rowsWith = (hidden: Set<string>, from: Map<string, number>) => {
        const list = keys.filter((k) => !hidden.has(k)).map((k) => from.get(k) ?? 0);
        if (hidden.size > 0) list.push(moreWidth);
        return packRows(list, gap, available);
      };

      // 收文字看当前这组;放回文字要看完整文案那组,不然一收起就够宽了、
      // 立刻又展开,来回抖。
      const none = new Set<string>();
      const reference = compactRef.current ? fullWidths.current ?? widths : widths;
      const compact = rowsWith(none, reference) > maxRows;

      // 还超行就按优先级往菜单里收,收到不超行为止;全收完还超行就认了,
      // 多占一行也不压缩控件。
      const hidden = new Set<string>();
      for (const key of order) {
        if (rowsWith(hidden, widths) <= maxRows) break;
        if (widths.has(key)) hidden.add(key);
      }

      setLayout((prev) =>
        prev.compact === compact &&
        prev.hidden.size === hidden.size &&
        [...hidden].every((k) => prev.hidden.has(k)) &&
        prev.rows === rowsWith(hidden, widths)
          ? prev
          : { rows: rowsWith(hidden, widths), compact, hidden },
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    ro.observe(mirror);
    // 控件增减、文案变化(比如按钮从「安装」变成「安装中…」)也要重量一次
    const watchChildren = () => {
      for (const child of Array.from(mirror.children)) ro.observe(child);
    };
    watchChildren();
    const mo = new MutationObserver(() => {
      watchChildren();
      measure();
    });
    mo.observe(mirror, { childList: true, subtree: true, characterData: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [barRef, mirrorRef, order, maxRows]);

  return layout;
}
