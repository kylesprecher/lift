// Reading workout targets back out of the program spreadsheet (exported as
// CSV). Columns are found from the sheet's own headers ("Week 3", then
// "Sets / Weight / RIR / Actual Reps" under it) and days from "Day N | Focus"
// rows, so the import keeps working if rows or columns move.

/** RFC 4180 CSV -> array of rows (arrays of strings). */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Spreadsheet id from a Google Sheets link, or the id itself. */
export function sheetIdFromUrl(text) {
  const s = String(text ?? "").trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

const cell = (rows, r, c) => String(rows[r]?.[c] ?? "").trim();
const DAY_RE = /^(Day\s*\d+)\s*\|\s*(.*)$/i;

// Cell values: null = the column exists but the cell is blank (clear the
// target); undefined = the sheet has no such column for that week (leave it).
function num(text) {
  const n = Number(text);
  // The sheet uses 0 as a "not set yet" placeholder for weights.
  return text !== "" && Number.isFinite(n) && n !== 0 ? n : null;
}

/** Map of week number -> {sets, weight, rir, reps} column indexes. */
export function findWeekColumns(rows) {
  const weeks = new Map();
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const m = String(value).trim().match(/^Week\s+(\d+)\b/i);
      if (!m || weeks.has(Number(m[1]))) return;
      const cols = {};
      // Field labels sit on the row below the week header, starting at its column.
      for (let k = 0; k < 5; k++) {
        const label = cell(rows, r + 1, c + k).toLowerCase();
        if (label === "sets") cols.sets = c + k;
        else if (label === "weight") cols.weight = c + k;
        else if (label === "rir") cols.rir = c + k;
        else if (label === "reps") cols.reps = c + k;
      }
      if (cols.sets != null || cols.weight != null) weeks.set(Number(m[1]), cols);
    });
  });
  return weeks;
}

/** Day blocks in sheet order: [{name, focus, rows: [row indexes]}]. */
export function findDays(rows) {
  const days = [];
  rows.forEach((row, r) => {
    const m = cell(rows, r, 0).match(DAY_RE);
    if (!m) return;
    const exerciseRows = [];
    for (let x = r + 1; x < rows.length; x++) {
      const name = cell(rows, x, 0);
      if (!name || DAY_RE.test(name)) break;
      exerciseRows.push(x);
    }
    days.push({ name: m[1].replace(/\s+/g, " "), focus: m[2].trim(), rows: exerciseRows });
  });
  return days;
}

/**
 * Targets for one workout. `dayName` ("Day 2") is matched first, then
 * `dayIndex` (0-based position). Throws an Error with a readable message
 * when the sheet doesn't have that week or day.
 */
export function readWorkout(rows, { weekNumber, dayName, dayIndex }) {
  const cols = findWeekColumns(rows).get(weekNumber);
  if (!cols) throw new Error(`Week ${weekNumber} isn't in the spreadsheet.`);
  const days = findDays(rows);
  if (!days.length) throw new Error("No “Day N | …” rows found. Is the program the first tab of the sheet?");
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const day = days.find((d) => norm(d.name) === norm(dayName)) ?? days[dayIndex];
  if (!day) throw new Error(`${dayName ?? `Day ${dayIndex + 1}`} isn't in the spreadsheet.`);
  return {
    name: day.name,
    focus: day.focus,
    exercises: day.rows.map((r) => {
      const read = (col, parse) => (col == null ? undefined : parse(cell(rows, r, col)));
      const text = (v) => v || null;
      const t = {
        sets: read(cols.sets, num),
        weight: read(cols.weight, num),
        rir: read(cols.rir, text),
        reps: read(cols.reps, text),
      };
      return { name: cell(rows, r, 0), repRange: cell(rows, r, 1) || null, target: t };
    }),
  };
}

/**
 * Compare the app's exercises for a day with the sheet's, by position.
 * Returns [{index, exercise (app, or null when new), sheet, changes: [{field, from, to}]}].
 */
export function diffWorkout(appExercises, appTargets, sheetWorkout) {
  return sheetWorkout.exercises.map((s, index) => {
    const ex = appExercises[index] ?? null;
    const t = (ex && appTargets[ex.id]) || {};
    const changes = [];
    const check = (field, from, to) => {
      if (to === undefined) return;
      if (String(from ?? "") !== String(to ?? "")) changes.push({ field, from, to });
    };
    check("name", ex?.name, s.name);
    check("repRange", ex?.repRange, s.repRange);
    check("sets", t.sets, s.target.sets);
    check("weight", t.weight, s.target.weight);
    check("rir", t.rir, s.target.rir);
    check("reps", t.reps, s.target.reps);
    return { index, exercise: ex, sheet: s, changes };
  });
}
