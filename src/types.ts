export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  ADMIN_TOKEN?: string;
  SWEEP_CRON: string;
  DRAIN_CRON: string;
  SWEEP_MODELS: string;
  SWEEP_MODES: string;
  DRAIN_BATCH_SIZE: string;
  MAX_RUN_COST_USD: string;
  DEDUPE_IDENTICAL_PROMPTS: string;
  MAX_SEARCHES_PER_ANSWER?: string;
  /** "batch" bills at half price; "sync" answers one call at a time. */
  SWEEP_ENGINE?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

export type Mode = "grounded" | "ungrounded";

export interface BrandRow {
  id: string;
  label: string;
  is_self: number;
  aliases: string;
  color: string;
  sort_order: number;
}

export interface Brand {
  id: string;
  label: string;
  isSelf: boolean;
  color: string;
  sortOrder: number;
  aliases: { pattern: string; caseSensitive?: boolean }[];
}

export interface Citation {
  url: string;
  domain: string;
  title: string;
}

/** Per-million-token list prices, keyed by model id. */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}
