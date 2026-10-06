/**
 * 云端 Agent 第一版开放的工具(契约 `docs/plan/cloud-agent-contract.md` 第 9.1、9.2、9.4 节)。
 *
 * 一张**开放清单**:不在清单里的一律不开放,新加的工具默认关着。两道:不开放的工具不交给模型(`CLOUD_OPEN_TOOLS`
 * 传给驱动当过滤);工具调用的总入口(`instance.mjs` 的 `callToolInternal`)再判一次,不在清单里的回
 * `{ ok: false, cloudUnsupported: true, error }`,什么都不执行。
 *
 * 进清单的条件(`server/test/cloud-agent-tools.test.mjs` 对着工具表与路由表核对):`side` 是 `agent` 或 `server`
 * (或下面点名改在服务端执行的);走路由表的必须是同步实现(`awaited: false`)——它们在进程级的锁里执行,
 * 等外部的实现会让全节点的工具排队;不打编辑器的 `/api/*`,不碰页面里的作业表。
 */

/** 开放清单,按 `server/tools/` 的分组列 */
const OPEN = {
  project: ['get_project', 'list_media', 'set_project_meta', 'set_theme', 'list_media_effects', 'get_selection'],
  clips: ['add_clip', 'update_clip', 'remove_clip', 'duplicate_clip', 'split_clip', 'get_clip', 'set_clip', 'set_emphasis'],
  layout: ['set_position', 'set_rect', 'align', 'nudge', 'get_layout', 'set_camera3d'],
  tracks: ['add_track', 'list_tracks', 'remove_track', 'update_track', 'move_track'],
  parts: ['list_parts', 'add_composite', 'add_part', 'set_part', 'remove_part', 'move_part'],
  effects: [
    'list_filters', 'create_filter', 'update_filter', 'remove_filter', 'apply_filter',
    'list_pixel_maps', 'create_pixel_map', 'update_pixel_map', 'remove_pixel_map', 'apply_pixel_map',
  ],
  cuts: ['list_transitions', 'add_transition', 'remove_transition', 'list_cuts', 'switch_cut', 'add_cut', 'rename_cut', 'remove_cut'],
  audio: [
    'set_clip_volume', 'set_clip_muted', 'separate_audio', 'create_audio',
    'list_audio_fx', 'create_audio_fx', 'update_audio_fx', 'remove_audio_fx', 'apply_audio_fx',
  ],
  ai: ['detach_clip_motion', 'get_transcript', 'fill_captions', 'list_captions', 'edit_caption'],
  cards: ['list_cards'],
  core: ['wait', 'report_progress'],
};

export const CLOUD_OPEN_TOOLS = Object.freeze(new Set(Object.values(OPEN).flat()));

/**
 * 工具表里是 `side: "page"`、云端改在服务端项目副本上执行的:`list_cards` 由服务端的卡片注册表答(只有内置卡)。
 * `get_selection` 不走这里:它读的是页面状态,由总入口按发消息时的快照答(契约第 9.4 节)。
 */
export const CLOUD_AGENT_SIDE = Object.freeze(new Set(['list_cards']));

/** 读页面状态、由总入口直接答的工具 */
export const CLOUD_PAGE_STATE_READS = Object.freeze(new Set(['get_selection']));

/** 不开放的理由,按分组;分组里个别工具另有理由的写在 `TOOL_REASON` */
const GROUP_REASON = {
  project: '要读写节点本地文件',
  audio: '配音、声音生成与测量要节点本地的解码与专用环境',
  ai: '语音识别、镜头与主体识别、运动追踪在云端没有运行环境',
  cards: '新建或修改卡片代码、看画面在云端第一版不开放',
  vision: '云端第一版没有渲染能力,看不了画面',
  collect: '网页采集在云端不开放',
  browser: '网页接管在云端不开放',
  agent: '多 Agent 协作要页面配合,云端第一版一个对话一个 Agent',
  core: '依赖后台作业或页面的播放控制',
};
const TOOL_REASON = {
  attach_clip_motion: '要页面内存里的追踪结果,而追踪在云端不开放',
  seek: '播放控制是操作页面,云端的对话不依赖任何页面',
  play: '播放控制是操作页面,云端的对话不依赖任何页面',
  pause: '播放控制是操作页面,云端的对话不依赖任何页面',
};

/**
 * 判一次调用。开放回 `{ ok: true }`;不开放回 `{ ok: false, cloudUnsupported: true, error }`。
 * @param {string} tool
 * @param {Record<string, string>} [toolGroups] 工具名 → 分组(`server/mcp-tools.mjs` 的 `toolGroups`)
 */
export function checkCloudTool(tool, toolGroups = {}) {
  if (CLOUD_OPEN_TOOLS.has(tool)) return { ok: true };
  const reason = TOOL_REASON[tool] ?? GROUP_REASON[toolGroups[tool]] ?? '云端第一版没有开放这个工具';
  return {
    ok: false,
    cloudUnsupported: true,
    error: `云端暂不支持 ${tool}:${reason}。请告诉用户在电脑上的 PromptCut 里使用,不要找替代办法。`,
  };
}

/** 拼进系统提示词的一段:云端的边界(契约第 9.1、9.4 节) */
export const CLOUD_SYSTEM_NOTE = [
  '## 你运行在云端',
  '',
  '你是托管方的云端 Agent,运行在云节点上,没有编辑界面可用;你的改动经文档服务落到项目里,所有成员都看得到。',
  '云端第一版不支持:导入与采集素材、网页操作、语音识别、配音与音效生成、镜头与主体识别、运动追踪、看画面、新建或修改卡片代码、自定义测量、多 Agent 协作、播放控制。',
  '用户要这些时直接告诉他「云端暂不支持,请在电脑上的 PromptCut 里使用」,不要找替代办法。',
  '用户可能已经离开。工具回「发起方不在线」时不要等,按项目内容继续,在进度汇报里说明哪一步没用上页面状态。',
].join('\n');
