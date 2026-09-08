import Anthropic from "@anthropic-ai/sdk";
import {
  BATCH_DISCOUNT, batchProgress, buildAnswerRequests, buildJudgeRequests,
  parseAnswerMessage, parseCustomId, parseStanceMessage, submitBatch,
  type AnswerJob,
} from "./batch.ts";
import { detectBrands, loadBrands } from "./brands.ts";
import { JUDGE_MODEL } from "./claude.ts";
import { fatalReason } from "./fatal.ts";
import { abortRun } from "./runner.ts";
import { costUsd, type Env, type Mode } from "./types.ts";

const nowIso = () => new Date().toISOString();

/**
 * Batch sweep lifecycle, advanced one step per cron tick:
 *
 *   running -> (submit)  processing
 *           -> (ended)   ingest answers -> judging
 *           -> (ended)   ingest stances -> complete
 *
 * Ingestion is idempotent: results carry a unique index on
 * (run_id, prompt_id, model, mode) and every insert is ON CONFLICT DO NOTHING,
 * so a tick that dies part-way is simply repeated by the next one.
 */
export async function advanceBatchRun(env: Env): Promise<string> {
  const run = await env.DB.prepare(
    `SELECT id, status, batch_id, judge_batch_id FROM runs
     WHERE engine = 'batch' AND status IN ('running','processing','judging')
     ORDER BY started_at LIMIT 1`,
  ).first<{ id: number; status: string; batch_id: string | null; judge_batch_id: string | null }>();

  if (!run) return "no batch run in flight";

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });

  try {
    if (!run.batch_id) return await submitAnswers(env, client, run.id);
    if (run.status === "processing") return await ingestAnswers(env, client, run.id, run.batch_id);
    if (run.status === "judging" && run.judge_batch_id) {
      return await ingestStances(env, client, run.id, run.judge_batch_id);
    }
    return `run ${run.id} in an unexpected state (${run.status})`;
  } catch (err) {
    const reason = fatalReason(err);
    if (!reason) throw err;
    await abortRun(env, run.id, reason);
    return `run ${run.id} aborted: ${reason}`;
  }
}

/** One request per distinct question, so identical DE/CH and NL/BE prompts share it. */
async function submitAnswers(env: Env, client: Anthropic, runId: number): Promise<string> {
  const dedupe = env.DEDUPE_IDENTICAL_PROMPTS !== "false";
  const { results: tasks } = await env.DB.prepare(
    `SELECT t.id, t.model, t.mode, p.prompt_native
     FROM tasks t JOIN prompts p ON p.id = t.prompt_id
     WHERE t.run_id = ? AND t.status = 'pending'
     ORDER BY p.prompt_native, t.id`,
  )
    .bind(runId)
    .all<{ id: number; model: string; mode: Mode; prompt_native: string }>();

  if (!tasks.length) {
    await env.DB.prepare("UPDATE runs SET status = 'complete', finished_at = ? WHERE id = ?")
      .bind(nowIso(), runId).run();
    return `run ${runId} had no pending tasks`;
  }

  const seen = new Set<string>();
  const jobs: AnswerJob[] = [];
  for (const t of tasks) {
    const key = `${t.model}|${t.mode}|${t.prompt_native}`;
    if (dedupe && seen.has(key)) continue;
    seen.add(key);
    jobs.push({ taskId: t.id, model: t.model, mode: t.mode, prompt: t.prompt_native });
  }

  const batchId = await submitBatch(
    client,
    buildAnswerRequests(jobs, {
      maxSearches: parseInt(env.MAX_SEARCHES_PER_ANSWER ?? "", 10) || undefined,
    }),
  );

  await env.DB.batch([
    env.DB.prepare("UPDATE runs SET batch_id = ?, status = 'processing' WHERE id = ?")
      .bind(batchId, runId),
    env.DB.prepare("UPDATE tasks SET status = 'running', claimed_at = ? WHERE run_id = ? AND status = 'pending'")
      .bind(nowIso(), runId),
  ]);
  return `run ${runId}: submitted ${jobs.length} requests as batch ${batchId}`;
}

async function ingestAnswers(
  env: Env, client: Anthropic, runId: number, batchId: string,
): Promise<string> {
  const progress = await batchProgress(client, batchId);
  await env.DB.prepare("UPDATE runs SET batch_progress = ? WHERE id = ?")
    .bind(JSON.stringify(progress), runId).run();

  if (progress.expired > 0 && progress.ended === false) {
    await abortRun(env, runId, "batch expired before completing");
    return `run ${runId}: batch expired`;
  }
  if (!progress.ended) {
    return `run ${runId}: batch ${batchId} ${progress.succeeded} done, ${progress.processing} in flight`;
  }

  const brands = await loadBrands(env.DB);
  const selfBrand = brands.find((b) => b.isSelf);

  let ingested = 0;
  let failed = 0;

  for await (const entry of await client.messages.batches.results(batchId)) {
    const parsedId = parseCustomId(entry.custom_id);
    if (!parsedId || parsedId.kind !== "answer") continue;

    if (entry.result.type !== "succeeded") {
      await env.DB.prepare(
        "UPDATE tasks SET status = 'error', error = ? WHERE id = ?",
      ).bind(`batch result: ${entry.result.type}`, parsedId.id).run();
      failed++;
      continue;
    }

    const lead = await env.DB.prepare(
      `SELECT t.id, t.model, t.mode, p.prompt_native
       FROM tasks t JOIN prompts p ON p.id = t.prompt_id WHERE t.id = ?`,
    ).bind(parsedId.id).first<{ id: number; model: string; mode: Mode; prompt_native: string }>();
    if (!lead) continue;

    const parsed = parseAnswerMessage(entry.result.message as unknown as Anthropic.Message);
    // Ledger first: the batch has already been billed by the time we read it.
    await env.DB.prepare(
      `INSERT INTO api_calls
         (run_id, task_id, kind, model, input_tokens, output_tokens, cost_usd, persisted, created_at)
       VALUES (?,?,'answer',?,?,?,?,0,?)`,
    ).bind(
      runId, lead.id, lead.model, parsed.inputTokens, parsed.outputTokens,
      costUsd(lead.model, parsed.inputTokens, parsed.outputTokens) * BATCH_DISCOUNT, nowIso(),
    ).run();
    if (!parsed.answer) {
      await env.DB.prepare("UPDATE tasks SET status = 'error', error = 'empty answer' WHERE id = ?")
        .bind(lead.id).run();
      failed++;
      continue;
    }

    const hits = detectBrands(parsed.answer, brands);
    const selfHit = selfBrand ? hits.find((h) => h.brandId === selfBrand.id) : undefined;
    const cost = costUsd(lead.model, parsed.inputTokens, parsed.outputTokens) * BATCH_DISCOUNT;

    // Attribute the answer to every task sharing this exact question.
    const { results: group } = await env.DB.prepare(
      `SELECT t.id, t.prompt_id FROM tasks t JOIN prompts p ON p.id = t.prompt_id
       WHERE t.run_id = ? AND t.model = ? AND t.mode = ? AND p.prompt_native = ?
         AND t.status != 'done'`,
    ).bind(runId, lead.model, lead.mode, lead.prompt_native)
     .all<{ id: number; prompt_id: string }>();

    let leadResultId: number | null = null;
    for (const member of group) {
      const row: { id: number } | null = await env.DB.prepare(
        `INSERT INTO results
           (run_id, prompt_id, model, mode, answer, self_mentioned, self_rank, citations,
            search_count, input_tokens, output_tokens, cost_usd, shared_from, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, prompt_id, model, mode) DO NOTHING
         RETURNING id`,
      ).bind(
        runId, member.prompt_id, lead.model, lead.mode, parsed.answer,
        selfHit ? 1 : 0, selfHit?.rank ?? null, JSON.stringify(parsed.citations), parsed.searchCount,
        leadResultId === null ? parsed.inputTokens : 0,
        leadResultId === null ? parsed.outputTokens : 0,
        leadResultId === null ? cost : 0,
        leadResultId, nowIso(),
      ).first<{ id: number }>();

      if (row) {
        if (leadResultId === null) leadResultId = row.id;
        if (hits.length) {
          await env.DB.batch(hits.map((h) =>
            env.DB.prepare(
              "INSERT OR REPLACE INTO mentions (result_id, run_id, brand_id, rank, hits) VALUES (?,?,?,?,?)",
            ).bind(row.id, runId, h.brandId, h.rank, h.hits)));
        }
      }
      await env.DB.prepare("UPDATE tasks SET status = 'done', error = NULL WHERE id = ?")
        .bind(member.id).run();
      ingested++;
    }
    await env.DB.prepare("UPDATE api_calls SET persisted = 1 WHERE task_id = ?")
      .bind(lead.id).run();
  }

  await submitJudges(env, client, runId);
  return `run ${runId}: ingested ${ingested} answers, ${failed} failed`;
}

/** The judge needs the answers, so it can only go out as a second batch. */
async function submitJudges(env: Env, client: Anthropic, runId: number): Promise<void> {
  const { results: rows } = await env.DB.prepare(
    `SELECT id, answer FROM results
     WHERE run_id = ? AND self_mentioned = 1 AND self_stance IS NULL AND shared_from IS NULL`,
  ).bind(runId).all<{ id: number; answer: string }>();

  if (!rows.length) {
    await env.DB.prepare("UPDATE runs SET status = 'complete', finished_at = ? WHERE id = ?")
      .bind(nowIso(), runId).run();
    return;
  }

  const judgeBatchId = await submitBatch(client, buildJudgeRequests(rows));
  await env.DB.prepare("UPDATE runs SET judge_batch_id = ?, status = 'judging' WHERE id = ?")
    .bind(judgeBatchId, runId).run();
}

async function ingestStances(
  env: Env, client: Anthropic, runId: number, judgeBatchId: string,
): Promise<string> {
  const progress = await batchProgress(client, judgeBatchId);
  await env.DB.prepare("UPDATE runs SET batch_progress = ? WHERE id = ?")
    .bind(JSON.stringify({ ...progress, phase: "judging" }), runId).run();
  if (!progress.ended) {
    return `run ${runId}: judge batch ${progress.succeeded} done, ${progress.processing} in flight`;
  }

  let judged = 0;
  for await (const entry of await client.messages.batches.results(judgeBatchId)) {
    const parsedId = parseCustomId(entry.custom_id);
    if (!parsedId || parsedId.kind !== "judge" || entry.result.type !== "succeeded") continue;

    const stance = parseStanceMessage(entry.result.message as unknown as Anthropic.Message);
    if (!stance) continue;

    const cost = costUsd(JUDGE_MODEL, stance.inputTokens, stance.outputTokens) * BATCH_DISCOUNT;
    await env.DB.prepare(
      `INSERT INTO api_calls
         (run_id, task_id, kind, model, input_tokens, output_tokens, cost_usd, persisted, created_at)
       VALUES (?,NULL,'judge',?,?,?,?,1,?)`,
    ).bind(runId, JUDGE_MODEL, stance.inputTokens, stance.outputTokens, cost, nowIso()).run();
    await env.DB.prepare(
      `UPDATE results SET self_stance = ?, self_evidence = ?, cost_usd = cost_usd + ?
       WHERE id = ? AND run_id = ?`,
    ).bind(stance.stance, stance.evidence, cost, parsedId.id, runId).run();

    // Answers shared with the paired market carry the same stance.
    await env.DB.prepare(
      "UPDATE results SET self_stance = ?, self_evidence = ? WHERE shared_from = ?",
    ).bind(stance.stance, stance.evidence, parsedId.id).run();
    judged++;
  }

  await env.DB.prepare("UPDATE runs SET status = 'complete', finished_at = ? WHERE id = ?")
    .bind(nowIso(), runId).run();
  return `run ${runId}: judged ${judged} mentions, complete`;
}
