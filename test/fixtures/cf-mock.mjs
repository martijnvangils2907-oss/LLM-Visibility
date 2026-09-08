// Stands in for api.cloudflare.com so scripts/cf-setup.mjs can be exercised
// without an account. Reads the scenario from TMP/state.json and records every
// call to TMP/calls.json.
import { readFileSync, writeFileSync } from "node:fs";

const TMP = process.env.CF_TEST_TMP;
const state = JSON.parse(readFileSync(`${TMP}/state.json`, "utf8"));
const calls = [];
writeFileSync(`${TMP}/calls.json`, "[]");

const reply = (body, ok = true) => new Response(JSON.stringify(body), { status: ok ? 200 : 400 });

globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ method, path, body });
  writeFileSync(`${TMP}/calls.json`, JSON.stringify(calls));

  if (path.endsWith("/access/organizations") && method === "GET") {
    return state.org
      ? reply({ success: true, result: state.org })
      : reply({ success: false, errors: [{ code: 12130, message: "no organization" }] }, false);
  }
  if (path.endsWith("/access/organizations") && method === "POST") {
    if (state.failOrgCreate) {
      return reply({ success: false, errors: [{ code: 12130, message: "Zero Trust not subscribed" }] }, false);
    }
    return reply({ success: true, result: { auth_domain: body.auth_domain } });
  }
  if (/\/access\/apps\?/.test(path) && method === "GET") return reply({ success: true, result: state.apps });
  if (path.endsWith("/access/apps") && method === "POST") {
    return reply({ success: true, result: { id: "app-generated", aud: "aud-generated" } });
  }
  if (/\/policies$/.test(path) && method === "GET") {
    const id = path.match(/apps\/([^/]+)\/policies/)[1];
    return reply({ success: true, result: state.policies[id] ?? [] });
  }
  if (/\/policies$/.test(path) && method === "POST") return reply({ success: true, result: { id: "pol-new" } });
  if (/\/policies\/[^/]+$/.test(path) && method === "PUT") return reply({ success: true, result: { id: "p1" } });
  return reply({ success: false, errors: [{ code: 10000, message: `unmocked ${method} ${path}` }] }, false);
};
