// Optional cloud copy of the app state, used when Lift runs as a published
// claude.ai Artifact: the whole state is kept in one private document under
// the viewer's own `data/users/<id>/` path, so it survives cleared browser
// data and follows the same person between phone and computer. Anywhere
// else (`window.claude` absent) connect() resolves null and the app runs on
// localStorage alone.

const WRITE_DELAY_MS = 1200;

let ref = null;
let timer = null;
let queued = null;
let writing = Promise.resolve();

/**
 * Connect and subscribe. `onRemote(state | null)` fires with the stored
 * state (null when nothing is stored yet) now and whenever another device
 * saves; `onStatus(status, detail?)` reports "connecting" | "local" |
 * "saving" | "synced" | "error".
 */
export async function connect({ onRemote, onStatus }) {
  if (!window.claude?.use) return null;
  onStatus("connecting");
  const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
  const id = db && user ? await user.id() : null;
  if (!id) {
    onStatus("local");
    return null;
  }
  ref = db.doc(`data/users/${id}/lift`);
  ref.onSnapshot(
    (snap) => {
      if (!snap.exists) return onRemote(null);
      try {
        onRemote(JSON.parse(snap.data().state));
        if (!queued) onStatus("synced");
      } catch (err) {
        console.warn("Ignoring unreadable cloud copy", err);
      }
    },
    (err) => onStatus("error", err.message)
  );
  push.onStatus = onStatus;
  return true;
}

/** Queue a write of the latest state; bursts of edits become one write. */
export function push(state, { now = false } = {}) {
  if (!ref) return;
  queued = state;
  push.onStatus?.("saving");
  clearTimeout(timer);
  timer = setTimeout(flush, now ? 0 : WRITE_DELAY_MS);
}

function flush() {
  const state = queued;
  if (!state) return;
  queued = null;
  // One write at a time to the document.
  writing = writing
    .then(() => ref.set({ updatedAt: state.updatedAt, state: JSON.stringify(state) }))
    .then(() => !queued && push.onStatus?.("synced"))
    .catch((err) => push.onStatus?.("error", err.message));
}

/** Write anything pending right away (e.g. when the app is backgrounded). */
export function flushNow() {
  if (!queued) return;
  clearTimeout(timer);
  flush();
}
