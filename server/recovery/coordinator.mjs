/** One recovery task per page. Dependencies are injected so races and backoff can be verified. */
export class RecoveryCoordinator {
  constructor(hooks) { this.hooks = hooks; this.generation = 0; this.timer = null; this.abort = null; }
  cancel() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.abort?.abort(); this.abort = null;
  }
  start(descriptor, contentId) {
    this.cancel(); const generation = this.generation; const abort = this.abort = new AbortController();
    const current = () => generation === this.generation && !abort.signal.aborted;
    const state = (kind, detail) => { if (current()) this.hooks.state(kind, detail); };
    if (descriptor.version !== 1) { state('unsupported'); return; }
    let delay = 500;
    const attempt = async () => {
      if (!current()) return;
      state('recovering');
      try {
        const saved = await this.hooks.identity(descriptor, contentId, abort.signal);
        if (!current()) return;
        if (saved.revoked) return state('deleted');
        if (!saved.selected) return state(saved.identities?.length > 1 ? 'choose-identity' : 'needs-auth');
        const record = saved.selected;
        const candidate = saved.host && descriptor.where === 'lan' && record.candidate?.where !== 'hosted' ? await this.hooks.host(descriptor, abort.signal) : await this.hooks.discover(descriptor, record, abort.signal);
        if (!current()) return;
        const result = await this.hooks.enter(candidate, record, current);
        if (!current()) return;
        if (result.ok) { state('connected'); return; }
        const error = new Error(result.error); error.reason = result.error; error.retryAfter = result.retryAfter; throw error;
      } catch (e) {
        if (!current()) return;
        const terminal = { auth: 'needs-auth', unauthorized: 'needs-auth', kicked: 'rejected', banned: 'rejected', removed: 'rejected', deleted: 'deleted', 'no-project': 'deleted', 'host-conflict': 'host-conflict', 'host-data-missing': 'damaged', 'recovery-storage': 'damaged' }[e.reason];
        if (terminal) return state(terminal);
        state('waiting-host');
        const wait = Math.max(delay, Number(e.retryAfter || 0) * 1000);
        delay = Math.min(30000, delay * 2);
        this.timer = setTimeout(() => { this.timer = null; void attempt(); }, wait);
      }
    };
    void attempt();
  }
}
