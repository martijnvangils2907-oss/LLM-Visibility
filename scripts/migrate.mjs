/**
 * Adds columns that CREATE TABLE ... IF NOT EXISTS cannot add to a database
 * that already exists.
 *
 * SQLite has no ADD COLUMN IF NOT EXISTS, and the deploy re-applies migrations
 * every run, so a bare ALTER would fail on the second deploy. This reads the
 * live schema first and applies only what is missing, which makes it safe to
 * run every time.
 *
 * Usage: node scripts/migrate.mjs [--local]
 */
import { execFileSync } from "node:child_process";

const DB = "icron-visibility";
const scope = process.argv.includes("--local") ? "--local" : "--remote";

/** Tables that must exist even on a database created before they were added. */
const REQUIRED_TABLES = {
  api_calls: `CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, task_id INTEGER,
    kind TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, persisted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL)`,
};

/** Columns every table must have, beyond what 0001_init.sql creates. */
const REQUIRED = {
  runs: [
    ["engine", "TEXT NOT NULL DEFAULT 'sync'"],
    ["batch_id", "TEXT"],
    ["judge_batch_id", "TEXT"],
    ["batch_progress", "TEXT"],
  ],
};

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, scope, "--yes", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  // Wrangler prefixes human-readable lines before the JSON payload.
  const start = out.indexOf("[");
  if (start === -1) throw new Error(`Unexpected wrangler output:\n${out}`);
  return JSON.parse(out.slice(start));
}

for (const [name, ddl] of Object.entries(REQUIRED_TABLES)) {
  d1(ddl.replace(/\s+/g, " "));
  d1(`CREATE INDEX IF NOT EXISTS idx_${name}_run ON ${name}(run_id)`);
  console.log(`${name}: ensured`);
}

let added = 0;
for (const [table, columns] of Object.entries(REQUIRED)) {
  const info = d1(`PRAGMA table_info(${table})`);
  const existing = new Set((info[0]?.results ?? []).map((r) => r.name));
  if (!existing.size) {
    console.log(`${table}: not present yet, schema migration will create it`);
    continue;
  }
  for (const [name, type] of columns) {
    if (existing.has(name)) continue;
    console.log(`${table}: adding column ${name}`);
    d1(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added++;
  }
}
console.log(added ? `Added ${added} column(s).` : "Schema already up to date.");
