/**
 * 量一段已经渲染出来的卡片内容的包围盒(舞台坐标)。
 *
 * 卡片没有静态的「我画在哪」:没有 frame 就铺满整个画幅,内容多半只在中间一小块。
 * 预览卡按整个画幅等比缩,1920×1080 塞进 130px 的方块,标题卡里的字就成了一粒芝麻。
 * 所以真的去量:把舞台里**看得见的东西**(文字、图片、svg、canvas、带底色 / 描边的盒子)
 * 的矩形并起来,预览按这个盒子缩放。铺满整个舞台的元素(背景、居中用的外层容器)不算,
 * 否则并出来永远是整幅画面。
 *
 * 文字用 Range 量:一个 block 元素的矩形是整行宽,Range 给的是字本身的框。
 * canvas 扫像素量:DOM 只知道画布多大,不知道里面画了什么。
 */
export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const REPLACED = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "PICTURE"]);
/** canvas 扫像素时每边最多取样多少档;再大就跳着取,几万个点足够定边界 */
const CANVAS_SAMPLES = 200;
/** 透明度低于这个数的像素当没画 */
const ALPHA_MIN = 8;

function hasOwnText(el: Element): boolean {
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) return true;
  }
  return false;
}

function paintsItself(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (cs.backgroundImage !== "none") return true;
  const bg = cs.backgroundColor;
  if (bg && bg !== "transparent" && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(bg)) return true;
  if ((parseFloat(cs.borderTopWidth) || 0) > 0 || (parseFloat(cs.borderLeftWidth) || 0) > 0) return true;
  if (cs.boxShadow && cs.boxShadow !== "none") return true;
  return false;
}

function textRect(el: Element): DOMRect | null {
  const range = document.createRange();
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const n of el.childNodes) {
    if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? "").trim()) continue;
    range.selectNodeContents(n);
    const rc = range.getBoundingClientRect();
    if (rc.width <= 0 || rc.height <= 0) continue;
    l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
  }
  range.detach();
  return r > l && b > t ? new DOMRect(l, t, r - l, b - t) : null;
}

/**
 * canvas 里画了什么,DOM 是看不见的:元素矩形永远是整块画布,于是粒子背景、图表这类卡
 * 一律被判成「铺满整幅」,预览只能退回整幅缩放。这里直接读像素,把真正画到东西的那块框出来。
 *
 * 只对 2D 画布有效:WebGL 的画布取不到 2d 上下文(返回 null),被跨域图片污染过的画布
 * 读像素会抛 —— 两种情况都返回 null,调用方退回元素矩形。返回的是**屏幕坐标**,
 * 和其他几种量法口径一致。
 */
function canvasBox(el: HTMLCanvasElement): DOMRect | null {
  const w = el.width, h = el.height;
  if (!w || !h) return null;
  let data: Uint8ClampedArray;
  try {
    const ctx = el.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const step = Math.max(1, Math.ceil(Math.max(w, h) / CANVAS_SAMPLES));
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (let y = 0; y < h; y += step) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += step) {
      if (data[row + x * 4 + 3] < ALPHA_MIN) continue;
      if (x < l) l = x;
      if (x > r) r = x;
      if (y < t) t = y;
      if (y > b) b = y;
    }
  }
  if (r < l || b < t) return null; // 整块空白
  // 取样是跳着走的,边界各外扩一格免得把内容切掉;再换算到屏幕坐标
  const rect = el.getBoundingClientRect();
  const sx = rect.width / w, sy = rect.height / h;
  const x0 = Math.max(0, l - step), y0 = Math.max(0, t - step);
  const x1 = Math.min(w, r + step), y1 = Math.min(h, b + step);
  return new DOMRect(rect.left + x0 * sx, rect.top + y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
}

/**
 * @param stage  舞台元素(.pc-stage),它的屏幕矩形就是舞台坐标系的原点和比例
 * @returns 舞台坐标下的包围盒;什么都没量到、或者内容本来就铺满舞台时返回 null
 *
 * 比例不从外面传:舞台正在被 transform 过渡的时候,样式里写的目标比例和屏幕上
 * 此刻画出来的比例不是一个数,拿目标比例去除会把坐标算歪。屏幕矩形 / 布局宽度
 * 就是此刻真实的比例,和元素矩形同一瞬间取的,永远对得上。
 */
export function measureContentBox(stage: HTMLElement): Box | null {
  const sr = stage.getBoundingClientRect();
  const scale = stage.offsetWidth > 0 ? sr.width / stage.offsetWidth : 0;
  if (sr.width <= 0 || sr.height <= 0 || scale <= 0) return null;
  const stageArea = sr.width * sr.height;
  let box: Box | null = null;
  const add = (r: DOMRect) => {
    if (r.width <= 0 || r.height <= 0) return;
    // 铺满舞台的算背景,不算内容
    if ((r.width * r.height) / stageArea >= 0.9) return;
    const l = Math.max(0, (r.left - sr.left) / scale);
    const t = Math.max(0, (r.top - sr.top) / scale);
    const rr = Math.min(sr.width / scale, (r.right - sr.left) / scale);
    const bb = Math.min(sr.height / scale, (r.bottom - sr.top) / scale);
    if (rr <= l || bb <= t) return;
    box = box ? { l: Math.min(box.l, l), t: Math.min(box.t, t), r: Math.max(box.r, rr), b: Math.max(box.b, bb) } : { l, t, r: rr, b: bb };
  };
  for (const el of stage.querySelectorAll<HTMLElement>("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    // svg 内部的子元素不用逐个量,整棵 svg 一个框就够
    if (el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName !== "svg") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    if (REPLACED.has(el.tagName.toUpperCase())) {
      // canvas 先扫像素:画布多半铺满整幅,真正画了东西的只是其中一块
      const painted = el.tagName.toUpperCase() === "CANVAS" ? canvasBox(el as HTMLCanvasElement) : null;
      add(painted ?? el.getBoundingClientRect());
      continue;
    }
    if (hasOwnText(el)) {
      const tr = textRect(el);
      if (tr) add(tr);
    }
    if (paintsItself(el)) add(el.getBoundingClientRect());
  }
  if (!box) return null;
  const b: Box = box;
  const stageW = sr.width / scale;
  const stageH = sr.height / scale;
  // 并出来还是几乎整幅画面,那就按整幅来,不用切
  if (((b.r - b.l) * (b.b - b.t)) / (stageW * stageH) >= 0.85) return null;
  return b;
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) };
}

/**
 * 把舞台里的动画从头拨到尾,每一档量一次包围盒取并集 —— 动效整段占过的最大范围。
 *
 * 用 Web Animations 的 currentTime 同步拨,不靠 requestAnimationFrame:窗口在后台、
 * 动画被浏览器节流时照样量得出来,而且一次调用就出结果,不用真等它播完。拨不动的部分
 * (跟 t 走的 Lottie、打字机)按当前这一帧算。量完把动画拨回 0。
 */
export function measureAcrossTime(stage: HTMLElement, totalMs: number, stepMs = 100): Box | null {
  const anims = stage.getAnimations({ subtree: true });
  const seek = (t: number) => {
    for (const a of anims) {
      try {
        a.pause();
        a.currentTime = t;
      } catch {
        // 已经结束 / 只读的动画不让改,跳过
      }
    }
  };
  let union: Box | null = null;
  for (let t = 0; t <= totalMs; t += stepMs) {
    seek(t);
    union = unionBox(union, measureContentBox(stage));
  }
  seek(0);
  return union;
}
