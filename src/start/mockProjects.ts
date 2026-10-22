/**
 * 开始页的假数据。**只给 UI 用**,等业务层接上就整个删掉。
 *
 * 待办(业务层):
 * - 项目列表改查云端文档服务(`src/account/useAccountProjects.ts` 的 `lists`,语义 `product/document-service.md`
 *   「云端文档服务是云端项目存在状态、创建者、成员、禁入及项目状态的权威记录方」);
 * - 文件夹现在语义里还没有,要新增一条二级语义(用户看得见的新能力),按 `guide_files/suggested_agent_behavior.md`
 *   的「对齐」先 dry run 给用户过目,再决定文件夹是记在文档服务还是只记在账号那边;
 * - 缩略图现在是按 id 哈希出来的色块,真图要等预渲染给首帧快照(`product/rendering.md`)。
 */

export interface MockFolder {
  id: string;
  name: string;
}

export interface MockProject {
  id: string;
  name: string;
  /** 时长(秒),缩略图右下角的小标 */
  duration: number;
  /** 最后改动时间(ISO),列表按它从新到旧排 */
  updatedAt: string;
  /** 所属文件夹;null 是没放进文件夹的 */
  folderId: string | null;
  /** 画幅:缩略图按它定长宽比 */
  ratio: "16:9" | "9:16" | "1:1";
}

export const MOCK_FOLDERS: MockFolder[] = [
  { id: "f-brand", name: "品牌短片" },
  { id: "f-course", name: "课程切片" },
  { id: "f-draft", name: "试验田" },
];

/** 从新到旧;`updatedAt` 写死成固定时刻,免得每次打开页面顺序都在变 */
export const MOCK_PROJECTS: MockProject[] = [
  { id: "p-01", name: "夏季上新 15 秒", duration: 15, updatedAt: "2026-10-22T18:10:00+09:00", folderId: "f-brand", ratio: "9:16" },
  { id: "p-02", name: "开箱测评 · 第三期", duration: 184, updatedAt: "2026-10-22T11:42:00+09:00", folderId: "f-course", ratio: "16:9" },
  { id: "p-03", name: "店铺主页循环片", duration: 8, updatedAt: "2026-10-21T20:05:00+09:00", folderId: "f-brand", ratio: "1:1" },
  { id: "p-04", name: "第 2 讲 · 卡片是什么", duration: 362, updatedAt: "2026-10-21T09:30:00+09:00", folderId: "f-course", ratio: "16:9" },
  { id: "p-05", name: "转场手感试验", duration: 22, updatedAt: "2026-10-20T22:18:00+09:00", folderId: "f-draft", ratio: "16:9" },
  { id: "p-06", name: "活动倒计时", duration: 6, updatedAt: "2026-10-20T15:00:00+09:00", folderId: null, ratio: "9:16" },
  { id: "p-07", name: "访谈 · 长版", duration: 1260, updatedAt: "2026-10-19T19:44:00+09:00", folderId: "f-course", ratio: "16:9" },
  { id: "p-08", name: "字幕样式对照", duration: 41, updatedAt: "2026-10-19T13:12:00+09:00", folderId: "f-draft", ratio: "16:9" },
  { id: "p-09", name: "新品特写 A", duration: 12, updatedAt: "2026-10-18T21:30:00+09:00", folderId: "f-brand", ratio: "1:1" },
  { id: "p-10", name: "新品特写 B", duration: 12, updatedAt: "2026-10-18T21:26:00+09:00", folderId: "f-brand", ratio: "1:1" },
  { id: "p-11", name: "未命名", duration: 0, updatedAt: "2026-10-18T08:02:00+09:00", folderId: null, ratio: "16:9" },
  { id: "p-12", name: "音乐卡点练习", duration: 29, updatedAt: "2026-10-17T23:55:00+09:00", folderId: "f-draft", ratio: "9:16" },
  { id: "p-13", name: "年会开场", duration: 95, updatedAt: "2026-10-17T16:20:00+09:00", folderId: null, ratio: "16:9" },
  { id: "p-14", name: "产品说明 · 日语版", duration: 148, updatedAt: "2026-10-16T12:00:00+09:00", folderId: "f-course", ratio: "16:9" },
];

/** 时长写成 mm:ss;超过一小时写 h:mm:ss。0 秒的是还没剪过的空项目 */
export function humanDuration(sec: number): string {
  if (sec <= 0) return "空项目";
  const s = Math.round(sec);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 列表上的时间:今天只写时分,今年写月日,再早写年月日 */
export function humanWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
