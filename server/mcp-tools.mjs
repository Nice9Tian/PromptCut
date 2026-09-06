export const tools = [
  { name: "background_job_status", description: "查询 stt_install 或 transcribe_media 返回的 jobId，得到 done、ok、error 和进度；done=true 且 ok=false 表示失败，不要继续轮询。", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] }, side: "browser" },
  {
    name: "list_cards",
    description: "列出可用卡片。不带参数返回摘要（id、name、description、useWhen 什么时候用这张卡、tags、参数名列表，带 * 的是必填），一次就能扫完所有卡并选定用哪张。选定之后带 cardId 再调一次拿这张卡的完整 controls 和 defaults，然后才 add_clip。",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "只要这一张卡的完整 schema" },
        detail: { type: "string", enum: ["summary", "full"], description: "full 表示所有卡都要完整 schema，通常不需要" }
      }
    },
    side: "browser"
  },
  {
    name: "get_project",
    description: "获取整个多轨 Project 对象,了解项目配置、素材和时间轴上的所有轨道与 clip。返回里 media 的 transcript 只是段数摘要，完整文字稿请用 get_transcript。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "list_media",
    description: "列出素材库里所有素材，返回每条素材的 id、name、kind、duration、width、height、path（服务端可直接读取的绝对磁盘路径）、url、hasTranscript、transcriptSegments（文字稿段数）；想拿完整文字稿要用 get_transcript。需要素材的 mediaId 时优先用本工具，不要为了找 mediaId 去调 get_project。",
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
    description: "在时间轴上添加一张新卡片。需要提供 cardId 和 start 时间。params 会和卡片 defaults 合并，只写你要改的项即可；但键名必须是该卡真有的参数、标了必填的参数不能为空，否则直接报错——先用 list_cards({cardId}) 看清 schema 再建。字幕卡不要手写 lines，用 fill_captions。",
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
    description: "添加一条新的序列(序列不分种类,卡片段和素材段都能放)。",
    inputSchema: {
      type: "object",
      properties: {
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
  },
  {
    name: "auto_workflow",
    description: "对指定素材一键完成 视频到文字稿到动效卡 的整条流程 —— 没有文字稿就先自动转写并等待完成（最多 10 分钟），然后按文字稿切成 5 到 15 秒的段落、用确定性规则给每段配一张合适的动效卡，再给整条文字稿铺一张 caption-track 常驻字幕卡（放在单独的字幕轨上）。参数 mediaId 必填，maxCards 默认 12。用户说 自动做 或 一键配特效 时直接用这个工具。素材较长时本工具会在 50 秒后先返回一个带 jobId 且 running 为 true 的对象，流程在后台继续，用 auto_workflow_status 轮询即可，不要重复调用本工具。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        style: { type: "string" },
        maxCards: { type: "number" }
      },
      required: ["mediaId"]
    },
    side: "browser"
  },
  {
    name: "auto_workflow_status",
    description: "轮询 auto_workflow 后台作业的进度；auto_workflow 在 50 秒内跑完会直接返回完整结果，只有返回里 running 为 true 时才需要用本工具轮询，done 变成 true 后 result 里就是完整结果。",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" }
      },
      required: ["jobId"]
    },
    side: "browser"
  },
  {
    name: "fill_captions",
    description: "把素材文字稿直接灌进一张 caption-track 字幕卡的 lines，本地按时间裁切对齐，不要自己拼 `起|止|文字` 字符串。clipId 不传时自动找时间轴上唯一那张字幕卡，mediaId 不传时用第一个有文字稿的素材。返回填了多少条。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "要填的字幕卡；时间轴上有多张时必须指明" },
        mediaId: { type: "string", description: "文字稿来源素材" },
        showEn: { type: "boolean", description: "是否显示英文行，默认 false" }
      }
    },
    side: "browser"
  },
  {
    name: "import_media",
    description: "把用户用「+」发来的附件装进项目素材库，并放到视频轨上。附件放在对话的工作目录里，和素材库是两回事——`list_media` 看不到它，必须先用本工具导入才能转写、配字幕、配动效。参数 url 就是用户消息末尾附件清单里的「站内地址」（形如 /@pcwork/<会话id>/<文件名>）。返回 mediaId。用户发了视频还让你处理它时，第一步就调它，不要回一句「请先手动导入」。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "附件的站内地址，取自用户消息末尾的附件清单" },
        name: { type: "string", description: "文件名，不传就从地址里取" }
      },
      required: ["url"]
    },
    side: "browser"
  },
  {
    name: "card_authoring_guide",
    description: "取建卡规则全文（CardDef 契约、控件类型、硬性约束、可用依赖、完整示例）。要用 create_card 新建卡片前**必须先调它**，不要凭印象写。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "create_card",
    description: "新建一张动效卡片，源码写入 src/cards/user/<id>.tsx，热更新后自动注册，list_cards 立刻可见。只在现有卡片都满足不了需求时才建新卡——先用 list_cards 确认没有能用的。调用前必须先调 card_authoring_guide 看规则。落盘前会校验 id、CardDef 结构、禁用 API 和语法，不合格直接报错并说明原因。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "小写 kebab-case，全局唯一，例如 price-tag" },
        source: { type: "string", description: "完整的 .tsx 源码，必须含 `export const xxx: CardDef<Params> = {...}`" },
        overwrite: { type: "boolean", description: "改写自己之前建的同名卡时传 true" }
      },
      required: ["id", "source"]
    },
    side: "browser"
  }
];
