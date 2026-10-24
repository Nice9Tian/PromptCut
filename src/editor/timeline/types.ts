export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** 悬停说明(置灰的项说清为什么点不了;带了它的置灰项仍接悬停,点了照样不做) */
  title?: string;
  /** 右边那一列小字:参数摘要、张数这类 */
  hint?: string;
  /** 这一项带下一级:鼠标停上去在右边展开。带了它的项自己不执行 action */
  sub?: ContextMenuItem[];
  /** 下一级的菜单头:逐级走下去时也认得出在动谁 */
  subHead?: ContextMenuHead;
  /** 危险项(删除、摘掉)画成警示色 */
  danger?: boolean;
}

/**
 * 菜单头:动的是哪一段 / 哪一张。
 * 叠加卡那一侧填底(底色取那一段的轨道色),选错了一眼看得出来;普通片段的菜单不填底。
 */
export interface ContextMenuHead {
  title: string;
  /** 填底时右边那半:这一张挂在哪一段 */
  of?: string;
  /** 轨道色按它取(clipTrackKind 的值) */
  trackKind?: string;
}
