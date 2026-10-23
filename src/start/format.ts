/** 开始页上的几种写法:时长、时间。原来放在 `mockProjects.ts` 里,假数据删掉后挪到这里 */

/** 时长写成 mm:ss;超过一小时写 h:mm:ss。0 秒是还没剪过的空项目;不知道(没在这台浏览器里打开过)给空串 */
export function humanDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "";
  if (sec <= 0) return "空项目";
  const s = Math.round(sec);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 列表上的时间:今天只写时分,今年写月日,再早写年月日 */
export function humanWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 项目的宽高换成三种画幅之一(差不多的归到最近的那一种) */
export function ratioOf(width: number, height: number): "16:9" | "9:16" | "1:1" | null {
  if (!(width > 0) || !(height > 0)) return null;
  const r = width / height;
  if (r > 1.2) return "16:9";
  if (r < 0.83) return "9:16";
  return "1:1";
}

/** 三种画幅的项目尺寸:新建时按开始页上点的那一颗定 */
export const RATIO_SIZE = { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 } } as const;

/** 开始页「说一句话」建出来的项目叫什么:取这句话的头一截,去掉换行;空的叫「未命名」 */
export function projectNameFromPrompt(text: string, max = 24): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "未命名";
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : line;
}
