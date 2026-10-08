/** Ephemeral selection publisher for an authenticated account-project document link.
 * The caller must explicitly enable this on cloud-account connections. LAN/local
 * links continue to use their established page-only get_selection behavior.
 */
interface SelectionLink {
  request(message: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export interface SelectionSource {
  readSelection(): readonly string[];
  subscribe(listener: () => void): () => void;
}

type Bound = { link: SelectionLink; projectId: string; pageId: string; revision: number; last: string };
let bound: Bound | null = null;
let stopStore: (() => void) | null = null;
let source: SelectionSource | null = null;
const unsupported = new WeakSet<SelectionLink>();

function publish(force = false): void {
  const current = bound;
  if (!current || !source || unsupported.has(current.link)) return;
  const clipIds = source.readSelection().filter((id): id is string => typeof id === "string");
  const key = JSON.stringify(clipIds);
  if (!force && current.last === key) return;
  current.last = key;
  const revision = ++current.revision;
  void current.link.request({ type: "selection.set", projectId: current.projectId,
    pageId: current.pageId, revision, selection: { clipIds } }, 5000).then(
    reply => { if (reply?.type === "error" && reply.reason === "unsupported") unsupported.add(current.link); },
    () => {},
  );
}

/** Explicit cloud-account hookup; passing null detaches. Each page owns one ID. */
export function setSelectionLink(link: SelectionLink | null, projectId: string | null, selectionSource?: SelectionSource): void {
  stopStore?.();
  stopStore = null;
  source = null;
  bound = link && projectId ? { link, projectId, pageId: crypto.randomUUID(), revision: 0, last: "" } : null;
  if (bound) {
    const binding = bound;
    const useSource = (provided: SelectionSource) => {
      if (bound !== binding) return;
      source = provided;
      stopStore = provided.subscribe(() => publish());
      publish(true); // Online pages with an empty selection must still be visible.
    };
    if (selectionSource) useSource(selectionSource);
    else void import("../../store/project").then(store => useSource({
      readSelection: () => store.getState().selection,
      subscribe: store.subscribe,
    }), () => {});
  }
}

export function selectionPresenceStatus(): { linked: boolean; pageId: string | null; revision: number; unsupported: boolean } {
  return { linked: !!bound, pageId: bound?.pageId ?? null,
    revision: bound?.revision ?? 0, unsupported: !!bound && unsupported.has(bound.link) };
}
