-- ICRON LLM Visibility -- schema
-- Safe to re-run: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS prompts (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  country       TEXT NOT NULL,   -- DE | UK | NL | BE | CH
  language      TEXT NOT NULL,   -- de | en | nl | nl-BE | de-CH
  intent        TEXT NOT NULL,   -- funnel layer
  prompt_native TEXT NOT NULL,   -- asked verbatim, in market language
  prompt_en     TEXT NOT NULL,   -- reference translation, for the UI
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_prompts_country ON prompts(country);
CREATE INDEX IF NOT EXISTS idx_prompts_topic   ON prompts(topic);
CREATE INDEX IF NOT EXISTS idx_prompts_intent  ON prompts(intent);

-- Tracked brands and the aliases we match on. Editable without a redeploy.
CREATE TABLE IF NOT EXISTS brands (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  is_self    INTEGER NOT NULL DEFAULT 0,  -- 1 for ICRON
  aliases    TEXT NOT NULL,               -- JSON array of {pattern, caseSensitive}
  color      TEXT NOT NULL DEFAULT '#64748B',
  sort_order INTEGER NOT NULL DEFAULT 100,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  trigger     TEXT NOT NULL DEFAULT 'cron',   -- cron | manual
  status      TEXT NOT NULL DEFAULT 'running', -- running | complete | aborted
  models      TEXT NOT NULL,                  -- JSON array
  modes       TEXT NOT NULL,                  -- JSON array
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  note        TEXT
);

-- One row per Claude call we intend to make.
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  prompt_id  TEXT    NOT NULL REFERENCES prompts(id),
  model      TEXT    NOT NULL,
  mode       TEXT    NOT NULL,               -- grounded | ungrounded
  status     TEXT    NOT NULL DEFAULT 'pending', -- pending|running|done|error|skipped
  attempts   INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, id);
CREATE INDEX IF NOT EXISTS idx_tasks_run   ON tasks(run_id, status);

-- One row per answer. `shared_from` is set when the answer was reused for a
-- byte-identical prompt in another country (DE/CH and NL/BE overlap).
CREATE TABLE IF NOT EXISTS results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES runs(id),
  prompt_id      TEXT    NOT NULL REFERENCES prompts(id),
  model          TEXT    NOT NULL,
  mode           TEXT    NOT NULL,
  answer         TEXT    NOT NULL,
  self_mentioned INTEGER NOT NULL DEFAULT 0,
  self_rank      INTEGER,                    -- 1 = named before every other tracked brand
  self_stance    TEXT,                       -- recommended | listed | qualified | negative
  self_evidence  TEXT,                       -- judge's one-line justification
  citations      TEXT NOT NULL DEFAULT '[]', -- JSON array of {url, domain, title}
  search_count   INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  shared_from    INTEGER REFERENCES results(id),
  created_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique ON results(run_id, prompt_id, model, mode);
CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);

-- Exploded brand hits, so aggregation is a plain GROUP BY.
CREATE TABLE IF NOT EXISTS mentions (
  result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  run_id    INTEGER NOT NULL,
  brand_id  TEXT    NOT NULL,
  rank      INTEGER NOT NULL,   -- 1-based order of first appearance
  hits      INTEGER NOT NULL,   -- times named in the answer
  PRIMARY KEY (result_id, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_run ON mentions(run_id, brand_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Lets the runner cheaply find an answer already produced for a byte-identical
-- prompt in another country (DE/CH share German text, NL/BE share Dutch).
CREATE INDEX IF NOT EXISTS idx_prompts_native ON prompts(prompt_native);
