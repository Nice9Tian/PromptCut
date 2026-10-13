/**
 * 任务进程设置里 `tools` 一节认哪些键(0.7.18「云端 Agent 工具表接线」)。
 *
 * 这一节两处要核:root 入口读自己的配置时(`account-root-slots.mjs`),任务进程读 root 写给它的设置时(`account-task-worker-config.mjs`)。
 * 两处用的是**这一张名单、这一个函数**:键写错了 root 在启动时就拒绝并指出是哪个键,不会出现「root 起得来、每一代任务进程都拒绝启动」。
 *
 * 本文件不引用别的模块(root 入口以 root 执行它,不让它把工具那一大串代码带进 root 进程)。
 * 各键的含义与读法在 `server/agent/service/account-tools.mjs` 的 `readAccountToolConfig`;部署说明在 `server/hosted/deploy/README.md`。
 */

/** 设置文件里 `tools` 一节认的键(部署者写;都是这台节点上的路径与开关,不是模型给的) */
export const ACCOUNT_TOOL_SETTING_KEYS = Object.freeze([
  'PROMPTCUT_FFMPEG', 'PROMPTCUT_FFPROBE',
  'PROMPTCUT_AGENT_SHOTS_PYTHON', 'PROMPTCUT_AGENT_SHOTS_MODELS', 'PROMPTCUT_AGENT_SHOTS_PYLIBS',
  'PROMPTCUT_AGENT_SUBJECT_PYTHON', 'PROMPTCUT_AGENT_SUBJECT_MODELS', 'PROMPTCUT_AGENT_SUBJECT_PYLIBS',
  'PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS', 'PROMPTCUT_AGENT_SUBJECT_WHEELHOUSE',
  'PROMPTCUT_AGENT_STT_PYTHON', 'PROMPTCUT_AGENT_STT_MODELS', 'PROMPTCUT_AGENT_STT_PYLIBS',
  'PROMPTCUT_AGENT_STT_REQUIREMENTS', 'PROMPTCUT_AGENT_STT_INDEX_URL',
  'PROMPTCUT_AGENT_TRACK_PYTHON', 'PROMPTCUT_AGENT_TRACK_MODELS', 'PROMPTCUT_AGENT_TRACK_PYLIBS',
  'PROMPTCUT_AGENT_BROWSER', 'PROMPTCUT_AGENT_BROWSER_ARGS',
  'PROMPTCUT_AGENT_COLLECT_PYTHON',
  // 代下(请发起人的电脑用他本机的登录态替云端下载):缺省不开,写 '1' 才开。桌面版代下时给不给提示、提示什么还没定,定了再开
  'PROMPTCUT_AGENT_COLLECT_DELEGATE',
  'PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES',
]);

/**
 * 形状检查:只许上面列的键,值都是不带换行的非空字符串。回整理过的那一份;不合规矩抛错(入口据此拒绝启动),
 * 错误上带 `key`(是哪个键)。路径在不在、值的取值范围由任务进程读配置时再核(`readAccountToolConfig`)。
 */
export function validateAccountToolSettings(tools) {
  const bad = (key, message) => { throw Object.assign(new Error(message), { code: 'account-worker-settings-tools', key }); };
  if (tools === undefined || tools === null) return {};
  if (typeof tools !== 'object' || Array.isArray(tools)) bad(null, 'tools 要是一个对象');
  const out = {};
  for (const [key, value] of Object.entries(tools)) {
    const name = String(key).slice(0, 80);
    if (!ACCOUNT_TOOL_SETTING_KEYS.includes(key)) bad(name, `tools 里的 ${name} 不认(键名写错了,或这一版没有这个键)`);
    if (typeof value !== 'string' || !value || value.length > 2000 || /[\r\n\0]/.test(value)) bad(name, `tools 里的 ${name} 的值不对(要是不带换行的非空字符串)`);
    // 不用看这台机器就能判的取值也在这里核(路径在不在要看任务用户那一侧,由任务进程读配置时核)
    if (key === 'PROMPTCUT_AGENT_COLLECT_DELEGATE' && !['0', '1'].includes(value)) bad(name, `tools 里的 ${name} 只能是 0 或 1`);
    if (key === 'PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES' &&
        value.split(',').map((part) => part.trim()).filter(Boolean).some((part) => !ACCOUNT_WORKFLOW_STAGES.includes(part)))
      bad(name, `tools 里的 ${name} 只能是 ${ACCOUNT_WORKFLOW_STAGES.join('、')} 里的几个,用逗号隔开`);
    out[key] = value;
  }
  return out;
}

/** 一键流程的阶段名(`PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES` 的取值) */
export const ACCOUNT_WORKFLOW_STAGES = Object.freeze(['transcribe', 'shots', 'subjects', 'compose', 'prerender']);
