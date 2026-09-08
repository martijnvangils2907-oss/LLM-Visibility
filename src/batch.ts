import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { JUDGE_MODEL } from "./claude.ts";
import type { Citation, Mode } from "./types.ts";

/**
 * Batch engine.
 *
 * The Messages API and the Batches API accept the same request body, so the
 * request builders here are shared with the synchronous path in spirit and
 * kept pure so they can be tested without an account. Everything that touches
 * the network lives in the small wrappers below.
 */

/** Batched usage is billed at half the standard rate. */
export const BATCH_DISCOUNT = 0.5;

export interface AnswerJob {
  taskId: number;      // the lead task of a deduplicated group
  model: string;
  mode: Mode;
  prompt: string;
}

export const answerCustomId = (taskId: number) => `a${taskId}`;
export const judgeCustomId = (resultId: number) => `j${resultId}`;

/** Parse a custom_id back to its kind and numeric id. */
export function parseCustomId(id: string): { kind: "answer" | "judge"; id: number } | null {
  const m = /^([aj])(\d+)$/.exec(id);
  if (!m) return null;
  return { kind: m[1] === "a" ? "answer" : "judge", id: Number(m[2]) };
}

export function buildAnswerRequests(
  jobs: AnswerJob[],
  opts: { maxSearches?: number } = {},
): Anthropic.Messages.Batches.BatchCreateParams["requests"] {
  return jobs.map((job) => ({
    custom_id: answerCustomId(job.taskId),
    params: {
      model: job.model,
      max_tokens: 4000,
      messages: [{ role: "user" as const, content: job.prompt }],
      // The prompt is sent exactly as a buyer would ask it: no system prompt,
      // no persona. Grounded answers get the same web search tool as the
      // synchronous path, which the Batches API supports.
      ...(job.mode === "grounded"
        ? {
            tools: [{
              type: "web_search_20260209" as const,
              name: "web_search" as const,
              max_uses: opts.maxSearches ?? 6,
            }],
          }
        : {}),
    },
  }));
}

const StanceSchema = z.object({
  stance: z.enum(["recommended", "listed", "qualified", "negative"]),
  evidence: z.string(),
});

export const JUDGE_PROMPT = (answer: string) =>
  "The text below is an AI assistant's answer to a supply chain software question. " +
  "It mentions a vendor called ICRON. Classify how the answer positions ICRON:\n\n" +
  "- recommended: actively recommended, or named as a leading/best-fit option\n" +
  "- listed: named neutrally in a list of vendors, with no particular endorsement\n" +
  "- qualified: named but hedged, e.g. niche, smaller, less proven, only for narrow cases\n" +
  "- negative: named unfavourably, or explicitly steered away from\n\n" +
  "Give one short sentence of evidence quoting or paraphrasing the relevant part.\n\n" +
  "<answer>\n" + answer + "\n</answer>";

export function buildJudgeRequests(
  rows: { id: number; answer: string }[],
): Anthropic.Messages.Batches.BatchCreateParams["requests"] {
  return rows.map((row) => ({
    custom_id: judgeCustomId(row.id),
    params: {
      model: JUDGE_MODEL,
      max_tokens: 500,
      // No `effort` here: Haiku 4.5 returns a 400 for it.
      output_config: { format: zodOutputFormat(StanceSchema) },
      messages: [{ role: "user" as const, content: JUDGE_PROMPT(row.answer) }],
    },
  }));
}

export interface ParsedAnswer {
  answer: string;
  citations: Citation[];
  searchCount: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Pull the answer out of a batched message.
 *
 * A batched request is single-shot, so unlike the synchronous path there is no
 * pause_turn to resume: whatever the model produced in one turn is the answer.
 */
export function parseAnswerMessage(message: Anthropic.Message): ParsedAnswer {
  let answer = "";
  const citations: Citation[] = [];
  let searchCount = 0;

  for (const block of message.content) {
    if (block.type === "text") {
      answer += block.text;
    } else if (block.type === "web_search_tool_result") {
      // Success returns a list of results; an error returns a single object.
      const content = block.content as unknown;
      if (Array.isArray(content)) {
        searchCount++;
        for (const r of content as { url?: string; title?: string }[]) {
          if (!r.url) continue;
          let domain = "";
          try {
            domain = new URL(r.url).hostname.replace(/^www\./, "");
          } catch {
            continue;
          }
          if (!citations.some((c) => c.url === r.url)) {
            citations.push({ url: r.url, domain, title: r.title ?? "" });
          }
        }
      }
    }
  }

  return {
    answer: answer.trim(),
    citations,
    searchCount,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

export interface ParsedStance {
  stance: "recommended" | "listed" | "qualified" | "negative";
  evidence: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Structured outputs guarantee the shape, but a refusal or a max_tokens stop
 * can still return something else, so this validates rather than casts.
 */
export function parseStanceMessage(message: Anthropic.Message): ParsedStance | null {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) return null;
  try {
    const parsed = StanceSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return {
      stance: parsed.data.stance,
      evidence: parsed.data.evidence,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- network I/O */

export async function submitBatch(
  client: Anthropic,
  requests: Anthropic.Messages.Batches.BatchCreateParams["requests"],
): Promise<string> {
  const batch = await client.messages.batches.create({ requests });
  return batch.id;
}

export async function batchEnded(client: Anthropic, batchId: string): Promise<boolean> {
  const batch = await client.messages.batches.retrieve(batchId);
  return batch.processing_status === "ended";
}
