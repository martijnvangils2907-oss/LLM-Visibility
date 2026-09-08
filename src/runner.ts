import Anthropic from "@anthropic-ai/sdk";
import { ask, judgeStance, JUDGE_MODEL } from "./claude.ts";
import { detectBrands, loadBrands } from "./brands.ts";
import { costUsd, type Env, type Mode } from "./types.ts";

const STALE_CLAIM_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const nowIso = () => new Date().toISOString();
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export interface TaskRow {
  id: number;
  run_id: number;
  prompt_id: string;
  model: string;
  mode: Mode;
  attempts: number;
  prompt_native: string;
}

/**
 * Open a run and enqueue one task per prompt x model x mode.
 *
 * Tasks are ordered by prompt text so that byte-identical prompts from
 * different countries land in the same drain batch and share one API call.
 */
export const sweepEngine = (env: Env) => (env.SWEEP_ENGINE === "sync" ? "sync" : "batch");

export async function startRun(
  env: Env,
  trigger: "cron" | "manual",
  note?: string,
): Promise<{ runId: number; taskCount: number }> {
  const models = list(env.SWEEP_MODELS);
  const modes = list(env.SWEEP_MODES) as Mode[];
  if (!models.length || !modes.length) throw new Error("SWEEP_MODELS and SWEEP_MODES must be set");

  const label = new Date().toISOString().slice(0, 10);
  const run = await env.DB.prepare(
    `INSERT INTO runs (label, trigger, status, models, modes, started_at, note, engine)
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(label, trigger, JSON.stringify(models), JSON.stringify(modes), nowIso(), note ?? null,
          sweepEngine(env))
    .first<{ id: number }>();
  if (!run) throw new Error("could not create run");

  const { results: prompts } = await env.DB.prepare(
    "SELECT id FROM prompts WHERE active = 1 ORDER BY prompt_native, country",
  ).all<{ id: string }>();

  const stmt = env.DB.prepare(
    "INSERT INTO tasks (run_id, prompt_id, model, mode) VALUES (?, ?, ?, ?)",
  );
  const binds = [];
  for (const p of prompts) {
    for (const model of models) {
      for (const mode of modes) binds.push(stmt.bind(run.id, p.id, model, mode));
    }
  }
  // D1 caps how much one batch can carry; 200 statements a chunk is comfortable.
  for (let i = 0; i < binds.length; i += 200) await env.DB.batch(binds.slice(i, i + 200));

  return { runId: run.id, taskCount: binds.length };
}

/** Return abandoned in-flight tasks to the queue, and give up on serial failures. */
async function reclaimStale(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks SET status = 'error', error = 'exceeded max attempts'
       WHERE status = 'running' AND claimed_at < ? AND attempts >= ?
         AND run_id IN (SELECT id FROM runs WHERE engine = 'sync')`,
    ).bind(cutoff, MAX_ATTEMPTS),
    env.DB.prepare(
      `UPDATE tasks SET status = 'pending', claimed_at = NULL
       WHERE status = 'running' AND claimed_at < ? AND attempts < ?
         AND run_id IN (SELECT id FROM runs WHERE engine = 'sync')`,
    ).bind(cutoff, MAX_ATTEMPTS),
  ]);
}

async function runSpendUsd(env: Env, runId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM results WHERE run_id = ?",
  )
    .bind(runId)
    .first<{ spent: number }>();
  return row?.spent ?? 0;
}

/** Close out any run whose tasks are all resolved. */
async function finalizeRuns(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs SET status = 'complete', finished_at = ?
     WHERE status = 'running' AND engine = 'sync'
       AND NOT EXISTS (
         SELECT 1 FROM tasks WHERE tasks.run_id = runs.id AND tasks.status IN ('pending','running')
       )`,
  )
    .bind(nowIso())
    .run();
}

/**
 * Claim a small batch of pending tasks and answer them.
 *
 * Batch size is kept well under the Workers subrequest ceiling; a full 300-prompt
 * sweep therefore spreads over roughly an hour of one-minute ticks, which the
 * dashboard shows as live progress.
 */
export async function drain(env: Env): Promise<{ claimed: number; done: number; errors: number }> {
  await reclaimStale(env);

  const batchSize = Math.max(1, parseInt(env.DRAIN_BATCH_SIZE, 10) || 12);
  const { results: claimed } = await env.DB.prepare(
    `UPDATE tasks SET status = 'running', claimed_at = ?, attempts = attempts + 1
     WHERE id IN (
       SELECT t.id FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.status = 'pending' AND r.engine = 'sync' ORDER BY t.id LIMIT ?
     )
     RETURNING id, run_id, prompt_id, model, mode, attempts`,
  )
    .bind(nowIso(), batchSize)
    .all<Omit<TaskRow, "prompt_native">>();

  if (!claimed.length) {
    await finalizeRuns(env);
    return { claimed: 0, done: 0, errors: 0 };
  }

  // Abort the sweep rather than run past the budget the operator set.
  const runId = claimed[0].run_id;
  const budget = parseFloat(env.MAX_RUN_COST_USD) || Infinity;
  if ((await runSpendUsd(env, runId)) >= budget) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE tasks SET status = 'skipped', error = 'run budget reached'
         WHERE run_id = ? AND status IN ('pending','running')`,
      ).bind(runId),
      env.DB.prepare(
        "UPDATE runs SET status = 'aborted', finished_at = ?, note = 'stopped at MAX_RUN_COST_USD' WHERE id = ?",
      ).bind(nowIso(), runId),
    ]);
    return { claimed: claimed.length, done: 0, errors: 0 };
  }

  const placeholders = claimed.map(() => "?").join(",");
  const { results: promptRows } = await env.DB.prepare(
    `SELECT id, prompt_native FROM prompts WHERE id IN (${placeholders})`,
  )
    .bind(...claimed.map((t) => t.prompt_id))
    .all<{ id: string; prompt_native: string }>();
  const nativeById = new Map(promptRows.map((p) => [p.id, p.prompt_native]));

  const tasks: TaskRow[] = claimed.map((t) => ({
    ...t,
    prompt_native: nativeById.get(t.prompt_id) ?? "",
  }));

  const brands = await loadBrands(env.DB);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const dedupe = env.DEDUPE_IDENTICAL_PROMPTS !== "false";

  // Group identical questions so DE/CH and NL/BE twins cost one call, not two.
  const groups = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const key = dedupe ? `${t.run_id}|${t.model}|${t.mode}|${t.prompt_native}` : `t${t.id}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }

  let done = 0;
  let errors = 0;

  const outcomes = await Promise.allSettled(
    [...groups.values()].map((group) => handleGroup(env, client, brands, group, dedupe)),
  );
  for (const [i, o] of outcomes.entries()) {
    const size = [...groups.values()][i].length;
    if (o.status === "fulfilled") done += size;
    else errors += size;
  }

  await finalizeRuns(env);
  return { claimed: tasks.length, done, errors };
}

async function handleGroup(
  env: Env,
  client: Anthropic,
  brands: Awaited<ReturnType<typeof loadBrands>>,
  group: TaskRow[],
  dedupe: boolean,
): Promise<void> {
  const lead = group[0];
  try {
    // A previous batch may already have answered this exact question.
    let reuse: { id: number } | null = null;
    if (dedupe) {
      reuse = await env.DB.prepare(
        `SELECT r.id FROM results r JOIN prompts p ON p.id = r.prompt_id
         WHERE r.run_id = ? AND r.model = ? AND r.mode = ? AND p.prompt_native = ? LIMIT 1`,
      )
        .bind(lead.run_id, lead.model, lead.mode, lead.prompt_native)
        .first<{ id: number }>();
    }

    if (reuse) {
      const source = await env.DB.prepare("SELECT * FROM results WHERE id = ?")
        .bind(reuse.id)
        .first<Record<string, unknown>>();
      if (source) {
        for (const t of group) await copyResult(env, t, source, reuse.id);
        return;
      }
    }

    const res = await ask(client, lead.model, lead.mode, lead.prompt_native, {
      maxSearches: parseInt(env.MAX_SEARCHES_PER_ANSWER ?? "", 10) || undefined,
    });
    if (!res.answer) throw new Error(`empty answer (stop_reason=${res.stopReason})`);

    const hits = detectBrands(res.answer, brands);
    const selfBrand = brands.find((b) => b.isSelf);
    const selfHit = selfBrand ? hits.find((h) => h.brandId === selfBrand.id) : undefined;

    let cost = costUsd(lead.model, res.inputTokens, res.outputTokens);
    let stance: Awaited<ReturnType<typeof judgeStance>> = null;
    if (selfHit) {
      stance = await judgeStance(client, res.answer);
      if (stance) cost += costUsd(JUDGE_MODEL, stance.inputTokens, stance.outputTokens);
    }

    let leadResultId: number | null = null;
    for (const t of group) {
      const row: { id: number } | null = await env.DB.prepare(
        `INSERT INTO results
           (run_id, prompt_id, model, mode, answer, self_mentioned, self_rank, self_stance,
            self_evidence, citations, search_count, input_tokens, output_tokens, cost_usd,
            shared_from, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, prompt_id, model, mode) DO NOTHING
         RETURNING id`,
      )
        .bind(
          t.run_id, t.prompt_id, t.model, t.mode, res.answer,
          selfHit ? 1 : 0, selfHit?.rank ?? null, stance?.stance ?? null, stance?.evidence ?? null,
          JSON.stringify(res.citations), res.searchCount,
          // Only the first row of a group carries the tokens and cost, so
          // spend is never double counted.
          leadResultId === null ? res.inputTokens : 0,
          leadResultId === null ? res.outputTokens : 0,
          leadResultId === null ? cost : 0,
          leadResultId,
          nowIso(),
        )
        .first<{ id: number }>();

      if (!row) continue;
      if (leadResultId === null) leadResultId = row.id;

      if (hits.length) {
        await env.DB.batch(
          hits.map((h) =>
            env.DB.prepare(
              "INSERT OR REPLACE INTO mentions (result_id, run_id, brand_id, rank, hits) VALUES (?,?,?,?,?)",
            ).bind(row.id, t.run_id, h.brandId, h.rank, h.hits),
          ),
        );
      }
      await env.DB.prepare("UPDATE tasks SET status = 'done', error = NULL WHERE id = ?")
        .bind(t.id)
        .run();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await env.DB.batch(
      group.map((t) =>
        env.DB.prepare(
          `UPDATE tasks SET status = CASE WHEN attempts >= ? THEN 'error' ELSE 'pending' END,
                            claimed_at = NULL, error = ?
           WHERE id = ?`,
        ).bind(MAX_ATTEMPTS, message.slice(0, 500), t.id),
      ),
    );
    throw err;
  }
}

/** Attribute an already-answered identical prompt to another country's row. */
async function copyResult(
  env: Env,
  task: TaskRow,
  source: Record<string, unknown>,
  sourceId: number,
): Promise<void> {
  const row = await env.DB.prepare(
    `INSERT INTO results
       (run_id, prompt_id, model, mode, answer, self_mentioned, self_rank, self_stance,
        self_evidence, citations, search_count, input_tokens, output_tokens, cost_usd,
        shared_from, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,?)
     ON CONFLICT(run_id, prompt_id, model, mode) DO NOTHING
     RETURNING id`,
  )
    .bind(
      task.run_id, task.prompt_id, task.model, task.mode, source.answer,
      source.self_mentioned, source.self_rank, source.self_stance, source.self_evidence,
      source.citations, source.search_count, sourceId, nowIso(),
    )
    .first<{ id: number }>();

  if (row) {
    const { results: srcMentions } = await env.DB.prepare(
      "SELECT brand_id, rank, hits FROM mentions WHERE result_id = ?",
    )
      .bind(sourceId)
      .all<{ brand_id: string; rank: number; hits: number }>();
    if (srcMentions.length) {
      await env.DB.batch(
        srcMentions.map((m) =>
          env.DB.prepare(
            "INSERT OR REPLACE INTO mentions (result_id, run_id, brand_id, rank, hits) VALUES (?,?,?,?,?)",
          ).bind(row.id, task.run_id, m.brand_id, m.rank, m.hits),
        ),
      );
    }
  }
  await env.DB.prepare("UPDATE tasks SET status = 'done', error = NULL WHERE id = ?")
    .bind(task.id)
    .run();
}
