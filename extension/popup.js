const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text; // textContent only: page-derived text is never parsed as HTML
  return e;
}

const COLORS = {
  visits: "#38bdf8",
  clicks: "#a78bfa",
  hot: "#fbbf24",
  grid: "rgba(255,255,255,0.07)",
  axis: "#7b8394",
  bg: "#171a22",
};

const STATUS = {
  new: ["New", "s-new"],
  rising: ["Rising", "s-rising"],
  stable: ["Stable", "s-stable"],
  falling: ["Falling", "s-falling"],
  gone: ["Gone", "s-gone"],
  first: ["First scan", "s-stable"],
};

const state = { visitsDraw: null, clicksDraw: null };

// ---------------------------------------------------------------- init
async function init() {
  setupTabs();
  $("exportBtn").addEventListener("click", async () => {
    const data = await chrome.runtime.sendMessage({ type: "DP_EXPORT_ALL" });
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dark-pattern-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith("http")) {
    $("domain").textContent = "Not applicable on this page";
    document.querySelector(".tabs").hidden = true;
    $("tab-visits").hidden = true;
    $("clearBtn").hidden = true;
    return;
  }
  const url = new URL(tab.url);
  const domain = url.hostname.replace(/^www\./, "");
  $("domain").textContent = domain;

  const load = async () => {
    const history = (await chrome.runtime.sendMessage({ type: "DP_GET_HISTORY", domain })) || [];
    const activity = (await chrome.runtime.sendMessage({ type: "DP_GET_ACTIVITY", domain })) || [];
    render(history, activity, url.pathname);
  };
  await load();

  $("clearBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "DP_CLEAR_HISTORY", domain });
    await load();
  });
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      const which = btn.dataset.tab;
      $("tab-visits").hidden = which !== "visits";
      $("tab-clicks").hidden = which !== "clicks";
      // Draw after the tab is visible.
      if (which === "visits" && state.visitsDraw) state.visitsDraw();
      if (which === "clicks" && state.clicksDraw) state.clicksDraw();
    });
  });
}

function render(history, activity, path) {
  const visits = DP.analyzeVisits(history, path);
  const clicks = DP.analyzeClicks(history, activity);

  renderVisits(visits);
  renderClicks(clicks);

  const v = $("verdict");
  if (visits) {
    v.hidden = false;
    v.textContent = visits.verdict.text;
    v.className = "chip " + visits.verdict.tone;
  } else {
    v.hidden = true;
  }

  $("footerInfo").textContent = `${history.length} visit(s) · ${activity.length} click(s) recorded`;
}

// ---------------------------------------------------------------- helpers
function tile(label, value, tone) {
  const t = el("div", "tile");
  t.appendChild(el("div", "v" + (tone ? " " + tone : ""), value));
  t.appendChild(el("div", "l", label));
  return t;
}

function fmtDelta(n) {
  const r = Math.round(n * 10) / 10;
  return (r > 0 ? "+" : "") + r;
}

function table(headers, rows) {
  const t = el("table");
  const head = el("tr");
  headers.forEach(([text, cls]) => head.appendChild(el("th", cls || "", text)));
  t.appendChild(head);
  rows.forEach((r) => t.appendChild(r));
  return t;
}

function cell(content, cls) {
  const td = el("td", cls || "");
  if (content instanceof Node) td.appendChild(content);
  else td.textContent = content;
  return td;
}

// ---------------------------------------------------------------- visits tab
function renderVisits(a) {
  const tiles = $("visitTiles");
  const box = $("visitChartBox");
  const tbl = $("visitTable");
  tiles.innerHTML = "";
  tbl.innerHTML = "";
  state.visitsDraw = null;

  if (!a) {
    box.hidden = true;
    tiles.hidden = true;
    tbl.appendChild(
      el("div", "empty", "No scans yet. Browse this site normally, wait a few seconds after a page loads, then reopen this popup.")
    );
    return;
  }
  box.hidden = false;
  tiles.hidden = false;

  const diff = a.latestScore - a.baseAvgScore;
  tiles.appendChild(tile(a.usingPage ? "visits (this page)" : "visits (site)", String(a.series.length)));
  tiles.appendChild(tile("latest score", String(a.latestScore)));
  tiles.appendChild(
    tile("vs earlier avg", a.baseCount ? fmtDelta(diff) : "—", a.baseCount ? (diff > 0 ? "bad" : diff < 0 ? "good" : "") : "")
  );
  tiles.appendChild(tile("patterns now", String(a.activeNow)));

  const points = a.series.map((s, i) => ({
    value: a.scores[i],
    xLabel: String(i + 1),
    hot: i > 0 && a.scores[i] > a.scores[i - 1],
    tip: `Visit ${i + 1} · ${new Date(s.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · score ${a.scores[i]}`,
  }));
  const last = points[points.length - 1];
  state.visitsDraw = () => drawChart($("visitChart"), $("visitReadout"), points, COLORS.visits, last.tip);
  state.visitsDraw();

  if (!a.rows.length) {
    tbl.appendChild(el("div", "empty", "No dark patterns detected on the latest visit."));
    return;
  }

  const rows = a.rows.map((r) => {
    const tr = el("tr");
    tr.title = r.samples.join(" | ");
    const [txt, cls] = STATUS[r.status];
    tr.appendChild(cell(r.label));
    tr.appendChild(cell(String(r.now), "num"));
    tr.appendChild(cell(a.baseCount ? String(Math.round(r.before * 10) / 10) : "—", "num"));
    tr.appendChild(cell(`${r.seen}/${r.of}`, "num"));
    tr.appendChild(cell(el("span", "st " + cls, txt)));
    return tr;
  });
  tbl.appendChild(table([["Pattern"], ["Now", "num"], ["Avg", "num"], ["Seen", "num"], ["Trend"]], rows));
  tbl.appendChild(
    el(
      "div",
      "note",
      a.baseCount
        ? `Compared with ${a.baseCount} earlier visit(s) to ${a.usingPage ? "this page" : "this site"}. Score is weighted by severity.`
        : "Visit again later to see how patterns change."
    )
  );
}

// ---------------------------------------------------------------- clicks tab
function renderClicks(a) {
  const tiles = $("clickTiles");
  const box = $("clickChartBox");
  const tbl = $("clickTable");
  tiles.innerHTML = "";
  tbl.innerHTML = "";
  state.clicksDraw = null;

  if (!a) {
    box.hidden = true;
    tiles.hidden = true;
    tbl.appendChild(
      el("div", "empty", "No clicks tracked yet. Click around the page (buttons, links, menus), then reopen this popup.")
    );
    return;
  }
  box.hidden = false;
  tiles.hidden = false;

  tiles.appendChild(tile("clicks tracked", String(a.clickCount)));
  tiles.appendChild(tile("peak score", String(a.peak)));
  tiles.appendChild(tile("clicks that changed", String(a.changed.length)));
  tiles.appendChild(tile("new patterns", String(a.newPatterns), a.newPatterns ? "bad" : ""));

  const points = a.steps.map((s) => ({
    value: s.score,
    xLabel: String(s.index),
    hot: !s.isLoad && (s.delta > 0 || s.added.length > 0),
    tip: s.isLoad
      ? `Page load · score ${s.score}`
      : `Click ${s.index} · "${s.label}" · score ${s.score} (${fmtDelta(s.delta)})`,
  }));
  const last = points[points.length - 1];
  state.clicksDraw = () => drawChart($("clickChart"), $("clickReadout"), points, COLORS.clicks, last.tip);
  // Tab is hidden on first render; it draws when the tab is opened.
  if (!$("tab-clicks").hidden) state.clicksDraw();

  if (!a.changed.length) {
    tbl.appendChild(el("div", "empty", "None of the tracked clicks changed which dark patterns appear."));
    return;
  }

  const MAX_ROWS = 6;
  const shown = a.changed.slice(-MAX_ROWS);
  const rows = shown.map((s) => {
    const tr = el("tr");
    tr.appendChild(cell(String(s.index), "num"));
    tr.appendChild(cell(s.label, "clip"));
    tr.appendChild(cell(el("span", s.delta > 0 ? "up" : s.delta < 0 ? "down" : "", fmtDelta(s.delta)), "num"));
    const what = [];
    if (s.added.length) what.push("+ " + s.added.join(", "));
    if (s.removed.length) what.push("− " + s.removed.join(", "));
    tr.appendChild(cell(what.join("  ") || "—"));
    return tr;
  });
  tbl.appendChild(table([["#", "num"], ["Clicked"], ["Δ", "num"], ["What changed"]], rows));
  if (a.changed.length > MAX_ROWS) {
    tbl.appendChild(el("div", "note", `Showing the latest ${MAX_ROWS} of ${a.changed.length} clicks that changed something.`));
  }
}

// ---------------------------------------------------------------- chart
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function drawChart(canvas, readout, points, color, defaultText) {
  const W = 352, H = 130;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d");

  const L = 26, R = 10, T = 10, B = 20;
  const plotW = W - L - R, plotH = H - T - B;
  const n = points.length;
  const yMax = Math.max(4, Math.ceil(Math.max(...points.map((p) => p.value), 0) / 2) * 2);
  const xAt = (i) => (n === 1 ? L + plotW / 2 : L + (i * plotW) / (n - 1));
  const yAt = (v) => T + plotH - (v / yMax) * plotH;

  function paint(hover) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px -apple-system, "Segoe UI", Roboto, sans-serif';

    // grid + y labels
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    [0, yMax / 2, yMax].forEach((v) => {
      const y = yAt(v);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(W - R, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(String(v), L - 6, y);
    });

    // x labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = COLORS.axis;
    const step = Math.ceil(n / 8);
    points.forEach((p, i) => {
      if (i % step === 0) ctx.fillText(p.xLabel, xAt(i), H - B + 6);
    });

    if (n > 1) {
      // gradient area
      const g = ctx.createLinearGradient(0, T, 0, T + plotH);
      g.addColorStop(0, rgba(color, 0.35));
      g.addColorStop(1, rgba(color, 0));
      ctx.beginPath();
      ctx.moveTo(xAt(0), yAt(0));
      points.forEach((p, i) => ctx.lineTo(xAt(i), yAt(p.value)));
      ctx.lineTo(xAt(n - 1), yAt(0));
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();

      // line
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(xAt(i), yAt(p.value)) : ctx.moveTo(xAt(i), yAt(p.value))));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // points
    points.forEach((p, i) => {
      const x = xAt(i), y = yAt(p.value);
      const r = i === hover ? 5 : p.hot ? 4 : 3;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.hot ? COLORS.hot : color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLORS.bg;
      ctx.stroke();
      if (i === hover || i === n - 1) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(p.hot ? COLORS.hot : color, 0.5);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });
  }

  paint(-1);
  readout.textContent = defaultText;

  canvas.onmousemove = (e) => {
    const x = e.clientX - canvas.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(xAt(i) - x) < Math.abs(xAt(best) - x)) best = i;
    paint(best);
    readout.textContent = points[best].tip;
  };
  canvas.onmouseleave = () => {
    paint(-1);
    readout.textContent = defaultText;
  };
}

init();
