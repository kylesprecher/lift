import * as L from "./logic.js";
import { load, save, freshState, migrate } from "./store.js";
import { lineChart, columnChart } from "./charts.js";
import * as cloud from "./cloud.js";
import * as chime from "./chime.js";

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
function ask({ title, message = "", fields = [], ok = "OK", danger = false }) {
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
      <button type="button" class="secondary" data-cancel>Cancel</button>
      <button type="submit" class="${danger ? "danger" : "primary"}">${esc(ok)}</button>
    </div>`;
  return new Promise((resolve) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      const values = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
      resolve(values);
      dlg.close();
    };
    form.querySelector("[data-cancel]").onclick = () => dlg.close();
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

const VIEWS = ["workout", "program", "progress", "body", "data"];

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

function render() {
  const views = { workout: renderWorkout, program: renderProgram, progress: renderProgress, body: renderBody, data: renderSettings };
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
    </section>

    <div class="exercises">
      ${day.exercises.map((ex) => exerciseCard(week, ex)).join("") || `<p class="empty">No exercises on this day yet — add some from the Program tab.</p>`}
    </div>

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

function refreshSessionMeta() {
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
  const volumes = L.weeklyVolume(state);
  const lastIdx = volumes.map((v) => v.volume > 0).lastIndexOf(true);
  const lastVol = volumes[lastIdx];
  const prevVol = volumes[lastIdx - 1];
  // Only compare finished weeks; a week in progress would always look like a drop.
  const lastWeekDone = lastVol && p.days.every((d) => L.isSessionComplete(state, lastVol.week.id, d.id));
  const delta = lastWeekDone && prevVol?.volume ? (lastVol.volume - prevVol.volume) / prevVol.volume : null;
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
        <span class="tile-label">Volume${lastVol ? ` · ${esc(lastVol.week.label)}` : ""}</span>
        <span class="tile-value">${lastVol ? `${Math.round(lastVol.volume).toLocaleString()}` : "–"}</span>
        <span class="tile-sub">${
          delta != null
            ? `<span class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(delta * 100))}%</span> vs ${esc(prevVol.week.label)}`
            : lastVol && !lastWeekDone
              ? `so far${prevVol?.volume ? ` · ${esc(prevVol.week.label)}: ${Math.round(prevVol.volume).toLocaleString()}` : ""}`
              : `${unit()} × reps`
        }</span>
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
      <h3>Weekly volume</h3>
      <p class="muted small">Total weight × reps across all logged sets.</p>
      <div id="volume-chart"></div>
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
  columnChart(main.querySelector("#volume-chart"), {
    label: "Weekly training volume",
    bars: volumes.map((v) => ({ label: v.week.label.replace("Week ", "W"), title: weekLabel(v.week), value: v.volume })),
    yFormat: (y) => `${Math.round(y).toLocaleString()} ${unit()}`,
  });
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
    <thead><tr><th>Week</th><th>Target</th><th>Logged</th><th class="num">Est. 1RM</th><th class="num">Volume</th></tr></thead>
    <tbody>${history
      .map(({ week, target: t, summary }) => {
        const log = getLog(week.id, exId);
        return `<tr><td>${esc(weekLabel(week))}</td>
          <td>${t.sets ?? "–"} × ${t.weight != null ? L.fmt(t.weight) : "–"}${t.rir ? ` · ${esc(t.rir)}` : ""}</td>
          <td>${summary ? esc(L.formatLog(log)) : '<span class="muted">—</span>'}</td>
          <td class="num">${summary ? L.fmt(summary.best1RM) : ""}</td>
          <td class="num">${summary ? Math.round(summary.volume).toLocaleString() : ""}</td></tr>`;
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

// ------------------------------------------------------------------ settings

function renderSettings() {
  main.innerHTML = `
    <section class="page-head"><h2>Settings & data</h2></section>
    <section class="card">
      <h3>Workout</h3>
      <form id="settings-form" class="goal-form">
        <label class="field check-field"><input type="checkbox" id="auto-rest" name="autoRest" ${state.settings.autoRest !== false ? "checked" : ""}><span>Start the rest timer when I tick a set</span></label>
        <label class="field"><span>Units</span>
          <select name="unit">${["lb", "kg"].map((u) => `<option ${u === unit() ? "selected" : ""}>${u}</option>`).join("")}</select>
        </label>
        <button class="secondary" type="submit">Save</button>
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
    ask({ title: "Import failed", message: err instanceof SyntaxError ? "That isn't valid backup text." : err.message, ok: "OK" });
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
  if (e.target.id !== "settings-form") return;
  e.preventDefault();
  const data = new FormData(e.target);
  state.settings.autoRest = data.get("autoRest") === "on";
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

if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !window.claude) {
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
