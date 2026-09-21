import { newId, type MediaAsset, type Transcript, type Shots, type Subjects } from "../../kernel/project";
import { stripMediaFromCuts } from "../../kernel/cuts";

import { state, setProject } from "../core";

export const media = {
  addMedia(asset: Omit<MediaAsset, "id"> & { id?: string }): MediaAsset {
    const m: MediaAsset = { ...asset, id: asset.id ?? newId("m") };
    setProject({ ...state.project, media: [...state.project.media, m] }, { undoable: false });
    return m;
  },
  /** 写入 / 清除素材的语音转文字结果(不进撤销栈) */
  setMediaShots(mediaId: string, shots: Shots | null) {
    const p = state.project;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, shots: shots ?? undefined } : m)) },
      { undoable: false },
    );
  },
  /** 写入 / 清除素材的主体检测结果(不进撤销栈,和镜头识别同一个道理) */
  setMediaSubjects(mediaId: string, subjects: Subjects | null) {
    const p = state.project;
    // 素材可能在检测跑完之前就被删了。不查一下的话 map 空转一圈、
    // setProject 白发一次通知,还会把「素材已经不在了」这件事藏起来。
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, subjects: subjects ?? undefined } : m)) },
      { undoable: false },
    );
  },
  setMediaTranscript(mediaId: string, transcript: Transcript | null) {
    const p = state.project;
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, transcript: transcript ?? undefined } : m)) },
      { undoable: false },
    );
  },
  setMediaPath(mediaId: string, path: string) {
    const p = state.project;
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, path } : m)) },
      { undoable: false },
    );
  },
  removeMedia(mediaId: string) {
    const p = state.project;
    // 素材是项目级的:激活剪辑和停放剪辑里引用它的段都要清,不然切过去会出现指向已删素材的段
    setProject(stripMediaFromCuts({
      ...p,
      media: p.media.filter((m) => m.id !== mediaId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.mediaId !== mediaId) })),
    }, mediaId));
  },
};
