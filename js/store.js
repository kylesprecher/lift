// Persistence: the whole app state lives in one localStorage key.
import { SEED } from "./seed.js";

const KEY = "lift.state.v1";

const clone = (x) => JSON.parse(JSON.stringify(x));

export function freshState() {
  // updatedAt 0: any copy saved from another device is newer than this.
  return { ...clone(SEED), settings: { restSeconds: 180, autoRest: true }, updatedAt: 0 };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (err) {
    // Unreadable data or storage blocked (private mode, sandboxed preview).
    console.warn("Could not read saved data, starting fresh", err);
  }
  return freshState();
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error("Could not save", err);
    return false;
  }
}

/** Validate and normalise imported / stored data. Throws on unusable input. */
export function migrate(data) {
  if (!data || typeof data !== "object" || !data.program?.weeks || !data.program?.days) {
    throw new Error("That file doesn't look like a Lift backup.");
  }
  return {
    version: 1,
    program: {
      targets: {},
      guides: {},
      unit: "lb",
      // Installs from before the sheet link existed get the original sheet.
      sheetId: data.program.id === SEED.program.id ? SEED.program.sheetId : null,
      ...data.program,
    },
    logs: data.logs ?? {},
    sessions: data.sessions ?? {},
    body: data.body ?? { startDate: null, startWeight: null, weeklyChangePct: 0, entries: [] },
    settings: {
      autoRest: true,
      ...data.settings,
      // 3 minutes unless the duration was changed on the timer.
      restSeconds: data.settings?.restCustom ? data.settings.restSeconds : 180,
    },
    updatedAt: data.updatedAt ?? 0,
  };
}
