// Pure functions for the workout tracker. No DOM or storage access here, so
// everything in this file can be unit tested with `node --test`.

/** "5-10" -> {min: 5, max: 10}; "12" -> {min: 12, max: 12}; anything else -> null */
export function parseRepRange(text) {
  const m = String(text ?? "").match(/^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/);
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] ? Number(m[2]) : min;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** Epley estimated one-rep max. Returns 0 for missing data. */
export function estimate1RM(weight, reps) {
  const w = Number(weight);
  const r = Number(reps);
  if (!(w > 0) || !(r > 0)) return 0;
  if (r === 1) return w;
  return w * (1 + r / 30);
}

/** Sets that count as performed: the ones checked off with ✓. */
export function performedSets(log) {
  return (log?.sets ?? []).filter((s) => s.done);
}

export function setVolume(sets) {
  return sets.reduce((sum, s) => sum + (Number(s.weight) || 0) * (Number(s.reps) || 0), 0);
}

/** Summary of one exercise's log: heaviest weight, best e1RM, volume, reps list. */
export function summarizeLog(log) {
  const sets = performedSets(log);
  if (!sets.length) return null;
  let topWeight = 0;
  let best1RM = 0;
  for (const s of sets) {
    topWeight = Math.max(topWeight, Number(s.weight) || 0);
    best1RM = Math.max(best1RM, estimate1RM(s.weight, s.reps));
  }
  return {
    sets: sets.length,
    topWeight,
    best1RM,
    volume: setVolume(sets),
    reps: sets.map((s) => Number(s.reps) || 0),
  };
}

/** "75 × 9, 9, 9" (or "75 × 9, 80 × 8" when weights differ). */
export function formatLog(log, unit = "") {
  const sets = performedSets(log);
  if (!sets.length) return "";
  const weights = new Set(sets.map((s) => Number(s.weight) || 0));
  const u = unit ? ` ${unit}` : "";
  if (weights.size === 1) {
    return `${fmt(sets[0].weight)}${u} × ${sets.map((s) => s.reps || 0).join(", ")}`;
  }
  return sets.map((s) => `${fmt(s.weight)} × ${s.reps || 0}`).join(", ");
}

export function fmt(n, digits = 1) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "–";
  return Number.isInteger(x) ? String(x) : x.toFixed(digits).replace(/\.0+$/, "");
}

/**
 * Double-progression advice based on the rep range:
 *  - every set at/above the top of the range -> add weight next time
 *  - any set below the bottom -> hold (or reduce) weight
 *  - otherwise -> keep the weight and add reps
 */
export function progressionAdvice(repRange, log, targetSets) {
  const range = parseRepRange(repRange);
  const sets = performedSets(log);
  if (!range || !sets.length) return null;
  const reps = sets.map((s) => Number(s.reps) || 0);
  const allSetsDone = !targetSets || sets.length >= targetSets;
  if (allSetsDone && reps.every((r) => r >= range.max)) {
    return { kind: "increase", text: `Top of ${repRange} on every set — add weight next week` };
  }
  if (reps.some((r) => r < range.min)) {
    return { kind: "hold", text: `Below ${range.min} reps — hold or drop the weight` };
  }
  return { kind: "reps", text: `In range — same weight, chase more reps` };
}

// ---------------------------------------------------------------- program

export const sessionKey = (weekId, dayId) => `${weekId}:${dayId}`;

export function findExercise(program, exerciseId) {
  for (const day of program.days) {
    const ex = day.exercises.find((e) => e.id === exerciseId);
    if (ex) return { day, exercise: ex };
  }
  return null;
}

/** Ordered list of every (week, day) pair in the program. */
export function allSessions(program) {
  const out = [];
  for (const week of program.weeks) {
    for (const day of program.days) out.push({ week, day, key: sessionKey(week.id, day.id) });
  }
  return out;
}

export function isSessionComplete(state, weekId, dayId) {
  return Boolean(state.sessions?.[sessionKey(weekId, dayId)]?.completed);
}

/** Sets planned vs. performed for one session. */
export function sessionProgress(state, weekId, dayId) {
  const day = state.program.days.find((d) => d.id === dayId);
  let planned = 0;
  let done = 0;
  for (const ex of day?.exercises ?? []) {
    const target = state.program.targets?.[weekId]?.[ex.id];
    const p = Number(target?.sets) || 0;
    planned += p;
    done += Math.min(performedSets(state.logs?.[weekId]?.[ex.id]).length, p || Infinity);
  }
  return { planned, done, pct: planned ? done / planned : 0 };
}

/**
 * The session to train next: the one after the most recently completed
 * session, or the first session if nothing is complete yet. Returns null
 * when the program is finished.
 */
export function nextSession(state) {
  const list = allSessions(state.program);
  let lastDone = -1;
  list.forEach((s, i) => {
    if (isSessionComplete(state, s.week.id, s.day.id)) lastDone = i;
  });
  for (let i = lastDone + 1; i < list.length; i++) {
    if (!isSessionComplete(state, list[i].week.id, list[i].day.id)) return list[i];
  }
  return list.find((s) => !isSessionComplete(state, s.week.id, s.day.id)) ?? null;
}

export function programProgress(state) {
  const list = allSessions(state.program);
  const completed = list.filter((s) => isSessionComplete(state, s.week.id, s.day.id)).length;
  return { completed, total: list.length, pct: list.length ? completed / list.length : 0 };
}

/** The most recent earlier week with a logged entry for this exercise. */
export function previousLog(state, weekId, exerciseId) {
  const idx = state.program.weeks.findIndex((w) => w.id === weekId);
  for (let i = idx - 1; i >= 0; i--) {
    const week = state.program.weeks[i];
    const log = state.logs?.[week.id]?.[exerciseId];
    if (performedSets(log).length) return { week, log };
  }
  return null;
}

/** Per-week history for an exercise slot, in program order. */
export function exerciseHistory(state, exerciseId) {
  return state.program.weeks.map((week) => {
    const target = state.program.targets?.[week.id]?.[exerciseId] ?? {};
    const summary = summarizeLog(state.logs?.[week.id]?.[exerciseId]);
    return { week, target, summary };
  });
}

/** Total volume lifted per week across the whole program. */
export function weeklyVolume(state) {
  return state.program.weeks.map((week) => {
    let volume = 0;
    for (const log of Object.values(state.logs?.[week.id] ?? {})) volume += setVolume(performedSets(log));
    return { week, volume };
  });
}

/** Best estimated 1RM per exercise slot, highest first. */
export function personalRecords(state) {
  const out = [];
  for (const day of state.program.days) {
    for (const ex of day.exercises) {
      let best = null;
      for (const { week, summary } of exerciseHistory(state, ex.id)) {
        if (summary && (!best || summary.best1RM > best.e1rm)) {
          best = { week, e1rm: summary.best1RM, topWeight: summary.topWeight };
        }
      }
      if (best) out.push({ day, exercise: ex, ...best });
    }
  }
  return out.sort((a, b) => b.e1rm - a.e1rm);
}

/**
 * Build the set rows to show for a session: the saved log if there is one,
 * otherwise blank rows pre-filled with the target weight.
 */
export function initialSets(target, log) {
  if (log?.sets?.length) return log.sets.map((s) => ({ ...s }));
  const n = Math.max(1, Number(target?.sets) || 1);
  return Array.from({ length: n }, () => ({ weight: target?.weight ?? "", reps: "", done: false }));
}

// ---------------------------------------------------------------- bodyweight

const DAY_MS = 86400000;
export const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const toISO = (d) => d.toISOString().slice(0, 10);
export const addDays = (iso, n) => toISO(new Date(toDate(iso).getTime() + n * DAY_MS));
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);

/**
 * Group weigh-ins into 7-day blocks starting at `startDate` (like the
 * spreadsheet's Week # column) with the weekly average and change.
 */
export function weeklyAverages(entries, startDate) {
  if (!entries.length) return [];
  const start = startDate ?? [...entries].sort((a, b) => a.date.localeCompare(b.date))[0].date;
  const buckets = new Map();
  for (const e of entries) {
    const idx = Math.floor(daysBetween(start, e.date) / 7);
    if (idx < 0) continue;
    if (!buckets.has(idx)) buckets.set(idx, []);
    buckets.get(idx).push(Number(e.weight));
  }
  const weeks = [...buckets.keys()].sort((a, b) => a - b);
  let prev = null;
  return weeks.map((idx) => {
    const ws = buckets.get(idx);
    const avg = ws.reduce((a, b) => a + b, 0) / ws.length;
    const row = {
      week: idx + 1,
      start: addDays(start, idx * 7),
      avg,
      count: ws.length,
      change: prev == null ? null : avg - prev,
    };
    prev = avg;
    return row;
  });
}

/** Goal bodyweight on a date given a weekly % change (e.g. -0.008 = lose 0.8%/week). */
export function goalWeight(body, iso) {
  const weeks = daysBetween(body.startDate, iso) / 7;
  return body.startWeight * (1 + body.weeklyChangePct * weeks);
}
