export const cutsTools = [
  {
    name: "list_transitions",
    description: "列出当前剪辑里的全部转场(交叉溶解 / 淡入 / 淡出)。**转场会把它引用的片段绑成一组**:那几段的相对时间关系被锁住 —— 单独改时长、换序列、split_clip 都会被拒(update_clip 只给 start 的整组平移仍然可以,同组的会跟着一起走)。要单独调先 remove_transition。返回每条的 id、kind、aId/bId、dur。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "add_transition",
    description: "加一处转场,并把相关片段绑成一组。kind 三种:crossfade 交叉溶解——要两段**首尾相接**的片段(clipId 和 otherClipId,前后顺序写反也认),会把后一段往前拉出重叠、必要时挪到另一条序列(同一条序列内不允许重叠);fadeIn 淡入——只加在片段**开头**;fadeOut 淡出——只加在**结尾**。dur 是秒(默认交叉溶解 0.5、淡入淡出 0.6)。加完那几段的相对时间关系就锁住了,要再单独调先 remove_transition。中间空着一段、时长比片段还长、那一端已经有转场了,都会被拒并告诉你原因。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "crossfade / fadeIn / fadeOut" },
        clipId: { type: "string", description: "淡入淡出:那一段;交叉溶解:两段中的任意一段" },
        otherClipId: { type: "string", description: "只有交叉溶解要:另一段" },
        dur: { type: "number", description: "秒,0.1~10" }
      },
      required: ["kind", "clipId"]
    },
    side: "browser"
  },
  {
    name: "remove_transition",
    description: "删掉一处转场(transitionId 从 list_transitions 或 get_project 的 transitions 里拿)。淡化会被擦掉,交叉溶解还会尽量把后一段放回加转场之前的位置;删完这几段就解锁,可以单独改时间了。",
    inputSchema: {
      type: "object",
      properties: { transitionId: { type: "string" } },
      required: ["transitionId"]
    },
    side: "browser"
  },
  {
    name: "list_cuts",
    description: "列出项目里的全部剪辑(时间轴)。一个项目可以有多条剪辑,时间轴顶部的选项栏切换,默认三条:剪辑1 / 剪辑2 / 剪辑3。**所有 clip / 序列 / 定位 / 导出 / see_frames 工具都只作用于当前激活的那条剪辑**(active:true 的),get_project 的 tracks 也是它的内容;要动别的剪辑先 switch_cut。返回每条的 id、name、active、trackCount、clipCount、duration。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "switch_cut",
    description: "切换到另一条剪辑(按 cutId 或 name 二选一)。切换后 get_project / add_clip / update_clip 等看到和改到的都是这条的内容;播放头回到这条上次离开的位置,选中清空。返回切换后的 cuts 列表和这条的 timeline 摘要。",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        name: { type: "string", description: "剪辑名,和 cutId 二选一" }
      }
    },
    side: "browser"
  },
  {
    name: "add_cut",
    description: "新建一条剪辑(默认名 剪辑N),带两条空序列、时长 30 秒。默认新建后立刻切过去(switch:false 则只建不切)。用户说「另起一条时间轴 / 再做一版」就是它。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        switch: { type: "boolean", description: "默认 true" }
      }
    },
    side: "browser"
  },
  {
    name: "rename_cut",
    description: "给剪辑改名。",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        name: { type: "string" }
      },
      required: ["cutId", "name"]
    },
    side: "browser"
  },
  {
    name: "remove_cut",
    description: "删除一条剪辑。最后一条不能删。里面有内容(clipCount > 0)时会被拒,确实要删就传 force:true 并在 reason 里写明理由(用户会看到)。删的是当前激活那条时会自动切到相邻的一条,返回里 switchedTo 说明切去了哪。",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["cutId"]
    },
    side: "browser"
  }
];
