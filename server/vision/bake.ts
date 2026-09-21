/**
 * 单卡预渲染:算缓存键(`bakeTarget`)、烘单张(`bakeOne`)、烘同一张卡的一批时刻(`bakeClip`)。
 * 从 server/vite-plugin-vision.ts 逐字搬来。
 *
 * **这份模块状态只有这里能写**:`bakeInFlight`(同一个键正在飞的那一趟)。
 * 依赖方向:bake → render / render-queue,单向。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isolateClip } from "../vision-project.mjs";
import { mediaDir } from "../vite-plugin-media";
import { cardCodeHash } from "../card-overrides.mjs";
import { enqueue } from "./render-queue";
import { nextCounter, renderFrames, renderOneFrame } from "./render";
import type { FrameResult } from "./render";
import type { Runner } from "./worker-pool";

/**
 * 烘焙时把片段挪到第几秒开始(起跑线)。理由和实测数据见 bakeTarget 里那段长注释。
 *
 * 不能是 0:预热在 t=0 上走四帧再重挂载卡片,压着第 0 帧的段会多经历这一段,画出来不一样
 * (实测 step-timeline 差 15164 个像素)。0.5 秒 = 15 帧,推过去约 0.24 秒,买的是
 * 「34/34 张卡挪位置逐字节相同」。
 */
const BAKE_LEAD = 0.5;

/**
 * 正在渲的:键 → 那次渲染的 promise。同一个键同时被要好几次时共用一次渲染。
 * 并行池之前不需要它(串行天然错开),之后才需要 —— 见 bakeOne 里的说明。
 */
const bakeInFlight = new Map<string, { promise: Promise<any>; priority: number }>();

/**
 * 这张图卡片段用到的全部图卡源码指纹(自己 + 上游整条链)。
 *
 * 隔离缓存键里只带 `cardCodeHash(clip.cardId)` 是不够的:片段指向的是 `cardNodes` 里的
 * 图卡节点,它的输入可以再接另一张图卡。改了上游那张卡的源码而不改这张,键一个字节没变,
 * `inspect_card_dom` / `bake_card` 就吃到旧缓存 —— 而且不报错,只是画面不跟着改。
 * 按节点 id 去重、按 id 排序,同一张图算出来的值和遍历顺序无关。
 */
function graphCardCode(project: any, nodeId?: string): string[] | undefined {
  if (!nodeId) return undefined;
  const nodes = new Map<string, any>((project?.cardNodes || []).map((n: any) => [n.id, n]));
  const seen = new Set<string>(), codes = new Set<string>();
  const walk = (id?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) return;
    if (node.adapter === 'card' && node.cardId) codes.add(node.cardId + ':' + cardCodeHash(node.cardId));
    for (const input of Object.values(node.inputs || {}) as any[]) walk(input?.nodeId);
  };
  walk(nodeId);
  return codes.size ? [...codes].sort() : undefined;
}

/**
 * 算出「这次烘焙对应磁盘上哪个文件」,以及烘它需要的那几样东西。**不碰文件系统。**
 *
 * 单独拆出来是因为除了烘焙本身,还有两个地方要问同一个问题:
 * 「这张卡烘过没有、那个文件多大」(bake-status)和「哪些文件是过期的、该删」(bake-evict)。
 * 这三方只要有一方把键算得不一样,就会出现「明明烘过却当成没烘」或者「把正在用的文件删了」——
 * 而且都不会报错,只会莫名其妙地慢下来或者闪一下。所以键只有这一处算得出来。
 */
export function bakeTarget(
  project: any,
  clipId: string,
  t: number,
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
) {
  const iso = isolateClip(project, clipId);
  if (!iso) throw new Error(`时间轴上没有 id 为 ${clipId} 的片段。`);
  if (iso.clip.mediaId) throw new Error("这是素材段(视频 / 图片),本来就是位图,直接把它的 URL 当纹理用即可,不用烘。");

  /*
   * **把 frame 摘掉再烘。**
   *
   * frame 是「这张卡摆在整个画幅的哪儿、怎么转」,是相对项目画幅(比如 1920×1080)写的。
   * 而烘焙要换一个画布(正方形贴图 / 卡片自己的框),坐标对不上 —— 一张 x:960 的卡
   * 放到 512×512 的画布上就整个跑到画外,烘出来是**一张全透明的空图,而且不报错**。
   * (实测:带 frame 的卡烘出来 transparentRatio = 1、1096 字节,三种不同变换烘出来还一模一样,
   * 因为它们都是同一张空图。)
   *
   * 摘掉之后卡片铺满画布、按画布尺寸重新排版 —— 卡片本来就是响应式的,这正是我们要的
   * 「这张卡自己长什么样」。位置和三维变换由用它的那一方去做:
   * scene-3d 贴到物体表面,3D 视图贴到代表这张卡的那块板子上。烘的时候再带一遍就是叠两次。
   */
  /*
   * **把这一段挪到固定的起跑线上再烘。**
   *
   * 以前是照着它在时间轴上的原位渲的,两笔账都记在这上头:
   *
   * 1. **延迟和它排得多靠后成正比。** 导出脚本从第 0 帧顺推(确定性要求),而实测**推一个
   *    「画面上什么都没有」的空帧和推一个实帧一样贵**(约 16ms):一张卡摆在第 10 秒,
   *    烘它第一帧要 9014ms,其中 4803ms 全花在推 0~299 这 300 个空帧上。
   * 2. **挪一下位置,它烘好的十来个时刻全部作废。** 缓存键里带着 start/end 的绝对值,
   *    而画面根本没变 —— 用户只是把卡拖了个位置,参数一个字没改,却要干等重烘一遍。
   *
   * 挪到起跑线上之后,同一张卡同一个**片内相对时刻**永远算出同一个键、渲同一趟,
   * 两笔账一起消掉:推帧距离只剩 BAKE_LEAD + 片内偏移,和它排在哪儿无关。
   *
   * ## 凭什么敢挪:34 张卡逐字节验过
   *
   * 挪位置要成立,前提是卡片画出来和绝对位置无关。逐卡对过账(同一片内时刻,一份摆在
   * 0.5 秒处、一份摆在 12 秒处,比 PNG 的 sha1):**34/34 逐字节相同**。
   *
   * 验的过程里咬出两件事,都在这一版里处理了:
   *
   * - **mu-word-rotate 原来真的会随位置变**:摆在 0/0.5/1 秒处和摆在 2/3/4/6/12 秒处
   *   烘出来是两张不同的图,差 22599 个像素、最大通道差 250(板子上显示的是上一个词还是
   *   下一个词)。根因在卡片那边(轮播用 `now - lastTick` 累加、命中后把相位挪到当前帧),
   *   已经改成 `floor(elapsed / duration)`,见 vendor/word-rotate.tsx。
   * - **第 0 帧是特殊的,所以起跑线不能是 0。** 预热(warmUp)在 t=0 上走四帧再重挂载卡片,
   *   于是「片段正好压着第 0 帧」的卡会多经历这一段:实测摆在 0 秒处 vs 摆在别处,
   *   step-timeline 差 15164 个像素、mu-word-rotate 差一整个词。留半秒的起跑距离就绕开了
   *   ——  实测 0.5 秒处和 12 秒处 34/34 逐字节相同。代价是每趟多推 15 帧(约 0.24 秒)。
   */
  /*
   * **片内位置一律用「第几帧」表示,不用「差多少秒」。**
   *
   * 时刻的格子本来就是相对片段起点的(`bakeTime.ts` 的 `pickBakeT` 返回 `clip.start + 格子`),
   * 所以直觉上 `t - clip.start` 就把绝对位置减掉了。但那是**浮点减法**:一段摆在 3 秒处时
   * `3.25 - 3 = 0.25` 逐位精确,摆在 17.3 秒处时 `17.55 - 17.3 = 0.2500000000000018`。
   * 键是拿这个数哈希出来的,于是"挪一下位置就全部作废"会以另一种形式活下来 ——
   * 而且只在位置不是整数的时候发作,最难查。(同一类坑 bakeTime.ts 里记过一次:
   * step=1/30 时累加和 floor 再乘差 2.8e-17,后果是"预烘出来的图显示端一张都问不到"。)
   *
   * 换成整数帧号就没有这回事:同一个帧号必然算出同一个 double,而渲染那一侧
   * (`Math.round(at * fps)`)本来就只认帧号,一点信息都没丢。
   */
  const fps = project.fps || 30;
  // 至少留一帧:零长度的段推不出任何一帧,烘出来是空图而且不报错
  const lenFrames = Math.max(1, Math.round(((iso.clip.end ?? 0) - (iso.clip.start ?? 0)) * fps));
  const len = lenFrames / fps;
  const { frame: _dropFrame, ...bare } = iso.clip;
  /*
   * 键就是从这个 plainClip 算的,所以**这里挪了位置,键才真的和位置无关**。
   * 只改 at、不改 clip 上的 start/end 是不够的 —— 那两个字段照样会进哈希。
   */
  const plainClip = { ...bare, start: BAKE_LEAD, end: BAKE_LEAD + len };
  const box = {
    w: Math.max(1, Math.round(iso.clip?.frame?.w ?? project.width)),
    h: Math.max(1, Math.round(iso.clip?.frame?.h ?? project.height)),
  };
  const px = Math.min(2048, Math.max(256, Math.round(Number(size) || 1024)));
  /*
   * 画幅两种:
   *   square —— 正方形。贴到立体表面上用(bake_card 的默认):原始 16:9 会被拉变形。
   *   box    —— 卡片自己那个框的尺寸。3D 视图用:那边的板子就是这个框,
   *             一比一贴上去才不会拉伸,而且排版和舞台上完全一致。
   */
  /*
   * **两个尺寸,不能混为一谈。**
   *
   *   renderBox —— 按什么尺寸**排版**,也就是输出多大。必须是这张卡在成片里真实的容器大小。
   *
   * 原来这两个是同一个值(直接按贴图尺寸去渲),后果是**卡片按别的宽度重新排了版**:
   * 卡片用的是绝对 px,容器从 1920 变成 1024,字就相对变大、要换行、底块被撑满。
   * 实测同一张 blur-text:在 1024×576 上渲,内容框占画布 100%×70.1%(换行);
   * 在真实的 1920×1080 上渲是 66.5%×28.1%(一行)—— 后者才和 2D 预览一致。
   * 也就是说 3D 板子上贴的根本不是 2D 那张画面,而且不报错。
   *
   * square 那一档不受影响:它**本来就是**要在正方形容器里排版(贴到立体表面上,
   * 16:9 会被拉变形),所以它的 renderBox 就是那个正方形。
   */
  const renderBox = fit === "box" ? { width: box.w, height: box.h } : { width: px, height: px };
  // 没给时间就取这一段的中点 —— 起止两端常卡在进场 / 退场动画上,烘出来是个半透明中间态
  const relFrames = Number.isFinite(t)
    ? Math.min(lenFrames, Math.max(0, Math.round(((t as number) - (iso.clip.start ?? 0)) * fps)))
    : Math.round(lenFrames / 2);
  /** 真正渲第几帧:起跑线 + 片内第几帧。**键和渲染都用它**,所以和绝对位置无关 */
  const at = BAKE_LEAD + relFrames / fps;
  /**
   * 回给调用方的 t —— **必须是它问的那个绝对时刻**,不是上面那个挪过的。
   *
   * 3D 视图和预烘都拿 `clipId + t` 当贴图的账本键(momentId),回一个挪过的时刻就会
   * 对不上号:`batch.find(x => x.t === b.t)` 全部落空,于是「明明烘出来了却当成没烘」,
   * 一直重烘同一张,而且不报错。
   */
  const askedT = Number.isFinite(t) ? (t as number) : (iso.clip.start + iso.clip.end) / 2;
  const rgb = typeof bg === "string" ? /^#?([0-9a-f]{6})$/i.exec(bg.trim()) : null;

  /*
   * code:这张卡此刻代码的哈希(定义文件 + 依赖闭包的生效内容,见 card-overrides.mjs)。
   * 没有它的时候改了卡片源码,预烘的旧图照样命中,3D 视图里贴的一直是改之前的样子。
   */
  const key = createHash("sha1")
    .update(JSON.stringify({ clip: plainClip, graph: iso.clip.nodeId ? { nodes: project.cardNodes, media: project.media, tracks: project.tracks, style: project.style } : undefined, theme: project.themeId, at, renderBox, fit, bg: rgb ? rgb[1].toLowerCase() : null, code: cardCodeHash(iso.clip.cardId), graphCode: graphCardCode(project, iso.clip.nodeId) }))
    .digest("hex").slice(0, 12);
  // 文件名带上 clipId 只是为了在素材目录里认得出来;真正保证唯一的是后面那段输入哈希
  const name = `bake-${clipId.replace(/[^\w.-]/g, "_")}-${key}.png`;
  const url = `/@media/${encodeURIComponent(name)}`;
  /**
   * 渲这一趟用的项目。**只在这里拼一次**:烘单张和烘一批以前各拼一份,
   * 两处都要记得改 duration、改 tracks、按 renderBox 排版 —— 漏一处就是
   * 「单张烘的和批量烘的不是同一张图」,而且不报错。
   *
   * duration 必须跟着挪过的位置重算(原来那个是整条片子的长度,而这里只剩一段),
   * 多给一帧的余量:renderFrames 会把帧号夹进 duration*fps-1,正好卡在末尾时会少一帧。
   */
  const target = {
    ...iso.project,
    // **按真实容器尺寸排版**,不是按贴图尺寸(见上面那段说明)
    width: renderBox.width,
    height: renderBox.height,
    duration: BAKE_LEAD + len + 1 / fps,
    tracks: iso.project.tracks.map((tr: any) => ({ ...tr, clips: tr.clips.map((c: any) => c.id === clipId ? plainClip : c) })),
  };
  return { iso, plainClip, renderBox, target, at, askedT, rgb, key, name, url };
}


/**
 * 烘一张卡成图片,**按输入做缓存**。单张 bake_card 和 3D 视图的批量都走这里。
 *
 * 缓存键是「输入」的哈希 —— 卡片内容 + 时刻 + 尺寸 + 底色 + 主题。所以同一张卡同样的参数
 * 只会真渲一次(4.7~6.5 秒),之后命中就是一次 fs.access,零成本。
 * 这正是「一般来说用户都是烘焙好的、不用代理」能成立的前提:代理只覆盖第一次那几秒。
 *
 * 键里**不能**用输出的哈希:那要先渲出来才知道叫什么,等于永远不命中。
 */
export async function bakeOne(
  root: string,
  origin: string,
  project: any,
  clipId: string,
  t: number,
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
  /** 1 = 用户正等着看的,插队;0 = 空闲预烘,排队尾 */
  priority = 0,
  /**
   * 已经渲好的那一帧(已经按 bg 压过底色、数过透明像素)。给 bakeClip 用:它一趟渲出同一张卡的好几个时刻,
   * 然后把每一张交回这里走**同一套**缓存键、原子落盘和返回值 ——
   * 两条路各写一套的话,迟早会出现「单张烘的和批量烘的不是同一张图」,而且不报错。
   */
  pre?: FrameResult,
  /** signal:调用方断开就取消;runner:谁来跑(不给是渲染池,界面的热备渲染器会传自己的) */
  o: { signal?: AbortSignal; runner?: Runner } = {},
): Promise<any> {
  const { target, at, askedT, rgb, key, name, url, renderBox } = bakeTarget(project, clipId, t, size, bg, fit);
  const dir = mediaDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);

  const hint = rgb
    ? "不透明贴图:贴上去是「实心物体表面印着这张卡」。把 url 填进 scene-3d 的 texture 参数。"
    : "透明底贴图:贴上去物体在卡片没画的地方也是透空的,内容像浮在空间里(适合标志 / 招牌)。想要「实心立方体表面印着这张卡」就重烘一次并传 bg(比如 bg:\"#0b0f17\")。";
  const note = "这是一张**快照**:卡片的动画定格在 t 这一帧,之后改卡片参数贴图不会跟着变,要重新烘。";

  // 缓存命中:同样的输入烘过了,直接给 URL
  try {
    const st = await fsp.stat(file);
    return { clipId, url, t: askedT, width: renderBox.width, height: renderBox.height, bytes: st.size, cached: true, hint, note };
  } catch { /* 没烘过,往下渲 */ }

  /*
   * **同一个键正在渲,就等它,别再渲一遍。**
   *
   * 渲染改成并行池之后才需要这个:以前是串行的,同一个键的第二个请求必然排在第一个之后,
   * 那时文件已经落盘 → 走上面的缓存命中。现在它们可以同时在飞,于是都 stat 落空、
   * 都起一个 Chrome、最后都往**同一个路径** writeFile。
   *
   * 实测:同时发 4 个完全一样的请求 → 真渲了 4 次,白烧 3 个 Chrome(每个约 4 秒)。
   * 更糟的是那几个 write 会重叠,中间有个窗口能被读到半张 —— 而浏览器正好可能在这时候
   * 来取这张图,拿到半张 PNG 就是贴不上,表现成「这块板子怎么一直是色块」。
   */
  /*
   * 搭车等同键的那一趟,有两个例外:
   *   - **自己更急就不搭**:Agent 的 bake_card(优先级 1)撞上一趟排在队尾的预烘(优先级 0)时,
   *     跟着等就是排在所有预烘后面、直到工具超时 —— 优先级倒挂。自己渲一趟,落盘是原子改名,两份不冲突。
   *   - **那一趟被取消了**(是它的请求方断开,不是这张图渲不出来):再看一眼,别的等待者可能已经接着渲了,
   *     有就跟那一趟;没有才自己来。见过的就不再跟,免得在同一个已经失败的 promise 上打转。
   */
  const seen = new Set<Promise<any>>();
  for (;;) {
    const flying = bakeInFlight.get(key);
    if (!flying || seen.has(flying.promise) || priority > flying.priority) break;
    seen.add(flying.promise);
    try {
      return await flying.promise;
    } catch (e: any) {
      if (!e?.cancelled || o.signal?.aborted) throw e;
    }
  }

  const work = bakeAndWrite();
  bakeInFlight.set(key, { promise: work, priority });
  try {
    return await work;
  } finally {
    if (bakeInFlight.get(key)?.promise === work) bakeInFlight.delete(key);
  }

  async function bakeAndWrite() {
  /*
   * 底色决定贴上去是什么观感,而这个选择只该在**烘的时候**做一次:
   *   不传 bg → 透明底,物体在卡片没画的地方也透空(挖空观感,适合标志 / 招牌);
   *   传了 bg → 压平成不透明,实心物体表面印着这张卡。
   * 压底色和数透明像素都在渲染 worker 里做(post.bg / post.stats,见 server/png-post.mjs),
   * 这个进程只收字节、落盘。
   */
  const post = { bg: rgb ? rgb[1].toLowerCase() : null, stats: true };
  const r = pre ?? (o.runner
    ? await renderOneFrame(root, origin, target, at, [], priority, { signal: o.signal, runner: o.runner, post })
    : await enqueue(() => renderOneFrame(root, origin, target, at, [], priority, { signal: o.signal, post }), priority, 0, o.signal));

  /*
   * 先写临时名再改名。改名在同一个卷上是原子的,所以**读的人要么看不到这个文件、
   * 要么看到完整的一张**,不会读到写了一半的。直接往目标名写会留一个能读到半张的窗口,
   * 而半张 PNG 贴不上,看起来就是「这块板子一直是色块」,还查不出原因。
   */
  const tmp = `${file}.${process.pid}-${nextCounter()}.tmp`;
  await fsp.writeFile(tmp, r.buf);
  await fsp.rename(tmp, file);
  return {
    clipId, url, t: askedT, width: r.width ?? renderBox.width, height: r.height ?? renderBox.height, bytes: r.buf.length, cached: false,
    ...(r.transparentRatio !== undefined ? { transparentRatio: r.transparentRatio } : {}),
    hint, note,
  };
  }
}

/**
 * 烘**同一张卡的若干个时刻**。没烘过的合成一趟渲完,烘过的直接命中缓存。
 *
 * 为什么按卡分组而不是把所有请求平铺开:导出脚本从第 0 帧顺推(确定性要求),所以
 * 「烘第 F 帧」这件事已经把 0..F 全推了一遍 —— 同一张卡里**所有 ≤F 的时刻都是顺路白捡的**,
 * 多截一张 78ms,而单独开一趟要 4400ms。
 *
 * **这不牺牲「先烘播放头附近」**:批次的先后仍然由调用方按离播放头的距离排,这里只是把
 * 同一张卡的其余时刻捎上。最坏情况是那个最近的时刻在一趟里排在后面几张,晚几十毫秒。
 */
export async function bakeClip(
  root: string,
  origin: string,
  project: any,
  clipId: string,
  times: number[],
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
  priority = 0,
  o: { signal?: AbortSignal; runner?: Runner } = {},
): Promise<any[]> {
  const uniq = [...new Set(times.map(Number).filter(Number.isFinite))];
  if (uniq.length <= 1) {
    return [await bakeOne(root, origin, project, clipId, uniq[0], size, bg, fit, priority, undefined, o)];
  }

  // 哪几个时刻还没落盘。已经有的不进这一趟 —— 它们在 bakeOne 里一次 fs.access 就返回了
  const dir = mediaDir(root);
  const missing: { t: number; at: number }[] = [];
  for (const t of uniq) {
    const tg = bakeTarget(project, clipId, t, size, bg, fit);
    try { await fsp.stat(path.join(dir, tg.name)); } catch { missing.push({ t, at: tg.at }); }
  }
  if (missing.length < 2) {
    return await Promise.all(uniq.map((t) => bakeOne(root, origin, project, clipId, t, size, bg, fit, priority, undefined, o)));
  }

  /*
   * 排版尺寸对同一张卡是固定的(只看 clip 的框),所以一趟里所有时刻共用同一个 target 项目。
   * 时刻不同的只是「渲第几帧」,由 renderFrames 的 target-frames 决定。
   */
  const { target, rgb } = bakeTarget(project, clipId, missing[0].t, size, bg, fit);
  const fps = target.fps || 30;
  // 底色和透明统计在渲染 worker 里一并做掉(和单张那条路同一套 post),交回 bakeOne 的已经是成品
  const post = { bg: rgb ? rgb[1].toLowerCase() : null, stats: true };
  const atList = missing.map((m) => m.at);
  const shots = o.runner
    ? await renderFrames(root, origin, target, atList, [], priority, { signal: o.signal, runner: o.runner, post })
    : await enqueue(() => renderFrames(root, origin, target, atList, [], priority, { signal: o.signal, post }), priority, 0, o.signal);

  // 渲好的按帧号交回 bakeOne,缓存键、落盘、返回值全走那一套
  const byT = new Map<number, FrameResult>();
  for (const m of missing) {
    const f = Math.max(0, Math.round(m.at * fps));
    const r = shots.get(f);
    if (r) byT.set(m.t, r);
  }
  return await Promise.all(uniq.map((t) => bakeOne(root, origin, project, clipId, t, size, bg, fit, priority, byT.get(t), o)));
}
