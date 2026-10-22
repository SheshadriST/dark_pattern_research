import argparse
import json
import os
import sys
import warnings

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

warnings.filterwarnings("ignore")

CATS = ["urgency", "scarcity", "socialProof", "forcedContinuity", "autoRenew",
        "confirmshaming", "preCheckedConsent", "visualAsymmetry", "nagging"]
LABELS = {"urgency": "Urgency", "scarcity": "Scarcity", "socialProof": "Social proof",
          "forcedContinuity": "Forced continuity", "autoRenew": "Auto-renewal",
          "confirmshaming": "Confirmshaming", "preCheckedConsent": "Pre-checked consent",
          "visualAsymmetry": "Visual asymmetry", "nagging": "Nagging popups"}
WEIGHTS = {"urgency": 2, "scarcity": 2, "socialProof": 1, "forcedContinuity": 3, "autoRenew": 1,
           "confirmshaming": 3, "preCheckedConsent": 3, "visualAsymmetry": 2, "nagging": 2}
COUNT_CAP = 5
ACTIONS = ["accept", "reject", "close", "other"]
PAL = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#000000", "#999999"]
CAT_COLOR = dict(zip(CATS, PAL))
INK, MUTED, GRID = "#222222", "#6b7280", "#e5e7eb"
SEED = 7

plt.rcParams.update({"font.size": 9, "axes.edgecolor": MUTED, "axes.labelcolor": INK,
                     "xtick.color": MUTED, "ytick.color": MUTED, "axes.spines.top": False,
                     "axes.spines.right": False, "axes.grid": True, "grid.color": GRID,
                     "grid.linewidth": 0.6, "axes.axisbelow": True, "figure.dpi": 110,
                     "savefig.bbox": "tight", "savefig.facecolor": "white"})


def snaps_to_df(snaps):
    rows = []
    for s in snaps:
        cats = s.get("categories") or {}
        r = {"sessionId": s.get("sessionId"), "domain": s.get("domain"), "path": s.get("path") or "/",
             "timestamp": s.get("timestamp"), "step": s.get("step", 0),
             "trigger": s.get("trigger", ""), "action": s.get("action", "")}
        for k in CATS:
            r[k] = int((cats.get(k) or {}).get("count", 0))
        rows.append(r)
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["total"] = df[CATS].sum(axis=1)
    df["score"] = sum(WEIGHTS[k] * df[k].clip(upper=COUNT_CAP) for k in CATS)
    df["n_types"] = (df[CATS] > 0).sum(axis=1)
    return df


def load(path, tz):
    data = json.load(open(path))
    v, c = snaps_to_df(data.get("history", [])), snaps_to_df(data.get("activity", []))
    for d in (v, c):
        if len(d):
            d["time"] = pd.to_datetime(d["timestamp"], unit="ms", utc=True).dt.tz_convert(tz)
    return v, c


def prepare(v, c, group_by):
    v = v.sort_values("timestamp").reset_index(drop=True)
    v["group"] = v["domain"] + (v["path"] if group_by == "page" else "")
    v["visit_no"] = v.groupby("group").cumcount() + 1
    if len(c):
        c = c.sort_values(["sessionId", "timestamp"]).reset_index(drop=True)
        c["action"] = c["action"].replace("", "other").fillna("other")
        c.loc[~c["action"].isin(ACTIONS), "action"] = "other"
    return v, c


def classify(seq):
    p = np.array(seq) > 0
    n = len(p)
    if not p.any():
        return None
    frac = p.mean()
    tail = p[-2:] if n >= 4 else p[-1:]
    if p[-1] and p[0] and frac >= 0.8:
        return "persistent"
    if p[-1] and not p[0]:
        return "emerged"
    if not tail.any():
        return "disappeared"
    return "intermittent"


def evolution(v, min_visits):
    rows = []
    for g, d in v.groupby("group"):
        if len(d) < min_visits:
            continue
        for k in CATS:
            seq = d[k].tolist()
            st = classify(seq)
            if st:
                rows.append({"group": g, "pattern": LABELS[k], "key": k, "n_visits": len(d),
                             "first_count": seq[0], "last_count": seq[-1],
                             "mean_count": round(float(np.mean(seq)), 2),
                             "pct_visits_present": round(100 * np.mean(np.array(seq) > 0)),
                             "status": st})
    return pd.DataFrame(rows)


def fig_counts(v, out):
    groups = [g for g, d in v.groupby("group") if len(d) >= 2]
    groups = sorted(groups, key=lambda g: -len(v[v.group == g]))[:12]
    if not groups:
        return
    ncol = min(3, len(groups))
    nrow = int(np.ceil(len(groups) / ncol))
    fig, axes = plt.subplots(nrow, ncol, figsize=(4.2 * ncol, 2.6 * nrow + 0.8), squeeze=False, sharey=True)
    for ax in axes.ravel():
        ax.set_visible(False)
    for ax, g in zip(axes.ravel(), groups):
        ax.set_visible(True)
        d = v[v.group == g]
        bottom = np.zeros(len(d))
        for k in CATS:
            vals = d[k].values
            if vals.sum() == 0:
                continue
            ax.bar(d.visit_no, vals, bottom=bottom, color=CAT_COLOR[k], width=0.75,
                   edgecolor="white", linewidth=0.8)
            bottom += vals
        ax.set_title(g[:34], fontsize=9, color=INK, loc="left")
        ax.xaxis.set_major_locator(matplotlib.ticker.MaxNLocator(integer=True))
        ax.grid(axis="x", visible=False)
    for ax in axes[:, 0]:
        ax.set_ylabel("patterns detected")
    for ax in axes[-1]:
        ax.set_xlabel("visit #")
    handles = [plt.Rectangle((0, 0), 1, 1, color=CAT_COLOR[k]) for k in CATS if v[k].sum() > 0]
    labs = [LABELS[k] for k in CATS if v[k].sum() > 0]
    if handles:
        fig.legend(handles, labs, ncol=min(5, len(labs)), loc="lower center", frameon=False,
                   bbox_to_anchor=(0.5, -0.02))
    fig.suptitle("Dark-pattern count per visit, by category", x=0.01, ha="left", fontsize=11, color=INK)
    fig.tight_layout(rect=(0, 0.05, 1, 0.96))
    fig.savefig(f"{out}/fig1_counts_per_visit.png")
    plt.close(fig)


def fig_score(v, out):
    fig, ax = plt.subplots(figsize=(7, 3.6))
    groups = sorted([g for g, d in v.groupby("group") if len(d) >= 2], key=lambda g: -len(v[v.group == g]))[:8]
    cols = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#999999", "#000000"]
    for g, c in zip(groups, cols):
        d = v[v.group == g]
        ax.plot(d.visit_no, d.score, color=c, lw=1.6, marker="o", ms=4, label=g[:28])
        ax.annotate(g[:18], (d.visit_no.iloc[-1], d.score.iloc[-1]), xytext=(4, 0),
                    textcoords="offset points", fontsize=7, color=INK, va="center")
    ax.set_xlabel("visit #")
    ax.set_ylabel("weighted dark-pattern score")
    ax.xaxis.set_major_locator(matplotlib.ticker.MaxNLocator(integer=True))
    if groups:
        ax.legend(frameon=False, fontsize=7, loc="upper left", bbox_to_anchor=(1.12, 1))
    ax.set_title("Weighted score across visits", loc="left", fontsize=11, color=INK)
    fig.savefig(f"{out}/fig2_score_over_visits.png")
    plt.close(fig)


def fig_status(ev, out):
    if ev.empty:
        return
    order = ["persistent", "intermittent", "emerged", "disappeared"]
    colr = {"persistent": "#0072B2", "intermittent": "#999999", "emerged": "#D55E00", "disappeared": "#009E73"}
    ev = ev.assign(domain=ev.group.str.split("/").str[0])
    t = ev.groupby(["domain", "status"]).size().unstack(fill_value=0).reindex(columns=order, fill_value=0)
    fig, ax = plt.subplots(figsize=(7, 0.45 * len(t) + 1.6))
    left = np.zeros(len(t))
    for s in order:
        ax.barh(t.index, t[s], left=left, color=colr[s], label=s, edgecolor="white", linewidth=1, height=0.65)
        left += t[s].values
    ax.set_xlabel("number of pattern categories")
    ax.grid(axis="y", visible=False)
    ax.legend(frameon=False, ncol=4, loc="lower center", bbox_to_anchor=(0.5, 1.0), fontsize=8)
    ax.xaxis.set_major_locator(matplotlib.ticker.MaxNLocator(integer=True))
    fig.suptitle("Which patterns persist, disappear or emerge", x=0.01, ha="left", fontsize=11, y=1.08)
    fig.savefig(f"{out}/fig3_pattern_evolution.png")
    plt.close(fig)


FEATS = {
    "current": ["cur_total", "cur_score", "cur_ntypes", "hour"],
    "history": ["h_n_visits", "h_mean_total", "h_last_total", "h_max_total", "h_trend", "h_gap_days"],
    "actions": ["a_clicks", "a_accept", "a_reject", "a_close", "a_end_total", "a_delta_total"],
}
SETS = {
    "A. Current visit only": ["current"],
    "B. + History": ["current", "history"],
    "C. + History + Actions": ["current", "history", "actions"],
}
MODELS = {"Linear regression": "linear", "Random forest": "forest"}


def build_ml_table(v, c):
    sess = {sid: d.sort_values("timestamp") for sid, d in c.groupby("sessionId")} if len(c) else {}
    rows = []
    for g, d in v.groupby("group"):
        d = d.sort_values("timestamp").reset_index(drop=True)
        for i in range(len(d) - 1):
            cur, nxt, prior = d.iloc[i], d.iloc[i + 1], d.iloc[:i]
            gap = (cur.time - d.iloc[i - 1].time).total_seconds() / 86400 if i else 0
            r = {"group": g, "domain": cur.domain, "time": cur.time, "visit_no": i + 1, "y": nxt.total,
                 "cur_total": cur.total, "cur_score": cur.score, "cur_ntypes": cur.n_types, "hour": cur.time.hour,
                 "h_n_visits": i,
                 "h_mean_total": prior.total.mean() if i else cur.total,
                 "h_last_total": d.iloc[i - 1].total if i else cur.total,
                 "h_max_total": prior.total.max() if i else cur.total,
                 "h_trend": (cur.total - prior.total.mean()) if i else 0,
                 "h_gap_days": min(gap, 30),
                 "a_clicks": 0, "a_accept": 0, "a_reject": 0, "a_close": 0,
                 "a_end_total": cur.total, "a_delta_total": 0}
            ca = sess.get(cur.sessionId)
            if ca is not None and len(ca):
                r.update(a_clicks=len(ca), a_accept=int((ca.action == "accept").sum()),
                         a_reject=int((ca.action == "reject").sum()), a_close=int((ca.action == "close").sum()),
                         a_end_total=ca.iloc[-1].total, a_delta_total=ca.iloc[-1].total - cur.total)
            rows.append(r)
    return pd.DataFrame(rows)


def make_model(kind):
    from sklearn.linear_model import LinearRegression
    from sklearn.ensemble import RandomForestRegressor
    if kind == "linear":
        return LinearRegression()
    return RandomForestRegressor(n_estimators=200, max_depth=4, min_samples_leaf=3, random_state=SEED)


def reg_metrics(y, p):
    from sklearn.metrics import mean_absolute_error, r2_score
    return {"MAE": mean_absolute_error(y, p),
            "RMSE": float(np.sqrt(np.mean((y - p) ** 2))),
            "R2": r2_score(y, p) if len(y) > 1 else np.nan}


def ml_compare(m, split):
    notes = []
    if len(m) < 20:
        return None, None, [f"ML skipped: only {len(m)} usable visit pairs (need at least 20)."]
    m = m.sort_values("time").reset_index(drop=True)
    n_in_group = m.groupby("group")["visit_no"].transform("max")
    test = (m.visit_no / n_in_group) > 0.7
    folds = [(~test.values, test.values)]
    if split == "domain":
        if m.domain.nunique() >= 3:
            folds = [((m.domain != d).values, (m.domain == d).values) for d in m.domain.unique()]
        else:
            notes.append("Fewer than 3 domains: used the chronological split instead.")
    elif test.sum() < 10:
        notes.append(f"Only {int(test.sum())} test rows with the chronological split; try --split domain.")

    preds = {}
    for mname, kind in MODELS.items():
        for sname, blocks in SETS.items():
            cols = [c_ for b in blocks for c_ in FEATS[b]]
            p = np.full(len(m), np.nan)
            for tr, te in folds:
                if tr.sum() < 5 or te.sum() == 0:
                    continue
                mod = make_model(kind).fit(m.loc[tr, cols].astype(float), m.y[tr])
                p[te] = np.clip(mod.predict(m.loc[te, cols].astype(float)), 0, None)
            preds[(mname, sname)] = p
    ok = ~np.isnan(next(iter(preds.values())))
    if ok.sum() < 8:
        return None, None, notes + ["ML skipped: too few test rows."]
    y = m.y.values[ok]
    g = m.group.values[ok]
    rows = []
    base = m.cur_total.values[ok].astype(float)
    rows.append({"model": "Baseline (next = now)", "features": "-", "n_test": int(ok.sum()),
                 **{k: round(x, 3) for k, x in reg_metrics(y, base).items()}})
    mean_p = np.full(len(y), m.y[~ok].mean() if (~ok).any() else m.y.mean())
    rows.append({"model": "Baseline (training mean)", "features": "-", "n_test": int(ok.sum()),
                 **{k: round(x, 3) for k, x in reg_metrics(y, mean_p).items()}})
    for (mname, sname), p in preds.items():
        rows.append({"model": mname, "features": sname, "n_test": int(ok.sum()),
                     **{k: round(x, 3) for k, x in reg_metrics(y, p[ok]).items()}})
    res = pd.DataFrame(rows)

    rng = np.random.default_rng(SEED)
    ug = np.unique(g)
    idx = {u: np.where(g == u)[0] for u in ug}
    gains = []
    for mname in MODELS:
        pa = preds[(mname, "A. Current visit only")][ok]
        for sname in list(SETS)[1:]:
            px = preds[(mname, sname)][ok]
            point = np.mean(np.abs(y - pa)) - np.mean(np.abs(y - px))
            ds = []
            for _ in range(1000):
                ii = np.concatenate([idx[u] for u in rng.choice(ug, len(ug))])
                ds.append(np.mean(np.abs(y[ii] - pa[ii])) - np.mean(np.abs(y[ii] - px[ii])))
            gains.append({"model": mname, "features": sname, "MAE_improvement": round(point, 3),
                          "ci_low": round(float(np.percentile(ds, 2.5)), 3),
                          "ci_high": round(float(np.percentile(ds, 97.5)), 3)})
    return res, pd.DataFrame(gains), notes


def fig_ml(res, gains, out):
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.9))
    x = np.arange(len(SETS))
    w = 0.38
    for j, (mname, col) in enumerate([("Linear regression", "#0072B2"), ("Random forest", "#E69F00")]):
        vals = [res[(res.model == mname) & (res.features == s)].MAE.mean() for s in SETS]
        ax[0].bar(x + (j - 0.5) * w, vals, w * 0.92, color=col, label=mname, edgecolor="white")
        for xi, vv in zip(x + (j - 0.5) * w, vals):
            ax[0].text(xi, vv + 0.02, f"{vv:.2f}", ha="center", fontsize=7, color=INK)
    b = res[res.model == "Baseline (next = now)"].MAE
    if len(b):
        ax[0].axhline(b.iloc[0], color="#D55E00", ls="--", lw=1)
        ax[0].text(len(SETS) - 0.5, b.iloc[0] + 0.02, "baseline: next = now", color="#D55E00", fontsize=7, ha="right")
    ax[0].set_xticks(x)
    ax[0].set_xticklabels([s.replace("+ ", "+\n") for s in SETS], fontsize=8)
    ax[0].set_ylabel("error in predicted pattern count (MAE, lower = better)")
    ax[0].grid(axis="x", visible=False)
    ax[0].legend(frameon=False, fontsize=8, ncol=2, loc="upper center", bbox_to_anchor=(0.5, -0.22))
    ax[0].set_title("Prediction error on held-out visits", loc="left", fontsize=10)
    labels, k = [], 0
    for mname, col in [("Linear regression", "#0072B2"), ("Random forest", "#E69F00")]:
        for _, g in gains[gains.model == mname].iterrows():
            ax[1].errorbar(g.MAE_improvement, k, xerr=[[g.MAE_improvement - g.ci_low], [g.ci_high - g.MAE_improvement]],
                           fmt="o", color=col, capsize=3)
            labels.append(f"{mname}: {g.features[3:]}")
            k += 1
    ax[1].axvline(0, color=MUTED, lw=0.8)
    ax[1].set_yticks(range(len(labels)))
    ax[1].set_yticklabels(labels, fontsize=8)
    ax[1].invert_yaxis()
    ax[1].set_xlabel("error reduction vs. 'Current visit only' (95% CI)\nright of 0 = extra info helps")
    ax[1].grid(axis="y", visible=False)
    ax[1].set_title("Does history / action info add value?", loc="left", fontsize=10)
    fig.suptitle("Current visit vs. current + history + actions", x=0.01, ha="left", fontsize=11, y=1.03)
    fig.tight_layout()
    fig.savefig(f"{out}/fig5_ml_comparison.png")
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export")
    ap.add_argument("--out", default="results")
    ap.add_argument("--group-by", choices=["page", "domain"], default="page")
    ap.add_argument("--min-visits", type=int, default=3)
    ap.add_argument("--split", choices=["chronological", "domain"], default="chronological")
    ap.add_argument("--tz", default="UTC")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    v, c = load(args.export, args.tz)
    if v.empty:
        sys.exit("No visit data in the file.")
    v, c = prepare(v, c, args.group_by)
    print(f"{len(v)} visits, {len(c)} click snapshots, {v.domain.nunique()} domains, {v.group.nunique()} series")

    v.drop(columns=["time"]).to_csv(f"{args.out}/visits_table.csv", index=False)
    ev = evolution(v, args.min_visits)
    ev.to_csv(f"{args.out}/evolution.csv", index=False)
    fig_counts(v, args.out)
    fig_score(v, args.out)
    fig_status(ev, args.out)

    res, gains, notes = ml_compare(build_ml_table(v, c), args.split)
    if res is not None:
        res.to_csv(f"{args.out}/ml_metrics.csv", index=False)
        fig_ml(res, gains, args.out)
    for n in notes:
        print(n)
    print(f"Done. Output written to {args.out}/")


if __name__ == "__main__":
    main()
