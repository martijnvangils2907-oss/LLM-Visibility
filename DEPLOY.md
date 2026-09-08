# Deploying to Cloudflare

**Option A is strongly recommended.** It does the Cloudflare setup for you --
database, Zero Trust organisation, Access application and policy, custom domain --
and leaves you four steps that genuinely cannot be automated, because you have to
be signed in to Cloudflare to do them at all. Credentials live in GitHub's secret
store rather than on someone's laptop.

Option B is the manual equivalent, for when you would rather drive it yourself.

---

## Option A — deploy from GitHub Actions

The workflow does everything that can be done over an API: it creates the D1
database, the Zero Trust organisation, the Access application and its allow
policy, reads the application's AUD tag back and bakes it into the Worker, then
deploys and attaches the custom domain. No identifier is copied between
dashboards by hand.

Four steps are left for you, because none of them can be bootstrapped without
already being signed in.

### 1. Create a Cloudflare API token

Cloudflare dashboard → My Profile → API Tokens → **Create Token** → *Create
Custom Token*. Name it `icron-llm-visibility-deploy` and add these permissions:

| Type | Resource | Level | Needed for |
|---|---|---|---|
| Account | Workers Scripts | Edit | deploying the Worker |
| Account | D1 | Edit | creating the database, loading prompts |
| Account | Account Settings | Read | resolving the account |
| Account | Cloudflare Zero Trust | Edit | the Access application and policy |
| Zone | Workers Routes | Edit | attaching the custom domain |
| Zone | Zone | Read | finding the zone for that domain |

Under *Account Resources* pick your account; under *Zone Resources* pick the
zone for your dashboard hostname. **The token is shown once** — copy it.

### 2. Copy your Account ID

Workers & Pages → Overview → right-hand column.

### 3. Add four repository secrets

GitHub → Settings → Secrets and variables → Actions → **Secrets**:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | from step 2 |
| `ANTHROPIC_API_KEY` | the key the sweeps bill against |
| `ADMIN_TOKEN` | `openssl rand -hex 24` — keep it, you need it to start a sweep |

### 4. Run the workflow

Actions → **Deploy** → Run workflow.

`workflow_dispatch` is only offered for workflows on the repository's default
branch, which here is the `claude/...` branch, because the repository was created
empty and GitHub made the first pushed branch the default.

### Defaults, and how to change them

Nothing below needs setting unless you want something different. Override any of
them with a repository *variable* (Settings → Secrets and variables → Actions →
**Variables**):

| Variable | Default | Notes |
|---|---|---|
| `APP_HOSTNAME` | `llmvisibilityicron.uk` | the zone must be on this Cloudflare account |
| `ACCESS_TEAM_NAME` | `icron` | becomes `icron.cloudflareaccess.com`. **Permanent** — Cloudflare does not allow renaming it |
| `ACCESS_EMAIL_DOMAIN` | `icrontech.com` | everyone at this domain may open the dashboard |
| `ACCESS_EMAILS` | *(empty)* | extra individual addresses, comma separated |

The setup refuses to create an Access application with no allow rule, rather than
publishing an unguarded dashboard.

### If the Zero Trust step fails

Zero Trust has to be subscribed once before its API will answer, and that first
click is dashboard-only. If the workflow stops with *"Zero Trust not subscribed"*,
open Cloudflare → **Zero Trust** in the sidebar, choose the **Free** plan (it asks
for a card and does not charge it), then re-run the workflow. Everything else is
automated either way.

These Cloudflare calls could not be rehearsed against a live account from the
machine that wrote them, so each one reports the API's own error code and a
suggested fix rather than failing silently. `npm test` covers the control flow
against a mock.

### Later changes

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

This deploys the Worker but does **not** set up Access, so the dashboard would be
unreachable (there is no `workers.dev` URL) and, once you attach a domain,
unguarded. Run the Cloudflare setup too:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
APP_HOSTNAME=llmvisibilityicron.uk ACCESS_TEAM_NAME=icron \
ACCESS_EMAIL_DOMAIN=icrontech.com \
  node scripts/cf-setup.mjs
```

It prints the team domain and AUD tag. Put both into `[vars]` in `wrangler.toml`,
add a `[[routes]]` block with `pattern = "llmvisibilityicron.uk"` and
`custom_domain = true`, and deploy again.

Do not commit the database id, the AUD tag or the routes block if you also use
Option A — the workflow injects all of them, and committed values are overwritten.

---

## 5. Verify before sharing the link

The workflow prints the dashboard URL and the sign-in domain in its summary.

`workers_dev = false` is set deliberately, so there is **no `*.workers.dev` URL**
that would sidestep Access.

Open the hostname in a private window: you should be redirected to a Cloudflare
Access login, and land on the dashboard after signing in.

Then the check that actually matters:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://llmvisibilityicron.uk/api/overview
```

**This must print `401` or `302`.** A `200` means the data is public — say so and
stop. With `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` baked in, a request carrying no
valid Access JWT is rejected by the Worker itself, not only at the edge, so a
route misconfiguration cannot quietly expose it. The deploy fails outright if
either value is empty.

To change who has access later: Zero Trust → Access → Applications → *ICRON LLM
Visibility* → Policies. Or change `ACCESS_EMAIL_DOMAIN` / `ACCESS_EMAILS` and
re-run the workflow, which rewrites the policy in place.

## 6. Run the first sweep

Sweeps run automatically every Monday at 06:00 UTC. To start one now, open

```
https://llmvisibilityicron.uk/?token=<ADMIN_TOKEN>
```

go to **Runs**, and press **Start a sweep now**. It enqueues ~780 Claude calls and
drains 12 a minute, so a full sweep takes about an hour. The Runs tab shows live
progress. You can close the tab; the per-minute cron keeps draining.

---

## What it costs

At the shipped configuration (Sonnet 5 + Opus 5, grounded + ungrounded, 195
distinct prompts, submitted as a batch) a sweep is about **$14**, so roughly
**$710 a year** weekly. The **Runs** tab shows a live estimate from your actual
configuration, and what the last sweep actually cost.

That already includes the 50% Message Batches discount. Grounded Opus is most of
what remains. To cut further, edit `[vars]` in `wrangler.toml`:

- `SWEEP_MODELS = "claude-sonnet-5"` — roughly a third of the bill.
- `SWEEP_MODES = "grounded"` — drops the knowledge-vs-retrieval split.
- Change the sweep cron to `0 6 1,15 * *` for fortnightly.
- `MAX_SEARCHES_PER_ANSWER = "3"` — the largest remaining knob, but it makes
  answers less researched than a real buyer's, so it costs measurement fidelity.

Before dropping a model, check the **Trend** tab: if Opus and Sonnet track each
other, one of them is a duplicate number you are paying twice for. If they
diverge, that difference is itself a finding.

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
