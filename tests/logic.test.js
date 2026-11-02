import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../js/logic.js";
import { SEED } from "../js/seed.js";

const seed = () => JSON.parse(JSON.stringify(SEED));

test("parseRepRange", () => {
  assert.deepEqual(L.parseRepRange("5-10"), { min: 5, max: 10 });
  assert.deepEqual(L.parseRepRange("8–15"), { min: 8, max: 15 });
  assert.deepEqual(L.parseRepRange("12"), { min: 12, max: 12 });
  assert.equal(L.parseRepRange("half of last week"), null);
});

test("estimate1RM uses Epley and ignores empty sets", () => {
  assert.equal(L.estimate1RM(100, 1), 100);
  assert.equal(L.estimate1RM(100, 10), 100 * (1 + 10 / 30));
  assert.equal(L.estimate1RM(100, 0), 0);
  assert.equal(L.estimate1RM("", 5), 0);
});

test("summarizeLog and formatLog", () => {
  const log = { sets: [{ weight: 75, reps: 9, done: true }, { weight: 75, reps: 8, done: true }, { weight: 75, reps: "", done: false }] };
  const s = L.summarizeLog(log);
  assert.equal(s.sets, 2);
  assert.equal(s.topWeight, 75);
  assert.equal(s.volume, 75 * 17);
  assert.equal(L.formatLog(log, "lb"), "75 lb × 9, 8");
  assert.equal(L.formatLog({ sets: [{ weight: 75, reps: 9, done: true }, { weight: 80, reps: 7, done: true }] }), "75 × 9, 80 × 7");
  assert.equal(L.summarizeLog({ sets: [{ weight: 75, reps: 9, done: false }] }), null, "unchecked sets don't count");
  assert.equal(L.summarizeLog({ sets: [] }), null);
});

test("progressionAdvice follows double progression", () => {
  const log = (...reps) => ({ sets: reps.map((r) => ({ weight: 50, reps: r, done: true })) });
  assert.equal(L.progressionAdvice("7-12", log(12, 12, 13), 3).kind, "increase");
  assert.equal(L.progressionAdvice("7-12", log(12, 12), 3).kind, "reps", "not every target set done yet");
  assert.equal(L.progressionAdvice("7-12", log(10, 9, 8), 3).kind, "reps");
  assert.equal(L.progressionAdvice("7-12", log(8, 6), 3).kind, "hold");
  assert.equal(L.progressionAdvice("7-12", { sets: [] }, 3), null);
});

test("seed data matches the spreadsheet", () => {
  const s = seed();
  assert.equal(s.program.weeks.length, 7);
  assert.equal(s.program.days.length, 4);
  assert.deepEqual(s.program.days.map((d) => d.exercises.length), [5, 5, 5, 5]);
  const squat = s.program.days[0].exercises[0];
  assert.equal(squat.name, "Smith Machine Squat");
  assert.deepEqual(s.program.targets.w2[squat.id], { sets: 3, weight: 75, rir: "2/fail" });
  assert.deepEqual(s.logs.w2[squat.id].sets.map((x) => x.reps), [9, 9, 9]);
  // A single "7" in a 3-set week becomes 3 sets of 7.
  assert.deepEqual(s.logs.w1[squat.id].sets.map((x) => x.reps), [7, 7, 7]);
  assert.equal(s.program.targets.w6[squat.id].reps, "half of last week");
  assert.equal(s.body.startWeight, 208);
  assert.ok(s.body.entries.length > 10);
});

test("nextSession picks the session after the last completed one", () => {
  const s = seed();
  // Week 2 Day 4 is the latest logged session in the sheet.
  const next = L.nextSession(s);
  assert.equal(next.week.id, "w3");
  assert.equal(next.day.id, "d1");
  s.sessions = {};
  assert.equal(L.nextSession(s).key, "w0:d1");
  for (const x of L.allSessions(s.program)) s.sessions[x.key] = { completed: true };
  assert.equal(L.nextSession(s), null);
});

test("sessionProgress counts logged sets against the target", () => {
  const s = seed();
  const p = L.sessionProgress(s, "w2", "d1");
  assert.equal(p.planned, 15);
  assert.equal(p.done, 15);
  const empty = L.sessionProgress(s, "w3", "d1");
  assert.equal(empty.done, 0);
  assert.ok(empty.planned > 0);
});

test("previousLog walks back to the latest logged week", () => {
  const s = seed();
  const id = s.program.days[0].exercises[0].id;
  assert.equal(L.previousLog(s, "w4", id).week.id, "w2");
  assert.equal(L.previousLog(s, "w0", id), null);
});

test("initialSets pre-fills target weight", () => {
  const rows = L.initialSets({ sets: 3, weight: 80 }, null);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { weight: 80, reps: "", done: false });
  const saved = { sets: [{ weight: 70, reps: 5, done: true }] };
  assert.deepEqual(L.initialSets({ sets: 3 }, saved), saved.sets);
  assert.notEqual(L.initialSets({ sets: 3 }, saved)[0], saved.sets[0], "returns copies");
});

test("weeklyAverages groups weigh-ins into 7-day blocks", () => {
  const entries = [
    { date: "2026-09-24", weight: 208 },
    { date: "2026-09-26", weight: 206 },
    { date: "2026-10-01", weight: 202 },
    { date: "2026-10-03", weight: 202.5 },
  ];
  const w = L.weeklyAverages(entries, "2026-09-24");
  assert.equal(w.length, 2);
  assert.equal(w[0].avg, 207);
  assert.equal(w[0].change, null);
  assert.equal(w[1].start, "2026-10-01");
  assert.equal(w[1].avg, 202.25);
  assert.equal(w[1].change, 202.25 - 207);
});

test("goalWeight matches the sheet's linear goal", () => {
  const body = { startDate: "2026-09-24", startWeight: 208, weeklyChangePct: -0.008 };
  assert.equal(L.goalWeight(body, "2026-09-24"), 208);
  // Spreadsheet: "Weight After 6 weeks" = 198.016
  assert.ok(Math.abs(L.goalWeight(body, L.addDays("2026-09-24", 42)) - 198.016) < 1e-9);
});

test("weeklyTotals: pounds worked = sets × weight, with week-over-week change", () => {
  const s = seed();
  const t = L.weeklyTotals(s);
  assert.equal(t.length, 7);
  // Week 0 Day 1 squat: 2 sets at 75 lb -> 150 lb worked.
  assert.equal(L.poundsWorked(s.logs.w0.d1e1.sets), 150);
  const w0 = Object.values(s.logs.w0).flatMap((l) => l.sets.filter((x) => x.done));
  assert.equal(t[0].sets, w0.length);
  assert.equal(t[0].pounds, w0.reduce((a, x) => a + x.weight, 0));
  assert.equal(t[0].poundsChange, null, "nothing before week 0");
  assert.equal(t[1].poundsChange, (t[1].pounds - t[0].pounds) / t[0].pounds);
  assert.equal(t[1].setsChange, (t[1].sets - t[0].sets) / t[0].sets);
  assert.equal(t[3].sets, 0);
  assert.equal(t[3].poundsChange, null, "an empty week isn't a −100% drop");
  assert.equal(t[4].poundsChange, null, "no change from an empty week");
  assert.equal(L.pctChange(110, 100), 0.1);
  assert.equal(L.pctChange(5, 0), null);
});

test("repsText and sheetPasteBlock", () => {
  const log = { sets: [{ weight: 85, reps: 9, done: true }, { weight: 85, reps: 8, done: true }, { weight: 85, reps: 10, done: false }] };
  assert.equal(L.repsText(log), "9,8");
  assert.equal(L.repsText(undefined), "");
  const week = { id: "w3", sheetRepsCol: "U" };
  const day = { exercises: [
    { id: "a", name: "Squat", sheetRow: 9 },
    { id: "b", name: "SLDL", sheetRow: 10 },
    { id: "c", name: "Curls", sheetRow: 12 },
    { id: "d", name: "New thing" },
  ] };
  const block = L.sheetPasteBlock(week, day, { a: log, c: { sets: [{ weight: 40, reps: 12, done: true }] } });
  assert.equal(block.cell, "U9");
  assert.equal(block.text, "9,8\n\n\n12", "blank lines keep rows aligned");
  assert.deepEqual(block.missing, ["New thing"]);
});

test("personalRecords", () => {
  const s = seed();
  const prs = L.personalRecords(s);
  assert.ok(prs.length > 0);
  assert.ok(prs[0].e1rm >= prs.at(-1).e1rm);
});

test("older saved data gets sheet rows and reps columns", async () => {
  const { migrate } = await import("../js/store.js");
  const old = seed();
  for (const w of old.program.weeks) delete w.sheetRepsCol;
  for (const d of old.program.days) for (const ex of d.exercises) delete ex.sheetRow;
  const m = migrate(old);
  assert.equal(m.program.weeks.find((w) => w.id === "w3").sheetRepsCol, "U");
  assert.equal(m.program.days[1].exercises[0].sheetRow, 17);
  assert.equal(m.program.days[3].exercises[4].sheetRow, 38);
});

test("rest timer defaults to 3 minutes unless changed on the timer", async () => {
  const { migrate, freshState } = await import("../js/store.js");
  assert.equal(freshState().settings.restSeconds, 180);
  const base = seed();
  assert.equal(migrate({ ...base, settings: { restSeconds: 120 } }).settings.restSeconds, 180);
  assert.equal(migrate({ ...base, settings: { restSeconds: 90, restCustom: true } }).settings.restSeconds, 90);
});
