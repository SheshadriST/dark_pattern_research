// Shared analysis helpers used by the popup.
// Turns raw snapshots into scores, "evolution" statuses and chart-ready series.

const DP = (() => {
  const LABELS = {
    urgency: "Urgency / Countdown",
    scarcity: "Scarcity",
    socialProof: "Social Proof",
    forcedContinuity: "Forced Continuity",
    autoRenew: "Auto-renewal",
    confirmshaming: "Confirmshaming",
    preCheckedConsent: "Pre-checked Consent",
    visualAsymmetry: "Visual Asymmetry",
    nagging: "Nagging Popups",
  };

  // Heavier weight = more manipulative / more harmful to the user.
  const WEIGHTS = {
    urgency: 2,
    scarcity: 2,
    socialProof: 1,
    forcedContinuity: 3,
    autoRenew: 1,
    confirmshaming: 3,
    preCheckedConsent: 3,
    visualAsymmetry: 2,
    nagging: 2,
  };

  const COUNT_CAP = 5; // one very repetitive pattern shouldn't dominate the score
  const WINDOW = 10; // most recent visits shown on the chart
  const BASELINE_N = 6; // earlier visits used as the "normal" level

  const labelOf = (k) => LABELS[k] || k;
  const countOf = (snap, k) => (snap.categories && snap.categories[k] ? snap.categories[k].count : 0);
  const keysOf = (snap) => Object.keys(snap.categories || {}).filter((k) => countOf(snap, k) > 0);

  // Weighted score (computed on the fly so old stored snapshots stay comparable).
  function scoreOf(snap) {
    let total = 0;
    for (const k of Object.keys(snap.categories || {})) {
      total += (WEIGHTS[k] || 1) * Math.min(countOf(snap, k), COUNT_CAP);
    }
    return total;
  }

  function pathOf(snap) {
    if (snap.path) return snap.path;
    try {
      return new URL(snap.url).pathname;
    } catch (e) {
      return "/";
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  // ---------------------------------------------------------------
  // Evolution across repeat visits
  // Compares the latest visit with the average of earlier visits.
  // Prefers visits to the same page (pathname) so a home page is not
  // compared with a checkout page.
  // ---------------------------------------------------------------
  function analyzeVisits(history, path) {
    if (!history.length) return null;

    const samePage = history.filter((h) => pathOf(h) === path);
    const usingPage = samePage.length >= 2;
    const series = (usingPage ? samePage : history).slice(-WINDOW);
    const latest = series[series.length - 1];
    const base = series.slice(0, -1).slice(-BASELINE_N);

    const scores = series.map(scoreOf);
    const latestScore = scores[scores.length - 1];
    const baseAvgScore = avg(base.map(scoreOf));

    const keys = new Set();
    series.forEach((s) => keysOf(s).forEach((k) => keys.add(k)));

    const order = { new: 0, rising: 1, stable: 2, falling: 3, gone: 4, first: 5 };
    const rows = [];
    for (const k of keys) {
      const now = countOf(latest, k);
      const before = avg(base.map((s) => countOf(s, k)));
      const baseSeen = base.filter((s) => countOf(s, k) > 0).length;
      const seen = series.filter((s) => countOf(s, k) > 0).length;

      let status;
      if (!base.length) status = "first";
      else if (now > 0 && baseSeen === 0) status = "new";
      else if (now === 0) status = "gone";
      else if (now >= before * 1.5 && now - before >= 1) status = "rising";
      else if (now <= before * 0.5) status = "falling";
      else status = "stable";

      const samples = (latest.categories[k] && latest.categories[k].samples) || [];
      rows.push({ key: k, label: labelOf(k), now, before, seen, of: series.length, status, samples });
    }
    rows.sort((a, b) => order[a.status] - order[b.status] || b.now - a.now);

    const newCount = rows.filter((r) => r.status === "new").length;
    const diff = latestScore - baseAvgScore;
    let verdict;
    if (!base.length) {
      verdict = { tone: "info", text: "First scan" };
    } else if (newCount > 0 || (diff >= 2 && latestScore >= baseAvgScore * 1.25)) {
      verdict = { tone: "bad", text: "Escalating" };
    } else if (diff <= -2 && latestScore <= baseAvgScore * 0.75) {
      verdict = { tone: "good", text: "Improving" };
    } else {
      verdict = { tone: "flat", text: "Steady" };
    }

    return {
      series,
      scores,
      latest,
      latestScore,
      baseAvgScore,
      baseCount: base.length,
      usingPage,
      rows,
      verdict,
      activeNow: keysOf(latest).length,
    };
  }

  // ---------------------------------------------------------------
  // Evolution across activity (clicks) within the latest page session
  // Step 0 = page load, then one step per tracked click.
  // ---------------------------------------------------------------
  function analyzeClicks(history, activity) {
    if (!activity.length) return null;

    const sid = activity[activity.length - 1].sessionId;
    const clicks = activity.filter((a) => a.sessionId === sid);
    const start = history.find((h) => h.sessionId === sid);

    const raw = [];
    if (start) raw.push({ label: "Page load", snap: start });
    clicks.forEach((c) => raw.push({ label: c.trigger || "click", snap: c }));

    const steps = raw.map((s, i) => {
      const prev = i > 0 ? raw[i - 1].snap : null;
      const score = scoreOf(s.snap);
      const delta = prev ? score - scoreOf(prev) : 0;
      const prevKeys = prev ? keysOf(prev) : [];
      const added = prev ? keysOf(s.snap).filter((k) => !prevKeys.includes(k)) : [];
      const removed = prev ? prevKeys.filter((k) => countOf(s.snap, k) === 0) : [];
      return {
        index: start ? i : i + 1, // 0 = page load
        label: s.label,
        score,
        delta,
        added: added.map(labelOf),
        removed: removed.map(labelOf),
        isLoad: start && i === 0,
      };
    });

    const clickSteps = steps.filter((s) => !s.isLoad);
    const changed = clickSteps.filter((s) => s.delta !== 0 || s.added.length || s.removed.length);
    const newPatterns = new Set();
    changed.forEach((s) => s.added.forEach((a) => newPatterns.add(a)));

    return {
      steps,
      changed,
      clickCount: clickSteps.length,
      peak: Math.max(...steps.map((s) => s.score), 0),
      newPatterns: newPatterns.size,
      path: pathOf(clicks[clicks.length - 1]),
    };
  }

  return { LABELS, labelOf, scoreOf, pathOf, analyzeVisits, analyzeClicks };
})();
