// Exercises scripts/cf-setup.mjs against the fake API in fixtures/cf-mock.mjs.
// Covers the green-field path, a re-run (which must change nothing), and the
// three failure modes worth a clear message.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "scripts", "cf-setup.mjs");
const MOCK = join(here, "fixtures", "cf-mock.mjs");
const TMP = mkdtempSync(join(tmpdir(), "cf-test-"));
const ENVFILE = join(TMP, "gh_env");


function run(name, { state, env = {} }) {
  return new Promise((resolve) => {
    writeFileSync(join(TMP, "state.json"), JSON.stringify(state));
    if (existsSync(ENVFILE)) unlinkSync(ENVFILE);
    const p = spawn(process.execPath, ["--import", MOCK, SCRIPT], {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct",
        APP_HOSTNAME: "llmvisibilityicron.uk",
        ACCESS_TEAM_NAME: "icron", ACCESS_EMAIL_DOMAIN: "icrontech.com",
        GITHUB_ENV: ENVFILE,
        CF_TEST_TMP: TMP,
        ...env,
      },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const envOut = existsSync(ENVFILE) ? readFileSync(ENVFILE, "utf8") : "";
      resolve({ name, code, out, envOut, calls: JSON.parse(readFileSync(join(TMP, "calls.json"), "utf8")) });
    });
  });
}

let failed = 0;
const expect = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
};

// 1. Green field: no org, no app.
let r = await run("greenfield", { state: { org: null, apps: [], policies: {} } });
console.log("Green field (nothing exists yet)");
expect("exits 0", r.code === 0, r.out.slice(-500));
expect("creates the Zero Trust org", r.calls.some((c) => c.method === "POST" && c.path.endsWith("/access/organizations")));
expect("creates the Access app", r.calls.some((c) => c.method === "POST" && c.path.endsWith("/access/apps")));
expect("creates a policy", r.calls.some((c) => c.method === "POST" && /\/policies$/.test(c.path)));
expect("policy allows the email domain",
  r.calls.some((c) => JSON.stringify(c.body ?? {}).includes('"domain":"icrontech.com"')));
expect("exports the AUD to GITHUB_ENV", r.envOut.includes("RESOLVED_AUD=aud-generated"), r.envOut);
expect("exports the team domain", r.envOut.includes("RESOLVED_TEAM_DOMAIN=icron.cloudflareaccess.com"), r.envOut);

// 2. Re-run against the state the first run produced.
console.log("\nSecond run (everything already exists)");
r = await run("idempotent", { state: {
  org: { auth_domain: "icron.cloudflareaccess.com" },
  apps: [{ id: "app1", domain: "llmvisibilityicron.uk", aud: "aud-existing" }],
  policies: { app1: [{ id: "p1", name: "Allowed viewers", precedence: 1 }] },
} });
expect("exits 0", r.code === 0, r.out.slice(-500));
expect("creates nothing new", !r.calls.some((c) => c.method === "POST"), JSON.stringify(r.calls.filter((c) => c.method === "POST")));
expect("updates the existing policy in place", r.calls.some((c) => c.method === "PUT" && /\/policies\/p1$/.test(c.path)));
expect("reuses the existing AUD", r.envOut.includes("RESOLVED_AUD=aud-existing"), r.envOut);

// 3. Refuse to build an app nobody can reach.
console.log("\nNo allow rule configured");
r = await run("no-policy", {
  state: { org: { auth_domain: "icron.cloudflareaccess.com" }, apps: [], policies: {} },
  env: { ACCESS_EMAIL_DOMAIN: "", ACCESS_EMAILS: "" },
});
expect("exits non-zero", r.code !== 0);
expect("says why rather than locking everyone out", /no allow rule|lock everyone out/i.test(r.out), r.out.slice(-300));

// 4. Zero Trust not subscribed -> actionable message.
console.log("\nZero Trust not enabled on the account");
r = await run("zt-missing", { state: { org: null, apps: [], policies: {}, failOrgCreate: true } });
expect("exits non-zero", r.code !== 0);
expect("points at the dashboard fix", /Free plan/.test(r.out), r.out.slice(-400));

// 5. Missing hostname.
console.log("\nHostname not configured");
r = await run("no-host", { state: { org: null, apps: [], policies: {} }, env: { APP_HOSTNAME: "" } });
expect("exits non-zero with a named variable", r.code !== 0 && /APP_HOSTNAME/.test(r.out));

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
