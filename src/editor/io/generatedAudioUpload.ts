/** Shared sound/AV WAV ingest. Bytes go through the ordinary asset-service media protocol. */
import { getState } from "../../store/project";
import { createSnapUploader, sha256Hex } from "../../online/snapUploader";
import { docRequest, hasDocLink, remoteAssetBase } from "../media/assetTiers";
import { onlinePage } from "../../online/pageFlag";

function generatedAudioService(signal: AbortSignal) {
  const projectId = getState().project.id;
  const remoteBase = remoteAssetBase();
  const base = remoteBase ?? (onlinePage() ? null : "/api/asset");
  if (!base) throw new Error("尚未连接素材服务,请连接项目后重试");
  if (hasDocLink() && !remoteBase) throw new Error("共享项目素材服务尚未就绪,请稍后重试");
  const stillCurrent = () => {
    signal.throwIfAborted();
    if (getState().project.id !== projectId || remoteAssetBase() !== remoteBase) throw new Error("素材服务或项目已切换,取消上传");
  };
  const uploader = createSnapUploader({
    base: () => base,
    ticket: async () => {
      stillCurrent();
      if (!remoteBase) return null;
      const response = await docRequest({ type: "auth.ticket", kind: "asset", access: "rw" });
      stillCurrent();
      if (response.type !== "auth.ticket.ok" || typeof response.ticket !== "string") throw new Error("无法取得素材写入票据");
      return response.ticket;
    },
    fetch: (url, init) => { stillCurrent(); return fetch(url, { ...init, signal }); },
  });
  return { uploader, stillCurrent };
}

/** 缓存复用也必须核对当前素材服务字节，不只相信项目内的旧引用。 */
export async function hasGeneratedAudio(hash: string, signal: AbortSignal): Promise<boolean> {
  const { uploader, stillCurrent } = generatedAudioService(signal);
  const exists = await uploader.has("media", hash);
  stillCurrent();
  return exists;
}

export async function uploadGeneratedAudio(wav: Uint8Array, signal: AbortSignal): Promise<{ hash: string; bytes: number }> {
  const { uploader, stillCurrent } = generatedAudioService(signal);
  const hash = await sha256Hex(wav);
  stillCurrent();
  await uploader.put("media", hash, wav, "wav");
  stillCurrent();
  return { hash, bytes: wav.byteLength };
}
