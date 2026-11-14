import * as L from "./logic.js";
import { load, save, freshState, migrate } from "./store.js";
import { lineChart, columnChart } from "./charts.js";
import * as cloud from "./cloud.js";
import * as chime from "./chime.js";
import * as sheet from "./sheet.js";
import * as PT from "./pt.js";

let state = load();
const ui = { view: "workout", weekId: null, dayId: null, exerciseId: null };
const main = document.getElementById("main");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const unit = () => state.program.unit || "lb";
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const shortDate = (iso) =>
  L.toDate(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const weekById = (id) => state.program.weeks.find((w) => w.id === id);
const dayById = (id) => state.program.days.find((d) => d.id === id);
const weekLabel = (w) => `${w.label}${w.deload ? " (Deload)" : ""}`;
const dayLabel = (d) => `${d.name}${d.focus ? ` · ${d.focus}` : ""}`;
const target = (weekId, exId) => state.program.targets?.[weekId]?.[exId] ?? {};
const getLog = (weekId, exId) => state.logs?.[weekId]?.[exId];

function persist() {
  state.updatedAt = Date.now();
  if (!save(state) && !cloudOn) toast("Couldn't save — storage may be full or blocked.");
  cloud.push(state);
}

/**
 * In-page replacement for prompt()/confirm() (which hosted pages can't use).
 * Resolves the field values as an object, or null when cancelled.
 */
function ask({ title, message = "", fields = [], ok = "OK", danger = false, info = false }) {
  const dlg = document.getElementById("ask-dialog");
  const form = dlg.querySelector("form");
  form.innerHTML = `
    <h2>${esc(title)}</h2>
    ${message ? `<p class="muted">${esc(message)}</p>` : ""}
    ${fields
      .map(
        (f) => `<label class="field"><span>${esc(f.label)}</span>${
          f.multiline
            ? `<textarea id="ask-${f.name}" name="${f.name}" rows="3" placeholder="${esc(f.placeholder ?? "")}">${esc(f.value ?? "")}</textarea>`
            : `<input id="ask-${f.name}" name="${f.name}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder ?? "")}" ${f.required ? "required" : ""}>`
        }</label>`
      )
      .join("")}
    <div class="dialog-actions">
      <span class="spacer"></span>
      ${info ? "" : `<button type="button" class="secondary" data-cancel>Cancel</button>`}
      <button type="submit" class="${danger ? "danger" : "primary"}">${esc(ok)}</button>
    </div>`;
  return new Promise((resolve) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      const values = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
      resolve(values);
      dlg.close();
    };
    const cancel = form.querySelector("[data-cancel]");
    if (cancel) cancel.onclick = () => dlg.close();
    dlg.onclose = () => resolve(null);
    dlg.showModal();
    form.querySelector("input, textarea")?.focus();
  });
}

/** Show text with Copy and Save buttons (export/backup). */
function showText(title, text, filename, type) {
  const dlg = document.getElementById("ask-dialog");
  const form = dlg.querySelector("form");
  form.innerHTML = `
    <h2>${esc(title)}</h2>
    <textarea id="export-text" class="export" rows="10" readonly>${esc(text)}</textarea>
    <div class="dialog-actions">
      <button type="button" class="secondary" data-x="save">Save file</button>
      <button type="button" class="secondary" data-x="copy">Copy</button>
      <span class="spacer"></span>
      <button type="button" class="primary" data-x="close">Done</button>
    </div>`;
  form.onsubmit = (e) => e.preventDefault();
  form.onclick = async (e) => {
    const x = e.target.closest("[data-x]")?.dataset.x;
    if (x === "close") dlg.close();
    if (x === "copy") {
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied");
      } catch {
        const area = form.querySelector("textarea");
        area.focus();
        area.select();
        toast("Select all and copy");
      }
    }
    if (x === "save") saveFile(filename, text, type);
  };
  dlg.showModal();
}

async function saveFile(filename, text, type) {
  const downloads = window.claude?.use ? await window.claude.use("downloads") : null;
  if (downloads) {
    try {
      const result = await downloads.save({ filename, data: text });
      if (result === "saved") toast(`Saved ${filename}`);
    } catch (err) {
      if (err?.code !== "declined") toast("Couldn't save the file — use Copy instead.");
    }
    return;
  }
  if (window.claude) {
    toast("Saving files isn't available here — use Copy instead.");
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

// ------------------------------------------------------------------ routing

const VIEWS = ["workout", "program", "progress", "body", "pt", "data"];

// Views are plain `#token` links so they also work when the app is hosted
// as an Artifact; the selected week/day lives in `ui`, not the URL.
function route() {
  const token = location.hash.replace(/^#\/?/, "").split("/")[0];
  ui.view = VIEWS.includes(token) ? token : "workout";
  if (!weekById(ui.weekId) || !dayById(ui.dayId)) {
    const next = L.nextSession(state) ?? L.allSessions(state.program).at(-1);
    ui.weekId = next.week.id;
    ui.dayId = next.day.id;
  }
  document.querySelectorAll("nav.tabs a").forEach((link) => {
    if (link.dataset.view === ui.view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  render();
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function openSession(weekId, dayId) {
  ui.weekId = weekId;
  ui.dayId = dayId;
  go("#workout");
}

// ------------------------------------------------------------------ appearance

/** Is the page showing dark colors right now (app choice, then host, then system)? */
function isDark() {
  const choice = state.settings.theme;
  if (choice === "dark" || choice === "light") return choice === "dark";
  const host = document.documentElement.dataset.theme;
  if (host === "dark" || host === "light") return host === "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme() {
  const choice = state.settings.theme;
  const root = document.documentElement;
  if (choice === "dark" || choice === "light") root.dataset.liftTheme = choice;
  else delete root.dataset.liftTheme;
  const dark = isDark();
  const btn = document.getElementById("theme-toggle");
  btn.textContent = dark ? "☀" : "☾";
  btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  btn.title = btn.getAttribute("aria-label");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0d0d0d" : "#f9f9f7");
}

document.getElementById("theme-toggle").addEventListener("click", () => {
  state.settings.theme = isDark() ? "light" : "dark";
  persist();
  applyTheme();
  if (ui.view === "data") render();
});
// Keep the button's icon right when the system or Claude's theme changes.
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

function render() {
  applyTheme();
  const views = { workout: renderWorkout, program: renderProgram, progress: renderProgress, body: renderBody, pt: renderPT, data: renderSettings };
  views[ui.view]();
  main.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ workout

function renderWorkout() {
  const week = weekById(ui.weekId);
  const day = dayById(ui.dayId);
  const key = L.sessionKey(week.id, day.id);
  const session = state.sessions[key];
  const prog = L.sessionProgress(state, week.id, day.id);

  main.innerHTML = `
    ${restBar()}
    <section class="session-picker">
      <label class="field inline">
        <span>Week</span>
        <select id="week-select">
          ${state.program.weeks
            .map((w) => {
              const done = state.program.days.every((d) => L.isSessionComplete(state, w.id, d.id));
              return `<option value="${w.id}" ${w.id === week.id ? "selected" : ""}>${esc(weekLabel(w))}${done ? " ✓" : ""}</option>`;
            })
            .join("")}
        </select>
      </label>
      <div class="day-tabs" role="tablist">
        ${state.program.days
          .map(
            (d) => `<button role="tab" data-day="${d.id}" aria-selected="${d.id === day.id}" class="${
              L.isSessionComplete(state, week.id, d.id) ? "complete" : ""
            }"><b>${esc(d.name)}</b><small>${esc(d.focus ?? "")}</small></button>`
          )
          .join("")}
      </div>
    </section>

    <section class="session-summary">
      <h2>${esc(weekLabel(week))} · ${esc(dayLabel(day))}</h2>
      <div class="meter" aria-label="Sets completed"><span style="width:${Math.round(prog.pct * 100)}%"></span></div>
      <p class="muted" id="session-count">${prog.done} of ${prog.planned} sets logged${
        session?.completed ? ` · completed${session.date ? ` ${shortDate(session.date)}` : ""}` : ""
      }</p>
      ${week.deload ? `<p class="banner">Deload week — lighter weights and about half of last week's reps. Leave plenty in the tank.</p>` : ""}
      ${week.note ? `<p class="banner">${esc(week.note)}</p>` : ""}
      <div class="row-actions">
        <button class="ghost" data-action="import-sheet" id="import-sheet">↻ Update targets from sheet</button>
      </div>
    </section>

    <div class="exercises">
      ${day.exercises.map((ex) => exerciseCard(week, ex)).join("") || `<p class="empty">No exercises on this day yet — add some from the Program tab.</p>`}
    </div>

    ${summaryCard(week, day)}

    <div class="session-actions">
      ${
        session?.completed
          ? `<button class="secondary" data-action="reopen">Mark as not done</button>`
          : `<button class="primary" data-action="finish">Finish workout</button>`
      }
    </div>`;
}

function exerciseCard(week, ex) {
  const t = target(week.id, ex.id);
  const log = getLog(week.id, ex.id);
  const sets = L.initialSets(t, log);
  const prev = L.previousLog(state, week.id, ex.id);
  const advice = L.progressionAdvice(ex.repRange, log, t.sets);
  const targetBits = [
    t.sets ? `${t.sets} sets` : null,
    ex.repRange ? `${esc(ex.repRange)} reps` : null,
    t.reps ? esc(t.reps) : null,
    t.weight != null ? `${L.fmt(t.weight)} ${unit()}` : null,
    t.rir ? `RIR ${esc(t.rir)}` : null,
  ].filter(Boolean);
  return `
    <article class="card exercise" data-ex="${ex.id}">
      <header>
        <h3>${esc(ex.name)}</h3>
        ${ex.video ? `<a class="video" href="${esc(ex.video)}" target="_blank" rel="noopener">Form video ↗</a>` : ""}
      </header>
      <p class="target"><span class="label">Target</span> ${targetBits.join(" · ") || "—"}</p>
      ${prev ? `<p class="prev"><span class="label">${esc(prev.week.label)}</span> ${esc(L.formatLog(prev.log, unit()))}</p>` : ""}
      ${ex.note ? `<p class="note">${esc(ex.note)}</p>` : ""}
      <table class="sets">
        <thead><tr><th>Set</th><th>Weight (${unit()})</th><th>Reps</th><th><span class="sr-only">Done</span></th></tr></thead>
        <tbody>
          ${sets
            .map(
              (s, i) => `
            <tr class="${s.done ? "done" : ""}">
              <td>${i + 1}</td>
              <td><input type="number" inputmode="decimal" step="any" min="0" data-field="weight" data-i="${i}" value="${esc(s.weight)}" aria-label="Set ${i + 1} weight"></td>
              <td><input type="number" inputmode="numeric" min="0" data-field="reps" data-i="${i}" value="${esc(s.reps)}" placeholder="${esc(repPlaceholder(ex, t))}" aria-label="Set ${i + 1} reps"></td>
              <td><button class="check" data-action="toggle-set" data-i="${i}" aria-pressed="${!!s.done}" aria-label="Mark set ${i + 1} done">✓</button></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <div class="row-actions">
        <button class="ghost" data-action="add-set">+ Set</button>
        <button class="ghost" data-action="remove-set" ${sets.length <= 1 ? "disabled" : ""}>− Set</button>
        <button class="ghost" data-action="edit-note">${log?.note ? "Edit note" : "Add note"}</button>
      </div>
      ${log?.note ? `<p class="log-note">“${esc(log.note)}”</p>` : ""}
      ${advice ? `<p class="advice ${advice.kind}">${esc(advice.text)}</p>` : ""}
    </article>`;
}

function repPlaceholder(ex, t) {
  const r = L.parseRepRange(ex.repRange);
  return r ? `${r.min}–${r.max}` : t.reps ? "" : "reps";
}

/** Reps to assume when a set is ticked without entering any: the previous set, then last week's same set, then the bottom of the range. */
function defaultReps(exId, log, i) {
  const before = log.sets.slice(0, i).reverse().find((s) => Number(s.reps) > 0);
  if (before) return before.reps;
  const prev = L.previousLog(state, ui.weekId, exId);
  const prevSets = L.performedSets(prev?.log);
  if (prevSets.length) return (prevSets[i] ?? prevSets.at(-1)).reps;
  return L.parseRepRange(L.findExercise(state.program, exId).exercise.repRange)?.min ?? "";
}

/** Make sure a log exists for (week, exercise) so edits have somewhere to go. */
function ensureLog(weekId, exId) {
  state.logs[weekId] ??= {};
  const existing = state.logs[weekId][exId];
  if (!existing?.sets?.length) {
    state.logs[weekId][exId] = { ...existing, sets: L.initialSets(target(weekId, exId), null) };
  }
  return state.logs[weekId][exId];
}

function refreshCard(exId) {
  const card = main.querySelector(`.exercise[data-ex="${exId}"]`);
  const ex = L.findExercise(state.program, exId).exercise;
  card.outerHTML = exerciseCard(weekById(ui.weekId), ex);
  refreshSessionMeta();
}

// ------------------------------------------------------------------ summary for the sheet

/** Weight(s) of the completed sets: "85" or "85/80" when they differ. */
function weightsText(log) {
  const ws = [...new Set(L.performedSets(log).map((s) => Number(s.weight) || 0))];
  return ws.length ? `${ws.map((w) => L.fmt(w)).join("/")} ${unit()}` : "";
}

function summaryCard(week, day) {
  const logs = state.logs[week.id] ?? {};
  const block = L.sheetPasteBlock(week, day, logs);
  const any = day.exercises.some((ex) => L.performedSets(logs[ex.id]).length);
  return `
    <section class="card summary" id="summary">
      <h3>Summary for your sheet</h3>
      <div class="table-scroll">
        <table class="data">
          <thead><tr><th>Exercise</th><th class="num">Weight</th><th>Reps</th></tr></thead>
          <tbody>${day.exercises
            .map((ex) => {
              const reps = L.repsText(logs[ex.id]);
              return `<tr><td class="wrap">${esc(ex.name)}</td><td class="num">${esc(weightsText(logs[ex.id])) || '<span class="muted">—</span>'}</td><td class="reps">${
                reps ? esc(reps) : '<span class="muted">—</span>'
              }</td></tr>`;
            })
            .join("")}</tbody>
        </table>
      </div>
      ${
        block.cell
          ? `<p class="muted small">In the sheet, click cell <b>${block.cell}</b> (${esc(week.label)} · ${week.deload ? "Reps" : "Actual Reps"}) and paste. Each exercise lands on its own row.</p>`
          : `<p class="muted small">Click the first exercise's Actual Reps cell for ${esc(week.label)} in the sheet and paste.</p>`
      }
      ${block.missing.length ? `<p class="muted small">Not in the sheet, so not copied: ${esc(block.missing.join(", "))}.</p>` : ""}
      <div class="row-actions">
        <button class="primary" data-action="copy-reps" ${any ? "" : "disabled"}>Copy reps for sheet</button>
        <button class="secondary" data-action="copy-summary" ${any ? "" : "disabled"}>Copy full summary</button>
      </div>
    </section>`;
}

function summaryText(week, day) {
  const logs = state.logs[week.id] ?? {};
  const lines = day.exercises
    .filter((ex) => L.performedSets(logs[ex.id]).length)
    .map((ex) => `${ex.name}: ${weightsText(logs[ex.id])} × ${L.repsText(logs[ex.id])}`);
  return [`${weekLabel(week)} · ${dayLabel(day)}`, ...lines].join("\n");
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    // Clipboard refused (some app views): show the text to copy by hand.
    showText(what, text, "lift-summary.txt", "text/plain");
  }
}

function refreshSummary() {
  const card = main.querySelector("#summary");
  if (card) card.outerHTML = summaryCard(weekById(ui.weekId), dayById(ui.dayId));
}

function refreshSessionMeta() {
  refreshSummary();
  const prog = L.sessionProgress(state, ui.weekId, ui.dayId);
  main.querySelector(".meter span").style.width = `${Math.round(prog.pct * 100)}%`;
  const session = state.sessions[L.sessionKey(ui.weekId, ui.dayId)];
  main.querySelector("#session-count").textContent = `${prog.done} of ${prog.planned} sets logged${
    session?.completed ? ` · completed${session.date ? ` ${shortDate(session.date)}` : ""}` : ""
  }`;
}

function onWorkoutChange(e) {
  if (e.target.id === "week-select") {
    openSession(e.target.value, ui.dayId);
    return;
  }
  const field = e.target.dataset.field;
  if (!field) return;
  const exId = e.target.closest(".exercise").dataset.ex;
  const log = ensureLog(ui.weekId, exId);
  const i = Number(e.target.dataset.i);
  const value = e.target.value === "" ? "" : Number(e.target.value);
  log.sets[i][field] = value;
  // A new weight carries forward to the sets that haven't been done yet.
  if (field === "weight") {
    const inputs = e.target.closest("tbody").querySelectorAll('input[data-field="weight"]');
    log.sets.forEach((s, j) => {
      if (j > i && !s.done) {
        s.weight = value;
        inputs[j].value = value;
      }
    });
  }
  // Only the ✓ button marks a set done or not done.
  persist();
  patchCard(exId);
}

/** Update a card's status bits without re-rendering its inputs (keeps focus). */
function patchCard(exId) {
  const card = main.querySelector(`.exercise[data-ex="${exId}"]`);
  const ex = L.findExercise(state.program, exId).exercise;
  const log = getLog(ui.weekId, exId);
  card.querySelectorAll("tbody tr").forEach((row, i) => {
    const done = !!log.sets[i]?.done;
    row.classList.toggle("done", done);
    row.querySelector(".check").setAttribute("aria-pressed", done);
  });
  const advice = L.progressionAdvice(ex.repRange, log, target(ui.weekId, exId).sets);
  card.querySelector(".advice")?.remove();
  if (advice) card.insertAdjacentHTML("beforeend", `<p class="advice ${advice.kind}">${esc(advice.text)}</p>`);
  refreshSessionMeta();
}

// ------------------------------------------------------------------ import from sheet

const FIELD_NAMES = { name: "Name", repRange: "Rep range", sets: "Sets", weight: "Weight", rir: "RIR", reps: "Reps" };

async function importFromSheet() {
  const week = weekById(ui.weekId);
  const day = dayById(ui.dayId);
  const weekNumber = Number(week.label.match(/Week\s+(\d+)/i)?.[1]);
  if (!Number.isFinite(weekNumber)) {
    ask({ title: "Can't match this week", message: `“${week.label}” has no week number to look up in the sheet.`, info: true });
    return;
  }
  const btn = document.getElementById("import-sheet");
  btn.disabled = true;
  btn.textContent = "Reading sheet…";
  let result;
  try {
    result = await readSheetFromDrive();
  } finally {
    btn.disabled = false;
    btn.textContent = "↻ Update targets from sheet";
  }
  if (result.text) {
    previewImport(result.text, week, day, weekNumber);
    return;
  }
  // No Drive access here (or it failed): offer a downloaded CSV instead.
  pickCSV(week, day, weekNumber, result.error);
}

/** Export the linked sheet's first tab as CSV through the viewer's Google Drive connector. */
async function readSheetFromDrive() {
  const mcp = window.claude?.use ? await window.claude.use("mcp") : null;
  if (!mcp) return {};
  const fileId = state.program.sheetId;
  if (!fileId) return { error: "No spreadsheet is linked yet. Add its link under Data → Spreadsheet." };
  const input = { fileId, exportMimeType: "text/csv" };
  const call = () => mcp.callTool("Google Drive", "download_file_content", input, { cache: false });
  let res;
  try {
    res = await call();
  } catch (err) {
    // A read is safe to retry once when the platform says so.
    if (!err?.retryable) return { error: driveError(err) };
    await new Promise((r) => setTimeout(r, err.retryAfterMs ?? 800 + Math.random() * 700));
    try {
      res = await call();
    } catch (err2) {
      return { error: driveError(err2) };
    }
  }
  const content = res?.payload && typeof res.payload === "object" ? res.payload.content : null;
  if (typeof content !== "string") return { error: "Google Drive sent back something unexpected." };
  try {
    const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    return { text: new TextDecoder().decode(bytes).replace(/^\uFEFF/, "") };
  } catch {
    return { error: "Google Drive sent back something unexpected." };
  }
}

function driveError(err) {
  switch (err?.code) {
    case "server_not_connected":
    case "server_not_found":
      return "Google Drive isn't connected. Add it in claude.ai Settings → Connectors, then try again.";
    case "needs_reauth":
      return "Google Drive needs to be reconnected. Reconnect it in claude.ai Settings → Connectors, then try again.";
    case "selection_required":
      return "You have more than one Google Drive connected. Pick one when Claude asks, then try again.";
    case "approval_required":
    case "not_in_manifest":
    case "consent_required":
      return "Lift needs your permission to read Google Drive. Tap Update again and choose Allow.";
    case "blocked_by_policy":
      return "Your organization doesn't allow Lift to use Google Drive.";
    case "tool_error":
      return "Google Drive couldn't export the sheet. Check the sheet link under Data → Spreadsheet.";
    case "server_unavailable":
      return "Google Drive didn't respond. Try again in a moment.";
    default:
      return "Couldn't read the sheet from Google Drive.";
  }
}

function pickCSV(week, day, weekNumber, error) {
  const dlg = document.getElementById("ask-dialog");
  const form = dlg.querySelector("form");
  form.innerHTML = `
    <h2>Update from a CSV file</h2>
    ${error ? `<p class="banner">${esc(error)}</p>` : ""}
    <p class="muted">In Google Sheets, open the program tab and choose <b>File → Download → Comma-separated values (.csv)</b>. Then pick that file here.</p>
    <label class="button secondary">Choose CSV file<input type="file" accept=".csv,text/csv" id="sheet-csv" hidden></label>
    <div class="dialog-actions"><span class="spacer"></span><button type="button" class="secondary" data-cancel>Cancel</button></div>`;
  form.onsubmit = (e) => e.preventDefault();
  form.querySelector("[data-cancel]").onclick = () => dlg.close();
  form.querySelector("#sheet-csv").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    dlg.close();
    previewImport(text, week, day, weekNumber);
  };
  dlg.onclose = null;
  dlg.showModal();
}

function previewImport(text, week, day, weekNumber) {
  let workout;
  try {
    workout = sheet.readWorkout(sheet.parseCSV(text), { weekNumber, dayName: day.name, dayIndex: state.program.days.indexOf(day) });
  } catch (err) {
    ask({ title: "Couldn't read the sheet", message: err.message, info: true });
    return;
  }
  const diff = sheet.diffWorkout(day.exercises, state.program.targets[week.id] ?? {}, workout);
  const changed = diff.filter((d) => d.changes.length);
  const leftOver = day.exercises.length - workout.exercises.length;
  if (!changed.length) {
    if (syncSheetPositions(week, day, workout)) {
      persist();
      render();
    }
    toast(`${weekLabel(week)} · ${day.name} already matches the sheet`);
    return;
  }
  const show = (field, v) => (v == null || v === "" ? "—" : field === "weight" ? `${L.fmt(v)} ${unit()}` : esc(v));
  const dlg = document.getElementById("ask-dialog");
  const form = dlg.querySelector("form");
  form.innerHTML = `
    <h2>Update ${esc(weekLabel(week))} · ${esc(day.name)}</h2>
    <p class="muted">These targets differ from the sheet. Logged sets aren't changed.</p>
    <ul class="import-list">
      ${changed
        .map(
          (d) => `<li>
            <b>${esc(d.sheet.name)}</b>${d.exercise ? "" : ' <span class="pill">New</span>'}
            <ul>${d.changes
              .filter((c) => d.exercise || c.field !== "name")
              .map((c) => `<li>${FIELD_NAMES[c.field]}: ${d.exercise ? `<s>${show(c.field, c.from)}</s> → ` : ""}${show(c.field, c.to)}</li>`)
              .join("")}</ul>
          </li>`
        )
        .join("")}
    </ul>
    ${leftOver > 0 ? `<p class="muted small">${leftOver} exercise${leftOver > 1 ? "s" : ""} in the app aren't in the sheet and will be left as they are.</p>` : ""}
    <div class="dialog-actions">
      <span class="spacer"></span>
      <button type="button" class="secondary" data-cancel>Cancel</button>
      <button type="submit" class="primary">Apply ${changed.length} update${changed.length > 1 ? "s" : ""}</button>
    </div>`;
  form.querySelector("[data-cancel]").onclick = () => dlg.close();
  dlg.onclose = null;
  form.onsubmit = (e) => {
    e.preventDefault();
    applyImport(week, day, changed);
    syncSheetPositions(week, day, workout);
    persist();
    render();
    dlg.close();
  };
  dlg.showModal();
}

/** Remember where this day's rows and this week's reps column are in the sheet. Returns true if anything moved. */
function syncSheetPositions(week, day, workout) {
  let moved = false;
  workout.exercises.forEach((e, i) => {
    const ex = day.exercises[i];
    if (ex && ex.sheetRow !== e.row) {
      ex.sheetRow = e.row;
      moved = true;
    }
  });
  if (workout.repsCol && week.sheetRepsCol !== workout.repsCol) {
    week.sheetRepsCol = workout.repsCol;
    moved = true;
  }
  return moved;
}

function applyImport(week, day, changed) {
  const targets = (state.program.targets[week.id] ??= {});
  for (const d of changed) {
    let ex = d.exercise;
    if (!ex) {
      ex = { id: uid(`${day.id}e`), name: d.sheet.name };
      day.exercises.push(ex);
    }
    for (const c of d.changes) {
      if (c.field === "name" || c.field === "repRange") {
        if (c.to == null) delete ex[c.field];
        else ex[c.field] = c.to;
      } else {
        const t = { ...targets[ex.id] };
        if (c.to == null) delete t[c.field];
        else t[c.field] = c.to;
        targets[ex.id] = t;
      }
    }
    // Sets not started yet are rebuilt from the new targets.
    const log = state.logs[week.id]?.[ex.id];
    if (log && !log.sets?.some((s) => s.done) && !log.note) delete state.logs[week.id][ex.id];
  }
  persist();
  render();
  toast(`Updated ${changed.length} exercise${changed.length > 1 ? "s" : ""} from the sheet`);
}

function onWorkoutClick(e) {
  if (onRestClick(e)) return;
  const dayBtn = e.target.closest("[data-day]");
  if (dayBtn) {
    openSession(ui.weekId, dayBtn.dataset.day);
    return;
  }
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const key = L.sessionKey(ui.weekId, ui.dayId);

  if (action === "import-sheet") {
    importFromSheet();
    return;
  }
  if (action === "copy-reps" || action === "copy-summary") {
    const week = weekById(ui.weekId);
    const day = dayById(ui.dayId);
    if (action === "copy-reps") copyText(L.sheetPasteBlock(week, day, state.logs[week.id]).text, "Reps");
    else copyText(summaryText(week, day), "Summary");
    return;
  }
  if (action === "finish") {
    state.sessions[key] = { completed: true, date: today() };
    persist();
    const next = L.nextSession(state);
    if (next) {
      toast(`Workout saved. Next up: ${weekLabel(next.week)} · ${dayLabel(next.day)}`);
      openSession(next.week.id, next.day.id);
    } else {
      toast("Workout saved — that's the whole program done! 🎉");
      render();
    }
    return;
  }
  if (action === "reopen") {
    delete state.sessions[key];
    persist();
    render();
    return;
  }

  const card = btn.closest(".exercise");
  if (!card) return;
  const exId = card.dataset.ex;
  const t = target(ui.weekId, exId);
  const log = ensureLog(ui.weekId, exId);

  if (action === "toggle-set") {
    const s = log.sets[Number(btn.dataset.i)];
    s.done = !s.done;
    if (s.done) {
      if (s.weight === "" || s.weight == null) s.weight = t.weight ?? "";
      if (s.reps === "" || s.reps == null) s.reps = defaultReps(exId, log, Number(btn.dataset.i));
      if (state.settings.autoRest !== false) startRest({ restart: true });
    }
  } else if (action === "add-set") {
    const last = log.sets.at(-1);
    log.sets.push({ weight: last?.weight ?? t.weight ?? "", reps: "", done: false });
  } else if (action === "remove-set") {
    if (log.sets.length > 1) log.sets.pop();
  } else if (action === "edit-note") {
    ask({
      title: "Exercise note",
      fields: [{ name: "note", label: "How it felt, form cues, pain…", value: log.note ?? "", multiline: true }],
      ok: "Save note",
    }).then((r) => {
      if (!r) return;
      log.note = r.note || undefined;
      persist();
      refreshCard(exId);
    });
    return;
  }
  persist();
  refreshCard(exId);
}

// ------------------------------------------------------------------ rest timer

// The timer lives outside the view so it keeps running while you switch
// tabs; the bar at the top of the workout screen shows it.
const REST_MIN = 15;
const REST_MAX = 600;
const REST_STEP = 15;
// total = length in seconds of the current rest, for the progress bar.
const rest = { status: "idle", end: 0, remaining: 0, total: 0, timer: null, wakeLock: null };

const restDuration = () => Number(state.settings.restSeconds) || 180;
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

function restLeft() {
  if (rest.status === "running") return Math.max(0, Math.ceil((rest.end - Date.now()) / 1000));
  if (rest.status === "paused") return Math.ceil(rest.remaining / 1000);
  return restDuration();
}

function restBar() {
  return `
    <section class="rest-bar" id="rest-bar" data-status="${rest.status}" aria-label="Rest timer">
      <div class="rest-readout">
        <span class="rest-label">Rest</span>
        <b id="rest-time" role="timer">${clock(restLeft())}</b>
      </div>
      <div class="rest-adjust" role="group" aria-label="Change rest time">
        <button class="ghost" data-rest="minus" aria-label="15 seconds less">−15s</button>
        <button class="ghost" data-rest="plus" aria-label="15 seconds more">+15s</button>
      </div>
      <div class="rest-controls">
        <button class="rest-main" data-rest="toggle" id="rest-toggle">${restToggleLabel()}</button>
        <button class="ghost" data-rest="reset" aria-label="Reset timer" ${rest.status === "idle" ? "disabled" : ""}>Reset</button>
      </div>
      <div class="rest-track" aria-hidden="true"><span id="rest-progress"></span></div>
    </section>`;
}

const restToggleLabel = () => (rest.status === "running" ? "Pause" : rest.status === "paused" ? "Resume" : "Start");

function startRest({ restart = false } = {}) {
  chime.unlock(); // called from a tap, so sound is allowed later
  if (rest.status === "paused" && !restart) {
    rest.end = Date.now() + rest.remaining;
  } else {
    rest.total = restDuration();
    rest.end = Date.now() + rest.total * 1000;
  }
  rest.status = "running";
  clearInterval(rest.timer);
  rest.timer = setInterval(tickRest, 250);
  keepAwake(true);
  tickRest();
}

function pauseRest() {
  rest.remaining = Math.max(0, rest.end - Date.now());
  rest.status = "paused";
  clearInterval(rest.timer);
  keepAwake(false);
  tickRest();
}

function resetRest() {
  rest.status = "idle";
  clearInterval(rest.timer);
  keepAwake(false);
  tickRest();
}

function adjustRest(delta) {
  if (rest.status === "running") {
    rest.end = Math.max(Date.now() + 1000, rest.end + delta * 1000);
    rest.total = Math.max(rest.total + delta, restLeft());
  } else if (rest.status === "paused") {
    rest.remaining = Math.max(1000, rest.remaining + delta * 1000);
    rest.total = Math.max(rest.total + delta, restLeft());
  } else {
    // While idle the buttons change the saved duration.
    state.settings.restSeconds = Math.min(REST_MAX, Math.max(REST_MIN, restDuration() + delta));
    state.settings.restCustom = true;
    persist();
  }
  tickRest();
}

function tickRest() {
  const left = restLeft();
  if (rest.status === "running" && left === 0) return finishRest();
  const bar = document.getElementById("rest-bar");
  if (!bar) return;
  bar.dataset.status = rest.status;
  document.getElementById("rest-time").textContent = clock(left);
  document.getElementById("rest-toggle").textContent = restToggleLabel();
  bar.querySelector('[data-rest="reset"]').disabled = rest.status === "idle";
  const pct = rest.status === "idle" ? 0 : 1 - left / Math.max(rest.total, 1);
  document.getElementById("rest-progress").style.width = `${Math.round(pct * 100)}%`;
}

function finishRest() {
  resetRest();
  chime.play();
  navigator.vibrate?.([200, 100, 200]);
  toast("Rest's up — next set!");
  const bar = document.getElementById("rest-bar");
  if (bar) {
    bar.classList.remove("done");
    void bar.offsetWidth; // restart the flash animation
    bar.classList.add("done");
  }
}

/** Keep the screen on while resting so the chime isn't missed. Optional. */
async function keepAwake(on) {
  try {
    if (on && !rest.wakeLock && navigator.wakeLock) {
      rest.wakeLock = await navigator.wakeLock.request("screen");
      rest.wakeLock.addEventListener?.("release", () => (rest.wakeLock = null));
    } else if (!on && rest.wakeLock) {
      await rest.wakeLock.release();
      rest.wakeLock = null;
    }
  } catch {
    rest.wakeLock = null;
  }
}

function onRestClick(e) {
  const a = e.target.closest("[data-rest]")?.dataset.rest;
  if (!a) return false;
  if (a === "toggle") {
    if (rest.status === "running") pauseRest();
    else startRest();
  }
  if (a === "reset") resetRest();
  if (a === "minus") adjustRest(-REST_STEP);
  if (a === "plus") adjustRest(REST_STEP);
  return true;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (rest.status === "running") keepAwake(true);
    tickRest();
  }
});

// ------------------------------------------------------------------ program

function renderProgram() {
  const p = state.program;
  const guides = Object.entries(p.guides ?? {}).filter(([, url]) => url);
  const guideNames = { warmup: "Warm-up guide", rir: "Rep range & RIR explanation", cardio: "Cardio & step guide" };
  main.innerHTML = `
    <section class="page-head">
      <h2>${esc(p.name)}</h2>
      <p class="muted">${p.days.length} training days × ${p.weeks.length} weeks. Tap a cell to log that session.</p>
      ${guides.length ? `<p class="guides">${guides.map(([k, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(guideNames[k] ?? k)} ↗</a>`).join("")}</p>` : ""}
      <div class="row-actions">
        <button class="ghost" data-action="rename-program">Rename program</button>
        <button class="ghost" data-action="add-week">+ Week</button>
        <button class="ghost" data-action="add-day">+ Day</button>
      </div>
    </section>
    ${p.days.map(programDayTable).join("")}`;
}

function programDayTable(day) {
  const weeks = state.program.weeks;
  return `
    <section class="card program-day">
      <header>
        <h3>${esc(dayLabel(day))}</h3>
        <div>
          <button class="ghost" data-action="edit-day" data-day-id="${day.id}">Rename</button>
          <button class="ghost" data-action="add-exercise" data-day-id="${day.id}">+ Exercise</button>
        </div>
      </header>
      <div class="table-scroll">
        <table class="grid">
          <thead>
            <tr>
              <th class="sticky">Exercise</th>
              ${weeks
                .map((w) => {
                  const done = L.isSessionComplete(state, w.id, day.id);
                  return `<th><a href="#workout" data-open="${w.id}:${day.id}">${esc(w.label)}${w.deload ? "<br><small>deload</small>" : ""}</a>${done ? ' <span class="tick-mark" title="Session complete">✓</span>' : ""}</th>`;
                })
                .join("")}
            </tr>
          </thead>
          <tbody>
            ${day.exercises
              .map(
                (ex) => `
              <tr>
                <th class="sticky">
                  <button class="link" data-action="edit-exercise" data-ex-id="${ex.id}">${esc(ex.name)}</button>
                  <small>${esc(ex.repRange ?? "")} reps</small>
                </th>
                ${weeks.map((w) => programCell(w, day, ex)).join("")}
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>`;
}

function programCell(week, day, ex) {
  const t = target(week.id, ex.id);
  const log = getLog(week.id, ex.id);
  const done = L.performedSets(log);
  const status = !done.length ? "" : t.sets && done.length < t.sets ? "partial" : "done";
  const plan = t.sets || t.weight != null ? `${t.sets ?? "?"} × ${t.weight != null ? L.fmt(t.weight) : "?"}` : "—";
  const actual = done.length
    ? new Set(done.map((s) => Number(s.weight))).size === 1 && Number(done[0].weight) !== Number(t.weight)
      ? `${L.fmt(done[0].weight)}: ${done.map((s) => s.reps).join(",")}`
      : done.map((s) => s.reps).join(",")
    : "";
  return `<td class="${status}"><a href="#workout" data-open="${week.id}:${day.id}">
      <span class="plan">${plan}</span>
      ${t.rir ? `<span class="rir">${esc(t.rir)}</span>` : t.reps ? `<span class="rir">${esc(t.reps)}</span>` : ""}
      ${actual ? `<span class="actual">${esc(actual)}</span>` : ""}
    </a></td>`;
}

async function onProgramClick(e) {
  const open = e.target.closest("[data-open]");
  if (open) {
    e.preventDefault();
    const [weekId, dayId] = open.dataset.open.split(":");
    openSession(weekId, dayId);
    return;
  }
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const p = state.program;
  switch (btn.dataset.action) {
    case "rename-program": {
      const r = await ask({ title: "Rename program", fields: [{ name: "name", label: "Program name", value: p.name, required: true }], ok: "Rename" });
      if (!r?.name) return;
      p.name = r.name;
      break;
    }
    case "add-week": {
      const n = p.weeks.length;
      const prev = p.weeks.at(-1);
      const id = uid("w");
      p.weeks.push({ id, label: `Week ${n}` });
      // Start the new week from the previous week's targets.
      p.targets[id] = JSON.parse(JSON.stringify(p.targets[prev?.id] ?? {}));
      break;
    }
    case "add-day": {
      const r = await ask({
        title: "Add a training day",
        fields: [
          { name: "name", label: "Day name", value: `Day ${p.days.length + 1}`, required: true },
          { name: "focus", label: "Focus", placeholder: "e.g. Arms" },
        ],
        ok: "Add day",
      });
      if (!r?.name) return;
      p.days.push({ id: uid("d"), name: r.name, focus: r.focus, exercises: [] });
      break;
    }
    case "edit-day": {
      const day = dayById(btn.dataset.dayId);
      const r = await ask({
        title: "Rename day",
        fields: [
          { name: "name", label: "Day name", value: day.name, required: true },
          { name: "focus", label: "Focus", value: day.focus ?? "" },
        ],
        ok: "Save",
      });
      if (!r?.name) return;
      day.name = r.name;
      day.focus = r.focus;
      break;
    }
    case "add-exercise":
      openExerciseDialog(null, btn.dataset.dayId);
      return;
    case "edit-exercise":
      openExerciseDialog(btn.dataset.exId);
      return;
    default:
      return;
  }
  persist();
  render();
}

const uid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function openExerciseDialog(exId, dayId) {
  const dlg = document.getElementById("exercise-dialog");
  const found = exId ? L.findExercise(state.program, exId) : null;
  const ex = found?.exercise ?? { name: "", repRange: "8-12" };
  const day = found?.day ?? dayById(dayId);
  const idx = day.exercises.indexOf(found?.exercise);
  dlg.querySelector("form").innerHTML = `
    <h2>${exId ? "Edit exercise" : `Add exercise to ${esc(dayLabel(day))}`}</h2>
    <label class="field"><span>Name</span><input name="name" required value="${esc(ex.name)}"></label>
    <div class="field-row">
      <label class="field"><span>Rep range</span><input name="repRange" value="${esc(ex.repRange ?? "")}" placeholder="8-12"></label>
      <label class="field grow"><span>Form video URL</span><input name="video" type="url" value="${esc(ex.video ?? "")}"></label>
    </div>
    <label class="field"><span>Note</span><input name="note" value="${esc(ex.note ?? "")}" placeholder="e.g. Kept light for shoulder"></label>
    <h3>Weekly targets</h3>
    <div class="table-scroll">
      <table class="targets">
        <thead><tr><th>Week</th><th>Sets</th><th>Weight</th><th>RIR / reps</th></tr></thead>
        <tbody>
          ${state.program.weeks
            .map((w) => {
              const t = exId ? target(w.id, exId) : {};
              return `<tr>
                <th>${esc(weekLabel(w))}</th>
                <td><input name="sets-${w.id}" type="number" min="0" inputmode="numeric" value="${esc(t.sets ?? "")}"></td>
                <td><input name="weight-${w.id}" type="number" min="0" step="any" inputmode="decimal" value="${esc(t.weight ?? "")}"></td>
                <td><input name="rir-${w.id}" value="${esc(t.rir ?? t.reps ?? "")}" placeholder="2/fail"></td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
    <div class="dialog-actions">
      ${exId ? `<button type="button" class="danger" data-dlg="delete">Delete</button>` : ""}
      ${exId && idx > 0 ? `<button type="button" class="ghost" data-dlg="up">Move up</button>` : ""}
      ${exId && idx < day.exercises.length - 1 ? `<button type="button" class="ghost" data-dlg="down">Move down</button>` : ""}
      <span class="spacer"></span>
      <button type="button" class="secondary" data-dlg="cancel">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div>`;

  const form = dlg.querySelector("form");
  form.onclick = async (e) => {
    const a = e.target.closest("[data-dlg]")?.dataset.dlg;
    if (!a) return;
    if (a === "cancel") return dlg.close();
    if (a === "delete") {
      dlg.close();
      const sure = await ask({ title: `Delete ${ex.name}?`, message: "Its targets and every logged set will be removed.", ok: "Delete", danger: true });
      if (!sure) return;
      day.exercises.splice(idx, 1);
      for (const w of state.program.weeks) {
        delete state.program.targets[w.id]?.[exId];
        delete state.logs[w.id]?.[exId];
      }
    } else if (a === "up" || a === "down") {
      const j = a === "up" ? idx - 1 : idx + 1;
      [day.exercises[idx], day.exercises[j]] = [day.exercises[j], day.exercises[idx]];
    }
    persist();
    dlg.close();
    render();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const item = exId ? ex : { id: uid(`${day.id}e`) };
    item.name = data.get("name").trim();
    for (const k of ["repRange", "video", "note"]) {
      const v = data.get(k).trim();
      if (v) item[k] = v;
      else delete item[k];
    }
    if (!exId) day.exercises.push(item);
    for (const w of state.program.weeks) {
      const isRir = !w.deload;
      const t = {};
      const sets = data.get(`sets-${w.id}`);
      const weight = data.get(`weight-${w.id}`);
      const extra = data.get(`rir-${w.id}`).trim();
      if (sets !== "") t.sets = Number(sets);
      if (weight !== "") t.weight = Number(weight);
      if (extra) t[isRir ? "rir" : "reps"] = extra;
      state.program.targets[w.id] ??= {};
      state.program.targets[w.id][item.id] = t;
    }
    persist();
    dlg.close();
    render();
  };
  dlg.showModal();
  form.querySelector("input[name=name]").focus();
}

// ------------------------------------------------------------------ progress

function renderProgress() {
  const p = state.program;
  const overall = L.programProgress(state);
  const next = L.nextSession(state);
  const totals = L.weeklyTotals(state);
  const latest = totals.filter((t) => t.sets > 0).at(-1);
  const prs = L.personalRecords(state);
  const exercises = p.days.flatMap((d) => d.exercises.map((ex) => ({ day: d, ex })));
  if (!exercises.some((x) => x.ex.id === ui.exerciseId)) ui.exerciseId = exercises[0]?.ex.id;

  main.innerHTML = `
    <section class="page-head"><h2>Progress</h2><p class="muted">${esc(p.name)}</p></section>
    <section class="tiles">
      <div class="tile">
        <span class="tile-label">Program complete</span>
        <span class="tile-value">${Math.round(overall.pct * 100)}%</span>
        <span class="tile-sub">${overall.completed} of ${overall.total} sessions</span>
        <div class="meter"><span style="width:${Math.round(overall.pct * 100)}%"></span></div>
      </div>
      <div class="tile">
        <span class="tile-label">Next session</span>
        <span class="tile-value small">${next ? `${esc(next.week.label)} · ${esc(next.day.name)}` : "Done!"}</span>
        <span class="tile-sub">${next ? esc(next.day.focus ?? "") : "Program complete"}</span>
      </div>
      <div class="tile">
        <span class="tile-label">Pounds worked${latest ? ` · ${esc(latest.week.label)}` : ""}</span>
        <span class="tile-value">${latest ? Math.round(latest.pounds).toLocaleString() : "–"}</span>
        <span class="tile-sub">${latest ? `${changeHTML(latest.poundsChange)}${latest.complete ? "" : " · in progress"}` : "sets × weight"}</span>
      </div>
      <div class="tile">
        <span class="tile-label">Sets${latest ? ` · ${esc(latest.week.label)}` : ""}</span>
        <span class="tile-value">${latest ? latest.sets : "–"}</span>
        <span class="tile-sub">${latest ? `${changeHTML(latest.setsChange)}${latest.complete ? "" : " · in progress"}` : "completed sets"}</span>
      </div>
    </section>

    <section class="card">
      <header class="chart-head">
        <h3>Exercise progress</h3>
        <select id="exercise-select" aria-label="Exercise">
          ${p.days
            .map(
              (d) => `<optgroup label="${esc(dayLabel(d))}">${d.exercises
                .map((ex) => `<option value="${ex.id}" ${ex.id === ui.exerciseId ? "selected" : ""}>${esc(ex.name)}</option>`)
                .join("")}</optgroup>`
            )
            .join("")}
        </select>
      </header>
      <div class="legend">
        <span><span class="key" style="--c:var(--series-1)"></span>Estimated 1RM</span>
        <span><span class="key" style="--c:var(--series-2)"></span>Top weight lifted</span>
        <span><span class="key dashed" style="--c:var(--muted)"></span>Program target</span>
      </div>
      <div id="exercise-chart"></div>
      <div class="table-scroll"><table class="data" id="exercise-table"></table></div>
    </section>

    <section class="card">
      <h3>Pounds worked per week</h3>
      <p class="muted small">Sets × weight, added up over every exercise. Labels show the change from the week before; lighter bars are weeks still in progress.</p>
      <div id="pounds-chart"></div>
    </section>

    <section class="card">
      <h3>Sets per week</h3>
      <p class="muted small">Completed sets across every exercise.</p>
      <div id="sets-chart"></div>
    </section>

    <section class="card">
      <h3>Week over week</h3>
      <div class="table-scroll">
        <table class="data wow">
          <thead><tr><th>Week</th><th class="num">Lbs</th><th class="num">+/−</th><th class="num">Sets</th><th class="num">+/−</th></tr></thead>
          <tbody>${totals
            .map(
              (t) => `<tr${t.sets ? "" : ' class="muted"'}><td>${esc(t.week.label)}${t.week.deload ? "<small>deload</small>" : ""}${t.sets && !t.complete ? "<small>in progress</small>" : ""}</td>
                <td class="num">${t.sets ? Math.round(t.pounds).toLocaleString() : "—"}</td>
                <td class="num">${t.sets ? changeHTML(t.poundsChange, false) : ""}</td>
                <td class="num">${t.sets || "—"}</td>
                <td class="num">${t.sets ? changeHTML(t.setsChange, false) : ""}</td></tr>`
            )
            .join("")}</tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h3>Best lifts</h3>
      <p class="muted small">Highest estimated one-rep max (Epley) logged for each exercise.</p>
      ${
        prs.length
          ? `<div class="table-scroll"><table class="data"><thead><tr><th>Exercise</th><th class="num">Est. 1RM</th><th class="num">Top set</th><th>Week</th></tr></thead><tbody>
          ${prs
            .map(
              (r) => `<tr><td class="wrap">${esc(r.exercise.name)}<small>${esc(r.day.name)}</small></td><td class="num">${L.fmt(r.e1rm)}</td><td class="num">${L.fmt(r.topWeight)}</td><td>${esc(r.week.label.replace("Week ", "W"))}</td></tr>`
            )
            .join("")}</tbody></table></div>`
          : `<p class="empty">Log a few sets to see your best lifts.</p>`
      }
    </section>`;

  drawExerciseChart();
  const bars = (field, changeField) =>
    totals.map((t) => ({
      label: t.week.label.replace("Week ", "W"),
      title: `${weekLabel(t.week)}${t.sets && !t.complete ? " (in progress)" : ""}`,
      value: t[field],
      partial: t.sets > 0 && !t.complete,
      cap: t[changeField] == null ? "" : pctText(t[changeField]),
      detail: t[changeField] == null ? "" : `${pctText(t[changeField])} vs week before`,
    }));
  columnChart(main.querySelector("#pounds-chart"), {
    label: "Pounds worked per week",
    bars: bars("pounds", "poundsChange"),
    yFormat: (y) => `${Math.round(y).toLocaleString()} ${unit()}`,
  });
  columnChart(main.querySelector("#sets-chart"), {
    label: "Sets per week",
    bars: bars("sets", "setsChange"),
    color: "var(--series-2)",
    yFormat: (y) => `${y} sets`,
  });
}

/** "+12%" / "−8%" / "0%". */
function pctText(change) {
  const pct = Math.round(change * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${Math.abs(pct)}%` : "0%";
}

function changeHTML(change, arrows = true) {
  if (change == null) return '<span class="muted">—</span>';
  const cls = change > 0 ? "up" : change < 0 ? "down" : "";
  const arrow = !arrows ? "" : change > 0 ? "▲ " : change < 0 ? "▼ " : "";
  return `<span class="${cls}">${arrow}${pctText(change)}</span>`;
}

function drawExerciseChart() {
  const exId = ui.exerciseId;
  if (!exId) return;
  const history = L.exerciseHistory(state, exId);
  const pts = (fn) => history.map((h, i) => ({ x: i, y: fn(h) })).filter((p) => p.y > 0);
  lineChart(main.querySelector("#exercise-chart"), {
    label: "Exercise progress by week",
    series: [
      { name: "Est. 1RM", color: "var(--series-1)", points: pts((h) => h.summary?.best1RM) },
      { name: "Top weight", color: "var(--series-2)", points: pts((h) => h.summary?.topWeight) },
      { name: "Target", color: "var(--muted)", dashed: true, markers: false, points: pts((h) => Number(h.target.weight) || 0) },
    ],
    xTicks: history.map((h, i) => ({ x: i, label: h.week.label.replace("Week ", "W") })),
    xFormat: (x) => weekLabel(history[x].week),
    yFormat: (y) => `${L.fmt(y)} ${unit()}`,
  });
  main.querySelector("#exercise-table").innerHTML = `
    <thead><tr><th>Week</th><th>Target</th><th>Logged</th><th class="num">Est. 1RM</th><th class="num">Lbs worked</th></tr></thead>
    <tbody>${history
      .map(({ week, target: t, summary }) => {
        const log = getLog(week.id, exId);
        return `<tr><td>${esc(weekLabel(week))}</td>
          <td>${t.sets ?? "–"} × ${t.weight != null ? L.fmt(t.weight) : "–"}${t.rir ? ` · ${esc(t.rir)}` : ""}</td>
          <td>${summary ? esc(L.formatLog(log)) : '<span class="muted">—</span>'}</td>
          <td class="num">${summary ? L.fmt(summary.best1RM) : ""}</td>
          <td class="num">${summary ? Math.round(summary.pounds).toLocaleString() : ""}</td></tr>`;
      })
      .join("")}</tbody>`;
}

// ------------------------------------------------------------------ bodyweight

function renderBody() {
  const body = state.body;
  const entries = [...body.entries].sort((a, b) => a.date.localeCompare(b.date));
  const start = body.startDate ?? entries[0]?.date;
  const weekly = L.weeklyAverages(entries, start);
  const latest = entries.at(-1);
  const lastWeek = weekly.at(-1);
  const hasGoal = body.startDate && body.startWeight && body.weeklyChangePct;
  const goalToday = hasGoal ? L.goalWeight(body, today()) : null;

  main.innerHTML = `
    <section class="page-head"><h2>Bodyweight</h2></section>
    <form class="card weigh-in" id="weigh-in">
      <label class="field"><span>Date</span><input type="date" name="date" value="${today()}" required></label>
      <label class="field"><span>Weight (${unit()})</span><input type="number" name="weight" step="0.1" min="0" inputmode="decimal" required value="${latest ? latest.weight : ""}"></label>
      <button class="primary" type="submit">Log weight</button>
    </form>

    <section class="tiles">
      <div class="tile"><span class="tile-label">Latest</span><span class="tile-value">${latest ? L.fmt(latest.weight) : "–"}</span><span class="tile-sub">${latest ? shortDate(latest.date) : "No weigh-ins yet"}</span></div>
      <div class="tile"><span class="tile-label">This week's average</span><span class="tile-value">${lastWeek ? L.fmt(lastWeek.avg) : "–"}</span><span class="tile-sub">${
        lastWeek?.change != null ? `${lastWeek.change > 0 ? "+" : ""}${L.fmt(lastWeek.change)} vs last week` : ""
      }</span></div>
      <div class="tile"><span class="tile-label">Since start</span><span class="tile-value">${
        lastWeek && body.startWeight ? `${lastWeek.avg - body.startWeight > 0 ? "+" : ""}${L.fmt(lastWeek.avg - body.startWeight)}` : "–"
      }</span><span class="tile-sub">${body.startWeight ? `from ${L.fmt(body.startWeight)} ${unit()}` : ""}</span></div>
      ${hasGoal ? `<div class="tile"><span class="tile-label">Goal today</span><span class="tile-value">${L.fmt(goalToday)}</span><span class="tile-sub">${L.fmt(body.weeklyChangePct * 100)}% per week</span></div>` : ""}
    </section>

    <section class="card">
      <h3>Weight trend</h3>
      <div class="legend">
        <span><span class="key" style="--c:var(--series-1)"></span>Daily weigh-in</span>
        <span><span class="key" style="--c:var(--series-2)"></span>Weekly average</span>
        ${hasGoal ? `<span><span class="key dashed" style="--c:var(--muted)"></span>Goal</span>` : ""}
      </div>
      <div id="body-chart"></div>
    </section>

    <section class="card">
      <h3>Weekly averages</h3>
      ${
        weekly.length
          ? `<div class="table-scroll"><table class="data"><thead><tr><th>Week</th><th>Starts</th><th class="num">Avg</th><th class="num">Change</th>${hasGoal ? '<th class="num">Goal</th>' : ""}<th class="num">Weigh-ins</th></tr></thead><tbody>
        ${weekly
          .map(
            (w) => `<tr><td>${w.week}</td><td>${shortDate(w.start)}</td><td class="num">${L.fmt(w.avg)}</td><td class="num">${
              w.change == null ? "" : `${w.change > 0 ? "+" : ""}${L.fmt(w.change)}`
            }</td>${hasGoal ? `<td class="num">${L.fmt(L.goalWeight(body, w.start))}</td>` : ""}<td class="num">${w.count}</td></tr>`
          )
          .join("")}</tbody></table></div>`
          : `<p class="empty">No weigh-ins yet.</p>`
      }
    </section>

    <details class="card">
      <summary>All weigh-ins (${entries.length})</summary>
      <ul class="entries">
        ${entries
          .slice()
          .reverse()
          .map((e) => `<li><span>${shortDate(e.date)}</span><b>${L.fmt(e.weight)}</b><button class="ghost" data-del="${e.date}" aria-label="Delete ${e.date}">Delete</button></li>`)
          .join("")}
      </ul>
    </details>

    <details class="card">
      <summary>Goal settings</summary>
      <form id="goal-form" class="goal-form">
        <label class="field"><span>Start date</span><input type="date" name="startDate" value="${esc(body.startDate ?? "")}"></label>
        <label class="field"><span>Starting weight</span><input type="number" step="0.1" name="startWeight" value="${esc(body.startWeight ?? "")}"></label>
        <label class="field"><span>Weekly change %</span><input type="number" step="0.1" name="pct" value="${body.weeklyChangePct ? +(body.weeklyChangePct * 100).toFixed(2) : ""}" placeholder="-0.8"></label>
        <button class="secondary" type="submit">Save goal</button>
      </form>
      <p class="muted small">Use a negative % to lose weight (fat loss), positive to gain (massing), 0 for maintenance.</p>
    </details>`;

  if (entries.length && start) {
    const x = (iso) => L.daysBetween(start, iso);
    const lastX = Math.max(x(entries.at(-1).date), 7);
    const series = [
      { name: "Weigh-in", color: "var(--series-1)", points: entries.map((e) => ({ x: x(e.date), y: e.weight })) },
      { name: "Weekly avg", color: "var(--series-2)", points: weekly.map((w) => ({ x: x(w.start) + 3, y: w.avg })) },
    ];
    if (hasGoal) {
      series.push({
        name: "Goal",
        color: "var(--muted)",
        dashed: true,
        markers: false,
        points: [0, lastX].map((d) => ({ x: d, y: L.goalWeight(body, L.addDays(body.startDate, d - x(body.startDate))) })),
      });
    }
    const xTicks = [];
    for (let d = 0; d <= lastX; d += 7) xTicks.push({ x: d, label: shortDate(L.addDays(start, d)) });
    lineChart(main.querySelector("#body-chart"), {
      label: "Bodyweight trend",
      series,
      xTicks,
      xFormat: (d) => shortDate(L.addDays(start, d)),
      yFormat: (y) => `${L.fmt(y)} ${unit()}`,
    });
  } else {
    main.querySelector("#body-chart").innerHTML = `<p class="empty">Log a weigh-in to start your trend.</p>`;
  }
}

function onBodySubmit(e) {
  e.preventDefault();
  const data = new FormData(e.target);
  if (e.target.id === "weigh-in") {
    const date = data.get("date");
    const weight = Number(data.get("weight"));
    if (!date || !(weight > 0)) return;
    state.body.entries = state.body.entries.filter((x) => x.date !== date);
    state.body.entries.push({ date, weight });
    if (!state.body.startDate) {
      state.body.startDate = date;
      state.body.startWeight = weight;
    }
    toast(`Logged ${L.fmt(weight)} ${unit()} for ${shortDate(date)}`);
  } else if (e.target.id === "goal-form") {
    state.body.startDate = data.get("startDate") || null;
    state.body.startWeight = Number(data.get("startWeight")) || null;
    state.body.weeklyChangePct = (Number(data.get("pct")) || 0) / 100;
    toast("Goal saved");
  }
  persist();
  render();
}

// ------------------------------------------------------------------ physical therapy

const ptDate = () => ui.ptDate ?? PT.localToday();
const ptDay = (iso) =>
  iso === PT.localToday() ? "Today" : L.toDate(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

function renderPT() {
  const pt = state.pt;
  const date = ptDate();
  const week = PT.weekProgress(pt, PT.weekStart(date));
  const byId = new Map(week.rows.map((r) => [r.exercise.id, r]));
  const areas = [...new Set(pt.plan.exercises.map((ex) => ex.area || "Other"))];
  const src = pt.plan.source;
  const history = PT.adherenceHistory(pt, PT.localToday(), 8);
  const lastWeek = PT.weekProgress(pt, L.addDays(PT.weekStart(date), -7));
  const lastById = new Map(lastWeek.rows.map((r) => [r.exercise.id, r]));

  main.innerHTML = `
    <section class="page-head">
      <h2>Physical therapy</h2>
      <p class="muted small">${
        src
          ? `Plan from ${esc(firstName(pt.sender))}'s email of ${shortDate(src.date.slice(0, 10))}${src.subject ? ` (“${esc(src.subject)}”)` : ""}${
              src.url ? ` · <a href="${esc(src.url)}" target="_blank" rel="noopener">open email ↗</a>` : ""
            }`
          : "Kept separate from your strength program."
      }</p>
      <div class="row-actions">
        <button class="secondary" data-action="pt-gmail" id="pt-gmail">✉ Check Gmail for updates</button>
        <button class="ghost" data-action="pt-add">+ Add exercise</button>
      </div>
    </section>

    <section class="pt-day" aria-label="Day">
      <button class="ghost" data-pt-day="-1" aria-label="Previous day">‹</button>
      <div><b>${esc(ptDay(date))}</b><small class="muted">Week of ${shortDate(PT.weekStart(date))}</small></div>
      <button class="ghost" data-pt-day="1" aria-label="Next day" ${date >= PT.localToday() ? "disabled" : ""}>›</button>
    </section>

    <section class="tile pt-week">
      <span class="tile-label">This week</span>
      <span class="tile-value">${week.done} <small>of ${week.target} sessions</small></span>
      <div class="meter"><span style="width:${Math.round(week.pct * 100)}%"></span></div>
      <span class="tile-sub">${week.rows.filter((r) => r.met).length} of ${week.rows.length} exercises on target</span>
    </section>

    ${
      pt.plan.exercises.length
        ? areas
            .map(
              (area) => `
      <section class="pt-area">
        <h3>${esc(area)}</h3>
        ${pt.plan.exercises
          .filter((ex) => (ex.area || "Other") === area)
          .map((ex) => ptCard(ex, date, byId.get(ex.id)))
          .join("")}
      </section>`
            )
            .join("")
        : `<p class="empty">No PT exercises yet. Tap “Check Gmail for updates” to pull them from ${esc(firstName(pt.sender))}'s emails, or add one yourself.</p>`
    }

    <section class="card">
      <h3>Weekly completion</h3>
      <p class="muted small">Sessions done against your current plan's weekly targets. The lighter bar is this week, still in progress.</p>
      <div id="pt-chart"></div>
      ${
        pt.plan.exercises.length
          ? `<div class="table-scroll"><table class="data"><thead><tr><th>Exercise</th><th class="num">This week</th><th class="num">Last week</th></tr></thead><tbody>${pt.plan.exercises
              .map((ex) => {
                const t = byId.get(ex.id);
                const l = lastById.get(ex.id);
                return `<tr><td class="wrap">${esc(ex.name)}<small>${esc(PT.frequencyText(ex.perWeek))}</small></td><td class="num ${t.met ? "up" : ""}">${t.done}/${t.target}</td><td class="num ${l.met ? "up" : ""}">${l.done}/${l.target}</td></tr>`;
              })
              .join("")}</tbody></table></div>`
          : ""
      }
    </section>

    ${
      pt.history.length
        ? `<details class="card"><summary>Plan changes (${pt.history.length})</summary><ul class="pt-history">${pt.history
            .slice()
            .reverse()
            .map(
              (h) => `<li><b>${shortDate(h.date)}</b>${h.source?.subject ? ` · ${esc(h.source.subject)}` : ""}<ul>${(h.changes ?? []).map((c) => `<li>${esc(c)}</li>`).join("")}</ul></li>`
            )
            .join("")}</ul></details>`
        : ""
    }

    <details class="card">
      <summary>Email settings</summary>
      <form id="pt-sender-form" class="goal-form">
        <label class="field"><span>Therapist's email address</span><input id="pt-sender" name="sender" type="email" value="${esc(pt.sender)}" placeholder="therapist@clinic.com" required></label>
        <button class="secondary" type="submit">Save</button>
      </form>
      <p class="muted small">“Check Gmail” reads emails from this address sent after your plan's source email and asks Claude to update the plan. You review every change before it's applied.</p>
    </details>`;

  columnChart(main.querySelector("#pt-chart"), {
    label: "Weekly PT completion",
    bars: history.map((h) => ({
      label: `${Number(h.start.slice(5, 7))}/${Number(h.start.slice(8))}`,
      title: `Week of ${shortDate(h.start)}${h.current ? " (in progress)" : ""}`,
      value: Math.round(h.pct * 100),
      partial: h.current,
      detail: `${h.done} of ${h.target} sessions`,
    })),
    color: "var(--series-1)",
    max: 100,
    yFormat: (y) => `${y}%`,
  });
}

const firstName = (email) => {
  const n = String(email).split("@")[0].split(/[._-]/)[0];
  return n ? n[0].toUpperCase() + n.slice(1) : "your therapist";
};

function ptCard(ex, date, week) {
  const done = PT.setsDone(state.pt, date, ex.id);
  const sets = Math.max(1, Number(ex.sets) || 1);
  const complete = done >= sets;
  return `
    <article class="card pt-ex ${complete ? "complete" : ""}" data-pt-ex="${ex.id}">
      <header>
        <h4>${esc(ex.name)}</h4>
        <button class="ghost" data-pt-edit="${ex.id}" aria-label="Edit ${esc(ex.name)}">Edit</button>
      </header>
      <p class="target">${sets} × ${esc(ex.reps)}${ex.weight ? ` · ${L.fmt(ex.weight)} ${unit()}` : ""} · ${esc(PT.frequencyText(ex.perWeek))}
        <span class="pt-count ${week?.met ? "up" : ""}">${week ? `${week.done}/${week.target} this week` : ""}</span></p>
      ${ex.note ? `<p class="note">${esc(ex.note)}</p>` : ""}
      <div class="pt-sets" role="group" aria-label="Sets done">
        ${Array.from({ length: sets }, (_, i) => `<button class="pt-set" data-pt-set="${i}" aria-pressed="${i < done}" aria-label="Set ${i + 1}">${i + 1}</button>`).join("")}
        ${complete ? '<span class="pt-done">✓ Done</span>' : ""}
        ${ex.video ? `<a class="video" href="${esc(ex.video)}" target="_blank" rel="noopener">Video ↗</a>` : ""}
      </div>
    </article>`;
}

function onPTClick(e) {
  const day = e.target.closest("[data-pt-day]");
  if (day) {
    const next = L.addDays(ptDate(), Number(day.dataset.ptDay));
    ui.ptDate = next >= PT.localToday() ? null : next;
    render();
    return;
  }
  const setBtn = e.target.closest("[data-pt-set]");
  if (setBtn) {
    const exId = setBtn.closest("[data-pt-ex]").dataset.ptEx;
    const date = ptDate();
    const log = (state.pt.log[date] ??= {});
    const count = PT.toggleSet(PT.setsDone(state.pt, date, exId), Number(setBtn.dataset.ptSet));
    if (count) log[exId] = { ...log[exId], sets: count };
    else delete log[exId];
    if (!Object.keys(log).length) delete state.pt.log[date];
    persist();
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    return;
  }
  const edit = e.target.closest("[data-pt-edit]");
  if (edit) return openPTDialog(edit.dataset.ptEdit);
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "pt-add") openPTDialog(null);
  if (action === "pt-gmail") checkTherapistEmail();
}

function onPTSubmit(e) {
  if (e.target.id !== "pt-sender-form") return;
  e.preventDefault();
  state.pt.sender = new FormData(e.target).get("sender").trim();
  persist();
  toast("Saved");
  render();
}

function openPTDialog(exId) {
  const dlg = document.getElementById("exercise-dialog");
  const form = dlg.querySelector("form");
  const list = state.pt.plan.exercises;
  const ex = list.find((x) => x.id === exId) ?? { name: "", area: "", perWeek: 3, sets: 3, reps: "10", weight: null, video: "", note: "" };
  const areas = [...new Set(list.map((x) => x.area).filter(Boolean))];
  form.innerHTML = `
    <h2>${exId ? "Edit PT exercise" : "Add PT exercise"}</h2>
    <label class="field"><span>Name</span><input id="pt-name" name="name" required value="${esc(ex.name)}"></label>
    <div class="field-row">
      <label class="field"><span>Body area</span><input id="pt-area" name="area" list="pt-areas" value="${esc(ex.area)}" placeholder="e.g. Shoulder"></label>
      <label class="field"><span>Times per week</span>
        <select id="pt-perweek" name="perWeek">${[1, 2, 3, 4, 5, 6, 7]
          .map((n) => `<option value="${n}" ${Number(ex.perWeek) === n ? "selected" : ""}>${n === 7 ? "Daily (7)" : n}</option>`)
          .join("")}</select>
      </label>
    </div>
    <datalist id="pt-areas">${areas.map((a) => `<option value="${esc(a)}">`).join("")}</datalist>
    <div class="field-row">
      <label class="field"><span>Sets</span><input id="pt-sets" name="sets" type="number" min="1" max="20" inputmode="numeric" required value="${esc(ex.sets)}"></label>
      <label class="field"><span>Reps</span><input id="pt-reps" name="reps" required value="${esc(ex.reps)}" placeholder="10-12"></label>
      <label class="field"><span>Weight (${unit()})</span><input id="pt-weight" name="weight" type="number" min="0" step="any" inputmode="decimal" value="${esc(ex.weight ?? "")}" placeholder="none"></label>
    </div>
    <label class="field"><span>Video link</span><input id="pt-video" name="video" type="url" value="${esc(ex.video)}"></label>
    <label class="field"><span>Note</span><input id="pt-note" name="note" value="${esc(ex.note)}" placeholder="e.g. 5 second lowering"></label>
    <div class="dialog-actions">
      ${exId ? '<button type="button" class="danger" data-pt-dlg="delete">Delete</button>' : ""}
      <span class="spacer"></span>
      <button type="button" class="secondary" data-pt-dlg="cancel">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div>`;
  form.onclick = async (e) => {
    const a = e.target.closest("[data-pt-dlg]")?.dataset.ptDlg;
    if (a === "cancel") dlg.close();
    if (a === "delete") {
      dlg.close();
      const sure = await ask({ title: `Remove ${ex.name}?`, message: "It leaves your plan. Sets you've already logged stay in your history.", ok: "Remove", danger: true });
      if (!sure) return;
      state.pt.plan.exercises = list.filter((x) => x.id !== exId);
      persist();
      render();
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const clean = PT.cleanExercise(Object.fromEntries(new FormData(form)));
    if (!clean) return;
    if (exId) Object.assign(ex, clean);
    else list.push({ ...clean, id: uid("pt") });
    state.pt.plan.updatedAt = PT.localToday();
    persist();
    dlg.close();
    render();
    toast(exId ? "Exercise updated" : "Exercise added");
  };
  dlg.showModal();
}

// --- Gmail -> plan

const SAMPLE_ERRORS = {
  not_granted: "Lift needs your permission to ask Claude to read the emails. Try again and choose Allow.",
  sampling_disabled: "Claude isn't available for your account right now.",
  not_declared: "This version of Lift can't ask Claude. Reload the page.",
  rate_limited: "Too many requests just now. Try again in a minute.",
  session_expired: "Sign in to Claude again, then retry.",
  prompt_too_large: "Those emails are too long to read at once.",
  invalid_json: "Claude's answer couldn't be read. Try again.",
  empty_completion: "Claude didn't answer. Try again.",
  refused: "Claude couldn't read these emails.",
};

const GMAIL_ERRORS = {
  server_not_connected: "Gmail isn't connected. Add it in claude.ai Settings → Connectors, then try again.",
  needs_reauth: "Gmail needs to be reconnected in claude.ai Settings → Connectors.",
  selection_required: "You have more than one Gmail connected. Pick one when Claude asks, then try again.",
  approval_required: "Lift needs your permission to read Gmail. Try again and choose Allow.",
  not_in_manifest: "Lift needs your permission to read Gmail. Try again and choose Allow.",
  consent_required: "Lift needs your permission to read Gmail. Try again and choose Allow.",
  blocked_by_policy: "Your organization doesn't allow Lift to use Gmail.",
  server_unavailable: "Gmail didn't respond. Try again in a moment.",
};

function gmailQueryDate(iso) {
  // Gmail's after: is a calendar day; start a day early and filter exactly below.
  return L.addDays(iso.slice(0, 10), -1).replace(/-/g, "/");
}

async function checkTherapistEmail() {
  const pt = state.pt;
  const [mcp, sample] = window.claude?.use ? await Promise.all([window.claude.use("mcp"), window.claude.use("sample")]) : [null, null];
  if (!mcp || !sample) {
    ask({ title: "Open Lift in Claude to check Gmail", message: "Reading your therapist's emails works in the Lift app on claude.ai. Here you can still add and edit exercises yourself.", info: true });
    return;
  }
  const btn = document.getElementById("pt-gmail");
  const busy = (text) => {
    if (btn) {
      btn.disabled = Boolean(text);
      btn.textContent = text || "✉ Check Gmail for updates";
    }
  };
  if (!pt.sender) {
    ask({ title: "Add your therapist's email first", message: "Open “Email settings” at the bottom of this page and enter the address their exercise emails come from.", info: true });
    return;
  }
  const since = pt.plan.source?.date ?? null;
  try {
    busy("Searching Gmail…");
    const query = `from:${pt.sender} ${since ? `after:${gmailQueryDate(since)}` : "newer_than:180d"}`;
    const found = await mcp.callTool("Gmail", "search_threads", { query, pageSize: 10, view: "THREAD_VIEW_MINIMAL" }, { cache: false });
    const ids = (found.payload?.threads ?? []).map((t) => t.id).filter(Boolean).slice(0, 10);
    const threads = [];
    for (const threadId of ids) {
      busy(`Reading email ${threads.length + 1} of ${ids.length}…`);
      const t = await mcp.callTool("Gmail", "get_thread", { threadId, messageFormat: "PLAIN_TEXT" }, { cache: false });
      threads.push(t.payload);
    }
    const emails = PT.therapistMessages(threads, pt.sender).filter((m) => !since || m.date > since);
    if (!emails.length) {
      toast(`No new emails from ${firstName(pt.sender)}${since ? ` since ${shortDate(since.slice(0, 10))}` : ""}`);
      return;
    }
    busy(`Asking Claude about ${emails.length} email${emails.length > 1 ? "s" : ""}…`);
    const reply = PT.readPlanReply(await sample.json(PT.planPrompt(pt.plan.exercises, emails), { modelTier: "default" }));
    previewPlanUpdate(reply, emails);
  } catch (err) {
    const msg = GMAIL_ERRORS[err?.code] ?? SAMPLE_ERRORS[err?.code] ?? (err instanceof Error ? err.message : "Couldn't check Gmail. Try again in a moment.");
    ask({ title: "Couldn't update from Gmail", message: msg, info: true });
  } finally {
    busy("");
  }
}

const PT_FIELD_NAMES = { area: "Area", perWeek: "Per week", sets: "Sets", reps: "Reps", weight: "Weight", video: "Video", note: "Note" };

function previewPlanUpdate(reply, emails) {
  const pt = state.pt;
  const latest = emails.at(-1);
  const source = { date: latest.date, subject: latest.subject, url: latest.url };
  const diff = PT.diffPlan(pt.plan.exercises, reply.exercises);
  const nothing = !diff.added.length && !diff.removed.length && !diff.changed.length;
  if (nothing) {
    pt.plan.source = source;
    persist();
    render();
    toast(`${firstName(pt.sender)}'s latest email${emails.length > 1 ? "s don't" : " doesn't"} change your plan`);
    return;
  }
  const val = (f, v) => (v == null || v === "" ? "—" : f === "perWeek" ? PT.frequencyText(v) : f === "video" ? "link" : esc(v));
  const dlg = document.getElementById("ask-dialog");
  const form = dlg.querySelector("form");
  form.innerHTML = `
    <h2>Update your PT plan?</h2>
    <p class="muted">From ${emails.length} email${emails.length > 1 ? "s" : ""} by ${esc(firstName(pt.sender))}, latest ${shortDate(latest.date.slice(0, 10))}. Check it against the email before applying.</p>
    ${reply.changes.length ? `<ul class="import-list">${reply.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
    <ul class="import-list">
      ${diff.added.map((x) => `<li><b>${esc(x.name)}</b> <span class="pill">New</span><ul><li>${esc(x.area)} · ${x.sets} × ${esc(x.reps)} · ${PT.frequencyText(x.perWeek)}</li></ul></li>`).join("")}
      ${diff.changed
        .map(
          (c) => `<li><b>${esc(c.exercise.name)}</b><ul>${c.fields
            .map((f) => `<li>${PT_FIELD_NAMES[f.field]}: <s>${val(f.field, f.from)}</s> → ${val(f.field, f.to)}</li>`)
            .join("")}</ul></li>`
        )
        .join("")}
      ${diff.removed.map((x) => `<li><b>${esc(x.name)}</b> <span class="pill">Removed</span></li>`).join("")}
    </ul>
    <p class="muted small"><a href="${esc(latest.url)}" target="_blank" rel="noopener">Open the latest email ↗</a></p>
    <div class="dialog-actions">
      <span class="spacer"></span>
      <button type="button" class="secondary" data-cancel>Not now</button>
      <button type="submit" class="primary">Apply changes</button>
    </div>`;
  form.querySelector("[data-cancel]").onclick = () => dlg.close();
  dlg.onclose = null;
  form.onsubmit = (e) => {
    e.preventDefault();
    pt.history.push({ date: PT.localToday(), source, changes: reply.changes, exercises: pt.plan.exercises });
    pt.history = pt.history.slice(-20);
    pt.plan = { exercises: PT.mergePlan(pt.plan.exercises, reply.exercises, () => uid("pt")), source, updatedAt: PT.localToday() };
    persist();
    dlg.close();
    render();
    toast("PT plan updated");
  };
  dlg.showModal();
}

// ------------------------------------------------------------------ settings

function renderSettings() {
  main.innerHTML = `
    <section class="page-head"><h2>Settings & data</h2></section>
    <section class="card">
      <h3>Workout</h3>
      <form id="settings-form" class="goal-form">
        <label class="field"><span>Appearance</span>
          <select id="theme-select" name="theme">${[
            ["system", "Match my device"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]
            .map(([v, label]) => `<option value="${v}" ${(state.settings.theme ?? "system") === v ? "selected" : ""}>${label}</option>`)
            .join("")}</select>
        </label>
        <label class="field check-field"><input type="checkbox" id="auto-rest" name="autoRest" ${state.settings.autoRest !== false ? "checked" : ""}><span>Start the rest timer when I tick a set</span></label>
        <label class="field"><span>Units</span>
          <select name="unit">${["lb", "kg"].map((u) => `<option ${u === unit() ? "selected" : ""}>${u}</option>`).join("")}</select>
        </label>
        <button class="secondary" type="submit">Save</button>
      </form>
    </section>
    <section class="card">
      <h3>Spreadsheet</h3>
      <p class="muted small">“Update targets from sheet” on each workout reads this Google Sheet's first tab${
        state.program.sheetId
          ? `: <a href="https://docs.google.com/spreadsheets/d/${esc(state.program.sheetId)}/edit" target="_blank" rel="noopener">open the sheet ↗</a>`
          : "."
      }</p>
      <form id="sheet-form" class="goal-form">
        <label class="field"><span>Sheet link</span><input id="sheet-url" name="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…" value="${
          state.program.sheetId ? esc(`https://docs.google.com/spreadsheets/d/${state.program.sheetId}/edit`) : ""
        }"></label>
        <button class="secondary" type="submit">Save link</button>
      </form>
    </section>
    <section class="card">
      <h3>Backup</h3>
      <p class="muted small">${
        cloudOn
          ? "Your log is saved privately to your account and syncs between your devices. Exports are extra copies."
          : "Your data is stored in this browser only. Export a backup regularly, and import it to move to another device."
      }</p>
      <div class="row-actions">
        <button class="secondary" data-action="export-json">Export backup (.json)</button>
        <button class="secondary" data-action="export-csv">Export sets (.csv)</button>
        <label class="button secondary">Import file<input type="file" accept="application/json,.json" id="import-file" hidden></label>
        <button class="secondary" data-action="import-text">Paste backup</button>
      </div>
    </section>
    <section class="card">
      <h3>Reset</h3>
      <p class="muted small">Replace everything with the original program and logs from the spreadsheet.</p>
      <button class="danger" data-action="reset">Reset to spreadsheet data</button>
    </section>`;
}

function toCSV() {
  const rows = [["week", "day", "focus", "exercise", "rep_range", "target_sets", "target_weight", "target_rir", "set", "weight", "reps", "done", "note"]];
  for (const w of state.program.weeks) {
    for (const d of state.program.days) {
      for (const ex of d.exercises) {
        const t = target(w.id, ex.id);
        const log = getLog(w.id, ex.id);
        (log?.sets ?? []).forEach((s, i) => {
          rows.push([w.label, d.name, d.focus, ex.name, ex.repRange, t.sets, t.weight, t.rir ?? t.reps, i + 1, s.weight, s.reps, s.done ? "yes" : "no", i === 0 ? log.note : ""]);
        });
      }
    }
  }
  return rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? ""))).join(",")).join("\n");
}

async function onSettingsClick(e) {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "export-json") showText("Backup", JSON.stringify(state), `lift-backup-${today()}.json`, "application/json");
  if (action === "export-csv") showText("All sets (CSV)", toCSV(), `lift-sets-${today()}.csv`, "text/csv");
  if (action === "import-text") {
    const r = await ask({ title: "Import backup", message: "Paste the text from Export backup. This replaces all current data.", fields: [{ name: "json", label: "Backup", multiline: true }], ok: "Import", danger: true });
    if (r?.json) importData(r.json);
  }
  if (action === "reset") {
    const sure = await ask({ title: "Reset to spreadsheet data?", message: "Anything logged in the app will be lost.", ok: "Reset", danger: true });
    if (!sure) return;
    state = { ...freshState(), updatedAt: Date.now() };
    persist();
    ui.weekId = null;
    toast("Reset to spreadsheet data");
    route();
  }
}

async function importData(text) {
  try {
    state = { ...migrate(JSON.parse(text)), updatedAt: Date.now() };
    persist();
    ui.weekId = null;
    toast("Backup imported");
    route();
  } catch (err) {
    ask({ title: "Import failed", message: err instanceof SyntaxError ? "That isn't valid backup text." : err.message, info: true });
  }
}

async function onImport(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const sure = await ask({ title: "Import backup?", message: `Replace all current data with ${file.name}?`, ok: "Import", danger: true });
  if (sure) importData(await file.text());
}

function onSettingsSubmit(e) {
  if (e.target.id === "sheet-form") {
    e.preventDefault();
    const raw = new FormData(e.target).get("sheetUrl");
    const id = sheet.sheetIdFromUrl(raw);
    if (raw.trim() && !id) {
      ask({ title: "That isn't a Google Sheets link", message: "Paste the sheet's address from your browser, like https://docs.google.com/spreadsheets/d/…", info: true });
      return;
    }
    state.program.sheetId = id;
    persist();
    toast(id ? "Sheet link saved" : "Sheet link removed");
    render();
    return;
  }
  if (e.target.id !== "settings-form") return;
  e.preventDefault();
  const data = new FormData(e.target);
  state.settings.autoRest = data.get("autoRest") === "on";
  state.settings.theme = data.get("theme");
  applyTheme();
  state.program.unit = data.get("unit");
  persist();
  toast("Settings saved");
}

// ------------------------------------------------------------------ wiring

main.addEventListener("change", (e) => {
  if (ui.view === "workout") onWorkoutChange(e);
  if (ui.view === "progress" && e.target.id === "exercise-select") {
    ui.exerciseId = e.target.value;
    drawExerciseChart();
  }
  if (ui.view === "data" && e.target.id === "import-file") onImport(e);
});
main.addEventListener("click", (e) => {
  if (ui.view === "workout") onWorkoutClick(e);
  if (ui.view === "program") onProgramClick(e);
  if (ui.view === "data") onSettingsClick(e);
  if (ui.view === "pt") onPTClick(e);
  if (ui.view === "body") {
    const date = e.target.closest("[data-del]")?.dataset.del;
    if (!date) return;
    ask({ title: `Delete the ${shortDate(date)} weigh-in?`, ok: "Delete", danger: true }).then((sure) => {
      if (!sure) return;
      state.body.entries = state.body.entries.filter((x) => x.date !== date);
      persist();
      render();
    });
  }
});
main.addEventListener("submit", (e) => {
  if (ui.view === "body") onBodySubmit(e);
  if (ui.view === "data") onSettingsSubmit(e);
  if (ui.view === "pt") onPTSubmit(e);
});
// Enter in a set input moves to the next input instead of submitting anything.
main.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.matches(".sets input")) return;
  e.preventDefault();
  const inputs = [...main.querySelectorAll(".sets input")];
  const next = inputs[inputs.indexOf(e.target) + 1];
  if (next) next.focus();
  else e.target.blur();
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (ui.view === "progress" || ui.view === "body") render();
  }, 200);
});
window.addEventListener("hashchange", route);
// Another tab changed the data.
window.addEventListener("storage", () => {
  state = load();
  render();
});

// Offline cache for the multi-file version only (the single-file build has no sw.js or manifest).
if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !window.claude && document.querySelector('link[rel="manifest"]')) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ------------------------------------------------------------------ cloud sync

let cloudOn = false;
let pendingRemote = null;

const SYNC_TEXT = {
  connecting: "Connecting…",
  local: "Saved on this device",
  saving: "Saving…",
  synced: "Synced",
  error: "Sync failed · saved on this device",
};

function setSyncStatus(status, detail) {
  const el = document.getElementById("sync");
  el.hidden = false;
  el.dataset.status = status;
  el.textContent = SYNC_TEXT[status] ?? status;
  el.title = detail ?? "";
}

/** Adopt a newer copy saved from another device; push ours if it's newer. */
function onRemote(remote) {
  if (!remote) {
    cloud.push(state, { now: true });
    return;
  }
  const remoteAt = remote.updatedAt ?? 0;
  const localAt = state.updatedAt ?? 0;
  if (remoteAt < localAt) cloud.push(state, { now: true });
  if (remoteAt <= localAt) return;
  // Don't yank an input out from under someone typing; apply when they leave it.
  if (main.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) {
    pendingRemote = remote;
    return;
  }
  applyRemote(remote);
}

function applyRemote(remote) {
  try {
    state = { ...migrate(remote), updatedAt: remote.updatedAt };
  } catch {
    return;
  }
  save(state);
  route();
}

main.addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingRemote && !main.contains(document.activeElement)) {
      const r = pendingRemote;
      pendingRemote = null;
      if ((r.updatedAt ?? 0) > (state.updatedAt ?? 0)) applyRemote(r);
    }
  }, 0);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") cloud.flushNow();
});

route();
cloud
  .connect({ onRemote, onStatus: setSyncStatus })
  .then((ok) => {
    cloudOn = Boolean(ok);
    if (cloudOn && ui.view === "data") render();
  })
  .catch((err) => setSyncStatus("error", err?.message));
