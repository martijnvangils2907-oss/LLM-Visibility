# ICRON LLM Visibility

Tracks how visible ICRON is in Claude's answers to the questions our markets
actually ask, and how that compares to Kinaxis, Blue Yonder, OMP and SAP.

None of the 300 prompts name ICRON. We are measuring **unbranded, unprompted**
visibility: whether Claude reaches for us when a buyer describes their problem.

## What it measures

Every week the Worker asks Claude all 300 prompts, in the market's own language,
with no system prompt and no persona, and records the full answer. Each answer is
then scanned for the tracked vendors.

| Metric | Definition | Why it is here |
|---|---|---|
| **Visibility score** | Mean reciprocal rank x 100. Named first = 1.0, second = 0.5, third = 0.33, absent = 0. | One comparable number that rewards being named *and* being named early. |
| **Mention rate** | Share of answers naming the vendor at all. | The blunt "are we in the conversation" number. |
| **Average position** | Mean rank among named vendors, over answers that name us. | Being third on every list is a different problem from being absent. |
| **Share of voice** | Our mentions as a share of all tracked vendor mentions. | Movement here means we took ground from someone. |
| **Stance** | recommended / listed / qualified / negative, judged per mention. | A mention is not automatically a win. |
| **Sources** | Domains Claude read while answering, split by whether the answer named us. | Turns a score into a content brief. |

### Two grounding modes, run side by side

Each prompt is asked twice per model:

- **grounded** uses Claude's web search tool. This is closest to what a buyer sees
  in claude.ai today, and it moves when our content moves.
- **ungrounded** uses only the model's own knowledge. This moves slowly and
  reflects whether ICRON is in the model's picture of the category at all.

A gap between the two is the useful signal. Strong grounded and weak ungrounded
means our content is working but the brand has not landed. The reverse means
Claude knows us but is not finding current pages to cite.

## Known limits, stated plainly

- **105 of the 300 prompts are byte-identical to another row.** 48 German prompts
  are shared between DE and CH, and 57 Dutch prompts between NL and BE. The runner
  asks each distinct question once and attributes the answer to both markets, which
  cuts roughly a third off the API bill. It also means **a DE-CH or NL-BE
  difference is not a real market difference** until those prompts are localised.
  The Markets tab says so on the page. Set `DEDUPE_IDENTICAL_PROMPTS = "false"` to
  ask them separately instead.
- **Answers are non-deterministic.** Claude does not return the same text twice.
  Read week-over-week movement, not single-run precision. With ~1,200 answers per
  sweep, aggregate scores are stable; a single prompt's result is not.
- **Brand detection is alias matching, not comprehension.** `OMP` and `SAP` are
  matched case-sensitively on word boundaries so they do not fire inside ordinary
  German and Dutch prose. `npm test` covers the traps.
- **Comparison / Alternatives is the thinnest layer** (29 of 300 prompts), which is
  also where the prompt set notes we are weakest. Expect noisier numbers there.

## Layout

```
data/prompts.csv          Source of truth for the prompt set. Opens in Excel.
scripts/gen-seed.mjs      Regenerates the seed SQL from that CSV.
migrations/               Schema, then generated prompt + brand seed.
src/index.ts              Worker entry: HTTP and the two cron triggers.
src/runner.ts             Opens sweeps, drains the task queue, writes results.
src/claude.ts             The Claude calls, incl. pause_turn resume and the judge.
src/brands.ts             Alias matching and first-appearance ranking.
src/metrics.ts            All aggregation SQL.
src/access.ts             Cloudflare Access JWT verification.
src/api.ts                JSON API and CSV export.
public/                   The dashboard. No build step, no CDN, no dependencies.
test/brands.test.ts       Brand detection tests.
```

## Changing the prompt set

Edit `data/prompts.csv`, then:

```bash
npm run seed:gen
npx wrangler d1 execute icron-visibility --remote --file=./migrations/0002_seed_prompts.sql
```

Prompt IDs are stable, so history survives as long as you do not renumber existing
rows. Add new prompts with fresh IDs rather than reusing old ones.

## Changing the tracked vendors

Vendors and their aliases live in the `brands` table, seeded from the `brands`
array in `scripts/gen-seed.mjs`. Add an entry, re-run `npm run seed:gen`, re-apply
the seed. Series colours are a fixed categorical order validated for
colour-vision deficiency; if you add a sixth vendor, re-run the palette check
rather than picking a colour by eye.

Adding a vendor only affects future sweeps. Past answers are stored in full, so
you can re-score history by re-running detection over the `results` table.

## Local development

```bash
npm install
npx wrangler d1 execute icron-visibility --local --file=./migrations/0001_init.sql
npx wrangler d1 execute icron-visibility --local --file=./migrations/0002_seed_prompts.sql
echo "ANTHROPIC_API_KEY=sk-ant-..." > .dev.vars
echo "ADMIN_TOKEN=local-dev-admin" >> .dev.vars
npm run dev          # http://localhost:8788
npm test             # brand detection
npm run typecheck
```

With `ACCESS_TEAM_DOMAIN` empty the auth check is bypassed, which is what you want
locally and never in production. See DEPLOY.md.

## Branding

The header renders the ICRON wordmark as text. Drop the real logo SVG (digital
variant, without the motto) into `public/` and replace the `<span class="wordmark">`
in `public/index.html`. The maze symbol must not appear without the wordmark.
