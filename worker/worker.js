export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const ALLOWED_ORIGIN = "https://report.fitgroup.com.vn";

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (origin !== ALLOWED_ORIGIN) return new Response("Forbidden", { status: 403, headers: corsHeaders });

    if (url.pathname === "/nonce" && request.method === "GET") return handleNonce(env, corsHeaders);
    if (url.pathname === "/change-password" && request.method === "POST") return handleChangePassword(request, env, corsHeaders);

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

const NONCE_TTL_MS = 5 * 60 * 1000;
const VALID_PERSONS = ["chairman", "ceo", "cfo"];
const GITHUB_OWNER = "it-fg";
const GITHUB_REPO = "Automation";

function bytesToHex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSha256(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
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

async function handleChangePassword(request, env, headers) {
  let body;
  try { body = await request.json(); } catch { return new Response("Bad request", { status: 400, headers }); }

  const { person, token, proof, salt, iv, wrappedDek } = body || {};
  if (!VALID_PERSONS.includes(person)) return new Response("Invalid person", { status: 400, headers });
  if (!token || !proof || !salt || !iv || !wrappedDek) return new Response("Missing fields", { status: 400, headers });

  const nonceHex = await verifyToken(env, token);
  if (!nonceHex) return new Response("Invalid or expired token", { status: 401, headers });

  const dek = b64ToBytes(env.DEK_B64);
  const expectedProof = await hmacSha256(dek, new TextEncoder().encode(nonceHex));
  if (bytesToHex(expectedProof) !== proof) return new Response("Proof mismatch - old password incorrect", { status: 401, headers });

  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/auth.json`;
  const ghHeaders = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "fg-dashboard-worker", Accept: "application/vnd.github+json" };

  const getResp = await fetch(apiBase, { headers: ghHeaders });
  if (!getResp.ok) return new Response("Cannot read auth.json from GitHub", { status: 502, headers });
  const getJson = await getResp.json();
  const currentContent = JSON.parse(atob(getJson.content.replace(/\n/g, "")));

  currentContent.users[person] = { salt, iv, wrappedDek };

  const putResp = await fetch(apiBase, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Doi mat khau: ${person}`, content: btoa(JSON.stringify(currentContent, null, 2)), sha: getJson.sha }),
  });

  if (!putResp.ok) return new Response(`GitHub update failed: ${await putResp.text()}`, { status: 502, headers });
  return new Response(JSON.stringify({ ok: true }), { headers: { ...headers, "Content-Type": "application/json" } });
}
