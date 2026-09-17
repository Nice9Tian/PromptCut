/** Real Python-card audio -> browser OfflineAudioContext -> mix.wav acceptance.
 * Uses Vite's production prerender plugin set and mixAudioInChrome; no mock audio or
 * direct tool dispatch. Evidence is retained in work/card-audio. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { mixAudioInChrome } from "./export-frames.mjs";

process.env.PROMPTCUT_ROLE = "prerender";
const root = process.cwd(), out = path.join(root, "work", "card-audio"), id = "card-audio-verify", port = 5202;
process.env.PROMPTCUT_EXPORT_DIR = out;
await fs.mkdir(path.join(out, `export-${id}`), { recursive: true });
const project = {
  id: "card-audio-verify", name: "card audio verify", width: 64, height: 64, fps: 10, duration: 1, themeId: "default", media: [], style: {},
  cardDefinitions: [{ id: "tone", language: "python", entry: "Tone", kind: "audio", need_prerendering: false, compositing: "independent", source: `import numpy as np
class Tone:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time): return AudioBlock(np.tile([.25,.75], (time.count, 1)).astype(np.float32), time.sample_rate, time.start)` }],
  cardNodes: [{ id: "tone-node", adapter: "python", definitionId: "tone", inputs: {} }],
  tracks: [{ id: "audio", name: "audio", clips: [{ id: "tone-clip", cardId: "tone", nodeId: "tone-node", start: 0, end: 1, params: {} }] }],
};
await fs.writeFile(path.join(out, `export-${id}`, "project.json"), JSON.stringify(project));
const server = await createServer({ configFile: path.join(root, "vite.prerender.config.ts"), server: { host: "127.0.0.1", port, strictPort: true, hmr: false, watch: null } });
try {
  await server.listen();
  const pageUrl = `http://127.0.0.1:${port}/?export=1&timeline=/@export/${id}/project.json`;
  const result = await mixAudioInChrome({ ffmpegCmd: "ffmpeg", outDir: path.join(out, `export-${id}`), project, pageUrl, durationSec: 1,
    plan: [{ cardAudio: true, nodeId: "tone-node", clipId: "tone-clip", start: 0, dur: 1, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0, fx: null }] });
  const wav = await fs.readFile(result.mixWav), header = wav.subarray(0, 44);
  assert.equal(header.toString("ascii", 0, 4), "RIFF"); assert.equal(header.toString("ascii", 8, 12), "WAVE");
  assert.equal(header.readUInt16LE(22), 2); assert.equal(header.readUInt32LE(24), 48000);
  assert.equal((wav.length - 44) / 8, 48000, "browser mix must retain exactly one second of stereo frames");
  assert.ok(Math.abs(wav.readFloatLE(44) - .25) < 1e-6); assert.ok(Math.abs(wav.readFloatLE(48) - .75) < 1e-6);
  await fs.writeFile(path.join(out, "evidence.json"), JSON.stringify({ id, result: { clips: result.clips, mixWav: path.basename(result.mixWav) }, wav: { bytes: wav.length, channels: 2, sampleRate: 48000, frames: 48000, first: [wav.readFloatLE(44), wav.readFloatLE(48)] } }, null, 2));
  console.log("PASS Python card audio Chrome mix", path.join(out, "evidence.json"));
} finally { await server.close(); }
