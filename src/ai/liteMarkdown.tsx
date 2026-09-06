import type { ReactNode } from "react";

/**
 * 轻量 Markdown 渲染器。
 * 支持：段落、**粗体**、行内代码、``` 代码块、`- ` 列表。
 */
export function renderLiteMarkdown(text: string): ReactNode {
  if (!text) return null;

  // 1. 先把由三反引号包围的代码块提出来，其余部分再按段落劈开
  const segments: { type: "code" | "text"; content: string }[] = [];
  let currentText = "";
  const lines = text.split("\n");
  let inCodeBlock = false;
  let codeContent = "";
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        if (currentText) {
          segments.push({ type: "text", content: currentText });
          currentText = "";
        }
        inCodeBlock = true;
        // Check if there is a language tag (no spaces)
        const remainder = line.trim().substring(3).trim();
        if (remainder && !remainder.includes(" ")) {
          // It's a language tag, drop it.
        } else if (remainder) {
          // If it contains space, it's part of the code
          codeContent += remainder + "\n";
        }
      } else {
        inCodeBlock = false;
        segments.push({ type: "code", content: codeContent });
        codeContent = "";
      }
    } else {
      if (inCodeBlock) {
        codeContent += line + "\n";
      } else {
        currentText += line + "\n";
      }
    }
  }
  
  if (inCodeBlock) {
    segments.push({ type: "code", content: codeContent });
  } else if (currentText) {
    segments.push({ type: "text", content: currentText });
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "code") {
          return (
            <pre key={i}>
              <code>{seg.content.replace(/\n$/, "")}</code>
            </pre>
          );
        }

        // 2. 对文本部分按空行分段
        const blocks = seg.content.split(/\n\n+/);
        return blocks.map((block, j) => {
          const trimmed = block.trim();
          if (!trimmed) return null;

          // 列表
          if (trimmed.split("\n").every((line) => line.trim().startsWith("- "))) {
            const items = trimmed.split("\n").map((line) => line.trim().substring(2));
            return (
              <ul key={`${i}-${j}`}>
                {items.map((item, k) => (
                  <li key={k}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          }

          // 普通段落
          return <p key={`${i}-${j}`}>{renderInline(trimmed)}</p>;
        });
      })}
    </>
  );
}

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let current = "";
  
  let i = 0;
  while (i < text.length) {
    if (text.substring(i).startsWith("**")) {
      if (current) parts.push(current);
      current = "";
      i += 2;
      let boldContent = "";
      while (i < text.length && !text.substring(i).startsWith("**")) {
        boldContent += text[i];
        i++;
      }
      if (i < text.length) i += 2; // skip closing **
      parts.push(<strong key={i + "b"}>{boldContent}</strong>);
    } else if (text[i] === "`") {
      if (current) parts.push(current);
      current = "";
      i++;
      let codeContent = "";
      while (i < text.length && text[i] !== "`") {
        codeContent += text[i];
        i++;
      }
      if (i < text.length) i++; // skip closing `
      parts.push(<code key={i + "c"}>{codeContent}</code>);
    } else {
      current += text[i];
      i++;
    }
  }
  
  if (current) parts.push(current);
  
  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : parts;
}
