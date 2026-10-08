import { createHash } from 'node:crypto';
import { budgetOf, clipWeight } from '../../src/render/pipelinePlan.mjs';

/** Ordinary project-owned card source. Every computed cell affects the image;
 * no real-clock escape, export-mode shortcut or authored rendering capability.
 * This is a workload candidate, not evidence of browser measurement. */
export function heavyUserCardSource(id) {
  if (!/^c10-cpu-field-[a-z0-9-]{1,80}$/.test(id)) throw new Error('invalid fixture card id');
  return `import { useMemo } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
function CpuField({ params, t }: CardProps<{ seed: number }>) {
  const cells = useMemo(() => Array.from({ length: 128 }, (_, cell) => {
    let x = (cell + 1) * 0.013 + params.seed * 0.001 + t * 0.1;
    for (let i = 0; i < 32768; i++) x = Math.sin(x * 1.97 + i * 0.00001) + Math.cos(x * 0.71 + cell);
    return Math.round((x + 2) * 90);
  }), [params.seed, t]);
  return <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "repeat(16, 1fr)", background: "#101828" }}>
    <style>{"@keyframes ${id} { from { opacity: 0.7; } to { opacity: 1; } }"}</style>
    {cells.map((hue, cell) => <div key={cell} style={{ background: "hsl(" + hue + " 70% 55%)", animation: "${id} 1s linear infinite alternate" }} />)}
  </div>;
}
export const cpuField: CardDef<{ seed: number }> = {
  id: "${id}", name: "递归纹理", source: "user", frameMode: "stateful",
  description: "逐时刻计算递归纹理，CSS 动画调节透明度。",
  defaults: { seed: 1 }, controls: [{ key: "seed", type: "number", label: "纹理种子" }], Component: CpuField,
};
`;
}

/** A prerequisite, never completion evidence. Costs must come from the page's
 * finished probe/L2 record; canvasHeavy only governs splitting AFTER selection.
 * Online l2CostBackend uses the normal default tuning, as does clipWeight here. */
export function hostFixtureReadiness({ fixture, fps, job, probe, record, publisher, pipeline }) {
  const reasons = [];
  const measured = probe?.running === false && typeof job?.identityKey === 'string' &&
    job.clipId === fixture.clipId && job.cardId === fixture.cardId && job.at >= fixture.createdAt &&
    record?.identityKey === job.identityKey && record.mode === 'build' && record.fps === fps &&
    record.measuredAt >= job.at && typeof record.device === 'string' && record.device.length > 0 &&
    ['random', 'stepped'].includes(record.kind) &&
    ['stepMs', 'inlineMs', 'rasterMs', 'serializeMs', 'catchUpMs'].every(k => Number.isFinite(record[k]) && record[k] >= 0);
  if (!measured) reasons.push('measurement-not-settled');
  const weight = measured ? clipWeight(record, 'stateful', fps) : null;
  const heavy = !!weight && (weight.pinned || weight.w > budgetOf(fps));
  if (measured && !heavy) reasons.push('measured-light');
  // Unknown/local cards may be pinned by policy. That alone cannot establish
  // the claimed CPU workload: this fixture additionally requires measured step.
  const cpuMeasured = !fixture.requireStepOverBudget || (measured && record.stepMs > budgetOf(fps));
  if (measured && !cpuMeasured) reasons.push('measured-step-not-over-budget');
  if (pipeline !== 'heavy') reasons.push('stage-not-heavy');
  const hit = publisher?.log?.filter(e => e.ok).at(-1);
  const current = !!hit && publisher.measured === true && publisher.last === hit.id &&
    publisher.want?.projectId === fixture.projectId &&
    Number.isSafeInteger(publisher.want?.projectRev) && publisher.want.projectRev >= 0 &&
    hit.id.startsWith(`plan:${publisher.want.projectId}@${publisher.want.projectRev}#clips:`) &&
    publisher.lastClips?.includes(fixture.clipId) && hit.state === 'open';
  if (!current) reasons.push('target-not-in-current-successful-plan');
  return { ready: measured && heavy && cpuMeasured && pipeline === 'heavy' && current,
    terminal: measured && (!heavy || !cpuMeasured), reasons, measured, cpuMeasured, budgetMs: budgetOf(fps),
    weight: weight ? { ...weight, w: Number.isFinite(weight.w) ? weight.w : 'Infinity' } : null,
    published: current ? hit : null };
}

// Completion is intentionally unchanged: splitting a plan is not rendering a fine task.
export const hostDidWork = view => (view?.nodes ?? []).some(n => (n.completed ?? 0) > 0 && (n.claimed ?? 0) > (n.completed ?? 0) - 1);
/** Exact clip evidence; aggregate completed, dedup or a browser result cannot substitute. */
export function hostRenderedClip(trace, nodeEvents, { clipId, fingerprint, layer = null } = {}) {
  const completed = new Set(nodeEvents.filter(e => e.event === 'node.completed').map(e => e.id));
  const dedup = new Set(nodeEvents.filter(e => e.event === 'node.dedup').map(e => e.id));
  const tasks = (trace?.records ?? []).filter(r => r.kind === 'snapshot' && r.clipId === clipId && r.requires.envFingerprint === fingerprint &&
    r.dual === false && r.weight.class === 'heavy' && r.completeFromOpen && r.continuous && r.closed?.state === 'done');
  const rendered = tasks.filter(r => completed.has(r.id) && !dedup.has(r.id));
  const ready = !!layer && layer.clipId === clipId && layer.envFingerprint === fingerprint && layer.ready > 0 && rendered.some(r => r.resultKey === layer.resultKey);
  return { rendered: rendered.length > 0, ready, taskIds: [...new Set(rendered.map(r => r.id))],
    resultKeys: [...new Set(rendered.map(r => r.resultKey))], rejectedDedup: tasks.filter(r => dedup.has(r.id)).map(r => r.id) };
}
const text = value => typeof value === 'string' ? value.slice(0, 240) : null;
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const reasonOf = value => ['superseded', 'orphan', 'released', 'expired', 'stalled', 'deleted', 'failed'].includes(value)
  ? { reason: value } : value == null ? { reason: null } : { reason: 'other', reasonHash: createHash('sha256').update(String(value)).digest('hex') };
const taskOf = task => ({ id: text(task.id), kind: text(task.kind), state: text(task.state), version: number(task.version),
  resultKey: text(task.resultKey), range: task.range ? { unit: text(task.range.unit), from: number(task.range.from), to: number(task.range.to) } : null,
  source: { projectId: text(task.source?.projectId), projectRev: number(task.source?.projectRev), derivedFrom: text(task.source?.derivedFrom) },
  tier: text(task.tier), clipId: text(task.input?.clipId), contentKey: text(task.input?.contentKey), dual: task.input?.dual === true,
  weight: { class: text(task.weight?.class), frames: number(task.weight?.frames) },
  requires: { envFingerprint: text(task.requires?.envFingerprint), codeVersion: text(task.requires?.codeVersion),
    userCards: task.requires?.userCards === true, graphCards: task.requires?.graphCards === true,
    transcode: task.requires?.transcode === true, belowDependent: task.requires?.belowDependent === true,
    localMediaRequired: task.requires?.localMedia != null, streams: task.requires?.capabilities?.streams === true,
    cardSourceCount: Object.keys(task.requires?.cardSources ?? {}).length,
    cardSourcesHash: createHash('sha256').update(JSON.stringify(Object.entries(task.requires?.cardSources ?? {}).sort())).digest('hex') }, ...reasonOf(task.lastError) });

/** Diagnostic evidence only. Different sockets have no shared delivery sequence.
 * An unversioned publisher failure/ACK is preserved separately, never attached to
 * a later same-ID generation or treated as proof that every host task was superseded.
 */
export function createC10Trace() {
  const records = [], events = [], current = new Map(), epochs = new Map(), serverEpochs = new Map();
  let sequence = 0;
  function boundary(channel, reason = 'disconnected') {
    epochs.set(channel, (epochs.get(channel) ?? 0) + 1);
    for (const record of records) if (record.channel === channel && current.get(`${channel}\0${record.id}`) === record) record.continuous = false;
    events.push({ sequence: ++sequence, channel, type: 'boundary', reason: ['disconnected', 'new-session', 'resumed', 'queue-epoch'].includes(reason) ? reason : 'other' });
  }
  function observe(message, { channel = 'observer', at = Date.now() } = {}) {
    if (!message || !['queue.snapshot', 'task.opened', 'task.taken', 'task.claimed', 'task.closed', 'task.failed', 'task.done', 'task.published'].includes(message.type)) return;
    if (typeof message.epoch === 'string') {
      if (serverEpochs.has(channel) && serverEpochs.get(channel) !== message.epoch) boundary(channel, 'queue-epoch');
      serverEpochs.set(channel, message.epoch);
    }
    const event = { sequence: ++sequence, at, channel, connection: epochs.get(channel) ?? 0, type: message.type,
      epoch: text(message.epoch), seq: number(message.seq), id: text(message.id), version: number(message.version) };
    const ingest = (task, initial) => {
      if (typeof task?.id !== 'string') return;
      const key = `${channel}\0${task.id}`, prior = current.get(key), projected = taskOf(task);
      const fresh = !prior || !prior.continuous || prior.connection !== event.connection ||
        (task.version === 1 && (prior.version !== 1 || prior.state !== 'open'));
      const record = fresh ? { ...projected, channel, connection: event.connection,
        generation: records.filter(r => r.channel === channel && r.id === task.id).length + 1,
        firstSeen: initial ? 'snapshot' : 'opened', completeFromOpen: !initial && task.version === 1,
        continuous: true, winner: null, closed: null, observations: [] } : Object.assign(prior, projected);
      if (fresh) { records.push(record); current.set(key, record); }
      record.observations.push(event.sequence);
      return record;
    };
    if (message.type === 'queue.snapshot') {
      event.tasks = (message.tasks ?? []).map(t => taskOf(t));
      for (const task of message.tasks ?? []) ingest(task, true);
    } else if (message.type === 'task.opened' || message.type === 'task.claimed') {
      event.task = message.task ? taskOf(message.task) : null;
      const record = message.task && ingest(message.task, false);
      if (record && message.type === 'task.claimed') record.winner = { fingerprint: record.requires.envFingerprint, evidence: event.type, sequence: event.sequence };
    } else if (message.type === 'task.taken' || message.type === 'task.closed') {
      const record = current.get(`${channel}\0${message.id}`);
      if (record?.continuous) {
        if (message.type === 'task.taken' && message.version === record.version + 1 && record.state === 'open')
          record.winner = { fingerprint: record.requires.envFingerprint, evidence: event.type, sequence: event.sequence };
        record.state = message.type === 'task.taken' ? 'claimed' : text(message.state);
        if (number(message.version) !== null) record.version = message.version;
        record.observations.push(event.sequence);
        if (message.type === 'task.closed') record.closed = { state: text(message.state), reason: 'unknown', sequence: event.sequence };
      }
      event.state = text(message.state);
    } else if (message.type === 'task.published') {
      event.reqId = text(message.reqId);
      event.results = (message.results ?? []).map(r => ({ id: text(r.id), state: text(r.state), version: number(r.version),
        created: r.created === true, lockedBy: text(r.lockedBy), ...reasonOf(r.error) }));
    } else {
      Object.assign(event, reasonOf(message.error), { association: 'unversioned-not-correlated', projectId: text(message.projectId), projectRev: number(message.projectRev) });
      if (message.type === 'task.done') event.derived = Array.isArray(message.result?.derived) ? message.result.derived.map(text).filter(Boolean) : null;
    }
    events.push(event);
  }
  return { observe, boundary, snapshot: () => structuredClone({ diagnosticOnly: true, records, events }) };
}
