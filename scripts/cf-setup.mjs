/**
 * Idempotent Cloudflare setup, run from CI where api.cloudflare.com is reachable.
 *
 * Ensures the Zero Trust organisation, the Access application guarding the
 * dashboard hostname, and an allow policy for the people who should see it.
 * Prints the application's AUD tag so the deploy can bake it into the Worker,
 * which means nobody has to copy that tag between two dashboards by hand.
 *
 * Every step reads before it writes, so re-running changes nothing.
 */

const API = "https://api.cloudflare.com/client/v4";

const token = req("CLOUDFLARE_API_TOKEN");
const accountId = req("CLOUDFLARE_ACCOUNT_ID");
const hostname = req("APP_HOSTNAME");
const teamName = (process.env.ACCESS_TEAM_NAME || "").trim();
const emailDomain = (process.env.ACCESS_EMAIL_DOMAIN || "").trim();
const extraEmails = (process.env.ACCESS_EMAILS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const appName = process.env.ACCESS_APP_NAME || "ICRON LLM Visibility";
const sessionDuration = process.env.ACCESS_SESSION_DURATION || "24h";

function req(name) {
  const v = (process.env[name] || "").trim();
  if (!v) fail(`${name} is not set.`);
  return v;
}

function fail(message, detail) {
  console.error(`\n::error::${message}`);
  if (detail) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let json;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    fail(`Cloudflare returned a non-JSON response for ${method} ${path} (HTTP ${res.status}).`, text.slice(0, 800));
  }
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

/** Cloudflare error codes we want to explain rather than dump. */
const HINTS = {
  10000: "The API token is missing a permission for this call, or the account id is wrong.",
  9109: "The API token cannot see this account. Check Account Resources on the token.",
  12130: "Zero Trust is not enabled on this account yet, and could not be enabled from the API.",
};

function explain(json) {
  const errors = json?.errors ?? [];
  const lines = errors.map((e) => `  [${e.code}] ${e.message}${HINTS[e.code] ? `\n      -> ${HINTS[e.code]}` : ""}`);
  return lines.length ? lines.join("\n") : JSON.stringify(json, null, 2).slice(0, 800);
}

/* ------------------------------------------------- Zero Trust organisation */

async function ensureOrganisation() {
  const existing = await cf("GET", `/accounts/${accountId}/access/organizations`);
  const authDomain = existing.json?.result?.auth_domain;
  if (existing.ok && authDomain) {
    console.log(`Zero Trust organisation already exists: ${authDomain}`);
    return authDomain;
  }

  if (!teamName) {
    fail(
      "No Zero Trust organisation on this account, and ACCESS_TEAM_NAME is not set.\n" +
      "Set the repository variable ACCESS_TEAM_NAME to the team name you want.\n" +
      "It becomes <name>.cloudflareaccess.com and CANNOT be renamed later.",
    );
  }

  const slug = teamName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  console.log(`No Zero Trust organisation found. Creating "${slug}".`);
  const created = await cf("POST", `/accounts/${accountId}/access/organizations`, {
    name: teamName,
    auth_domain: `${slug}.cloudflareaccess.com`,
  });
  if (!created.ok) {
    fail(
      "Could not create the Zero Trust organisation.\n" +
      "If this reports that Zero Trust is not subscribed, open the Cloudflare dashboard,\n" +
      "click Zero Trust once and pick the Free plan, then re-run this workflow.",
      explain(created.json),
    );
  }
  const domain = created.json.result.auth_domain;
  console.log(`Created Zero Trust organisation: ${domain}`);
  return domain;
}

/* ------------------------------------------------------ Access application */

async function ensureApplication() {
  const list = await cf("GET", `/accounts/${accountId}/access/apps?per_page=200`);
  if (!list.ok) fail("Could not list Access applications.", explain(list.json));

  const match = (list.json.result ?? []).find(
    (a) => a.domain === hostname || a.domain === `${hostname}/`,
  );

  if (match) {
    console.log(`Access application already guards ${hostname} (id ${match.id}).`);
    return { id: match.id, aud: match.aud };
  }

  console.log(`Creating Access application for ${hostname}.`);
  const created = await cf("POST", `/accounts/${accountId}/access/apps`, {
    name: appName,
    domain: hostname,
    type: "self_hosted",
    session_duration: sessionDuration,
    app_launcher_visible: true,
  });
  if (!created.ok) fail("Could not create the Access application.", explain(created.json));

  const { id, aud } = created.json.result;
  console.log(`Created Access application ${id}.`);
  return { id, aud };
}

/* ------------------------------------------------------------------ policy */

function buildInclude() {
  const include = [];
  if (emailDomain) include.push({ email_domain: { domain: emailDomain.replace(/^@/, "") } });
  for (const email of extraEmails) include.push({ email: { email } });
  return include;
}

async function ensurePolicy(appId) {
  const include = buildInclude();
  if (!include.length) {
    fail(
      "No Access policy could be built: set ACCESS_EMAIL_DOMAIN (e.g. icrontech.com)\n" +
      "and/or ACCESS_EMAILS (a comma separated list of addresses).\n" +
      "Refusing to create an application with no allow rule, which would lock everyone out.",
    );
  }

  const existing = await cf("GET", `/accounts/${accountId}/access/apps/${appId}/policies`);
  if (!existing.ok) fail("Could not list Access policies.", explain(existing.json));

  const policy = {
    name: "Allowed viewers",
    decision: "allow",
    include,
  };

  const current = (existing.json.result ?? []).find((p) => p.name === policy.name);
  if (current) {
    const updated = await cf(
      "PUT",
      `/accounts/${accountId}/access/apps/${appId}/policies/${current.id}`,
      { ...policy, precedence: current.precedence ?? 1 },
    );
    if (!updated.ok) fail("Could not update the Access policy.", explain(updated.json));
    console.log(`Updated policy "${policy.name}" (${include.length} include rule(s)).`);
    return;
  }

  const created = await cf("POST", `/accounts/${accountId}/access/apps/${appId}/policies`, {
    ...policy,
    precedence: 1,
  });
  if (!created.ok) fail("Could not create the Access policy.", explain(created.json));
  console.log(`Created policy "${policy.name}" (${include.length} include rule(s)).`);
}

/* -------------------------------------------------------------------- main */

const authDomain = await ensureOrganisation();
const app = await ensureApplication();
await ensurePolicy(app.id);

if (!app.aud) fail("The Access application has no AUD tag, so the Worker cannot verify tokens.");

console.log(`\nHostname     ${hostname}`);
console.log(`Team domain  ${authDomain}`);
console.log(`AUD tag      ${app.aud.slice(0, 8)}...`);

if (process.env.GITHUB_ENV) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_ENV, `RESOLVED_TEAM_DOMAIN=${authDomain}\nRESOLVED_AUD=${app.aud}\n`);
}
