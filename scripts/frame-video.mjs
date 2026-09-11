import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { shrink } from '../server/png-post.mjs';

/** PNG pipe with backpressure; a video is published only after ffmpeg exits successfully. */
export function frameVideo(ffmpeg, file, fps) {
  const process = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
  { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '', error;
  process.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  process.stdin.on('error', e => { error = e; });
  const done = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve() : reject(error || new Error(`ffmpeg ${code}: ${stderr}`)));
  });
  done.catch(() => {});
  return {
    async write(buffer) {
      if (error) throw error;
      // H.264 has no alpha. Use the same transparency checker as Agent images, at native resolution.
      const png = PNG.sync.read(buffer);
      const opaque = PNG.sync.write(shrink(png, Math.max(png.width, png.height)).png);
      await new Promise((resolve, reject) => process.stdin.write(opaque, e => e ? reject(e) : resolve()));
    },
    async finish() { process.stdin.end(); await done; },
    async abort() { process.kill(); await done.catch(() => {}); },
  };
}
