import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';
import { cliCommand, cliEnv } from './cli-runtime.mjs';

function runAgy(exe, args, options) {
  const invocation = cliCommand(exe, args);
  return execFileSync(invocation.command, invocation.args, { env: cliEnv('agy'), timeout: 15000, ...options });
}

let registerPromise = null;
let lastRegisteredPort = null;

async function ensureMcpRegistered(exePath, mcpOpts, safeOnEvent) {
  if (registerPromise && lastRegisteredPort === mcpOpts.env.PROMPTCUT_PORT) return registerPromise;
  
  registerPromise = (async () => {
    try {
      const listStdout = runAgy(exePath, ['mcp', 'list'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = listStdout.trim().split(/\r?\n/);
      let found = false;
      for (const l of lines) {
         if (l.startsWith('promptcut') || l.split(/\s+/)[0] === 'promptcut') {
             if (l.includes(mcpOpts.command) && l.includes(mcpOpts.args[0])) {
                 found = true;
                 break;
             }
         }
      }
      if (found) {
         lastRegisteredPort = mcpOpts.env.PROMPTCUT_PORT;
         return;
      }
    } catch {}

    try {
      runAgy(exePath, ['mcp', 'add', '-e', `PROMPTCUT_PORT=${mcpOpts.env.PROMPTCUT_PORT}`, 'promptcut', mcpOpts.command, mcpOpts.args[0]], { windowsHide: true, stdio: 'ignore' });
      lastRegisteredPort = mcpOpts.env.PROMPTCUT_PORT;
      safeOnEvent({ type: 'status', text: '已把 PromptCut 注册为 agy 的 MCP 服务（agy mcp add promptcut）' });
    } catch (e) {
      safeOnEvent({ type: 'error', message: `MCP registration failed: ${e.message}` });
    }
  })();
  return registerPromise;
}

export async function getAgyProvider() {
  const exePath = resolveExe('agy');
  let available = false;
  let version = undefined;
  let note = undefined;
  try {
    const stdout = probeVersion(exePath);
    version = stdout.trim();
    available = true;
  } catch (e) {
    note = e.message;
  }
  return { id: 'agy', label: 'Antigravity', available, version, path: exePath, note };
}

import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';

export function startRun(opts) {
  if (opts.toolProtocol) {
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
  }

  let abortRef = { abort: () => {} };
  let rejected = false;

  const interceptOnEvent = (ev) => {
    if ((ev.type === 'done' || ev.type === 'error') && rejected) {
        return;
    }
    opts.onEvent(ev);
  };

  const run = _startRun({
    ...opts,
    onEvent: interceptOnEvent,
    onPermissionDenied: () => {
      rejected = true;
    }
  });
  abortRef.abort = run.abort;

  const donePromise = run.done.then((res) => {
    if (rejected) {
      opts.onEvent({ type: 'status', text: '原生工具被拒，改用文本协议重试' });
      const nextRun = runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
      abortRef.abort = nextRun.abort;
      return nextRun.done;
    }
    return res;
  });

  return { abort: () => abortRef.abort(), done: donePromise };
}

function _startRun(opts) {
  const exePath = resolveExe('agy');
  
  let resolveDone;
  const donePromise = new Promise(r => { resolveDone = r; });
  let childController = null;
  let isAborted = false;
  
  const fullPrompt = `<<<系统说明>>>\n${opts.systemPrompt}\n<<<用户消息>>>\n${opts.prompt}`;

  /*
   * 提示词走 **stdin**,不走命令行参数。
   *
   * 原来是 `-p <整个提示词>`。Windows 单条命令行上限 32767 字符,而系统提示词本身就
   * 15,000 出头 —— 平时够用,一旦叠上文本协议那份工具清单(33,000 字符)就是 49,000,
   * 直接 `spawn ENAMETOOLONG`。也就是说 agy 的「原生工具被拒 → 改用文本协议重试」
   * 这条兜底路**从来没有成功过**,一进去就炸,而且炸得看不出所以然。
   * claude.mjs 和 codex.mjs 早就是走 stdin 的,这里是唯一的例外。
   *
   * `--input-format stream-json` 让 agy 从 stdin 逐行读 NDJSON;它本身就意味着 print 模式,
   * 所以不再给 `-p`(给了反而会把后面那个标志当成提示词吃掉)。消息的形状是实测出来的:
   * `{"event":"user","message":{"role":"user","content":"…"}}` —— 少 `event` 或少 `message`
   * 都会被 agy 明确拒绝。实测 48,000 字符的提示词这样发过去正常返回。
   */
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--add-dir', opts.cwd,
    '--print-timeout', '20m'
  ];
  if (opts.sessionId) {
    args.push('--conversation', opts.sessionId);
  }
  /*
   * 模型名和思考档**必须配对**,这是 agy 的硬规矩,配不上直接拒整轮:
   *
   *   --model gemini-3.8-flash-low --effort low   ✓
   *   --model gemini-3.8-flash-low --effort high  ✗ invalid model selection
   *   --model gemini-3.8-flash     --effort low   ✓ 基名 + 档位,和第一条等价
   *
   * 面板那边已经拆成「基名 + 档位」再发过来了(modelOptions.pairModelEffort),
   * 这里把带后缀的写法再兜一道:后台任务、分工模式那几条路不一定经过面板,
   * 而且会话历史里存的可能是早先那种带后缀的名字。剥掉后缀、拿它当档位,
   * 结果和原来那个名字完全等价,但一定配得上。
   */
  let model = opts.model || '';
  let effort = opts.effort || '';
  const suffixed = /^(.+)-(low|medium|high)$/.exec(model);
  if (suffixed) {
    model = suffixed[1];
    effort = suffixed[2];
  }
  if (model) {
    args.push('--model', model);
  }
  // agy 支持 low|medium|high 三档,但**每个模型有哪几档不一样**(gemini-3.1-pro 就没有 medium);
  // 没有加速档,前端会把那个开关灰掉
  if (effort) {
    args.push('--effort', effort);
  }

  const safeOnEvent = (ev) => {
      if (childController) childController.safeOnEvent(ev);
      else {
          try { opts.onEvent(ev); } catch {}
      }
  };

  const runChild = () => {
    if (isAborted) {
       resolveDone();
       return;
    }
    
    childController = spawnCli(exePath, args, { cwd: opts.cwd }, opts.onEvent, 'Antigravity');
    let emitted = '';

    // 提示词从这里进去(见上面 args 的说明)。EPIPE 忽略:进程要是已经自己退了,
    // 真正的原因在 stderr / result 事件里,不该被一个写管道失败盖过去。
    childController.child.stdin.on('error', () => {});
    try {
      childController.child.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: fullPrompt } }) + '\n');
      childController.child.stdin.end();
    } catch { /* 同上 */ }


    childController.child.stdout.on('data', lineSplitter(line => {
      if (!line.trim()) return;
      if (process.env.PROMPTCUT_RUNNER_DEBUG) console.error('[agy] ' + line);
      try {
        const ev = JSON.parse(line);
        if (ev.event === 'init' && ev.conversation_id) {
          childController.safeOnEvent({ type: 'session', sessionId: ev.conversation_id });
        } else if (ev.event === 'step_update' && ev.step_update) {
           const su = ev.step_update;
           if (su.step_type === 'tool') {
              let tName = su.tool_name;
              let tInput = su.tool_info?.parameters || {};
              // 这一步到底是不是在调 PromptCut 的工具。agy 自己也有一大堆内建工具
              // (run_command / browser_* / …),它们不走 MCP,被拒的处理方式完全不同
              const isMcp = su.tool_name === 'call_mcp_tool';
              if (isMcp) {
                  tName = tInput.ToolName || 'call_mcp_tool';
                  tInput = tInput.Arguments || tInput;
              }

              if (su.state === 'ACTIVE') {
                 childController.safeOnEvent({ type: 'tool_call', name: tName, input: tInput });
              } else if (su.state === 'DONE') {
                 let outputStr = 'done';
                 if (su.tool_info?.output !== undefined) {
                     if (typeof su.tool_info.output === 'string') outputStr = su.tool_info.output;
                     else outputStr = JSON.stringify(su.tool_info.output);
                 }
                 childController.safeOnEvent({ type: 'tool_result', name: tName, ok: true, summary: outputStr.substring(0, 300) });
              } else if (su.state === 'ERROR') {
                 const msg = su.tool_info?.error?.message || '';
                 const denied = msg.includes('permission') || msg.includes('权限') || msg.includes('denied') || msg.includes('not allowed');
                 /*
                  * 「被拒」要分是谁被拒的,原来一律当成 MCP 被拒,两处都错:
                  *
                  * - 话说错了。agy 内建的 run_command 在无人值守模式下没法弹窗问,会被自动
                  *   拒掉,而我们回一句「请点『授权 PromptCut 工具』」—— 那个按钮跟它一点关系
                  *   没有,用户点了也没用。同一轮里 get_project / list_media 明明都成功了,
                  *   MCP 根本是通的。
                  * - 事也做错了。onPermissionDenied 会让整轮跑完之后改用文本协议重试,可文本协议
                  *   换的只是「PromptCut 的工具怎么下达」,管不着 agy 自己那套 command 权限;
                  *   重试一遍照样被拒。白跑一轮,还把用户等在那儿。
                  *
                  * 所以只有真的是 MCP 那条路被拒时才回退。agy 自家工具被拒就照实说,
                  * 并且当成一次失败的工具调用交回给模型 —— 让它换个办法接着做,而不是整轮作废。
                  */
                 if (denied && isMcp) {
                    if (opts.onPermissionDenied) opts.onPermissionDenied();
                    childController.safeOnEvent({ type: 'status', text: `agy 拒绝了 MCP 工具调用。请打开 AI 设置（右栏齿轮），点『授权 PromptCut 工具』，然后重试。` });
                 } else if (denied) {
                    childController.safeOnEvent({ type: 'tool_result', name: tName, ok: false, summary: `Antigravity 自己拒绝了这个工具(它的内建工具,不是 PromptCut 的):${msg}` });
                    childController.safeOnEvent({ type: 'status', text: `Antigravity 拦下了它自己的 ${tName}——无人值守模式下没法弹窗征求同意。PromptCut 的工具不受影响,让它改用 PromptCut 的工具做同一件事即可。` });
                 } else {
                    childController.safeOnEvent({ type: 'tool_result', name: tName, ok: false, summary: msg });
                 }
              }
           } else {
               const txt = su.text_delta ?? su.text ?? su.delta ?? su.content ?? su.message;
               if (typeof txt === 'string' && txt.length > 0) {
                  childController.safeOnEvent({ type: 'text', delta: txt });
                  emitted += txt;
               }
           }
        } else if (ev.event === 'result' && ev.result) {
           const res = ev.result;

           /*
            * agy 出错时照样发一条 result,只是 status 是 ERROR、error 里写着原因,
            * 然后以非 0 退出。这里原来不看 status,把它当成正常收尾发了个 done ——
            * 而 done 一发,spawnCli 里 hasDone 就为真,`close` 那条「exited with code 1」
            * 也被一并压掉。于是界面上只剩一句「已启动 Antigravity」,几秒后无声无息地结束:
            * 没有回复、没有报错、usage 全是 0,看起来就像连不上。
            *
            * 实际最常撞上的是模型名不对(比如 `gemini-3.8.flash` —— agy 的名字是
            * `gemini-3.8-flash-low` 这种),agy 说得清清楚楚,只是没人把这句话传出来。
            * claude.mjs 那边一直是查 is_error 的,这里补齐。
            */
           if (res.status === 'ERROR' || res.error) {
              const why = typeof res.error === 'string' ? res.error : (res.error?.message || 'Antigravity 报错但没说原因');
              childController.finish({ type: 'error', message: `Antigravity: ${why}` });
              return;
           }

           const finalResponse = res.response || '';

           if (res.denied_actions && res.denied_actions.length > 0) {
               const deniedNames = res.denied_actions.map(a => a.display_name || a.action).join(', ');
               /*
                * 被拒**而且什么都没产出** = 这一轮废了,不能报成功。
                *
                * agy 在无人值守模式下把自己的 run_command 自动拒掉之后就放弃整轮,
                * result 里 denied_actions 有值、response 是空的,但 status 不是 ERROR。
                * 原来这里只发一条 status 就照常 finish('done') —— 界面上是一串工具调用
                * 之后毫无征兆地结束:没有回复、没有报错,用户完全不知道发生了什么。
                * (用户原话:「这里拒绝好像是我们拒绝的,没有给 Agent 反馈而是直接中断了」。)
                *
                * 拒绝这件事我们无法在 agy 的循环里回喂 —— 它是一次性的 CLI 调用,
                * 自己管自己的工具。能做的是:把它如实报成错误,并且说清楚下一步。
                * 真正的治本在另一头:补了 wait 工具,模型就不必再借 shell 去睡觉了
                * (见 server/mcp-tools.mjs 里 wait 的说明)。
                */
               if (!String(finalResponse).trim() && !emitted.trim()) {
                  childController.finish({
                    type: 'error',
                    message: `Antigravity 拒绝了它自己的内建工具(${deniedNames})之后放弃了这一轮,没有产出任何结果。`
                      + `无人值守模式下它没法弹窗征求同意,所以需要 command 权限的工具一律自动拒绝。`
                      + `PromptCut 的工具不受影响 —— 如果它是想「等几秒再查作业」,现在有 wait 工具可以用,重试一次即可。`,
                  });
                  return;
               }
               childController.safeOnEvent({ type: 'status', text: `部分动作被拒绝: ${deniedNames}` });
           }

           if (typeof finalResponse === 'string' && finalResponse.trim().length > 0) {
              const cleanedEmitted = emitted.trim();
              const cleanedResponse = finalResponse.trim();
              if (!cleanedEmitted.endsWith(cleanedResponse) && !cleanedEmitted.includes(cleanedResponse)) {
                  childController.safeOnEvent({ type: 'text', delta: finalResponse });
              }
           }
           childController.finish({ type: 'done', sessionId: res.conversation_id, usage: res.usage });
        }
      } catch {}
    }));

    childController.donePromise.then(resolveDone);
  };

  if (opts.mcp) {
    ensureMcpRegistered(exePath, opts.mcp, safeOnEvent).then(runChild);
  } else {
    runChild();
  }
  
  const abort = () => {
    isAborted = true;
    if (childController) childController.abort();
    else resolveDone();
  };
  
  return { abort, done: donePromise };
}
