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
 */
export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const REPLACED = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "PICTURE"]);

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
      add(el.getBoundingClientRect());
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
