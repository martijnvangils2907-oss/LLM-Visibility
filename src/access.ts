import type { Env } from "./types";

/**
 * Verify a Cloudflare Access JWT.
 *
 * Access protects the route, but a Worker is also reachable at its
 * *.workers.dev hostname, which Access never sees. `workers_dev = false` in
 * wrangler.toml closes that door; this check is the second lock, so a
 * misconfigured route cannot quietly publish the dashboard.
 */

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let cachedKeys: { keys: Jwk[]; fetchedAt: number } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKeys(teamDomain: string): Promise<Jwk[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_TTL_MS) return cachedKeys.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs unavailable (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  cachedKeys = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

export interface AccessIdentity {
  email: string;
  sub: string;
}

export async function verifyAccess(req: Request, env: Env): Promise<AccessIdentity | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!teamDomain || !aud) return { email: "access-disabled", sub: "" };

  const token =
    req.headers.get("Cf-Access-Jwt-Assertion") ??
    /CF_Authorization=([^;]+)/.exec(req.headers.get("Cookie") ?? "")?.[1];
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; exp?: number; iss?: string; email?: string; sub?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const keys = await getKeys(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) return null;

  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(aud)) return null;
  if (payload.iss !== `https://${teamDomain}`) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;

  return { email: payload.email ?? "unknown", sub: payload.sub ?? "" };
}

/** Admin actions (starting a sweep, editing brands) need a shared secret on top. */
export function isAdmin(req: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const given =
    req.headers.get("X-Admin-Token") ??
    new URL(req.url).searchParams.get("token") ??
    "";
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
