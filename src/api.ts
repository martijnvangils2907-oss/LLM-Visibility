import { Hono } from "hono";
import { verifyAccess, isAdmin } from "./access";
import {
  brandMetrics, breakdown, citationDomains, gaps, runSummary, stanceMix, trend,
  type Filters,
} from "./metrics";
import { startRun } from "./runner";
import { costUsd, type Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: { email: string } }>();

app.use("/api/*", async (c, next) => {
  const identity = await verifyAccess(c.req.raw, c.env);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  c.set("email", identity.email);
  await next();
});

const filtersFrom = (url: URL): Filters => ({
  runId: url.searchParams.get("run") ? Number(url.searchParams.get("run")) : undefined,
  model: url.searchParams.get("model") ?? undefined,
  mode: url.searchParams.get("mode") ?? undefined,
  country: url.searchParams.get("country") ?? undefined,
  topic: url.searchParams.get("topic") ?? undefined,
  intent: url.searchParams.get("intent") ?? undefined,
});

async function selfBrandId(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT id FROM brands WHERE is_self = 1 LIMIT 1").first<{ id: string }>();
  return row?.id ?? "icron";
}

app.get("/api/me", (c) => c.json({ email: c.get("email"), admin: isAdmin(c.req.raw, c.env) }));

app.get("/api/runs", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.label, r.status, r.trigger, r.started_at AS startedAt,
            r.finished_at AS finishedAt, r.models, r.modes, r.note,
            (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id) AS tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.status = 'done') AS tasksDone,
            (SELECT COALESCE(SUM(cost_usd),0) FROM results x WHERE x.run_id = r.id) AS costUsd
     FROM runs r ORDER BY r.started_at DESC LIMIT 60`,
  ).all();
  return c.json(results);
});

app.get("/api/facets", async (c) => {
  const [countries, topics, intents, models, modes, brands] = await Promise.all([
    c.env.DB.prepare("SELECT DISTINCT country AS v FROM prompts ORDER BY v").all(),
    c.env.DB.prepare("SELECT DISTINCT topic AS v FROM prompts ORDER BY v").all(),
    c.env.DB.prepare("SELECT DISTINCT intent AS v FROM prompts ORDER BY v").all(),
    c.env.DB.prepare("SELECT DISTINCT model AS v FROM results ORDER BY v").all(),
    c.env.DB.prepare("SELECT DISTINCT mode AS v FROM results ORDER BY v").all(),
    c.env.DB.prepare("SELECT id, label, color, is_self AS isSelf FROM brands WHERE active = 1 ORDER BY sort_order").all(),
  ]);
  return c.json({
    countries: countries.results.map((r) => (r as { v: string }).v),
    topics: topics.results.map((r) => (r as { v: string }).v),
    intents: intents.results.map((r) => (r as { v: string }).v),
    models: models.results.map((r) => (r as { v: string }).v),
    modes: modes.results.map((r) => (r as { v: string }).v),
    brands: brands.results,
  });
});

app.get("/api/overview", async (c) => {
  const url = new URL(c.req.url);
  const f = filtersFrom(url);
  if (!f.runId) {
    const latest = await c.env.DB.prepare(
      "SELECT id FROM runs WHERE status IN ('complete','aborted') ORDER BY started_at DESC LIMIT 1",
    ).first<{ id: number }>();
    f.runId = latest?.id;
  }
  const self = await selfBrandId(c.env.DB);
  const [brands, byCountry, byTopic, byIntent, stances, summary] = await Promise.all([
    brandMetrics(c.env.DB, f),
    breakdown(c.env.DB, "country", self, f),
    breakdown(c.env.DB, "topic", self, f),
    breakdown(c.env.DB, "intent", self, f),
    stanceMix(c.env.DB, f),
    f.runId ? runSummary(c.env.DB, f.runId) : Promise.resolve(null),
  ]);
  return c.json({ filters: f, selfBrandId: self, brands, byCountry, byTopic, byIntent, stances, summary });
});

app.get("/api/trend", async (c) => {
  const self = await selfBrandId(c.env.DB);
  return c.json(await trend(c.env.DB, self));
});

app.get("/api/citations", async (c) => {
  return c.json(await citationDomains(c.env.DB, filtersFrom(new URL(c.req.url))));
});

app.get("/api/gaps", async (c) => {
  const self = await selfBrandId(c.env.DB);
  return c.json(await gaps(c.env.DB, self, filtersFrom(new URL(c.req.url))));
});

/** Full drilldown for one prompt: every answer we have, newest run first. */
app.get("/api/prompts/:id", async (c) => {
  const id = c.req.param("id");
  const prompt = await c.env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(id).first();
  if (!prompt) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.run_id AS runId, run.label AS runLabel, r.model, r.mode, r.answer,
            r.self_mentioned AS selfMentioned, r.self_rank AS selfRank,
            r.self_stance AS selfStance, r.self_evidence AS selfEvidence,
            r.citations, r.shared_from AS sharedFrom,
            (SELECT GROUP_CONCAT(b.label || ':' || m.rank, '|')
               FROM mentions m JOIN brands b ON b.id = m.brand_id
              WHERE m.result_id = r.id) AS brandRanks
     FROM results r JOIN runs run ON run.id = r.run_id
     WHERE r.prompt_id = ? ORDER BY run.started_at DESC, r.model, r.mode LIMIT 40`,
  ).bind(id).all();
  return c.json({ prompt, results });
});

app.get("/api/prompts", async (c) => {
  const url = new URL(c.req.url);
  const f = filtersFrom(url);
  const clauses: string[] = ["1=1"];
  const binds: unknown[] = [];
  for (const [col, val] of [["country", f.country], ["topic", f.topic], ["intent", f.intent]] as const) {
    if (val && val !== "all") { clauses.push(`p.${col} = ?`); binds.push(val); }
  }
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.topic, p.country, p.language, p.intent, p.prompt_en AS promptEn,
            p.prompt_native AS promptNative
     FROM prompts p WHERE ${clauses.join(" AND ")} ORDER BY p.country, p.topic, p.id`,
  ).bind(...binds).all();
  return c.json(results);
});

/** Cost of one full sweep at the configured models and modes, before running it. */
app.get("/api/estimate", async (c) => {
  const models = c.env.SWEEP_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  const modes = c.env.SWEEP_MODES.split(",").map((s) => s.trim()).filter(Boolean);
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE active = 1").first<{ n: number }>();
  const distinct = await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT prompt_native) AS n FROM prompts WHERE active = 1",
  ).first<{ n: number }>();
  const dedupe = c.env.DEDUPE_IDENTICAL_PROMPTS !== "false";
  const calls = (dedupe ? distinct?.n ?? 0 : total?.n ?? 0) * models.length * modes.length;

  // Observed shape of a grounded answer: a few searches pulled into context,
  // then a page or so of prose.
  const perCall = { grounded: { input: 12000, output: 900 }, ungrounded: { input: 60, output: 700 } };
  let estimate = 0;
  for (const model of models) {
    for (const mode of modes) {
      const shape = mode === "grounded" ? perCall.grounded : perCall.ungrounded;
      const n = (dedupe ? distinct?.n ?? 0 : total?.n ?? 0);
      estimate += n * costUsd(model, shape.input, shape.output);
    }
  }
  const batchSize = Math.max(1, parseInt(c.env.DRAIN_BATCH_SIZE, 10) || 12);
  return c.json({
    prompts: total?.n ?? 0,
    distinctPrompts: distinct?.n ?? 0,
    drainBatchSize: batchSize,
    // One task is drained per slot per minute, so wall-clock is set by the task
    // count and the batch size, not by how many API calls dedupe saves.
    sweepMinutes: Math.ceil(((total?.n ?? 0) * models.length * modes.length) / batchSize),
    dedupe,
    models,
    modes,
    apiCalls: calls,
    estimateUsd: Math.round(estimate * 100) / 100,
    budgetUsd: parseFloat(c.env.MAX_RUN_COST_USD),
    note: "Rough. Grounded answers dominate cost because search results enter the input context.",
  });
});

app.post("/api/admin/run", async (c) => {
  if (!isAdmin(c.req.raw, c.env)) return c.json({ error: "admin token required" }, 403);
  const open = await c.env.DB.prepare("SELECT id FROM runs WHERE status = 'running' LIMIT 1").first();
  if (open) return c.json({ error: "a run is already in progress" }, 409);
  const { runId, taskCount } = await startRun(c.env, "manual", `started by ${c.get("email")}`);
  const batchSize = Math.max(1, parseInt(c.env.DRAIN_BATCH_SIZE, 10) || 12);
  return c.json({ runId, taskCount, etaMinutes: Math.ceil(taskCount / batchSize) });
});

app.post("/api/admin/abort", async (c) => {
  if (!isAdmin(c.req.raw, c.env)) return c.json({ error: "admin token required" }, 403);
  const runId = Number(new URL(c.req.url).searchParams.get("run"));
  if (!runId) return c.json({ error: "run required" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE tasks SET status = 'skipped', error = 'aborted' WHERE run_id = ? AND status IN ('pending','running')",
    ).bind(runId),
    c.env.DB.prepare(
      "UPDATE runs SET status = 'aborted', finished_at = ? WHERE id = ?",
    ).bind(new Date().toISOString(), runId),
  ]);
  return c.json({ ok: true });
});

/** CSV export of the current slice, for anyone who wants it in Excel. */
app.get("/api/export.csv", async (c) => {
  const f = filtersFrom(new URL(c.req.url));
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "" && v !== "all") { clauses.push(sql); binds.push(v); }
  };
  add("r.run_id = ?", f.runId); add("r.model = ?", f.model); add("r.mode = ?", f.mode);
  add("p.country = ?", f.country); add("p.topic = ?", f.topic); add("p.intent = ?", f.intent);
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";

  const { results } = await c.env.DB.prepare(
    `SELECT run.label AS run, p.id AS prompt_id, p.country, p.language, p.topic, p.intent,
            p.prompt_en, r.model, r.mode, r.self_mentioned, r.self_rank, r.self_stance,
            (SELECT GROUP_CONCAT(b.label || ':' || m.rank, ' | ')
               FROM mentions m JOIN brands b ON b.id = m.brand_id WHERE m.result_id = r.id) AS brands_ranked
     FROM results r JOIN prompts p ON p.id = r.prompt_id JOIN runs run ON run.id = r.run_id
     ${where} ORDER BY p.country, p.topic, p.id`,
  ).bind(...binds).all<Record<string, unknown>>();

  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = results.length ? Object.keys(results[0]) : [];
  const csv = [header.join(","), ...results.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="icron-visibility-${f.runId ?? "all"}.csv"`,
    },
  });
});

export default app;
