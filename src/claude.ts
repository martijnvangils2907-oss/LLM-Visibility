import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Citation, Mode } from "./types.ts";

/**
 * Model used to judge how ICRON was talked about. Only runs when an answer
 * actually names us, and the task is a four-way classification against written
 * definitions, so the cheapest current model is the right tool.
 *
 * Note: Haiku 4.5 rejects `output_config.effort`, so the judge must not send it.
 */
export const JUDGE_MODEL = "claude-haiku-4-5";

export interface AskResult {
  answer: string;
  citations: Citation[];
  searchCount: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

/**
 * Ask Claude a market prompt exactly as a buyer would: no system prompt, no
 * persona, no mention of ICRON. Anything we add here would contaminate the
 * measurement.
 */
export async function ask(
  client: Anthropic,
  model: string,
  mode: Mode,
  prompt: string,
  opts: { maxSearches?: number } = {},
): Promise<AskResult> {
  // Search results land in the input context, so this is the single biggest
  // lever on grounded cost. Lowering it also makes the answer less researched
  // than a real user's, so it trades measurement fidelity for money.
  const tools =
    mode === "grounded"
      ? [{
          type: "web_search_20260209" as const,
          name: "web_search" as const,
          max_uses: opts.maxSearches ?? 6,
        }]
      : undefined;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";
  const citations: Citation[] = [];
  let searchCount = 0;
  let stopReason: string | null = null;

  // A grounded turn can stop with `pause_turn` part-way through its searches.
  // Push the paused assistant turn back and continue, or the answer is
  // silently truncated and we record a false negative.
  for (let turn = 0; turn < 6; turn++) {
    const res = await client.messages.create({
      model,
      max_tokens: 4000,
      messages,
      ...(tools ? { tools } : {}),
    });

    inputTokens += res.usage.input_tokens;
    outputTokens += res.usage.output_tokens;
    stopReason = res.stop_reason;

    for (const block of res.content) {
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

    if (res.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: res.content });
  }

  return { answer: answer.trim(), citations, searchCount, inputTokens, outputTokens, stopReason };
}

const StanceSchema = z.object({
  stance: z.enum(["recommended", "listed", "qualified", "negative"]),
  evidence: z.string(),
});

export interface Stance {
  stance: "recommended" | "listed" | "qualified" | "negative";
  evidence: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A mention is not a win on its own. Being top of a recommendation reads very
 * differently from being a footnote or a caveat, so classify how the answer
 * actually positions ICRON.
 */
export async function judgeStance(
  client: Anthropic,
  answer: string,
): Promise<Stance | null> {
  try {
    const res = await client.messages.parse({
      model: JUDGE_MODEL,
      max_tokens: 500,
      // No `effort` here: Haiku 4.5 returns a 400 for it.
      output_config: { format: zodOutputFormat(StanceSchema) },
      messages: [
        {
          role: "user",
          content:
            "The text below is an AI assistant's answer to a supply chain software question. " +
            "It mentions a vendor called ICRON. Classify how the answer positions ICRON:\n\n" +
            "- recommended: actively recommended, or named as a leading/best-fit option\n" +
            "- listed: named neutrally in a list of vendors, with no particular endorsement\n" +
            "- qualified: named but hedged, e.g. niche, smaller, less proven, only for narrow cases\n" +
            "- negative: named unfavourably, or explicitly steered away from\n\n" +
            "Give one short sentence of evidence quoting or paraphrasing the relevant part.\n\n" +
            "<answer>\n" + answer + "\n</answer>",
        },
      ],
    });
    const parsed = res.parsed_output;
    if (!parsed) return null;
    return {
      stance: parsed.stance,
      evidence: parsed.evidence,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    };
  } catch {
    // The judge is a nice-to-have. Never let it fail a measured answer.
    return null;
  }
}
