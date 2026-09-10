import { Agent } from './agent.mjs';
import { MessageHistory } from './history.mjs';
import * as P from './loop-prompts.mjs';

/**
 * 审查环路:judger 开场定要求 → worker 执行 → reviewer 审查 → judger 裁决。
 *
 * 只有 judger 能宣布完成(phase_done)。worker 连续失败三次,第四次不干活、改为反省,
 * judger 读完反省改写要求和检查项,再给一批。第二次走到反省就停下,交给用户。
 *
 * 每个方框都是一次 new Agent(...),各自的历史、工具、系统提示。worker 每一轮都换一段新的
 * 历史并重新注入用户原话 —— 截断只钉住最近一条用户文字消息(history.mjs),指望 worker
 * 从早期历史里翻回原始需求是靠不住的。
 */

const FAILS_PER_BATCH = 3;
const MAX_BATCHES = 2;
const ROLE_ROUNDS = 60;
const RETRIES = 2;
const WORKER_MIN_ROUNDS = 60;

/** 和 runners/api.mjs 判「可续跑」用的是同一套:超时类的错误才重试 */
const isTimeout = (err) => err?.name === 'TimeoutError' || /timeout|timed out|aborted due to timeout|没有收到任何数据/i.test(String(err?.message || ''));

/** 记录型工具:模型调一次就把参数存下来,本回合的结论就是它 */
function recorder(name, description, inputSchema) {
  const box = { value: null };
  const tool = {
    name, description, inputSchema,
    async execute(input) {
      if (box.value) return { ok: false, error: '这一回合已经交过了,不要重复调用。用一句话收尾即可。' };
      box.value = { name, input };
      return { ok: true, recorded: true, next: '已记录。本回合到此结束,不要再调用任何工具,用一句话收尾即可。' };
    },
  };
  return { tool, box };
}

const str = (description) => ({ type: 'string', description });

function verdictTools() {
  const done = recorder('phase_done', '宣布这条片子通过、环路结束。只有四条项目要求都有依据证明达到时才调用。', {
    type: 'object', properties: { summary: str('四条项目要求各自的依据') }, required: ['summary'],
  });
  const revise = recorder('request_revision', '判定这次交付不通过,把逐条裁定和下一轮要求交给 worker。', {
    type: 'object',
    properties: {
      rulings: {
        type: 'array',
        description: '对 reviewer 每一条意见的裁定',
        items: {
          type: 'object',
          properties: {
            opinion: str('reviewer 的那条意见(可以缩写)'),
            verdict: { type: 'string', enum: ['采纳', '驳回', '降级'], description: '采纳 / 驳回 / 降级' },
            reason: str('为什么这样裁定'),
          },
          required: ['opinion', 'verdict', 'reason'],
        },
      },
      requirements: str('给 worker 的下一轮要求,只来自采纳和降级的条目'),
      reviewerBrief: str('(可选)改写后的检查项'),
    },
    required: ['rulings', 'requirements'],
  });
  const user = needUserTool();
  return { tools: [done.tool, revise.tool, user.tool], boxes: [done.box, revise.box, user.box] };
}

function needUserTool() {
  return recorder('need_user', '遇到必须由用户处理或决定的事(扫码登录、验证码、需要拍板),说明原因后停下。', {
    type: 'object', properties: { reason: str('要用户做什么') }, required: ['reason'],
  });
}

function planTool() {
  return recorder('issue_plan', '交出给 worker 的任务要求和给 reviewer 的检查项。', {
    type: 'object',
    properties: {
      requirements: str('给 worker 的任务要求,逐条写清验收标准'),
      reviewerBrief: str('给 reviewer 的检查项,每项写明用什么工具、看什么、什么算不合格'),
      lessons: { type: 'array', items: { type: 'string' }, description: '(改写时)你认可的教训,一条一句' },
    },
    required: ['requirements', 'reviewerBrief'],
  });
}

function reviewTool() {
  return recorder('submit_review', '交出全部审查意见。没有问题就交空列表。', {
    type: 'object',
    properties: {
      opinions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { issue: str('问题是什么'), evidence: str('依据:哪个工具、哪个时刻 t、看到了什么') },
          required: ['issue', 'evidence'],
        },
      },
    },
    required: ['opinions'],
  });
}

const ROLE_LABEL = { judger: 'judger', worker: 'worker', reviewer: 'reviewer' };

/**
 * 把环路的原始事件翻成聊天栏认得的那几种(text / thinking / status / progress …),前端不用改:
 * - 阶段切换、每次裁决 → status 行,裁决逐条列出来,用户一眼看到为什么没过;
 * - reviewer / judger 说的话 → thinking(折叠区),不混进回复正文;
 * - worker 的交货和环路的最终结论 → text;
 * - progress 的文字前面加上角色。
 */
export function presentLoopEvent(ev) {
  if (ev.type === 'loop') {
    const role = ROLE_LABEL[ev.role] || '';
    switch (ev.stage) {
      case 'plan': return [{ type: 'status', text: '审查环路 · judger 正在看工程,定任务要求和检查项' }];
      case 'work': return [{ type: 'status', text: `worker 开始第 ${ev.attempt} 次交付${ev.batch > 1 ? `(第 ${ev.batch} 批)` : ''}` }];
      case 'review': return [{ type: 'status', text: 'reviewer 正在按检查项审查' }];
      case 'verdict': {
        if (ev.verdict === 'phase_done') return [{ type: 'status', text: 'judger:通过' }];
        if (ev.verdict === 'need_user') return [{ type: 'status', text: 'judger:需要你来决定' }];
        if (ev.verdict !== 'request_revision') return [{ type: 'status', text: 'judger 没有给出裁决,按不通过处理' }];
        const rulings = ev.input?.rulings || [];
        const count = (v) => rulings.filter((r) => r.verdict === v).length;
        return [{
          type: 'status',
          text: [`judger:不通过 —— 采纳 ${count('采纳')} 条、降级 ${count('降级')} 条、驳回 ${count('驳回')} 条`,
            ...rulings.map((r) => `· [${r.verdict}] ${r.opinion} —— ${r.reason}`)].join('\n'),
        }];
      }
      case 'stalled': return [{ type: 'status', text: '连续两次卡在同样的问题上,提前进入反省' }];
      case 'retry': return [{ type: 'status', text: `${role} 这一轮请求网关超时,接着刚才的进度重试(第 ${ev.attempt} 次)` }];
      case 'reflect': return [{ type: 'status', text: 'worker 连续没通过,这一轮不干活,先反省' }];
      case 'rewrite': return [{ type: 'status', text: 'judger 读完反省,正在改写任务要求和检查项' }];
      default: return role ? [] : [];
    }
  }
  if (ev.type === 'text' && (ev.role === 'reviewer' || ev.role === 'judger')) return [{ type: 'thinking', delta: ev.delta, round: ev.round }];
  if (ev.type === 'text' && ev.role === 'loop') return [{ type: 'text', delta: `\n\n${ev.delta}` }];
  if (ev.type === 'progress' && ev.role && ev.text) return [{ ...ev, text: `${ROLE_LABEL[ev.role] || ev.role} · ${ev.text}` }];
  return [ev];
}

const signature = (rulings) => (rulings || [])
  .filter((r) => r.verdict !== '驳回')
  .map((r) => String(r.opinion || '').replace(/\s+/g, ''))
  .sort()
  .join('|');

/**
 * @param {object} o
 * @param {object} o.provider           模型;o.providers 可以按角色覆盖({ worker, reviewer, judger })
 * @param {Array}  o.tools              全部工具(buildTools 的结果)
 * @param {string} o.system             编辑台的系统提示(worker 用)
 * @param {string} o.userText           用户这一条消息
 * @param {object} [o.lessonsStore]     { read(): string[], add(list) } 教训跨运行保存
 * @param {MessageHistory} [o.history]  会话历史:只记用户原话和环路的最终结论,供下一条消息接着聊
 */
export async function runReviewLoop(o) {
  const { tools: allTools, system, userText, signal, onEvent = () => {} } = o;
  const providerFor = (role) => o.providers?.[role] || o.provider;
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const readOnly = P.READ_ONLY_TOOLS.map((n) => byName.get(n)).filter(Boolean);
  /*
   * worker 每轮至少 60 次往返。常规对话的上限是 24,实跑里 worker 第一次交付就撞上它、
   * 在「最后核对画面」之前被截断 —— 而截断出来的半成品正是这个环路要治的病。
   * 深度自主给的更大(或不限)就用那个。
   */
  const workerRounds = Math.max(o.maxIterations ?? 0, WORKER_MIN_ROUNDS);
  const lessons = [...(o.lessonsStore?.read?.() || [])];
  const newLessons = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const toolCounts = {};
  let completed = 0, failed = 0;
  const say = (ev) => onEvent({ type: 'loop', ...ev });

  async function runAgent(role, { system: sys, tools, prompt, rounds = ROLE_ROUNDS, history }) {
    const h = history || new MessageHistory({ maxChars: Infinity });
    const agent = new Agent({
      provider: providerFor(role), system: sys, tools, maxIterations: rounds,
      deepAuto: o.deepAuto, maxInputTokens: o.maxInputTokens || 0, signal, history: h,
      onEvent: (ev) => {
        if (role === 'worker' && ev.type === 'tool_call') toolCounts[ev.name] = (toolCounts[ev.name] || 0) + 1;
        onEvent({ ...ev, role });
      },
    });
    /*
     * 上游卡住(闲置超时)时接着这一段历史再请求一次,而不是让异常冒出去结束整个环路。
     * 环路一跑十几分钟,一次网关卡顿就把前面所有角色的进度作废,代价太大。
     * 用户点停止(signal.aborted)不重试;同一个回合最多重试 RETRIES 次。
     */
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await agent.run(attempt === 0 ? prompt : '上一次请求因为网关超时断了。之前的进度都还在,接着刚才停下的地方继续做。');
        break;
      } catch (err) {
        if (signal?.aborted || attempt >= RETRIES || !isTimeout(err)) throw err;
        say({ stage: 'retry', role, attempt: attempt + 1, reason: String(err?.message || err) });
      }
    }
    for (const k of Object.keys(usage)) usage[k] += Number(res.usage?.[k]) || 0;
    completed += res.completed || 0; failed += res.failed || 0;
    return { ...res, history: h };
  }

  /** judger 回合:必须交出 boxes 里的某一个;没交就推一次,再不交返回 null */
  async function judgerTurn(stage, prompt, extraTools, boxes) {
    say({ stage, role: 'judger' });
    const sys = P.judgerSystem({ lessons: [...lessons, ...newLessons] });
    const tools = [...readOnly, ...extraTools];
    const first = await runAgent('judger', { system: sys, tools, prompt });
    let hit = boxes.find((b) => b.value);
    if (!hit) {
      await runAgent('judger', { system: sys, tools, prompt: '你还没有调用规定的工具交出结论。现在就调用。', history: first.history });
      hit = boxes.find((b) => b.value);
    }
    return hit ? hit.value : null;
  }

  const finish = (outcome, text) => {
    if (newLessons.length) o.lessonsStore?.add?.(newLessons);
    if (o.history) {
      o.history.appendUserText(userText);
      o.history.append({ role: 'assistant', content: [{ type: 'text', text }] });
    }
    say({ stage: 'done', outcome });
    onEvent({ type: 'text', delta: text, role: 'loop' });
    return { outcome, text, usage, completed, failed, lessons: newLessons };
  };

  // ── judger 开场 ──
  const opening = planTool();
  const plan = await judgerTurn('plan', P.judgerOpenPrompt({ userText }), [opening.tool], [opening.box]);
  if (!plan) return finish('no_plan', 'judger 没能给出任务要求和检查项,环路没有开始。可以换个说法再发一次。');
  let requirements = plan.input.requirements;
  let brief = plan.input.reviewerBrief;

  const reflections = [];
  for (let batch = 1; batch <= MAX_BATCHES; batch++) {
    const verdicts = [];
    let prevSig = null;

    while (verdicts.length < FAILS_PER_BATCH) {
      // ── worker ──
      say({ stage: 'work', role: 'worker', batch, attempt: verdicts.length + 1 });
      const nu = needUserTool();
      const workerTools = [...allTools.filter((t) => !['phase_done', 'request_revision', 'issue_plan', 'submit_review', 'need_user'].includes(t.name)), nu.tool];
      const work = await runAgent('worker', {
        system: system + P.WORKER_RULES, tools: workerTools, rounds: workerRounds,
        prompt: P.workerPrompt({ userText, requirements, lessons: [...lessons, ...newLessons] }),
      });
      if (nu.box.value) return finish('need_user', `需要你处理:${nu.box.value.input.reason}`);
      const delivery = work.text;

      // ── reviewer ──
      say({ stage: 'review', role: 'reviewer' });
      const rv = reviewTool();
      const review = await runAgent('reviewer', {
        system: P.REVIEWER_SYSTEM, tools: [...readOnly, rv.tool],
        prompt: P.reviewerPrompt({ brief, userText, delivery }),
      });
      const opinions = rv.box.value?.input?.opinions
        ?? (review.text?.trim() ? [{ issue: review.text.trim(), evidence: '(reviewer 没有按格式提交,这是它的原文)' }] : []);

      // ── judger 裁决 ──
      const vt = verdictTools();
      const verdict = await judgerTurn('verdict', P.judgerVerdictPrompt({ userText, requirements, delivery, opinions }), vt.tools, vt.boxes);
      say({ stage: 'verdict', role: 'judger', verdict: verdict?.name || 'none', input: verdict?.input });

      if (verdict?.name === 'phase_done') {
        return finish('passed', `judger 判定通过。\n\n${verdict.input.summary}`);
      }
      if (verdict?.name === 'need_user') {
        return finish('need_user', `judger 需要你决定:${verdict.input.reason}`);
      }
      const rulings = verdict?.input?.rulings || [{ opinion: '(无)', verdict: '采纳', reason: 'judger 未裁决' }];
      verdicts.push({ rulings, requirements: verdict?.input?.requirements || requirements });
      if (verdict?.input?.requirements) requirements = verdict.input.requirements;
      if (verdict?.input?.reviewerBrief) brief = verdict.input.reviewerBrief;

      // 连续两次裁决的缺口一模一样:卡住了,不等满三次,提前反省
      const sig = signature(rulings);
      if (sig && sig === prevSig) { say({ stage: 'stalled', role: 'judger' }); break; }
      prevSig = sig;
    }

    // ── worker 反省(不给工具) ──
    say({ stage: 'reflect', role: 'worker', batch });
    const reflect = await runAgent('worker', { system: system + P.WORKER_RULES, tools: [], prompt: P.reflectPrompt({ verdicts, toolCounts }) });
    reflections.push(reflect.text);

    if (batch === MAX_BATCHES) {
      const last = verdicts[verdicts.length - 1];
      return finish('exhausted', [
        `这条片子两批都没通过 judger 的裁决,环路停下,交给你判断。`,
        '', '最后一次裁决:',
        ...(last?.rulings || []).map((r) => `- [${r.verdict}] ${r.opinion} —— ${r.reason}`),
        '', ...reflections.map((r, i) => `第 ${i + 1} 次反省:\n${r}`),
      ].join('\n'));
    }

    // ── judger 改写 ──
    const rewrite = planTool();
    const plan2 = await judgerTurn('rewrite', P.judgerRewritePrompt({ userText, reflection: reflect.text, verdicts }), [rewrite.tool], [rewrite.box]);
    if (plan2) {
      requirements = plan2.input.requirements;
      brief = plan2.input.reviewerBrief;
      for (const l of plan2.input.lessons || []) if (l && !newLessons.includes(l)) newLessons.push(l);
    }
  }
  return finish('exhausted', '环路结束。');
}
