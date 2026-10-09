/**
 * 四段连做最终验收的清单(数据)。格式与字段含义见 `acceptance-lib.mjs` 的 `validateManifest`,运行见 `four-stage-acceptance.mjs`。
 *
 * 字段:
 *   id / name / category   编号、名字、类别(G0、G0-R、探针、第一段、第二段、第三段、第四段)
 *   level                  级别(`docs/semantics/guide_files/verification.md`「本地验证与真实网络验证」),每项都写:
 *                          'local' 本地验证(服务全在本机,合入 main 前跑的就是这一级;运行器缺省只跑它);
 *                          'network' 真实网络验证(只在往节点部署时、或改到网络这一层时做;照 four-stage-deploy-checklist.md 在节点上做,脚本不跑)
 *   taskRef                对应任务书哪一条(文字);tasks 是同一件事的机器可读版(R<n> = sound-online-render-task.md 第 n 条,
 *                          C<n> = cloud-agent-task.md「完成条件」第 n 条,U<n> = cloud-agent-task.md「用户体验验收」第 n 条)
 *   cmd | steps            命令(字符串数组,第一个是 node 就用当前的 node)或几步;steps 带 parallel:true 时并行
 *   cwd                    缺省仓库根;'main' = main 基准树
 *   needs                  先起的服务:dev(共享 dev server)、dev-main(main 基准树的 dev server)、main-worktree、online-build
 *   pass                   通过标准:exit(缺省 0)、must / mustNot(正则)、metrics + limits、resultLine;输出最后一个 JSON 里 fails 非空或 ok:false 一律不过
 *   timing: 'record'       这一项的探针会报耗时数字(输出里的 TIMINGS 行),timingNote 写记的是哪些。耗时只记录,不当通过条件
 *                          (verification.md「耗时只记录,不当闸门」);在哪台机器上跑都一样判,发版时汇进 docs/reports/release-timings.md
 *   remoteOnly / manual    在节点上做(level 必为 'network')/ 人工验:脚本不跑,占一行,文字写明怎么验
 *   requires / requiresText  本检出里要有的文件 / 文件里要有的字样,没有就记 missing(后三段的探针在它们的分支上才有)
 *   prereq                 前置项没过就记 blocked
 *   known                  已知的失败或不稳定(写进小结,不改判定)
 *   optional               补充项:缺省不跑,--include-optional 或 --only 点名才跑
 *   covers                 这一项覆盖 scripts/probes/ 下的哪些文件(--check-coverage 用)
 *
 * 端口:共享 dev server 5690～5692,main 基准树的 dev server 5693～5695;探针自己起的东西也在 5690～5699;文档服务 / 素材服务 8760～8769;
 * 探针自己限定端口段的照它的(multi-agent 5840～5859、skill-mcp 5880～5899)。串行跑,每项结束后它的进程都清掉。
 */

import '../lib/no-user-dirs.mjs'; // 清单里写着会起编辑器与导出的命令;按 no-user-dirs.test.mjs 的规矩,第一个 import 摘掉外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR

const node = 'node';
const probe = (name, args = []) => [node, `scripts/probes/${name}.mjs`, ...args];

/** 约定的端口 */
const B = '5690'; // 探针自己起的编辑器 / 在线站点的端口段起点
const DOC = (n = 0) => String(8760 + n);

/** 不在整套里的探针文件与原因(--check-coverage 对照) */
export const EXCLUDED_PROBE_FILES = {
  // 公共件与工具,不单独跑
  'asset-lan-discover.mjs': '公共件(局域网发现),单测在 server/test',
  'claim-gate-judge.mjs': '认领闸探针的判定函数,单测直接测',
  'codex-auth-fixture-loader.mjs': '测试进程加载器,被 codex-auth-state-probe 用',
  'm7-judge.mjs': 'M7 探针的纯判据,单测直接测',
  'm7-node-adapter.mjs': 'M7 探针读页面节点诊断的适配处,不单独跑',
  'probe-chrome.mjs': '探针共用的 Chrome 启动参数',
  'probe-connect.mjs': '探针共用的连接件',
  'probe-coord.mjs': '跨机探针共用的协调口',
  'stream-common.mjs': '轨道流探针的公共件',
  'stream-probe-project.mjs': '轨道流探针的夹具项目',
  'stream-demux-browser.js': '轨道流探针的页面脚本',
  'netlog-request.cjs': 'Chrome 网络日志的读取工具',
  'longtask-stacks.mjs': '长任务汇总工具',
  'gl-atlas-harness.html': '探针的页面夹具',
  'pixelmap-gl-harness.html': '探针的页面夹具',
  'placeholder-harness.html': '探针的页面夹具',
  'render-queue-proxy.mjs': '队列探针用的 TCP 代理,被 render-queue-e2e 与 card-sync-probe 用',
  'lowmem-online-probe.mjs': '要带在线模式编译期常量(VITE_PC_ONLINE=1)另起 dev server、再配远程素材服务,低内存档规则由 sound-ab、online-user-cards、c10-cost 三个探针的低内存档段覆盖',
  'c65-editor-probe.mjs': 'C6.5 页面一侧同步 / 撤销 / 离线 / 共享项目的点一遍探针(历史),要先手工起托管端并分阶段(local、shared、lan),主流程由 c10-ui、online-join 等覆盖',
  'm8-e-probe.mjs': 'M8 跨机编排探针,要第二台机器(笔记本),不在本机整套里',
  'm8-migrate-probe.mjs': 'M8 换机迁移演练,由主会话照迁移步骤做',
  'm8-outbound-probe.mjs': 'M8 只能出网的节点一侧,跨机',
  'ht-w-probe.mjs': 'W-HT-a 跨机探针,要第二台机器',
  'ht7-probe.mjs': 'HT7 从外面敲托管端,对象是已部署的托管端(见部署清单的新节点实测)',
  'c66-t9-probe.mjs': 'C6.6 T9 跨机探针,要第二台机器',
  'asset-lan-probe.mjs': '局域网素材服务探针,要第二台机器',
  'shared-project-lan.mjs': '共享项目局域网模式,要第二台机器',
  'shared-project-probe.mjs': '共享项目探针(互联网 / 局域网两种),要手工起托管端与协调口并分角色,不在整套里',
  'render-host-probe.mjs': '独立渲染主机探针(分角色、要协调口与第二台机器)',
  'c10-stage-probe.mjs': 'C10 可行性探针(历史),结论已落进契约',
  'oac-probe.mjs': 'Origin-Agent-Cluster 可行性探针(历史)',
  'backdrop-probe.mjs': '毛玻璃采样可行性探针(历史)',
  'videodecoder-probe.mjs': 'WebCodecs 可行性探针(历史)',
  'browser-stream-encode-probe.mjs': '浏览器压轨道流的可行性实测(见 render-standard.md),还没接进在线页面的生成流程,接进去后改进整套',
  'stateful-seek-cost-probe.mjs': '有状态的卡在在线后台舞台里跳到第 N 帧要多久的实验(见 render-standard.md),要先出在线构建,只记录耗时',
  'snapshot-diff-apply-probe.mjs': '快照「结构一份加每帧差异」的贴图耗时实验(见 render-standard.md),只记录耗时',
  'audio-determine-probe.mjs': '音频图卡判重方案的前提实测(历史)',
  'svg-url-serialize-probe.mjs': '序列化可行性探针(历史)',
  'inherited-props-probe.mjs': '属性表对账工具(历史)',
  'snapshot-size-probe.mjs': '快照体积实测(历史)',
  'snapshot-diff-compare.mjs': '差异样式内联的画面验收(历史,A2(8))',
  'snapshot-hash-probe.mjs': 'X6 跨进程快照哈希探针(历史)',
  'gl-atlas-probe.mjs': 'R9 M3 可行性探针(历史)',
  'gl-migrate-compare.mjs': 'R9 迁移对账(历史)',
  'gl-stage-probe.mjs': 'R9 共享渲染器探针(历史)',
  'gl-unified-probe.mjs': 'R9 统一渲染探针(历史)',
  'pixelmap-gl-probe.mjs': 'R9 像素图探针(历史)',
  'placeholder-probe.mjs': '占位符平面探针(历史,报告 REPORT-placeholder-plane)',
  'swap-cost-probe.mjs': 'SWAP_MS 实测工具',
  'cold-start-probe.mjs': 'dev server 冷启动量测工具',
  'png-adopt-probe.mjs': 'X7 可视验收(历史),要远端节点',
  'stream-alpha-quality.mjs': '轨道流单项实测(历史)',
  'stream-cadence.mjs': '轨道流单项实测(历史)',
  'stream-crop-rect.mjs': '轨道流单项实测(历史)',
  'stream-decode-throughput.mjs': '轨道流单项实测(历史)',
  'stream-editor-e2e.mjs': '轨道流编辑器端到端(历史)',
  'stream-encoder-params.mjs': '轨道流单项实测(历史)',
  'stream-fmp4-split.mjs': '轨道流单项实测(历史)',
  'stream-material.mjs': '轨道流单项实测(历史)',
  'stream-play-probe.mjs': '轨道流播放探针,接 stream-produce-probe --keep 的产物,不单独跑',
  'stream-roundtrip.mjs': '轨道流单项实测(历史)',
  'stream-sparse.mjs': '轨道流单项实测(历史)',
  'video-source-cadence-stress.mjs': '节奏探针的压力版(连跑若干遍),由 --flaky-rerun 的思路覆盖',
  'preview-3d-playback.mjs': '3D 页播放回归探针(历史)',
  'particles-paused-probe.mjs': '粒子卡暂停探针(历史)',
  'playback-probe.mjs': 'R5 播放与追帧探针(历史)',
  'reveal-probe.mjs': 'R7 露出舞台探针(历史)',
  'probe-gate-probe.mjs': 'R4b 加载遮罩探针(历史)',
  'stage-content-probe.mjs': 'R3 舞台内容探针(历史)',
  'stage-rpc-probe.mjs': 'E0 / E1 舞台 RPC 探针(历史)',
  'chat-window-probe.mjs': 'AI 栏聊天记录窗口化探针(历史)',
  'card-overlay-probe.mjs': '用户卡与改动层探针(装机版形态,历史)',
  'editor-preview-smoke.mjs': '编辑台冒烟(E0 / E1 / D3),由 preview-fallback 等覆盖',
  'ws-client-test.mjs': '文档服务骨架连通探针(历史,要先起 8787 的文档服务)',
  'render-queue-e2e.mjs': '渲染任务队列端到端(M5a 的探针,要先起文档服务并分角色),单测与 claim-gate 覆盖同一条路',
  'queue-single-pass-probe.mjs': '队列细任务一段一趟顺推的等价性探针(历史)',
  'stage-isolation-probe.mjs': 'E1 舞台独立进程探针(历史);OAC 隔离由在线探针覆盖',
  'm7-bake-probe.mjs': 'M7 P1～P3 实验探针(分子命令、要实验分支)',
  'm7-bake-node-probe.mjs': 'M7 P1～P3 页面节点分支版(分子命令)',
  'm7-build-probe.mjs': 'M7 P6 在线构建可跑性实验',
  'm7-upload-probe.mjs': 'M7 P4 推送实验(要手工给快照目录)',
  'm7-visibility-probe.mjs': 'M7 P5 页面隐藏 / 冻结实验(有头 Chrome、分钟级,要装好的 Chrome)',
  'reopen-association-lease.mjs': '协作重开专项(安装版、原生壳、广域网、第二台机器),不在第 7、8 节',
  'reopen-association-lease.ps1': '协作重开专项',
  'reopen-baseline.mjs': '协作重开专项',
  'reopen-capabilities.mjs': '协作重开专项',
  'reopen-e2e.mjs': '协作重开专项',
  'reopen-editor-env.mjs': '协作重开专项',
  'reopen-exit-matrix.mjs': '协作重开专项',
  'reopen-installed-lib.mjs': '协作重开专项',
  'reopen-installed-open.ps1': '协作重开专项',
  'reopen-installed-query.ps1': '协作重开专项',
  'reopen-installed-state.mjs': '协作重开专项',
  'reopen-installed.mjs': '协作重开专项',
  'reopen-matrix.mjs': '协作重开专项',
  'reopen-native-association.mjs': '协作重开专项',
  'reopen-native-fixture.mjs': '协作重开专项',
  'reopen-native-process-watch.ps1': '协作重开专项',
  'reopen-native-upgrade.mjs': '协作重开专项',
  'reopen-native.mjs': '协作重开专项',
  'reopen-online.mjs': '协作重开专项',
  'reopen-public-gateway.mjs': '协作重开专项',
  'reopen-public-tunnel.mjs': '协作重开专项',
  'reopen-reboot.mjs': '协作重开专项',
  'reopen-remote-host.mjs': '协作重开专项',
  'reopen-sealed.mjs': '协作重开专项',
  'reopen-wan-member.mjs': '协作重开专项',
  'reopen-wan-peer.mjs': '协作重开专项',
  'reopen-wan.mjs': '协作重开专项',
  // 后三段分支上新增的公共件
  'lib-graph-snapshot-size.mjs': '第二段探针公共件(在 claude/online-cards 上)',
  'lib-seed.mjs': '第二段探针公共件(在 claude/online-cards 上)',
  'cloud-agent-probe-lib.mjs': '第四段探针公共件(在 claude/cloud-agent 上)',
  'cloud-agent-ui-lib.mjs': '第四段探针公共件(在 claude/cloud-agent 上)',
  'cloud-agent-isolation-look.mjs': '第四段隔离探针里「看画面」的一组,由 cloud-agent-isolation-probe(S4-2)调,不单独跑',
  'cloud-agent-isolation-tools.mjs': '第四段隔离探针里「工具」的几组,由 cloud-agent-isolation-probe(S4-2)调,不单独跑',
  'probe-timings.mjs': '探针共用的耗时记录件(耗时只记录,不当闸门),单测在 server/test/probe-timings.test.mjs',
  // 已交付、能在本机独立跑、但还没有进整套清单的验收探针:要不要加成清单项等用户定(见 docs/reports/REPORT-verification-rework.md「看到了但没有自己定的」)
  'hosted-render-isolation-probe.mjs': '第三段「越权探测卡」隔离验收探针(49 条),清单里还没有对应的项,待用户定是否加入',
  'hosted-render-node-side-check.mjs': '第三段同步文件预检的对照实验(回答缺口在不在,故意不经过预检),清单里还没有对应的项,待用户定是否加入',
  'cloud-agent-look-probe.mjs': '第四段云端 Agent「看画面」端到端探针,清单里还没有对应的项,待用户定是否加入',
  'cloud-agent-sound-probe.mjs': '第四段云端 Agent「声音」端到端探针,清单里还没有对应的项,待用户定是否加入',
  'cloud-agent-first-video-probe.mjs': '第四段「首支短片」探针(模拟模型冒烟;--real-model 有费用),清单里只有真实模型的 S4-r6 一行(脚本不跑),待用户定是否加入',
};

/* ------------------------------------------------------------------ 清单 */

const JSON_OK = { strictJson: true };

export const ITEMS = [
  /* ============================== G0 通用门槛 ============================== */
  {
    id: 'G0-1', name: '类型检查 tsc -b --force', category: 'G0', level: 'local', taskRef: '最后一次完整验收第 1 步;任务书一 第 1 条',
    tasks: ['R1'], cmd: [node, '{tsc}', '-b', '--force'], pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'G0-2', name: '全量测试 npm test', category: 'G0', level: 'local', taskRef: '最后一次完整验收第 1 步;任务书一 第 1 条;主计划 G0(失败 0、跳过 ≤ 2)',
    tasks: ['R1', 'C3', 'C11'], cmd: [node, 'scripts/test-suite.mjs'],
    pass: {
      exit: 0, must: ['最终结果:零失败|最终结果：零失败'],
      metrics: { tests: 'ℹ tests (\\d+)', pass: 'ℹ pass (\\d+)', fail: 'ℹ fail (\\d+)', skipped: 'ℹ skipped (\\d+)' },
      limits: { fail: { eq: 0 }, skipped: { max: 2 } },
    },
    timeoutMin: 45, idleKillMin: 12, retryOnIdle: true,
    known: 'server/test/codex-auth-state.test.mjs 偶发卡死:日志十几分钟没输出就结束这一轮的子进程树后重跑(runner 的 idleKillMin 12、自动重跑一次)',
  },
  {
    id: 'G0-3', name: '网页构建 npm run build(tsc -b 与 vite build)', category: 'G0', level: 'local', taskRef: '最后一次完整验收第 1 步;任务书一 第 1 条;release 合入条件第二条',
    tasks: ['R1', 'C11'], steps: [[node, '{tsc}', '-b'], [node, '{vite}', 'build']], pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'G0-4', name: '在线构建 vite build --mode online', category: 'G0', level: 'local', taskRef: '最后一次完整验收第 1 步;任务书一 第 1 条',
    tasks: ['R1', 'C11'],
    steps: [
      [node, '{vite}', 'build', '--mode', 'online', '--outDir', '{dist}'],
      [node, '-e', 'const fs=require("fs"),cp=require("child_process");fs.writeFileSync(process.argv[1]+"/.built-from",cp.execSync("git rev-parse HEAD",{encoding:"utf8"}).trim())', '{dist}'],
    ],
    pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'G0-5', name: '桌面壳脚本测试 node --test desktop/test', category: 'G0', level: 'local', taskRef: '上一次整套(a45)的 G0 附带项;外壳版本判断的旁证',
    tasks: [], cmd: [node, '--test', 'desktop/test/*.test.mjs'],
    pass: { exit: 0, metrics: { fail: 'ℹ fail (\\d+)' }, limits: { fail: { eq: 0 } } }, timeoutMin: 10,
  },

  /* ============================== G0-R 渲染附加项 ============================== */
  {
    id: 'GR-1', name: 'main 基准树全长导出(1800 帧,单进程)', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「导出像素基线」;任务书一 第二段「桌面导出像素 0 差异」(核心项)',
    tasks: [], needs: ['dev-main'], cwd: 'main',
    cmd: [node, 'scripts/export-frames.mjs', '--url', '{dev-main.origin}/?export=1', '--fps', '30', '--workers', '1', '--no-video', '--out', '{out}/pixels/main'],
    pass: { exit: 0 }, timeoutMin: 40,
  },
  {
    id: 'GR-2', name: '候选全长导出(与 main 同参数)', category: 'G0-R', level: 'local', taskRef: '同上',
    tasks: [], needs: ['dev'],
    cmd: [node, 'scripts/export-frames.mjs', '--url', '{dev.origin}/?export=1', '--fps', '30', '--workers', '1', '--no-video', '--out', '{out}/pixels/cand'],
    pass: { exit: 0 }, timeoutMin: 40,
  },
  {
    id: 'GR-3', name: '与 main 的像素比对:0 不同、0 缺失', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「导出像素基线」;最后一次完整验收第 1 步(与 main 的像素比对 0 差异)',
    tasks: ['R6'], prereq: ['GR-1', 'GR-2'], covers: ['export-baseline-compare.mjs'],
    cmd: probe('export-baseline-compare', ['--baseline', '{out}/pixels/main/frames', '--candidate', '{out}/pixels/cand/frames']),
    pass: {
      exit: 0, must: ['逐字节:相同 (\\d+)/\\1(?!\\d)', '全长导出逐字节相同'], mustNot: ['只在基线里的帧', '只在候选里的帧'],
      metrics: { identical: '逐字节:相同 (\\d+)/' }, limits: { identical: { min: 1800 } },
    },
    timeoutMin: 20,
  },
  {
    id: 'GR-4', name: '导出确定性:同一段导两遍逐像素相同(1800/1800)', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「导出确定性」',
    tasks: [], needs: ['dev'],
    cmd: [node, 'scripts/verify-determinism.mjs', '--url', '{dev.origin}/?export=1', '--fps', '30'],
    pass: { exit: 0, must: ['Total Frames: 1800', 'Identical: 1800', 'Different: 0'] }, timeoutMin: 40,
  },
  {
    id: 'GR-5', name: '导出与快照重放一致 verify-unified-frames', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「快照重放一致」',
    tasks: [], needs: ['dev'], cmd: [node, 'scripts/verify-unified-frames.mjs', '--origin', '{dev.origin}'], pass: { exit: 0 }, timeoutMin: 10,
  },
  {
    id: 'GR-6', name: 'ready-index-probe(就绪索引的端到端)', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「预渲染探针」',
    tasks: [], covers: ['ready-index-probe.mjs'], cmd: probe('ready-index-probe', ['--port', B]),
    pass: { exit: 0 }, timing: 'record', timingNote: '每一处等待等到的用时(没有时间门槛;等待时限只为防卡死,不少于 120 秒)',
    timeoutMin: 20,
  },
  {
    id: 'GR-7', name: 'stream-produce-probe(轨道流生产,含全幅编码 p50 ≤ 300 ms)', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「预渲染探针」',
    tasks: [], needs: ['dev'], covers: ['stream-produce-probe.mjs'], cmd: probe('stream-produce-probe', ['--origin', '{dev.origin}']),
    pass: { exit: 0, must: ['^PASS$'] }, timing: 'record', timingNote: '15 帧分段编码 p50(原门槛 1080p 全幅流 ≤ 300 ms)、全部分段满密度的用时、替换后旧文件删掉的用时', timeoutMin: 20,
  },
  {
    id: 'GR-8', name: 'stream-produce-probe --group(组流)', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「预渲染探针」含 --group',
    tasks: [], needs: ['dev'], covers: ['stream-produce-probe.mjs'], cmd: probe('stream-produce-probe', ['--origin', '{dev.origin}', '--group']),
    pass: { exit: 0, must: ['^PASS$'] }, timing: 'record', timingNote: '全部分段满密度的用时(组流不做编码基准)', timeoutMin: 20,
  },
  {
    id: 'GR-9', name: 'preview-fallback-probe(普通预览兜底顺序)', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「预渲染探针」',
    tasks: [], needs: ['dev'], covers: ['preview-fallback-probe.mjs'], cmd: probe('preview-fallback-probe', ['--origin', '{dev.origin}']),
    pass: { exit: 0, must: ['^PASS$'] }, timing: 'record', timingNote: '各场景每拍主线程耗时 p90;transparent 拍数为 0 照旧是通过条件', timeoutMin: 20,
  },
  {
    id: 'GR-10', name: 'preview-fallback-probe --page-preload', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R「预渲染探针」含 --page-preload',
    tasks: [], needs: ['dev'], covers: ['preview-fallback-probe.mjs'], cmd: probe('preview-fallback-probe', ['--origin', '{dev.origin}', '--page-preload']),
    pass: { exit: 0, must: ['^PASS$'] }, timing: 'record', timingNote: '同 GR-9', timeoutMin: 20,
  },
  {
    id: 'GR-11', name: 'video-source-cadence-probe(视频取帧节奏)', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R(改到取帧、解码、图卡视频源时另跑)',
    tasks: [], covers: ['video-source-cadence-probe.mjs'], cmd: probe('video-source-cadence-probe', ['--port', B]),
    pass: { exit: 0, must: ['"fails":\\s*\\[\\]'] }, timeoutMin: 20,
    known: '上一轮整套里有过一次偶发(紧接最忙的探针之后);已在 claude/cadence-race 修过',
  },
  {
    id: 'GR-12', name: 'video-seek-race-probe 三实例并行(取帧竞态,各 300 轮)', category: 'G0-R', level: 'local', taskRef: '主计划 G0-R(取帧竞态回归基线);stale、wrongPixel 都要 0',
    tasks: [], covers: ['video-seek-race-probe.mjs'], parallel: true,
    steps: [0, 1, 2].map((i) => ({ cmd: probe('video-seek-race-probe', ['--port', String(5690 + i), '--mode', 'fixed', '--busy', '--settle', '0', '--loops', '300']) })),
    pass: { exit: 0, must: ['"stale":0', '"wrongPixel":0'] }, timeoutMin: 30,
  },

  /* ============================== 探针:主计划第 7、8 节点名与上一次整套(a45)跑过的 ============================== */
  // —— 在线构建一组 ——
  {
    id: 'P-c10-browser-a4', name: 'C10 在线普通档 A1～A4(不导视频)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10;任务书一 第 17 条(原有探针不退步)',
    tasks: ['R17'], needs: ['online-build'], covers: ['c10-browser-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('c10-browser-probe', ['--only-a4', '--no-video', '--base-port', B, '--dist', '{dist}']), pass: { exit: 0 },
    timing: 'record', timingNote: '各步用时;A1「播放 10 秒主文档长任务 0」照旧是通过条件', timeoutMin: 30,
  },
  {
    id: 'P-c10-browser-full', name: 'C10 在线普通档完整版 A1～A5', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10',
    tasks: ['R17'], needs: ['online-build'], covers: ['c10-browser-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('c10-browser-probe', ['--base-port', B, '--dist', '{dist}']), pass: { exit: 0 },
    timing: 'record', timingNote: '各步用时(含 A5 独立渲染主机一步);A1 主文档长任务 0 照旧是通过条件', timeoutMin: 45,
    known: 'main 上 A5(独立渲染主机认领清单计划)超时',
  },
  {
    id: 'P-c10-user-card', name: 'C10 用户卡端到端 --user-card', category: '探针', level: 'local', taskRef: '任务书一 第 17 条(c10-browser-probe --user-card 仍过)',
    tasks: ['R17'], needs: ['online-build'], covers: ['c10-browser-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('c10-browser-probe', ['--user-card', '--only-a4', '--no-video', '--base-port', B, '--dist', '{dist}']), pass: { exit: 0 },
    timing: 'record', timingNote: '各步用时(含用户卡一步);A1 主文档长任务 0 照旧是通过条件', timeoutMin: 45,
  },
  {
    id: 'P-online-user-cards', name: '在线用户卡探针', category: '探针', level: 'local', taskRef: '任务书一 第 17 条(online-user-cards-probe 仍过)',
    tasks: ['R17'], needs: ['online-build'], covers: ['online-user-cards-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('online-user-cards-probe', ['--dist', '{dist}', '--base-port', B, '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 30,
    known: 'main 上不过:探针建的项目是空的,在线页面加入空项目被拒;修复在第二段分支上',
    timing: 'record', timingNote: '用户卡测完到最后一拍还停在快照的用时(原门槛 ≤ 3 秒)',
  },
  {
    id: 'P-c10-ui', name: 'C10 界面探针(徽标、断线重连、用户卡贴层)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10;任务书一 第 17 条',
    tasks: ['R17'], needs: ['online-build'], covers: ['c10-ui-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('c10-ui-probe', ['--dist', '{dist}', '--out', '{item}', '--proxy-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1), '--proxy2-port', '5693']), pass: { exit: 0 }, timeoutMin: 30,
    known: 'main 上不过:同上(空项目加入被拒)',
  },
  {
    id: 'P-online-stage-watch', name: '在线舞台看守(握手后又断)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10',
    tasks: [], needs: ['online-build'], covers: ['online-stage-watch-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('online-stage-watch-probe', ['--dist', '{dist}', '--base-port', B, '--out', '{item}']), pass: { exit: 0 },
    timing: 'record', timingNote: '弄崩到重载、握回、退回单舞台、画回片段的用时(原等待上限 60 / 120 秒;现在等待不少于 180 秒)', timeoutMin: 20,
  },
  {
    id: 'P-online-stale-layer', name: '在线改参数后不再贴旧层', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10',
    tasks: [], needs: ['online-build'], covers: ['online-stale-layer-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('online-stale-layer-probe', ['--dist', '{dist}', '--base-port', B, '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'P-online-stage-handshake', name: '在线舞台首次握手计时(慢网络退单舞台)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10',
    tasks: [], needs: ['online-build'], covers: ['online-stage-handshake-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('online-stage-handshake-probe', ['--dist', '{dist}', '--base-port', B, '--out', '{item}']), pass: { exit: 0 },
    timing: 'record', timingNote: '挂上到进过渡期、第一次画出(原门槛 ≤ 24 秒)、握上手、换回双舞台、退回单舞台(原上界 30 / 35 秒)的用时', timeoutMin: 20,
  },
  {
    id: 'P-online-nav-stress', name: '在线页导航压测 200 次', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10(偶发导航超时的回归)',
    tasks: [], needs: ['online-build'], covers: ['online-nav-stress-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('online-nav-stress-probe', ['--dist', '{dist}', '--base-port', B, '--iters', '200', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'P-desktop-auto-node', name: '桌面应用自动成为渲染节点', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10 / M7 之后的桌面节点',
    tasks: ['R17'], needs: ['online-build'], covers: ['desktop-auto-node-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('desktop-auto-node-probe', ['--dist', '{dist}', '--base-port', B, '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'P-m7-browser', name: 'M7 纯浏览器节点验收(本机替身,A1～A12;「跨机」不再单独成项)', category: '探针', level: 'local', taskRef: '主计划第 7 节 M7;任务书一 第 16、17 条',
    tasks: ['R16', 'R17'], covers: ['m7-browser-probe.mjs'],
    cmd: probe('m7-browser-probe', ['--role', 'all', '--base-port', B, '--out', '{item}']),
    pass: { exit: 0, must: ['"fails":\\[\\]', '"pending":\\[\\]'] }, timing: 'record', timingNote: 'A4 最慢锚帧段的用时(原门槛 ≤ 30 秒)、A5 让路后恢复认领的用时、A10 切分 / 抢卡 / 换层的用时;A12 长任务 0 照旧是通过条件',
    timeoutMin: 60, known: 'A10 抢卡一步历史上贴着 300 s 等待上限(等待上限现在是防卡死用,切分 600 秒、抢卡 900 秒)',
  },
  {
    id: 'P-m7-node', name: 'M7 纯浏览器节点本机端到端', category: '探针', level: 'local', taskRef: '主计划第 7 节 M7',
    tasks: ['R16'], needs: ['online-build'], covers: ['m7-node-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('m7-node-probe', ['--dist', '{dist}', '--base-port', B, '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 30,
    known: 'main 上不过:同上(空项目加入被拒);修复在第二、四段分支上',
  },
  // —— 本机 dev server 一组 ——
  {
    id: 'P-tier-switch', name: '两档素材换档(黑帧、帧误差、超时)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C6.6',
    tasks: [], needs: ['dev'], covers: ['tier-switch-probe.mjs'],
    cmd: probe('tier-switch-probe', ['--origin', '{dev.origin}', '--remote-port', '5696', '--out', '{item}']), pass: { exit: 0 },
    timing: 'record', timingNote: 'T5a 素材原尺寸到齐后多久被轮询看到(原门槛 ≤ 2600 ms)、各场景换到素材原尺寸的用时;黑帧 0、帧误差照旧是通过条件', timeoutMin: 20,
    known: '上一轮整套里在一个新基线上不过,查明是探针夹具没进共享空间(修在 claude/tier-switch-baseline 并已合入)',
  },
  {
    id: 'P-creativity', name: '创造力等级界面', category: '探针', level: 'local', taskRef: '主计划 Agent 与工作方式 A1',
    tasks: [], needs: ['dev'], covers: ['creativity-probe.mjs'], cmd: probe('creativity-probe', ['--origin', '{dev.origin}']), pass: { exit: 0 }, timeoutMin: 10,
  },
  {
    id: 'P-user-editing', name: '「用户正在编辑」', category: '探针', level: 'local', taskRef: '主计划 Agent 与工作方式 A2',
    tasks: [], needs: ['dev'], covers: ['user-editing-probe.mjs'], cmd: probe('user-editing-probe', ['--origin', '{dev.origin}']), pass: { exit: 0 }, timeoutMin: 10,
  },
  // —— 探针自己起服务的一组 ——
  {
    id: 'P-query-render', name: '查询渲染调度', category: '探针', level: 'local', taskRef: '主计划 Agent 与工作方式(查询渲染)',
    tasks: [], covers: ['query-render-probe.mjs'], cmd: probe('query-render-probe', ['--port', B]), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'P-multi-agent', name: '多 Agent(阶段一与阶段二)', category: '探针', level: 'local', taskRef: '主计划 Agent 与工作方式 A3;任务书二 第 3 条(桌面 Agent 相关探针不变红)',
    tasks: ['C3'], covers: ['multi-agent-probe.mjs'], cmd: probe('multi-agent-probe', ['--phase', 'all', '--shots', '{item}']), pass: { exit: 0 }, timeoutMin: 20,
    known: '端口按探针自己的段 5840～5859;main 上第二阶段不过:探针建的项目是空的、在线页面加入空项目被拒',
  },
  {
    id: 'P-custom-measure', name: '自定义测量 measure_audio_js', category: '探针', level: 'local', taskRef: '主计划 Agent 与工作方式 A6',
    tasks: [], covers: ['custom-measure-probe.mjs'], cmd: probe('custom-measure-probe', ['--port', '5860']), pass: { exit: 0 }, timeoutMin: 15,
    timing: 'record', timingNote: '死循环脚本从调用到被终止的用时(原门槛 < 17 秒)',
  },
  {
    id: 'P-skill-mcp', name: 'SKILL 经 MCP 直连', category: '探针', level: 'local', taskRef: '主计划 Agent 与工作方式 A4;任务书二 第 3 条',
    tasks: ['C3'], covers: ['skill-mcp-probe.mjs'], cmd: probe('skill-mcp-probe', ['--port', '5880', '--shots', '{item}']), pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'P-codex-auth-state', name: 'Codex 登录状态的界面探针', category: '探针', level: 'local', taskRef: '任务书二 第 3 条(桌面 Agent 相关探针不变红)',
    tasks: ['C3'], covers: ['codex-auth-state-probe.mjs'],
    requiresText: [{ file: 'scripts/probes/codex-auth-state-probe.mjs', text: "resolve('vite/package.json')" }],
    cmd: probe('codex-auth-state-probe', ['--port', B]), pass: { exit: 0 }, timeoutMin: 10,
    known: '本检出的探针端口写死 5203(dev-test 段),且按相对路径找 node_modules、在 worktree 里起不来(超时);修复(--port、vite 向上解析)在第四段分支上;requiresText 认的是修复后才有的 vite 向上解析那一行,没有就记 missing、不去跑(免得写死的 5203 被占)',
  },
  {
    id: 'P-asset-path', name: 'Agent 读素材走素材服务', category: '探针', level: 'local', taskRef: '主计划第 7 节 C5 之后的 Agent 素材路径',
    tasks: [], covers: ['asset-path-probe.mjs'], cmd: probe('asset-path-probe', ['--port', B]), pass: { exit: 0 }, timeoutMin: 15,
    known: '要一个带 numpy 的 Python(PATH 上的 python 或环境变量 PROMPTCUT_TEST_PYTHON);这台 PC 上没有,P7～P11 一项不过(其余 19 项过)——属缺环境,不是代码问题',
  },
  {
    id: 'P-bake-asset', name: 'bake_card 快照经素材服务存取', category: '探针', level: 'local', taskRef: '主计划第 7 节(预渲染产物入库)',
    tasks: [], covers: ['bake-asset-probe.mjs'], cmd: probe('bake-asset-probe', ['--port', B]), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'P-claim-gate', name: '队列模式认领闸', category: '探针', level: 'local', taskRef: '主计划第 7 节 M5b(队列接真业务与认领)',
    tasks: [], covers: ['claim-gate-probe.mjs', 'claim-gate-judge.mjs'], cmd: probe('claim-gate-probe', ['--port', B, '--doc-port', DOC(0)]), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'P-tiers', name: '两档素材与上传队列', category: '探针', level: 'local', taskRef: '主计划第 7 节 C6.6',
    tasks: [], covers: ['tiers-probe.mjs'], cmd: probe('tiers-probe', ['--port-a', B, '--port-r', '5693']), pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'P-storage-cap', name: '帧库上限与淘汰', category: '探针', level: 'local', taskRef: '主计划第 7 节(存储占用)',
    tasks: [], covers: ['storage-cap-probe.mjs'], cmd: probe('storage-cap-probe', ['--port', B]), pass: { exit: 0 }, timeoutMin: 10,
  },
  {
    id: 'P-storage-ui', name: '开始页「存储」界面', category: '探针', level: 'local', taskRef: '主计划第 7 节(存储占用)',
    tasks: [], covers: ['storage-ui-probe.mjs'], cmd: probe('storage-ui-probe', ['--port', B, '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 10,
    timing: 'record', timingNote: '开始页的占用数字变成真实值的用时(原门槛 < 20 秒)',
  },
  {
    id: 'P-cross-machine-proc', name: '跨机器直接打开 .proc', category: '探针', level: 'local', taskRef: '主计划第 7 节(跨机器素材路径)',
    tasks: [], covers: ['cross-machine-proc-probe.mjs'], cmd: probe('cross-machine-proc-probe', ['--port-a', B, '--port-b', '5693', '--port-c', '5696', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'P-shared-import-upload', name: '共享项目新导入素材到达其它成员', category: '探针', level: 'local', taskRef: '主计划第 7 节 SP / C6.6',
    tasks: [], covers: ['shared-import-upload-probe.mjs'],
    cmd: probe('shared-import-upload-probe', ['--doc-port', DOC(0), '--asset-port', DOC(1), '--port-a', B, '--port-b', '5693', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'P-push-race-shard', name: '素材推送竞态(分片布局 30 轮)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C5(素材服务存储层)',
    tasks: [], covers: ['push-race-probe.mjs'], cmd: probe('push-race-probe', ['--port', DOC(0), '--rounds', '30', '--store', 'shard']), pass: { exit: 0 }, timeoutMin: 10,
  },
  {
    id: 'P-push-race-flat', name: '素材推送竞态(平铺布局 30 轮)', category: '探针', level: 'local', taskRef: '同上',
    tasks: [], covers: ['push-race-probe.mjs'], cmd: probe('push-race-probe', ['--port', DOC(0), '--rounds', '30', '--store', 'flat']), pass: { exit: 0 }, timeoutMin: 10,
  },

  /* ============================== 补充:其余仍可本机独立跑的现有探针(缺省不跑) ============================== */
  {
    id: 'X-c10-catalog', name: '在线 Lottie / 粒子素材卡取得到 /catalog', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10 收尾', optional: true,
    tasks: [], needs: ['online-build'], covers: ['c10-catalog-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('c10-catalog-probe', ['--dist', '{dist}', '--base-port', B, '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'X-c10-cost', name: '低内存档完整规则(成本、判轻判重)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10 其余', optional: true,
    tasks: [], needs: ['online-build'], covers: ['c10-cost-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('c10-cost-probe', ['--dist', '{dist}', '--port', B, '--proxy-port', '5693', '--doc-port', DOC(0), '--asset-port', DOC(1), '--debug-port', '5697', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 40,
  },
  {
    id: 'X-c10a-online', name: 'C10a 在线页面静态形状(不请求 /api/*)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10a', optional: true,
    tasks: [], needs: ['online-build'], covers: ['c10a-online-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('c10a-online-probe', ['--dist', '{dist}', '--port', B, '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'X-online-join', name: 'C10a 加入别人的项目、多用户协作', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10a', optional: true,
    tasks: [], needs: ['online-build'], covers: ['online-join-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('online-join-probe', ['--dist', '{dist}', '--out', '{item}', '--desktop-port', B, '--proxy-port', '5694', '--doc-port', DOC(0), '--asset-port', DOC(1)]), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'X-c10a-demo-local', name: 'C10a demo(本机替身)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10a', optional: true,
    tasks: [], needs: ['online-build'], covers: ['c10a-demo-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('c10a-demo-probe', ['--local', '--dist', '{dist}', '--port', B, '--proxy-port', '5694', '--doc-port', DOC(0), '--asset-port', DOC(1), '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 60,
  },
  {
    id: 'X-queue-mode', name: '队列模式端到端', category: '探针', level: 'local', taskRef: '主计划第 7 节 M1～M5', optional: true,
    tasks: [], covers: ['queue-mode-probe.mjs'], cmd: probe('queue-mode-probe', ['--queue-port', B, '--normal-port', '5693', '--docservice-port', DOC(0)]), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'X-procp-roundtrip', name: '打包保存 .procp 往返', category: '探针', level: 'local', taskRef: '主计划第 7 节(打包保存)', optional: true,
    tasks: ['R7'], covers: ['procp-roundtrip-probe.mjs'], cmd: probe('procp-roundtrip-probe', ['--port-a', B, '--port-b', '5693', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'X-card-sync', name: '卡片源码同步(含 --cut-b 之外的基本路径)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C6.6 T8', optional: true,
    tasks: [], covers: ['card-sync-probe.mjs'], cmd: probe('card-sync-probe', ['--doc-port', DOC(0), '--asset-port', DOC(1), '--a-port', B, '--b-port', '5693', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 20,
    timing: 'record', timingNote: '另一台装上卡片源码、重新测量的用时(原门槛各 ≤ 5 秒)',
  },
  {
    id: 'X-m8-scale-k1', name: 'M8 规模复测 K1(本机替身)', category: '探针', level: 'local', taskRef: '主计划第 7 节 M8', optional: true,
    tasks: [], covers: ['m8-scale-probe.mjs'], cmd: probe('m8-scale-probe', ['--role', 'all', '--case', 'k1']), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'X-m8-scale-i1', name: 'M8 规模复测 I1(本机替身)', category: '探针', level: 'local', taskRef: '主计划第 7 节 M8', optional: true,
    tasks: [], covers: ['m8-scale-probe.mjs'], cmd: probe('m8-scale-probe', ['--role', 'all', '--case', 'i1']), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'X-small-tier', name: '预渲染小尺寸(渲染节点一侧)', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10a(小尺寸)', optional: true,
    tasks: [], needs: ['dev'], covers: ['small-tier-probe.mjs'], cmd: probe('small-tier-probe', ['--origin', '{dev.origin}', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'X-lowmem-export-compare', name: '低内存档逐帧导出与桌面导出逐帧比', category: '探针', level: 'local', taskRef: '主计划第 7 节 C10a(低内存档导出)', optional: true,
    tasks: [], needs: ['dev'], covers: ['lowmem-export-compare.mjs'], cmd: probe('lowmem-export-compare', ['--origin', '{dev.origin}', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'X-render-host-local', name: '独立渲染主机探针(本机 creator)', category: '探针', level: 'local', taskRef: '主计划第 7 节 M6(M6b)', optional: true,
    tasks: [], covers: ['render-host-probe.mjs'], manual: '分角色、要协调口与第二台机器(creator / host / check),不在 runner 里串行跑;按文件头用法由主会话手工起',
  },

  /* ============================== 第一段:声音 ============================== */
  {
    id: 'S1-1', name: '声音探针完整版(真实浏览器)', category: '第一段', level: 'local', taskRef: '任务书一 第 2 条',
    tasks: ['R2'], needs: ['dev'], covers: ['sound-effects-probe.mjs'],
    cmd: probe('sound-effects-probe', ['--origin', '{dev.origin}', '--asset-port', '5696', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'S1-2', name: '声音探针完整版 --av(导出 MP4 与音轨量测)', category: '第一段', level: 'local', taskRef: '任务书一 第 2 条(--av)',
    tasks: ['R2'], needs: ['dev'], covers: ['sound-effects-probe.mjs'],
    cmd: probe('sound-effects-probe', ['--origin', '{dev.origin}', '--asset-port', '5696', '--out', '{item}', '--av']), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'S1-3', name: '声音探针便携版 --node-only --av', category: '第一段', level: 'local', taskRef: '任务书一 第 2 条(Node 一侧)',
    tasks: ['R2'], covers: ['sound-effects-probe.mjs'],
    cmd: [node, '--experimental-transform-types', 'scripts/probes/sound-effects-probe.mjs', '--node-only', '--av', '--out', '{item}'], pass: { exit: 0 }, timeoutMin: 10,
  },
  {
    id: 'S1-4', name: '声音预览(桌面、在线、重开、在线合成)', category: '第一段', level: 'local', taskRef: '任务书一 第 3、7 条',
    tasks: ['R3', 'R7'], needs: ['online-build'], covers: ['sound-preview-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('sound-preview-probe', ['--mode', 'both', '--base-port', B, '--doc-port', DOC(2), '--asset-port', DOC(3), '--dist', '{dist}', '--out', '{item}']), pass: { exit: 0 },
    timing: 'record', timingNote: 'P2 暂停到停声的用时(原门槛 ≤ 300 ms);对齐阈值(ALIGN_SEC 0.15 s、占比 ≥ 90%)这次保留为通过条件、待用户定', timeoutMin: 40,
  },
  {
    id: 'S1-5', name: '声音 A、B:导出自动生成与在线合成(桌面、在线普通档、低内存档)', category: '第一段', level: 'local', taskRef: '任务书一 第 4、5 条(决定 A、B)',
    tasks: ['R4', 'R5'], needs: ['online-build'], covers: ['sound-ab-probe.mjs'], prereq: ['G0-4'],
    cmd: probe('sound-ab-probe', ['--dist', '{dist}', '--out', '{item}', '--desktop-port', B, '--site-port', '5693', '--doc-port', DOC(0), '--asset-port', DOC(1)]), pass: { exit: 0 }, timeoutMin: 40,
  },
  {
    id: 'S1-6', name: '声音样本导出(提示音、键盘声、有声动效卡各一段 MP4)', category: '第一段', level: 'local', taskRef: '任务书一 第 8 条',
    tasks: ['R8'], covers: ['sound-samples-probe.mjs'],
    cmd: probe('sound-samples-probe', ['--base-port', B, '--out', '{item}/samples']), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'S1-7', name: '打字动画卡改前改后逐帧比对(核心项)', category: '第一段', level: 'local', taskRef: '任务书一 第 6 条;「没过怎么办」第一段核心项(默认参数画面与 main 一致)',
    tasks: ['R6'], needs: ['main-worktree'], covers: ['typing-card-compare.mjs'],
    cmd: probe('typing-card-compare', ['--main', '{main}', '--out', '{item}', '--port', B]), pass: { exit: 0 }, timeoutMin: 45,
  },
  {
    id: 'S1-m1', name: '第一段的语义文档与 A、B 一致', category: '第一段', level: 'local', taskRef: '任务书一 第 1、11 条',
    tasks: ['R1', 'R11'], manual: '读 product/rendering.md「有声动效卡」、product/platforms.md「卡片声音的平台边界」、mechanism/rendering.md「声音的轻重」与任务书决定 A、B 逐句对;TODO.md 更新;draft_sound-effects.md 并入后已删,draft_TODO.md 里 0.5 期一行改成已完成',
  },
  {
    id: 'S1-m2', name: '声音预览的截图 / 录屏过目', category: '第一段', level: 'local', taskRef: '任务书一 第 3 条(有截图或录屏)',
    tasks: ['R3'], manual: '看 S1-4 的 --out 目录里桌面与在线的预览截图(播放、静音标记、拖动后、恢复);探针断言已经量过数字,这里只看画面有没有明显不对',
  },
  {
    id: 'S1-m3', name: '音色人耳试听', category: '第一段', level: 'local', taskRef: '任务书一「用户已经审过并同意的」末条(音色不挡合入,样本给用户听)',
    tasks: [], manual: '把 S1-6 导出的三段样本路径交给用户听,音色参数之后再调',
  },
  {
    id: 'S1-m4', name: '声音:合入 main、0.7.18、补丁、release', category: '第一段', level: 'local', taskRef: '任务书一 第 9 条',
    tasks: ['R9'], manual: '不在新节点上,但只能在完整验收通过之后做:见 docs/plan/four-stage-deploy-checklist.md「合入 main 之前」「版本号与补丁」;产物路径、大小、SHA-256 贴进总报告',
  },
  {
    id: 'S1-r2', name: '声音:新节点在线页面换成 0.7.18 同一提交', category: '第一段', level: 'network', taskRef: '任务书一 第 10 条',
    tasks: ['R10'], remoteOnly: '只能在新节点上验:换静态页面(先备份)、三个源的主脚本相同、内嵌代码版本与桌面 0.7.18 一致、无头打开无页面错误;见 four-stage-deploy-checklist.md「换在线页面」',
  },
  {
    id: 'S1-r3', name: '声音:新节点上的在线合成与在线导出', category: '第一段', level: 'network', taskRef: '任务书一 第 4、5 条(留到最后的新节点实测)',
    tasks: ['R4', 'R5'], remoteOnly: '只能在新节点上验:对着新节点的在线页面跑 sound-ab-probe 的在线段思路(无头打开、创建者放云端项目、在线普通档合成与导出);见 four-stage-deploy-checklist.md「换在线页面之后的实测」',
  },

  /* ============================== 第二段:在线执行用户卡与图卡 ============================== */
  {
    id: 'S2-1', name: '安全验收:越权探测卡读不到凭证与票据、带不走数据(核心项)', category: '第二段', level: 'local', taskRef: '任务书一 第 13、14 条(核心项)',
    tasks: ['R13', 'R14'], needs: ['online-build'], prereq: ['G0-4'], covers: ['online-card-security-probe.mjs'],
    requires: ['scripts/probes/online-card-security-probe.mjs'],
    cmd: probe('online-card-security-probe', ['--dist', '{dist}', '--base-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1), '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 40,
  },
  {
    id: 'S2-2', name: '功能验收:五张卡(用户画面卡、有声卡、相对导入、视频输入源图卡、音频图卡)', category: '第二段', level: 'local', taskRef: '任务书一 第 15 条',
    tasks: ['R15'], needs: ['online-build'], prereq: ['G0-4'], covers: ['online-card-exec-probe.mjs'],
    requires: ['scripts/probes/online-card-exec-probe.mjs'],
    cmd: probe('online-card-exec-probe', ['--dist', '{dist}', '--base-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1), '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 40,
    timing: 'record', timingNote: 'E8 写进新源码到舞台换成新版的用时(原门槛 ≤ 10 秒)',
  },
  {
    id: 'S2-3', name: '图卡在线执行(GPU 执行、素材取帧、图形能力不够的退回)', category: '第二段', level: 'local', taskRef: '任务书一 第 15 条(图卡)',
    tasks: ['R15'], needs: ['online-build'], prereq: ['G0-4'], covers: ['online-card-graph-probe.mjs'],
    requires: ['scripts/probes/online-card-graph-probe.mjs'],
    cmd: probe('online-card-graph-probe', ['--dist', '{dist}', '--base-port', B, '--doc-port', DOC(2), '--asset-port', DOC(3), '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'S2-4', name: '声音线程:在线执行用户卡、图卡的 audio()', category: '第二段', level: 'local', taskRef: '任务书一 第 15 条(声音)',
    tasks: ['R15'], needs: ['online-build'], prereq: ['G0-4'], covers: ['online-card-sound-probe.mjs'],
    requires: ['scripts/probes/online-card-sound-probe.mjs'],
    cmd: probe('online-card-sound-probe', ['--port', B, '--phases', 'dev,online', '--dist', '{dist}', '--online-base', '5693', '--doc-port', DOC(4), '--asset-port', DOC(5), '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 30,
    timing: 'record', timingNote: 'S6 死循环的声音代码被掐断的用时(原上界 < 8 秒;不早于 950 ms 的下界照旧是通过条件)',
  },
  {
    id: 'S2-5', name: '纯浏览器节点认领用户卡与图卡任务', category: '第二段', level: 'local', taskRef: '任务书一 第 16 条',
    tasks: ['R16'], needs: ['online-build'], prereq: ['G0-4'], covers: ['online-card-node-probe.mjs'],
    requires: ['scripts/probes/online-card-node-probe.mjs'],
    cmd: probe('online-card-node-probe', ['--dist', '{dist}', '--base-port', B, '--out', '{item}', '--strict']), pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'S2-6', name: '有声动效卡的成本身份与轻重判定(判轻、测量不出声)', category: '第二段', level: 'local', taskRef: '任务书一 第 15 条(轻重判定);用户 2026-10-06「直接自动即时补测试」',
    tasks: ['R15'], covers: ['av-card-cost-probe.mjs'], requires: ['scripts/probes/av-card-cost-probe.mjs'],
    cmd: probe('av-card-cost-probe', ['run', '--kind', 'av', '--expect', 'light', '--out', '{item}', '--port', B]), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'S2-7', name: '不含声音的项目导出与 main 的成片一致(核心项)', category: '第二段', level: 'local', taskRef: '任务书一 第一段「没过怎么办」核心项;第 17 条',
    tasks: ['R17'], needs: ['main-worktree'], covers: ['av-card-cost-probe.mjs'], requires: ['scripts/probes/av-card-cost-probe.mjs'],
    steps: [
      probe('av-card-cost-probe', ['run', '--kind', 'plain', '--out', '{item}/cand', '--port', B]),
      probe('av-card-cost-probe', ['run', '--kind', 'plain', '--out', '{item}/main', '--tree', '{main}', '--port', B]),
      probe('av-card-cost-probe', ['compare', '--a', '{item}/cand', '--b', '{item}/main']),
    ], pass: { exit: 0 }, timeoutMin: 30,
  },
  {
    id: 'S2-8', name: '隔离可行性探针(WebRTC 缺口、构造器加固回归)', category: '第二段', level: 'local', taskRef: '任务书一 第 12、14 条',
    tasks: ['R12', 'R14'], covers: ['online-card-isolation-feasibility-probe.mjs'], requires: ['scripts/probes/online-card-isolation-feasibility-probe.mjs'],
    cmd: probe('online-card-isolation-feasibility-probe', ['--base-port', B]), pass: { exit: 0 }, timeoutMin: 15,
  },
  {
    id: 'S2-9', name: '第二段新增的单测与守门(在线卡运行时、舞台策略头、nginx 模板)', category: '第二段', level: 'local', taskRef: '任务书一 第 17 条(tsc、npm test 全过)',
    tasks: ['R17'], requires: ['server/test/online-card-n.test.mjs'],
    cmd: [node, '--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test', 'server/test/online-card-n.test.mjs', 'server/test/stage-policy-nginx.test.mjs', 'src/online/cardRuntime/*.test.mjs'],
    pass: { exit: 0, metrics: { fail: 'ℹ fail (\\d+)' }, limits: { fail: { eq: 0 } } }, timeoutMin: 10,
  },
  {
    id: 'S2-m1', name: '第二段:设计与契约、语义与契约同步', category: '第二段', level: 'local', taskRef: '任务书一 第 12、18 条',
    tasks: ['R12', 'R18'], manual: '读 docs/plan/online-card-exec-contract.md 第 13、13A 节的裁定与「待用户审」清单;c10-contract.md 第 9 节、m7-contract.md 与 product/platforms.md 的「渲染节点」表按决定 C 改好;时间轴「需要本地 PC 渲染辅助」的出现条件与代码一致',
  },
  {
    id: 'S2-m2', name: '第二段:手机低内存档的表现', category: '第二段', level: 'local', taskRef: '任务书一 第 15 条末句(低内存档按现有规则、表现写清楚)',
    tasks: ['R15'], manual: '由 online-user-cards-probe 的低内存档断言与 S2-2 的「低内存档」一行覆盖;读报告里「低内存档」一节确认写清了表现',
  },
  {
    id: 'S2-m3', name: '第二段:合入、0.7.19(统一为 0.7.18)、补丁、release', category: '第二段', level: 'local', taskRef: '任务书一 第 19 条前半;「做法与验收节奏」统一版本号',
    tasks: ['R19'], manual: '合入与发版见部署清单「合入 main 之前」「版本号与补丁」',
  },
  {
    id: 'S2-r1', name: '第二段:新节点 nginx 的舞台策略头与 /media-s/ 路由、在线页面换版', category: '第二段', level: 'network', taskRef: '任务书一 第 19 条后半、第二段背景(改 nginx 与换页面要一起做)',
    tasks: ['R19'], remoteOnly: '只能在新节点上验:nginx -t 与 reload、探针对着真地址验策略头(online-card-security-probe 的前提断言 A1 思路),见 four-stage-deploy-checklist.md「先改 nginx」「换在线页面」',
  },

  /* ============================== 第三段:云节点渲染服务 ============================== */
  {
    id: 'S3-1', name: '渲染服务本机整套演练(接活、迟到成员、Agent 补渲、越权被拒、开关、杀进程、上限、负载、删项目)', category: '第三段', level: 'local', taskRef: '任务书一 第 20～23 条(本机能验的部分);「没过怎么办」第三段核心项',
    tasks: ['R20', 'R21', 'R22', 'R23'], covers: ['hosted-render-probe.mjs'], requires: ['scripts/probes/hosted-render-probe.mjs'],
    cmd: probe('hosted-render-probe', ['--base-port', B, '--doc-port', DOC(0), '--asset-port', DOC(1)]), pass: { exit: 0 }, timeoutMin: 60,
    timing: 'record', timingNote: '渲染服务连进来 / 连回来 / 断开的用时(原门槛各 ≤ 5 秒)、load 步渲染进行中与空闲时文档服务 /healthz 往返时延(原门槛 p95 < 500 ms)',
  },
  {
    id: 'S3-2', name: '项目设置里「托管方的渲染节点」开关与成员列表一行(界面)', category: '第三段', level: 'local', taskRef: '任务书一 第 21 条(决定 D 的界面);HR24 的浏览器一半',
    tasks: ['R21', 'R24'], covers: ['hosted-render-ui-probe.mjs'], requires: ['scripts/probes/hosted-render-ui-probe.mjs'],
    cmd: probe('hosted-render-ui-probe', ['--out', '{item}', '--desktop-port', B, '--doc-port', DOC(2), '--asset-port', DOC(3)]), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'S3-3', name: '第三段的单测(身份、权限、容量、隔离、进程、部署模板)', category: '第三段', level: 'local', taskRef: '任务书一 第 21 条(tsc、npm test 全过;队列、鉴权、渲染主机相关测试)',
    tasks: ['R21'], requires: ['server/test/hosted-render-service.test.mjs'],
    cmd: [node, '--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test', 'server/test/hosted-render-*.test.mjs'],
    pass: { exit: 0, metrics: { fail: 'ℹ fail (\\d+)' }, limits: { fail: { eq: 0 } } }, timeoutMin: 15,
  },
  {
    id: 'S3-m1', name: '第三段:设计与契约、语义与迁移文档', category: '第三段', level: 'local', taskRef: '任务书一 第 20、24 条',
    tasks: ['R20', 'R24'], manual: '读 docs/plan/hosted-render-contract.md(认证、并发与内存上限、环境指纹、容量上限的〔裁〕);product/hosting.md、product/platforms.md、workflow/project.md 的决定 D 逐句对;hosting-migration.md 补了渲染服务的迁移与重建;draft_cloud-node-and-agent.md「步骤 1」「步骤 2」标为已完成',
  },
  {
    id: 'S3-r1', name: '新节点:部署渲染服务(装 chrome-headless-shell、字体、ffmpeg;服务用户;keygen;--check;PM2)', category: '第三段', level: 'network', taskRef: '任务书一 第 22 条',
    tasks: ['R22'], remoteOnly: '只能在新节点上做:见 four-stage-deploy-checklist.md「部署渲染服务」;等写入停止再重启托管服务,重启前后核对各项目版本号不变并记中断时长',
  },
  {
    id: 'S3-r2', name: '新节点实测:低内存档补渲被云节点认领、产物贴上', category: '第三段', level: 'network', taskRef: '任务书一 第 23 条第 1 点',
    tasks: ['R23'], remoteOnly: '只能在新节点上验:手机仿真(c10-browser-probe --site 的低内存档思路 / lowmem-online-probe)打开含重卡的测试项目,看渲染服务认领与贴上;测试房间与凭证验完删',
  },
  {
    id: 'S3-r3', name: '新节点实测:在线普通档判重的层交给云节点渲', category: '第三段', level: 'network', taskRef: '任务书一 第 23 条第 2 点',
    tasks: ['R23'], remoteOnly: '只能在新节点上验:c10-browser-probe --site <新节点地址> --no-host(不起外部主机,看云节点接活)',
  },
  {
    id: 'S3-r4', name: '新节点实测:用户卡与图卡的任务它能渲,越权探测卡在隔离工作进程里读不到', category: '第三段', level: 'network', taskRef: '任务书一 第 23 条第 3 点(「关掉软件照常运转」的一部分,不因缺夹具而退掉)',
    tasks: ['R23'], remoteOnly: '只能在新节点上验:把越权探测卡(scripts/probes/fixtures/online-card-attacks/)放进测试项目,发清单计划让渲染服务渲,断言读不到别的项目的内容与素材、节点上的凭证与令牌、工作进程自己的本机接口、工作目录以外的文件',
  },
  {
    id: 'S3-r5', name: '新节点实测:新建项目自动接活、关开关后不接、删项目后断开;身份改项目内容被拒', category: '第三段', level: 'network', taskRef: '任务书一 第 23 条第 4、5 点',
    tasks: ['R23'], remoteOnly: '只能在新节点上验:对着真实地址重放 hosted-render-probe 的 work、switch、delete、forbidden 四步的断言(探针是本机的,需改写成对新节点;或手工按清单操作,测试房间验完删)',
  },
  {
    id: 'S3-r6', name: '新节点实测:进程被杀自动拉起、节点重启后自动起来', category: '第三段', level: 'network', taskRef: '任务书一 第 23 条第 6 点',
    tasks: ['R23'], remoteOnly: '只能在新节点上验:结束渲染服务的管理进程(pm2 会拉起)后再发计划能做完;重启节点(要用户在场授权)后 pm2 resurrect 自启',
  },
  {
    id: 'S3-r7', name: '新节点实测:满载渲染时文档服务响应时间与素材下载速度前后对比、资源上限生效', category: '第三段', level: 'network', taskRef: '任务书一 第 23 条第 7、8 点',
    tasks: ['R23'], remoteOnly: '只能在新节点上验:空闲与满载各量 /healthz 往返与一个素材下载速度,写出数字;把并发或内存上限调小观察超限表现(管理进程的 worker.exit reason oom、降并发)',
  },
  {
    id: 'S3-m2', name: '第三段:合入、版本(客户端有改动出 0.7.20 → 统一 0.7.18)、新节点跑的是哪个提交', category: '第三段', level: 'local', taskRef: '任务书一 第 25 条',
    tasks: ['R25'], manual: '见部署清单:合入 main 后 release 判过并推进;写明新节点上跑的提交,三项(渲染服务、Agent 服务、在线页面)同一提交',
  },

  /* ============================== 第四段:云端 Agent 服务 ============================== */
  {
    id: 'S4-1', name: '云端 Agent 隔离(文档服务与素材服务一侧,假 Agent 服务)', category: '第四段', level: 'local', taskRef: '任务书二 第 4 条(核心项);H 条的核验',
    tasks: ['C4'], covers: ['cloud-agent-auth-probe.mjs'], requires: ['scripts/probes/cloud-agent-auth-probe.mjs'],
    cmd: probe('cloud-agent-auth-probe', ['--doc-port', DOC(0), '--asset-port', DOC(1)]), pass: { exit: 0 }, timeoutMin: 20,
  },
  {
    id: 'S4-2', name: '云端 Agent 隔离(整条链,真的 Agent 服务进程)', category: '第四段', level: 'local', taskRef: '任务书二 第 4 条(核心项)',
    tasks: ['C3', 'C4'], covers: ['cloud-agent-isolation-probe.mjs'], requires: ['scripts/probes/cloud-agent-isolation-probe.mjs'],
    cmd: probe('cloud-agent-isolation-probe', ['--doc-port', DOC(2), '--asset-port', DOC(3), '--agent-port', '5696']), pass: { exit: 0 }, timeoutMin: 30,
    timing: 'record', timingNote: '撤销(关开关、移出名单、被踢、删项目)到进行中的对话停下的用时(原门槛各 ≤ 2 秒)',
  },
  {
    id: 'S4-3', name: '云端 Agent 一轮的生命周期(断流不停、按 seq 补发、进程被杀、额度、发起方不在线)', category: '第四段', level: 'local', taskRef: '任务书二 第 6、7 条(本机版);「用户体验验收」不依赖页面与渲染服务的部分',
    tasks: ['C6', 'C7'], covers: ['cloud-agent-run-probe.mjs'], requires: ['scripts/probes/cloud-agent-run-probe.mjs'],
    cmd: probe('cloud-agent-run-probe'), pass: { exit: 0 }, timeoutMin: 20,
    known: '端口写死:文档服务 8798、Agent 服务 5741(在别的子 Agent 用的 8770～8799、5720～5839 段里),起之前确认空着',
    timing: 'record', timingNote: 'E1 发起方不在线时读选区的工具回话的用时(原门槛 < 500 ms)',
  },
  {
    id: 'S4-4', name: '云端 AI 栏(在线宽屏、桌面云端项目、手机占位)', category: '第四段', level: 'local', taskRef: '任务书二 第 5、6 条(界面部分)',
    tasks: ['C5', 'C6'], needs: ['online-build'], prereq: ['G0-4'], covers: ['cloud-agent-ui-probe.mjs'], requires: ['scripts/probes/cloud-agent-ui-probe.mjs'],
    cmd: probe('cloud-agent-ui-probe', ['--base-port', B, '--doc-port', DOC(4), '--asset-port', DOC(5), '--agent-port', DOC(6), '--phases', 'online,desktop', '--dist', '{dist}', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 40,
    timing: 'record', timingNote: '点「停止」到停下(原门槛 < 5 秒)、一轮结束到云端 Agent 标记消失(原门槛 < 20 / 25 秒)的用时',
  },
  {
    id: 'S4-5', name: '关掉软件照常运转(无界面版,真的结束发起方进程)', category: '第四段', level: 'local', taskRef: '任务书二「用户体验验收」六条的本机版(回归项)',
    tasks: ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'], covers: ['cloud-agent-ux-probe.mjs'], requires: ['scripts/probes/cloud-agent-ux-probe.mjs'],
    cmd: probe('cloud-agent-ux-probe', ['--doc-port', DOC(4), '--asset-port', DOC(5), '--agent-port', '5696', '--render-port', '5860']), pass: { exit: 0 }, timeoutMin: 60,
    known: '含约 100 秒的任务与多步等待;--steps 缺省全跑(leave,later,reopen,stop,spaced,errors,load)',
    timing: 'record', timingNote: 'U9 停掉到收尾的用时(原门槛 ≤ 2 秒)、U16 满载时文档服务往返时延与素材下载速度(原门槛 p95 < 500 / 1000 ms、下载不低于空闲的两成)、各步用时',
  },
  {
    id: 'S4-6', name: '关掉软件照常运转(带界面版:桌面发起、在线发起、另一位成员看画面)', category: '第四段', level: 'local', taskRef: '任务书二「用户体验验收」六条的本机版(回归项)',
    tasks: ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'C6'], needs: ['online-build'], prereq: ['G0-4'], covers: ['cloud-agent-ux-ui-probe.mjs'], requires: ['scripts/probes/cloud-agent-ux-ui-probe.mjs'],
    cmd: probe('cloud-agent-ux-ui-probe', ['--base-port', B, '--doc-port', DOC(6), '--asset-port', DOC(7), '--agent-port', '5698', '--render-port', '5870', '--dist', '{dist}', '--out', '{item}']), pass: { exit: 0 }, timeoutMin: 90,
    timing: 'record', timingNote: '点「停止」到停下的用时(原门槛 < 5 秒)、各步用时',
  },
  {
    id: 'S4-7', name: '第四段的单测(服务、鉴权、运行、补渲、接线守门)', category: '第四段', level: 'local', taskRef: '任务书二 第 3、11 条',
    tasks: ['C3', 'C11'], requires: ['server/test/cloud-agent-service.test.mjs'],
    cmd: [node, '--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test', 'server/test/cloud-agent-*.test.mjs'],
    pass: { exit: 0, metrics: { fail: 'ℹ fail (\\d+)' }, limits: { fail: { eq: 0 } } }, timeoutMin: 15,
  },
  {
    id: 'S4-m1', name: '第四段:设计与契约、载入缝', category: '第四段', level: 'local', taskRef: '任务书二 第 1、2 条',
    tasks: ['C1', 'C2'], manual: '读 docs/plan/cloud-agent-contract.md;第 2 条的载入缝用 grep 核:独立入口(server/agent-service/)对前端代码的直接引用只经 server/agent/ssr-host.mjs 一处——`grep -rn "from .*\\.\\./\\.\\./src" server/agent-service` 与 import 路径逐个看;不动桌面壳(desktop/ 下 diff 为空)',
  },
  {
    id: 'S4-m2', name: '第四段:语义 E～J 与契约同步、草稿「步骤 3」', category: '第四段', level: 'local', taskRef: '任务书二 第 10 条',
    tasks: ['C10'], manual: 'product/agent.md、architecture.md、platforms.md、hosting.md 与决定 E～J 逐句对;c10-contract.md、c10a-contract.md、auth-contract.md、render-queue-contract.md 同步;draft_cloud-node-and-agent.md「步骤 3」做完的标出处,没做的(看画面、页面状态工具、未开放的工具、手机界面、按项目发上限的界面)留在那里写清差什么',
  },
  {
    id: 'S4-m3', name: '第四段:模型 Key 的加密分发(机器识别码 → make-api-share.bat 密文 → 节点导入)', category: '第四段', level: 'local', taskRef: '任务书二 第 8 条、F 条(2026-10-07 改定)',
    tasks: ['C8'], manual: '部署清单「Agent 服务」一节的 Key 流程:节点上取机器识别码(server/runners/machine-id.mjs 的 machineCode)→ 用户在自己的电脑上用 make-api-share.bat 加密成只有那台节点解得开的密文 → 会话把密文送到节点导入(导入命令待第四段补)→ 只核对末四位与能否调通,不打印 Key;会话全程只接触密文;录入前 S4-1～S4-6 用模拟模型提供方先跑通',
  },
  {
    id: 'S4-m5', name: '云端 Agent 的工具与本机一致(J):逐工具核对,节点条件做不了的逐项记未达成', category: '第四段', level: 'local', taskRef: '任务书二 J 条(2026-10-07 更正);部署清单「Agent 服务的运行条件」',
    tasks: ['J1'], manual: '对照桌面版 Agent 的工具清单(server/tools/ 与 server/agent/ 注册的全部工具)逐个在云端调用一遍:建卡改卡、导入素材、网页采集、配音、感知类(语音转文字、镜头切换、主体检测、运动追踪)、看画面(即时渲染)都要能用;只有操作发起人自己界面的工具(选区、播放头、播放暂停、网页接管)可缺省并回「发起方不在线」。节点缺 Python 扩展包、模型、Chrome、字体或出网受限而做不了的,按部署清单该节逐项记原因与差什么;命令细节待第四段返工完成后补',
  },
  {
    id: 'S4-m6', name: '诊断报告(K):云端对话与本机对话都能出,可下载、可一键提交,不含凭证票据 Key', category: '第四段', level: 'local', taskRef: '任务书二 K 条(2026-10-07 用户定)',
    tasks: ['K1'], manual: '界面:云端对话与本机对话各出一份诊断报告,「下载」存成文件、「报告」提交到收集端(tools/report-worker/;取回用 report-inbox.bat);在线页面里报告在页面内生成,下载与提交都不经编辑器进程的 /api/*(在线构建的 __pcApiBlocked 为空);内容是对话过程、出错原因、客户端与版本信息。不含凭证的断言用单测(命令待第四段补);本机 Agent 的对话原来若只能出整机诊断,这次补上按对话出',
  },
  {
    id: 'S4-m7', name: '隔离新增(第 4 条):工具在节点上读写按项目隔离', category: '第四段', level: 'local', taskRef: '任务书二 J 条配套、第 4 条新增第一条',
    tasks: ['C4a'], manual: '探针断言(第四段补,命令待补):一个对话的工具读写不到别的项目的文件,也读写不到节点上的系统文件、凭证与别的服务的数据目录(素材经素材服务、项目经文档服务);在 cloud-agent-isolation-probe 里加断言或另立探针',
  },
  {
    id: 'S4-m8', name: '隔离新增(第 4 条):能发网络请求的工具不能访问节点的回环地址、内网地址与同机别的服务的接口', category: '第四段', level: 'local', taskRef: '任务书二 J 条配套、第 4 条新增第二条',
    tasks: ['C4b'], manual: '探针断言(第四段补,命令待补):网页采集、下载等工具对 127.0.0.1、::1、10./172.16–31./192.168. 段、169.254.169.254 与同机的文档服务、素材服务、渲染服务诊断口、Agent 服务自己的端口发请求一律被拒,含 DNS 重绑定与重定向到内网地址;在节点上用部署清单「出网限制核对」一节再实测一次',
  },
  {
    id: 'S4-m9', name: '隔离新增(第 4 条):配音等花钱的调用记进用量', category: '第四段', level: 'local', taskRef: '任务书二 J 条配套、第 4 条新增第三条',
    tasks: ['C4c'], manual: '探针断言(第四段补,命令待补):云端 Agent 调配音(voice_generate)用托管方的配置,调用记进 G 的用量记录(项目、成员、服务商、用量);用 admin.mjs usage 查得到;额度检查对它同样生效',
  },
  {
    id: 'S4-r1', name: '新节点:部署 Agent 服务并实测(隔离、端到端、额度接口、资源上限)', category: '第四段', level: 'network', taskRef: '任务书二 第 6、7、9、12 条',
    tasks: ['C6', 'C7', 'C9', 'C12'], remoteOnly: '只能在新节点上验:见 four-stage-deploy-checklist.md「部署 Agent 服务」;模拟模型先验、Key 按加密分发办法导入后再用真实模型验(见下面三行「真实模型」);满载时同机文档服务响应与素材下载速度前后对比写数字',
  },
  {
    id: 'S4-r2', name: '新节点:「关掉软件照常运转」用真实部署走通(整件事做成的标准)', category: '第四段', level: 'network', taskRef: '任务书二「用户体验验收」六条(新节点用真实部署)',
    tasks: ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'], remoteOnly: '只能在新节点上验:创建者在桌面版(另用在线浏览器再验一遍)对放云端的项目发一个跑一段时间、触发重卡重渲的任务,确认被云端接下后完全退出软件(桌面连托盘一起退出、浏览器关标签页、电脑不再连着),再逐条核六条;样本路径与证据贴进总报告',
  },
  {
    id: 'S4-r4', name: '真实模型:第 6 条端到端(改文案、挪片段、调卡片参数;两成员互不串;撤销)', category: '第四段', level: 'network', taskRef: '任务书二 第 8 条(2026-10-07 改定)', realModel: true,
    tasks: ['C8a'], remoteOnly: '真实模型,两遍:① 本机演练现在就用这台 PC 已配好的 API 直连跑(第四段的子 Agent 做,不读出配置的值);② 新节点上部署 Agent 服务并按加密分发办法导入 Key 之后再跑一遍(用 cloud-agent-ui-probe 的思路对着真实地址,模型换成真实提供方,测试房间验完删)',
  },
  {
    id: 'S4-r5', name: '真实模型:「用户体验验收」六条(发出任务后关掉软件照常运转)', category: '第四段', level: 'network', taskRef: '任务书二 第 8 条(2026-10-07 改定)', realModel: true,
    tasks: ['C8b'], remoteOnly: '真实模型,两遍:① 本机演练用这台 PC 的 API 直连跑界面版体验探针(cloud-agent-ux-ui-probe 的模型换成真实提供方,第四段子 Agent 做);② 新节点上部署之后走通真实部署(同 S4-r2),模型用真实 Key',
  },
  {
    id: 'S4-r6', name: '真实模型:示例句「为我快速创建一个视频告诉我软件都可以做什么。」走一遍', category: '第四段', level: 'network', taskRef: '任务书二 第 8 条(2026-10-07 改定)', realModel: true,
    tasks: ['C8c'], remoteOnly: '真实模型,两遍:① 本机演练:云端 Agent 对放云端的测试项目发这一句,看它能不能自己查出软件的能力并建出一段视频(含建卡、素材、配音等本机一致的工具),结果与对话记录留样;② 新节点上部署之后再发一遍;记录对话过程、工具调用清单、成片或项目的样子与用量',
  },
  {
    id: 'S4-r7', name: '新节点:在线构建里诊断报告收集端的地址与提交令牌已配置(只核变量名与是否内联,不打印值)', category: '第四段', level: 'network', taskRef: '任务书二 K 条;部署清单「在线构建的报告收集端配置」',
    tasks: ['K1'], remoteOnly: '换页面之前在构建机核对:根目录 .env.local 里 VITE_DIAG_SUBMIT_URL、VITE_DIAG_SUBMIT_TOKEN 都有值(只看有没有);构建后在 dist-online 的脚本里查收集端域名有没有被内联(不打印令牌);换页面之后在新节点的在线页面里点一次「报告」,收集端(report-inbox.bat)收到一份、再删掉',
  },
  {
    id: 'S4-m4', name: '第四段:合入、补丁、release、deploy 模板与迁移文档、docs/local.md', category: '第四段', level: 'local', taskRef: '任务书二 第 12、13 条',
    tasks: ['C12', 'C13'], manual: '见部署清单与总报告模板:server/hosted/deploy/ 的模板与 hosting-migration.md 补上 Agent 服务;docs/local.md 记节点上多出的进程与目录(清单见部署清单末节)',
  },
];

/** 两份任务书里全部编号验收,单测核每一条都至少被清单里的一项覆盖 */
export const TASK_ACCEPTANCE = {
  R: Array.from({ length: 25 }, (_, i) => `R${i + 1}`),
  C: Array.from({ length: 13 }, (_, i) => `C${i + 1}`),
  U: Array.from({ length: 6 }, (_, i) => `U${i + 1}`),
  // 2026-10-07 任务书更新:J 工具与本机一致、K 诊断报告、第 4 条新增的三条隔离、第 8 条真实模型下的三样
  N: ['J1', 'K1', 'C4a', 'C4b', 'C4c', 'C8a', 'C8b', 'C8c'],
};
