/**
 * 游客头像。颜色和图形都从游客编号哈希出来（`guest.ts` 的 `guestAvatar`），不用图片资源：
 * 游客是进来那一刻随机分配的，不可能先给他配一张图。
 *
 * 画成圆的，和 AI 角色那个方头像（`src/editor/right/RoleAvatar.tsx`）区分开 —— 一眼能看出
 * 「这是个人，不是个角色」。描边和线条粗细照界面上那套图标：24×24 的 `viewBox`、1.6 的线宽、圆头。
 */
import { guestAvatar, GUEST_SHAPES, guestName } from './guest';
import './guestAvatar.css';

export function GuestAvatar(props: { id: string; size?: number; title?: string }) {
  const { id, size = 24 } = props;
  const { hue, shape } = guestAvatar(id);
  const glyph = GUEST_SHAPES[shape];
  const label = props.title ?? guestName(id);
  return (
    <span
      className="pc-guest-avatar"
      style={{
        width: size,
        height: size,
        // 和 RoleAvatar 同一档明度纯度:底深、描边亮一档、笔画最亮,这样在深浅两套皮肤里都看得清
        background: `hsl(${hue} 45% 32%)`,
        borderColor: `hsl(${hue} 45% 46%)`,
        color: `hsl(${hue} 60% 88%)`,
      }}
      title={label}
      aria-label={label}
      data-pc="guest-avatar"
      data-shape={shape}
    >
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.72)} height={Math.round(size * 0.72)} aria-hidden="true">
        <path d={glyph} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** 头像 + 名字，占一行。成员列表、开始页的「你现在是」都用这个 */
export function GuestChip(props: { id: string; size?: number; suffix?: string }) {
  return (
    <span className="pc-guest-chip" data-pc="guest-chip">
      <GuestAvatar id={props.id} size={props.size} />
      <span className="pc-guest-name">{guestName(props.id)}{props.suffix ?? ''}</span>
    </span>
  );
}
