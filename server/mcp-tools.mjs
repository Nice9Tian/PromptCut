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
    description: "在时间轴上添加一张新卡片。需要提供 cardId 和 start 时间。params 会和卡片 defaults 合并，只写你要改的项即可；但键名必须是该卡真有的参数、标了必填的参数不能为空，否则直接报错——先用 list_cards({cardId}) 看清 schema 再建。字幕卡不要手写 lines，用 fill_captions。返回新建的 clip，外加 `look`（为这张卡准备好的 see_preview 调用，涉及位置和遮挡的决定请照着调去看真实画面）和 `timeline`（当前全部轨道与 clip 的 id、起止一览，之后引用 clipId 以它为准）。",
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
    description: "更新某张卡片,可修改参数、时段或更换卡片类型(cardId)。**已经在时间轴上的卡要改就用它**，不要 remove_clip 再 add_clip 重建。返回 `look`（去看这张卡真实画面的 see_preview 调用）和 `timeline`（当前全部 clip 的 id、起止一览）。",
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
    description: "删除某张卡片(根据 clipId)。有门槛：你自己刚用 add_clip 建的卡、或者一口气连删超过 5 张，会被拒——要改卡用 update_clip；确实要删就传 force:true 并在 reason 里写明理由（用户会看到这句话）。返回 `timeline`（删完后全部 clip 的 id、起止一览，之后引用 clipId 以它为准）。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        force: { type: "boolean", description: "越过门槛（删自己刚建的卡 / 连删超过 5 张）。必须同时给 reason。" },
        reason: { type: "string", description: "为什么要删这张卡。force 为 true 时必填，原样回显给用户。" }
      },
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
    name: "detect_shots",
    description: "识别素材的镜头切换（转场）。检测较慢（5 分钟素材约 36 秒），所以立即返回 jobId，用 list_shots 轮询结果。装了镜头识别拓展时用 TransNetV2，硬切和溶解都认得，溶解还能给出渐变的起止时间；没装拓展时自动退回 ffmpeg scdet，只认硬切、认不出溶解（返回的 engine 字段会说明用的是哪个）。参数 mediaId 必填，force 可选（默认 false，已经检测过就直接复用结果）。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        force: { type: "boolean", description: "true 表示忽略已有结果，重新检测一遍" }
      },
      required: ["mediaId"]
    },
    side: "browser"
  },
  {
    name: "list_shots",
    description: "读取素材的镜头划分结果，detect_shots 之后用它轮询和取数（未完成时返回 running:true 和进度百分比）。返回 shots（每个镜头的 start/end 秒，以及进出各是什么转场）和 transitions（每个转场的 kind: cut 硬切 / dissolve 溶解、start/end 跨度、置信度）。**给素材配动效卡时应当先看这个**：把卡片起止对齐到镜头边界，不要让一张卡横跨两个镜头；溶解区间内不要放强调类动效，那段画面本身在交融。每个镜头还带一个 subject 字段：做过 detect_subjects 就是这段区间里的人物情况（safeSide 哪一侧是空的、suggestedPosition 可直接填进卡片 params.position、suggestedOccupancy 被选中那一侧有多少是人、occupancy 四侧占用率、boxes 人物框），**要「别遮住脸」就照 suggestedPosition 填**；没做过就是 null，返回里的 subjectHint 会提示去调 detect_subjects。suggestedPosition 的取值只有 left / right / bottom，**不会返回 center**；它是「剩下三档里最不坏的」，不等于保证不遮，所以要看 suggestedOccupancy——超过 0.5 时 suggestedPosition 直接给 null 并带一句 warning，表示四个档位都被人物占住、这个镜头没有不遮人的位置，那就缩小卡片或者换个镜头放，别硬填。能不能填这个值以 list_cards({cardId}) 的 controls 为准；卡片没有 position、或选项里没有这个值时换一张支持的卡，**不要退回默认的居中——居中正是人脸所在**。subject.approximate 为 true 表示这个镜头里没有采样点、数字来自最近的一次采样，只是近似。返回顶层的 subjectFailedCount 是抽帧失败的采样个数，subjectFellBackFrom 为 full 表示本来要跑 full 档、中途退回了 light（prompt 没生效）。",
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
    name: "track_points",
    description: "在素材里追踪一个或多个点的运动轨迹，用来让卡片/字幕跟着画面里的目标走。立即返回 jobId，用 get_track 轮询。两档都能用，不装拓展也能追：装了运动追踪拓展走 BootsTAPIR（250 帧约 26 秒，理解画面内容，目标转向、形变、长时间被挡后还能重新认出）；没装时走模板匹配兜底（250 帧约 1 秒，刚体且纹理清晰的目标能追到亚像素，但目标一旦转向、缩放或长时间被挡就会跟丢）。哪一档在跑要看 get_track 返回的 engine。参数：mediaId 必填；points 必填，写成 [[帧号, x, y], ...]，坐标是该素材的原始像素。注意：**要追的点必须落在有纹理的地方**——纯色区域内部（比如一块白色色块的正中）没有可对应的局部特征，追不住。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        points: {
          type: "array",
          description: "[[帧号, x, y], ...]，原始像素坐标",
          items: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          minItems: 1
        }
      },
      required: ["mediaId", "points"]
    },
    side: "browser"
  },
  {
    name: "get_track",
    description: "读取运动追踪结果，track_points 之后用它轮询（未完成时返回 running:true 和进度百分比）。**默认只回摘要**：每个点的可见帧数、位移范围、起止坐标——足够判断这次追踪成没成、值不值得绑。**不要为了让卡片跟着走而把坐标读出来**，那是 attach_clip_motion 的活，数据在应用内部直接流转；一段 30 秒的片子每个点是 900 组坐标，读进来纯属浪费。确实要自己算点什么才传 full:true。某个点带 note 表示它压根没追成（纹理不够、贴太靠边），别用那条。engine 为 template 说明用户没装拓展、走的是模板匹配兜底，目标转向或形变时会悄悄跟丢——不要把大片不可见读成「画面里没有运动」，可以建议用户 track_install 装上拓展再追一次。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        full: { type: "boolean", description: "回逐帧坐标（很长）。默认 false，只回摘要" }
      },
      required: ["mediaId"]
    },
    side: "browser"
  },
  {
    name: "track_status",
    description: "查运动追踪能跑到哪一档，追之前先看一眼。engine 为 bootstapir 表示已装拓展（准、慢、能扛遮挡和形变）；template 表示没装拓展、走 numpy 的模板匹配兜底（快，刚体清晰纹理能追得很准，但目标转向、缩放或长时间被挡就会跟丢）；null 表示两档都用不了（通常是找不到 Python）。用户想要更稳的结果时用 track_install 装拓展。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "track_install",
    description: "安装运动追踪拓展（BootsTAPIR，torch + 权重约 400 MB，要几分钟）。装完追踪会自动从模板匹配兜底切到神经网络档。由于耗时远超调用超时，立即返回 jobId；用 background_job_status 查该 jobId，或用 track_status 看 engine 有没有变成 bootstapir。**不要重复启动**。只在用户明确要更好的追踪效果时才装——兜底档对刚体目标已经够用，别为了追一个纹理清晰的静物就让用户下 400 MB。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "detect_subjects",
    description: "检测素材画面里的人物位置，用来决定卡片放哪边不会遮住人。立即返回 jobId，用 list_subjects 轮询；跑完之后 list_shots 的每个镜头会带上 subject 和 suggestedPosition。**用户说「别遮住脸」「避开人物」「放空的那一边」时走这条路，不要靠猜 position。**返回里带 engine（当前档位）和 etaSeconds（预估耗时）：实测 light 约 0.5 秒/帧、full 约 3 秒/帧，20 个镜头 60 个采样 light 半分钟、full 三分多钟——**light 隔 3 秒问一次 list_subjects、full 隔 10 秒问一次就够**，别每秒都问；engine 为 null 说明两档都用不了，这个作业多半会失败，先调 subject_status 确认。采样时刻默认自己算：做过 detect_shots 就每个镜头取 20%/50%/80% 三点（镜头短于 1 秒只取中点），没做过就每 2 秒一点；总数超过 200 会自动降精度（先每镜头只取一个中点，仍超再等距抽稀），降过就在返回里给一句 sampledNote，此时镜头级结论更粗、approximate 的镜头会变多。也可以自己传 times（素材内秒数数组，一次最多 200 个）。prompt 只有 full 档认（能找任意名词），**必须是英文名词短语、用「 . 」分隔、结尾带句点**，例如「person . face . dog .」；用户的中文需求要先自己翻成英文再传。full 档的文本塔是 bert-base-uncased，词表里没有中文，喂中文会被切成 [UNK] 然后返回**看着合法其实是噪声**的框（实测「显示器 . 椅子 .」框住了画面主体、conf 0.44，纯属瞎猜）。light 档忽略 prompt、只认 person 和 face，但会把提示词原样回显。参数：mediaId 必填；times / prompt / force 可选。同一素材测过会自动复用（换了 prompt、传 force:true、或者上一批结果是 light 档跑的而这次带了 prompt——light 答不了提示词，会自动重测并回 staleEngine:true——才重跑）。先用 subject_status 看能跑到哪一档。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        times: {
          type: "array",
          description: "自己指定采样时刻（素材内秒数）。不传就按镜头自动算",
          items: { type: "number" }
        },
        prompt: { type: "string", description: "要找什么，**只能是英文名词短语**，用 \" . \" 分隔并以句点结尾，如 \"person . face . dog .\"。只有 full 档生效；中文会被切成 [UNK] 并返回噪声框" },
        force: { type: "boolean", description: "true 表示忽略已有结果，重新检测一遍" }
      },
      required: ["mediaId"]
    },
    side: "browser"
  },
  {
    name: "list_subjects",
    description: "读取素材的主体检测结果，detect_subjects 之后用它轮询（未完成时返回 running:true 和进度百分比，没检测过返回 null）。返回 engine（light / full）、prompt、width/height（坐标系）和 samples：每个采样给 t（素材内秒数）、boxes（label / x / y / w / h / conf，**原始视频像素**，只列面积最大的 4 个，boxCount 是真实个数）、occupancy（左半屏 / 右半屏 / 上 1/3 带 / 下 1/3 带各被人物覆盖了多少，0~1）、safeSide（占用最小的那一侧）、suggestedPosition（safeSide 换算成卡片能直接用的值，**只有 left / right / bottom，不会返回 center**）和 suggestedOccupancy（被选中那一侧有多少是人）。suggestedPosition 为 null 时看 warning：四个档位都被人物占住，那一刻没有不遮人的位置，缩小卡片或换个镜头，别退回居中——居中正是人脸所在；能不能填这个值以 list_cards({cardId}) 的 controls 为准，卡片不支持就换一张卡。顶层还有 failedCount（抽帧失败的采样个数，那些采样带 failed:true 和 reason，**不是「这一帧没有人」，不要拿它下结论**）和 fellBackFrom（为 full 表示本来要跑 full 档、中途退回了 light，prompt 因此没生效）。**按镜头排卡片时不必调本工具**，list_shots 已经把这些采样按镜头折好了；这里是给「要看某个具体时刻画面里有几个人、人在哪」用的。engine 为 light 时 label 只可能是 person 或 face，不要把「没有 cat」读成画面里真的没有猫。",
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
    name: "subject_status",
    description: "查主体检测能跑到哪一档，检测之前先看一眼。engine 为 full 表示装了完整拓展（YuNet 人脸 + RT-DETR 人体 + Grounding DINO 开放词汇，prompt 生效，能找任意名词）；light 表示只装了轻档（YuNet + RT-DETR，只认 person 和 face，prompt 不生效）；null 表示**两档都用不了，没有兜底档**——此时不要假装检测过，位置和遮挡的判断退回 see_preview 看真实画面。用户想要就用 subject_install 装 light 档（约 30 MB）。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "subject_install",
    description: "安装主体检测的 light 档（onnxruntime，约 30 MB，一分钟上下）。装完 subject_status 的 engine 会变成 light，就能认 person 和 face 了。耗时可能超过调用超时，所以立即返回 jobId；用 background_job_status 查该 jobId，或用 subject_status 看 engine 有没有变。**不要重复启动**。注意两点：依赖装完还可能缺权重文件（yunet.onnx / rtdetr_r18vd.onnx），那要用户跑拓展库包的 .exe 才有，返回里会说；full 档（Grounding DINO，690 MB）不走在线装，只随拓展库包发，本工具装不了。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "attach_clip_motion",
    description: "把一张卡片绑到一条运动轨迹上，让它跟着画面里的目标走 —— 这是运动追踪真正的用法。先 track_points 追出轨迹，再用这个工具绑，**不需要把坐标读出来**，逐帧数据在应用内部直接流转。卡片会保持你摆的位置，只是跟着目标一起挪。参数：clipId 必填（要跟随的卡片段，不能是素材段）；mediaId 必填（轨迹来自哪段素材）；pointIndex 默认 0（track_points 传了几个点就有几条轨迹，按传入顺序编号）；whenHidden 默认 hold（目标被挡时停在最后看见的位置）或 hide（目标被挡时整张卡不显示）。要求卡片段和该素材段在时间轴上真的重叠，否则会报错——卡片跟着一个当时没在播的画面走是没有意义的。返回里带 movedX/movedY（位移范围）和 visibleFrames，位移接近 0 或大片不可见时会给 warning。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        mediaId: { type: "string" },
        pointIndex: { type: "number", description: "第几条轨迹，默认 0" },
        whenHidden: { type: "string", enum: ["hold", "hide"], description: "目标被挡时的行为，默认 hold" }
      },
      required: ["clipId", "mediaId"]
    },
    side: "browser"
  },
  {
    name: "detach_clip_motion",
    description: "解除一张卡片的运动跟随，让它回到固定位置。参数：clipId 必填。",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" } },
      required: ["clipId"]
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
    name: "get_card_source",
    description: "读回一张自己建的卡的当前源码（只对 create_card 建出来的用户卡有效；内置卡没有可读源码，调整内置卡请改参数）。**要改已有的卡之前必须先调它**：不读回来就改，等于凭记忆重写整张卡，没提到的地方每改一轮就会漂一点。",
    inputSchema: {
      type: "object",
      properties: { cardId: { type: "string", description: "卡片 id" } },
      required: ["cardId"]
    },
    side: "browser"
  },
  {
    name: "edit_card",
    description: "改一张自己建的卡：把源码里的 find 这一段替换成 replace，只动这一处，别的地方原样不变。**这是修改已有卡片的唯一正确方式**，不要用 create_card + overwrite 整篇重写。用法：先 get_card_source 读回源码，照着它原样复制要改的那几行当 find（缩进空格都要一致），写上改完的样子当 replace。find 必须在源码里唯一命中：命中 0 次说明你手上的版本旧了，命中多次就把 find 写长一点带上周围几行。落盘前会跑和建卡一样的校验。",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        find: { type: "string", description: "要被替换掉的原文，逐字照抄源码" },
        replace: { type: "string", description: "替换成的新内容" },
        replaceAll: { type: "boolean", description: "find 有意匹配多处且都要改时传 true" }
      },
      required: ["cardId", "find", "replace"]
    },
    side: "browser"
  },
  {
    name: "see_preview",
    description: "看画面：把时间轴某一刻渲染成图片交回来，用的就是导出那条渲染管线，所以看到的即导出所得。不传参数看整个预览画面（默认播放头所在时刻，也可以用 t 指定第几秒）；传 clipId 则只渲染那一张卡、其余轨道全部不画，用来分辨「这张卡自己不对」还是「被上面别的卡盖住了」（不同时传 t 的话取该片段的中点，避开进出场动画的中间态）。**改完卡片的样式后应当看一眼再下结论**，不要凭源码想象效果。每次要起一个渲染进程，大约几秒到十几秒，别连着刷。画面是叠在深色底上的。",
    inputSchema: {
      type: "object",
      properties: {
        t: { type: "number", description: "时间轴第几秒；不传就用当前播放头" },
        clipId: { type: "string", description: "只看这一个片段的画面" }
      }
    },
    side: "browser",
    // 当场起一个 Chrome 渲一帧,冷启动 + 素材预热可能过分钟,60 秒的默认上限不够
    timeoutMs: 150000
  },
  {
    name: "create_card",
    description: "新建一张动效卡片，源码写入 src/cards/user/<id>.tsx，热更新后自动注册，list_cards 立刻可见。只在现有卡片都满足不了需求时才建新卡——先用 list_cards 确认没有能用的。调用前必须先调 card_authoring_guide 看规则。落盘前会校验 id、CardDef 结构、禁用 API 和语法，不合格直接报错并说明原因。**只用来建新卡**：想改一张已经建好的卡，用 get_card_source + edit_card，不要用 overwrite 整篇重写。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "小写 kebab-case，全局唯一，例如 price-tag" },
        source: { type: "string", description: "完整的 .tsx 源码，必须含 `export const xxx: CardDef<Params> = {...}`" },
        overwrite: { type: "boolean", description: "只在确实要把同名卡整篇换掉时传 true；改细节请用 edit_card" }
      },
      required: ["id", "source"]
    },
    side: "browser"
  }
];
