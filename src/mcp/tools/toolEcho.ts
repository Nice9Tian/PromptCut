/**
 * 时间轴类工具（add_clip / update_clip / remove_clip）返回值里的附加物，以及成批删除的门槛。
 * 抽成纯函数是为了能用 node --test 把行为钉住。
 *
 * 为什么要有这些——来自一份真实对话导出的复盘：4 轮对话、79 次工具调用只失败 1 次，
 * 用户还是没拿到想要的结果。时间耗在三件事上：
 *   - 前两轮 47 次调用里 0 次 see_frames，却在总结里写「已避开人物主体」；
 *   - 18 次 remove_clip + 13 次 add_clip：第 2 轮把第 1 轮刚建的 5 张卡全删了、再建 5 张几乎一样的；
 *   - 第 3 轮拿着第 1 轮的 clipId 去 update_clip，那个 id 第 2 轮已经被它自己删了。
 * 三样东西分别对着这三件事：lookHint 给它一个看画面的入口，timelineDigest 让它手里的 id 永远是新的，
 * createClipGuard 让「删自己刚建的卡」和「连着删一串」必须停下来说理由。
 */

import type { Project } from "../../kernel/project";

export interface TimelineDigestClip {
  id: string;
  cardId?: string;
  mediaId?: string;
  /** 挂着的滤镜(project.filters 里的 id) */
  filterId?: string;
  /** 挂着的音频效果(project.audioFx 里的 id) */
  audioFxId?: string;
  start: number;
  end: number;
}
export interface TimelineDigestTrack {
  trackId: string;
  name: string;
  /** 只在为 true 时出现:隐藏 / 静音 / 锁定的序列,模型要知道那上面的东西看不见、听不见或改不了 */
  hidden?: true;
  muted?: true;
  locked?: true;
  clips: TimelineDigestClip[];
}
export interface TimelineDigest {
  /** 整条片子多长(秒)。预览和导出都在这里停 */
  duration: number;
  /** 最后一张卡 / 一段素材结束在哪(秒)。空时间轴是 0 */
  contentEnd: number;
  tracks: TimelineDigestTrack[];
}

/**
 * 工具结果里回显的时间轴一览。只有 id / 卡或素材 / 起止，不带 params，省 token。
 *
 * duration 和 contentEnd 必须一起给出来 —— 这两个数不一样是**看不见的**:
 * 项目时长只涨不缩(store 里 addClip 才 Math.max 一下,removeClip 根本不动它,
 * 卡片类的 clip 连涨都不涨),所以「删完冗余内容」之后时长还停在老的最大值,
 * 片尾挂着一段黑;反过来往后铺卡片铺过了头,超出的部分直接被切掉。
 * 以前这份回显只有轨道和 clip,模型每一步都看不到这个错位,自然也想不到去修。
 */
export function timelineDigest(p: Project): TimelineDigest {
  const tracks = p.tracks.map((tr) => ({
    trackId: tr.id,
    name: tr.name,
    ...(tr.hidden ? { hidden: true as const } : null),
    ...(tr.muted ? { muted: true as const } : null),
    ...(tr.locked ? { locked: true as const } : null),
    clips: tr.clips.map((c) => ({
      id: c.id,
      ...(c.cardId ? { cardId: c.cardId } : { mediaId: c.mediaId }),
      ...(c.filter ? { filterId: c.filter.id } : null),
      ...(c.audioFx ? { audioFxId: c.audioFx.id } : null),
      start: round2(c.start),
      end: round2(c.end),
    })),
  }));
  const ends = p.tracks.flatMap((tr) => tr.clips.map((c) => c.end));
  return {
    duration: round2(p.duration),
    contentEnd: round2(ends.length ? Math.max(...ends) : 0),
    tracks,
  };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 「去看真实画面」的入口。
 * 不硬塞图：每张图要起一个渲染进程（几秒到十几秒），进上下文还烧 token。
 * 给出现成的调用，让模型在涉及位置和遮挡的决定上按需去看。
 */
export function lookHint(clipId: string) {
  return {
    tool: "see_frames",
    args: { source: "timeline", clipId },
    why: "先确认真实画面再下结论：这张卡会不会压到人物、文字会不会被别的卡盖住。要看整屏就不传 clipId、传 t。",
  };
}

export interface ClipGuardOptions {
  /** add_clip 之后多少次时间轴改动之内算「刚建的」 */
  freshWindow?: number;
  /** 连续 remove_clip 到第几张要停下来 */
  deleteStreakMax?: number;
}

export interface RemoveArgs {
  clipId: string;
  force?: boolean;
  reason?: string;
}

/**
 * 成批删除的门槛。两条规则都能用 force:true + reason 越过，但理由会原样回显给用户看——
 * 目的不是禁止删除，是逼它在「推倒重来」之前停一下、说清楚。
 * 默认值来自那份复盘：一轮里删到第 5 张，基本就是清空重铺的形状了。
 */
export function createClipGuard(opts: ClipGuardOptions = {}) {
  const freshWindow = opts.freshWindow ?? 30;
  const deleteStreakMax = opts.deleteStreakMax ?? 5;
  /** clipId → 建它时的改动序号 */
  const born = new Map<string, number>();
  let seq = 0;
  let deleteStreak = 0;

  return {
    /** add_clip / duplicate_clip / split_clip 产生新 clip 之后记一笔 */
    noteCreated(clipId: string) {
      seq++;
      deleteStreak = 0;
      born.set(clipId, seq);
    },
    /** 任何不是删除的时间轴改动（update / add_track …）都打断连删计数 */
    noteMutation() {
      seq++;
      deleteStreak = 0;
    },
    /**
     * remove_clip 之前调。不放行就抛错；错误文案是写给模型看的，要告诉它该怎么办。
     * 放行返回 { reason }：force 越过门槛时的理由，工具结果里原样回显。
     */
    checkRemove(args: RemoveArgs): { reason?: string } {
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (args.force) {
        if (!reason) throw new Error("传了 force:true 就必须在 reason 里写明为什么要删这张卡，用户会看到这句话。");
        return { reason };
      }
      const b = born.get(args.clipId);
      if (b !== undefined && seq - b < freshWindow) {
        throw new Error(
          `clip ${args.clipId} 是你刚用 add_clip 建的（之后只过了 ${seq - b} 次改动）。` +
            `要改它（参数、时段、换卡）用 update_clip，不要删了重建——重建会丢掉这次没提到的细节，` +
            `也会让你手里的 clipId 失效。确实要删就传 force:true 并在 reason 里说明。`,
        );
      }
      if (deleteStreak >= deleteStreakMax) {
        throw new Error(
          `已经连续删了 ${deleteStreak} 张。先停一下：用 get_project 看清现在还剩什么、哪些才是用户说的冗余；` +
            `确实要继续删就传 force:true 并在 reason 里逐条说明。`,
        );
      }
      return {};
    },
    /** remove_clip 成功后记一笔 */
    noteRemoved(clipId: string) {
      seq++;
      deleteStreak++;
      born.delete(clipId);
    },
  };
}
export type ClipGuard = ReturnType<typeof createClipGuard>;
