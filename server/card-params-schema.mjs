/**
 * 给 add_clip / update_clip 的 `params` 生成真实的 JSON Schema。
 *
 * 为什么需要它:`params` 的合法字段取决于 cardId,静态写不出来。原来的写法是
 * `params: { type: "object" }` —— 一个没有任何字段说明的自由对象。
 * MCP server 走 tools/list 时会动态换成下面这个 anyOf,但 **API 直连从来没做这一步**,
 * 于是模型收到的是被 sanitizeSchema 规范成的 `{ type:"object", properties:{} }`,
 * 意思变成「这个对象没有任何字段」—— 模型因此**根本无法传任何卡片参数**,
 * 建出来的卡永远是 params: {}。字幕卡没有 lines、动效卡全是默认值,根子都在这里。
 *
 * 两条路现在共用这一份,不会再出现「CLI 能传、API 传不了」的不对称。
 */

/** 控件类型 → JSON Schema 类型 */
function typeOf(control) {
  if (control.type === "number") return { type: "number" };
  if (control.type === "select") {
    return { type: "string", enum: control.options?.map((o) => o.value) ?? [] };
  }
  return { type: "string" };
}

function describe(control) {
  const bits = [control.label].filter(Boolean);
  if (control.required) bits.push("必填");
  if (control.hint) bits.push(control.hint);
  return bits.join(" · ") || undefined;
}

/**
 * @param cards list_cards({ detail: 'full' }) 的返回,每项要有 id / controls
 * @returns 可直接塞进 add_clip.params 的 schema
 */
export function buildParamsSchema(cards) {
  const usable = (cards || []).filter((c) => c && typeof c.id === "string" && Array.isArray(c.controls));
  if (usable.length === 0) return null;

  return {
    type: "object",
    description:
      "卡片参数,合法字段取决于 cardId。下面每个分支对应一张卡;先用 list_cards({cardId}) 看清该卡的 controls 再填。",
    anyOf: usable.map((card) => {
      const properties = {};
      const required = [];
      for (const control of card.controls) {
        properties[control.key] = { ...typeOf(control), description: describe(control) };
        if (control.required) required.push(control.key);
      }
      return {
        title: card.id,
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        // 留个口子:卡片刚加的参数还没进这份 schema 时也能传进来
        additionalProperties: true,
      };
    }),
  };
}

/**
 * 就地把 add_clip / update_clip 的 params 换成真实 schema。
 * 拿不到卡片列表时原样返回 —— 宁可退回自由对象,也不要因为拼 schema 失败让工具整个用不了。
 */
export function injectCardParams(tools, cards) {
  const schema = buildParamsSchema(cards);
  if (!schema) return tools;
  for (const tool of tools) {
    const props = tool?.inputSchema?.properties ?? tool?.parameters?.properties;
    if (props && "params" in props) props.params = schema;
  }
  return tools;
}
