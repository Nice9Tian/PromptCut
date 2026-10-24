/**
 * 0.7.23 新进来的验收项（照 `v22-manifest.mjs` 的写法，字段含义见 `four-stage-manifest.mjs` 文件头）。
 *
 * 这一版合入四条分支（都在 0.7.22 发出去之后、用户当天逐条定的）：
 *
 *   claude/thumb-opens-classic  「最近项目」那一排的缩略图卡片点下去直接进传统式（用户圈图定）
 *   claude/guest-one-chat        游客每个项目只能开一条 Agent 对话，服务端在建对话的事务里就拒
 *   claude/av-card-speed-sound   声画一体卡挂在变速素材段上照常出声（用户「出声。」，推翻〔裁〕V21-28）
 *   claude/groups-local-cloud    分组拆成本地与云端两套，云端那套存云端（〔裁〕V22-05～10）
 *
 * 前两条由单元测试覆盖（`guest-one-chat*.test.mjs`、`orgRealm.test.mjs` 等，随 G0 全量跑），
 * 这里只登记要单独起服务、G0 跑不到的那一支探针，另两支写明为什么不进整套。
 */
import '../lib/no-user-dirs.mjs';

const node = 'node';
const probe = (name, args = []) => [node, `scripts/probes/${name}.mjs`, ...args];

/** 0.7.23 的一支探针 */
function PR23(id, name, script, args, o = {}) {
  const { where = 'local', known, timeoutMin = 30, needs, covers } = o;
  return {
    id, name, category: 'V23', level: 'local',
    taskRef: o.taskRef || '0.7.23 发版（docs/reports/REPORT-021.md「0.7.23」一节）',
    where, tasks: [], cmd: probe(script, args), requires: [`scripts/probes/${script}.mjs`],
    covers: covers || [`${script}.mjs`],
    ...(known ? { known } : {}), ...(needs ? { needs } : {}),
    pass: { exit: 0 }, timeoutMin,
  };
}

/** 不进整套的探针文件与原因（`--check-coverage` 对照；并进 `four-stage-manifest.mjs` 的 EXCLUDED_PROBE_FILES） */
export const V23_EXCLUDED = {
  'av-card-speed-1x-compare.mjs': '声画一体卡出声那次改动的**一次性前后对账件**（`claude/av-card-speed-sound`）：拿改动前的提交当基准，逐项比 1 倍时的卡图、舞台清单、卡片时钟、身份、播放偏移和两条混音路，证明「不变速的项目一个字都没变」。对账做完即无用，照 `gl-migrate-compare` 的先例不进整套。2026-10-23 的读数是 14/14 逐项相同（另有既有的 `clip-speed-key-compare` 57/57），证据在 docs/archive/agent-reports/AGENT-claude-av-card-speed-sound.md',
};

export const V23_ITEMS = [
  // 这一支要一台**在线浏览器模式**的 dev server(`VITE_PC_ONLINE=1`),共享的那台 `dev` 不是,所以点名要 `dev-online`
  // (`four-stage-acceptance.mjs` 的服务表,缺省 5970～5972)。探针再占一个端口当服务端(5973)。
  // 2026-10-23 之前因为起不到这样一台而进不了整套,现在能跑了。
  PR23('V23-groups-cloud', '云端分组走真服务端:两台设备(两个隔离的浏览器上下文)登同一个账号,甲建的分组乙直接看得见;两台各改一处后收敛到同一份;老服务端 404 时界面不报错、改口成「暂时只记在这台浏览器里」;云端 503 时出「云端分组没同步上」、恢复后自动补上',
    'vibe-groups-cloud-probe', ['--url', '{dev-online.origin}', '--api-port', '5973', '--out', '{item}'],
    { needs: ['dev-online'], timeoutMin: 30,
      known: '要在线模式的 dev server(服务名 dev-online,缺省 5970～5972);探针自己再起一个服务端占 5973' }),
  PR23('V23-av-card-sound', '声画一体卡挂在变速素材段上照常出声（导出后测主频：1× 440、2× 880、0.5× 220 Hz；切开 2× 段后两半共用同一份 WAV、不用重新生成；切点前后卡的画面不跳）',
    'av-card-speed-sound-probe', ['--port', '5940'],
    { timeoutMin: 30, known: '自己起开发服务器与导出，端口 5940 起；带 PROMPTCUT_NO_PORT_FILE=1 跑' }),
];
