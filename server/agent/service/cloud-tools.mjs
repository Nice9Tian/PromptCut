/**
 * 云端 Agent 的工具表(任务书 `docs/plan/cloud-agent-task.md` J〔2026-10-07 更正〕;契约 `docs/plan/cloud-agent-contract.md` 第 9 节)。
 *
 * 云端 Agent 的工具与本机 Agent 一致。这里把工具表里的**每一个**工具归到五种跑法之一;没有归类的工具(以后新加的)按
 * 「还没接上」答,并由单测 CA-TOOL-01 拦住——新加工具必须在这里表态,不会悄悄变成「云端没有」。
 *
 *   route      在服务端的项目副本上同步执行(`agent-exec.mjs` 的路由表那条路),改动带期望版本提交给文档服务;
 *   hosted     在服务端另有实现(`hosted-tools.mjs`):文件只进这个对话的工作区、出网只经出网闸、素材经素材服务、
 *              卡片源码经文档服务的内容库、花钱的调用记用量;
 *   server     就地执行,不碰项目(`wait`、`report_progress`、多 Agent 的公告板);
 *   initiator  要操作发起人自己的界面(选区、播放头、播放与暂停、网页接管、扫码登录、开页签)。**这是唯一可以缺省的一类**:
 *              发起方不在线时立刻回「发起方不在线」,Agent 据此继续,不卡住;在线时能答的照答(选区、播放头按发消息时的快照);
 *   看画面的四个(`see_frames`、`get_gif`、`bake_card`、`inspect_card_dom`,`look: true`)也是 route:读项目副本,再向同机的渲染服务要一帧
 *              (`server/agent-service/look-client.mjs`;契约第 9.8 节)。这台节点没有配看画面的口子时它们不交给模型,调用回明确的原因。
 *   pending    这一版在云节点上还没接上。逐项写明差什么(`why`),记未达成;不交给模型,调用时回明确的原因。
 *              这不是「不开放」:接上之后把它挪到上面某一类即可。
 *
 * 两道:`pending` 的工具不交给模型(`CLOUD_OPEN_TOOLS` 传给驱动当过滤);工具调用的总入口(`instance.mjs`)再判一次。
 */

const R = 'route';
const H = 'hosted';
const S = 'server';
const I = 'initiator';
const P = 'pending';

const NEED_PY = (what) => `${what}要节点上的 Python 运行环境与模型权重,并把页面里的作业表搬到服务端;这一版还没接上`;
const NEED_COLLECT = '网页采集要节点上的下载器(Python 与 yt-dlp、ffmpeg),并让它只经出网闸的代理出网;这一版还没接上';
const NEED_WEB = '网页接管要节点上的浏览器,并让它只经出网闸的代理出网、按对话隔离用户数据目录;这一版还没接上';
const NEED_SYNTH = '卡片的声音代码要在不持凭证的隔离进程里执行,云端这一版还没接上';

/** 工具名 → { mode, why? }。按 `server/tools/` 的分组列,128 个 */
export const CLOUD_TOOL_PLAN = Object.freeze({
  // project(7)
  get_project: { mode: R }, list_media: { mode: R }, set_project_meta: { mode: R }, set_theme: { mode: R }, list_media_effects: { mode: R },
  get_selection: { mode: I, what: '页面的选区' },
  import_media: { mode: H },
  // clips(8)
  add_clip: { mode: R }, update_clip: { mode: R }, remove_clip: { mode: R }, duplicate_clip: { mode: R }, split_clip: { mode: R },
  get_clip: { mode: R }, set_clip: { mode: R }, set_emphasis: { mode: R },
  // layout(6)
  set_position: { mode: R }, set_rect: { mode: R }, align: { mode: R }, nudge: { mode: R }, get_layout: { mode: R }, set_camera3d: { mode: R },
  // tracks(5)
  add_track: { mode: R }, list_tracks: { mode: R }, remove_track: { mode: R }, update_track: { mode: R }, move_track: { mode: R },
  // parts(6)
  list_parts: { mode: R }, add_composite: { mode: R }, add_part: { mode: R }, set_part: { mode: R }, remove_part: { mode: R }, move_part: { mode: R },
  // effects(10)
  list_filters: { mode: R }, create_filter: { mode: R }, update_filter: { mode: R }, remove_filter: { mode: R }, apply_filter: { mode: R },
  list_pixel_maps: { mode: R }, create_pixel_map: { mode: R }, update_pixel_map: { mode: R }, remove_pixel_map: { mode: R }, apply_pixel_map: { mode: R },
  // cuts(8):切剪辑的三个要播放头,发起方在线用发消息时的,不在线按 0 记并注明
  list_transitions: { mode: R }, add_transition: { mode: R }, remove_transition: { mode: R }, list_cuts: { mode: R }, rename_cut: { mode: R },
  switch_cut: { mode: R }, add_cut: { mode: R }, remove_cut: { mode: R },
  // audio(19)
  set_clip_volume: { mode: R }, set_clip_muted: { mode: R }, separate_audio: { mode: R }, create_audio: { mode: R },
  list_audio_fx: { mode: R }, create_audio_fx: { mode: R }, update_audio_fx: { mode: R }, remove_audio_fx: { mode: R }, apply_audio_fx: { mode: R },
  sound_presets: { mode: R },
  voice_list: { mode: H }, voice_generate: { mode: H },
  // 提示音与键盘声:确定性的纯计算,在服务进程里按块合成(`hosted-sound.mjs`;契约第 9.4a 节)
  sound_generate: { mode: H }, sound_status: { mode: H }, sound_cancel: { mode: H },
  render_card_audio: { mode: P, why: NEED_SYNTH },
  cancel_card_audio: { mode: P, why: NEED_SYNTH },
  // 测响度:素材凭成员的只读票据取到对话的工作目录,用工作区的受限子进程起 ffmpeg 量(`hosted-audio.mjs`;契约第 9.4b 节)
  measure_audio: { mode: H },
  measure_audio_js: { mode: P, why: '模型写的测量脚本要在断网的无头浏览器里跑,Agent 服务进程不起浏览器;要渲染服务那一侧开一个跑脚本的口子,这一版还没接上' },
  // ai(19)
  detach_clip_motion: { mode: R }, get_transcript: { mode: R }, fill_captions: { mode: R }, list_captions: { mode: R }, edit_caption: { mode: R },
  list_shots: { mode: R }, list_subjects: { mode: R },
  stt_status: { mode: P, why: NEED_PY('语音识别') }, stt_install: { mode: P, why: NEED_PY('语音识别') }, transcribe_media: { mode: P, why: NEED_PY('语音识别') },
  detect_shots: { mode: P, why: NEED_PY('镜头识别') },
  track_points: { mode: P, why: NEED_PY('运动追踪') }, get_track: { mode: P, why: NEED_PY('运动追踪') },
  track_status: { mode: P, why: NEED_PY('运动追踪') }, track_install: { mode: P, why: NEED_PY('运动追踪') },
  detect_subjects: { mode: P, why: NEED_PY('主体识别') }, subject_status: { mode: P, why: NEED_PY('主体识别') }, subject_install: { mode: P, why: NEED_PY('主体识别') },
  attach_clip_motion: { mode: P, why: '要一份追踪结果,而运动追踪在云节点上还没接上' },
  // cards(8)
  list_cards: { mode: R }, apply_card: { mode: R },
  card_authoring_guide: { mode: H }, get_card_source: { mode: H }, create_card: { mode: H }, edit_card: { mode: H },
  bake_card: { mode: R, look: true }, inspect_card_dom: { mode: R, look: true },
  // vision(2):向同机的渲染服务要一帧(契约第 9.8 节)
  see_frames: { mode: R, look: true }, get_gif: { mode: R, look: true },
  // collect(9)
  collect_status: { mode: P, why: NEED_COLLECT }, collect_install: { mode: P, why: NEED_COLLECT }, collect_search: { mode: P, why: NEED_COLLECT },
  collect_probe: { mode: P, why: NEED_COLLECT }, collect_download: { mode: P, why: NEED_COLLECT }, collect_job: { mode: P, why: NEED_COLLECT },
  collect_logout: { mode: P, why: NEED_COLLECT },
  collect_login: { mode: I, what: '登录窗口(要用户自己扫码或输口令)' }, collect_login_check: { mode: I, what: '登录窗口' },
  // browser(8)
  web_open: { mode: P, why: NEED_WEB }, web_view: { mode: P, why: NEED_WEB }, web_click: { mode: P, why: NEED_WEB }, web_type: { mode: P, why: NEED_WEB },
  web_scroll: { mode: P, why: NEED_WEB }, web_read: { mode: P, why: NEED_WEB }, web_close: { mode: P, why: NEED_WEB },
  web_handoff: { mode: I, what: '网页接管窗口' },
  // agent(5):公告板四个在服务进程里答;拉起子 Agent 要页面开页签
  declare_scope: { mode: S }, list_agents: { mode: S }, send_message: { mode: S }, check_messages: { mode: S },
  spawn_agent: { mode: I, what: 'AI 栏的页签' },
  // core(8)
  wait: { mode: S }, report_progress: { mode: S },
  seek: { mode: I, what: '播放头' }, play: { mode: I, what: '播放' }, pause: { mode: I, what: '播放' },
  background_job_status: { mode: P, why: '它查的后台作业(语音识别、扩展包安装)在云节点上还没接上' },
  auto_workflow: { mode: P, why: `一键流程的第一步是语音识别;${NEED_PY('语音识别')}` },
  auto_workflow_status: { mode: P, why: '一键流程在云节点上还没接上' },
});

const namesOf = (...modes) => Object.entries(CLOUD_TOOL_PLAN).filter(([, p]) => modes.includes(p.mode)).map(([n]) => n);

/** 交给模型的工具:除了「还没接上」的,全部 */
export const CLOUD_OPEN_TOOLS = Object.freeze(new Set(namesOf(R, H, S, I)));

/** 要向渲染服务要一帧画面的(契约第 9.8 节)。`get_layout` 不在里面:它没有画面也答得了规定的框,只是量不到实体框 */
export const CLOUD_LOOK_TOOLS = Object.freeze(new Set(Object.entries(CLOUD_TOOL_PLAN).filter(([, p]) => p.look === true).map(([n]) => n)));

/** 这台节点没有配看画面的口子时交给模型的工具(少掉看画面的四个) */
export const CLOUD_OPEN_TOOLS_NO_LOOK = Object.freeze(new Set([...CLOUD_OPEN_TOOLS].filter((n) => !CLOUD_LOOK_TOOLS.has(n))));

/** 这台节点没有配看画面的口子:看画面的工具的回答 */
export function lookUnavailable(tool) {
  return {
    ok: false, cloudUnavailable: true,
    error: `云端 Agent 在这台节点上看不了画面(${tool}):节点没有开渲染服务的看画面。请按项目内容继续,并在汇报里说明没有看过画面。`,
  };
}

/**
 * 看画面的工具在云端的结果:画面只交给模型。聊天栏的可视化记录与动图存在云节点渲染服务的工作进程里,在线页面取不到,
 * 所以不带 `visualId` 与动图地址(页面据 `visualId` 去取记录,带了只会取不到);`get_gif` 的说明照实改。
 */
export function cloudLookResult(tool, out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  const { visualId: _v, gif: _g, ...rest } = out;
  if (tool === 'get_gif' && rest.ok !== false) rest.note = '拼图 4×2,第 k 格对应 times 的第 k 个时刻(按行从左到右)。云端只把这张拼图交给你;用户在聊天栏里看不到动图。';
  return rest;
}

/** `see_frames` 的素材镜头拼图(`source: "media"`)要镜头识别,云端还没接上;只看得了时间轴的画面 */
export function lookSourceUnavailable() {
  return {
    ok: false, cloudUnavailable: true,
    error: '云端 Agent 的 see_frames 只能看时间轴上的画面(不传 source,或 source: "timeline");素材的镜头拼图要节点上的镜头识别,这一版还没接上。',
  };
}

/** 在服务端另有实现的(工具表里它们是 `side: "page"` 或走编辑器接口的,托管档改由 `hosted-tools.mjs` 执行) */
export const CLOUD_HOSTED_TOOLS = Object.freeze(new Set(namesOf(H)));

/** 工具表里是 `side: "page"`、云端改在服务端项目副本上执行的(实现本身只读项目与注册表) */
export const CLOUD_AGENT_SIDE = Object.freeze(new Set(['list_cards', 'sound_presets', 'list_shots', 'list_subjects']));

/** 要操作发起人界面的 */
export const CLOUD_INITIATOR_TOOLS = Object.freeze(new Set(namesOf(I)));

/** 读页面状态、发起方在线时按发消息时的快照答的 */
export const CLOUD_PAGE_STATE_READS = Object.freeze(new Set(['get_selection']));

/** 要页面播放头的切剪辑工具:发起方在线用发消息时的播放头,不在线照常执行、播放头按 0 记并在结果里注明 */
export const CLOUD_PLAYHEAD_TOOLS = Object.freeze(new Set(['switch_cut', 'add_cut', 'remove_cut']));

/** 「发起方不在线」的回答(模型据此继续,不等) */
export function initiatorOffline(tool) {
  // 读选区的那一句是用户审过的原话(契约第 22.2 节),不改
  if (tool === 'get_selection') return { ok: false, initiatorOffline: true, error: '发起方不在线,读不到页面的选区。请按项目内容继续,不要等待。' };
  const what = CLOUD_TOOL_PLAN[tool]?.what ?? '页面';
  return { ok: false, initiatorOffline: true, error: `发起方不在线,${tool} 要用到他的${what}。请按项目内容继续,不要等待。` };
}

/** 发起方在线、但这个工具要反过来操作他的页面:云端到页面的反向通道还没有 */
export function initiatorUnreachable(tool) {
  const what = CLOUD_TOOL_PLAN[tool]?.what ?? '页面';
  return {
    ok: false, initiatorOnly: true,
    error: `${tool} 要操作发起人的${what};云端的对话现在只读得到他发消息时的选区与播放头,还不能反过来操作他的页面。请按项目内容继续,需要的话告诉用户自己在界面上操作。`,
  };
}

/**
 * 判一次调用。能跑回 `{ ok: true, mode }`;「还没接上」回 `{ ok: false, cloudUnavailable: true, error }`。
 * @param {string} tool
 */
export function checkCloudTool(tool) {
  const plan = Object.hasOwn(CLOUD_TOOL_PLAN, tool) ? CLOUD_TOOL_PLAN[tool] : null;
  if (plan && plan.mode !== P) return { ok: true, mode: plan.mode };
  const why = plan?.why ?? '这个工具还没有在云端的工具表里归类';
  return {
    ok: false,
    cloudUnavailable: true,
    error: `云端 Agent 这一版还用不了 ${tool}:${why}。请换一种做法继续;确实需要它就告诉用户在电脑上的 PromptCut 里做这一步。`,
  };
}

/** 「还没接上」的工具按原因归并(系统提示词与契约的表用) */
export function pendingByReason() {
  const out = new Map();
  for (const [name, p] of Object.entries(CLOUD_TOOL_PLAN)) {
    if (p.mode !== P) continue;
    const list = out.get(p.why) ?? [];
    list.push(name);
    out.set(p.why, list);
  }
  return out;
}

const LOOK_NOTE_ON = '- **看画面照常用,但比本机慢。** `see_frames`、`get_gif`、`bake_card`、`inspect_card_dom` 的画面由同一台云节点上的渲染服务出;`get_layout` 的实体框也是。'
  + '项目里有自定义卡片(用 `create_card` / `edit_card` 建过或改过卡)时,画面由一个按项目单开的隔离进程出,第一次要等十来秒,别的项目正在渲时要排队。'
  + '工具回「这次没看成」时不要反复重试:按 `get_layout` 的规定框和卡片参数继续,做完在汇报里说明哪一步没有看过画面。`see_frames` 只能看时间轴的画面,素材的镜头拼图(`source: "media"`)云端还没有。';
const LOOK_NOTE_OFF = '- **这台云节点上看不了画面。** `see_frames`、`get_gif`、`bake_card`、`inspect_card_dom` 没有交给你。本提示词里凡是要求「先看一眼画面」「放完再看」的步骤一律跳过,工具结果里的 `look` 提示也不用管;排版按 `get_layout` 给的规定框和卡片参数判断,做完在汇报里说明「没有看过画面」。别的成员看到的是云端渲染服务渲好的画面。';

/**
 * 拼进系统提示词的一段:只写与本机真实的差别(契约第 9.7 节)。
 * @param {{ look?: boolean }} [o] `look`:这台节点配没配看画面的口子
 */
export const cloudSystemNote = ({ look = false } = {}) => CLOUD_SYSTEM_NOTE_LINES.map((line) => (line === LOOK_LINE ? (look ? LOOK_NOTE_ON : LOOK_NOTE_OFF) : line)).join('\n');

const LOOK_LINE = Symbol('look');
const CLOUD_SYSTEM_NOTE_LINES = [
  '## 你运行在云端',
  '',
  '你是托管方的云端 Agent,运行在云节点上。你的改动经文档服务落到项目里,所有成员都看得到;用户关掉软件后你照常把这一轮做完。',
  '工具与本机一致,下面是仅有的差别:',
  '',
  '- **用户可能已经离开。** 要用到他界面的工具(选区、播放头、播放与暂停、网页接管、扫码登录、开子 Agent 页签)在他不在线时会回「发起方不在线」:不要等,按项目内容继续,在进度汇报里说明哪一步没用上页面状态。',
  LOOK_LINE,
  '- **这一版在云端还没有:** 语音识别与一键流程、镜头与主体识别、运动追踪、卡片声音生成、自定义测量(measure_audio_js)、网页采集与网页操作。用户要这些时说明「云端这一版还做不了这一步」,能换做法就换(例如字幕直接按用户给的文字写),不要停下整件事。',
  '- **素材:** 附件在这个对话的工作目录里,地址形如 `work:attachments/<文件名>`,用 `import_media` 传这个地址装进素材库;网上的文件直接给 `import_media` 传 http(s) 地址。素材库是空的也可以只用卡片做片子,不必为了「有素材」去找素材。',
  '- **卡片:** 建卡改卡照常用(`card_authoring_guide`、`get_card_source`、`create_card`、`edit_card`、`apply_card`)。新卡存进这个项目的卡片库,所有成员都会收到;写卡时 `id`、`name`、`defaults`、`controls` 要写成字面量。卡片里**不能直接引用外链**的图片、字体、脚本(渲染节点与在线舞台都不出网,取不到):要用的图片先 `import_media` 装进素材库,再用它的 cardUrl。建新卡仍是最后手段:`list_cards` 里有合适的就用现成的调参数。',
  '- **配音:** `voice_generate` 用的是托管方的配音服务,会产生费用,按用户的意思用,不要为了试听反复生成。',
];

/** 没有配看画面的口子时的那一段(原来的常量名留着:单测与旧调用方用) */
export const CLOUD_SYSTEM_NOTE = cloudSystemNote({ look: false });
