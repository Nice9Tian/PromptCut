/**
 * 0.7.18 验收的清单项(数据)。底本 `docs/reports/ACCEPT-018-map.md`(第 2 节 38 行总表、第 3 节新增的测试与探针、第 4 节命令清单、第 6～9 节明细)。
 * 由 `four-stage-manifest.mjs` 接进总清单;字段含义见那个文件的头与 `acceptance-lib.mjs` 的 validateManifest。0.7.18 新增的字段:
 *   rows        这一项是 38 行里哪几行的依据(行号见 v18-rows.mjs)
 *   where       在哪能跑:local 本机就能跑 / installer 要安装包 / node 要部署到节点以后 / network 要真实网络 / manual 要人工看 / wait 等某条分支合入 / na 不适用
 *   waitFor     where 为 wait 时写等哪条分支(那条分支上的文件现在不在 main,命令先按地图写;合入后文件在了,这一项自己就会跑)
 *   notApplicable  不适用(依据);requiresEnv  要先设的环境变量(没设记「跑不了」,不让用到账号后端的测试悄悄整文件跳过)
 *   pass.skipAllow 全量测试的跳过名单;pass.todoFail 有失败的 todo(已知不成立的断言)就不过
 *
 * 端口:0.7.18 的项都用一段连着的端口,起点 V = 28990(`--v18-port-base <N>` 或环境变量 PC_V18_PORT_BASE 换),各项依次(串行)用,不同时占。
 * 老入口(房间号加口令)已废的项见文件末尾的 STALE_OLD_ENTRY。
 */
import '../lib/no-user-dirs.mjs';

const node = 'node';
export const V = Number(process.env.PC_V18_PORT_BASE) || 28990;
const port = (n = 0) => String(V + n);
const ACCOUNT_ENV = ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE'];
const TEST_OK = '最终结果[:：]零失败';
const TESTS = (files) => [node, 'scripts/test-suite.mjs', ...files];
const probe = (name, args = []) => [node, `scripts/probes/${name}.mjs`, ...args];
const MAP = 'ACCEPT-018-map.md';

/** 全量测试(npm test)里允许被跳过的测试:名字(spec 报告器里的原文)、所在文件、为什么跳过。多出名单以外的一条,G0-2 就不过 */
export const G0_2_SKIPS = [
  { name: '恢复遍历遇symlink明确拒绝，不跟随到其它目录', file: 'server/test/asset-project-publication-durability.test.mjs', platforms: ['win32'], kind: '平台不符', why: 'Windows 本轮不请求 symlink 权限;测试自己说「Linux 包装运行实际验证」' },
  { name: 'POSIX database and parent-directory permissions stay private without changing existing shared directories', file: 'server/test/cloud-tool-jobs.test.mjs', platforms: ['win32'], kind: '平台不符', why: 'Windows 的文件权限位不算 POSIX 权限证据' },
  { name: '集成:/api/cards/layout 对真实项目返回整数框', file: 'server/test/cards-layout.test.mjs', kind: '本来该跑却被无声跳过', why: '没设 PC_STAGE_TEST_URL(要一台开着的 dev server)就跳过,而且没写原因;清单里 G0-6 专门起 dev server 设好变量把它跑一遍' },
  { name: 'real speech: Chinese wav and an English video transcribe through the whole chain', file: 'server/test/cloud-tools-p2-stt-real.test.mjs', kind: '缺外部依赖', why: 'out/p2-stt/pylibs 里没有 faster_whisper(先跑 cloud-tools-p2-stt-probe.mjs --setup,要把主工作区装好的依赖复制过来)' },
  { name: 'real environment answers: weights missing, engine missing, no audio track, image', file: 'server/test/cloud-tools-p2-stt-real.test.mjs', kind: '缺外部依赖', why: '同上' },
  { name: 'real cancel: a fence while the engine is decoding really ends the child, the job is cancelled, nothing is written', file: 'server/test/cloud-tools-p2-stt-real.test.mjs', kind: '缺外部依赖', why: '同上' },
  { name: 'real timeout: the engine is stopped at the limit and the job ends as TIMEOUT', file: 'server/test/cloud-tools-p2-stt-real.test.mjs', kind: '缺外部依赖', why: '同上' },
  { name: 'real install job: pip runs with the node-configured locked requirements file, not with anything from the model', file: 'server/test/cloud-tools-p2-stt-real.test.mjs', kind: '缺外部依赖', why: '要 P2_PIP=1 加联网与 pip,会下载依赖' },
  { name: 'real short clip: speech → shots → subjects → captions and cards in the project → prerender publish, every stage reported', file: 'server/test/cloud-tools-p5-real.test.mjs', kind: '缺外部依赖', why: '转写依赖 out/p2-stt/pylibs 里没有 faster_whisper' },
  { name: 'real chain, a dependency not ready: subjects cannot run (no onnxruntime in this Python) → the flow stops there, shots stay done, the project gets nothing', file: 'server/test/cloud-tools-p5-real.test.mjs', kind: '缺外部依赖', why: '同上' },
  { name: 'real chain, stopped mid-transcription (host path): the Python process is really gone, the flow never moves on, nothing is committed', file: 'server/test/cloud-tools-p5-real.test.mjs', kind: '缺外部依赖', why: '同上' },
  { name: 'real chain, the service shuts down mid-run, then comes back: "interrupted" at the right stage; a new call finishes the job', file: 'server/test/cloud-tools-p5-real.test.mjs', kind: '缺外部依赖', why: '同上' },
];

/** 一项测试文件的通过标准:零失败、零跳过(除名单)、没有失败的 todo */
const testPass = ({ skipAllow = null, todoFail = true } = {}) => ({
  exit: 0, must: [TEST_OK],
  metrics: { tests: 'ℹ tests (\\d+)', pass: 'ℹ pass (\\d+)', fail: 'ℹ fail (\\d+)', skipped: 'ℹ skipped (\\d+)' },
  limits: { fail: { eq: 0 }, ...(skipAllow ? {} : { skipped: { eq: 0 } }) },
  ...(skipAllow ? { skipAllow } : {}), todoFail,
});

/**
 * 一组测试文件(npm test -- 文件…):account=true 要账号后端的两个环境变量;requires 自动取文件名,缺了记 missing(或 wait 的记 waiting)。
 */
function T(id, name, rows, files, o = {}) {
  const { account = false, where = 'local', waitFor, known, env, timeoutMin = 20, skipAllow, todoFail = true, optional, needs, prereq, taskRef } = o;
  return {
    id, name, category: 'V18', level: 'local', taskRef: taskRef || `${MAP} ${rows.join('、')}`, rows, where, ...(waitFor ? { waitFor } : {}),
    tasks: [], cmd: TESTS(files), requires: files.filter((f) => !/[*]/.test(f)), ...(account ? { requiresEnv: ACCOUNT_ENV } : {}),
    ...(env ? { env } : {}), ...(known ? { known } : {}), ...(optional ? { optional } : {}), ...(needs ? { needs } : {}), ...(prereq ? { prereq } : {}),
    pass: testPass({ skipAllow, todoFail }), timeoutMin,
  };
}

/** 一支探针 */
function PR(id, name, rows, script, args, o = {}) {
  const { where = 'local', waitFor, known, env, timeoutMin = 30, account = false, needs, prereq, covers, optional, must = [], extra = {}, taskRef, timing } = o;
  return {
    id, name, category: 'V18', level: 'local', taskRef: taskRef || `${MAP} ${rows.join('、')}`, rows, where, ...(waitFor ? { waitFor } : {}),
    tasks: [], cmd: probe(script, args), requires: [`scripts/probes/${script}.mjs`], covers: covers || [`${script}.mjs`],
    ...(account ? { requiresEnv: ACCOUNT_ENV } : {}), ...(env ? { env } : {}), ...(known ? { known } : {}), ...(optional ? { optional } : {}),
    ...(needs ? { needs } : {}), ...(prereq ? { prereq } : {}), ...(timing ? { timing: 'record', timingNote: timing } : {}),
    pass: { exit: 0, must, ...extra }, timeoutMin,
  };
}

/** 不在这台机器上跑、也不是人工看的:要部署到节点以后 / 要真实网络 */
const REMOTE = (id, name, rows, where, how, o = {}) => ({
  id, name, category: 'V18', level: 'network', taskRef: o.taskRef || `${MAP} ${rows.join('、')}`, rows, where, tasks: [], remoteOnly: how, ...(o.known ? { known: o.known } : {}), ...(o.covers ? { covers: o.covers } : {}),
});
/** 要人工看 / 要安装包(脚本不跑,写明怎么验) */
const MANUAL = (id, name, rows, where, how, o = {}) => ({
  id, name, category: 'V18', level: 'local', taskRef: o.taskRef || `${MAP} ${rows.join('、')}`, rows, where, tasks: [], manual: how, ...(o.waitFor ? { waitFor: o.waitFor } : {}), ...(o.known ? { known: o.known } : {}),
});
const NA = (id, name, rows, why) => ({ id, name, category: 'V18', level: 'local', taskRef: `${MAP} ${rows.join('、')}`, rows, where: 'na', tasks: [], notApplicable: why });

const VISU = '{visuhive}';
const DIST = '{dist}';

export const V18_ITEMS = [
  /* ============================== 账号认证与隔离(组 auth)============================== */
  T('V18-auth-credentials', '内部核对口与凭证:无证书/假证书/别的服务身份/明文都被拒;日志与数据目录无秘密;恢复凭证可撤销;名称与密码同文案;网站与编辑器共用限次数', ['2.1-1', '2.1-13'],
    ['server/test/accept-018-auth-credentials.test.mjs'], { account: true, env: { ACCEPT018_AUTH_PORT_BASE: port(0) } }),
  T('V18-auth-account-path', '账号路径服务端:新建前必须登录、创建者归账号、换设备仍是创建者、两张列表按账号分、被踢两设备都 403', ['2.1-1', '2.1-2', '2.1-21'],
    ['server/test/accept-018-auth-account-path.test.mjs'], { account: true, env: { ACCEPT018_AUTH_PORT_BASE: port(0) } }),
  T('V18-auth-agent-path', '账号模式真实 Agent 全链:五个账号六七个项目,独立入口、隔离、额度与用量', ['2.3-3', '2.3-4', '2.3-7'],
    ['server/test/accept-018-auth-agent-path.test.mjs'], { account: true, env: { ACCEPT018_AUTH_PORT_BASE: port(0) } }),
  T('V18-auth-start-page', '在线开始页(未登录首屏)服务端渲染', ['2.1-21'], ['server/test/accept-018-auth-start-page.test.mjs'], { known: '静态首屏,不是真浏览器;登录后的整页与两窗口互看要真浏览器探针(V18-account-pages-probe)' }),
  T('V18-account-core', '账号后端与文档服务核心用例(账号库无项目表、被踢、两张列表、证明签发、新建口子、成员控制、两页互看)', ['2.1-1', '2.1-2', '2.1-8', '2.1-21', '2.3-4'],
    ['server/test/account-projects-provider.test.mjs', 'server/test/account-dual-user-path.test.mjs', 'server/test/account-member-controls.test.mjs', 'server/test/account-assembly-central.test.mjs',
      'server/test/account-create-policy.test.mjs', 'src/account/client.test.mjs', 'src/account/assetTicket.test.mjs'], { account: true, timeoutMin: 30 }),
  T('V18-credentials-support', '内部口、安装计划、部署配置与桌面保管凭证的单测', ['2.1-13'],
    ['server/test/account-assembly-run-internal.test.mjs', 'server/test/account-v2-install-plan.test.mjs', 'server/test/account-v2-deploy-config.test.mjs', 'src/account/desktopVault.test.mjs'], { account: true }),
  PR('V18-asset-isolation', '素材按项目隔离(账号模式,真账号后端、真文档服务、独立素材进程)', ['2.3-4'], 'asset-account-isolation-probe', ['--base-port', port(0), '--out', '{item}'],
    { account: true, must: ['"passed":\\s*\\d+', '"failed":\\s*0'], timeoutMin: 30, known: '探针自己说不含轨道流与渲染工作进程的按项目隔离(那两处归块十一,等渲染重构)' }),
  T('V18-tools-isolation', '工具的出网限制与子进程隔离(网页采集不能访问回环与内网、spawn 关闭与隔离)', ['2.3-4', '2.1-20'],
    ['server/test/cloud-agent-egress.test.mjs', 'server/test/cloud-tools-w1-egress.test.mjs', 'server/test/cloud-agent-spawn-disabled.test.mjs', 'server/test/cloud-tools-spawn-isolation.test.mjs', 'server/test/cloud-tools-spawn-tree.test.mjs']),
  PR('V18-account-pages-probe', '账号网页与项目列表的真浏览器探针(登录、限次数页面、列表可点开、两窗口互看)', ['2.1-1', '2.1-2', '2.1-21'], 'account-user-pages-probe',
    ['--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}'], {
      account: true, needs: ['online-build'], prereq: ['G0-4'], optional: true, timeoutMin: 40,
      known: '端口写死 6340～6342、6388(root 授予的窗口),还要 --fixture-module 指到 VisuHive 那边的固定探针;不在 0.7.18 的端口段里,本次没跑。补页面证据时手工加参数跑',
    }),

  /* ============================== Agent 对话与撤销(组 conv)============================== */
  T('V18-conv-controls', 'Agent 共有/私有、发送者署名、切换、停任务权限、创建者操作被拒、旧授权撤销不误伤;50 个上限与并发创建', ['2.1-3', 'RS18-chat'],
    ['server/test/accept-018-conv-controls.test.mjs'], { account: true, known: 'RS18-chat 的删除子断言要等 claude/v18-chats 合入(见 V18-chats-wait)' }),
  T('V18-conv-readexception', '已读消息撤回例外:改密选退出、被踢、已读/未读/伪造已读、重启后;设备退出选「否」', ['2.1-4', '2.1-5'],
    ['server/test/accept-018-conv-readexception.test.mjs'], { account: true }),
  T('V18-conv-endtoend', '账号模式端到端(改文案、挪片段、调卡片参数、署名、两成员互不串、过期写入被拒)与页面背后的接口(发消息、流式、工具过程、重开、停止)', ['2.3-5', '2.3-6'],
    ['server/test/accept-018-conv-endtoend.test.mjs'], { account: true, timeoutMin: 30 }),
  T('V18-conv-access', '对话访问、已读回执、运行权威(撤销、崩溃)、任务进程生命周期、退出确认、改密用户路径', ['2.1-3', '2.1-4', '2.1-5'],
    ['server/test/agent-access-conversation.test.mjs', 'server/test/agent-access-http.test.mjs', 'server/test/agent-read-control.test.mjs', 'server/test/run-authority-core.test.mjs',
      'server/test/run-authority-crash.test.mjs', 'server/test/account-worker-lifecycle.test.mjs', 'server/test/account-logout-confirmation.test.mjs', 'server/test/account-password-user-path.test.mjs'], { account: true, timeoutMin: 30, known: 'account-password-user-path 写死 6680 段端口、account-logout-confirmation 写死 66xx;机器忙时偶发撞端口,单独重跑' }),
  PR('V18-conv-password-probe', '改密选退出:真浏览器看页面「已退出」与四个服务的真实确认一致', ['2.1-5'], 'accept-018-conv-password-probe',
    ['--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}', '--base-port', port(0)], {
      account: true, needs: ['online-build'], prereq: ['G0-4'], timeoutMin: 20, must: ['"passed":\\s*47', '"completed":\\s*true'],
    }),
  T('V18-cloud-chat-tests', '云端 AI 栏的页面逻辑与接口:对话控制、排队、读撤销、守卫与棘轮、真实任务进程的 SSE', ['2.3-5', '2.1-3'],
    ['src/ai/cloud/cloud-chat.test.mjs', 'src/ai/cloud/account-conversation-controls.test.mjs', 'src/ai/cloud/account-queue.test.mjs', 'src/ai/cloud/account-read-revocation.test.mjs', 'src/ai/cloud/newchat-absent.test.mjs',
      'src/online/c10a-api-guard.test.mjs', 'src/online/onlinePrune.test.mjs', 'server/test/account-real-runner.test.mjs', 'server/test/account-real-runner-sse.test.mjs'], { account: true, timeoutMin: 30, known: 'account-real-runner 一族写死 6700 段端口;机器忙时偶发' }),
  T('V18-undo-tests', '云端 Agent 的改动能被撤销(账号项目里的署名与逆操作)', ['2.3-6'], ['server/test/c65b-agent.test.mjs', 'server/test/c65-undo.test.mjs', 'server/test/c65b-undo.test.mjs', 'server/test/c65b-creator.test.mjs']),
  PR('V18-real-runner-probe', '真实执行器的浏览器探针(两账号登录、新建、共享对话、工具过程可见)', ['2.3-5', '2.3-6'], 'account-real-runner-probe',
    ['--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}'], { account: true, needs: ['online-build'], prereq: ['G0-4'], optional: true, timeoutMin: 20,
      known: '端口写死 6700～6711(夹具 account-real-runner.mjs);不在 0.7.18 的端口段里,本次没跑' }),
  PR('V18-ui-reverse-channel', '反向通道(真浏览器,账号模式):云端 Agent 调 seek / play / pause / get_selection 操作发起人的页面', ['2.1-20', '2.3-6'], 'cloud-agent-ui-probe',
    ['--phases', 'reverse', '--base-port', String(V + 13), '--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}'],
    { account: true, needs: ['online-build'], prereq: ['G0-4'], timeoutMin: 30, covers: [],
      known: '账号模式下现在不通:云端 Agent 回「发起方不在线」,页面没收到要它执行的请求(见 docs/reports/AGENT-v18-runner-list.md「发现的产品问题」);工具表接线在 claude/v18-wire 上做,合入后核这一项' }),
  PR('V18-executor-visible-probe', '任务进程可见性(执行器接上页面)', ['2.3-5'], 'account-executor-visible-probe', ['--out', '{item}'],
    { optional: true, timeoutMin: 15, known: '端口写死 6640～6643;不在 0.7.18 的端口段里,本次没跑' }),
  PR('V18-conv-controls-probe', '对话共有/私有的真浏览器探针(界面证据)', ['2.1-3'], 'account-conversation-controls-probe', ['--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}'],
    { account: true, needs: ['online-build'], prereq: ['G0-4'], optional: true, timeoutMin: 30, known: '夹具断言端口必须在 6620～6639;不在 0.7.18 的端口段里,本次没跑' }),
  PR('V18-queue-pages-probe', '对话消息排队位置的真浏览器探针(不是渲染看画面的队列)', ['2.3-5'], 'cloud-queue-user-pages-probe', ['--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}'],
    { account: true, needs: ['online-build'], prereq: ['G0-4'], optional: true, timeoutMin: 30, known: '端口写死 6528～6531;不在 0.7.18 的端口段里,本次没跑' }),
  PR('V18-newchat-probe', '新开的空对话是安静的(不一直重试事件流、没有断线提示);发第一条消息、刷新、切换、私有化、Agent 服务停掉', ['2.3-5'], 'newchat-events-probe', ['--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}/o'],
    { account: true, needs: ['online-build'], prereq: ['G0-4'], optional: true, timeoutMin: 20, known: '端口写死 28850～28861(不在 0.7.18 的端口段里),本次没跑;配套单测 src/ai/cloud/newchat-absent.test.mjs 在 V18-cloud-chat-tests 里' }),
  PR('V18-move-guard-probe', '「搬到云端」旧流程防呆:账号模式节点上两个入口与「搬回本机」各点一遍(请求、界面原文、本机房间前后状态)', ['2.1-6'], 'move-guard-probe', ['--tag', 'runner'],
    { account: true, optional: true, timeoutMin: 20, known: '端口写死 28950～28989(不在 0.7.18 的端口段里),本次没跑;它把截图与证据写进 docs/reports/assets/v18-move-guard/(会改工作区),所以缺省不跑;配套单测 move-guard.test.mjs 在 V18-local-legacy-tests 里' }),
  PR('V18-consent-probe', '首次使用云端 Agent 告知托管方可读(真浏览器)', ['2.3-5'], 'cloud-agent-consent-user-path-probe', ['--out', '{item}'],
    { optional: true, timeoutMin: 20, known: '端口写死 6650～6659;不在 0.7.18 的端口段里,本次没跑' }),
  PR('V18-member-controls-probe', '成员控制(创建者踢人、关 Agent 开关)的真浏览器探针', ['2.1-2'], 'project-member-controls-probe', ['--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}'],
    { account: true, needs: ['online-build'], prereq: ['G0-4'], optional: true, timeoutMin: 30, known: '端口写死 6560～6571;不在 0.7.18 的端口段里,本次没跑' }),
  MANUAL('V18-gap-stop-immediate', '创建者关开关后正在跑的对话「立刻」停(语义写立刻,账号模式现在是下一个检查点才停)', ['2.3-4'], 'manual',
    '对口径:workflow/project.md 写「立刻停掉」,账号模式在下一个模型或工具检查点停(ACCEPT-018-map 第 6 节 2.3-4.9);主会话看 V18-auth-agent-path 的「停下用时」诊断行,决定口径或补强制关进程的断言'),

  /* ============================== 文件重开、坏文件、缺素材、备份(组 files)============================== */
  T('V18-files-local-regression', '本地项目不要求账号(账号模式开着时局域网自由/限定进入、邀请码、主机/成员照旧)', ['2.1-6'], ['server/test/accept-018-files-local-regression.test.mjs'], { account: true }),
  T('V18-local-legacy-tests', '本地项目的老证据:握手、建项目、成员、邀请码、局域网发现、隔离中继、页面同步与重连', ['2.1-6'],
    ['server/test/auth-handshake.test.mjs', 'server/test/auth-create.test.mjs', 'server/test/auth-members.test.mjs', 'server/test/c10a-invite.test.mjs', 'server/test/invite-impl.test.mjs',
      'server/test/sp-lan.test.mjs', 'server/test/asset-lan-discover.test.mjs', 'server/test/reopen-hosting.test.mjs', 'server/test/move-guard.test.mjs', 'src/editor/sync/presence.test.mjs', 'src/editor/sync/reconnect.test.mjs',
      'src/editor/sync/enterFailure.test.mjs', 'src/editor/sync/onlineSync.test.mjs', 'src/editor/sync/hostedServices.test.mjs'], { timeoutMin: 30, known: '局域网发现是本机替身(回环加单播),不是真实多机组播' }),
  REMOTE('V18-lan-real', '局域网真实组播/子网广播(两台机器)', ['2.1-6'], 'network',
    '要第二台机器:node scripts/probes/shared-project-lan.mjs 与 asset-lan-probe.mjs(按文件头分角色);运行器老清单把它们排除在整套外(要第二台机器)', { known: '本机替身(sp-lan、asset-lan-discover)已在 V18-local-legacy-tests' }),
  T('V18-files-account-fixture', '旧文件内容重开不覆盖云端;备份恢复演练(清单、校验、恢复到新目录、不覆盖)', ['2.1-7', '2.1-14'], ['server/test/accept-018-files-account-fixture.test.mjs'],
    { account: true, known: '备份恢复是方法的演练(仓库里没有备份脚本);恢复副本上真起三个服务和节点当时数据的重做见 V18-backup-node' }),
  MANUAL('V18-gap-file-association', '账号项目保存出来的 .proc 带不带云端关联(功能缺口,要用户定)', ['2.1-7', '2.1-8', '2.1-19'], 'manual',
    '要用户定:账号项目另存为文件再打开,文件里没有「它原来是哪个云端项目」的记号(syncManager.ts enterAccountProject 里 setAssociation(null)),所以「从文件连回原云端项目」「过期转本地的触发」「清理后旧文件验收」都没有可验的路径;见 ACCEPT-018-map 第 1 节问题 9、第 5 节给用户的第 2 条'),
  T('V18-files-proc-damage', '坏文件:截断、空、旧格式、坏关联、未知版本、.procp 损坏与截断、存储不可用、落盘中断', ['2.1-9'], ['server/test/accept-018-files-proc-damage.test.mjs']),
  T('V18-files-recovery-states', '恢复协调器的输入矩阵:超时、故障、未登录、被踢、错误节点 404、凭证撤销;账号项目进入失败的三类提示', ['2.1-9', '2.1-8'], ['server/test/accept-018-files-recovery-states.test.mjs']),
  T('V18-files-old-proc-fixtures', '合成旧文件矩阵(7 份样本)自检', ['2.1-8', '2.1-19'], ['server/test/accept-018-files-old-proc-fixtures.test.mjs'], { known: '只是夹具自检,不能代替 2.1-19 要的清理后真实旧文件' }),
  T('V18-files-missing-voice', '随软件分发的「找不到素材」人声文件与契约一致', ['2.1-12'], ['server/test/accept-018-files-missing-voice.test.mjs'], { known: '第二条只是文本扫描,说服力弱' }),
  T('V18-reopen-recovery', '口令式房间的重开与恢复(25 条:凭证分别保存、重启后绑定连续、限速等待自动重入)', ['2.1-9', '2.1-7'], ['server/test/reopen-recovery.test.mjs'], { known: '口令式房间的证据;账号项目的「从文件重开」没有代码,见 V18-gap-file-association' }),
  T('V18-missing-tests', '缺素材与旧云端文件转本地的单测(证明签发核对、转换、缺失判定、占位、导出)', ['2.1-12', '2.1-8', '2.1-9'],
    ['server/test/cloud-gone-recovery.test.mjs', 'server/test/legacy-gone-proof.test.mjs', 'server/test/gone-trust-source.test.mjs', 'server/test/bakery-missing-media.test.mjs', 'server/test/export-compose.test.mjs',
      'server/test/export-media-url.test.mjs', 'src/audio/missingMaterial.test.mjs', 'src/editor/io/mediaPath.test.mjs', 'src/editor/io/missingMaterials.test.mjs', 'src/editor/io/missingProducer.test.mjs',
      'src/editor/preview/missingMaterials.test.mjs', 'src/editor/sync/cloudGone.test.mjs', 'src/export/browserExport.missing.test.mjs', 'src/render/MissingMaterial.test.mjs'],
    { account: true, where: 'wait', waitFor: 'claude/v18-missing', known: '合入后:把 accept-018-files-recovery-states 的 STATE-4/5 与 proc-damage 的 DMG-6 的 todo 去掉应转绿' }),
  T('V18-missing-bakery-tests', '缺素材:导出混音、缺字体、合成声音的三个 bakery 测试', ['2.1-12'], ['server/bakery/audio-mix.test.mjs', 'server/bakery/export-missing-font.test.mjs', 'server/bakery/mux-audio.test.mjs'],
    { where: 'wait', waitFor: 'claude/v18-missing', known: '这三个在 server/bakery/ 下,不在 npm test 默认扫的范围里,要点名' }),
  PR('V18-missing-probe', '缺素材与旧云端文件转本地(编辑器真浏览器探针:假云端文档服务入口加一台开发服务器)', ['2.1-12', '2.1-8', '2.1-9'], 'v18-missing-probe',
    ['--port', port(0), '--doc-port', port(3), '--dead-port', port(4), '--out', '{item}', '--shots', '{item}/shots'], { where: 'wait', waitFor: 'claude/v18-missing', timeoutMin: 30, covers: [], must: ['"fails":\\s*\\[\\]'], known: '命令照地图抄自分支文件头,没在分支工作区里跑过' }),
  PR('V18-missing-online-probe', '缺素材(在线浏览器:预览占位、人声、在线导出)', ['2.1-12'], 'v18-missing-online-probe',
    ['--dist', DIST, '--base', port(5), '--doc-port', port(8), '--asset-port', port(9), '--shots', '{item}/shots'], { where: 'wait', waitFor: 'claude/v18-missing', needs: ['online-build'], prereq: ['G0-4'], timeoutMin: 30, covers: [], known: '命令照地图抄自分支文件头' }),
  REMOTE('V18-backup-node', '备份恢复在节点当时的数据上重做,并在恢复副本上真起三个服务(原备份保留,未证明恢复不删旧数据)', ['2.1-14'], 'node',
    '部署前在节点上重做:停写、列清单(逐文件字节数与 SHA-256)、校验、恢复到新目录(已存在则拒绝)、起账号/文档/素材三个服务过健康检查;旧证据 docs/archive/three-versions-production-restore-2026-10-09.md 不替代最终提交复验;删旧数据要用户点头'),
  REMOTE('V18-old-files-cleanup', '清理后旧文件验收(节点上先清掉旧项目,再用真实旧文件验转换与提示)', ['2.1-19'], 'node',
    '先要用户点头清掉节点上旧测试项目(0.7.18 到 0.7.20 三个版本可打断旧测试项目);再用清理后的真实旧文件:打开 → 转本地 → 缺素材占位与弹窗(夹具 accept-018-files-old-proc-fixtures.mjs 的 7 份样本演练);依赖 V18-gap-file-association 与 claude/v18-missing 合入'),

  /* ============================== 契约、排队、运行器、发版动作(组 rest)============================== */
  T('V18-ssr-seam', '独立入口对前端代码的依赖只经一处载入缝(扫描 + 棘轮),以及独立入口形态与托管档', ['2.3-2', '2.3-3'], ['server/test/accept-018-rest-ssr-seam.test.mjs', 'server/test/cloud-agent-service.test.mjs'],
    { known: '前半句现状不成立(SEAM-2 todo:闭包里 agent-board、agent-roles、agent-sessions、creativity-gate、vite-plugin-cards 直接引用 src/);CA-SEAM-01 扫得不全' }),
  MANUAL('V18-desktop-shell', '不动桌面壳:核对 desktop/ 的改动是否只来自账号任务', ['2.3-2'], 'manual',
    '命令(只读):git log --oneline release..HEAD -- desktop/ 与 git diff --stat release..HEAD -- desktop/src-tauri/;要的不是「差异为空」(账号任务动了壳:account_vault.rs 等),而是「改动是否只来自账号任务、Agent 服务这条线没碰壳」;外壳版本要不要抬见 V18-installer-compat'),
  T('V18-queue-tests', '单节点排队与看画面:排队、重启不丢、背压、容量、隔离、取消与失败兜底、授权;账号模式看画面接线', ['RS18-queue', 'RS-common'],
    ['server/test/hosted-render-queue.test.mjs', 'server/test/hosted-render-memory.test.mjs', 'server/test/hosted-render-capacity.test.mjs', 'server/test/hosted-render-isolation.test.mjs', 'server/test/hosted-render-look.test.mjs',
      'server/test/hosted-render-usercards.test.mjs', 'server/test/cloud-agent-look.test.mjs', 'server/test/accept-018-rest-queue-account-look.test.mjs'], { timeoutMin: 30, known: 'hosted-render-queue 的 RQ7 在全量里偶发(计时相关),单独重跑' }),
  PR('V18-queue-probe', '云端排队探针(缩短版:空闲 20 秒才让位)', ['RS18-queue', 'RS-common'], 'hosted-render-queue-probe', ['--base-port', port(0), '--doc-port', port(9), '--asset-port', port(10), '--idle-ms', '20000'],
    { timeoutMin: 40, must: ['"fails":\\s*\\[\\]'], known: '14 条检查;机器忙时要十几分钟;idle-ms 缩短只验「满了配置的时长才让位」' }),
  PR('V18-queue-probe-prod', '云端排队探针(生产版:空闲满五分钟才让位,真等)', ['RS18-queue'], 'hosted-render-queue-probe', ['--base-port', port(0), '--doc-port', port(9), '--asset-port', port(10)],
    { optional: true, timeoutMin: 60, covers: [], must: ['"realIdle":\\s*true', '"fails":\\s*\\[\\]'], known: '整趟十几分钟以上,缺省不跑;--include-optional 或 --only V18-queue-probe-prod' }),
  PR('V18-queue-isolation-probe', '渲染隔离探针(越权探测卡,49 项)', ['RS-common', 'RS18-queue'], 'hosted-render-isolation-probe', ['--base-port', port(0), '--doc-port', port(9), '--asset-port', port(10)],
    { timeoutMin: 40, must: ['"fails":\\s*\\[\\]'] }),
  MANUAL('V18-queue-507-wait', '预渲染任务遇到素材服务 507 时留在队列里等、不记失败', ['RS18-queue'], 'wait',
    '没有测试:server/render-node/host.mjs 现在把 507 记成不可重试的失败并暂停认领 10 分钟(块八报告「没做成的」第 3 条),在渲染那一带,等渲染重构合入后做;合入后补一条单测加探针', { waitFor: '渲染重构的后续块' }),
  REMOTE('V18-queue-node-pressure', '真实内存/磁盘压力与 16 GB 节点上的表现;三版本共同回归的度量记录(机器、帧数、素材复杂度、并发、缓存、内存、最终提交、起止点、分位数、>5 分钟尾部原因)', ['RS18-queue', 'RS-common'], 'node',
    '在最终提交加节点(8 核 16 GB)上重跑 RS18 各组并记数;探针只有 6 次样本,算不出分位数;RS-common 在最终提交上没跑出结果之前不计通过'),
  MANUAL('V18-local-first', '本地取帧优先:本地成功、授权/能力/可用性不满足、全部离线、执行中离线、取消、版本切换与迟到结果、播放头不变、云端兜底且单活跃项目', ['RS18-local', 'RS-common'], 'wait',
    '代码没做(块十,等渲染重构),main 上 git grep -nE "本地取帧|本地优先|localFirst|local-first|preferLocal" -- server src 无命中,没有任何测试;合入后要补:选择链的单测加一支要真浏览器的探针(播放头不动)', { waitFor: '块十 本地取帧优先(等渲染重构)' }),
  T('V18-chats-wait', '50 个对话的删除:删后重建/重开、删后立刻让出名额、谁能删、有任务在跑先停再删、满额提示、被删通知', ['RS18-chat'],
    ['server/test/conversation-delete.test.mjs', 'server/test/conversation-delete-http.test.mjs', 'server/test/conversation-delete-running.test.mjs', 'src/ai/cloud/chat-delete.test.mjs'],
    { account: true, where: 'wait', waitFor: 'claude/v18-chats', known: '分支还有一支浏览器探针 conversation-delete-probe(见 V18-chats-probe-wait)' }),
  PR('V18-chats-probe-wait', '云端对话删除与 50 个上限的浏览器探针(三个账号、40 项检查)', ['RS18-chat'], 'conversation-delete-probe', ['--dist', DIST, '--site-root', `${VISU}/site`, '--out', '{item}'],
    { account: true, where: 'wait', waitFor: 'claude/v18-chats', needs: ['online-build'], prereq: ['G0-4'], timeoutMin: 30, covers: [], known: '命令照分支报告抄;分支说夹具放宽了探针端口段,合入后核一下它占哪些端口再接进 --v18-port-base' }),
  {
    id: 'V18-doc-contracts', name: '设计与契约的八项章节都在(身份、实例、全局状态、认证、G、通道、对话记录、资源上限)', category: 'V18', level: 'local', taskRef: `${MAP} 2.3-1`, rows: ['2.3-1'], where: 'local', tasks: [],
    cmd: [node, 'scripts/acceptance/v18-doc-checks.mjs', 'contracts'], requires: ['scripts/acceptance/v18-doc-checks.mjs', 'docs/plan/cloud-agent-contract.md'], pass: { exit: 0, must: ['全部章节都在'] },
    known: '只核章节标题在,不核内容;「先写好再动手」的先后无法事后验,契约 7.2 的旧主人键方案正文没删(只加了说明)',
  },
  {
    id: 'V18-doc-semantics', name: '语义按 E～J 改好(E 云端 Agent 承诺、F 模型、G 上限、H 身份、I 界面范围、J 工具范围)的段落都在', category: 'V18', level: 'local', taskRef: `${MAP} 2.3-10`, rows: ['2.3-10'], where: 'local', tasks: [],
    cmd: [node, 'scripts/acceptance/v18-doc-checks.mjs', 'semantics'], requires: ['scripts/acceptance/v18-doc-checks.mjs', 'docs/semantics/product/agent.md'], pass: { exit: 0, must: ['全部段落都在'] },
    known: '只核段落在;mechanism/agent.md 的「对话归属的主人键」旧机制与现行按账号归属冲突(需主会话改语义文档),契约同步与草稿「步骤 3」出处只核到文件在',
  },
  MANUAL('V18-doc-semantics-judge', '语义 E～J 与契约同步的内容对照(逐句)', ['2.3-10'], 'manual',
    '人工逐句对:product/agent.md、architecture.md、platforms.md、hosting.md 与决定 E～J;c10-contract.md、c10a-contract.md 第 2 节加「Agent 服务 = 同源的 /agent/v1/」(grep -n "agent/v1" docs/plan/c10a-contract.md docs/plan/c10-contract.md);draft_cloud-node-and-agent.md「步骤 3」做完的标出处;mechanism/agent.md 第 79 行「主人键」旧机制要改'),
  T('V18-keys-tests', '模型 Key 的加密分发机制(机器识别码、加密、导入、给别的机器的密文被拒、输出与日志无 Key)', ['2.3-8'], ['server/test/cloud-agent-keys.test.mjs'], { known: '全用假 Key 与临时目录;送到节点、导入、真实模型三遍要节点和真实模型' }),
  T('V18-resource-tests', '节点资源:并发上限(全节点 6 轮、每项目 3、每成员 2)、内存上限的部署模板断言、Agent 服务的部署脚本', ['2.3-9', '2.3-12'], ['server/test/cloud-agent-runs.test.mjs', 'server/test/cloud-agent-wiring.test.mjs'],
    { timeoutMin: 30, known: '满载前后对比的数字只能在节点上测(S4-r1)' }),
  T('V18-tools-tests', '云端 Agent 的工具(与本机一致):作业账本、镜头识别、语音转写、运动追踪、主体识别、一键流程、网页操作、页面反向通道', ['2.1-20'],
    ['server/test/cloud-agent-tools.test.mjs', 'server/test/cloud-tool-jobs.test.mjs', 'server/test/cloud-tool-jobs-retained-worker.test.mjs', 'server/test/cloud-tools-*.test.mjs'],
    { timeoutMin: 40, skipAllow: G0_2_SKIPS.filter((s) => /cloud-tool/.test(s.file)), known: '真实依赖的集成测试(转写、一条龙)在没备依赖时整条跳过,名单见 G0_2_SKIPS;备依赖要 cloud-tools-p2-stt-probe.mjs --setup(复制主工作区已装好的依赖,P2_PIP 那条要联网)' }),
  MANUAL('V18-wire-wait', '云端 Agent 工具表接线(G 第一期):把八个已合入的工具包接进云端工具表', ['2.1-20'], 'wait',
    '分支 claude/v18-wire 还在做(报告只有开工提交);合入后补接线的单测与端到端命令', { waitFor: 'claude/v18-wire' }),
  T('V18-cardsync-wait', '账号云端项目里的用户卡源码同步、卡片声音上传、Agent 一侧旧绑定、连接寿命(令牌到期续)', ['2.3-6', '2.1-20'],
    ['server/test/account-card-link.test.mjs', 'server/test/account-card-sync.test.mjs', 'server/test/account-page-link.test.mjs', 'src/editor/io/generatedAudioUpload.test.mjs', 'src/editor/sync/accountCardSync.test.mjs', 'src/editor/sync/accountLinkLife.test.mjs'],
    { account: true, where: 'wait', waitFor: 'claude/v18-cardsync', known: '分支还有探针 account-card-sync-probe(见 V18-cardsync-probe-wait);分支自己说在线页面拿得到源码但画不出来(舞台取素材票据只认旧形状)' }),
  PR('V18-cardsync-probe-wait', '卡片源码同步与连接寿命(真服务,120 秒令牌下 30/130/250/400 秒各改一次)', ['2.3-6', '2.1-20'], 'account-card-sync-probe', ['--out', '{item}'],
    { account: true, where: 'wait', waitFor: 'claude/v18-cardsync', timeoutMin: 30, covers: [], known: '命令是猜的(分支上的探针文件头才是准),合入后核' }),

  /* ---- 账号层的几支独立探针(操作历史、改密顺序)与 Linux 真系统上的探针 ---- */
  PR('V18-operation-history', '操作历史:完整值、稳定编号、结构版本、其他操作者同值证据、日志重建、账号与文档重启后的检查点保留', ['2.1-3'], 'operation-history-probe', ['--out', '{item}/o'],
    { account: true, timeoutMin: 20, known: '读文件头:要真账号后端;不接生产挂载' }),
  PR('V18-operation-wiring', '页面角色的 WS/project.op(真 Chromium):未封存不可见、可信的 A/B 操作者、完整持久化与历史、重启后同一版本', ['2.1-3'], 'operation-wiring-probe', ['--out', '{item}'],
    { account: true, timeoutMin: 20, optional: true, known: '读文件头:真实 Chromium;端口没读过,第一次跑前先看文件头' }),
  PR('V18-password-order', '改密顺序:33 条崩溃/缺证据情形与真 mTLS/HTTP 封存确认的私有竞态', ['2.1-5'], 'password-order-probe', ['--url', 'http://127.0.0.1:5760', '--out', '{item}/o'],
    { account: true, optional: true, timeoutMin: 20, known: '夹具把端口限死在 5760～5768(scripts/probes/fixtures/password-order/live-fixture.mjs 里抛「Probe owns only isolated loopback ports」),不在 0.7.18 的端口段里,本次没跑;不证明生产挂载' }),
  REMOTE('V18-linux-os-probes', 'Linux 真系统上的探针:任务进程的 root 入口与配置、服务用户/私钥权限、进程组被收掉、cgroup、spawn 与网页采集的隔离演示', ['2.1-13', '2.3-4', '2.3-9', '2.3-12'], 'node',
    '要 Linux(真 systemd、root):在节点临时目录里照文件头跑 account-root-entry-linux.mjs(11 条)、account-task-worker-config-linux.mjs(9 条,sudo --dir)、asset-root-cgroup-os-probe.mjs、agent-run-scope-proof.mjs、cloud-tools-spawn-linux-demo.mjs、cloud-tools-w1-linux-demo.mjs;主会话在 v18-prod 合入时已在节点临时目录里跑过一遍(11/11、9/9),发版前在最终提交上重跑',
    { covers: ['account-root-entry-linux.mjs', 'account-task-worker-config-linux.mjs', 'asset-root-cgroup-os-probe.mjs', 'agent-run-scope-proof.mjs', 'cloud-tools-spawn-linux-demo.mjs', 'cloud-tools-w1-linux-demo.mjs'] }),
  REMOTE('V18-net-public-pages', '公网账号网页探针(创建测试账号、真实公网)', ['2.1-18', '2.1-1'], 'network',
    'node scripts/probes/account-public-user-pages-probe.mjs --dry-preflight --out <新临时目录>,再 --run-public(连真实公网并创建测试账号;部署后做,测试账号验完删)',
    { covers: ['account-public-user-pages-probe.mjs', 'account-hosted-wiring-probe.mjs'] }),

  /* ---- 云端 Agent 工具的独立探针(2.1-20):要备依赖或联网的缺省不跑 ---- */
  PR('V18-tools-p1-shots', '镜头识别工具', ['2.1-20'], 'cloud-tools-p1-shots-probe', [], { optional: true, timeoutMin: 20, known: '要 ffmpeg(scdet);没读过文件头里的端口,第一次跑前先看' }),
  PR('V18-tools-p3-motion', '运动追踪与贴运动', ['2.1-20'], 'cloud-tools-p3-probe', [], { optional: true, timeoutMin: 20, known: '依赖(numpy 等)没备好会说缺什么' }),
  PR('V18-tools-p4-subject', '主体识别', ['2.1-20'], 'cloud-tools-p4-subject-probe', [], { optional: true, timeoutMin: 20, known: '依赖 onnxruntime 等;没备好会说缺什么' }),
  PR('V18-tools-w2-reverse', '发起人页面反向通道(seek、play、pause、get_selection)', ['2.1-20'], 'cloud-tools-w2-probe', ['--shots', '{item}/shots'], { optional: true, timeoutMin: 20 }),
  PR('V18-tools-c1-collect', '网页采集代下(yt_dlp)', ['2.1-20'], 'cloud-tools-c1-probe', [], { optional: true, timeoutMin: 20, known: '先 --setup(把主工作区已装好的 yt_dlp 复制进 out/c1-collect/pylibs,不联网);缺依赖说缺什么并退出码 1' }),
  PR('V18-tools-p2-stt', '语音转写(假脚本单测加真 Python 集成测试,缺依赖就失败不跳过)', ['2.1-20'], 'cloud-tools-p2-stt-probe', [], { optional: true, timeoutMin: 60, known: '先 --setup(复制主工作区已装好的 pylibs 与 small 权重);P2_PIP 那条要联网' }),
  PR('V18-tools-p5-workflow', '一键流程(转写 → 镜头 → 主体 → 字幕与卡片 → 预渲染发布)', ['2.1-20'], 'cloud-tools-p5-workflow-probe', [], { optional: true, timeoutMin: 60, known: '依赖 cloud-tools-p2-stt-probe.mjs --setup 备好的 Python 与 faster-whisper small;镜头要 ffmpeg' }),
  PR('V18-tools-w1-browser', '网页操作(窗口检查 → 五份专用测试 → 公网 → 浏览器自己不解析主机名)', ['2.1-20'], 'cloud-tools-w1-browser-probe', ['--no-public'], { optional: true, timeoutMin: 40, known: '--no-public 不连公网;公网那段(--public)要真实网络' }),

  /* ---- 运行器本身(2.1-15)---- */
  {
    id: 'V18-runner-coverage', name: '运行器的覆盖守门:探针都登记、38 行每行有项、引用的文件在、跳过名单自检', category: 'V18', level: 'local', taskRef: `${MAP} 2.1-15`, rows: ['2.1-15'], where: 'local', tasks: [],
    cmd: [node, 'scripts/acceptance/four-stage-acceptance.mjs', '--check-coverage'], pass: { exit: 0, must: ['守门:通过'] }, timeoutMin: 5,
  },
  T('V18-runner-tests', '运行器的单测(清单自洽、判定、续跑、首败复跑记不稳定、--list / --matrix / 38 行表)', ['2.1-15'], ['server/test/four-stage-acceptance.test.mjs', 'server/test/four-stage-acceptance-v18.test.mjs']),
  MANUAL('V18-release-timings', '发版时整套跑一遍并记 release-timings(首败复跑通过仍报告不稳定)', ['2.1-15'], 'manual',
    '发版动作:node scripts/acceptance/four-stage-acceptance.mjs --rows --out work/four-stage/final/<时间戳> --flaky-rerun 1 --release-timings "0.7.18";把 release-timings-section.md 贴进 docs/reports/release-timings.md;在最终提交上跑,旧结果不替代'),

  /* ---- 安装包与兼容补丁(2.1-16、2.1-17)---- */
  MANUAL('V18-installer-build', '出完整安装包(版本、来源 SHA、文件哈希)', ['2.1-16'], 'installer',
    'git rev-parse HEAD 记来源提交;cd desktop && npm run release -- --from-head(完整安装包与兼容补丁一起出);产物在 desktop/release/:PromptCut-<版本>-setup.exe、PromptCut-patch-<版本>.zip、manifest-<版本>.json;(Get-Item <文件>).Length 与 Get-FileHash -Algorithm SHA256 取大小和哈希;依赖比 0.7.17 多 sucrase,补丁带整份 node_modules(约 196 MB)要提前告诉用户'),
  MANUAL('V18-installer-smoke', '安装后启动、关闭;账号路径(登录、新建云端项目、加入);实际文件关联双击;不覆盖用户运行副本', ['2.1-16'], 'installer',
    '在隔离的安装位置装(不覆盖用户在用的那份):cd desktop && node scripts/smoke-all.mjs <exe 绝对路径>(smoke-boot 加 smoke-shutdown);账号路径走壳上的账号探针(.account-probe 标识);双击 .proc / .procp 看软件打开并进对应项目;安装前后对比用户数据目录与已装副本的哈希(只读)'),
  MANUAL('V18-installer-compat', '兼容补丁:清单/哈希/目标版本/壳要求明确;最低声明壳 0.2.0 与现用壳 0.2.7 的隔离副本上升级、启动、必要账号/文件功能;回退验证;最低声明要不要抬', ['2.1-17'], 'installer',
    '读 desktop/release/manifest-0.7.18.json 与 make-patch.mjs 的 MIN_SHELL_VERSION(0.2.0);做 0.2.0 与 0.2.7 外壳的隔离副本各装补丁、启动、走账号登录与文件关联,再回退;壳新增了 account_vault.rs,判「新的 Node 这一半放到旧壳上能不能照常跑」(grep -rn "account_vault\\|__TAURI__" src/account);不在有 Agent 会话在跑的安装目录上装补丁'),

  /* ---- 真实网络(2.1-18)补充三条,运行器老清单的 16 项网络项另挂 ---- */
  REMOTE('V18-net-cert-proxy', '证书与反代:主站与 s1/s2 的证书有效期;公网上没有内部路径(/hosted/internal/v2/…、/internal/v2/… 回 404)', ['2.1-18', '2.1-13'], 'node',
    'curl -sI https://<域名>/editor;openssl s_client -connect <域名>:443 -servername <域名> | openssl x509 -noout -dates(主站与 s1、s2 各一次);公网请求内部路径回 404'),
  REMOTE('V18-net-reconnect', '延迟与断线重连:加入用时、一次编辑到另一成员看到的用时;在服务器侧断那条 TCP,页面显示断开后自动重连、改动不丢', ['2.1-18'], 'network',
    '无头 Chrome 以成员身份进测试房间;不动宿主机网络(constraints.md),只在服务器侧断 TCP'),
  REMOTE('V18-net-account-limits', '真实地址上的实际限权/退出:踢人对全设备生效、切私有立刻撤、改密退出与重连、旧票据和内部接口被拒、关掉发起方软件后任务继续并且预渲染入库、三个服务是同一个提交', ['2.1-18'], 'node',
    '用账号探针对真实地址跑(account-public-user-pages-probe --run-public 等,改 --site);status-agent、status-render 与页面 __PC_CODE_VERSION__ 对 <SHA>;测试账号与房间验完删'),

  /* ---- 发版动作(2.3-11 的 build、2.3-12、2.3-13)---- */
  MANUAL('V18-release-merge', '合入 main、版本号(package.json 与 package-lock.json 两处 0.7.17 → 0.7.18)、release 判过并推进', ['2.3-12'], 'manual',
    '要用户授权(原则 4);照 git_and_release.md「release 分支」:基线全绿、npm run build 成功、动了桌面壳所以 desktop/ 的发版构建也要成功;git checkout release && git merge --ff-only <发版提交>;快进不了按 release-fallback.md'),
  MANUAL('V18-release-docs', '模板与迁移文档补上 Agent 服务;docs/local.md 记节点上多出的进程与目录', ['2.3-12'], 'manual',
    'ls server/hosted/deploy | grep agent;grep -n "2b. Agent" docs/plan/hosting-migration.md(这两样现在就在);注意 Agent 端口模板里仍是 8790(设计裁定说 8791),account-v2-install-plan.mjs 里没有 Agent;docs/local.md 不入库、含密钥,部署后由主会话记'),
  MANUAL('V18-report', '写总报告含〔裁〕清单;播报后停下,列出每项结果、没过或没做的项与原因、补丁信息(路径、大小、SHA-256、来源提交)、要用户做的事', ['2.3-13'], 'manual',
    '各块报告里的〔裁〕汇总(grep -c "〔裁" docs/reports/AGENT-v18-*.md);补丁信息见 V18-installer-build;发版时在最终提交上给每行重新下结论(账号任务书「逐项验收」表头:旧记录不能顶替)'),
  NA('V18-na-offline-conflict', '暂时离线改动与冲突(提示落后并询问是否发送;可视化选择冲突;不静默覆盖;幂等且离线内容不丢)', ['2.1-10'], '账号任务书第 186 行与「各版本必须做」表:暂时离线改动确认与可视化冲突处理归 0.7.19,不是 0.7.18 的验收'),
  NA('V18-na-save-state', '保存与修改状态检查(暂停前台编辑、等本机写完、保存哈希+时间+版本/基准;失败可恢复编辑)', ['2.1-11'], '账号任务书第 186 行与「各版本必须做」表:保存状态记录归 0.7.19,不是 0.7.18 的验收'),

  /* ---- 全量测试里被无声跳过的一条:起 dev server 设好变量把它跑一遍 ---- */
  {
    id: 'G0-6', name: 'cards-layout 集成测试(要一台开着的 dev server,全量测试里它被无声跳过)', category: 'G0', level: 'local', taskRef: '问题 17:全量测试跳过名单里「本来该跑却被无声跳过」的一条', tasks: [], rows: ['2.3-11'], where: 'local',
    needs: ['dev'], env: { PC_STAGE_TEST_URL: '{dev.origin}' }, requires: ['server/test/cards-layout.test.mjs'],
    cmd: [node, '--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test', 'server/test/cards-layout.test.mjs'],
    pass: { exit: 0, metrics: { fail: 'ℹ fail (\\d+)', skipped: 'ℹ skipped (\\d+)' }, limits: { fail: { eq: 0 }, skipped: { eq: 0 } } }, timeoutMin: 10,
  },
];

/** scripts/probes 下没有被 V18 项登记、也不是 0.7.18 验收的文件:写明原因(--check-coverage 对照) */
const RENDER_REFACTOR = '渲染 / 轨道流 / 卡片键一带的探针,属渲染重构那一块(现在不碰),不是 0.7.18 38 行的依据;渲染重构合入后另议';
export const V18_EXCLUDED = {
  'account-dual-user-path-probe.mjs': '账号双用户路径夹具的公开入口(导出 runAccountDualUserPath),被 server/test/account-dual-user-path.test.mjs 直接导入,不单独跑',
  'account-password-user-path-probe.mjs': '改密选退出的原始探针(端口写死 6680～6689);V18-conv-password-probe 是它按 0.7.18 端口段改的同一套断言(47 项)的副本,以后者为准',
  'account-public-user-pages-probe.test.mjs': '公网网页探针自己的单测,由 npm test 扫(放在探针目录里)',
  'asset-project-isolation-probe.mjs': '素材按项目隔离的旧模式(口令式)版本;账号模式以 V18-asset-isolation(asset-account-isolation-probe)为准',
  'cloud-tools-c1-site.mjs': '网页采集探针 cloud-tools-c1-probe 的本机站点夹具,不单独跑',
  'below-diff-measure-probe.mjs': RENDER_REFACTOR, 'below-stream-common.mjs': RENDER_REFACTOR, 'browser-stream-e2e-probe.mjs': RENDER_REFACTOR, 'browser-stream-node-probe.mjs': RENDER_REFACTOR,
  'canvas-encode-paths-probe.mjs': RENDER_REFACTOR, 'card-plan-key-compare.mjs': RENDER_REFACTOR, 'card-policy-particles-probe.mjs': RENDER_REFACTOR, 'card-policy-probe.mjs': RENDER_REFACTOR,
  'card-source-version-compare.mjs': RENDER_REFACTOR, 'card-table-digest-compare.mjs': RENDER_REFACTOR, 'emphasis-key-probe.mjs': RENDER_REFACTOR, 'export-paths-measure.mjs': RENDER_REFACTOR,
  'framework-card-pipeline-probe.mjs': RENDER_REFACTOR, 'guide-blind-check.mjs': '建卡指南的盲写验收(派不带上下文的子 Agent),渲染重构「丙」的验收,不是 0.7.18 的依据',
  'hosted-render-remotion-probe.mjs': RENDER_REFACTOR, 'hosted-render-streams-probe.mjs': RENDER_REFACTOR, 'hosted-render-wipe-demo.mjs': RENDER_REFACTOR, 'hosted-stream-entry-probe.mjs': RENDER_REFACTOR,
  'online-remotion-card-probe.mjs': RENDER_REFACTOR, 'online-runtime-harness.html': RENDER_REFACTOR + '(页面夹具)', 'online-stream-play-probe.mjs': RENDER_REFACTOR, 'page-stream-probe.mjs': RENDER_REFACTOR,
  'preview-stop-lib.mjs': 'seek-back-exact-probe 与 scrub-hold-snapshot-probe 共用的搭法,不单独运行', 'remotion-style-harness.html': RENDER_REFACTOR + '(页面夹具)', 'remotion-style-probe.mjs': RENDER_REFACTOR,
  'scrub-hold-snapshot-probe.mjs': RENDER_REFACTOR, 'seek-back-exact-probe.mjs': RENDER_REFACTOR, 'stage-push-before-after-probe.mjs': RENDER_REFACTOR, 'stateful-seq-vs-jump-probe.mjs': RENDER_REFACTOR,
  'lottie-baseline-probe.mjs': RENDER_REFACTOR, 'lottie-pipeline-probe.mjs': RENDER_REFACTOR, 'lottie-seed-extra-probe.mjs': RENDER_REFACTOR, 'lottie-seed-probe.mjs': RENDER_REFACTOR,
  'merged-stream-bitstream.mjs': RENDER_REFACTOR, 'merged-stream-capacity.mjs': RENDER_REFACTOR, 'merged-stream-common.mjs': RENDER_REFACTOR, 'merged-stream-decode-limits.mjs': RENDER_REFACTOR,
  'merged-stream-h264.mjs': RENDER_REFACTOR, 'merged-stream-play-page.js': RENDER_REFACTOR, 'merged-stream-play.mjs': RENDER_REFACTOR, 'merged-stream-reencode.mjs': RENDER_REFACTOR,
  'stream-below-probe.mjs': RENDER_REFACTOR, 'stream-canvas-direct-probe.mjs': RENDER_REFACTOR, 'stream-noreplay-probe.mjs': RENDER_REFACTOR,
};

/**
 * 老清单里原有的项挂到 38 行上:id → 行号。(项本身不动,这里只补 rows;where 缺省按写法推出。)
 */
export const OLD_ITEM_ROWS = {
  'G0-1': ['2.3-11'], 'G0-2': ['2.3-11'], 'G0-3': ['2.3-11'], 'G0-4': ['2.3-11'],
  'S4-1': ['2.3-4'], 'S4-2': ['2.3-4'], 'S4-3': ['2.3-6'], 'S4-4': ['2.3-5', '2.3-6'], 'S4-7': ['2.3-3', '2.3-9'],
  'S4-m1': ['2.3-2'], 'S4-m2': ['2.3-10'], 'S4-m3': ['2.3-8'], 'S4-m4': ['2.3-12'], 'S4-m5': ['2.1-20'],
  'S4-r1': ['2.3-9', '2.3-12', '2.1-18'], 'S4-r2': ['2.3-6', '2.1-18'], 'S4-r4': ['2.3-8', '2.1-18'], 'S4-r5': ['2.3-8', '2.1-18'], 'S4-r6': ['2.3-8', '2.1-18'], 'S4-r7': ['2.1-18'],
  'S1-r2': ['2.1-18'], 'S1-r3': ['2.1-18'], 'S2-r1': ['2.1-18'], 'S3-r1': ['2.1-18'], 'S3-r2': ['2.1-18'], 'S3-r3': ['2.1-18'], 'S3-r4': ['2.1-18'], 'S3-r5': ['2.1-18'], 'S3-r6': ['2.1-18'], 'S3-r7': ['2.1-18'],
};

/**
 * 因为「云端项目一律走网站账号」而在 main 上必然跑不通的老项(它们走的是在线页面的「房间号加口令」加入表单 join-form,
 * 在线构建的开始页现在只有账号登录,没有这个表单)。能改成账号入口的已改(S4-4);改不了的在这里写明,运行器把它们记成「不适用」。
 * id → 原因。验证记录见 docs/reports/AGENT-v18-runner-list.md「老项逐条判」。
 */
const JOIN_FORM = '在线构建的开始页现在只有账号登录,探针进项目要等 [data-pc="join-form"](房间号加口令的加入表单)、等不到(2026-10-13 在 main 上用 0.7.18 的端口段实跑确认:日志里是等 join-form 超时或探针自己把它记成失败)。改成走账号入口要把项目的创建者也换成账号项目,不是只改进项目那一步';
export const STALE_OLD_ENTRY = {
  'P-c10-browser-a4': 'c10-browser-probe 的成员一半凭 #invite=<邀请码> 进在线页面(第 1512 行等 join-invite-project),开始页上已没有这个控件;创建者一半(桌面 dev server 本机建项目、层表)实跑能走完(318 秒后 step0.done),后面 A1～A5 全靠「创建者桌面节点把层产到同一个共享房间、成员页读」,账号项目只能由在线页面或 Rust 壳账号保管建,所以不是改进项目一步的事,要重写探针主干;它验的是渲染一带(在线普通档:长任务 0、首次打开在遮罩下测完、成本记录、层表与环境指纹、换帧占位、独立渲染主机认领),渲染重构合入后在账号模式下重搭。codex/018-browser-doc-read 修的是 main 里已不存在的强化版探针,不合',
  'P-c10-browser-full': '同 P-c10-browser-a4(c10-browser-probe 的成员一半进不去)',
  'P-c10-user-card': '同 P-c10-browser-a4(c10-browser-probe 的成员一半进不去)',
  'P-online-user-cards': JOIN_FORM, 'P-c10-ui': JOIN_FORM, 'P-online-stage-watch': JOIN_FORM, 'P-online-stage-handshake': JOIN_FORM, 'P-online-nav-stress': JOIN_FORM,
  'S1-5': JOIN_FORM + ';桌面一半(导出自动生成)能过,在线一半进不去', 'S2-1': JOIN_FORM, 'S2-2': JOIN_FORM, 'S2-3': JOIN_FORM, 'S2-4': JOIN_FORM, 'S2-5': JOIN_FORM,
  'X-online-join': '这支探针就是测在线开始页的「加入别人的项目」表单(join-form、邀请码),开始页上已经没有(只读代码判定,没实跑;可选项)',
  'X-c10a-demo-local': '走 join-form 加入本机替身的项目(c10a-demo-probe 里 7 处用到);只读代码判定,没实跑;可选项',
  'S1-4': '声音预览探针的在线一半凭邀请码进在线页面(等 [data-pc="join-invite-project"]),开始页上已没有这个控件;2026-10-13 在 main 上实跑:62 条检查里桌面一半都过,唯一的失败是等 join-invite-project 超时(桌面一半的证据另由 S1-1～S1-3 与探针本身的桌面段覆盖,在线一半现在没人验)',
  'S4-6': '界面版「关掉软件照常运转」探针的在线一半用 joinOnline(cloud-agent-ui-lib.mjs)等 join-form 进项目(第 233 行)。2026-10-13 在 main 上实跑:桌面发起那一半的检查能过(它仍然跑在已退役的口令式房间本机组合上),200 秒时限内没走到在线那一步,所以「必然失败」是读代码加这半段实跑得出的;账号入口下的同一件事(发任务后关掉软件照常运转)要搭账号模式的两个页面加关闭发起方,未做',
};

/**
 * 老项补充说明(写进小结的「已知」):2026-10-13 在 0.7.18 的端口段里实跑过、结论不是「旧入口已废」的。
 */
export const OLD_ITEM_KNOWN = {
  'P-online-stale-layer': '2026-10-13 在 main 上实跑:能进项目(不走 join-form),6 条断言不过(静置后 u 仍贴着旧层、改参数后…),原因没查,不是入口问题;属渲染一带',
  'P-m7-node': '2026-10-13 在 main 上实跑:到 node.ready(页面作为渲染节点就绪)后 200 秒时限内没跑完,没判结论;不走 join-form',
  'P-desktop-auto-node': '2026-10-13 在 main 上实跑:桌面页面测量测完后 200 秒时限内没跑完,没判结论',
  'P-m7-browser': '没判结论(实跑时 200 秒时限内被我收掉)',
};
