import { tools as mcpTools } from '../../mcp-tools.mjs';
import { thinkTool } from './think.mjs';
import { createTextEditorTool } from './textEditor.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { injectCardParams } from '../../card-params-schema.mjs';

export async function buildTools({ callTool, workspaceDir, onEvent = () => {}, pollIntervalMs = 3000, jobTimeoutMs = 600000 }) {
  async function waitForJob(name, input, initial, context) {
    const workflow = name === 'auto_workflow' && initial?.running === true || name === 'auto_workflow_status' && initial?.done === false;
    const background = ['stt_install', 'transcribe_media'].includes(name) && initial?.jobId;
    if (!workflow && !background) return initial;
    const jobId = initial.jobId || input.jobId;
    const start = Date.now();
    while (Date.now() - start < jobTimeoutMs) {
      context.signal?.throwIfAborted();
      onEvent({ type: 'progress', phase: 'waiting', round: context.round, callId: context.callId, jobId, text: `后台任务进行中：${name}，已等待 ${Math.floor((Date.now() - start) / 1000)} 秒；自动等待，不消耗模型轮数。` });
      await delay(pollIntervalMs, undefined, { signal: context.signal });
      const status = await callTool(workflow ? 'auto_workflow_status' : 'background_job_status', { jobId });
      onEvent({ type: 'diagnostic', stage: 'job_poll', callId: context.callId, data: status });
      if (!status?.done) continue;
      if (status.ok === false) throw new Error(status.error || '后台任务失败，请检查安装或转写日志。');
      if (name === 'transcribe_media') return await callTool('get_transcript', { mediaId: input.mediaId });
      if (name === 'stt_install') return await callTool('stt_status', {});
      return status.result ?? status;
    }
    throw new Error(`后台任务 ${jobId} 等待超时；任务可能仍在运行，请先查询状态，不要重复启动。`);
  }
  const result = mcpTools.map(t => ({
    name: t.name,
    description: t.description + (['auto_workflow', 'stt_install', 'transcribe_media'].includes(t.name) ? ' API 模式会自动等待后台作业结束，不要自己密集轮询或重复启动。' : ''),
    // 深拷贝:下面要就地改写 params,而 mcpTools 是整个进程共享的模块级常量
    inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
    async execute(input, context = {}) { return waitForJob(t.name, input, await callTool(t.name, input), context); },
  }));
  result.push(thinkTool, createTextEditorTool(workspaceDir));

  // 把 add_clip / update_clip 的 params 换成按 cardId 分支的真实 schema。
  // 不做这一步的话它是个自由对象,模型看到的是「没有任何字段」,一个卡片参数都传不出去
  // —— MCP server 那条路一直做了这件事,API 直连这条路以前漏了。
  try {
    const cards = await callTool('list_cards', { detail: 'full' });
    injectCardParams(result, cards);
  } catch (error) {
    // 拿不到卡片列表就退回自由对象:少了参数提示总比工具整个不能用强
    onEvent({ type: 'status', text: `没能取到卡片 schema,add_clip 的参数提示会缺失:${error.message}` });
  }

  return result;
}
