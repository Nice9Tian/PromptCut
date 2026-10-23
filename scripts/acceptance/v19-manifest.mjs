/**
 * 0.7.19 验收的清单项(数据)与要求表。由 `four-stage-manifest.mjs` 接进总清单;字段含义见那个文件的头与 `acceptance-lib.mjs` 的 validateManifest。
 * 0.7.19 新增的字段:
 *   v19          这一项支撑 0.7.19 要求表(下面的 V19_REQS)里哪几条;老项的 v19 写在 V19_TAGS 里,由总清单补上
 *   retiredWhen  某条分支合入后这一项失去意义:{ missing: 文件 } 或 { file, text },加 why;标记出现时运行器记「不适用」并写明依据,
 *                合入前照旧跑(main 上它描述的行为还在)
 *
 * 要求表的出处(2026-10-22 盘查,报告 docs/reports/AGENT-claude-acceptance-019.md):
 *   - docs/plan/online-browser-task.md「做完的标准」五条(第 3 条拆成小条);
 *   - docs/plan/three-versions-progress.md「还差什么」里 0.7.19 的几块与「0.7.19 之前」几件;
 *   - docs/plan/account-binding-task.md「逐项验收」里归 0.7.19 的两行(暂时离线改动与冲突、保存与修改状态检查)与每版都做的几行;
 *   - 0.7.18 发版(41b6d335)之后进 main、随 0.7.19 一起发的其它改动(剪辑段、手机版、AI 栏开始页、数字框提交时机、云端 Agent 面板流畅)。
 *
 * 在线浏览器那一块(撤档、三道闸门、四档气泡)在 2026-10-22 还**一行都没进 main**(分支 claude/online-browser):它的项全写成 wait 项,
 * 本检出缺新文件时记「等分支合入」,合入后自己会跑;撤档后失去意义的老项用 retiredWhen。
 *
 * 端口:沿用总清单的约定,探针自己起的东西用 5690 起的一段(串行用,每项结束后清掉),文档服务 / 素材服务 8760～8769;
 * 要 dev server 的用运行器的共享 dev server({dev.origin})。端口写死、不随这段走的标 optional 并写在 known 里。
 */
import '../lib/no-user-dirs.mjs';

const node = 'node';
const B = '5690';
const B2 = '5693';
const DOC = (n = 0) => String(8760 + n);
const ACCOUNT_ENV = ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE'];
const TEST_OK = '最终结果[:：]零失败';
const probe = (name, args = []) => [node, `scripts/probes/${name}.mjs`, ...args];
const OB = 'claude/online-browser';
/** 在线浏览器分支合入后才有的文件(wait 项的 requires):三道闸门的判法 */
const OB_MARK = 'src/online/stageGate.ts';
/** 新的舞台闸门探针才有的字样(旧的同名探针是舞台端口白名单) */
const GATE_PROBE_TEXT = { file: 'scripts/probes/stage-gate-probe.mjs', text: 'Page.crash' };

/** 0.7.19 要求表:编号、名字、出处、分组(--v19-map 按组排) */
export const V19_REQS = [
  // —— 在线浏览器(online-browser-task.md 做完的标准)
  ...[
    ['OB-1', '类型检查零错误、npm test 零失败、网页构建与在线构建成功', '做完的标准第 1 条'],
    ['OB-2', '渲染附加项:导出确定性、与 main 的像素比对 0 不同(桌面版行为不变)', '做完的标准第 2 条'],
    ['OB-3a', '登录后在浏览器新建项目、另一账号加入两边互看;没登录不能新建', '做完的标准第 3 条第 1 点'],
    ['OB-3b', '身份为手机时不认领渲染任务,电脑照常认领', '做完的标准第 3 条第 2 点'],
    ['OB-3c', '舞台闸门:真杀页面进程,停在下一级;护栏内不试、过了再试;成功一次清零、版本变了清零;刷新与切后台不算崩;安卓不到 8 GB 不试', '做完的标准第 3 条第 3 点'],
    ['OB-3d', '素材闸门:只测一次、更大的素材直接比上限;超解码上限用小尺寸;网速低先小后大', '做完的标准第 3 条第 4 点'],
    ['OB-3e', '即时渲染闸门:测崩的卡下次当重卡;最低一档播放不即时渲染、停下逐层替换', '做完的标准第 3 条第 5 点'],
    ['OB-3f', '低内存档的设置项、提示文字、自动降档都没有了,搜不到残留的调用', '做完的标准第 3 条第 6 点'],
    ['OB-3g', '进入后用四档气泡告知档位(用户定的原文)', 'account-binding-task.md「三个版本」0.7.19 一行;三道闸门'],
    ['OB-4', '原有的在线页面探针不退步;因撤档失去意义的逐个列明', '做完的标准第 4 条'],
    ['OB-5', '真机(iPhone、iPad、安卓)落在哪一档、崩溃表现、气泡;记待用户,不挡发版', '「这次做不了、要留给用户的」;用户 2026-10-22 定'],
  ].map(([id, name, source]) => ({ id, name, source: `online-browser-task.md ${source}`, group: '在线浏览器:撤档、三道闸门与四档气泡' })),
  // —— 多项目渲染节点
  ...[
    ['MP-1', '两种模式(单项目、多项目)出的画面相同(看画面那一路)', 'product/rendering.md「渲染服务的两种模式」'],
    ['MP-2', '产流也只装用到的那一段,流键与画面不变', 'mechanism/rendering.md「多项目模式的做法」;主会话 2026-10-22 定'],
    ['MP-3', '队列次序:看画面先于产流、各项目轮流、项目内先来先做、一轮最多连做 K 个、不让哪个项目占着', 'product/rendering.md「渲染服务的两种模式」'],
    ['MP-4', '多项目模式下的隔离(越权探测卡、只给本项目的票据)', 'product/rendering.md;hosted-render-contract.md'],
    ['MP-5', '节点上多个带用户卡的项目同时要画面时的表现(换装、K、缓存时长)', 'account-binding-task.md「三个版本」0.7.19 一行(10-16 改定)'],
  ].map(([id, name, source]) => ({ id, name, source, group: '多项目渲染节点(取代按轮占用)' })),
  // —— 冲突合并窗口
  ...[
    ['CM-1', '两级可勾选列表:一级按被改的那样东西、二级按属性,同一属性只列一条', 'product/document-service.md「冲突」'],
    ['CM-2', '增删两向都算冲突:我删了别人改了、我改了别人删了', 'product/document-service.md「冲突」'],
    ['CM-3', '待合并表按「项目 × 用户」存在文档服务,不进项目 JSON、不涨历史序号、不广播;同一用户换设备是同一张表', 'product/document-service.md「冲突」'],
    ['CM-4', '断网时改动照常、离线批次落浏览器本地缓存;在线浏览器断网时导入置灰;重连后逐项转进窗口', 'workflow/project.md「暂时离线项目与保存」'],
    ['CM-5', '五个按钮、导航栏顶端的「冲突合并」按钮;手机版同桌面', 'product/document-service.md「冲突」'],
    ['CM-6', '卡片源码冲突也进同一个窗口(先备份我的、装上云端的)', 'three-versions-progress.md 0.7.19 冲突合并一条'],
    ['CM-7', '固定非本机快照:另存 .proc/.procp 带确认过的云端基准与哈希,重开按基准逐项比', 'mechanism/document-service.md「保存基准与修改状态检查」'],
  ].map(([id, name, source]) => ({ id, name, source, group: '共用的「冲突合并」窗口(含固定非本机快照、断网保留)' })),
  // —— 云端 Agent 消息断网排队
  ...[
    ['OQ-1', '断网时发消息不报错,气泡照常显示「等网络恢复后发出」,服务端没收到', 'workflow/production.md「云端对话」断网一条'],
    ['OQ-2', '网络恢复后不用再点就按顺序发出', '同上'],
    ['OQ-3', '离线期间这个对话里有别人(或自己的其它设备)发过消息就不发,气泡标「发送失败」带「重新发送」', '同上'],
    ['OQ-4', '点「重新发送」按当前状态重走', '同上'],
    ['OQ-5', '排着的消息跨页面刷新还在,恢复后发出(〔裁〕三级)', 'mechanism/agent.md「断网时发消息的排队」'],
  ].map(([id, name, source]) => ({ id, name, source, group: '云端 Agent 消息断网排队' })),
  // —— 老外壳账号入口
  ...[
    ['OS-1', '0.2.8 以前的外壳打补丁后,三处账号入口只给「这个功能要装完整安装包」的说明,不报错', 'product/platforms.md「桌面应用」'],
    ['OS-2', '判据两个条件同时成立才说外壳太老,真错误、新外壳权限配错照报原来的错', 'mechanism/platforms.md「怎么认出外壳太老」'],
    ['OS-3', '在真的 0.2.0～0.2.7 外壳上实测(待用户,不挡发版)', 'three-versions-progress.md 老外壳一条「记待办」'],
  ].map(([id, name, source]) => ({ id, name, source, group: '老外壳打补丁后账号入口只给说明' })),
  // —— 0.7.19 之前的几件
  ...[
    ['PRE-1', '手机版「滤镜」入口;缩略卡、素材格子显示真画面', 'three-versions-progress.md「0.7.19 之前」第 1 件'],
    ['PRE-2', '播放停顿时声音立刻停(音频看门狗)', '同上第 2 件'],
    ['PRE-3', '登录框「粘贴授权码」,登录任务接上标准输入', '同上第 3 件'],
    ['PRE-4', '云端 Agent 的发送接口一次只核一次「首次使用告知」,不放过没同意的身份', '同上第 4 件'],
    ['PRE-5', '缺省托管地址换成自有域名,旧地址读进来自动换新', '同上「发版说明」一条;hosting-migration.md'],
    ['PRE-6', '「放弃这次搬迁」按钮(〔裁〕H04),删账号项目连文档服务数据一起删', '同上「并行分支」H04 一条'],
  ].map(([id, name, source]) => ({ id, name, source, group: '0.7.19 之前做完、随 0.7.19 发的几件' })),
  // —— 账号任务书逐项验收里归 0.7.19 与每版都做的行
  ...[
    ['AB-1', '暂时离线改动与冲突:提示落后、可视化选择冲突、不静默覆盖、幂等且离线内容不丢', '「逐项验收」暂时离线改动与冲突'],
    ['AB-2', '保存与修改状态检查:暂停前台编辑、等本机写完、保存哈希+时间+历史序号/基准;失败可恢复编辑且保留旧保存', '「逐项验收」保存与修改状态检查'],
    ['AB-3', '最终产品交互验收:逐项结论,首败复跑通过仍报不稳定;耗时与配置记入 release-timings', '「逐项验收」最终产品交互验收'],
    ['AB-4', '完整安装包:版本、来源 SHA、文件哈希;安装后启动、账号路径、文件关联;不覆盖用户运行副本', '「逐项验收」完整安装包'],
    ['AB-5', '兼容补丁:清单、哈希、目标版本、壳要求;最低声明壳与现用壳的隔离副本上升级、启动、回退', '「逐项验收」兼容补丁'],
    ['AB-6', '真实网络环境验收:证书、反代、重连、同提交服务、实际限权/退出', '「逐项验收」真实网络环境验收'],
    ['AB-7', '合入 main、版本号、release 推进', 'git_and_release.md;三个版本每版都做'],
  ].map(([id, name, source]) => ({ id, name, source: `account-binding-task.md ${source}`, group: '账号任务书逐项验收:归 0.7.19 与每版都做的行' })),
  // —— 随版合入
  ...[
    ['MG-1', '剪辑段:嵌套、面板、声音进成片、卡逐张产流、看画面指定剪辑', 'cut-nesting-task.md;AGENT-cut-*.md'],
    ['MG-2', '手机版界面与业务层(导航、缩略卡、时间轴、业务操作、输入框缩放)', 'mobile-online-task.md'],
    ['MG-3', 'AI 栏开始页与 Agent 分页按项目分开(桌面与手机)', 'workflow/editing.md「AI 栏的 Agent 标签」(2026-10-22 用户定)'],
    ['MG-4', '数字框与滑块的提交时机(敲字不落中间值、连按并成一步撤销)', 'workflow/editing.md「撤销、重做」(2026-10-20 用户定)'],
    ['MG-5', '云端 Agent 面板流畅(进项目就能输入、点发送当场出气泡、空闲时请求有数)', 'AGENT-agent-panel-smooth.md'],
    ['MG-6', '浏览器版不画应用标题栏(菜单行与最小化/最大化/关闭);桌面版照旧;菜单里在线还用得上的七项不丢', '用户 2026-10-22 当场定;product/platforms.md「在线浏览器」'],
  ].map(([id, name, source]) => ({ id, name, source, group: '0.7.18 发版后进 main、随 0.7.19 一起发的其它改动' })),
];

/** 一组测试文件(npm test -- 文件…) */
function T(id, name, v19, files, o = {}) {
  const { account = false, where = 'local', waitFor, known, timeoutMin = 20, optional } = o;
  return {
    id, name, category: 'V19', level: 'local', taskRef: o.taskRef || `0.7.19 ${v19.join('、')}`, v19, where, ...(waitFor ? { waitFor } : {}),
    tasks: [], cmd: [node, 'scripts/test-suite.mjs', ...files], requires: files.filter((f) => !/[*]/.test(f)), ...(account ? { requiresEnv: ACCOUNT_ENV } : {}),
    ...(known ? { known } : {}), ...(optional ? { optional } : {}),
    pass: {
      exit: 0, must: [TEST_OK],
      metrics: { tests: 'ℹ tests (\\d+)', pass: 'ℹ pass (\\d+)', fail: 'ℹ fail (\\d+)', skipped: 'ℹ skipped (\\d+)' },
      limits: { fail: { eq: 0 }, skipped: { eq: 0 }, tests: { min: 1 } }, todoFail: true,
    },
    timeoutMin,
  };
}

/** 一支探针 */
function PR(id, name, v19, script, args, o = {}) {
  const { where = 'local', waitFor, known, timeoutMin = 30, account = false, needs, prereq, covers, optional, must = [], requires = [], requiresText, timing } = o;
  return {
    id, name, category: 'V19', level: 'local', taskRef: o.taskRef || `0.7.19 ${v19.join('、')}`, v19, where, ...(waitFor ? { waitFor } : {}),
    tasks: [], cmd: probe(script, args), requires: [`scripts/probes/${script}.mjs`, ...requires], covers: covers || [`${script}.mjs`],
    ...(requiresText ? { requiresText } : {}), ...(account ? { requiresEnv: ACCOUNT_ENV } : {}), ...(known ? { known } : {}), ...(optional ? { optional } : {}),
    ...(needs ? { needs } : {}), ...(prereq ? { prereq } : {}), ...(timing ? { timing: 'record', timingNote: timing } : {}),
    pass: { exit: 0, must }, timeoutMin,
  };
}

/** 真实网络验证:要部署到节点以后(node)/ 要真实公网(network)。脚本不跑,remoteOnly 写明在节点上怎么验(命令只列出来) */
const REMOTE = (id, name, v19, where, how, o = {}) => ({
  id, name, category: 'V19', level: 'network', taskRef: o.taskRef || `0.7.19 ${v19.join('、')}`, v19, where, tasks: [], remoteOnly: how,
  ...(o.known ? { known: o.known } : {}), ...(o.covers ? { covers: o.covers } : {}),
});

/** 要人工看 / 要安装包(脚本不跑,写明怎么验) */
const MANUAL = (id, name, v19, where, how, o = {}) => ({
  id, name, category: 'V19', level: 'local', taskRef: o.taskRef || `0.7.19 ${v19.join('、')}`, v19, where, tasks: [], manual: how, ...(o.known ? { known: o.known } : {}),
});

const OK_TRUE = '"ok":\\s*true';
const S = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `S${from + i}`).join(',');
/** 在线浏览器分支的 wait 项共用:等新文件、等新探针 */
const OB_WAIT = { where: 'wait', waitFor: OB, requires: [OB_MARK], requiresText: [GATE_PROBE_TEXT], needs: ['online-build'], prereq: ['G0-4'] };

export const V19_ITEMS = [
  /* ============================== 在线浏览器:撤档、三道闸门与四档气泡(等 claude/online-browser 合入)============================== */
  T('V19-ob-tests', '三道闸门、档位与身份的单测(舞台闸门 SG、档位 OT、素材闸门 MG、单舞台界限搜索 LS、停下追一帧、最低一档取档、页面本地缓存上限、身份、浏览器节点资格)',
    ['OB-3b', 'OB-3c', 'OB-3d', 'OB-3e', 'OB-3g'],
    ['src/online/stageGate.test.mjs', 'src/online/onlineTier.test.mjs', 'src/online/mediaGate.test.mjs', 'src/online/l2.test.mjs', 'src/online/deviceKind.test.mjs', 'src/online/browserNode.test.mjs',
      'src/editor/costSearch.test.mjs', 'src/editor/c10a-single-stage.test.mjs', 'src/render/settleFrame.test.mjs', 'src/render/mediaTierSmallOnly.test.mjs', 'server/test/m7-page-node.test.mjs'],
    { where: 'wait', waitFor: OB, known: '文件名照 claude/online-browser 上的(stageGate、onlineTier、mediaGate、costSearch、settleFrame、mediaTierSmallOnly 是那条分支新建或改名的)' }),
  PR('V19-ob-stage-gate', '舞台闸门、崩溃记录、护栏、四档气泡、查看口、身份(真杀页面进程:S1～S14)', ['OB-3b', 'OB-3c', 'OB-3g'], 'stage-gate-probe',
    ['--dist', '{dist}', '--base-port', B, '--out', '{item}', '--only', S(1, 14)],
    { ...OB_WAIT, must: [OK_TRUE], timeoutMin: 60,
      known: '新探针在 claude/online-browser 上(main 上同名文件还是旧的舞台端口白名单探针,所以用 requiresText 认新探针的「Page.crash」);端口 base～base+4;S10 是「安卓 4 GB 不试、身份手机」,S12 是 iPad' }),
  PR('V19-ob-lowest', '最低一档(?tier=low):播放时卡被抑制、不即时渲染;停下逐层追一帧画好(S15)', ['OB-3e'], 'stage-gate-probe',
    ['--dist', '{dist}', '--base-port', B, '--out', '{item}', '--only', 'S15'], { ...OB_WAIT, must: [OK_TRUE], timeoutMin: 30, known: '在线浏览器第四步' }),
  PR('V19-ob-instant-gate', '即时渲染闸门:基准卡跑不动进最低一档(S16)、测某张卡时崩下次直接当重卡(S17)、有成本记录时界限搜索先划线再后台补测(S20)', ['OB-3e'], 'stage-gate-probe',
    ['--dist', '{dist}', '--base-port', B, '--out', '{item}', '--only', 'S16,S17,S20'], { ...OB_WAIT, must: [OK_TRUE], timeoutMin: 40, known: '在线浏览器第四步' }),
  PR('V19-ob-media-gate', '素材闸门:载入原尺寸时崩下次解码上限调低一级(S18)、浏览器只说解得动 720p 时上限 720p(S19)', ['OB-3d'], 'stage-gate-probe',
    ['--dist', '{dist}', '--base-port', B, '--out', '{item}', '--only', 'S18,S19'], { ...OB_WAIT, must: [OK_TRUE], timeoutMin: 30,
      known: '在线浏览器第四步;素材闸门的「网速低先拉小尺寸、恢复后改回」「导入更大的素材不重测、直接比上限」探针里没有场景,只有单测(mediaGate MG-01～08),见报告「要主会话改探针」' }),
  {
    id: 'V19-ob-residue', name: '低内存档搜不到残留(撤掉的模块、import、引号里的「低内存」字样、专有标识)', category: 'V19', level: 'local', taskRef: '0.7.19 OB-3f', v19: ['OB-3f'],
    where: 'wait', waitFor: OB, tasks: [], cmd: [node, 'scripts/acceptance/v19-lowmem-residue.mjs'],
    requires: ['scripts/acceptance/v19-lowmem-residue.mjs', OB_MARK], pass: { exit: 0, must: [OK_TRUE] }, timeoutMin: 5,
    known: '合入前可以先对着分支核:node scripts/acceptance/v19-lowmem-residue.mjs --ref claude/online-browser(2026-10-22 对分支 d31659d0 四条全过;对 main 四条全不过)',
  },
  MANUAL('V19-ob-device', '真机核对:iPhone、iPad、安卓落在哪一档、崩溃后的表现、气泡(待用户,不挡发版)', ['OB-5'], 'manual',
    '照在线浏览器分支报告 docs/reports/AGENT-claude-online-browser.md「安卓真机测试的做法与预期」「真机核对清单」逐条做:地址后加 ?gates=1 看只读查看口(档位、舞台闸门的目标与到达、上次崩没崩、护栏、身份);?tier=low 强制最低一档看气泡与播放;导入 4K 视频看解码上限。用户 2026-10-22 定:真机项记待办,不挡发版',
    { known: '这台 PC 上验不了' }),

  /* ============================== 多项目渲染节点 ============================== */
  T('V19-mp-tests', '多项目模式的单测(出队次序 MPQ、展开 MPE、隔离 MPI、产流键 MSK)与托管渲染服务一组(排队、看画面、隔离、用户卡、容量)',
    ['MP-2', 'MP-3', 'MP-4'],
    ['server/test/multi-project-queue.test.mjs', 'server/test/multi-project-expand.test.mjs', 'server/test/multi-project-isolation.test.mjs', 'server/test/multi-project-stream-keys.test.mjs',
      'server/test/hosted-render-*.test.mjs', 'server/test/cloud-see-frames-dispatch.test.mjs', 'server/test/accept-018-rest-queue-account-look.test.mjs', 'server/test/cloud-agent-look.test.mjs'],
    { timeoutMin: 30, known: 'hosted-render-queue 的 RQ7 在全量里偶发(计时相关),单独重跑' }),
  PR('V19-mp-expand', '两种模式出的画面相同(看画面那一路:整份项目与按请求展开后的项目,每帧逐像素比)', ['MP-1'], 'multi-project-expand-probe',
    ['--url', '{dev.origin}', '--out', '{item}'],
    { needs: ['dev'], must: [OK_TRUE, '"diffPixels":\\s*0'], timeoutMin: 30, covers: ['multi-project-expand-probe.mjs', 'multi-project-fixture.mjs'],
      known: '素材写进 out/media(PC_FRAME_MEDIA_DIR 可改),跑完删掉(不带 --keep);子 Agent 2026-10-22 实跑 24/24 帧相同' }),
  PR('V19-mp-stream', '产流只装用到的那一段:流键两边逐字节相同、画面逐像素相同', ['MP-2'], 'multi-project-stream-probe',
    ['--url', '{dev.origin}', '--out', '{item}'],
    { needs: ['dev'], must: [OK_TRUE, '"diffPixels":\\s*0'], timeoutMin: 30, covers: ['multi-project-stream-probe.mjs', 'multi-project-fixture.mjs'],
      known: '子 Agent 2026-10-22 实跑 streams 6、keysSame 6、frames 23、identical 23' }),
  PR('V19-mp-turn-bench', '一轮最多连做 K 个的实测(K=1/2/4/8,只出数字)', ['MP-3'], 'multi-project-turn-bench',
    ['--base-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1)],
    { optional: true, timeoutMin: 90, timing: '每个 K:请求从登记到出结果、换装次数与用时、另一个项目要等多久(只记录;K=4 是 2026-10-22 按实测定的〔裁〕)',
      known: '文件头写明「不是验收探针,只出数字」,所以是补充项;退出码 0 = 跑完' }),

  /* ============================== 共用的「冲突合并」窗口 ============================== */
  T('V19-cm-tests', '冲突合并的单测(条目 MI、离线合并链 OM、文档服务待合并表 PM、固定非本机快照 CS、断网导入判据、卡片源码 T8、另存与重开)',
    ['CM-1', 'CM-2', 'CM-3', 'CM-4', 'CM-6', 'CM-7', 'AB-1', 'AB-2'],
    ['src/editor/sync/mergeItems.test.mjs', 'src/editor/sync/offlineMerge.test.mjs', 'server/test/pending-merge.test.mjs', 'src/editor/sync/cloudSnapshot.test.mjs',
      'src/editor/sync/onlineSync.test.mjs', 'server/test/card-sync.test.mjs', 'src/editor/sync/accountMove.test.mjs', 'server/test/c10-ui-gates.test.mjs']),
  PR('V19-cm-probe', '冲突合并窗口(桌面与手机):只断甲 → 连回逐项转表、两级列表 → 选中无冲突项合并 → 下次再说留按钮 → 同一用户的手机处理同一张表 → 断网导入置灰(D1～D6)',
    ['CM-1', 'CM-2', 'CM-3', 'CM-4', 'CM-5', 'AB-1'], 'conflict-merge-probe',
    ['--dist', '{dist}', '--out', '{item}', '--base-port', B, '--base2-port', B2, '--doc-port', DOC(0), '--asset-port', DOC(1)],
    { needs: ['online-build'], prereq: ['G0-4'], must: [OK_TRUE], timeoutMin: 30,
      known: '子 Agent 2026-10-22 第三次跑 ok:true(第二次手机「处理」按钮被进项目的气泡盖住,探针已加退路)' }),
  PR('V19-cm-card', '冲突合并窗口里「卡片源码」那一行与「源码」二级、删除选中(保留云端现状)', ['CM-6'], 'card-conflict-probe',
    ['--port', B, '--doc-port', DOC(0), '--out', '{item}'],
    { must: [OK_TRUE], timeoutMin: 20, known: '不点「合并」(会写进本仓库 src/cards/user/),合并规则由 card-sync.test.mjs T8-8 覆盖;冲突通知经开发钩子喂给页面(两个编辑器共用 src/cards/user/,造不出真的跨编辑器冲突)' }),
  MANUAL('V19-save-state', '保存与修改状态检查里没有探针的几处:暂停前台编辑、等本机写完、保存中断后能恢复编辑且保留旧保存', ['AB-2'], 'manual',
    '2026-10-22 查代码的结论(详见 docs/reports/AGENT-claude-acceptance-019.md「保存与修改状态检查查到的」):① 保存时暂停前台编辑——未实现(src/editor/TopBar.tsx 的 saveProject 等待期间不锁任何编辑);② 等本机写完——部分实现:只等文档服务确认所有本地操作(syncManager.ts whenSaved → DocSync.whenSettled,10 秒,超时不写并提示)与恢复日志落盘,不等素材入库/上传、本机 Agent、渲染、后台写入(mechanism/document-service.md 第 36 行要求的其余几样);③ 失败不覆盖上次有效保存并恢复编辑——部分实现:等确认失败时在写文件之前就退出、旧文件不动;写到一半失败只靠 File System Access API 的 createWritable 先写临时副本、close 才替换的行为,代码里没有显式处理,也没有任何测试;「恢复编辑」因为从没禁用而无从谈起。固定非本机快照(CS-01～06)已实现。语义两处都还写着「待实施」。整行按未达成处理,除非用户另定',
    { known: '在线浏览器里 saveProject 是空函数(ONLINE_BUILD),这一行只对桌面版的 .proc/.procp 保存有意义' }),

  /* ============================== 云端 Agent 消息断网排队 ============================== */
  T('V19-oq-tests', '断网排队与告知的单测(outbox 18 条、告知只核一次)', ['OQ-1', 'OQ-2', 'OQ-3', 'OQ-4', 'PRE-4'],
    ['src/ai/cloud/outbox.test.mjs', 'src/ai/cloud/consent-once.test.mjs']),
  PR('V19-oq-probe', '断网待发的浏览器探针(真的 CloudAiPanel,桌面 14 条 + 手机 375×812 触屏 5 条)', ['OQ-1', 'OQ-2', 'OQ-3', 'OQ-4', 'OQ-5'], 'cloud-offline-queue-probe',
    ['--port', B], { must: [OK_TRUE], timeoutMin: 20,
      known: '截图写死在仓库的 out/offline-queue/(探针没有 --out);Agent 服务是探针里模拟的;断网 = 浏览器离线模式 + 服务端掐事件流,不碰宿主机网络' }),

  /* ============================== 老外壳账号入口 ============================== */
  T('V19-os-tests', '老外壳判据的单测(Tauri「没有这个命令」四种原话、读版本、三处入口的流程)', ['OS-1', 'OS-2'],
    ['src/account/desktopShellOld.test.mjs', 'src/account/oldShellFlow.test.mjs']),
  PR('V19-os-probe', '老外壳上三处账号入口只给说明;真错误、新外壳权限配错、新外壳正常三种对照', ['OS-1', 'OS-2'], 'old-shell-account-probe',
    ['--port', B, '--out', '{item}'], { timeoutMin: 20, known: '老外壳是按 Tauri 真实报错形状用桩造的(window.__TAURI__ 换成替身),不是真的 0.2.0～0.2.7 外壳' }),
  MANUAL('V19-os-real-shell', '在真的 0.2.0～0.2.7 外壳上打 0.7.19 补丁,三处账号入口只给说明(待用户,不挡发版)', ['OS-3'], 'installer',
    '与 V19-patch 一起做:隔离副本上装 0.2.0 与 0.2.7 外壳,打 0.7.19 的兼容补丁,开始页「云端项目」、项目设置「搬到云端」、协作房间「搬到云端」各点一次,看到「这个功能要装完整安装包」、没有红色错误条;不在有 Agent 会话在跑的安装目录上装补丁',
    { known: '三版本进度「记待办不挡发版」' }),

  /* ============================== 0.7.19 之前做完的几件 ============================== */
  PR('V19-mobile-entries', '手机版「滤镜」入口、素材格子与缩略卡显示真画面(T1～T5、F1～F3)', ['PRE-1'], 'mobile-entries-probe',
    ['--dist', '{dist}', '--out', '{item}', '--base-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1)],
    { needs: ['online-build'], prereq: ['G0-4'], must: [OK_TRUE], timeoutMin: 30 }),
  PR('V19-stall-audio', '播放停顿时声音立刻停(音频看门狗正向验收:迟到那一拍到达前就停、拍子回来后从播放头接着放)', ['PRE-2'], 'playback-probe',
    ['--port', B, '--only', '停顿声音'], { must: ['"fails":\\s*\\[\\]'], timeoutMin: 20, covers: ['playback-probe.mjs'],
      known: '主会话 2026-10-22 复跑 41 项过;同一探针的「节拍」一例机器忙时会假失败,这里只跑「停顿声音」' }),
  T('V19-pre-tests', '前置项的单测:粘贴授权码(cli-setup)、告知只核一次、托管地址换自有域名与旧地址换新、放弃这次搬迁(account-move、accountMove AM-26)',
    ['PRE-3', 'PRE-4', 'PRE-5', 'PRE-6'],
    ['server/test/cli-setup.test.mjs', 'src/ai/cloud/consent-once.test.mjs', 'server/test/hosted-migrate.test.mjs', 'server/test/legacy-gone-proof.test.mjs', 'server/test/sp-route.test.mjs',
      'server/test/sp-routing.test.mjs', 'server/test/account-move.test.mjs', 'src/editor/sync/accountMove.test.mjs'],
    { account: true, timeoutMin: 30, known: 'cli-setup 有真子进程与收尾删临时目录,机器满载时偶发假失败,单独重跑' }),

  /* ============================== 0.7.18 发版后进 main、随 0.7.19 发的其它改动 ============================== */
  T('V19-cut-tests', '剪辑段的单测(摊平、路径、段、索引、面板状态、停放剪辑的 Agent 编辑与总览、看画面带 cutId、产流、声音、导出模式、云端路由、撤销)', ['MG-1'],
    ['src/kernel/cutFlatten.test.mjs', 'src/kernel/cutPaths.test.mjs', 'src/kernel/cutSegments.test.mjs', 'src/kernel/cuts.test.mjs', 'src/kernel/cutsIndex.test.mjs', 'src/editor/timeline/cutTabsState.test.mjs',
      'src/mcp/handlers/cutSegments.test.mjs', 'src/mcp/handlers/parkedCutEdit.test.mjs', 'src/mcp/handlers/parkedCutOverview.test.mjs', 'src/mcp/handlers/seeFramesCut.test.mjs',
      'src/store/actions/cutSegments.test.mjs', 'src/store/docsyncCutUndo.test.mjs', 'server/test/agent-parked-cut-edit.test.mjs', 'server/test/cut-flatten-streams.test.mjs', 'server/test/cut-look-ui.test.mjs',
      'server/test/cut-segment-audio.test.mjs', 'server/test/cut-segment-cloud-route.test.mjs', 'server/test/cut-segment-export-mode.test.mjs', 'server/test/stream-cut.test.mjs'], { timeoutMin: 30 }),
  PR('V19-cut-nesting-ui', '剪辑:标签、素材库剪辑组、拖进成剪辑段、循环引用拦下、删被引用的剪辑(A1～A9,真编辑台)', ['MG-1'], 'cut-nesting-ui-probe',
    ['--origin', '{dev.origin}', '--out', '{item}'], { needs: ['dev'], timeoutMin: 20 }),
  PR('V19-cut-panel', '剪辑段属性面板与素材库剪辑格子(P1～P9:偏移、框、不透明度、淡入淡出、音量、引用不能改、打开被引用剪辑)', ['MG-1'], 'cut-segment-panel-probe',
    ['--origin', '{dev.origin}', '--out', '{item}'], { needs: ['dev'], timeoutMin: 20 }),
  PR('V19-cut-flatten', '剪辑段里的卡逐张产流、贴流、轻卡活渲、没流占位(比像素)', ['MG-1'], 'cut-flatten-probe',
    ['--port', B, '--out', '{item}'], { timeoutMin: 30 }),
  PR('V19-cut-look', 'see_frames 带 cutId 看指定剪辑(镜像与项目副本两条出图路)', ['MG-1'], 'cut-look-probe',
    ['--port', B, '--out', '{item}'], { timeoutMin: 30, known: '探针临时写 src/cards/user/cut-look-solid.tsx,跑完删掉' }),
  PR('V19-cut-online-e2e', '在线页面贴剪辑段里那张卡自己的流,被引用剪辑改过之后不贴旧流', ['MG-1'], 'cut-online-e2e-probe',
    ['--dist', '{dist}', '--base-port', B, '--out', '{item}'], { needs: ['online-build'], prereq: ['G0-4'], timeoutMin: 40, known: '端口整段 base～base+9' }),
  PR('V19-cut-audio', '剪辑段的声音进导出成片(Chrome 混音一路;段前静音、淡入、电平)', ['MG-1'], 'cut-segment-audio-probe',
    ['--port', B, '--out', '{item}'], { timeoutMin: 20 }),
  PR('V19-cut-card-sound', '剪辑段里的有声动效卡:导出前自动生成,按段的音量、淡入、静音处理(浏览器与预渲染两条导出路)', ['MG-1'], 'cut-segment-card-sound-probe',
    ['--port', B, '--out', '{item}'], { timeoutMin: 30 }),
  PR('V19-cut-ffmpeg-media', '显式 --media=ffmpeg 导出遇到剪辑段里的视频图片改走完整整帧路线,画得出来', ['MG-1'], 'cut-segment-ffmpeg-media-probe',
    ['--port', B, '--out', '{item}'], { timeoutMin: 30 }),
  PR('V19-number-input-undo', '数字框与滑块的提交时机(N1～N7:敲字不落中间值、Esc 放弃、失焦提交、连按并成一步撤销、拖动限速)', ['MG-4'], 'number-input-undo-probe',
    ['--origin', '{dev.origin}', '--out', '{item}'], { needs: ['dev'], timeoutMin: 20 }),
  T('V19-mobile-tests', '手机版的单测(界面、缩略卡取帧、Agent 对话页画法)', ['MG-2', 'MG-3', 'PRE-1'],
    ['src/mobile/mobile.test.mjs', 'src/mobile/thumbs.test.mjs', 'src/mobile/agentView.test.mjs']),
  PR('V19-mobile-ui', '手机版界面(M1 设备判断与强制、M2 导航、子导航、冲突横条 C 段、缩略卡、时间轴缩放、返回层级、滚动条、无横向溢出)', ['MG-2', 'CM-5'], 'mobile-ui-probe',
    ['--dist', '{dist}', '--out', '{item}', '--base-port', B, '--base2-port', B2, '--doc-port', DOC(0), '--asset-port', DOC(1)],
    { needs: ['online-build'], prereq: ['G0-4'], must: [OK_TRUE], timeoutMin: 30, known: 'C 段 2026-10-22 随冲突合并窗口改成逐项(1d07f323)' }),
  PR('V19-mobile-business', '手机版接业务层:逐项操作看 store,桌面打开同一项目一致,刷新后仍在', ['MG-2'], 'mobile-business-probe',
    ['--dist', '{dist}', '--out', '{item}', '--base-port', B, '--base2-port', B2, '--doc-port', DOC(0), '--asset-port', DOC(1)],
    { needs: ['online-build'], prereq: ['G0-4'], must: [OK_TRUE], timeoutMin: 30 }),
  PR('V19-mobile-input-zoom', '手机浏览器点输入框不放大、放大后能缩回(F、Z、K、N)', ['MG-2'], 'mobile-input-zoom-probe',
    ['--dist', '{dist}', '--base-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1)],
    { needs: ['online-build'], prereq: ['G0-4'], must: [OK_TRUE], timeoutMin: 20, known: '无头 Chrome 不会真的放大,验的是放大的起因去掉了、兜底按时序动了 viewport;真的放大缩回要真机看' }),
  PR('V19-mobile-agent', '手机版 Agent 分页:开始页、清空、引用标记条、发送带引用、标签、尺寸对演示稿', ['MG-3'], 'mobile-agent-probe',
    ['--dist', '{dist}', '--out', '{item}', '--base-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1)],
    { needs: ['online-build'], prereq: ['G0-4'], must: [OK_TRUE], timeoutMin: 30 }),
  PR('V19-mobile-agent-view', '手机版 Agent 对话页的画法(V1～V7,假消息并排对演示稿)', ['MG-3'], 'mobile-agent-view-probe',
    ['--out', '{item}', '--port', B], { must: [OK_TRUE], timeoutMin: 20 }),
  PR('V19-agent-tabs-start', 'AI 栏 Agent 分页按项目分开、没有会话时是开始页(桌面编辑台,页面内置假流,不调真模型)', ['MG-3'], 'agent-tabs-start-probe',
    ['--port', B, '--out', '{item}'], { timeoutMin: 20 }),
  PR('V19-agent-tabs-start-mobile', '在线构建里 AI 栏的开始页(桌面界面走云端接入)与手机版 Agent 分页的开始页', ['MG-3'], 'agent-tabs-start-mobile-probe',
    ['--dist', '{dist}', '--out', '{item}', '--base-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1)],
    { needs: ['online-build'], prereq: ['G0-4'], timeoutMin: 20 }),
  PR('V19-titlebar', '浏览器版不画应用标题栏:在线页面上菜单行与三个窗口按钮都没有;桌面模式两组都在、「文件」菜单能打开;「快捷键」「关于」挪进顶栏「⋯」且桌面不重复', ['MG-6'], 'browser-titlebar-probe',
    ['--online-port', '5960', '--desktop-port', '5963', '--out', '{item}'],
    { must: [OK_TRUE], timeoutMin: 20, known: '端口写死在探针参数里(5960/5963),与本清单 5690 段不同;守门测试 C10-TITLEBAR-01 另在单测里核产物' }),
  PR('V19-save-state-probe', '保存与修改状态检查里有探针的几处(保存中断、超时、锁)', ['AB-2'], 'save-state-probe',
    ['--origin', '{dev.origin}', '--out', '{item}'],
    { must: [OK_TRUE], timeoutMin: 20, known: '探针自己不起服务,用运行器的共享 dev server;没有探针的三处见 V19-save-state(人工结论)' }),
  PR('V19-agent-panel-smooth', '云端 Agent 面板流畅(进项目就能输入、点发送 300 ms 内出气泡、只一条、空闲 30 秒列对话不超过 12 次、刷新回到原对话)', ['MG-5'], 'agent-panel-smooth-probe',
    ['--dist', '{dist}', '--site-root', '{visuhive}/site', '--out', '{item}', '--base-port', B],
    { account: true, needs: ['online-build'], prereq: ['G0-4'], timeoutMin: 20, must: ['"completed":\\s*true', '"failed":\\s*0'],
      timing: 'R1 进项目到能输入、O1 刷新后显示出来的用时、N1 空闲 30 秒的各类请求次数(只记录)',
      known: '要真账号后端(两个环境变量);端口 base 起连着 10 个' }),
  PR('V19-mobile-account', '手机版走账号版的完整路径(官网注册 → 手机开始页 → 新建云端项目 → 编辑 → 桌面同账号打开一致)', ['MG-2'], 'mobile-account-probe',
    ['--dist', '{dist}', '--site-root', '{visuhive}/site', '--out', '{item}', '--base-port', B],
    { account: true, optional: true, needs: ['online-build'], prereq: ['G0-4'], timeoutMin: 30,
      known: '两个舞台源写死 6341、6342(不随 --base-port 走),所以是补充项;用户 2026-10-21 指定的测试账号,截图不含密码' }),

  /* ============================== 真实网络环境验收(0.7.19 部署到节点以后;照 four-stage-deploy-checklist.md 在节点上做,脚本不跑)==============================
   * 通用规矩(verification.md「产品交互验收与真实网络环境验收」):只用测试账号、测试项目,验完删;改动前备份;模拟断线只在应用层做
   * (浏览器 CDP 的离线模式、在服务器侧断那条 TCP),不动宿主机网络;三个服务与在线页面是同一个提交(status-agent、status-render 与页面 __PC_CODE_VERSION__ 对 <SHA>)。 */
  REMOTE('V19-net-hosted-domain', '新的缺省托管地址 https://hosted.visuhive.com/hosted 在公网上通;旧地址读进来自动换新', ['PRE-5', 'AB-6'], 'network',
    '部署后在公网上(不在节点本机):① curl -s -o /dev/null -w "%{http_code}" https://hosted.visuhive.com/hosted/healthz、…/hosted/hosting/healthz、…/media/healthz 都 200;openssl s_client -connect hosted.visuhive.com:443 -servername hosted.visuhive.com | openssl x509 -noout -dates 证书有效;s1.visuhive.com、s2.visuhive.com 两个舞台源同样核证书与 /editor/stage.html 200;② 0.7.19 的桌面版(隔离数据目录,不碰用户在用的那份)不手填地址,「加入别人的项目」与账号登录后新建云端项目都连得上(文档服务握手走 wss://hosted.visuhive.com/hosted/);③ 打开一份存着旧地址(<节点 IP>:8787 / :8788 或 sslip.io 名字)的测试 .proc,看项目文件与本机记录里的地址被换成新域名下的 /hosted 与 /media(协议换成 https / wss)且能连上;④ 公网上直接请求 http://<节点 IP>:8787 连不上(8787、8788 只听本机)。证据:各条命令输出、桌面版截图、换地址前后 .proc 里那一段',
    { known: '出处:three-versions-progress.md「发版说明」托管地址一条、hosting-migration.md「2026-10-22 托管地址换成自有域名」;单测 hosted-migrate.test.mjs 已在 V19-pre-tests' }),
  REMOTE('V19-net-multi-project', '节点上多项目渲染节点的队列次序与隔离(两个以上带用户卡的测试项目同时要画面与产流)', ['MP-3', 'MP-4', 'MP-5', 'AB-6'], 'node',
    '部署渲染服务与 Agent 服务之后,建两个(或三个)测试账号与各自的云端测试项目,每个项目放一张把舞台涂成自己颜色的用户卡(夹具同 hosted-render-queue-probe:fixtures 里的纯色卡);① 用两个项目的云端对话几乎同时各发几次 see_frames(看画面),再让第三个项目发产流计划:看画面都先于产流出图、各项目轮流、同一项目先来先做、一个项目一轮最多连做 K 个(节点上 PROMPTCUT_RENDER_TURN,缺省 4),拿回的每张图中心颜色都是自己项目的;节点上 pm2 logs 的 look.expanded 与隔离工作进程换装记录(结束原因都是轮换)对得上;② 隔离:把越权探测卡(scripts/probes/fixtures/render-isolation/)放进项目甲,发计划让渲染服务渲,断言读不到项目乙的内容与素材、节点上的凭证与令牌、工作进程自己的本机接口、工作目录以外的文件(同 S3-r4 的断言,换成多项目模式下两个项目同时有活);③ 记每个请求从登记到出图的用时、换装次数(只记录)。测试账号与项目验完删',
    { known: '本机的同一组断言是 RS18-queue(K=1)、V18-queue-probe(K=4)、V18-queue-isolation-probe(49 条);节点压力与内存另见 V18-queue-node-pressure' }),
  REMOTE('V19-net-conflict-merge', '冲突合并窗口经公网断线重连后逐项恢复(桌面与手机,同一用户的两台设备看同一张表)', ['CM-1', 'CM-3', 'CM-4', 'CM-5', 'AB-1', 'AB-6'], 'network',
    '换在线页面之后,对着公网地址(https://<域名>/editor/)用两个测试账号甲、乙进同一个云端测试项目:① 甲断线——在服务器侧断甲那条 WebSocket 的 TCP(或甲的页面用 CDP Network.emulateNetworkConditions offline),不动宿主机网络;甲断线期间改 c1 的属性两次、删 c2、改 c4,乙同时改 c1 同一属性、改 c2、删 c4;② 甲连回:冲突合并窗口自己打开,一级按东西、二级按属性,增删两向都标冲突,「选中无冲突项」只勾无冲突的,合并后乙那边看到的值对;③ 关窗后导航栏「冲突合并」按钮在;甲用手机仿真(或真机)同一账号进项目,冲突横条显示同一张表,在手机上处理完,桌面按钮消失;④ 断线时在线页面「导入媒体」置灰并提示「当前离线」,刷新页面后离线改动还在(浏览器本地缓存)、连回后照样逐项转进窗口。截图与每步的值写进报告;测试账号与项目验完删。本机的同一组断言是 V19-cm-probe(D1～D6)',
    { known: '真网络才有的是:真的 nginx 与证书下的 WebSocket 断开与重连、真实时延下待合并表在文档服务与两台设备之间的推送' }),
  REMOTE('V19-net-offline-queue', '云端 Agent 消息断网排队在真网络上:恢复后按序发出;期间别的设备发过就不发、标发送失败、重新发送', ['OQ-1', 'OQ-2', 'OQ-3', 'OQ-4', 'OQ-5', 'AB-6'], 'network',
    '部署 Agent 服务之后,测试账号在公网在线页面打开云端测试项目的对话:① 页面用 CDP Network.emulateNetworkConditions offline(应用层断网,不动宿主机网络),发两条消息:不报错、气泡下写「等网络恢复后发出」,节点上 Agent 服务的对话记录里没有这两条;② 恢复网络,不用再点就按顺序发出,节点上记录顺序对;③ 再断网发一条,期间同一账号的第二个页面(另一台设备)在同一对话里发一条;恢复后第一条不发,气泡标「发送失败」带「重新发送」;点「重新发送」按当前状态发出;④ 断网时发一条后刷新页面,恢复后照样发出。模型用模拟提供方或真实 Key 都行(只看排队,不看回答);截图与节点上的对话记录写进报告,测试对话验完删。本机的同一组断言是 V19-oq-probe(19 条,Agent 服务是模拟的)',
    { known: '真网络才有的是:真的 Agent 服务(账号版、一条任务一个进程)与 nginx 的 /agent/ 路由下,断开与恢复时事件流重连、排着的消息按序到达' }),
  REMOTE('V19-net-online-gates', '公网在线页面上的三道闸门与四档气泡(真的跨源舞台 s1/s2、真实时延;等 claude/online-browser 合入并换页面后)', ['OB-3c', 'OB-3g', 'AB-6'], 'network',
    '换成 0.7.19 的在线页面之后,电脑上的 Chrome(新的浏览器配置,本地存储全空)打开公网 /editor/ 进测试项目,地址加 ?gates=1:查看口里舞台闸门从低往高试到第三级、气泡原文对、两个舞台都在 s1/s2 跨源源上;安卓仿真(4 GB)打开停在精简模式、身份手机、不认领渲染任务;?tier=low 播放时只贴已产好的流。真机部分归 V19-ob-device',
    { known: '依赖 claude/online-browser 合入后的在线构建;合入前这一项无从验' }),

  /* ============================== 每版都做的发版动作(人工)============================== */
  MANUAL('V19-release-timings', '0.7.19 发版时整套跑一遍并记 release-timings(首败复跑通过仍报告不稳定)', ['AB-3'], 'manual',
    '在线浏览器合入之后、在最终提交上:node scripts/acceptance/four-stage-acceptance.mjs --out work/four-stage/final/<时间戳> --flaky-rerun 1 --release-timings "0.7.19";另跑 --v19-map 与 --check-coverage 贴进报告;release-timings-section.md 贴进 docs/reports/release-timings.md;旧结果不替代'),
  MANUAL('V19-installer', '0.7.19 完整安装包:版本、来源 SHA、文件哈希;隔离位置安装后启动、账号路径、文件关联双击;不覆盖用户运行副本', ['AB-4'], 'installer',
    '同 V18-installer-build、V18-installer-smoke 的做法换成 0.7.19:git rev-parse HEAD;cd desktop && npm run release -- --from-head;产物 desktop/release/PromptCut-0.7.19-setup.exe、PromptCut-patch-0.7.19.zip、manifest-0.7.19.json 的大小与 SHA-256;node scripts/smoke-all.mjs <exe>;用户 2026-10-22 定:安装包冒烟由用户自己测,记待办不挡发版'),
  MANUAL('V19-patch', '0.7.19 兼容补丁:清单、哈希、目标版本、壳要求;最低声明壳与现用壳的隔离副本上升级、启动、账号与文件功能、回退', ['AB-5'], 'installer',
    '同 V18-installer-compat 换成 0.7.19(manifest-0.7.19.json、make-patch.mjs 的 MIN_SHELL_VERSION,用户 2026-10-17 定不抬);老外壳那一半与 V19-os-real-shell 一起做;用户 2026-10-22 定:补丁演练用户自己测,记待办不挡发版'),
  MANUAL('V19-release-merge', '合入 main、版本号(0.7.18 → 0.7.19)、release 判过并推进', ['AB-7'], 'manual',
    '要用户授权(原则 4);照 git_and_release.md「release 分支」:基线全绿、npm run build 成功;git checkout release && git merge --ff-only <发版提交>;快进不了按 release-fallback.md'),
];

/**
 * 老项(0.7.18 及以前的)支撑 0.7.19 哪几条要求:id → 要求编号。总清单把它们补进各项的 v19。
 */
export const V19_TAGS = {
  'G0-1': ['OB-1'], 'G0-2': ['OB-1'], 'G0-3': ['OB-1'], 'G0-4': ['OB-1'],
  'GR-1': ['OB-2'], 'GR-2': ['OB-2'], 'GR-3': ['OB-2'], 'GR-4': ['OB-2'], 'GR-5': ['OB-2'],
  'V18-account-core': ['OB-3a'], 'V18-auth-account-path': ['OB-3a'], 'V18-account-pages-probe': ['OB-3a'],
  'P-desktop-auto-node': ['OB-3b'], 'P-m7-browser': ['OB-3b', 'OB-4'],
  'P-c10-browser-a4': ['OB-4'], 'P-c10-browser-full': ['OB-4'], 'P-c10-user-card': ['OB-4'], 'P-online-user-cards': ['OB-4'], 'P-c10-ui': ['OB-4'],
  'P-online-stage-watch': ['OB-4'], 'P-online-stale-layer': ['OB-4'], 'P-online-stage-handshake': ['OB-4'], 'P-online-nav-stress': ['OB-4'], 'P-m7-node': ['OB-4'],
  'RR-page-stream': ['OB-4', 'OB-3b'], 'RR-stage-gate': ['OB-4'], 'S1-4': ['OB-4'], 'S1-5': ['OB-4'], 'S2-1': ['OB-4'], 'S2-2': ['OB-4'], 'S2-3': ['OB-4'], 'S2-4': ['OB-4'], 'S2-5': ['OB-4', 'OB-3b'],
  'S4-4': ['OB-4'], 'S4-6': ['OB-4'],
  'RS18-queue': ['MP-3'], 'V18-queue-probe': ['MP-3'], 'V18-queue-isolation-probe': ['MP-4'], 'V18-queue-tests': ['MP-3', 'MP-4'], 'V18-queue-node-pressure': ['MP-5', 'AB-6'],
  'V18-gap-file-association': ['CM-7', 'AB-2'],
  'V18-move-probe': ['PRE-6'],
  'V18-runner-coverage': ['AB-3'], 'V18-runner-tests': ['AB-3'],
  'S1-r2': ['AB-6', 'MG-2'], 'S3-r2': ['AB-6', 'OB-3b'], 'S3-r3': ['AB-6'], 'S3-r5': ['AB-6'], 'V18-net-cert-proxy': ['AB-6'], 'V18-net-reconnect': ['AB-6'], 'V18-net-account-limits': ['AB-6'],
};

/** scripts/probes 下不进清单的、0.7.19 新出现的文件 */
export const V19_EXCLUDED = {
  // 0.7.20 的两块(申请加入与账号名单、改密退出后逐项撤回)已经在 main 上、会随 0.7.19 的包一起发,
  // 但它们的验收行归 0.7.20(account-binding-task.md「逐项验收」),清单项随 0.7.20 的清单一起加。
  'account-join-request-probe.mjs': '0.7.20 申请加入与账号名单的探针;0.7.19 清单不收,随 0.7.20 清单登记',
  'logout-rollback-probe.mjs': '0.7.20 改密退出后逐项撤回的探针;0.7.19 清单不收,随 0.7.20 清单登记',
  // 下面三支同理:它们验的功能已在 main 上、随 0.7.21 一起发,验收行归 0.7.21 的清单(2026-10-23 探针总审补登记,
  // 报告 docs/reports/AGENT-claude-probe-audit.md)。登记在这里只为让守门有据可查,不是说不跑 ——
  // 0.7.21 的清单建好时要把这三行删掉、改成各自的清单项。
  'cut-online-browser-probe.mjs': '〔裁〕R02(在线浏览器替剪辑段里的重卡产流)的探针,0.7.20 做成;0.7.19 清单不收,随 0.7.21 清单登记',
  'account-direct-address-probe.mjs': '0.7.21 项目直达地址与分享链接的探针;0.7.19 清单不收,随 0.7.21 清单登记',
  'update-notice-probe.mjs': '0.7.21 在线浏览器新版本提示与换代保留的探针;0.7.19 清单不收,随 0.7.21 清单登记',
};
