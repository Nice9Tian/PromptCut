// 对应 claude-quickstarts/agents/utils/schema.py

/**
 * 清洗 schema 使其符合不同厂商的要求
 */
export function sanitizeSchema(schema, vendor) {
  const clone = JSON.parse(JSON.stringify(schema || {}));

  function processNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;

    if (vendor === 'gemini') {
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

    if (node.type === 'object' && !node.properties) {
      node.properties = {};
    }

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
export function toolToVendor(tool, vendor) {
  const { name, description, inputSchema } = tool;
  const sanitizedSchema = sanitizeSchema(inputSchema, vendor);

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
