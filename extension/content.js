(function () {
  if (window.__dpWatchInjected) return;
  window.__dpWatchInjected = true;
  const TEXT_PATTERNS = [
    {
      key: "urgency",
      label: "Urgency / Countdown",
      regex: /\b(hurry|only \d+\s*(left|remaining)|ends? (in|today|tonight)|limited time only|offer expires|sale ends soon|last chance|almost gone)\b/i,
    },
    {
      key: "scarcity",
      label: "Scarcity",
      regex: /\b(\d+\s*(people|others)\s*(are\s*)?(viewing|looking at|bought)|selling fast|in high demand|only \d+\s*(left|in stock)|low stock)\b/i,
    },
    {
      key: "socialProof",
      label: "Social Proof Pressure",
      regex: /\b\d[\d,]*\+?\s*(people|customers|users)\s*(bought|purchased|signed up|joined|booked)\s*(today|this week|recently|in the last)/i,
    },
    {
      key: "forcedContinuity",
      label: "Forced Continuity",
      regex: /\bfree trial\b.{0,60}\b(then|after which)\b.{0,20}\$?\d+/i,
    },
    {
      key: "autoRenew",
      label: "Auto-renewal Notice",
      regex: /\bauto[- ]renew(s|al)?\b/i,
    },
  ];

  function scanText() {
    const found = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let scanned = 0;
    while ((node = walker.nextNode()) && scanned < 20000) {
      scanned++;
      const text = node.textContent.trim();
      if (!text || text.length < 4) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") continue;
      for (const p of TEXT_PATTERNS) {
        if (p.regex.test(text)) {
          if (!found[p.key]) found[p.key] = { label: p.label, count: 0, samples: [] };
          found[p.key].count++;
          if (found[p.key].samples.length < 3) found[p.key].samples.push(text.slice(0, 140));
        }
      }
    }
    return found;
  }

  // Category 6: confirmshaming (guilt-tripping decline buttons) -------
  function scanConfirmshaming() {
    const els = Array.from(document.querySelectorAll('button, a, [role="button"], span[onclick]'));
    const pattern = /\b(no[, ]+i (don'?t|do not)|no thanks[, ]+i|i don'?t want|skip (this )?(deal|offer|discount)|i'?d rather pay full price)\b/i;
    const out = { label: "Confirmshaming", count: 0, samples: [] };
    for (const e of els) {
      const t = (e.innerText || "").trim();
      if (t.length > 8 && t.length < 200 && pattern.test(t)) {
        out.count++;
        if (out.samples.length < 3) out.samples.push(t.slice(0, 140));
      }
    }
    return out.count ? { confirmshaming: out } : {};
  }

  // Category 7: pre-checked consent/marketing checkboxes
  function scanPreChecked() {
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    const consentWords = /(subscribe|newsletter|marketing|offers|partners|third[- ]party|share my (data|info)|keep me updated|sign me up)/i;
    const out = { label: "Pre-checked Consent Box", count: 0, samples: [] };
    for (const b of boxes) {
      if (!b.defaultChecked) continue;
      let labelText = "";
      if (b.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(b.id)}"]`);
        if (lbl) labelText = lbl.innerText;
      }
      if (!labelText && b.closest("label")) labelText = b.closest("label").innerText;
      if (!labelText && b.parentElement) labelText = b.parentElement.innerText.slice(0, 140);
      if (consentWords.test(labelText)) {
        out.count++;
        if (out.samples.length < 3) out.samples.push(labelText.slice(0, 140));
      }
    }
    return out.count ? { preCheckedConsent: out } : {};
  }

  // Category 8: visual asymmetry (huge "accept" vs tiny "decline") 
  function scanVisualAsymmetry() {
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'));
    const acceptWords = /(accept|agree|subscribe|continue|yes|buy|join|claim|get started|sign up)/i;
    const declineWords = /(no thanks|decline|cancel|reject|not now|skip|maybe later|no, thank)/i;
    let acceptEl = null,
      declineEl = null;
    for (const b of buttons) {
      const t = (b.innerText || "").trim();
      if (!t) continue;
      if (!acceptEl && acceptWords.test(t)) acceptEl = b;
      if (!declineEl && declineWords.test(t)) declineEl = b;
    }
    if (!acceptEl || !declineEl) return {};
    const a = acceptEl.getBoundingClientRect();
    const d = declineEl.getBoundingClientRect();
    const areaA = Math.max(a.width * a.height, 1);
    const areaD = Math.max(d.width * d.height, 1);
    const ratio = areaA / areaD;
    if (ratio > 2.5) {
      return {
        visualAsymmetry: {
          label: "Visual Asymmetry (accept vs decline)",
          count: 1,
          samples: [`Accept control is ~${ratio.toFixed(1)}x larger than the decline control`],
        },
      };
    }
    return {};
  }

  // Category 9: nagging (popups/overlays appearing).
  // One observer runs for the whole page life; each scan "takes" the popups
  // that appeared since the previous scan.
  let popupBuffer = 0;
  const seenNodes = new WeakSet();
  const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="popup" i], [class*="overlay" i]';

  function isModalLike(node) {
    if (node.nodeType !== 1) return false;
    const role = node.getAttribute && node.getAttribute("role");
    const cls = typeof node.className === "string" ? node.className : "";
    if (role === "dialog" || role === "alertdialog") return true;
    if (/\b(modal|popup|overlay|dialog|interstitial)\b/i.test(cls)) return true;
    return !!(node.querySelector && node.querySelector(MODAL_SELECTOR));
  }

  function startPopupObserver() {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (isModalLike(n) && !seenNodes.has(n)) {
            seenNodes.add(n);
            popupBuffer++;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function takePopups(windowMs) {
    const count = popupBuffer;
    popupBuffer = 0;
    if (!count) return {};
    return {
      nagging: {
        label: "Repeated Popups / Overlays",
        count,
        samples: [`${count} popup-like element(s) appeared within ${Math.max(1, Math.round(windowMs / 1000))}s`],
      },
    };
  }

  // Snapshot building --------------------------------------------------
  const SESSION_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const domain = location.hostname.replace(/^www\./, "");

  function buildSnapshot(windowMs) {
    const categories = {
      ...scanText(),
      ...scanConfirmshaming(),
      ...scanPreChecked(),
      ...scanVisualAsymmetry(),
      ...takePopups(windowMs),
    };
    return {
      sessionId: SESSION_ID,
      url: location.href,
      path: location.pathname,
      domain,
      timestamp: Date.now(),
      categories,
      totalScore: Object.values(categories).reduce((s, c) => s + c.count, 0),
    };
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {
      // Extension was reloaded/updated while this tab was open - ignore.
    }
  }

  // Visit scan (page load) ----------------------------------------------
  let loadDone = false;
  const LOAD_SETTLE_MS = 1500;
  const LOAD_POPUP_WINDOW_MS = 4500;

  function runLoadScan() {
    startPopupObserver();
    setTimeout(() => {
      send({ type: "DP_SCAN_RESULT", payload: buildSnapshot(LOAD_POPUP_WINDOW_MS) });
      loadDone = true;
    }, LOAD_POPUP_WINDOW_MS);
  }

  // Activity scan (clicks) ----------------------------------------------
  // After each click, wait briefly for the page to react, then re-scan.
  const MAX_CLICK_SCANS = 40;
  const CLICK_SETTLE_MS = 700;
  let clickCount = 0;
  let clickTimer = null;
  let pendingLabel = "";

  function describeTarget(target) {
    const el =
      target.closest &&
      target.closest('button, a, [role="button"], input, select, summary, label');
    if (!el) return `<${(target.tagName || "element").toLowerCase()}>`;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select") {
      // Never record what the user typed - only button-like values.
      const type = (el.type || "").toLowerCase();
      if (type === "submit" || type === "button") return (el.value || "button").slice(0, 40);
      return `<${tag}${type ? " " + type : ""}>`;
    }
    const text = (el.getAttribute("aria-label") || el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return text || `<${tag}>`;
  }

  // Classify what the user clicked: accept / reject / close / other.
  // Based on the visible label only (never typed input).
  const ACCEPT_RE = /\b(accept|agree|allow|ok(ay)?|got it|i understand|yes|continue|subscribe|sign up|join|buy|add to (cart|bag)|claim|get started)\b/i;
  const REJECT_RE = /\b(reject|decline|deny|refuse|disagree|no thanks?|not now|maybe later|opt[- ]?out|necessary only|only necessary|essential only|manage|skip|cancel)\b/i;
  const CLOSE_RE = /^(x|×|✕|✖|close|dismiss|clos(e|ing)( (dialog|popup|modal))?)$/i;
  function classifyAction(target) {
    const el = target.closest && target.closest('button, a, [role="button"], input, summary, label, [aria-label]');
    if (!el) return "other";
    const label = ((el.getAttribute && el.getAttribute("aria-label")) || el.innerText || el.value || el.title || "").trim().replace(/\s+/g, " ");
    const cls = typeof el.className === "string" ? el.className : "";
    if (CLOSE_RE.test(label) || /\b(close|dismiss)\b/i.test(cls) || /^(close|dismiss)/i.test(label)) return "close";
    if (label.length > 60) return "other";
    if (REJECT_RE.test(label)) return "reject";
    if (ACCEPT_RE.test(label)) return "accept";
    return "other";
  }
  let pendingAction = "other";

  function runClickScan() {
    clickTimer = null;
    clickCount++;
    const snap = buildSnapshot(CLICK_SETTLE_MS);
    snap.step = clickCount;
    snap.trigger = pendingLabel;
    snap.action = pendingAction;
    send({ type: "DP_ACTIVITY_RESULT", payload: snap });
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || !loadDone || clickCount >= MAX_CLICK_SCANS) return;
      pendingLabel = describeTarget(e.target);
      pendingAction = classifyAction(e.target);
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(runClickScan, CLICK_SETTLE_MS);
    },
    true
  );

  // Start once the page has had a moment to settle.
  if (document.readyState === "complete") {
    setTimeout(runLoadScan, LOAD_SETTLE_MS);
  } else {
    window.addEventListener("load", () => setTimeout(runLoadScan, LOAD_SETTLE_MS));
  }
})();
