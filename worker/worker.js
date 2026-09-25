export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const ALLOWED_ORIGIN = "https://report.fitgroup.com.vn";
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Audit-Key",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // /audit-log is called server-to-server (e.g. from it-pc01), not from the browser,
    // so it has no matching Origin header - it is protected by its own secret key instead.
    if (url.pathname === "/audit-log" && request.method === "GET") {
      const allowed = await checkRateLimit(env, env.RATE_LIMITER_10, `auditlog:${ip}`);
      if (!allowed) return new Response("Too many requests", { status: 429, headers: corsHeaders });
      return handleAuditLog(request, env, corsHeaders);
    }

    if (origin !== ALLOWED_ORIGIN) return new Response("Forbidden", { status: 403, headers: corsHeaders });

    if (url.pathname === "/nonce" && request.method === "GET") {
      const allowed = await checkRateLimit(env, env.RATE_LIMITER_20, `nonce:${ip}`);
      if (!allowed) return new Response("Too many requests", { status: 429, headers: corsHeaders });
      return handleNonce(env, corsHeaders);
    }
    if (url.pathname === "/change-password" && request.method === "POST") {
      const allowed = await checkRateLimit(env, env.RATE_LIMITER_10, `changepw:${ip}`);
      if (!allowed) return new Response("Too many requests", { status: 429, headers: corsHeaders });
      return handleChangePassword(request, env, corsHeaders);
    }
    if (url.pathname === "/log-login" && request.method === "POST") {
      const allowed = await checkRateLimit(env, env.RATE_LIMITER_20, `loglogin:${ip}`);
      if (!allowed) return new Response("Too many requests", { status: 429, headers: corsHeaders });
      return handleLogLogin(request, env, corsHeaders);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

const NONCE_TTL_MS = 5 * 60 * 1000;
const VALID_PERSONS = ["chairman", "ceo", "cfo"];
const VALID_LOGIN_EVENTS = ["login_success", "login_failed"];
const GITHUB_OWNER = "it-fg";
const GITHUB_REPO = "Automation";

function bytesToHex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function nowIso() { return new Date().toISOString(); }
function padTs(ms) { return String(ms).padStart(14, "0"); }

async function hmacSha256(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}

// Rate-limit check using Cloudflare's native Rate Limiting binding (no KV writes involved,
// so it does not eat into the Workers KV free-tier write quota). Fails OPEN (allows the
// request) if the binding isn't configured yet, or if the rate-limiter API itself errors -
// a rate-limiting outage must never take the real dashboard down.
async function checkRateLimit(env, limiter, key) {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (e) {
    return true;
  }
}

// Best-effort audit log write. Never throws - a logging failure must not break login/password-change.
async function writeAuditEntry(env, entry) {
  if (!env.AUDIT_LOG_KV) return;
  try {
    const key = `log:${padTs(Date.now())}:${crypto.randomUUID()}`;
    await env.AUDIT_LOG_KV.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 400 });
  } catch (e) {
    // swallow - logging is not allowed to break the auth flow
  }
}

async function handleNonce(env, headers) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const timestamp = Date.now();
  const payload = `${bytesToHex(nonceBytes)}.${timestamp}`;
  const sig = await hmacSha256(new TextEncoder().encode(env.SIGNING_SECRET), new TextEncoder().encode(payload));
  const token = `${payload}.${bytesToHex(sig)}`;
  return new Response(JSON.stringify({ token }), { headers: { ...headers, "Content-Type": "application/json" } });
}

async function verifyToken(env, token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [nonceHex, timestampStr, sigHex] = parts;
  const payload = `${nonceHex}.${timestampStr}`;
  const expected = await hmacSha256(new TextEncoder().encode(env.SIGNING_SECRET), new TextEncoder().encode(payload));
  if (bytesToHex(expected) !== sigHex) return null;
  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > NONCE_TTL_MS) return null;
  return nonceHex;
}

async function handleLogLogin(request, env, headers) {
  let body;
  try { body = await request.json(); } catch { return new Response("Bad request", { status: 400, headers }); }
  const { person, event } = body || {};
  if (!VALID_PERSONS.includes(person)) return new Response("Invalid person", { status: 400, headers });
  if (!VALID_LOGIN_EVENTS.includes(event)) return new Response("Invalid event", { status: 400, headers });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  await writeAuditEntry(env, { ts: nowIso(), person, event, ip, source: "client-reported" });
  return new Response(JSON.stringify({ ok: true }), { headers: { ...headers, "Content-Type": "application/json" } });
}

async function handleAuditLog(request, env, headers) {
  const key = request.headers.get("X-Audit-Key") || "";
  if (!env.AUDIT_READ_KEY || key !== env.AUDIT_READ_KEY) {
    return new Response("Unauthorized", { status: 401, headers });
  }
  if (!env.AUDIT_LOG_KV) {
    return new Response(JSON.stringify({ entries: [], cursor: null, list_complete: true }), { headers: { ...headers, "Content-Type": "application/json" } });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "500", 10) || 500, 1000);
  const cursorParam = url.searchParams.get("cursor") || undefined;

  const listResult = await env.AUDIT_LOG_KV.list({ prefix: "log:", limit, cursor: cursorParam });
  const entries = [];
  for (const k of listResult.keys) {
    const v = await env.AUDIT_LOG_KV.get(k.name);
    if (v) { try { entries.push(JSON.parse(v)); } catch (e) {} }
  }
  return new Response(JSON.stringify({
    entries,
    cursor: listResult.list_complete ? null : listResult.cursor,
    list_complete: listResult.list_complete,
  }), { headers: { ...headers, "Content-Type": "application/json" } });
}

async function handleChangePassword(request, env, headers) {
  let body;
  try { body = await request.json(); } catch { return new Response("Bad request", { status: 400, headers }); }

  const { person, token, proof, salt, iv, wrappedDek } = body || {};
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  if (!VALID_PERSONS.includes(person)) return new Response("Invalid person", { status: 400, headers });
  if (!token || !proof || !salt || !iv || !wrappedDek) return new Response("Missing fields", { status: 400, headers });

  const nonceHex = await verifyToken(env, token);
  if (!nonceHex) {
    await writeAuditEntry(env, { ts: nowIso(), person, event: "password_change_failed", detail: "invalid_or_expired_token", ip, source: "server-verified" });
    return new Response("Invalid or expired token", { status: 401, headers });
  }

  const dek = b64ToBytes(env.DEK_B64);
  const expectedProof = await hmacSha256(dek, new TextEncoder().encode(nonceHex));
  if (bytesToHex(expectedProof) !== proof) {
    await writeAuditEntry(env, { ts: nowIso(), person, event: "password_change_failed", detail: "wrong_old_password", ip, source: "server-verified" });
    return new Response("Proof mismatch - old password incorrect", { status: 401, headers });
  }

  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/auth.json`;
  const ghHeaders = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "fg-dashboard-worker", Accept: "application/vnd.github+json" };

  const getResp = await fetch(apiBase, { headers: ghHeaders });
  if (!getResp.ok) {
    await writeAuditEntry(env, { ts: nowIso(), person, event: "password_change_failed", detail: "github_read_error", ip, source: "server-verified" });
    return new Response("Cannot read auth.json from GitHub", { status: 502, headers });
  }
  const getJson = await getResp.json();
  const currentContent = JSON.parse(atob(getJson.content.replace(/\n/g, "")));

  currentContent.users[person] = { salt, iv, wrappedDek };

  const putResp = await fetch(apiBase, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Doi mat khau: ${person}`, content: btoa(JSON.stringify(currentContent, null, 2)), sha: getJson.sha }),
  });

  if (!putResp.ok) {
    await writeAuditEntry(env, { ts: nowIso(), person, event: "password_change_failed", detail: "github_write_error", ip, source: "server-verified" });
    return new Response(`GitHub update failed: ${await putResp.text()}`, { status: 502, headers });
  }

  await writeAuditEntry(env, { ts: nowIso(), person, event: "password_change_success", ip, source: "server-verified" });
  return new Response(JSON.stringify({ ok: true }), { headers: { ...headers, "Content-Type": "application/json" } });
}
