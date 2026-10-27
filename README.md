# Lift

Lift is a phone-friendly web app for tracking workouts, exercises, sets and reps, and for checking your progress against a training program. It's built from the **KS Phase 1 Hypertrophy and Fat Loss** spreadsheet and comes preloaded with that program (7 weeks × 4 training days) and everything logged in it so far.

## Features

| Tab | What it does |
| --- | --- |
| **Workout** | Opens on your next session. Each exercise shows that week's target (sets · rep range · weight · RIR), a link to its form video, and what you lifted last time. Log the weight and reps for each set. A rest timer is pinned to the top of the screen. It defaults to 3:00; −15s/+15s change the saved duration, and while it's running they adjust only the current rest. A soft two-note chime plays when time is up. Tapping ✓ marks a set done and starts the timer (you can turn that off under Data). **Update targets from sheet** re-reads that week and day from the Google Sheet. It shows what's different (exercise names, rep ranges, sets, weight, RIR) and applies only what you confirm. Logged sets are never changed. In the hosted app it reads the sheet through your Google Drive connector; elsewhere, pick a CSV downloaded from the sheet. When you change the weight on a set, the sets you haven't done yet get the same weight. After each exercise you get double-progression advice (add weight, add reps, or hold). |
| **Program** | The spreadsheet grid: exercises × weeks, showing planned `sets × weight`, RIR, and the reps you actually did, colored green for done and amber for partial. Tap a cell to log that session. Tap an exercise to edit its name, rep range, video, note or per-week targets, or to reorder or delete it. You can also add exercises, days and weeks. |
| **Progress** | How much of the program you've finished, your next session, and weekly volume. For each exercise there's a chart of estimated 1RM and top weight against the program's target weight, plus a week-by-week table. Also shows a weekly volume chart and your best lift for each exercise. |
| **Body** | Daily weigh-ins, 7-day averages and week-over-week change, and a goal line (from the sheet: 208 lb start, −0.8%/week). |
| **Data** | Auto-start for the rest timer, lb/kg, the linked Google Sheet, JSON backup export/import, CSV export of every set, and a reset back to the spreadsheet data. |

The app works offline once it has loaded (there's a service worker), and you can add it to your phone's home screen.

## Using it on your phone

Lift is published as a private claude.ai Artifact: <https://claude.ai/artifact/94DosEAMHGR3RwauzDXa9J>. Sign in to Claude on your phone and open that link. When it runs there, your log is saved privately to your Claude account and syncs between your devices. The indicator in the top-right corner says whether it's "Synced". To publish an update, run `npm run build:artifact` and republish `dist/lift.artifact.html` to the same artifact.

## Running it

It's plain HTML, CSS and JavaScript modules. There's no build step and nothing to install. Serve the folder over HTTP:

```sh
npm start            # python3 -m http.server 8000
# open http://localhost:8000
```

You can host it on any static host (GitHub Pages, Netlify, …) by publishing the repository root.

`npm run build` bundles everything into one file, `dist/lift.html`, which opens straight from disk with no server.

**Data storage:** everything is saved in your browser's `localStorage` on that device (plus your Claude account when hosted as an Artifact). Use **Data → Export backup** to keep a copy or to move to another device.

## Tests

```sh
npm test             # node --test, no dependencies
```

## How the spreadsheet maps to the app

- `js/seed.js` was generated from the sheet's *Phase1 Hypertrophy (4-day)* and *Weight Tracker (Fat Loss)* tabs: exercises, rep ranges, form-video links, cell comments (as notes), per-week sets/weight/RIR targets, logged reps, and bodyweights.
- Where an "Actual Reps" cell has one number (e.g. `7`) for a 3-set week, it's treated as that many reps on every set. Lists like `9,9,9` or `8/8/8` are read one set at a time.
- The logged weight for each set is the planned weight for that week, because the sheet only has one weight column.
- A session counts as complete if it had any logged reps. Sessions with no logged reps (e.g. Week 2 Day 3) stay open.
- The diet, macro and meal-builder tabs aren't included. This app covers training and bodyweight.

## Layout

```
index.html            app shell + bottom navigation
css/styles.css        styles (light & dark)
js/app.js             views and event handling
js/logic.js           pure functions: progress, e1RM, advice, weekly averages
js/charts.js          dependency-free SVG line/column charts with tooltips
js/store.js           localStorage persistence, import validation
js/cloud.js           private per-user sync when hosted as a claude.ai Artifact
js/chime.js           synthesized end-of-rest chime (Web Audio)
js/sheet.js           reads one workout's targets from the program sheet (CSV)
js/seed.js            program + history from the spreadsheet
sw.js                 offline cache
scripts/build-single.mjs  bundles the app into one HTML file
tests/*.test.js       unit tests
```
