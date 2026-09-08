// 对应 claude-quickstarts/agents/utils/schema.py

/**
 * 清洗 schema 使其符合不同厂商的要求
 */
/**
 * @param opts.compat 「参数兼容模式」:按 Gemini 那套最窄的 schema 子集清洗(删 additionalProperties /
 *   default / format 等,自由对象退成空对象)。不传就按 vendor 推:gemini 家开,其余关。
 *   为什么要和 vendor 分开:走 OpenAI 兼容接口(Router、第三方网关)也可能接的是 Gemini 模型,
 *   厂商字段写的是 openai,schema 却得按 Gemini 的规矩来 —— 由调用方按模型名或用户开关决定。
 */
export function sanitizeSchema(schema, vendor, opts = {}) {
  const clone = JSON.parse(JSON.stringify(schema || {}));
  const compat = typeof opts.compat === 'boolean' ? opts.compat : vendor === 'gemini';

  function processNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;

    if (compat) {
      delete node.$schema;
      delete node.additionalProperties;
      delete node.default;
      delete node.examples;
      delete node.title;
      delete node.format;
      delete node.minItems;
      delete node.maxItems;
      delete node.exclusiveMinimum;
      delete node.exclusiveMaximum;
    }

    // 嵌套的自由对象(没写 properties)要保持自由。
    // 以前这里补一个空的 properties,等于把「任意对象」改写成「没有任何字段的对象」——
    // 模型照着这个 schema 只能交出 {},卡片参数因此完全传不出去。
    // 补 additionalProperties: true 把「随便填」这层意思说明白。
    if (node.type === 'object' && !node.properties && !node.anyOf && !node.oneOf) {
      if (compat) {
        // Gemini 的 schema 子集不认 additionalProperties(上面已经删掉了),
        // 它要求对象必须有 properties,所以这一家只能退回空对象。
        node.properties = {};
      } else {
        node.additionalProperties = true;
      }
    }

    if (Array.isArray(node.anyOf)) node.anyOf.forEach(processNode);
    if (Array.isArray(node.oneOf)) node.oneOf.forEach(processNode);

    if (node.properties && typeof node.properties === 'object') {
      for (const key of Object.keys(node.properties)) {
        processNode(node.properties[key]);
      }
    }
    if (node.items) {
      processNode(node.items);
    }
  }

  processNode(clone);
  
  if (vendor === 'openai' || vendor === 'anthropic' || vendor === 'gemini') {
    if (clone.type !== 'object') {
      clone.type = 'object';
    }
    if (!clone.properties) {
      clone.properties = {};
    }
  }
  
  return clone;
}

/**
 * 将内部 Tool 形状转成三家 API 的工具声明
 */
export function toolToVendor(tool, vendor, opts = {}) {
  const { name, description, inputSchema } = tool;
  const sanitizedSchema = sanitizeSchema(inputSchema, vendor, opts);

  if (vendor === 'anthropic') {
    return {
      name,
      description,
      input_schema: sanitizedSchema
    };
  } else if (vendor === 'openai') {
    return {
      type: 'function',
      function: {
        name,
        description,
        parameters: sanitizedSchema
      }
    };
  } else if (vendor === 'gemini') {
    return {
      name,
      description,
      parameters: sanitizedSchema
    };
  }
  
  return { name, description, inputSchema: sanitizedSchema };
}
