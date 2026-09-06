import { tools as mcpTools } from '../../mcp-tools.mjs';
import { thinkTool } from './think.mjs';
import { createTextEditorTool } from './textEditor.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export function buildTools({ callTool, workspaceDir, onEvent = () => {}, pollIntervalMs = 3000, jobTimeoutMs = 600000 }) {
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
  const result = mcpTools.filter(t => t.name !== 'import_video').map(t => ({
    name: t.name, description: t.description + (['auto_workflow', 'stt_install', 'transcribe_media'].includes(t.name) ? ' API 模式会自动等待后台作业结束，不要自己密集轮询或重复启动。' : ''), inputSchema: t.inputSchema,
    async execute(input, context = {}) { return waitForJob(t.name, input, await callTool(t.name, input), context); },
  }));
  result.push(thinkTool, createTextEditorTool(workspaceDir));
  const batchTools = [...result];
  result.push({
    name: 'batch_tools',
    description: '一次提交最多20个参数已确定的操作，按顺序执行并一次返回全部结果，节省模型往返。可用于批量添加或修改不同卡片。若需要上一个工具返回的ID，请分到下一轮。',
    inputSchema: { type: 'object', properties: { calls: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { name: { type: 'string', enum: batchTools.map(t => t.name) }, input: { type: 'object' } }, required: ['name', 'input'] } } }, required: ['calls'] },
    async execute(input, context = {}) {
      if (!Array.isArray(input.calls) || !input.calls.length || input.calls.length > 20) throw new Error('批量操作必须包含1到20个工具调用。');
      // Validate the entire batch before the first mutation.
      const selected = input.calls.map(call => {
        const tool = batchTools.find(t => t.name === call.name);
        if (!tool || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new Error('批量操作包含未知工具或无效参数。');
        for (const key of tool.inputSchema?.required || []) if (call.input[key] === undefined) throw new Error(`${call.name} 缺少参数 ${key}`);
        return tool;
      });
      const results = [];
      for (let i = 0; i < input.calls.length; i++) {
        context.signal?.throwIfAborted();
        const call = input.calls[i], callId = `${context.callId || 'batch'}:${i + 1}`, start = Date.now();
        onEvent({ type: 'tool_call', name: call.name, input: call.input, callId, round: context.round });
        let output, ok = true;
        try { output = await selected[i].execute(call.input, { ...context, callId }); ok = output?.ok !== false; }
        catch (error) { context.signal?.throwIfAborted(); ok = false; output = { error: error.message }; }
        onEvent({ type: 'tool_result', callId, name: call.name, ok, output, summary: JSON.stringify(output ?? null).slice(0, 1000), durationMs: Date.now() - start });
        results.push({ name: call.name, ok, result: output });
        if (!ok) return { ok: false, results, skipped: input.calls.length - i - 1, hint: '后续操作未执行，请修正失败项，勿重做已经成功的操作。' };
      }
      return { ok: true, results };
    },
  });
  return result;
}
