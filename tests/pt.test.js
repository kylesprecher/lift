import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../js/pt.js";

const plan = (exercises) => ({ ...P.emptyPT(), plan: { exercises, source: null, updatedAt: null } });
const ex = (id, name, perWeek = 3, sets = 3, extra = {}) => ({ id, name, area: "Knee", perWeek, sets, reps: "10", weight: null, video: "", note: "", ...extra });

test("weekStart is the Monday of the week", () => {
  assert.equal(P.weekStart("2026-11-14"), "2026-11-09"); // Saturday
  assert.equal(P.weekStart("2026-11-09"), "2026-11-09"); // Monday
  assert.equal(P.weekStart("2026-11-15"), "2026-11-09"); // Sunday
});

test("sessions count only when every set is done; weekly progress caps at target", () => {
  const pt = plan([ex("a", "Wall sit", 3, 3), ex("b", "Calf raise", 7, 2)]);
  pt.log = {
    "2026-11-09": { a: { sets: 3 }, b: { sets: 2 } },
    "2026-11-10": { a: { sets: 2 }, b: { sets: 2 } },
    "2026-11-11": { a: { sets: 3 } },
    "2026-11-12": { a: { sets: 3 } },
    "2026-11-13": { a: { sets: 3 } },
  };
  const w = P.weekProgress(pt, "2026-11-09");
  assert.deepEqual(w.rows.map((r) => [r.done, r.target, r.met]), [[4, 3, true], [2, 7, false]]);
  assert.equal(w.done, 3 + 2);
  assert.equal(w.target, 10);
  const hist = P.adherenceHistory(pt, "2026-11-14", 3);
  assert.deepEqual(hist.map((h) => h.start), ["2026-10-26", "2026-11-02", "2026-11-09"]);
  assert.ok(hist[2].current);
  assert.equal(hist[0].pct, 0);
});

test("toggleSet and frequencyText", () => {
  assert.equal(P.toggleSet(0, 0), 1);
  assert.equal(P.toggleSet(1, 0), 0, "tapping the last filled set un-checks it");
  assert.equal(P.toggleSet(1, 2), 3, "tapping set 3 fills 1-3");
  assert.equal(P.toggleSet(3, 1), 1);
  assert.equal(P.frequencyText(7), "Daily");
  assert.equal(P.frequencyText(3), "3×/week");
});

test("cleanEmailBody keeps only the sender's own words", () => {
  const body = `Hey!

Updated exercises below.

Knee:
3x/week
- 10 wall sits

--
Pat Therapist PT, DPT
Some Clinic`;
  assert.equal(P.cleanEmailBody(body), "Hey!\n\nUpdated exercises below.\n\nKnee:\n3x/week\n- 10 wall sits");
  const reply = `Sounds good!

On Thu, Nov 12, 2026 at 1:37 PM Someone <a@example.com>
wrote:

> quoted text
> more`;
  assert.equal(P.cleanEmailBody(reply), "Sounds good!");
});

test("therapistMessages filters by sender, dedupes and sorts", () => {
  const threads = [
    { messages: [
      { id: "2", sender: "pat@clinic.com", date: "2026-11-11T10:00:00Z", subject: "Update", plaintextBody: "New list" },
      { id: "3", sender: "me@example.com", date: "2026-11-12T10:00:00Z", plaintextBody: "Thanks" },
    ] },
    { messages: [
      { id: "1", sender: "Pat@Clinic.com", date: "2026-11-01T10:00:00Z", subject: "First", plaintextBody: "Old list" },
      { id: "2", sender: "pat@clinic.com", date: "2026-11-11T10:00:00Z", plaintextBody: "New list" },
    ] },
  ];
  const msgs = P.therapistMessages(threads, "pat@clinic.com");
  assert.deepEqual(msgs.map((m) => m.id), ["1", "2"]);
});

test("cleanExercise normalises and rejects", () => {
  assert.equal(P.cleanExercise({ name: "  " }), null);
  assert.deepEqual(P.cleanExercise({ name: "Wall sit", perWeek: 9, sets: "3", reps: 10, weight: "0", video: "javascript:x" }), {
    name: "Wall sit", area: "Other", perWeek: 7, sets: 3, reps: "10", weight: null, video: "", note: "",
  });
});

test("diffPlan and mergePlan match by name and keep ids", () => {
  const current = [ex("a", "Wall sit"), ex("b", "Calf raise", 7, 2), ex("c", "Old move")];
  const proposed = [
    P.cleanExercise({ name: "wall sit", area: "Knee", perWeek: 3, sets: 3, reps: "10" }),
    P.cleanExercise({ name: "Calf Raise", area: "Knee", perWeek: 7, sets: 3, reps: "10" }),
    P.cleanExercise({ name: "Step down", area: "Knee", perWeek: 3, sets: 3, reps: "8" }),
  ];
  const d = P.diffPlan(current, proposed);
  assert.deepEqual(d.added.map((e) => e.name), ["Step down"]);
  assert.deepEqual(d.removed.map((e) => e.name), ["Old move"]);
  assert.deepEqual(d.changed.map((c) => [c.exercise.id, c.fields.map((f) => f.field)]), [["b", ["sets"]]]);
  assert.equal(d.unchanged, 1);
  let n = 0;
  const merged = P.mergePlan(current, proposed, () => `new${++n}`);
  assert.deepEqual(merged.map((e) => e.id), ["a", "b", "new1"]);
});

test("planPrompt and readPlanReply", () => {
  const prompt = P.planPrompt([ex("a", "Wall sit")], [{ date: "2026-11-11", subject: "Update", body: "Knee: daily" }]);
  assert.match(prompt, /Wall sit/);
  assert.match(prompt, /Email 1 · 2026-11-11 · Update/);
  assert.throws(() => P.readPlanReply({ exercises: [] }), /didn't return/);
  const r = P.readPlanReply({ exercises: [{ name: "Wall sit", perWeek: 7 }], changes: ["Wall sit now daily"] });
  assert.equal(r.exercises[0].perWeek, 7);
  assert.deepEqual(r.changes, ["Wall sit now daily"]);
});
