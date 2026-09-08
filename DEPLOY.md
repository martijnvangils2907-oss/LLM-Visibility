# Deploying to Cloudflare

Two routes. Both end in the same place. **Option A is recommended**: credentials
live in GitHub's secret store rather than on someone's laptop, and every future
change to the prompt set redeploys by pushing a commit.

Whichever you pick, steps 5 (custom domain) and 6 (Access) are dashboard work and
have to be done once by hand.

---

## Option A — deploy from GitHub Actions

### 1. Create a Cloudflare API token

Cloudflare dashboard → My Profile → API Tokens → **Create Token** → *Create Custom
Token*. Give it exactly these permissions:

| Type | Resource | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |

Scope it to your account under *Account Resources*. Nothing zone-level is needed —
the custom domain is attached by hand in step 5.

Also copy your **Account ID** from Workers & Pages → Overview (right-hand column).

### 2. Add the repository secrets

GitHub → the repo → Settings → Secrets and variables → Actions → **Secrets**:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID |
| `ANTHROPIC_API_KEY` | the Anthropic key the sweeps bill against |
| `ADMIN_TOKEN` | any long random string, e.g. `openssl rand -hex 24` |

`ADMIN_TOKEN` gates starting and aborting sweeps. To use the "Start a sweep now"
button, open the dashboard once with `?token=<that value>`.

### 3. Run the workflow

Actions → **Deploy** → Run workflow, on this branch. It will:

- create the D1 database if it does not exist, and resolve its id from the API, so
  no account-specific id is ever committed;
- verify the build (typecheck, brand-detection tests, and a check that the seed SQL
  matches `data/prompts.csv`);
- apply the schema and load the 300 prompts;
- push the Worker secrets;
- deploy.

Both SQL files are idempotent. The schema is `CREATE ... IF NOT EXISTS`, and the
seed upserts rather than replaces, so re-running it updates prompt text in place
and never touches collected results. Prompts you delete from the CSV are marked
inactive rather than removed, which keeps their history readable.

The workflow uses a `production` GitHub environment. If you want a human approval
gate before anything reaches Cloudflare, add required reviewers to it under
Settings → Environments.

### 4. Later changes

Re-run the workflow from the Actions tab. The `push` trigger is set to `main`,
which does not exist yet: this repository was created empty, so GitHub made the
`claude/...` branch the default. That is what makes the Run workflow button
appear at all, since `workflow_dispatch` is only offered for workflows on the
default branch.

Once you are happy with it, Settings -> Branches -> rename the default branch to
`main`. Pushes then redeploy automatically.

---

## Option B — deploy from your own machine

Needs Node 22+ and a browser for the OAuth login.

```bash
npm install
npx wrangler login

npx wrangler d1 create icron-visibility
# copy the printed database_id into wrangler.toml, replacing
# REPLACE_WITH_YOUR_D1_DATABASE_ID

npm run db:init:remote                      # schema, then the 300 prompts

npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ADMIN_TOKEN

npm run deploy
```

Do not commit the database id if you also use Option A — the workflow injects it,
and a committed value would be overwritten anyway.

---

## 5. Attach a custom domain

`workers_dev = false` is set deliberately, so there is **no `*.workers.dev` URL**
that would sidestep Access. Until you attach a route, the Worker is unreachable.

Cloudflare dashboard → Workers & Pages → `icron-llm-visibility` → Settings →
Domains & Routes → Add → **Custom domain**. Use something like
`llm-visibility.icrontech.com`. Cloudflare creates the DNS record for you.

## 6. Put Cloudflare Access in front of it

Zero Trust → Access → Applications → Add an application → **Self-hosted**.

- **Application domain**: the hostname from step 5.
- **Session duration**: 24 hours is a sensible default.
- **Policy**: Allow → Include → *Emails ending in* `@icrontech.com`, or a specific
  list of addresses. Add a second Include rule for any external colleague.
- Under **Overview**, copy the **Application Audience (AUD) Tag**.

Then bind it so the Worker verifies the token itself, not just the edge. Either
add two GitHub repository *variables* (Settings → Secrets and variables → Actions
→ **Variables**) and re-run the workflow:

| Variable | Value |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `yourteam.cloudflareaccess.com` (no scheme) |
| `ACCESS_AUD` | the AUD tag you copied |

…or, on Option B, edit `[vars]` in `wrangler.toml` and redeploy.

**Verify this before sharing the link.** Open the URL in a private window: you
should be bounced to the Access login. With those two values set, a request
carrying no valid Access JWT gets a 401 from the Worker itself. With them empty,
the Worker trusts whatever reaches it — the deploy logs a warning when that is the
case.

## 7. Run the first sweep

Sweeps run automatically every Monday at 06:00 UTC. To start one now, open

```
https://your-hostname/?token=<ADMIN_TOKEN>
```

go to **Runs**, and press **Start a sweep now**. It enqueues ~780 Claude calls and
drains 12 a minute, so a full sweep takes about an hour. The Runs tab shows live
progress. You can close the tab; the per-minute cron keeps draining.

---

## What it costs

At the shipped configuration (Sonnet 5 + Opus 5, grounded + ungrounded, 195
distinct prompts) a sweep is about **$27**, so roughly **$1,400 a year** weekly.
The **Runs** tab shows a live estimate from your actual configuration.

Grounded Opus is most of it. To cut cost, edit `[vars]` in `wrangler.toml`:

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

**Workflow fails at "Resolve the D1 database".** The API token is missing the D1
Edit permission, or `CLOUDFLARE_ACCOUNT_ID` is wrong.

**Dashboard returns 401 for everyone.** `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` does
not match the Access application. Re-copy the AUD tag; the team domain is the full
`yourteam.cloudflareaccess.com`, with no scheme.

**Sweep stays at 0 done.** Check `npx wrangler tail`. Usually a missing or invalid
`ANTHROPIC_API_KEY`; failed tasks carry the API error:

```bash
npx wrangler d1 execute icron-visibility --remote \
  --command "SELECT error, COUNT(*) FROM tasks WHERE status='error' GROUP BY error"
```

**Everything shows zero visibility.** Confirm the vendors loaded:
`SELECT id, label FROM brands`. If the table is empty the seed did not apply.
