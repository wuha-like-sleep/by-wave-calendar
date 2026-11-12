import { decide, localOrigin, stableTransactionId, SyncConflictError, SyncUnavailableError, type Conflict, type SyncContent, type SyncItem, type SyncState } from "./model.js";

export interface SyncSide {
  findOrigin?(origin: string): Promise<SyncItem | { deletedId: string } | null>;
  snapshot(tracked: string[]): Promise<Map<string, SyncItem>>;
  save(content: SyncContent, current?: SyncItem, origin?: string): Promise<SyncItem>;
  remove(current: SyncItem): Promise<void>;
}
/** Persist after every mutation. Creates are journalled BEFORE the remote call;
 * both adapters recover them by a stable origin after a timeout or restart. */
export async function synchronize(pairId: string, state: SyncState, left: SyncSide, right: SyncSide,
  checkpoint: (state: SyncState) => Promise<void>, heartbeat: () => Promise<void>, budget = 100): Promise<Conflict[]> {
  await heartbeat();
  const l = await left.snapshot([...state.links.map(x => x.leftId), ...(state.pending?.side === "left" ? [state.pending.sourceId] : [])]);
  await heartbeat();
  const r = await right.snapshot([...state.links.map(x => x.rightId), ...(state.pending?.side === "right" ? [state.pending.sourceId] : [])]);
  const conflicts: Conflict[] = [];
  let mutations = 0;
  const persist = async () => { await checkpoint(state); await heartbeat(); };
  const finishPending = async (recover = false) => {
    const p = state.pending!;
    const target = p.side === "left" ? r : l;
    const adapter = p.side === "left" ? right : left;
    let item = [...target.values()].find(x => x.origin === p.origin);
    await heartbeat();
    const recovered = !item && recover && adapter.findOrigin ? await adapter.findOrigin(p.origin) : null;
    // A confirmed tombstone means creation succeeded before the interruption,
    // then an editor deleted it. Preserve that deletion for three-way comparison.
    const deletedId = recovered && "deletedId" in recovered ? recovered.deletedId : undefined;
    if (recovered && "content" in recovered) item = recovered;
    if (!deletedId) {
      item ??= await adapter.save(p.content, undefined, p.origin);
      target.set(item.id, item);
    }
    const targetId = deletedId ?? item!.id;
    state.links.push({ leftId: p.side === "left" ? p.sourceId : targetId, rightId: p.side === "left" ? targetId : p.sourceId, base: p.content });
    delete state.pending;
    await persist();
    mutations++;
  };
  if (state.pending) await finishPending(true);
  for (const link of [...state.links]) {
    const a = l.get(link.leftId), b = r.get(link.rightId);
    let action = decide(link, a, b);
    const key = link.leftId;
    const resolution = state.resolutions[key];
    if (action === "conflict" && resolution && resolution.leftRevision === (a?.revision ?? null) && resolution.rightRevision === (b?.revision ?? null)) {
      action = resolution.side === "left" ? "to-right" : "to-left";
    }
    if (action === "conflict") { conflicts.push({ key, left: a ?? null, right: b ?? null }); continue; }
    if (action === "equal") { link.base = a!.content; delete state.resolutions[key]; continue; }
    if (action === "forget") { state.links = state.links.filter(x => x !== link); delete state.resolutions[key]; continue; }
    if (mutations >= budget) continue;
    await heartbeat();
    const source = action === "to-right" ? a : b;
    const target = action === "to-right" ? b : a;
    const adapter = action === "to-right" ? right : left;
    try {
      if (source) {
        // A side deleted while the other was edited needs explicit resolution.
        // Recreating uses the same stable identity and remains restart-safe.
        if (!target) {
          state.links = state.links.filter(x => x !== link);
          state.pending = { side: action === "to-right" ? "left" : "right", sourceId: source.id,
            origin: action === "to-right" ? stableTransactionId(pairId, source.id + ":restore:" + source.revision) : localOrigin(pairId, source.id + ":restore:" + source.revision), content: source.content };
          await persist(); await finishPending();
        } else {
          const updated = await adapter.save(source.content, target);
          if (action === "to-right") r.set(updated.id, updated); else l.set(updated.id, updated);
          link.base = source.content;
        }
      } else {
        if (target) await adapter.remove(target);
        state.links = state.links.filter(x => x !== link);
        l.delete(link.leftId); r.delete(link.rightId);
      }
      delete state.resolutions[key];
      mutations++; await persist();
    } catch (e) {
      if (!(e instanceof SyncConflictError)) throw e;
      // Stop this pass: an editor won a conditional write. A fresh snapshot will
      // produce a conflict instead of guessing which revision to keep.
      throw new SyncUnavailableError("calendar_changed_retry");
    }
  }
  // Index linked identities once; large calendars must not scan every link
  // again for every event on every background pass.
  const leftIds = new Set(state.links.map(x => x.leftId));
  const rightIds = new Set(state.links.map(x => x.rightId));
  // Never import a linked event a second time, including unresolved conflicts.
  for (const [side, items] of [["left", l], ["right", r]] as const) {
    for (const item of items.values()) {
      if (mutations >= budget) break;
      if ((side === "left" ? leftIds : rightIds).has(item.id)) continue;
      state.pending = { side, sourceId: item.id, origin: side === "left" ? stableTransactionId(pairId, item.id) : localOrigin(pairId, item.id), content: item.content };
      await persist(); await finishPending();
      const link = state.links.at(-1)!; leftIds.add(link.leftId); rightIds.add(link.rightId);
    }
  }
  if (state.links.length > 20000) throw new SyncUnavailableError("calendar_too_large");
  await persist();
  return conflicts;
}
