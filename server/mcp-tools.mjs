export const tools = [
  {
    name: "list_cards",
    description: "获取系统支持的所有卡片样式(包含 id, name, description, source, controls, defaults)。建卡前必看以了解参数 schema。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "get_project",
    description: "获取整个多轨 Project 对象,了解项目配置、素材和时间轴上的所有轨道与 clip。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "get_selection",
    description: "获取当前选中的 clip id 及其详情和所在轨道。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "add_clip",
    description: "在时间轴上添加一张新卡片。需要提供 cardId 和 start 时间。其他参数可选。返回 clip 对象。",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        start: { type: "number" },
        duration: { type: "number" },
        trackId: { type: "string" },
        params: { type: "object" }
      },
      required: ["cardId", "start"]
    },
    side: "browser"
  },
  {
    name: "update_clip",
    description: "更新某张卡片,可修改参数、时段或更换卡片类型(cardId)。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        start: { type: "number" },
        end: { type: "number" },
        cardId: { type: "string" },
        params: { type: "object" }
      },
      required: ["clipId"]
    },
    side: "browser"
  },
  {
    name: "remove_clip",
    description: "删除某张卡片(根据 clipId)。",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" } },
      required: ["clipId"]
    },
    side: "browser"
  },
  {
    name: "duplicate_clip",
    description: "在原卡片后复制一张一模一样的卡片。",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" } },
      required: ["clipId"]
    },
    side: "browser"
  },
  {
    name: "split_clip",
    description: "在指定时间点(t)将卡片切分为两段。",
    inputSchema: {
      type: "object",
      properties: { 
        clipId: { type: "string" },
        t: { type: "number" }
      },
      required: ["clipId", "t"]
    },
    side: "browser"
  },
  {
    name: "add_track",
    description: "添加一条新的轨道(overlay 或 video)。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["overlay", "video"] },
        name: { type: "string" }
      }
    },
    side: "browser"
  },
  {
    name: "seek",
    description: "跳转到时间轴的指定秒数。",
    inputSchema: {
      type: "object",
      properties: { t: { type: "number" } },
      required: ["t"]
    },
    side: "browser"
  },
  {
    name: "play",
    description: "开始播放。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "pause",
    description: "暂停播放。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "set_theme",
    description: "设置项目的全局主题(如 'midnight' 等)。",
    inputSchema: {
      type: "object",
      properties: { themeId: { type: "string" } },
      required: ["themeId"]
    },
    side: "browser"
  },
  {
    name: "set_project_meta",
    description: "设置项目元数据(名称、宽高、帧率、时长等)。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        fps: { type: "number" },
        duration: { type: "number" },
        themeId: { type: "string" }
      }
    },
    side: "browser"
  },
  {
    name: "stt_status",
    description: "查询语音识别环境状态:Python 版本、各引擎(faster-whisper / whisper)是否已安装、CUDA 是否可用、已下载的模型列表。转写前或安装引擎前先调用此工具了解当前环境。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "stt_install",
    description: "安装指定语音识别引擎(pip 安装到用户数据目录)。由于安装可能超过 60 秒,此工具会立即返回 jobId;调用后请用 stt_status 轮询,直到目标引擎 installed=true。参数:engine(必须,\"faster-whisper\" 或 \"whisper\")。",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["faster-whisper", "whisper"] }
      },
      required: ["engine"]
    },
    side: "browser"
  },
  {
    name: "transcribe_media",
    description: "对指定素材文件进行语音转文字,结果写入项目 store。由于转写可能超过 60 秒,此工具立即返回 jobId;请用 get_transcript 轮询结果(出现 segments 即完成)。超过 200 段时只返回前 200 段和 total。参数:mediaId(必须);engine、model、language 可选(默认 faster-whisper / small / 自动)。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        engine: { type: "string", enum: ["faster-whisper", "whisper"] },
        model: { type: "string", enum: ["tiny", "base", "small", "medium", "large-v3"] },
        language: { type: "string", description: "语言代码,如 zh/en,不填则自动检测" }
      },
      required: ["mediaId"]
    },
    side: "browser"
  },
  {
    name: "get_transcript",
    description: "从项目 store 读取指定素材的语音转文字结果(engine、model、language、createdAt、segments)。transcribe_media 启动后可用此工具轮询结果;未完成时返回 null。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" }
      },
      required: ["mediaId"]
    },
    side: "browser"
  }
];
