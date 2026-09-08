export interface Filters {
  runId?: number;
  model?: string;
  mode?: string;
  country?: string;
  topic?: string;
  intent?: string;
}

interface Where {
  sql: string;
  binds: unknown[];
}

/** Build the shared WHERE clause over `results r JOIN prompts p`. */
function where(f: Filters): Where {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "" && v !== "all") {
      clauses.push(sql);
      binds.push(v);
    }
  };
  add("r.run_id = ?", f.runId);
  add("r.model = ?", f.model);
  add("r.mode = ?", f.mode);
  add("p.country = ?", f.country);
  add("p.topic = ?", f.topic);
  add("p.intent = ?", f.intent);
  return { sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "", binds };
}

export interface BrandMetric {
  brandId: string;
  label: string;
  color: string;
  isSelf: boolean;
  answers: number;
  mentions: number;
  mentionRate: number;
  avgRank: number | null;
  firstPlaceRate: number;
  /** Mean reciprocal rank over every answer in scope, x100. The headline number. */
  visibility: number;
  shareOfVoice: number;
}

/**
 * Core scoreboard.
 *
 * `visibility` is mean reciprocal rank: an answer that names the brand first
 * scores 1.0, second 0.5, third 0.33, absent 0. It rewards being named, and
 * being named early, in one comparable number.
 */
export async function brandMetrics(db: D1Database, f: Filters): Promise<BrandMetric[]> {
  const w = where(f);

  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM results r JOIN prompts p ON p.id = r.prompt_id ${w.sql}`)
    .bind(...w.binds)
    .first<{ n: number }>();
  const answers = total?.n ?? 0;

  const rows = await db
    .prepare(
      `SELECT b.id AS brandId, b.label, b.color, b.is_self AS isSelf,
              COALESCE(agg.mentions, 0) AS mentions,
              agg.avgRank AS avgRank,
              COALESCE(agg.firsts, 0) AS firsts,
              COALESCE(agg.rrSum, 0) AS rrSum
       FROM brands b
       LEFT JOIN (
         SELECT m.brand_id,
                COUNT(*) AS mentions,
                AVG(m.rank) AS avgRank,
                SUM(CASE WHEN m.rank = 1 THEN 1 ELSE 0 END) AS firsts,
                SUM(1.0 / m.rank) AS rrSum
         FROM mentions m
         JOIN results r ON r.id = m.result_id
         JOIN prompts p ON p.id = r.prompt_id
         ${w.sql}
         GROUP BY m.brand_id
       ) agg ON agg.brand_id = b.id
       WHERE b.active = 1
       ORDER BY b.sort_order`,
    )
    .bind(...w.binds)
    .all<{
      brandId: string; label: string; color: string; isSelf: number;
      mentions: number; avgRank: number | null; firsts: number; rrSum: number;
    }>();

  const totalMentions = rows.results.reduce((s, r) => s + r.mentions, 0);

  return rows.results.map((r) => ({
    brandId: r.brandId,
    label: r.label,
    color: r.color,
    isSelf: r.isSelf === 1,
    answers,
    mentions: r.mentions,
    mentionRate: answers ? r.mentions / answers : 0,
    avgRank: r.avgRank,
    firstPlaceRate: answers ? r.firsts / answers : 0,
    visibility: answers ? (r.rrSum / answers) * 100 : 0,
    shareOfVoice: totalMentions ? r.mentions / totalMentions : 0,
  }));
}

export interface Breakdown {
  key: string;
  answers: number;
  mentions: number;
  mentionRate: number;
  visibility: number;
}

/** ICRON's score sliced by country, topic or intent. */
export async function breakdown(
  db: D1Database,
  dimension: "country" | "topic" | "intent",
  brandId: string,
  f: Filters,
): Promise<Breakdown[]> {
  const w = where(f);
  const { results } = await db
    .prepare(
      `SELECT p.${dimension} AS key,
              COUNT(*) AS answers,
              SUM(CASE WHEN m.result_id IS NOT NULL THEN 1 ELSE 0 END) AS mentions,
              COALESCE(SUM(CASE WHEN m.rank IS NOT NULL THEN 1.0 / m.rank ELSE 0 END), 0) AS rrSum
       FROM results r
       JOIN prompts p ON p.id = r.prompt_id
       LEFT JOIN mentions m ON m.result_id = r.id AND m.brand_id = ?
       ${w.sql}
       GROUP BY p.${dimension} ORDER BY p.${dimension}`,
    )
    .bind(brandId, ...w.binds)
    .all<{ key: string; answers: number; mentions: number; rrSum: number }>();

  return results.map((r) => ({
    key: r.key,
    answers: r.answers,
    mentions: r.mentions,
    mentionRate: r.answers ? r.mentions / r.answers : 0,
    visibility: r.answers ? (r.rrSum / r.answers) * 100 : 0,
  }));
}

/** How answers position ICRON when they do name it. */
export async function stanceMix(db: D1Database, f: Filters) {
  const w = where(f);
  const { results } = await db
    .prepare(
      `SELECT COALESCE(r.self_stance, 'unclassified') AS stance, COUNT(*) AS n
       FROM results r JOIN prompts p ON p.id = r.prompt_id
       ${w.sql ? w.sql + " AND" : "WHERE"} r.self_mentioned = 1
       GROUP BY stance ORDER BY n DESC`,
    )
    .bind(...w.binds)
    .all<{ stance: string; n: number }>();
  return results;
}

/** Trend of ICRON's visibility across runs, split by model and grounding mode. */
export async function trend(db: D1Database, brandId: string) {
  const { results } = await db
    .prepare(
      `SELECT run.id AS runId, run.label, run.started_at AS startedAt, r.model, r.mode,
              COUNT(*) AS answers,
              SUM(CASE WHEN m.result_id IS NOT NULL THEN 1 ELSE 0 END) AS mentions,
              COALESCE(SUM(CASE WHEN m.rank IS NOT NULL THEN 1.0 / m.rank ELSE 0 END), 0) AS rrSum
       FROM results r
       JOIN runs run ON run.id = r.run_id
       LEFT JOIN mentions m ON m.result_id = r.id AND m.brand_id = ?
       GROUP BY run.id, r.model, r.mode
       ORDER BY run.started_at, r.model, r.mode`,
    )
    .bind(brandId)
    .all<{
      runId: number; label: string; startedAt: string; model: string; mode: string;
      answers: number; mentions: number; rrSum: number;
    }>();

  return results.map((r) => ({
    runId: r.runId,
    label: r.label,
    startedAt: r.startedAt,
    model: r.model,
    mode: r.mode,
    answers: r.answers,
    mentionRate: r.answers ? r.mentions / r.answers : 0,
    visibility: r.answers ? (r.rrSum / r.answers) * 100 : 0,
  }));
}

/**
 * Which sources Claude actually read. Domains that show up in answers naming
 * ICRON are the pages carrying our visibility; domains that show up only in
 * answers naming competitors are the pages to go win.
 */
export async function citationDomains(db: D1Database, f: Filters, limit = 40) {
  const w = where(f);
  const { results } = await db
    .prepare(
      `SELECT r.citations, r.self_mentioned FROM results r JOIN prompts p ON p.id = r.prompt_id
       ${w.sql ? w.sql + " AND" : "WHERE"} r.citations != '[]' AND r.shared_from IS NULL`,
    )
    .bind(...w.binds)
    .all<{ citations: string; self_mentioned: number }>();

  const tally = new Map<string, { domain: string; total: number; withSelf: number }>();
  for (const row of results) {
    let parsed: { domain: string }[] = [];
    try {
      parsed = JSON.parse(row.citations);
    } catch {
      continue;
    }
    for (const domain of new Set(parsed.map((c) => c.domain).filter(Boolean))) {
      const e = tally.get(domain) ?? { domain, total: 0, withSelf: 0 };
      e.total++;
      if (row.self_mentioned) e.withSelf++;
      tally.set(domain, e);
    }
  }
  return [...tally.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

/**
 * The action list: prompts where competitors were named and ICRON was not.
 * These are the specific questions where a buyer meets our market and we are
 * absent from the answer.
 */
export async function gaps(db: D1Database, selfBrandId: string, f: Filters, limit = 200) {
  const w = where(f);
  const { results } = await db
    .prepare(
      `SELECT r.id, p.id AS promptId, p.prompt_en AS promptEn, p.prompt_native AS promptNative,
              p.country, p.topic, p.intent, r.model, r.mode,
              (SELECT GROUP_CONCAT(b.label, ', ')
                 FROM mentions m2 JOIN brands b ON b.id = m2.brand_id
                WHERE m2.result_id = r.id) AS competitors
       FROM results r
       JOIN prompts p ON p.id = r.prompt_id
       ${w.sql ? w.sql + " AND" : "WHERE"} r.self_mentioned = 0
         AND EXISTS (SELECT 1 FROM mentions m WHERE m.result_id = r.id AND m.brand_id != ?)
       ORDER BY p.country, p.topic
       LIMIT ?`,
    )
    .bind(...w.binds, selfBrandId, limit)
    .all();
  return results;
}

export async function runSummary(db: D1Database, runId: number) {
  const run = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first();
  const progress = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM tasks WHERE run_id = ? GROUP BY status`,
    )
    .bind(runId)
    .all<{ status: string; n: number }>();
  const spend = await db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd),0) AS costUsd,
              COALESCE(SUM(input_tokens),0) AS inputTokens,
              COALESCE(SUM(output_tokens),0) AS outputTokens,
              SUM(CASE WHEN shared_from IS NOT NULL THEN 1 ELSE 0 END) AS sharedAnswers
       FROM results WHERE run_id = ?`,
    )
    .bind(runId)
    .first();
  return { run, progress: progress.results, spend };
}


/**
 * Measured spend for a run, split by model and grounding mode.
 *
 * The Runs tab's per-sweep estimate is modelled from assumed token shapes; this
 * is what was actually billed, and it is the only sound basis for deciding
 * which model or mode is worth its cost.
 */
export async function spendBreakdown(db: D1Database, runId: number) {
  const { results } = await db
    .prepare(
      `SELECT model, mode,
              COUNT(*) AS answers,
              SUM(CASE WHEN shared_from IS NULL THEN 1 ELSE 0 END) AS billedCalls,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM results WHERE run_id = ?
       GROUP BY model, mode ORDER BY costUsd DESC`,
    )
    .bind(runId)
    .all<{
      model: string; mode: string; answers: number; billedCalls: number;
      inputTokens: number; outputTokens: number; costUsd: number;
    }>();

  const total = results.reduce((s, r) => s + r.costUsd, 0);
  return results.map((r) => ({
    ...r,
    share: total ? r.costUsd / total : 0,
    // Per billed call, so a row is comparable regardless of dedup savings.
    avgInputTokens: r.billedCalls ? Math.round(r.inputTokens / r.billedCalls) : 0,
    avgOutputTokens: r.billedCalls ? Math.round(r.outputTokens / r.billedCalls) : 0,
    costPerCall: r.billedCalls ? r.costUsd / r.billedCalls : 0,
  }));
}
