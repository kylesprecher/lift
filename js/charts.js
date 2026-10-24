// Minimal dependency-free SVG charts with a hover crosshair + tooltip.
// Colors come from CSS custom properties (--series-1, --series-2, --muted …)
// so light and dark themes are handled by the stylesheet.

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

/** Round axis bounds to clean tick steps. */
function niceTicks(min, max, count = 4) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(+t.toFixed(6));
  return ticks;
}

const compact = (n) => (Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(+n.toFixed(1)));

/**
 * Line chart.
 * opts.series: [{name, color, points: [{x, y}], dashed?, markers?}]
 * opts.xTicks: [{x, label}] – labels for the x axis
 * opts.xFormat(x) – tooltip title for an x value
 * opts.yFormat(y) – tooltip value formatting
 */
export function lineChart(container, opts) {
  const { series, xTicks = [], xFormat = String, yFormat = compact, height = 220, zeroBased = false } = opts;
  container.innerHTML = "";
  container.classList.add("chart");
  const all = series.flatMap((s) => s.points);
  if (!all.length) {
    container.innerHTML = `<p class="empty">No data yet.</p>`;
    return;
  }
  const width = Math.max(280, container.clientWidth || 600);
  const m = { top: 12, right: 16, bottom: 26, left: 44 };
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = Math.min(...xs, ...xTicks.map((t) => t.x));
  const xMax = Math.max(...xs, ...xTicks.map((t) => t.x));
  const ticks = niceTicks(zeroBased ? 0 : Math.min(...ys), Math.max(...ys));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const sx = (x) => m.left + (xMax === xMin ? 0.5 : (x - xMin) / (xMax - xMin)) * (width - m.left - m.right);
  const sy = (y) => m.top + (1 - (y - yMin) / (yMax - yMin)) * (height - m.top - m.bottom);

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img" }, container);
  svg.setAttribute("aria-label", opts.label ?? "Chart");

  for (const t of ticks) {
    el("line", { x1: m.left, x2: width - m.right, y1: sy(t), y2: sy(t), class: "grid" }, svg);
    const label = el("text", { x: m.left - 6, y: sy(t) + 4, class: "tick", "text-anchor": "end" }, svg);
    label.textContent = compact(t);
  }
  // Thin out x labels so they never collide.
  const every = Math.max(1, Math.ceil((xTicks.length * 46) / (width - m.left - m.right)));
  xTicks.forEach((t, i) => {
    if (i % every) return;
    const label = el("text", { x: sx(t.x), y: height - 6, class: "tick", "text-anchor": "middle" }, svg);
    label.textContent = t.label;
  });

  for (const s of series) {
    const pts = [...s.points].sort((a, b) => a.x - b.x);
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
    el("path", { d, class: `line${s.dashed ? " dashed" : ""}`, style: `stroke:${s.color}` }, svg);
    if (s.markers !== false) {
      for (const p of pts) el("circle", { cx: sx(p.x), cy: sy(p.y), r: 4, class: "dot", style: `fill:${s.color}` }, svg);
    }
  }

  // Hover layer
  const cross = el("line", { y1: m.top, y2: height - m.bottom, class: "crosshair", visibility: "hidden" }, svg);
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  container.appendChild(tip);
  const uniqueX = [...new Set(xs)].sort((a, b) => a - b);
  const overlay = el("rect", { x: m.left, y: 0, width: width - m.left - m.right, height, class: "overlay" }, svg);

  const show = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * width;
    let nearest = uniqueX[0];
    for (const x of uniqueX) if (Math.abs(sx(x) - px) < Math.abs(sx(nearest) - px)) nearest = x;
    cross.setAttribute("x1", sx(nearest));
    cross.setAttribute("x2", sx(nearest));
    cross.setAttribute("visibility", "visible");
    const rows = series
      .map((s) => ({ s, p: s.points.find((p) => p.x === nearest) }))
      .filter((r) => r.p)
      .map(
        ({ s, p }) =>
          `<div><span class="key${s.dashed ? " dashed" : ""}" style="--c:${s.color}"></span>${s.name}<b>${yFormat(p.y)}</b></div>`
      )
      .join("");
    tip.innerHTML = `<div class="tip-title">${xFormat(nearest)}</div>${rows}`;
    tip.hidden = false;
    const left = (sx(nearest) / width) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  };
  overlay.addEventListener("pointermove", show);
  overlay.addEventListener("pointerdown", show);
  overlay.addEventListener("pointerleave", hide);
}

/**
 * Single-series column chart.
 * opts.bars: [{label, value, title?}]
 */
export function columnChart(container, opts) {
  const { bars, color = "var(--series-1)", yFormat = compact, height = 200 } = opts;
  container.innerHTML = "";
  container.classList.add("chart");
  if (!bars.some((b) => b.value > 0)) {
    container.innerHTML = `<p class="empty">No data yet.</p>`;
    return;
  }
  const width = Math.max(280, container.clientWidth || 600);
  const m = { top: 18, right: 8, bottom: 26, left: 44 };
  const ticks = niceTicks(0, Math.max(...bars.map((b) => b.value)));
  const yMax = ticks[ticks.length - 1];
  const band = (width - m.left - m.right) / bars.length;
  const barW = Math.min(24, band * 0.6);
  const sy = (y) => m.top + (1 - y / yMax) * (height - m.top - m.bottom);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img" }, container);
  svg.setAttribute("aria-label", opts.label ?? "Chart");
  for (const t of ticks) {
    el("line", { x1: m.left, x2: width - m.right, y1: sy(t), y2: sy(t), class: t ? "grid" : "baseline" }, svg);
    const label = el("text", { x: m.left - 6, y: sy(t) + 4, class: "tick", "text-anchor": "end" }, svg);
    label.textContent = compact(t);
  }
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  container.appendChild(tip);
  bars.forEach((b, i) => {
    const cx = m.left + band * (i + 0.5);
    const label = el("text", { x: cx, y: height - 6, class: "tick", "text-anchor": "middle" }, svg);
    label.textContent = b.label;
    if (b.value > 0) {
      const top = sy(b.value);
      const base = sy(0);
      const r = Math.min(4, (base - top) / 2);
      const x0 = cx - barW / 2;
      const x1 = cx + barW / 2;
      // Rounded data end, square at the baseline.
      const d = `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`;
      el("path", { d, class: "bar", style: `fill:${color}` }, svg);
    }
    const hit = el("rect", { x: cx - band / 2, y: m.top, width: band, height: height - m.top - m.bottom, class: "overlay" }, svg);
    const show = () => {
      tip.innerHTML = `<div class="tip-title">${b.title ?? b.label}</div><div><b>${yFormat(b.value)}</b></div>`;
      tip.hidden = false;
      const box = svg.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max((cx / width) * box.width, 70), box.width - 70)}px`;
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", () => (tip.hidden = true));
  });
}
