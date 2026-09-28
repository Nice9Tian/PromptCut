export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** 悬停说明(置灰的项说清为什么点不了;带了它的置灰项仍接悬停,点了照样不做) */
  title?: string;
}
