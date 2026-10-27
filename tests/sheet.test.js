import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCSV, sheetIdFromUrl, findWeekColumns, readWorkout, diffWorkout } from "../js/sheet.js";

// Same layout as the program tab: guide rows, week headers on one row, field
// labels under them (Week 0's labels sit on the "Day N" row), then day blocks.
const CSV = [
  ",,📕 WARM UP GUIDE,,,,,,,,,,,,,,",
  ",,,,,,,Week 1 ,,,,,Week 6 (DELOAD),,,,",
  " ,,Week 0,,,,,Sets,Weight,RIR,Actual Reps,,Sets,Weight,Reps,,",
  "Day 1 | Legs,Rep Range,Sets,RIR,Weight,Actual Reps,,,,,,,,,,,",
  'Smith Machine Squat,5-10,2,4-5/fail,75,10,,3,75,3/fail,"9,9,9",,2,70,half of last week,,',
  "Cable Crunch,8-15,2,4-5/fail,40,10,,2,40,2/fail,,,2,0,half of last week,,",
  ",,,,,,,,,,,,,,,,",
  ",,,,,,,Sets,Weight,RIR,Actual Reps,,Sets,Weight,Reps,,",
  "Day 2 | Chest/Back,Rep Range,Sets,RIR,Weight,Actual Reps,,,,,,,,,,,",
  "Neutral Grip DB Bench,5-10,2,4-5/fail,60,10,,4,,2/fail,,,2,0,half of last week,,",
  ",,,,,,,,,,,,,,,,",
  "REST DAY,,,,,,,,,,,,,,,,",
].join("\r\n");

test("parseCSV handles quotes and CRLF", () => {
  const rows = parseCSV('a,"b,c","say ""hi"""\r\n1,,3');
  assert.deepEqual(rows, [["a", "b,c", 'say "hi"'], ["1", "", "3"]]);
});

test("sheetIdFromUrl", () => {
  const id = "1dbJNCijsj1daoqF02FUQ4iL1BvpXl4E-LkhwjTSlko8";
  assert.equal(sheetIdFromUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), id);
  assert.equal(sheetIdFromUrl(id), id);
  assert.equal(sheetIdFromUrl("not a link"), null);
});

test("findWeekColumns reads the header labels", () => {
  const weeks = findWeekColumns(parseCSV(CSV));
  assert.deepEqual(weeks.get(0), { sets: 2, rir: 3, weight: 4 });
  assert.deepEqual(weeks.get(1), { sets: 7, weight: 8, rir: 9 });
  assert.deepEqual(weeks.get(6), { sets: 12, weight: 13, reps: 14 });
});

test("readWorkout extracts one week/day", () => {
  const rows = parseCSV(CSV);
  const w1 = readWorkout(rows, { weekNumber: 1, dayName: "Day 1", dayIndex: 0 });
  assert.equal(w1.focus, "Legs");
  assert.deepEqual(w1.exercises[0], { name: "Smith Machine Squat", repRange: "5-10", target: { sets: 3, weight: 75, rir: "3/fail", reps: undefined } });
  // Week 1 has no RIR blank here, but Cable Crunch's actual reps are blank; targets unaffected.
  assert.deepEqual(w1.exercises[1].target, { sets: 2, weight: 40, rir: "2/fail", reps: undefined });
  const w0 = readWorkout(rows, { weekNumber: 0, dayName: "Day 1", dayIndex: 0 });
  assert.deepEqual(w0.exercises[1].target, { sets: 2, weight: 40, rir: "4-5/fail", reps: undefined });
  const deload = readWorkout(rows, { weekNumber: 6, dayName: "Day 1" });
  assert.equal(deload.exercises[1].target.weight, null, "0 is a blank placeholder");
  assert.equal(deload.exercises[1].target.rir, undefined, "deload has no RIR column");
  assert.equal(deload.exercises[1].target.reps, "half of last week");
  // A day block ends at the first blank row, so REST DAY isn't an exercise.
  const d2 = readWorkout(rows, { weekNumber: 1, dayName: "Day 2" });
  assert.equal(d2.exercises.length, 1);
  assert.equal(d2.exercises[0].name, "Neutral Grip DB Bench");
  assert.equal(d2.exercises[0].target.weight, null, "blank cell clears the target");
  assert.throws(() => readWorkout(rows, { weekNumber: 9, dayName: "Day 1" }), /Week 9/);
  assert.throws(() => readWorkout(rows, { weekNumber: 1, dayName: "Day 7", dayIndex: 6 }), /Day 7/);
});

test("diffWorkout lists changed fields and new exercises", () => {
  const rows = parseCSV(CSV);
  const sheet = readWorkout(rows, { weekNumber: 1, dayName: "Day 1" });
  const app = [{ id: "a", name: "Smith Machine Squat", repRange: "5-10" }];
  const diff = diffWorkout(app, { a: { sets: 3, weight: 80, rir: "3/fail" } }, sheet);
  assert.deepEqual(diff[0].changes, [{ field: "weight", from: 80, to: 75 }]);
  const d2 = readWorkout(rows, { weekNumber: 1, dayName: "Day 2" });
  const cleared = diffWorkout([{ id: "b", name: "Neutral Grip DB Bench", repRange: "5-10" }], { b: { sets: 4, weight: 85, rir: "2/fail" } }, d2);
  assert.deepEqual(cleared[0].changes, [{ field: "weight", from: 85, to: null }]);
  const unchanged = diffWorkout([{ id: "b", name: "Neutral Grip DB Bench", repRange: "5-10" }], { b: { sets: 4, rir: "2/fail" } }, d2);
  assert.deepEqual(unchanged[0].changes, [], "blank vs missing is no change");
  assert.equal(diff[1].exercise, null);
  assert.ok(diff[1].changes.some((c) => c.field === "name" && c.to === "Cable Crunch"));
});
