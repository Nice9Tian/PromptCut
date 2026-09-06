// 对应 claude-quickstarts/agents/tools/index.py

import { tools as mcpTools } from '../../mcp-tools.mjs';
import { thinkTool } from './think.mjs';
import { createTextEditorTool } from './textEditor.mjs';

export function buildTools({ callTool, workspaceDir }) {
  const result = [];
  
  for (const t of mcpTools) {
    if (t.name === 'import_video') continue;
    
    result.push({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      async execute(input) {
        return await callTool(t.name, input);
      }
    });
  }
  
  result.push(thinkTool);
  result.push(createTextEditorTool(workspaceDir));
  
  return result;
}
