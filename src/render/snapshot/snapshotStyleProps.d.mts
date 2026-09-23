/** 差异样式内联的属性表(底稿 A2(8))。说明见 snapshotStyleProps.mjs。 */
export const INHERITED_PROPS: Set<string>;
export const LAYOUT_USED_VALUE_PROPS: Set<string>;
export const LAYOUT_UNIT_PROPS: Set<string>;
export function snapLayoutUnits(value: string): string;
export const COMPOSITED_ANIMATION_PROPS: Set<string>;
export function isCurrentAnimation(
  timing: { localTime?: CSSNumberish | null; endTime?: CSSNumberish; delay?: number; activeDuration?: CSSNumberish },
  playbackRate: number,
  playState: AnimationPlayState,
): boolean;
export function isInheritedProp(prop: string): boolean;
