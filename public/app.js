/* ICRON LLM Visibility -- dashboard.
   No build step, no CDN. Charts are hand-rolled SVG so the page has no runtime
   dependencies and renders identically wherever Cloudflare serves it. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(
    tag === "svg" || SVG_TAGS.has(tag) ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml",
    tag,
  );
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.setAttribute("class", v);
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
  }
  return n;
};
const SVG_TAGS = new Set(["g", "rect", "path", "text", "line", "circle", "svg", "title", "polyline"]);

const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const num = (v, digits = 1) => (v === null || v === undefined ? "—" : Number(v).toFixed(digits));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = { view: "overview", facets: null, runs: [], filters: {}, me: null };

/* ------------------------------------------------------------------ fetch */
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) throw new Error("Session expired. Reload to sign in through Cloudflare Access.");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
  return res.json();
}
const qs = (extra = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...state.filters, ...extra })) {
    if (v && v !== "all") p.set(k, v);
  }
  return p.toString() ? `?${p}` : "";
};

/* --------------------------------------------------------------- tooltip */
const tip = $("#tooltip");
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.style.opacity = "1";
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip.style.opacity = "0"; };

/* ---------------------------------------------------------------- charts */
/** Horizontal bars. Rows carry their own colour so a filter never repaints them. */
function barChart(rows, { format = (v) => pct(v), max = null, height = 26, accent = "#435AEE" } = {}) {
  if (!rows.length) return el("div", { class: "empty" }, "No data for this slice.");
  const labelW = 132, valueW = 66, gap = 8, padR = 4;
  const w = 640;
  const plotX = labelW + gap;
  const plotW = w - plotX - valueW - padR;
  const top = rows.reduce((m, r) => Math.max(m, r.value), 0);
  const scaleMax = max ?? (top > 0 ? top : 1);
  const h = rows.length * height + 8;

  const svg = el("svg", {
    class: "chart", viewBox: `0 0 ${w} ${h}`, width: "100%", height: h,
    preserveAspectRatio: "xMinYMin meet", role: "img",
  });

  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const x = plotX + plotW * frac;
    svg.appendChild(el("line", { class: "grid-line", x1: x, y1: 2, x2: x, y2: h - 8 }));
  }

  rows.forEach((r, i) => {
    const y = i * height + 4;
    const barH = height - 10; // 2px+ of surface between adjacent bars
    const bw = Math.max(r.value > 0 ? 3 : 0, (r.value / scaleMax) * plotW);
    const color = r.color || accent;
    const g = el("g", {
      onmousemove: (e) => showTip(e, `<strong>${esc(r.label)}</strong><br>${esc(r.tip || format(r.value))}`),
      onmouseleave: hideTip,
    });
    g.appendChild(el("text", { class: "axis-label", x: labelW, y: y + barH / 2 + 4, "text-anchor": "end" }, r.label));
    g.appendChild(el("rect", { x: plotX, y, width: plotW, height: barH, fill: "#F0F1F3", rx: 4 }));
    if (bw > 0) g.appendChild(el("rect", { class: "bar", x: plotX, y, width: bw, height: barH, fill: color, rx: 4 }));
    g.appendChild(el("text", { class: "value-label", x: plotX + plotW + 8, y: y + barH / 2 + 4 }, format(r.value)));
    svg.appendChild(g);
  });
  return svg;
}

/** Grouped horizontal bars -- one group per row, one bar per series. */
function groupedBarChart(rows, series, { format = (v) => pct(v) } = {}) {
  if (!rows.length) return el("div", { class: "empty" }, "No data for this slice.");
  const labelW = 132, valueW = 8, gap = 8, barH = 14, barGap = 4, groupPad = 12;
  const w = 640, plotX = labelW + gap, plotW = w - plotX - valueW - 60;
  const groupH = series.length * (barH + barGap) + groupPad;
  const h = rows.length * groupH + 8;
  const top = Math.max(...rows.flatMap((r) => series.map((s) => r.values[s.key] ?? 0)), 0) || 1;

  const svg = el("svg", { class: "chart", viewBox: `0 0 ${w} ${h}`, width: "100%", height: h, preserveAspectRatio: "xMinYMin meet" });
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const x = plotX + plotW * frac;
    svg.appendChild(el("line", { class: "grid-line", x1: x, y1: 2, x2: x, y2: h - 8 }));
  }
  rows.forEach((r, i) => {
    const gy = i * groupH + 4;
    svg.appendChild(el("text", { class: "axis-label", x: labelW, y: gy + groupH / 2, "text-anchor": "end" }, r.label));
    series.forEach((s, j) => {
      const v = r.values[s.key] ?? 0;
      const y = gy + j * (barH + barGap);
      const bw = Math.max(v > 0 ? 3 : 0, (v / top) * plotW);
      const g = el("g", {
        onmousemove: (e) => showTip(e, `<strong>${esc(r.label)}</strong><br><span class="muted">${esc(s.label)}</span> ${esc(format(v))}`),
        onmouseleave: hideTip,
      });
      g.appendChild(el("rect", { x: plotX, y, width: plotW, height: barH, fill: "#F0F1F3", rx: 4 }));
      if (bw > 0) g.appendChild(el("rect", { class: "bar", x: plotX, y, width: bw, height: barH, fill: s.color, rx: 4 }));
      g.appendChild(el("text", { class: "value-label", x: plotX + plotW + 8, y: y + barH / 2 + 4 }, format(v)));
      svg.appendChild(g);
    });
  });
  return svg;
}

/** Multi-series line chart over runs. */
function lineChart(series, { yFormat = (v) => num(v, 1), yMax = null } = {}) {
  const points = series.flatMap((s) => s.points);
  if (!points.length) return el("div", { class: "empty" }, "Not enough runs yet. The trend appears from the second sweep.");
  const w = 1100, h = 300, padL = 52, padR = 16, padT = 14, padB = 44;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const xs = [...new Set(points.map((p) => p.x))].sort();
  const top = yMax ?? Math.max(...points.map((p) => p.y), 1) * 1.15;
  const xAt = (x) => padL + (xs.length === 1 ? plotW / 2 : (xs.indexOf(x) / (xs.length - 1)) * plotW);
  const yAt = (y) => padT + plotH - (y / top) * plotH;

  const svg = el("svg", { class: "chart fluid", viewBox: `0 0 ${w} ${h}`, width: "100%", preserveAspectRatio: "xMidYMid meet" });
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i, y = yAt(v);
    svg.appendChild(el("line", { class: "grid-line", x1: padL, y1: y, x2: w - padR, y2: y }));
    svg.appendChild(el("text", { class: "axis-label", x: padL - 8, y: y + 4, "text-anchor": "end" }, yFormat(v)));
  }
  xs.forEach((x) => {
    svg.appendChild(el("text", { class: "axis-label", x: xAt(x), y: h - padB + 18, "text-anchor": "middle" }, x));
  });

  for (const s of series) {
    const pts = s.points.slice().sort((a, b) => xs.indexOf(a.x) - xs.indexOf(b.x));
    if (pts.length > 1) {
      svg.appendChild(el("path", {
        class: "series-line", stroke: s.color,
        d: pts.map((p, i) => `${i ? "L" : "M"}${xAt(p.x).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(" "),
        "stroke-dasharray": s.dashed ? "5 4" : null,
      }));
    }
    for (const p of pts) {
      svg.appendChild(el("circle", {
        class: "marker", cx: xAt(p.x), cy: yAt(p.y), r: 5, fill: s.color,
        onmousemove: (e) => showTip(e, `<strong>${esc(s.label)}</strong><br><span class="muted">${esc(p.x)}</span> ${esc(yFormat(p.y))}${p.meta ? `<br><span class="muted">${esc(p.meta)}</span>` : ""}`),
        onmouseleave: hideTip,
      }));
    }
  }
  return svg;
}

const legend = (items) =>
  el("div", { class: "legend" },
    items.map((i) =>
      el("span", { class: "item" },
        el("span", { class: "swatch", style: `background:${i.color}` }), i.label)));

const tile = (k, v, d, hero = false) =>
  el("div", { class: `tile${hero ? " hero" : ""}` },
    el("div", { class: "k" }, k),
    el("div", { class: "v", html: v }),
    d ? el("div", { class: "d" }, d) : null);

const card = (title, hint, ...body) =>
  el("div", { class: "card" }, el("h2", {}, title), hint ? el("p", { class: "hint" }, hint) : null, ...body);

function table(headers, rows) {
  return el("div", { class: "table-wrap" },
    el("table", {},
      el("thead", {}, el("tr", {}, headers.map((h) =>
        el("th", { class: h.num ? "num" : null }, h.label ?? h)))),
      el("tbody", {}, rows)));
}

/* ----------------------------------------------------------------- views */
const VIEWS = {};

VIEWS.overview = async (root) => {
  const d = await api(`/api/overview${qs()}`);
  const self = d.brands.find((b) => b.isSelf);
  const rivals = d.brands.filter((b) => !b.isSelf);
  const answers = self?.answers ?? 0;

  if (!answers) {
    root.appendChild(el("div", { class: "note", html:
      "No results yet. Open the <strong>Runs</strong> tab and start a sweep, or wait for the Monday cron." }));
    return;
  }

  const bestRival = rivals.reduce((m, b) => (b.visibility > (m?.visibility ?? -1) ? b : m), null);

  root.appendChild(el("div", { class: "grid cols-3" },
    tile("ICRON visibility score", `${num(self.visibility, 1)}<small> / 100</small>`,
      "Mean reciprocal rank: named first scores 1.0, second 0.5, absent 0.", true),
    tile("Answers naming ICRON", pct(self.mentionRate),
      `${self.mentions} of ${answers} answers in this slice`),
    tile("Share of voice", pct(self.shareOfVoice),
      "ICRON's share of all tracked vendor mentions"),
    tile("Average position when named", num(self.avgRank, 2),
      `Named first in ${pct(self.firstPlaceRate)} of all answers`),
    tile("Strongest competitor", bestRival ? esc(bestRival.label) : "—",
      bestRival ? `${num(bestRival.visibility, 1)} visibility, ${pct(bestRival.mentionRate)} of answers` : ""),
    tile("Sweep cost", d.summary?.spend ? `$${num(d.summary.spend.costUsd, 2)}` : "—",
      d.summary?.spend?.sharedAnswers ? `${d.summary.spend.sharedAnswers} answers reused across identical prompts` : ""),
  ));

  root.appendChild(el("div", { class: "grid cols-2", style: "margin-top:16px" },
    card("Visibility score by vendor",
      "One number combining whether a vendor is named and how early. Higher is better.",
      barChart(d.brands.map((b) => ({
        label: b.label, value: b.visibility, color: b.color,
        tip: `${num(b.visibility, 1)} / 100 · named in ${pct(b.mentionRate)} of answers`,
      })), { format: (v) => num(v, 1), max: 100 })),

    card("Share of answers naming each vendor",
      "How often each vendor appears at all, regardless of position.",
      barChart(d.brands.map((b) => ({
        label: b.label, value: b.mentionRate, color: b.color,
        tip: `${b.mentions} of ${b.answers} answers`,
      })), { max: 1 })),
  ));

  const stanceTotal = d.stances.reduce((s, r) => s + r.n, 0);
  root.appendChild(el("div", { class: "grid cols-2", style: "margin-top:16px" },
    card("How answers position ICRON",
      "A mention is not automatically a win. This is the tone of the mentions we do get.",
      stanceTotal
        ? barChart(d.stances.map((s) => ({
            label: s.stance, value: s.n / stanceTotal,
            color: { recommended: "#06980B", listed: "#435AEE", qualified: "#B48B20", negative: "#B22C14" }[s.stance] || "#64748B",
            tip: `${s.n} of ${stanceTotal} mentions`,
          })), { max: 1 })
        : el("div", { class: "empty" }, "No ICRON mentions in this slice.")),

    card("Full scoreboard", "Every tracked vendor across the current slice.",
      table(
        ["Vendor", { label: "Visibility", num: true }, { label: "Mention rate", num: true },
         { label: "Avg. position", num: true }, { label: "Named first", num: true }, { label: "Share of voice", num: true }],
        d.brands.map((b) =>
          el("tr", { class: b.isSelf ? "is-self" : null },
            el("td", { html: `<span class="swatch" style="background:${b.color}"></span>${esc(b.label)}` }),
            el("td", { class: "num" }, num(b.visibility, 1)),
            el("td", { class: "num" }, pct(b.mentionRate)),
            el("td", { class: "num" }, num(b.avgRank, 2)),
            el("td", { class: "num" }, pct(b.firstPlaceRate)),
            el("td", { class: "num" }, pct(b.shareOfVoice)))))),
  ));
};

VIEWS.markets = async (root) => {
  const d = await api(`/api/overview${qs()}`);
  if (!d.byCountry.length) {
    root.appendChild(el("div", { class: "empty" }, "No results yet."));
    return;
  }
  const bar = (rows) => barChart(rows.map((r) => ({
    label: r.key, value: r.visibility, color: "#435AEE",
    tip: `${num(r.visibility, 1)} / 100 · named in ${r.mentions} of ${r.answers} answers (${pct(r.mentionRate)})`,
  })), { format: (v) => num(v, 1) });

  root.appendChild(el("div", { class: "note", html:
    "German prompts are shared between DE and CH, and Dutch prompts between NL and BE, so those pairs are <strong>not independent samples</strong>. Treat a DE–CH or NL–BE gap as noise until the prompts are localised." }));

  root.appendChild(el("div", { class: "grid cols-2" },
    card("ICRON visibility by market", "Where we are found, and where we are not.", bar(d.byCountry)),
    card("ICRON visibility by funnel layer",
      "Early problem framing, mid-funnel discovery, late-stage comparison.", bar(d.byIntent)),
  ));
  root.appendChild(el("div", { class: "grid", style: "margin-top:16px" },
    card("ICRON visibility by topic", "The categories the prompt set is designed to own.", bar(d.byTopic)),
  ));
};

VIEWS.trend = async (root) => {
  const rows = await api("/api/trend");
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.model} · ${r.mode}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const colors = ["#435AEE", "#0B9A83", "#B4671B", "#971CB2", "#06980B"];
  const series = [...byKey.entries()].map(([label, pts], i) => ({
    label, color: colors[i % colors.length], dashed: label.includes("ungrounded"),
    points: pts.map((p) => ({ x: p.label, y: p.visibility, meta: `named in ${pct(p.mentionRate)} of ${p.answers} answers` })),
  }));

  root.appendChild(card("ICRON visibility over time",
    "One line per model and grounding mode. Dashed lines are ungrounded (the model's own knowledge); solid lines use web search.",
    lineChart(series, { yFormat: (v) => num(v, 0), yMax: Math.max(20, ...rows.map((r) => r.visibility)) * 1.2 }),
    legend(series.map((s) => ({ label: s.label, color: s.color })))));
};

VIEWS.gaps = async (root) => {
  const rows = await api(`/api/gaps${qs()}`);
  root.appendChild(el("div", { class: "note", html:
    "Prompts where a competitor was named and <strong>ICRON was not</strong>. This is the content brief: each row is a real buyer question our market asks and we are missing from." }));
  if (!rows.length) {
    root.appendChild(el("div", { class: "empty" }, "No gaps in this slice."));
    return;
  }
  root.appendChild(card(`${rows.length} answers name a competitor but not ICRON`, null,
    table(["Market", "Topic", "Funnel layer", "Prompt (English)", "Named instead", "Model"],
      rows.map((r) =>
        el("tr", { style: "cursor:pointer", onclick: () => openPrompt(r.promptId) },
          el("td", {}, r.country),
          el("td", {}, r.topic),
          el("td", {}, r.intent),
          el("td", {}, r.promptEn),
          el("td", { html: esc(r.competitors || "") }),
          el("td", { html: `${esc(r.model.replace("claude-", ""))} <span class="pill ${r.mode}">${r.mode}</span>` }))))));
};

VIEWS.sources = async (root) => {
  const rows = await api(`/api/citations${qs()}`);
  root.appendChild(el("div", { class: "note", html:
    "Pages Claude actually read while answering, for grounded runs only. Domains with a high <strong>ICRON share</strong> are carrying our visibility; high-traffic domains with a zero ICRON share are the pages to go win." }));
  if (!rows.length) {
    root.appendChild(el("div", { class: "empty" }, "No citations in this slice. Ungrounded runs do not search."));
    return;
  }
  root.appendChild(el("div", { class: "grid cols-2" },
    card("Most-read domains", "Number of answers that cited the domain.",
      barChart(rows.slice(0, 18).map((r) => ({
        label: r.domain, value: r.total, color: r.withSelf > 0 ? "#435AEE" : "#64748B",
        tip: `${r.total} answers cited it; ${r.withSelf} of those named ICRON`,
      })), { format: (v) => String(v) })),
    card("All cited domains", null,
      table(["Domain", { label: "Answers", num: true }, { label: "…naming ICRON", num: true }, { label: "ICRON share", num: true }],
        rows.map((r) =>
          el("tr", {},
            el("td", { html: `<a href="https://${esc(r.domain)}" target="_blank" rel="noopener">${esc(r.domain)}</a>` }),
            el("td", { class: "num" }, r.total),
            el("td", { class: "num" }, r.withSelf),
            el("td", { class: "num" }, pct(r.withSelf / r.total, 0)))))),
  ));
};

VIEWS.prompts = async (root) => {
  const rows = await api(`/api/prompts${qs()}`);
  root.appendChild(card(`${rows.length} prompts`, "Click a row to see every answer Claude has given it.",
    table(["ID", "Market", "Lang", "Topic", "Funnel layer", "Prompt (English)"],
      rows.map((r) =>
        el("tr", { style: "cursor:pointer", onclick: () => openPrompt(r.id) },
          el("td", { class: "mono" }, r.id),
          el("td", {}, r.country),
          el("td", {}, r.language),
          el("td", {}, r.topic),
          el("td", {}, r.intent),
          el("td", {}, r.promptEn))))));
};

async function openPrompt(id) {
  switchView("promptDetail", () => VIEWS.promptDetail(document.getElementById("view"), id));
}

VIEWS.promptDetail = async (root, id) => {
  const d = await api(`/api/prompts/${encodeURIComponent(id)}`);
  const p = d.prompt;
  root.appendChild(el("div", { class: "row-actions", style: "margin-bottom:16px" },
    el("button", { class: "action ghost", onclick: () => switchView("prompts") }, "← Back to prompts")));
  root.appendChild(card(p.prompt_en,
    `${p.country} · ${p.language} · ${p.topic} · ${p.intent}`,
    el("p", { class: "mono", style: "background:#F0F1F3;padding:10px 12px;border-radius:6px" }, p.prompt_native)));

  if (!d.results.length) {
    root.appendChild(el("div", { class: "empty" }, "No answers recorded for this prompt yet."));
    return;
  }
  for (const r of d.results) {
    const ranks = (r.brandRanks || "").split("|").filter(Boolean)
      .map((s) => { const [label, rank] = s.split(":"); return { label, rank: Number(rank) }; })
      .sort((a, b) => a.rank - b.rank);
    const cites = JSON.parse(r.citations || "[]");
    root.appendChild(card(
      `${r.runLabel} · ${r.model.replace("claude-", "")}`,
      null,
      el("div", { class: "row-actions", style: "margin-bottom:12px" },
        el("span", { class: `pill ${r.mode}` }, r.mode),
        el("span", { class: `pill ${r.selfMentioned ? (r.selfStance || "listed") : "absent"}` },
          r.selfMentioned ? `ICRON ${r.selfStance || "mentioned"} · position ${r.selfRank}` : "ICRON absent"),
        ranks.length ? el("span", { style: "color:#64748B;font-size:12px" }, `Order named: ${ranks.map((x) => x.label).join(" → ")}`) : null,
        r.sharedFrom ? el("span", { class: "pill unclassified" }, "answer shared with the identical prompt in the paired market") : null),
      r.selfEvidence ? el("p", { class: "hint", style: "margin:0 0 10px" }, `Judge: ${r.selfEvidence}`) : null,
      el("div", { class: "answer" }, r.answer),
      cites.length
        ? el("details", { style: "margin-top:10px" },
            el("summary", {}, `${cites.length} sources read`),
            el("ul", { style: "font-size:12px;line-height:1.7" },
              cites.map((c) => el("li", { html: `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.domain)}</a> — ${esc(c.title)}` }))))
        : null));
  }
};

VIEWS.runs = async (root) => {
  const [runs, est] = await Promise.all([api("/api/runs"), api("/api/estimate")]);
  state.runs = runs;

  root.appendChild(el("div", { class: "grid cols-3" },
    tile("Prompts per sweep", String(est.prompts),
      est.dedupe
        ? `${est.distinctPrompts} distinct questions; identical DE/CH and NL/BE prompts share one call`
        : "deduplication off"),
    tile("Claude calls per sweep", String(est.apiCalls),
      `${est.models.map((m) => m.replace("claude-", "")).join(", ")} × ${est.modes.join(", ")}`),
    tile("Estimated cost per sweep", `$${num(est.estimateUsd, 2)}`,
      `Budget cap $${num(est.budgetUsd, 0)}. ${est.note}`),
  ));

  if (state.me?.admin) {
    const running = runs.find((r) => r.status === "running");
    root.appendChild(el("div", { class: "card", style: "margin-top:16px" },
      el("div", { class: "row-actions" },
        el("button", {
          class: "action", disabled: !!running,
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await api("/api/admin/run", { method: "POST", headers: { "X-Admin-Token": state.adminToken || "" } });
              alert(`Sweep ${r.runId} started with ${r.taskCount} tasks. It drains over roughly an hour.`);
              switchView("runs");
            } catch (err) { alert(err.message); e.target.disabled = false; }
          },
        }, running ? "A sweep is already running" : "Start a sweep now"),
        el("span", { class: "hint", style: "margin:0" },
          "Sweeps also start automatically every Monday at 06:00 UTC."))));
  }

  root.appendChild(el("div", { style: "margin-top:16px" },
    card("Sweep history", null,
      table(["Run", "Status", "Trigger", "Progress", { label: "Cost", num: true }, "Started", "Models"],
        runs.map((r) => {
          const frac = r.tasks ? r.tasksDone / r.tasks : 0;
          return el("tr", {},
            el("td", { class: "mono" }, r.label),
            el("td", { html: `<span class="pill ${r.status === "complete" ? "recommended" : r.status === "running" ? "grounded" : "qualified"}">${esc(r.status)}</span>` }),
            el("td", {}, r.trigger),
            el("td", { html: `<div class="progress"><div style="width:${(frac * 100).toFixed(0)}%"></div></div><span style="font-size:11px;color:#64748B">${r.tasksDone} / ${r.tasks}</span>` }),
            el("td", { class: "num" }, `$${num(r.costUsd, 2)}`),
            el("td", {}, new Date(r.startedAt).toLocaleString()),
            el("td", { class: "mono" }, JSON.parse(r.models).map((m) => m.replace("claude-", "")).join(", ")));
        })))));
};

/* ------------------------------------------------------------------ shell */
const FILTERED_VIEWS = new Set(["overview", "markets", "gaps", "sources", "prompts"]);

async function switchView(view, custom) {
  state.view = view;
  for (const b of document.querySelectorAll("nav.tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.view === view));
  }
  $("#filters").hidden = !FILTERED_VIEWS.has(view);
  const root = $("#view");
  root.replaceChildren(el("div", { class: "empty" }, "Loading…"));
  try {
    const fresh = el("div");
    if (custom) {
      root.replaceChildren(fresh);
      await custom(fresh);
      root.replaceChildren(...fresh.childNodes);
    } else {
      await VIEWS[view](fresh);
      root.replaceChildren(...fresh.childNodes);
    }
  } catch (err) {
    root.replaceChildren(el("div", { class: "note" }, err.message));
  }
}

function fillSelect(id, values, { allLabel = "All", selected = "" } = {}) {
  const sel = $(id);
  sel.replaceChildren(
    el("option", { value: "" }, allLabel),
    ...values.map((v) => el("option", { value: v, selected: v === selected ? "selected" : null }, String(v))),
  );
}

async function boot() {
  try {
    state.me = await api("/api/me");
    $("#who").textContent = state.me.email === "access-disabled" ? "" : state.me.email;
  } catch (err) {
    $("#view").replaceChildren(el("div", { class: "note" }, err.message));
    return;
  }
  if (state.me.admin === false) {
    // The dashboard is read-only unless an admin token is supplied by hand.
    const token = new URLSearchParams(location.search).get("token");
    if (token) { state.adminToken = token; state.me.admin = true; }
  }

  const [facets, runs] = await Promise.all([api("/api/facets"), api("/api/runs")]);
  state.facets = facets;
  state.runs = runs;

  const runSel = $("#f-run");
  runSel.replaceChildren(
    el("option", { value: "" }, "Latest completed"),
    ...runs.map((r) => el("option", { value: r.id }, `${r.label} (${r.status})`)),
  );
  fillSelect("#f-model", facets.models, { allLabel: "All models" });
  fillSelect("#f-mode", facets.modes, { allLabel: "Both" });
  fillSelect("#f-country", facets.countries, { allLabel: "All markets" });
  fillSelect("#f-topic", facets.topics, { allLabel: "All topics" });
  fillSelect("#f-intent", facets.intents, { allLabel: "All layers" });

  const sync = () => {
    state.filters = {
      run: $("#f-run").value, model: $("#f-model").value, mode: $("#f-mode").value,
      country: $("#f-country").value, topic: $("#f-topic").value, intent: $("#f-intent").value,
    };
    switchView(state.view);
  };
  for (const id of ["#f-run", "#f-model", "#f-mode", "#f-country", "#f-topic", "#f-intent"]) {
    $(id).addEventListener("change", sync);
  }
  $("#btn-export").addEventListener("click", () => { location.href = `/api/export.csv${qs()}`; });
  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (btn) switchView(btn.dataset.view);
  });

  state.filters = { run: "", model: "", mode: "", country: "", topic: "", intent: "" };
  switchView("overview");
}

boot();
