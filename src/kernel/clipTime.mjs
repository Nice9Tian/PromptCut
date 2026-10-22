/**
 * 片段速度与「时间轴时刻 ↔ 素材时刻」的换算。全项目只此一份,各处都调它,不各写一遍。
 *
 * # 规则
 *
 *   素材时刻 = mediaOffset + (时间轴时刻 − start) × speed
 *
 * `speed` 是素材段(`TrackClip.speed`)的播放速度,缺省 1。0.5 是慢放(时间轴上 1 秒只走素材 0.5 秒),
 * 2 是快放。只给**视频**素材段设(图片没有时间,声音段变速会没声,见下)。
 *
 * # 缺省 1 时一个字节都不变
 *
 * - 没有 `speed` 字段、或它不是有限正数时按 1 算。IEEE 754 里 `x × 1 === x`、`x / 1 === x`,
 *   所以 `mediaOffset + (t − start) × 1` 与原来的 `mediaOffset + (t − start)` 逐位相同。
 * - 店里(store)写速度时,改回 1 就把字段删掉(`withSpeed`),不留 `speed: 1`:
 *   整份序列进哈希的那几处身份(帧服务的帧身份、镜像的项目哈希、快照签名)只要片段对象不多一个键就不变。
 * - 按字段挑着进键的那几处(层表的输入签名、卡片图的素材节点)只在 `speed !== 1` 时才加这一项(`speedKeyPart`)。
 *
 * # 声音
 *
 * 〔裁〕第一版变速段的原声一律不出(`speedMutesSource`),界面写明。浏览器离线混音没有现成的保调变速,
 * ffmpeg 有 `atempo`,两边做出来不一样,会破「导出与预览一致」(`src/audio/renderMix.ts` 与
 * `server/bakery/mux-audio.mjs` 一一对应)。只有「不出声」两边必然一致。
 *
 * 纯 JS(.mjs):服务端(导出合成、看画面、帧身份)直接 import,不经 TS。
 */

/** 速度的下限与上限(倍) */
export const CLIP_SPEED_MIN = 0.25;
export const CLIP_SPEED_MAX = 4;
/** 界面上写明「变速段不出原声」的那一句(〔裁〕第一版):桌面编辑分区、手机版「速度」面板同一句 */
export const SPEED_MUTE_NOTE = "变速后这一段不出原声（第一版不做变速声音）；改回 1× 恢复。";
/** 界面上给的几档 */
export const CLIP_SPEED_PRESETS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);

/** 片段的速度;没有、或不是有限正数时为 1 */
export function clipSpeed(clip) {
  const s = clip?.speed;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1;
}

/** 这一段改过速度(不是 1) */
export function isSpeedChanged(clip) {
  return clipSpeed(clip) !== 1;
}

/**
 * 这一段的素材原声因为变速而不出(〔裁〕第一版变速段原声静音)。只看素材段:卡片段、剪辑段没有素材速度。
 * 预览的声音层、导出混音(`audioPlanOf` 与 `mux-audio` 的卡片声音那一路)、测响度都用这一条。
 */
export function speedMutesSource(clip) {
  return !!clip?.mediaId && isSpeedChanged(clip);
}

/** 时间轴时刻 t → 素材时刻(秒) */
export function mediaTimeAt(clip, t) {
  return (clip.mediaOffset ?? 0) + (t - clip.start) * clipSpeed(clip);
}

/** 素材时刻 → 时间轴时刻(秒)。`mediaTimeAt` 的反函数 */
export function timelineTimeAt(clip, mediaSec) {
  return clip.start + (mediaSec - (clip.mediaOffset ?? 0)) / clipSpeed(clip);
}

/** 从片段起点往后走 `dt` 秒(时间轴)之后的素材起点:切分的后半段、剪辑段截掉的那一截 */
export function mediaOffsetAfter(clip, dt) {
  return (clip.mediaOffset ?? 0) + dt * clipSpeed(clip);
}

/** 时间轴上一段时长 `dur`(缺省整段)用掉多少秒素材 */
export function mediaSpanOf(clip, dur = clip.end - clip.start) {
  return dur * clipSpeed(clip);
}

/** 一段素材时长在这一段上占多少秒时间轴 */
export function timelineSpanOf(clip, mediaDur) {
  return mediaDur / clipSpeed(clip);
}

/**
 * 把输入的速度收成合法值:不是有限正数 → null(调用方拒绝);否则夹到 [MIN, MAX]、取到百分之一倍。
 */
export function normalizeSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(CLIP_SPEED_MAX, Math.max(CLIP_SPEED_MIN, n)) * 100) / 100;
}

/** 换上新速度的片段(新对象);速度为 1 时**删掉字段**,不留 `speed: 1`(见文件头「缺省 1 时一个字节都不变」) */
export function withSpeed(clip, speed) {
  const { speed: _old, ...rest } = clip;
  return speed === 1 ? rest : { ...rest, speed };
}

/** 进身份键的那一项:速度不是 1 时 `{ speed }`,是 1 时 null(展开后什么都不加) */
export function speedKeyPart(clip) {
  const s = clipSpeed(clip);
  return s === 1 ? null : { speed: s };
}

/**
 * 卡片图(`kernel/cardGraph.mjs` 的 `projectCardGraph` 的结果)里变速段的素材节点补上倍率 `rate`
 * (取帧时刻 = 片段内时间 × rate + offset,`render/cards/GraphCard.tsx`)。它进节点的身份,接这段素材的素材效果卡、
 * 转场的预渲染键跟着变(不加就会命中旧快照、画面错了不报错)。
 *
 * 为什么不直接写在 `projectCardGraph` 里:`cardGraph.mjs` 在内置有声卡的源码导入闭包里,改它一个字,用户已生成的卡片声音
 * 就全被判「已过期」(守门测试 `src/render/audioCardSourceVersion.test.mjs`,出处 `docs/plan/prerender-products-contract.md`
 * 第 9.2 节)。所以由出画面、出键的几处在拿到图之后调这一个函数:导出页(画面与 `__pcCardPlan`)、舞台、剪辑段的嵌套场景、
 * 在线页面的卡片计划(`editor/browserNodeHost.ts`)。
 *
 * 没有变速段时回**同一个对象**(图、键一个字节不变)。
 */
export function withMediaRates(project, graph) {
  if (!graph || !Array.isArray(graph.nodes)) return graph;
  const rates = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (clip?.mediaId && isSpeedChanged(clip)) rates.set(`@clip/${clip.id}/source`, clipSpeed(clip));
    }
  }
  if (!rates.size) return graph;
  return { ...graph, nodes: graph.nodes.map((node) => (node?.adapter === "media" && rates.has(node.id) ? { ...node, rate: rates.get(node.id) } : node)) };
}

/** 给人看的倍数:`2×`、`0.5×` */
export function speedLabel(speed) {
  return `${Math.round(speed * 100) / 100}×`;
}
