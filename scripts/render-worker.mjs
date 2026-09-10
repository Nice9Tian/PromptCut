import { openBakery, bakeFrames } from './export-frames.mjs';

/**
 * 常驻渲染 worker:**一个进程守着一个 Chrome,一趟一趟接活**。
 *
 * # 为什么要有它
 *
 * 以前每烘一次就 spawn 一个 node、起一个 Chrome、goto 一次导出页,这笔钱是**固定的**:
 * 实测 `--frames 0-0`(起进程 + 起 Chrome + 加载页面 + 推第 0 帧 + 截 1 张)4211ms,
 * 其中推帧和截图加起来只占约 100ms。也就是说用户在 3D 视图里拖到一个新位置、
 * 板子还是色块的那几秒里,**四秒是在等一个浏览器开机**。
 *
 * 而 export-frames 早就把「烘焙间」拆出来了(openBakery / bakery.reset / bakeFrames),
 * 并且验过复用的确定性:新开一个 page 是一个全新的 renderer,从没被启用过虚拟时间,
 * 和全新起一个浏览器等价 —— 见 openBakery 和 reset 的注释。这里只是把那套东西
 * 放进一个不退出的进程里。
 *
 * # 为什么用 IPC 而不是 stdin/stdout
 *
 * 烘焙过程本身往 stdout 写 `PAGE LOG:` 和进度,出错时父进程要拿最后几行当错误信息。
 * 再往同一条管子里塞协议消息,两边都得先猜「这一行是日志还是消息」。走 `process.send`
 * 是另一条通道,互不干扰。
 *
 * # 三条自保规矩
 *
 * 1. **出过错的 bakery 一律丢掉。** 烘焙中途失败时页面的虚拟时间可能停在 pause,
 *    也可能挂着没排空的任务 —— 下一趟在这样的页面上接着烘,烘出来的东西不可信,
 *    而且**不报错**。所以宁可多付一次 3 秒的重开。
 * 2. **烘够 MAX_JOBS 趟主动重开。** Chrome 长时间跑会慢慢涨内存(每趟一个新 renderer,
 *    旧的关掉但浏览器进程自己的堆不回落)。这台机器上多开 Chrome 踩过 0xC0000142,
 *    宁可定期换一个新的。
 * 3. **闲够 IDLE_EXIT_MS 就自己退。** 一个 worker 约 300~500MB,预烘一停就是纯占着。
 *    退掉之后父进程下次要活时重新拉起来 —— 那时候用户已经在等了,但只等一次。
 */

/** 烘几趟就换一个新浏览器 */
const MAX_JOBS = Number(process.env.PROMPTCUT_WORKER_MAX_JOBS) || 40;
/**
 * 闲多久就自己退出(毫秒)。
 *
 * **传 0 = 永不退出**,留给前台专用的那个常驻 worker(见父进程的 takeForeground):
 * 它存在的全部意义就是「用户随时松手,都有一个热的 Chrome 立刻接住」,
 * 闲三分钟就退掉的话,用户去改了会儿参数再回来拖时间轴,又要等一次开机。
 */
const rawIdle = process.env.PROMPTCUT_WORKER_IDLE_MS;
const IDLE_EXIT_MS = rawIdle === undefined || rawIdle === "" ? 180000 : Number(rawIdle);

let bakery = null;
/** 这个 bakery 已经烘过几趟 */
let jobsDone = 0;
let idleTimer = null;

function armIdleExit() {
  clearTimeout(idleTimer);
  if (!(IDLE_EXIT_MS > 0)) return; // 0 / 非法 = 常驻,见上面
  idleTimer = setTimeout(async () => {
    try { await bakery?.close(); } catch { /* 关不掉也要退,别把进程留在这儿 */ }
    process.exit(0);
  }, IDLE_EXIT_MS);
  // 定时器不该把进程钉住:父进程 disconnect 之后我们要能自然退出
  idleTimer.unref?.();
}

/** 丢掉当前 bakery(出错或到期)。关不掉不算失败 —— 进程退出时系统会收 */
async function dropBakery() {
  const old = bakery;
  bakery = null;
  jobsDone = 0;
  try { await old?.close(); } catch { /* ignore */ }
}

/**
 * 备好一个停在 `url` 上的 bakery。
 *
 * 三种情形:没有 → 开一个(openBakery 自己会 goto);有但停在别的地址 → reset 换一个新 page;
 * 有且就停在这个地址 → **仍然要 reset**。最后这条容易被当成可以省掉的一步,不能省:
 * 上一趟烘完页面已经被推到了片尾、动画锚点全都建好了,原地再烘一趟拿到的不是第 0 帧的画面。
 */
async function bakeryFor(url) {
  if (!bakery) {
    bakery = await openBakery({ url });
    return bakery;
  }
  await bakery.reset(null, url);
  return bakery;
}

async function runJob(opts) {
  if (jobsDone >= MAX_JOBS) await dropBakery();
  const b = await bakeryFor(opts.url);
  try {
    const baked = await bakeFrames(b, opts);
    jobsDone++;
    return baked;
  } catch (e) {
    // 见「三条自保规矩」第 1 条:这个页面已经不可信了
    await dropBakery();
    throw e;
  }
}

/** 一次只干一活:并行由父进程那边的池子决定,一个 worker 一个 Chrome 一趟活 */
let chain = Promise.resolve();

process.on('message', (msg) => {
  /*
   * **预热**:现在就起 Chrome、加载好导出页,别等第一个活来了才开机。
   *
   * 给前台那个常驻 worker 用。用户拖时间轴松手的那一刻才派活,如果那时候 Chrome 还没起,
   * 他要多等约 1.3 秒 —— 而这 1.3 秒完全可以在他还在拖的时候就付掉。
   * 预热用的地址随便给一个导出页就行:真正的活来了会 reset 到它自己的项目地址上。
   */
  if (msg && msg.type === 'prewarm') {
    chain = chain.then(() => bakeryFor(msg.url).then(() => {}, () => {}));
    return;
  }
  if (!msg || msg.type !== 'bake') return;
  clearTimeout(idleTimer);
  chain = chain.then(async () => {
    /*
     * 先回一声「接住了」。父进程靠它区分两种失败:活儿开跑之后崩的(不能重发,可能已经写了文件),
     * 和**根本没开跑**的 —— 后者只有一种成因:派活的那一刻这个 worker 正好闲置超时自己退了。
     * 那种情况父进程换一个新 worker 重来一次,用户看不见任何异常(见 runExport 的重试)。
     */
    process.send?.({ type: 'started', id: msg.id });
    try {
      const result = await runJob(msg.opts || {});
      process.send?.({ type: 'done', id: msg.id, result });
    } catch (e) {
      process.send?.({ type: 'error', id: msg.id, message: e?.message || String(e) });
    } finally {
      armIdleExit();
    }
  });
});

// 父进程没了就别留着一个 Chrome 在后台烧内存
process.on('disconnect', async () => {
  try { await bakery?.close(); } catch { /* ignore */ }
  process.exit(0);
});

armIdleExit();
process.send?.({ type: 'ready' });
