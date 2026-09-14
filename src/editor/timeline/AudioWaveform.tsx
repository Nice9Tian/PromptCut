import { useEffect, useState } from "react";
import type { MediaAsset, TrackClip } from "../../kernel/project";

type Wave = { peaks: number[]; duration: number };
// Share decoding across all cuts of a source, keeping only compact peaks.
const cache = new Map<string, Promise<Wave | null>>();
export function loadWave(url: string): Promise<Wave | null> {
  const existing = cache.get(url);
  if (existing) return existing;
  const pending = (async () => {
    let context: AudioContext | undefined;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.arrayBuffer();
      context = new AudioContext();
      const buffer = await context.decodeAudioData(data);
      const count = Math.min(20000, Math.ceil(buffer.duration * 40));
      const peaks = new Array<number>(count).fill(0);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const samples = buffer.getChannelData(ch);
        for (let i = 0; i < count; i++) {
          const end = Math.floor((i + 1) * samples.length / count);
          for (let j = Math.floor(i * samples.length / count); j < end; j++) {
            peaks[i] = Math.max(peaks[i], Math.abs(samples[j]));
          }
        }
      }
      return { peaks, duration: buffer.duration };
    } catch {
      return null;
    } finally {
      await context?.close();
    }
  })();
  cache.set(url, pending);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return pending;
}

export function AudioWaveform({ media, clip, width }: { media: MediaAsset; clip: TrackClip; width: number }) {
  const [wave, setWave] = useState<Wave | null>(null);
  useEffect(() => {
    let active = true;
    setWave(null);
    void loadWave(media.url).then((result) => { if (active) setWave(result); });
    return () => { active = false; };
  }, [media.url]);
  if (!wave) return null;
  const count = Math.max(1, Math.min(1500, Math.ceil(width / 3)));
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const from = (clip.mediaOffset ?? 0) + i / count * (clip.end - clip.start);
    const to = (clip.mediaOffset ?? 0) + (i + 1) / count * (clip.end - clip.start);
    let peak = 0;
    for (let j = Math.max(0, Math.floor(from / wave.duration * wave.peaks.length)); j < Math.min(wave.peaks.length, Math.ceil(to / wave.duration * wave.peaks.length)); j++) peak = Math.max(peak, wave.peaks[j]);
    const h = Math.max(0.3, peak * 9);
    paths.push(`M${(i + 0.5) / count * 1000},${10 - h}v${h * 2}`);
  }
  return <svg className="pc-audio-waveform" viewBox="0 0 1000 20" preserveAspectRatio="none" aria-label="音频波形"><path d={paths.join(" ")} stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" /></svg>;
}
