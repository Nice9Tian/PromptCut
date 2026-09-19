export const coreTools = [
  {
    "name": "wait",
    "description": "等待若干秒之后再继续（用于轮询之间的间隔）。凡是返回 jobId 让你轮询的工具（collect_job、stt_status、get_transcript、list_shots 等），两次查询之间用它来等，**不要用 shell 命令或别的办法自己睡** —— 那些在无人值守模式下会被拒绝，并且会让整轮对话直接中断。参数 seconds：1~30，默认 3。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "seconds": {
          "type": "number",
          "description": "等多少秒，1~30，默认 3"
        }
      }
    },
    "side": "server"
  },
  {
    "name": "report_progress",
    "description": "给用户看的唯一进度汇报渠道。每完成一个小阶段调一次(final: false),整个任务结束前必须调一次(final: true),因为出错或卡住而停下来也算结束;先填三个布尔再填列表;每条一句简洁中文、不超过 40 字、每类不超过 8 条。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "final": {
          "type": "boolean"
        },
        "has_done": {
          "type": "boolean"
        },
        "has_todo": {
          "type": "boolean"
        },
        "has_problem": {
          "type": "boolean"
        },
        "stage": {
          "type": "string"
        },
        "done": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "todo": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "problems": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "final",
        "has_done",
        "has_todo",
        "has_problem",
        "done",
        "todo",
        "problems"
      ]
    },
    "side": "server"
  },
  {
    "name": "background_job_status",
    "description": "查询 stt_install 或 transcribe_media 返回的 jobId，得到 done、ok、error 和进度；done=true 且 ok=false 表示失败，不要继续轮询。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "jobId": {
          "type": "string"
        }
      },
      "required": [
        "jobId"
      ]
    },
    "side": "browser"
  },
  {
    "name": "auto_workflow",
    "description": "对指定素材一键完成 视频到文字稿到动效卡 的整条流程 —— 没有文字稿就先自动转写并等待完成（最多 10 分钟），然后按文字稿切成 5 到 15 秒的段落、用确定性规则给每段配一张合适的动效卡，再给整条文字稿铺一张 caption-track 常驻字幕卡（放在单独的字幕轨上）。参数 mediaId 必填，maxCards 默认 12。用户说 自动做 或 一键配特效 时直接用这个工具。素材较长时本工具会在 50 秒后先返回一个带 jobId 且 running 为 true 的对象，流程在后台继续，用 auto_workflow_status 轮询即可，不要重复调用本工具。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "mediaId": {
          "type": "string"
        },
        "style": {
          "type": "string"
        },
        "maxCards": {
          "type": "number"
        }
      },
      "required": [
        "mediaId"
      ]
    },
    "side": "browser"
  },
  {
    "name": "auto_workflow_status",
    "description": "轮询 auto_workflow 后台作业的进度；auto_workflow 在 50 秒内跑完会直接返回完整结果，只有返回里 running 为 true 时才需要用本工具轮询，done 变成 true 后 result 里就是完整结果。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "jobId": {
          "type": "string"
        }
      },
      "required": [
        "jobId"
      ]
    },
    "side": "browser"
  },
  {
    "name": "seek",
    "description": "跳转到时间轴的指定秒数。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "t": {
          "type": "number"
        }
      },
      "required": [
        "t"
      ]
    },
    "side": "browser"
  },
  {
    "name": "play",
    "description": "开始播放。",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "side": "browser"
  },
  {
    "name": "pause",
    "description": "暂停播放。",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "side": "browser"
  }
];
