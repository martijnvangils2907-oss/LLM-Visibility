import Anthropic from "@anthropic-ai/sdk";

/**
 * Errors where continuing the sweep is pointless: no credit, a bad key, a
 * revoked key. Every remaining task would fail the same way, so the run is
 * stopped rather than ground through 1200 tasks and their retries.
 *
 * A rate limit is deliberately not fatal -- that one does clear on its own.
 */
export function fatalReason(err: unknown): string | null {
  if (err instanceof Anthropic.AuthenticationError) return "API key rejected";
  if (err instanceof Anthropic.PermissionDeniedError) return "API key lacks permission";

  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);

  // Anthropic reports an exhausted balance as a 400 naming the credit balance.
  if (/credit balance is too low|insufficient (credit|funds)|billing/i.test(message)) {
    return "Anthropic credit balance exhausted";
  }
  if (status === 401 || status === 403) return `API key rejected (HTTP ${status})`;
  return null;
}
