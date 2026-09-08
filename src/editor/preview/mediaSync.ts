/**
 * 素材层跟播放头对齐时,这一帧该做什么。
 *
 * # 为什么单独抽出来
 *
 * 原来的做法是一句话:播放中偏差超过 0.2s 就 `el.currentTime = target`。
 * 这句话在时间轴开头没问题,到中段就会把画面拖成一卡一卡的,原因是**纠偏手段的代价
 * 随着纠偏对象一起涨,而且没有任何阻尼**:
 *
 *   1. `el.play()` 本身有启动延迟,视频时钟因此天然落后播放头一小截;
 *   2. 落差一旦过 0.2s 就硬 seek。文件中段的 seek 不便宜 —— 关键帧是每 5 秒一个
 *      (实测用户素材就是 5s),浏览器要从上一个关键帧开始解出最多 150 帧才能出画;
 *   3. 这 100~500ms 里播放头照走,seek 落定时又差了 0.2s 以上 → 再 seek;
 *   4. 于是进入自持循环:每次纠偏都制造出下一次纠偏的理由,画面每隔几百毫秒被打断一次。
 *
 * 开头那十几秒之所以没事,是因为 `preload="auto"` 已经把开头缓冲好了、而且 0 秒就是
 * 关键帧,seek 几乎不要钱,启动落差压根到不了 0.2s,循环起不来。
 *
 * # 现在的做法
 *
 * 把「纠偏」和「重新对齐」分成两件事:
 *
 *   - **小偏差用变速**(`playbackRate` 微调 ±10%)慢慢追回来。变速不打断解码,
 *     没有代价,也就不会制造下一次纠偏的理由;
 *   - **只有真的脱节了才 seek**(阈值放宽到 0.5s),而且 seek 之间有冷却时间,
 *     `el.seeking` 期间一律不下新指令 —— 这两条一起,把上面那个自持循环从根上断掉。
 *
 * 纯函数,不碰 DOM,好单测:所有阈值和状态机都在这里,调用方只负责把 el 的读数递进来、
 * 把结果照着执行。
 */

/** 超过这个偏差才认为「脱节了」,值得付一次 seek 的代价 */
export const HARD_SEEK_SEC = 0.5;
/** 两次纠偏 seek 之间至少隔这么久,给解码器把画面重新喂上的时间 */
export const SEEK_COOLDOWN_MS = 700;
/** 小于这个偏差就当对齐了,不做任何纠正(视频帧本身就有 1/帧率 的粒度) */
export const IN_SYNC_SEC = 0.04;
/** 变速纠偏的上限:±10% 人眼和耳朵都听不出来,再多就该听出变调了 */
export const MAX_RATE_SKEW = 0.1;
/** 暂停时对齐得准一点 —— 这时候 seek 不跟播放抢,而且用户在逐帧看 */
export const PAUSED_SEEK_SEC = 0.03;

export interface SyncInput {
  /** 元素当前时间,null 表示还没有元数据、读不出来 */
  elTime: number;
  /** 元素这一刻是不是正在 seek */
  seeking: boolean;
  /** 元素这一刻是不是暂停的 */
  paused: boolean;
  /** 播放头换算到这条素材上的时刻 */
  target: number;
  /** 时间轴在播放中 */
  playing: boolean;
  /** 现在几点(ms),用来算冷却 */
  now: number;
  /** 上一次由我们发起的纠偏 seek 是什么时候,没有过就是 0 */
  lastSeekAt: number;
}

export interface SyncPlan {
  /** 要把 currentTime 设成这个值;null 表示不要动 */
  seekTo: number | null;
  /** 要把 playbackRate 设成这个值;null 表示不要动 */
  rate: number | null;
  /** 要不要调 play() */
  play: boolean;
  /** 要不要调 pause() */
  pause: boolean;
}

const NOTHING: SyncPlan = { seekTo: null, rate: null, play: false, pause: false };

/**
 * 这一帧该对元素做什么。
 *
 * 调用方拿到结果照做即可;`seekTo` 非空时要把 `lastSeekAt` 更新成 `now`。
 */
export function planSync(input: SyncInput): SyncPlan {
  const { elTime, seeking, paused, target, playing, now, lastSeekAt } = input;
  if (!Number.isFinite(target) || target < 0 || !Number.isFinite(elTime)) return NOTHING;

  // seek 还没落定时什么都别做。这一条是断开自持循环的关键:seeking 期间 currentTime
  // 读出来的是目标值不是真实进度,拿它算偏差只会得出「还差很多」,于是再发一次 seek,
  // 把刚才那次的解码工作全部作废 —— 画面就永远出不来。
  if (seeking) return playing && paused ? { ...NOTHING, play: true } : NOTHING;

  if (!playing) {
    // 暂停:速度先还原,免得下次起播带着上次的微调
    const rate = 1;
    const needSeek = Math.abs(elTime - target) > PAUSED_SEEK_SEC;
    return { seekTo: needSeek ? target : null, rate, play: false, pause: !paused };
  }

  const drift = target - elTime; // 正数 = 视频落后于播放头
  const off = Math.abs(drift);

  if (off > HARD_SEEK_SEC) {
    // 真脱节了。但冷却没过就先忍着 —— 上一次 seek 的解码可能还在路上,
    // 这时候再发一次只会把它推翻重来,这正是原来那个循环的形状。
    if (now - lastSeekAt < SEEK_COOLDOWN_MS) return { ...NOTHING, rate: 1, play: paused };
    return { seekTo: target, rate: 1, play: paused, pause: false };
  }

  if (off <= IN_SYNC_SEC) return { seekTo: null, rate: 1, play: paused, pause: false };

  /*
   * 中等偏差:变速追。
   *
   * 偏差 0.04~0.5s 之间线性映射到 ±10% 的速率:落后就快放一点、超前就慢放一点。
   * 0.2s 的偏差按 ~4% 的速差算,5 秒左右能追平,期间画面是连续的 —— 而原来这一档
   * 正好落在硬 seek 的触发区里,每次都要付一次中段 seek 的代价。
   */
  const skew = (drift / HARD_SEEK_SEC) * MAX_RATE_SKEW;
  const rate = 1 + Math.max(-MAX_RATE_SKEW, Math.min(MAX_RATE_SKEW, skew));
  return { seekTo: null, rate, play: paused, pause: false };
}
