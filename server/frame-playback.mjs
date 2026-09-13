/** Deadline planning is independent of Chrome and of the client clock. Costs
 * are wall milliseconds; rate is timeline seconds per wall second. */
export function planPlaybackBatch({ frame, fps, rate = 1, count, workers = 3, firstMs = 500, frameMs = 60, jitterMs = 0, deliveryMs = 250, ready = () => false, reserved = new Set() }) {
  let batchSize = 6, stride, lead;
  for (; batchSize >= 1; batchSize--) {
    stride = Math.max(1, Math.ceil((frameMs + firstMs / batchSize) * fps * rate / (1000 * workers * 0.8)));
    const debtMs = (batchSize - 1) * Math.max(0, frameMs - stride * 1000 / (fps * rate));
    lead = Math.ceil((firstMs + debtMs + jitterMs + deliveryMs) * fps * rate / 1000);
    // Near the end, do not reserve debt for screenshots outside the timeline.
    if (batchSize === 1 || Math.ceil((frame + lead) / stride) * stride + (batchSize - 1) * stride < count) break;
  }
  const start = Math.max(0, Math.ceil(frame + lead));
  const end = Math.min(count - 1, start + Math.max(batchSize * stride * workers, Math.ceil(fps * rate * 3)));
  const frames = [];
  // Contiguous blocks minimize duplicate simulation history. Forecast the
  // whole batch's deadline debt: aggregate worker throughput alone would let
  // the later screenshots in this block miss their presentation time.
  for (let n = Math.ceil(start / stride) * stride; n <= end && frames.length < batchSize; n += stride) {
    // Warm-cache holes must not turn six captures into a huge history replay.
    if (frames.length && n - frames[0] > (batchSize - 1) * stride) break;
    if (!ready(n) && !reserved.has(n)) frames.push(n);
  }
  // Do not pay page-reset/history cost for each newly exposed far-edge frame.
  // Wait for a batch there; nearby holes and the tail still run immediately.
  if (frames.length < batchSize && frames[0] > start + fps * rate / 2 && end < count - 1) frames.length = 0;
  return { frames, stride, lead, end };
}

export class FramePlayback {
  constructor({ entry, movie, render, cached, stop, clock = () => performance.now(), wallClock = () => Date.now(), workers = 3 }) {
    Object.assign(this, { entry, movie, render, cached, stop, clock, wallClock, workers });
    this.fps = entry.project.fps || 30;
    this.count = Math.max(1, Math.floor(entry.project.duration * this.fps));
    this.firstMs = 1000; this.frameMs = 150; this.jitterMs = 100;
    this.deliveryMs = 250;
    this.reserved = new Set(); this.jobs = new Set(); this.checked = new Map();
    this.incomplete = new Map();
    this.sequence = -1; this.epoch = 0; this.playing = false;
    this.rendered = 0; this.cacheHits = 0; this.error = null;
  }
  position(now = this.clock()) {
    return Math.min(this.count - 1, Math.max(0, this.frame + (this.playing ? (now - this.at) * this.rate * this.fps / 1000 : 0)));
  }
  update({ sequence, t, playing, rate = 1, deliveryMs = 250, sentAt }) {
    if (sequence <= this.sequence) return false;
    // The desktop client and service share the host's wall clock. A heartbeat
    // reports t at send time, not at the end of HTTP/event-loop queuing.
    const age = playing && Number.isFinite(sentAt) ? Math.min(5000, Math.max(0, this.wallClock() - sentAt)) : 0;
    const now = this.clock(), frame = Math.min(this.count - 1, Math.max(0, (t + age * rate / 1000) * this.fps));
    const changed = this.at === undefined || playing !== this.playing || Math.abs(frame - this.position(now)) > Math.max(3, this.fps * 0.25) || Math.abs(rate - this.rate) > 0.05;
    if (changed) this.cancel();
    this.sequence = sequence; this.frame = frame; this.at = now; this.rate = rate; this.playing = playing;
    this.deliveryMs = deliveryMs;
    this.expires = now + 5000;
    if (changed) { this.checked.clear(); this.error = null; }
    if (playing && !this.timer) {
      this.timer = setInterval(() => { void this.pump(); }, 40);
      this.timer.unref?.();
    }
    return true;
  }
  cancel() {
    this.epoch++;
    clearInterval(this.timer); this.timer = null;
    for (const job of this.jobs) job.controller.abort();
    this.reserved.clear();
  }
  setWorkers(count) {
    this.workers = count;
    const jobs = [...this.jobs].sort((a, b) => b.frames[0] - a.frames[0]);
    for (const job of jobs.slice(0, Math.max(0, jobs.length - count))) job.controller.abort();
  }
  async pump() {
    if (this.pumping || !this.playing) return;
    if (this.clock() >= this.expires) { this.playing = false; this.cancel(); await this.stop(); return; }
    if (this.preparing) return;
    this.pumping = true;
    const epoch = this.epoch;
    try {
      const current = Math.floor(this.position());
      // Hydrate the entire near window, including deadlines too close for a
      // live render. A warm movie must play immediately, with zero Chromes.
      const forecast = planPlaybackBatch({ frame: current, fps: this.fps, rate: this.rate, count: this.count, workers: this.workers,
        firstMs: this.firstMs, frameMs: this.frameMs, jitterMs: this.jitterMs, deliveryMs: this.deliveryMs });
      const end = Math.min(this.count - 1, Math.max(forecast.end, current + Math.ceil(this.fps * this.rate * 3)));
      for (let n = current; n <= end; n++) {
        if (epoch !== this.epoch || !this.playing) return;
        if (this.movie.has(n) || this.clock() - (this.checked.get(n) ?? -Infinity) < 1000) continue;
        this.checked.set(n, this.clock());
        const buffer = await this.cached(n);
        if (buffer && epoch === this.epoch) { await this.movie.put(n, buffer); this.cacheHits++; }
      }
      for (const n of this.checked.keys()) if (n < current || n > end) this.checked.delete(n);
      while (epoch === this.epoch && this.playing && this.jobs.size < this.workers) {
        const plan = planPlaybackBatch({ frame: this.position(), fps: this.fps, rate: this.rate, count: this.count, workers: this.workers,
          firstMs: this.firstMs, frameMs: this.frameMs, jitterMs: this.jitterMs, deliveryMs: this.deliveryMs,
          ready: n => this.movie.has(n) || this.clock() - (this.incomplete.get(n)?.at ?? -Infinity) < 1000, reserved: this.reserved });
        this.stride = plan.stride; this.lead = plan.lead;
        if (!plan.frames.length) break;
        const job = { controller: new AbortController(), frames: plan.frames };
        plan.frames.forEach(n => this.reserved.add(n)); this.jobs.add(job);
        void this.run(job, epoch);
      }
    } catch (error) { if (epoch === this.epoch) this.error = String(error.message || error); }
    finally { this.pumping = false; }
  }
  async run(job, epoch) {
    const started = this.clock();
    let lastLive, live = 0;
    try {
      await this.render(job.frames.map(n => n / this.fps), { lane: 'playback', signal: job.controller.signal,
        onFrame: async (frame, value) => {
          if (epoch !== this.epoch || job.controller.signal.aborted) return;
          const now = this.clock();
          if (value.incomplete) {
            this.incomplete.set(frame, { at: now, missing: value.missing || [] });
            return; // A placeholder must never become a published MOV sample.
          }
          this.incomplete.delete(frame);
          if (value.source === 'live' || value.source === 'html') {
            const cost = now - (lastLive ?? started);
            if (lastLive === undefined) {
              this.jitterMs = this.jitterMs * 0.8 + Math.abs(cost - this.firstMs) * 0.2;
              this.firstMs = Math.max(cost, this.firstMs * 0.9 + cost * 0.1);
            } else this.frameMs = Math.max(cost, this.frameMs * 0.9 + cost * 0.1);
            lastLive = now; live++; this.rendered++;
          } else this.cacheHits++;
          await this.movie.put(frame, value.buf);
          // If the measured cost makes the rest of this batch obsolete, yield
          // after a completed screenshot. This preserves the healthy Chrome
          // and lets the next reservation use the updated sampling interval.
          const next = job.frames.find(n => n > frame);
          if (next !== undefined && next < this.position() + (this.frameMs + this.deliveryMs) * this.fps * this.rate / 1000) {
            throw Object.assign(new Error('Playback deadlines changed'), { replan: true });
          }
        },
      });
      if (epoch === this.epoch) this.error = null;
    } catch (error) {
      if (epoch === this.epoch && !job.controller.signal.aborted && !error.replan) {
        this.error = String(error.message || error);
        // Include stalls in the forecast; otherwise a cold Chrome repeatedly
        // times out while aiming at the same already-passed deadlines.
        if (!live) this.firstMs = Math.min(8000, Math.max(this.firstMs * 1.5, this.clock() - started));
      }
    } finally {
      this.jobs.delete(job);
      if (epoch === this.epoch) job.frames.forEach(n => this.reserved.delete(n));
    }
  }
  status() {
    const frame = Math.floor(this.position());
    for (const n of this.incomplete.keys()) if (n < frame - this.fps || this.movie.has(n)) this.incomplete.delete(n);
    const nearby = [...this.incomplete.keys()].filter(n => n <= frame && frame - n < this.fps).sort((a, b) => b - a)[0];
    const preview = nearby === undefined ? null : { frame: nearby, missing: this.incomplete.get(nearby).missing,
      url: `/api/frames/${this.entry.key}/preview-frames/${String(nearby).padStart(6, '0')}.png` };
    return { epoch: this.epoch, sequence: this.sequence, playing: this.playing,
      preview, incomplete: !!preview,
      ...this.movie.index(frame - Math.min(this.stride || 1, this.fps), frame + Math.ceil(this.fps * this.rate * 3)),
      metrics: { firstMs: this.firstMs, frameMs: this.frameMs, deliveryMs: this.deliveryMs, lead: this.lead || 0, stride: this.stride || 1,
        workers: this.workers, inFlight: this.jobs.size, rendered: this.rendered, cacheHits: this.cacheHits }, error: this.error };
  }
}
