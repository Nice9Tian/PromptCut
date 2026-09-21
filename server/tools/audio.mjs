export const audioTools = [
  {
    name: "set_clip_volume",
    description: "设置音频或视频卡片的独立声音音量。volume 范围 0~1，0=无声，0.5=50%，1=原声（默认）。不改变画面不透明度，保留淡入淡出；不会解除序列静音、隐藏或音画分离后的原视频静音。支持撤销，锁定序列须先解锁。",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, volume: { type: "number", minimum: 0, maximum: 1 } }, required: ["clipId", "volume"] },
    side: "browser",
  },
  {
    name: "separate_audio",
    description: "音画分离：保留并静音目标视频片段，在其序列正下方新建序列放置音频卡片，保留起止时间、素材偏移、音量及淡入淡出。返回 audioClipId、trackId、mediaId。锁定序列或已分离的视频不可重复操作。",
    inputSchema: { type: "object", properties: { clipId: { type: "string" } }, required: ["clipId"] },
    side: "browser",
  },
  {
    name: "measure_audio",
    description: "测响度(EBU R128,和导出用的同一个 ffmpeg)。你听不见声音,调音量前先用它看数:给 clipId 测时间轴上那一段(只测它用到的那一截素材、**素材原声**,不含片段音量 / 淡入淡出 / 效果),给 mediaId 测整个素材,scope:'timeline' 测整条时间轴混在一起的结果(含每段音量和淡入淡出;**音频效果不含**,有效果时会标 note)。返回 integrated(整体响度 LUFS,越大越响,-14 是常见的发布目标)、truePeak(峰值 dBTP,超过 0 会削波爆音,发布要在 -1 以下)、lra / lraLow / lraHigh(响度范围,滤掉静音后的第 10 / 95 百分位)。timeline 档另给 series:逐秒的响度和那一秒正在出声的 clipId,好找出哪一秒太吵、是谁吵。经验:人声比配乐 / 环境音响 12~15 LU 才听得清;把两段的 integrated 相减就是差值,要压低 X dB 就 set_clip_volume 到 10^(-X/20)(压 12 dB ≈ 0.25),要抬高只能用 create_audio_fx 的 gain。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "测时间轴上这一段" },
        mediaId: { type: "string", description: "测整个素材" },
        scope: { type: "string", enum: ["clip", "media", "timeline"], description: "不传就按给了 clipId 还是 mediaId 判" },
        series: { type: "boolean", description: "clip / media 档也要逐秒曲线时传 true(timeline 档总是给)" }
      }
    },
    side: "browser"
  },
  {
    name: "create_audio",
    description: "把视频变成声音。两种用法:给 mediaId —— 在素材库里派生出一份「只有声音」的素材(和源视频同一个文件,不转码,所以是瞬间的),之后 add_clip 用这个 mediaId 就是纯音频段;给 clipId —— 把时间轴上**这一段**就地转成声音,画面没了、位置长度素材内偏移淡入淡出全留着,素材库里同时也留一份。同一段视频只会派生一份声音素材,重复调返回同一个 mediaId。图片没有声音会被拒;本来就是声音的原样返回。淡入淡出对声音一样有效(预览按音量、导出按 afade),要给声音加淡入淡出用 add_transition。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string", description: "素材库里的视频:派生一份声音素材" },
        clipId: { type: "string", description: "时间轴上的一段视频:就地转成声音" }
      }
    },
    side: "browser"
  },
  {
    name: "list_audio_fx",
    description: "列出音频效果库(素材库「音频效果」页里的那些),以及能用的效果种类、每种的参数(范围 / 默认 / 单位)、几条预设和表达式写法。每条效果给 fxId、name、description、params(挂到片段上可逐段调的参数)、ops、summary、animated、usedBy(挂在哪几段上)。挂效果前先看有没有现成能复用的;不确定该用哪种时看 kinds 里每种的 hint。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "create_audio_fx",
    description: "新建一个音频效果,放进素材库「音频效果」页 —— 用户能看到、能复用,你也能挂到任意视频 / 声音片段上。ops 是依次作用的几步,每步 { kind, <参数名>: 值 },kind 十一种:gain 增益(db,-60~24,**能超过 0 dB,是把太轻的声音放大的唯一办法**)、highpass 高通(freq, q)、lowpass 低通(freq, q)、peaking 峰值均衡(freq, q, db)、lowshelf 低架(freq, db)、highshelf 高架(freq, db)、compressor 压缩(threshold, ratio, knee, attack, release)、limiter 限幅(ceiling)、delay 回声(time, feedback, mix)、reverb 混响(decay, mix)、pan 声像(pan)。没填的参数取默认(list_audio_fx 的 kinds 里有)。参数写数字,或写**随时间变化的表达式字符串**:t = 片段内秒数、d = 片段时长、p = t/d,还能引用 params 里声明的参数。例:{ name:'压低背景', params:{ amount:{ default:-12, min:-40, max:0, label:'分贝' } }, ops:[{ kind:'gain', db:'amount' }] };人声清晰:ops:[{ kind:'highpass', freq:100 }, { kind:'peaking', freq:3000, q:1, db:3 }, { kind:'compressor', threshold:-24, ratio:3 }]。传 clipId 就顺手挂到那一段上。预览和导出用同一张节点图(Web Audio),听到的和导出的一致。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "素材库里显示的名字,30 字以内" },
        description: { type: "string", description: "一句话说它是什么效果、适合什么声音" },
        params: {
          type: "object",
          description: "可选:可逐段调的参数,键是参数名(小写字母开头,不能和种类的参数名 freq / db / q 等重名),值是 { default, min?, max?, label? }。表达式里直接用参数名",
          additionalProperties: {
            type: "object",
            properties: {
              default: { type: "number" },
              min: { type: "number" },
              max: { type: "number" },
              label: { type: "string" }
            },
            required: ["default"]
          }
        },
        ops: {
          type: "array",
          description: "依次作用的步骤,1~8 步,每步 { kind, <参数名>: 数字或表达式 }",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["gain", "highpass", "lowpass", "peaking", "lowshelf", "highshelf", "compressor", "limiter", "delay", "reverb", "pan"] }
            },
            required: ["kind"],
            additionalProperties: true
          }
        },
        clipId: { type: "string", description: "可选:建完直接挂到这一段(视频 / 声音)" },
        clipParams: { type: "object", description: "可选:挂上时这一段的参数值,覆盖 params 的 default" }
      },
      required: ["name", "ops"]
    },
    side: "browser"
  },
  {
    name: "update_audio_fx",
    description: "改音频效果库里的一个效果。挂着它的片段**全部**跟着变(片段引用的是它,不是复制了一份)。给了 ops / params 就整项替换。只想改某一段,用 apply_audio_fx 给那一段传 params 覆盖,或另建一个效果。",
    inputSchema: {
      type: "object",
      properties: {
        fxId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        params: { type: "object", description: "同 create_audio_fx" },
        ops: { type: "array", items: { type: "object" }, description: "同 create_audio_fx" }
      },
      required: ["fxId"]
    },
    side: "browser"
  },
  {
    name: "remove_audio_fx",
    description: "从音频效果库删掉一个效果。还挂在片段上时会被拒;确实要删就传 force:true 并在 reason 里写明理由(用户会看到),所有剪辑里挂着它的片段会一起摘掉。",
    inputSchema: {
      type: "object",
      properties: {
        fxId: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["fxId"]
    },
    side: "browser"
  },
  {
    name: "apply_audio_fx",
    description: "把音频效果库里的一个效果挂到视频 / 声音片段上(每段只挂一个,再挂就是替换;要叠几种效果就在一个效果里写多步 ops);params 给这一段单独的参数值。fxId 传空字符串就是摘掉。图片和卡片没有声音,不收。挂完可以 measure_audio 看一眼数值。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        fxId: { type: "string", description: "空字符串 = 摘掉这一段的音频效果" },
        params: { type: "object", description: "可选:这一段的参数值,只能是这个效果 params 里声明过的" }
      },
      required: ["clipId", "fxId"]
    },
    side: "browser"
  },
  {
    name: "voice_list",
    description: "查配音(voice_generate)的设置:默认服务(minimax / kling / vidu)、各服务的默认音色和参数、能用的音色(systemVoices 系统音色 + customVoices 用户在「配音设置」里建的或登记的「我的音色」,如复刻出来的人声)、API Key 设没设(apiKeySet)。第一次配音前先调一次,voiceId 从这里挑,不要自己编。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "voice_generate",
    description: "把一段文字配成语音(云端 TTS,走 API),同步返回,几秒钟。不传的参数取「配音设置」里的设置(出厂是 MiniMax speech-2.8-hd)。生成的 mp3 装进素材库;传 start(秒)就同时放到时间轴那个位置(可配 trackId),不传只进素材库。一次一段:MiniMax / Vidu 单次最多 5000 字、可灵 1000 字;长稿按句群拆开多次调,下一段的 start = 上一段 start + 上一段 duration(可留 0.2~0.4 秒气口)。voiceId 只能用 voice_list 里列出的音色,别的会被拒;没有新建音色的工具 —— 新音色首次合成要另收 ¥9.9,只能由用户在「配音设置」里建。没配 API Key、额度用完会报错,把报错原样告诉用户,不要反复重试。返回 mediaId、duration(秒)、clipId(放了时间轴才有)、provider、voiceId、chars(计费字数)。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要念的文字。数字、英文按想要的读法写(「130 毫秒」「PromptCut 零点五」)" },
        start: { type: "number", description: "放到时间轴的起点(秒);不传只进素材库" },
        trackId: { type: "string", description: "放到哪条序列;不传自动挑" },
        provider: { type: "string", enum: ["minimax", "kling", "vidu"], description: "不传用设置里的默认服务" },
        voiceId: { type: "string", description: "音色 id,只能取 voice_list 里有的;不传用该服务的默认音色" },
        speed: { type: "number", description: "语速,MiniMax / Vidu 0.5~2、可灵 0.8~2;不传用设置" },
        emotion: { type: "string", enum: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm"], description: "情绪,只对 MiniMax / Vidu 有效;不传由模型按文字判断" },
        name: { type: "string", description: "素材名里带上的简短标签,如「开场旁白」" }
      },
      required: ["text"]
    },
    side: "browser"
  }
];
