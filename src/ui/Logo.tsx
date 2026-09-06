/**
 * 产品标识(设计稿「工具栏组件表」第 00 节)。
 * 标记是一个被斜切开的方形:实心一半代表已渲染,取当前主题强调色;描边一半代表待处理,取主文字色。
 * 缝宽随字号等比缩放;16px 以下描边加粗到 2.5。字标用条件字体栈里的窄体,字距 .14em。
 */
export function LogoMark({ size = 22, mono = false }: { size?: number; mono?: boolean }) {
  const stroke = size < 16 ? 2.5 : 1.5;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M1 1H17L11 31H1V1Z" fill={mono ? "currentColor" : "var(--ui-accent)"} />
      <path
        d="M20 1H31V31H14L20 1Z"
        stroke={mono ? "currentColor" : "var(--ui-fg)"}
        strokeWidth={stroke}
      />
    </svg>
  );
}

export function Logo({
  size = 22,
  wordmark = true,
  sub = false,
  name = "PromptCut",
}: {
  size?: number;
  wordmark?: boolean;
  /** 副标(VIDEO EDITOR),纵向组合时用 */
  sub?: boolean;
  name?: string;
}) {
  return (
    <span className="pc-logo" style={{ gap: Math.round(size * 0.36) }}>
      <LogoMark size={size} />
      {wordmark && (
        <span className="pc-logo-text">
          <span className="pc-logo-word" style={{ fontSize: Math.round(size * 0.74) }}>
            {name}
          </span>
          {sub && <span className="pc-logo-sub">VIDEO EDITOR</span>}
        </span>
      )}
    </span>
  );
}
