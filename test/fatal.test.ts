import Anthropic from "@anthropic-ai/sdk";
import { fatalReason } from "../src/fatal.ts";

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = expected === null ? actual === null : actual !== null;
  if (ok) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}: got ${JSON.stringify(actual)}`); failed++; }
};

console.log("Fatal (stop the run)");
check("exhausted credit balance",
  fatalReason(new Error("Your credit balance is too low to access the Claude API")), "fatal");
check("401", fatalReason(new Anthropic.AuthenticationError(401, {}, "unauthorized", new Headers())), "fatal");
check("billing wording", fatalReason(new Error("billing: payment required")), "fatal");

console.log("\nNot fatal (keep going)");
check("rate limit clears on its own",
  fatalReason(new Anthropic.RateLimitError(429, {}, "rate limited", new Headers())), null);
check("transient network error", fatalReason(new Error("fetch failed")), null);
check("a D1 write failure is our problem, not the key's",
  fatalReason(new Error("D1_ERROR: no such column")), null);
check("an empty answer is not fatal", fatalReason(new Error("empty answer (stop_reason=null)")), null);

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
