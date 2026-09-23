import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { findClip } from "../../kernel/project";
import { cameraFor, clampFov, DEFAULT_FOV_DEG, MAX_FOV_DEG, MIN_FOV_DEG } from "../../kernel/space3d";
import { mediaCardUrl } from "../../ai/mediaRef";


export const projectHandlers = {
  getProject: () => {
    const p = getState().project;
    return {
      ...p,
      media: p.media.map(m => {
        if (m.transcript) {
          return {
            ...m,
            transcript: {
              engine: m.transcript.engine,
              model: m.transcript.model,
              language: m.transcript.language,
              createdAt: m.transcript.createdAt,
              segments: m.transcript.segments.length,
              hint: "完整文字稿请用 get_transcript"
            }
          };
        }
        return m;
      })
    };
  },
  listMedia: () => {
    const p = getState().project;
    return p.media.map(m => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      duration: m.duration,
      width: m.width,
      height: m.height,
      // 卡片里引用用 cardUrl。不再给 url:导入的素材那是 blob: 开头的编辑器私有地址,
      // 模型拿去填卡片只会得到空白画面(见 src/ai/mediaRef.ts)
      cardUrl: mediaCardUrl(m),
      path: m.path,
      hasTranscript: !!m.transcript,
      transcriptSegments: m.transcript ? m.transcript.segments.length : 0
    }));
  },
  getSelection: () => {
    const state = getState();
    if (state.selection.length === 0) return null;
    const clipId = state.selection[0];
    const hit = findClip(state.project, clipId);
    if (!hit) return null;
    return { id: clipId, trackId: hit.track.id, clip: hit.clip };
  },
  /**
   * 总时长不走 setProjectMeta:直接写进项目会被时间轴立刻按内容末尾改回去。
   * 走手动截断那条路,和用户手动缩短是同一个规则(kernel/duration.ts)。
   */
  setProjectMeta: (args) => {
    const { duration, ...rest } = args ?? {};
    if (Object.keys(rest).length) actions.setProjectMeta(rest);
    if (typeof duration === "number" && Number.isFinite(duration)) actions.setDurationManual(duration);
    return { ok: true, duration: getState().project.duration };
  },
  /**
   * 三维总开关。**只认 fov,不收相机距离** —— 距离是 fov 和画布高度推出来的,
   * 让人填距离的话换个画幅透视强度就变了(见 kernel/space3d.ts 里的那张表)。
   * 关掉时把字段整个删掉而不是设 0:老项目没有这个字段,存盘结果要和从没开过三维一样。
   */
  setCamera3d: (args) => {
    const hasFov = args?.fovDeg !== undefined && args.fovDeg !== null;
    /*
     * 非数字直接抛,不走 clampFov。
     * clampFov 对 NaN 返回默认值 40,于是 set_camera3d({fovDeg:"很强"}) 会得到
     * 「fovDeg 被夹到 40(允许 5~120)」—— Agent 以为自己传的数字越界了,
     * 其实是**类型**就错了,它会去调数字而不是去改类型。
     * 同一个仓库里 framePatchFromArgs 对非数字就是直接抛,两处要一个标准。
     */
    if (hasFov && (typeof args.fovDeg !== "number" || !Number.isFinite(args.fovDeg))) {
      throw new Error(`fovDeg 必须是有限数字(${MIN_FOV_DEG}~${MAX_FOV_DEG}),收到 ${JSON.stringify(args.fovDeg)}`);
    }
    const turnOff = args?.enabled === false;
    if (turnOff) {
      /*
       * 关掉时把调过的 fov 记在一边。不记的话「关掉看看对比、再打开」会静悄悄
       * 退回默认 40 —— 用户调到 60 的那个感觉没了,而且没有任何提示。
       * 记在 store 之外的模块变量里:它不该进项目文件(存盘结果要和从没开过三维一样)。
       */
      const remembered = getState().project.camera3dFov ?? getState().lastCamera3dFov ?? undefined;
      actions.setProjectMeta({ camera3dFov: undefined });
      actions.rememberCamera3dFov(remembered ?? null);
      return {
        ok: true,
        enabled: false,
        hint: `三维已关。卡片上的 rotateX/rotateY/translateZ 还在,只是不再有透视${remembered ? `;再打开(enabled:true)会回到 ${remembered}°` : ""}`,
      };
    }
    if (!hasFov && args?.enabled !== true) {
      const cur = getState().project;
      return {
        ok: true,
        enabled: !!cur.camera3dFov,
        fovDeg: cur.camera3dFov ?? null,
        hint: "什么都没传,这里只是报了下当前状态。要打开传 fovDeg(或 enabled:true),要关掉传 enabled:false",
      };
    }
    const fov = clampFov(hasFov ? args.fovDeg : (getState().project.camera3dFov ?? getState().lastCamera3dFov ?? DEFAULT_FOV_DEG));
    actions.setProjectMeta({ camera3dFov: fov });
    const cur = getState().project;
    const cam = cameraFor({ width: cur.width, height: cur.height }, fov);
    return {
      ok: true,
      enabled: true,
      fovDeg: fov,
      ...(hasFov && fov !== args.fovDeg
        ? { clamped: `fovDeg 被夹到 ${fov}(允许 ${MIN_FOV_DEG}~${MAX_FOV_DEG})` }
        : null),
      cameraDistancePx: Math.round(cam.distance),
      hint: "现在 set_position 的 rotateX / rotateY / translateZ 会走真透视了。改完用 see_frames 看一眼 —— 透视强度只能看,算不出来",
    };
  },
  setTheme: (args) => { actions.setProjectMeta({ themeId: args.themeId }); return { ok: true }; },
} satisfies Partial<EditorApi>;
