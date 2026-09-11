/**
 * 配音(voice_generate):云端语音合成,走 API 调 MiniMax / 可灵 / Vidu。API Key 走 ai-config 那一套落盘加密。
 *
 *   GET  /api/voice/config          设置 + 静态数据(服务商、模型、系统音色、情绪、字数上限)
 *   POST /api/voice/config          局部更新设置;带 apiKey 就换 API Key
 *   POST /api/voice/clear-key       删 API Key
 *   POST /api/voice/generate        合成一段,落到素材目录;preview: true 写固定的试听文件
 *   POST /api/voice/custom          往「我的音色」里手填一条
 *   POST /api/voice/custom/remove   从「我的音色」里移除(只删本地记录,服务商那边不动)
 *   POST /api/voice/design          MiniMax 音色设计(新音色首次合成收 ¥9.9)
 *   POST /api/voice/clone           MiniMax 快速复刻,源文件必须已经在素材目录里(同上收费)
 *
 * 真正的逻辑在 server/voice/*.mjs(纯函数,可单测),这里只做路由和落盘。
 */
import type { Plugin, ViteDevServer, Connect } from "vite";
import type { ServerResponse } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { readBody } from "./vite-plugin-stt";
import { mediaDir } from "./vite-plugin-media";
import { isInside } from "./http-guard.mjs";
import { findFfmpeg } from "./ai-visual.mjs";
import {
  readVoiceConfig, writeVoiceConfig, clearVoiceKey, publicVoiceConfig, addCustomVoice, removeCustomVoice,
} from "./voice/voice-config.mjs";
import { generateVoice } from "./voice/generate.mjs";
import { designVoice, cloneVoice, VoiceError } from "./voice/providers.mjs";
import {
  PROVIDERS, PROVIDER_LABELS, MINIMAX_MODELS, EMOTIONS, EMOTION_LABELS, SYSTEM_VOICES, TEXT_LIMITS,
  isVoiceIdShape, isCloneIdShape,
} from "./voice/presets.mjs";

const PRESETS = {
  providers: PROVIDERS, labels: PROVIDER_LABELS, models: MINIMAX_MODELS,
  emotions: EMOTIONS, emotionLabels: EMOTION_LABELS, systemVoices: SYSTEM_VOICES, textLimits: TEXT_LIMITS,
};

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function readJson(req: Connect.IncomingMessage): Promise<Record<string, any>> {
  const buf = await readBody(req);
  if (!buf.length) return {};
  const v = JSON.parse(buf.toString("utf8"));
  return v && typeof v === "object" ? v : {};
}

function fail(res: ServerResponse, e: unknown): void {
  if (e instanceof VoiceError) return sendJson(res, e.status && e.status >= 500 ? 502 : 400, { ok: false, error: e.message });
  if (e instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: "请求体不是合法的 JSON" });
  sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
}

let ffmpegBin: string | null | undefined;

/**
 * 复刻前把源文件整理成 MiniMax 收的样子:单声道 wav、去掉开头静音、音量拉平、最长 5 分钟。
 * 视频也能直接拿来复刻(取它的声音)。返回临时 wav 的路径和秒数。
 */
function prepareCloneAudio(src: string): { file: string; seconds: number } {
  if (ffmpegBin === undefined) ffmpegBin = findFfmpeg();
  if (!ffmpegBin) throw new VoiceError("找不到 ffmpeg，没法把源文件转成复刻要的音频。");
  const out = path.join(os.tmpdir(), `pc-voice-clone-${Date.now()}.wav`);
  const r = spawnSync(ffmpegBin, [
    "-y", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "32000", "-t", "300",
    "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2,loudnorm=I=-18:TP=-1.5:LRA=11",
    "-c:a", "pcm_s16le", out,
  ], { windowsHide: true, timeout: 120_000 });
  if (r.status !== 0 || !fs.existsSync(out)) {
    throw new VoiceError(`源文件转音频失败：${String(r.stderr || "").trim().slice(-300) || "ffmpeg 没有输出"}`);
  }
  // 16 位单声道 32kHz:每秒 64000 字节,减掉 44 字节的 wav 头
  const seconds = Math.max(0, (fs.statSync(out).size - 44) / 64000);
  return { file: out, seconds };
}

export function voicePlugin(): Plugin {
  return {
    name: "vite-plugin-voice",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (!url.startsWith("/api/voice/")) return next();
        const method = (req.method || "GET").toUpperCase();
        try {
          if (method === "GET" && url === "/api/voice/config") {
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(), presets: PRESETS });
          }
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "只接受 POST" });
          const body = await readJson(req);

          if (url === "/api/voice/config") {
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(writeVoiceConfig(body)) });
          }
          if (url === "/api/voice/clear-key") {
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(clearVoiceKey()) });
          }
          if (url === "/api/voice/generate") {
            const out = await generateVoice({
              cfg: readVoiceConfig(),
              args: {
                text: body.text, provider: body.provider, voiceId: body.voiceId,
                speed: body.speed, emotion: body.emotion, name: body.name,
              },
              outDir: mediaDir(root),
              preview: body.preview === true,
            });
            return sendJson(res, 200, { ok: true, ...out });
          }
          if (url === "/api/voice/custom") {
            if (!PROVIDERS.includes(body.provider)) throw new VoiceError(`provider 只能是 ${PROVIDERS.join(" / ")}`);
            if (!isVoiceIdShape(body.voiceId)) throw new VoiceError("音色 id 只能含字母数字和 - _ .");
            const cfg = addCustomVoice({ provider: body.provider, voiceId: body.voiceId, name: body.name, kind: "manual", note: body.note });
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(cfg) });
          }
          if (url === "/api/voice/custom/remove") {
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(removeCustomVoice(body.provider, body.voiceId)) });
          }
          if (url === "/api/voice/design") {
            const cfg = readVoiceConfig();
            const r = await designVoice({ baseUrl: cfg.effectiveBaseUrl, apiKey: cfg.apiKey }, { prompt: body.prompt, previewText: body.previewText });
            let previewUrl = "";
            if (r.trial) {
              const name = `voice-design-${r.voiceId}.mp3`;
              fs.mkdirSync(mediaDir(root), { recursive: true });
              fs.writeFileSync(path.join(mediaDir(root), name), r.trial);
              previewUrl = `/@media/${encodeURIComponent(name)}`;
            }
            const next = addCustomVoice({
              provider: "minimax", voiceId: r.voiceId, name: body.name || "设计的音色", kind: "design",
              note: String(body.prompt || "").slice(0, 200),
            });
            return sendJson(res, 200, { ok: true, voiceId: r.voiceId, previewUrl, config: publicVoiceConfig(next) });
          }
          if (url === "/api/voice/clone") {
            if (body.consent !== true) throw new VoiceError("复刻别人的声音要先得到本人同意；勾选确认后再提交。");
            const src = typeof body.path === "string" ? path.resolve(body.path) : "";
            // 只认素材目录里的文件:这个接口会把文件上传到第三方,不能变成任意文件外发
            if (!src || !isInside(src, mediaDir(root)) || !fs.existsSync(src)) {
              throw new VoiceError("源文件要先上传到素材目录（开始页的复刻表单会自动做）。");
            }
            const voiceId = body.voiceId || `pcVoice${Date.now()}`;
            if (!isCloneIdShape(voiceId)) throw new VoiceError("音色 id 要 8~256 位、字母开头、只含字母数字和 - _。");
            const prepared = prepareCloneAudio(src);
            try {
              if (prepared.seconds < 10) throw new VoiceError(`去掉静音后只有 ${prepared.seconds.toFixed(1)} 秒，复刻至少要 10 秒人声。`);
              const cfg = readVoiceConfig();
              const r = await cloneVoice({ baseUrl: cfg.effectiveBaseUrl, apiKey: cfg.apiKey }, {
                audio: fs.readFileSync(prepared.file), filename: "voice.wav", voiceId, previewText: body.previewText,
              });
              let demoUrl = "";
              if (r.demo) {
                const name = `voice-clone-${voiceId}.mp3`;
                fs.writeFileSync(path.join(mediaDir(root), name), r.demo);
                demoUrl = `/@media/${encodeURIComponent(name)}`;
              }
              const next = addCustomVoice({
                provider: "minimax", voiceId, name: body.name || "复刻的音色", kind: "clone",
                note: `源文件 ${path.basename(src)}，${prepared.seconds.toFixed(1)} 秒`,
              });
              return sendJson(res, 200, { ok: true, voiceId, demoUrl, seconds: prepared.seconds, config: publicVoiceConfig(next) });
            } finally {
              fs.rm(prepared.file, { force: true }, () => {});
            }
          }
          return sendJson(res, 404, { ok: false, error: `没有这个接口：${url}` });
        } catch (e) {
          return fail(res, e);
        }
      });
    },
  };
}
