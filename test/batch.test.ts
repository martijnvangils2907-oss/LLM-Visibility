import {
  answerCustomId, buildAnswerRequests, buildJudgeRequests, judgeCustomId,
  parseAnswerMessage, parseCustomId, parseStanceMessage, BATCH_DISCOUNT,
} from "../src/batch.ts";
import { costUsd } from "../src/types.ts";

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`); failed++; }
  else console.log(`  ok   ${name}`);
};

console.log("Request building");
const reqs = buildAnswerRequests([
  { taskId: 7, model: "claude-opus-5", mode: "grounded", prompt: "Welche Anbieter?" },
  { taskId: 8, model: "claude-sonnet-5", mode: "ungrounded", prompt: "Which vendors?" },
]);
check("one request per job", reqs.length, 2);
check("custom_id round-trips", parseCustomId(reqs[0].custom_id), { kind: "answer", id: 7 });
check("grounded request carries web search",
  (reqs[0].params as any).tools?.[0]?.type, "web_search_20260209");
check("ungrounded request carries no tools", (reqs[1].params as any).tools, undefined);
check("prompt is sent verbatim, with no system prompt",
  [(reqs[0].params as any).messages[0].content, (reqs[0].params as any).system],
  ["Welche Anbieter?", undefined]);
check("search depth is configurable",
  (buildAnswerRequests([{ taskId: 1, model: "m", mode: "grounded", prompt: "p" }],
    { maxSearches: 3 })[0].params as any).tools[0].max_uses, 3);

console.log("\nJudge requests");
const jreqs = buildJudgeRequests([{ id: 42, answer: "ICRON is one option." }]);
check("judge custom_id round-trips", parseCustomId(jreqs[0].custom_id), { kind: "judge", id: 42 });
check("judge uses the cheap model", (jreqs[0].params as any).model, "claude-haiku-4-5");
check("judge sends no effort (Haiku 4.5 rejects it)",
  (jreqs[0].params as any).output_config.effort, undefined);
check("judge asks about the actual answer",
  (jreqs[0].params as any).messages[0].content.includes("ICRON is one option."), true);

console.log("\ncustom_id parsing");
check("rejects junk", parseCustomId("nonsense"), null);
check("rejects an empty id", parseCustomId("a"), null);
check("answer and judge ids do not collide",
  answerCustomId(5) === judgeCustomId(5), false);

console.log("\nAnswer parsing");
const msg = {
  content: [
    { type: "text", text: "Kinaxis and " },
    { type: "web_search_tool_result", content: [
      { url: "https://gartner.com/a", title: "Report" },
      { url: "https://www.icrontech.com/b", title: "ICRON" },
      { url: "https://gartner.com/a", title: "Report" },   // duplicate
    ] },
    { type: "text", text: "ICRON are options." },
  ],
  usage: { input_tokens: 11000, output_tokens: 800 },
} as any;
const parsed = parseAnswerMessage(msg);
check("concatenates text blocks", parsed.answer, "Kinaxis and ICRON are options.");
check("counts one search", parsed.searchCount, 1);
check("dedupes citations", parsed.citations.length, 2);
check("strips www from the domain", parsed.citations[1].domain, "icrontech.com");
check("carries usage through", [parsed.inputTokens, parsed.outputTokens], [11000, 800]);

// A failed search returns an object, not a list -- indexing it would throw.
const errMsg = {
  content: [
    { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
    { type: "text", text: "Answer without search." },
  ],
  usage: { input_tokens: 50, output_tokens: 20 },
} as any;
check("survives a web search error block",
  [parseAnswerMessage(errMsg).answer, parseAnswerMessage(errMsg).searchCount],
  ["Answer without search.", 0]);

console.log("\nStance parsing");
const good = { content: [{ type: "text", text: '{"stance":"listed","evidence":"Named in a list."}' }],
  usage: { input_tokens: 900, output_tokens: 40 } } as any;
check("parses a valid stance", parseStanceMessage(good)?.stance, "listed");
check("rejects a stance outside the enum",
  parseStanceMessage({ content: [{ type: "text", text: '{"stance":"amazing","evidence":"x"}' }],
    usage: { input_tokens: 1, output_tokens: 1 } } as any), null);
check("rejects malformed JSON, e.g. a truncated answer",
  parseStanceMessage({ content: [{ type: "text", text: '{"stance":"lis' }],
    usage: { input_tokens: 1, output_tokens: 1 } } as any), null);
check("rejects an empty response",
  parseStanceMessage({ content: [], usage: { input_tokens: 0, output_tokens: 0 } } as any), null);

console.log("\nBilling");
const full = costUsd("claude-opus-5", 11000, 800);
check("batch bills at half the standard rate",
  Math.round(full * BATCH_DISCOUNT * 1e6) / 1e6, Math.round(full / 2 * 1e6) / 1e6);

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
