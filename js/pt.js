// Physical-therapy home exercises: a plan (exercises with sets, reps, weight
// and times per week), a day-by-day log of completed sets, and helpers to
// turn the therapist's emails into plan updates. Kept separate from the
// strength program. Pure functions only, so this file is unit tested.

import { toDate, toISO, addDays } from "./logic.js";

// Set from the PT tab (or the private seed); empty in the public code.
export const DEFAULT_SENDER = "";

export function emptyPT() {
  return { plan: { exercises: [], source: null, updatedAt: null }, log: {}, history: [], sender: DEFAULT_SENDER };
}

/** Monday of the week containing `iso` (YYYY-MM-DD). */
export function weekStart(iso) {
  const day = toDate(iso).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((day + 6) % 7));
}

export const weekDays = (startIso) => Array.from({ length: 7 }, (_, i) => addDays(startIso, i));

/** Sets checked off for one exercise on one day. */
export function setsDone(pt, iso, exId) {
  return Number(pt.log?.[iso]?.[exId]?.sets) || 0;
}

/** A day counts as a session once every planned set is checked off. */
export function isSessionDone(pt, iso, ex) {
  return setsDone(pt, iso, ex.id) >= Math.max(1, Number(ex.sets) || 1);
}

/** Per-exercise sessions done vs. target for the week starting `startIso`. */
export function weekProgress(pt, startIso) {
  const days = weekDays(startIso);
  const rows = pt.plan.exercises.map((ex) => {
    const target = Math.min(7, Math.max(1, Number(ex.perWeek) || 1));
    const done = days.filter((d) => isSessionDone(pt, d, ex)).length;
    return { exercise: ex, done, target, met: done >= target };
  });
  const target = rows.reduce((s, r) => s + r.target, 0);
  const done = rows.reduce((s, r) => s + Math.min(r.done, r.target), 0);
  return { rows, done, target, pct: target ? done / target : 0 };
}

/**
 * Completion for the last `count` weeks ending with the week of `todayIso`,
 * oldest first, measured against the current plan.
 */
export function adherenceHistory(pt, todayIso, count = 8) {
  const thisWeek = weekStart(todayIso);
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(thisWeek, -7 * (count - 1 - i));
    return { start, current: start === thisWeek, ...weekProgress(pt, start) };
  });
}

/** Toggle set `index` (0-based): tapping a filled last set un-checks it. */
export function toggleSet(count, index) {
  return count >= index + 1 ? index : index + 1;
}

/** "Daily", "3×/week", "1×/week". */
export function frequencyText(perWeek) {
  const n = Number(perWeek) || 0;
  return n >= 7 ? "Daily" : `${n}×/week`;
}

// ------------------------------------------------------------------ plan updates

const key = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Normalise one exercise from Claude's reply or a form. Returns null if unusable. */
export function cleanExercise(raw) {
  const name = String(raw?.name ?? "").trim();
  if (!name) return null;
  const int = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo ? Math.min(hi, n) : dflt;
  };
  const weight = Number(raw.weight);
  const text = (v) => (v == null ? "" : String(v).trim());
  const video = text(raw.video);
  return {
    name,
    area: text(raw.area) || "Other",
    perWeek: int(raw.perWeek, 1, 7, 3),
    sets: int(raw.sets, 1, 20, 3),
    reps: text(raw.reps) || "10",
    weight: Number.isFinite(weight) && weight > 0 ? weight : null,
    video: /^https?:\/\//.test(video) ? video : "",
    note: text(raw.note),
  };
}

const FIELDS = ["area", "perWeek", "sets", "reps", "weight", "video", "note"];

/**
 * Compare the current plan with a proposed one, matching exercises by name.
 * Returns {added, removed, changed: [{exercise, next, fields: [{field, from, to}]}], unchanged}.
 */
export function diffPlan(current, proposed) {
  const byKey = new Map(current.map((ex) => [key(ex.name), ex]));
  const seen = new Set();
  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const next of proposed) {
    const ex = byKey.get(key(next.name));
    if (!ex) {
      added.push(next);
      continue;
    }
    seen.add(key(next.name));
    const fields = FIELDS.filter((f) => String(ex[f] ?? "") !== String(next[f] ?? "")).map((f) => ({ field: f, from: ex[f], to: next[f] }));
    if (fields.length) changed.push({ exercise: ex, next, fields });
    else unchanged++;
  }
  const removed = current.filter((ex) => !seen.has(key(ex.name)));
  return { added, removed, changed, unchanged };
}

/**
 * Apply a proposed plan: exercises keep their id (and so their history) when
 * the name matches; new ones get `makeId()`.
 */
export function mergePlan(current, proposed, makeId) {
  const byKey = new Map(current.map((ex) => [key(ex.name), ex]));
  return proposed.map((next) => ({ ...next, id: byKey.get(key(next.name))?.id ?? makeId() }));
}

// ------------------------------------------------------------------ emails

/**
 * The therapist's own words from a plain-text email: quoted replies
 * ("> ..." and everything from "On <date> ... wrote:") and the signature
 * ("--") are dropped.
 */
export function cleanEmailBody(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*--\s*$/.test(line)) break;
    // "On Wed, Nov 11, 2026 at 3:37 PM Name <a@b> wrote:" can wrap onto two lines.
    if (/^On .+/.test(line) && /wrote:\s*$/.test(line + " " + (lines[i + 1] ?? ""))) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Messages from `sender` in Gmail thread payloads, oldest first, deduped. */
export function therapistMessages(threads, sender) {
  const want = String(sender).toLowerCase();
  const seen = new Set();
  const out = [];
  for (const t of threads) {
    for (const m of t?.messages ?? []) {
      if (!m?.id || seen.has(m.id) || !String(m.sender ?? "").toLowerCase().includes(want)) continue;
      seen.add(m.id);
      const body = cleanEmailBody(m.plaintextBody ?? m.snippet ?? "");
      if (body) out.push({ id: m.id, date: m.date, subject: m.subject ?? "", url: m.viewUrl ?? "", body });
    }
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** Prompt asking Claude to fold the emails into the current plan. */
export function planPrompt(currentExercises, emails) {
  const plan = currentExercises.map(({ name, area, perWeek, sets, reps, weight, video, note }) => ({ name, area, perWeek, sets, reps, weight, video, note }));
  return `You maintain a patient's physical therapy home exercise program (HEP).

CURRENT PLAN (JSON):
${JSON.stringify(plan, null, 1)}

EMAILS FROM THE PHYSICAL THERAPIST, OLDEST FIRST:
${emails.map((e, i) => `--- Email ${i + 1} · ${e.date} · ${e.subject}\n${e.body}`).join("\n\n")}

Update the plan to what the therapist currently prescribes:
- Emails are often partial updates. A later email replaces only the exercises or body area it covers; keep everything else ("keep up with the knee and back exercises" means keep those unchanged; "keeping your HEP the same" means no change).
- Ignore scheduling, billing and small talk.
- A list under a heading like "Knee:" with "Daily" and "3 sets" applies that frequency and set count to each item under it. "Daily" = perWeek 7, "3x/week" = 3. A one-off instruction such as "try a short walk at least once this week" is perWeek 1.
- reps is text exactly as prescribed: "10", "10-12", "8 each side", "2 min on / 2 min off".
- weight is a number in pounds only when the email gives one; otherwise null.
- video: the link given for that exercise, else "".
- note: short coaching cues from the email (e.g. "5 second lowering", "stop if pain goes above 3/10"), else "".
- Keep exercise names from the current plan when it is the same exercise, so history carries over. Fix obvious typos in new names.
- area: the body area heading ("Knee", "Back", "Shoulder", "Cardio", ...).

Reply with JSON only, in this shape:
{"exercises":[{"name":"","area":"","perWeek":3,"sets":3,"reps":"10","weight":null,"video":"","note":""}],"changes":["one short line per change, mentioning which email it came from"]}`;
}

/** Validate Claude's reply. Throws a readable Error when it is unusable. */
export function readPlanReply(reply) {
  const list = Array.isArray(reply?.exercises) ? reply.exercises.map(cleanExercise).filter(Boolean) : null;
  if (!list?.length) throw new Error("Claude didn't return any exercises from the emails.");
  const changes = Array.isArray(reply.changes) ? reply.changes.map(String).filter(Boolean).slice(0, 20) : [];
  return { exercises: list, changes };
}

/** Today's date in the viewer's time zone as YYYY-MM-DD. */
export function localToday(now = new Date()) {
  return toISO(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
