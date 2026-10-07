// ─── Sync status → the one state the user sees ───
// Pure: the raw facts (connectivity + outbox summary + engine flag) in, a
// single state out, so the header pill and the offline banner can't disagree.
//
// Priority: failed > offline > syncing > pending > synced.
//  - failed first: those ops were rejected by the server (validation/auth)
//    and won't fix themselves — they need the user, and being offline doesn't
//    make them go away.
//  - offline before pending: while offline, "N waiting" is expected and the
//    reassuring message is "saved locally", not a count.
export function deriveSyncState({ online = true, pending = 0, failed = 0, syncing = false } = {}) {
  if (failed > 0) return { state: "failed", count: failed };
  if (!online) return { state: "offline", count: pending };
  if (syncing) return { state: "syncing", count: pending };
  if (pending > 0) return { state: "pending", count: pending };
  return { state: "synced", count: 0 };
}
