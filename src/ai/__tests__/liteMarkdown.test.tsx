// 运行: npx tsx --tsconfig tsconfig.app.json src/ai/__tests__/liteMarkdown.test.tsx
// 必须带 --tsconfig tsconfig.app.json,否则 tsx 读不到 jsx 的 react-jsx 设置,会报 React is not defined
// @ts-ignore
import assert from "node:assert";
import { renderLiteMarkdown } from "../liteMarkdown";

function isElement(node: any): boolean {
  return node && typeof node === "object" && "type" in node;
}

function getChildren(node: any): any[] {
  if (!isElement(node)) return [];
  const children = node.props.children;
  if (Array.isArray(children)) return children;
  return children ? [children] : [];
}

function test() {
  // Simple text
  const n1: any = renderLiteMarkdown("Hello");
  const p1 = getChildren(n1)[0][0]; // nested in <>
  assert.strictEqual(p1.type, "p");
  assert.strictEqual(getChildren(p1)[0], "Hello");

  // Bold text
  const n2: any = renderLiteMarkdown("A **bold** word");
  const p2 = getChildren(n2)[0][0];
  const c2 = getChildren(p2);
  assert.strictEqual(c2[0], "A ");
  assert.strictEqual(c2[1].type, "strong");
  assert.strictEqual(getChildren(c2[1])[0], "bold");
  assert.strictEqual(c2[2], " word");

  // Inline code
  const n3: any = renderLiteMarkdown("Code `let x = 1;` end");
  const p3 = getChildren(n3)[0][0];
  const c3 = getChildren(p3);
  assert.strictEqual(c3[0], "Code ");
  assert.strictEqual(c3[1].type, "code");
  assert.strictEqual(getChildren(c3[1])[0], "let x = 1;");
  assert.strictEqual(c3[2], " end");

  // Code block
  const n4: any = renderLiteMarkdown("```javascript\nconst a = 1;\n```");
  const pre4 = getChildren(n4)[0];
  assert.strictEqual(pre4.type, "pre");
  const code4 = getChildren(pre4)[0];
  assert.strictEqual(code4.type, "code");
  assert.strictEqual(getChildren(code4)[0], "const a = 1;");

  // Code block without lang tag
  const n4_no_lang: any = renderLiteMarkdown("```\nconst a = 1;\n```");
  const pre4_no_lang = getChildren(n4_no_lang)[0];
  assert.strictEqual(pre4_no_lang.type, "pre");
  const code4_no_lang = getChildren(pre4_no_lang)[0];
  assert.strictEqual(code4_no_lang.type, "code");
  assert.strictEqual(getChildren(code4_no_lang)[0], "const a = 1;");

  // Code block with empty line
  const n4_empty_line: any = renderLiteMarkdown("```\na\n\nb\n```");
  const pre4_empty = getChildren(n4_empty_line)[0];
  assert.strictEqual(pre4_empty.type, "pre");
  const code4_empty = getChildren(pre4_empty)[0];
  assert.strictEqual(code4_empty.type, "code");
  assert.strictEqual(getChildren(code4_empty)[0], "a\n\nb");

  // List
  const n5: any = renderLiteMarkdown("- Item 1\n- Item 2");
  const ul5 = getChildren(n5)[0][0];
  assert.strictEqual(ul5.type, "ul");
  const items = getChildren(ul5);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].type, "li");
  assert.strictEqual(getChildren(items[0])[0], "Item 1");
  assert.strictEqual(items[1].type, "li");
  assert.strictEqual(getChildren(items[1])[0], "Item 2");

  // Mixed paragraph and list
  const n6: any = renderLiteMarkdown("A paragraph.\n\n- Item 1\n- Item 2\n\nAnother paragraph.");
  const c6 = getChildren(n6);
  assert.strictEqual(c6[0][0].type, "p");
  assert.strictEqual(c6[0][1].type, "ul");
  assert.strictEqual(c6[0][2].type, "p");

  console.log("liteMarkdown.test.tsx passed");
}

test();
