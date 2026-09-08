# Deploying to Cloudflare

Roughly 20 minutes end to end. You need a Cloudflare account, a domain on that
account (for Access), and an Anthropic API key.

## 1. Install and sign in

```bash
npm install
npx wrangler login
```

## 2. Create the database

```bash
npx wrangler d1 create icron-visibility
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

## 3. Create the tables and load the prompts

```bash
npm run db:init:remote
```

That applies `migrations/0001_init.sql` (schema) then
`migrations/0002_seed_prompts.sql` (300 prompts, 5 vendors). Both are safe to
re-run; the seed replaces the prompt and brand tables and leaves results alone.

## 4. Set the secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY     # your Anthropic API key
npx wrangler secret put ADMIN_TOKEN           # any long random string
```

`ADMIN_TOKEN` gates starting and aborting sweeps. Generate one with
`openssl rand -hex 24`. To use the "Start a sweep now" button, open the dashboard
with `?token=<that value>` once.

## 5. Deploy

```bash
npm run deploy
```

`workers_dev = false` is set deliberately, so there is no `*.workers.dev` URL that
would bypass Access. The Worker is only reachable once you attach a route.

## 6. Attach a route

Cloudflare dashboard → Workers & Pages → `icron-llm-visibility` → Settings →
Domains & Routes → Add → Custom domain. Use something like
`llm-visibility.icrontech.com`. Cloudflare creates the DNS record.

## 7. Put Cloudflare Access in front of it

Zero Trust → Access → Applications → Add an application → Self-hosted.

- **Application domain**: the hostname from step 6.
- **Session duration**: 24 hours is a reasonable default.
- **Policy**: Allow → Include → *Emails ending in* `@icrontech.com`, or a
  specific list of email addresses. Add a second Include rule for any external
  colleague who needs it.
- Under **Overview**, copy the **Application Audience (AUD) Tag**.

Then bind that to the Worker so it verifies the token itself, not just the edge:

```toml
# wrangler.toml, in [vars]
ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
ACCESS_AUD = "the-aud-tag-you-copied"
```

```bash
npm run deploy
```

**Verify this before sharing the link.** With those two vars set, a request
without a valid Access JWT gets a 401 from the Worker itself. With them empty,
the Worker trusts whatever reaches it. Test in a private window: you should be
bounced to the Access login.

## 8. Run the first sweep

Sweeps run automatically every Monday at 06:00 UTC. To start one now, open

```
https://your-hostname/?token=<ADMIN_TOKEN>
```

go to **Runs**, and press **Start a sweep now**. It enqueues ~780 Claude calls and
drains 12 a minute, so a full sweep takes about an hour. The Runs tab shows live
progress. You can close the tab; the cron keeps draining.

## What it costs

At the shipped configuration (Sonnet 5 + Opus 5, grounded + ungrounded, 195
distinct prompts) a sweep is about **$27**, so roughly **$1,400 a year** weekly.
The **Runs** tab shows a live estimate from your actual configuration.

Grounded Opus is most of it. To cut cost:

- `SWEEP_MODELS = "claude-sonnet-5"` — roughly a third of the bill.
- `SWEEP_MODES = "grounded"` — drops the knowledge-vs-retrieval split.
- Change the sweep cron to `0 6 1,15 * *` for fortnightly.

`MAX_RUN_COST_USD` is a hard stop: when a run's recorded spend passes it, the
remaining tasks are skipped and the run is marked aborted. It is a backstop
against a runaway loop, not a budget planner — set it comfortably above the
estimate.

## Operating notes

- **Two crons are registered.** `0 6 * * 1` opens the weekly sweep; `* * * * *`
  drains a batch. Removing the per-minute cron stops results being collected.
- **A sweep will not start while another is running**, by cron or by button.
- **Failed tasks retry twice**, then are marked `error` and skipped. A handful of
  errors in a sweep is normal and does not invalidate the aggregate.
- **Cost is recorded per answer**, so the Runs tab shows real spend, not the
  estimate.

## Troubleshooting

**Dashboard returns 401 for everyone.** `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` does
not match the Access application. Re-copy the AUD tag; the team domain is the full
`yourteam.cloudflareaccess.com`, no scheme.

**Sweep stays at 0 done.** Check `npx wrangler tail`. Usually a missing or invalid
`ANTHROPIC_API_KEY`; task rows will carry the API error in their `error` column:

```bash
npx wrangler d1 execute icron-visibility --remote \
  --command "SELECT error, COUNT(*) FROM tasks WHERE status='error' GROUP BY error"
```

**Everything shows zero visibility.** Confirm brand detection is loaded:
`SELECT id, label FROM brands`. If the table is empty the seed did not apply.
