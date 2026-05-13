// Cloudflare Worker — Web Push relay for MooTracker.
//
// POST /send
//   Headers: X-Auth: <SHARED_SECRET>
//   Body:    {"subscription": {...PushSubscription...}, "ttl"?: 60}
//
// Sends an empty-payload Web Push to the subscription. The service worker
// on the device shows the notification text from its own local data, so we
// don't need to encrypt a payload here.
//
// Secrets (set via `wrangler secret put`):
//   VAPID_PRIVATE_KEY   base64url-encoded P-256 scalar (32 bytes)
//   VAPID_PUBLIC_KEY    base64url-encoded uncompressed P-256 point (65 bytes)
//   SHARED_SECRET       arbitrary long random string

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    if (request.headers.get("X-Auth") !== env.SHARED_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    let body;
    try { body = await request.json(); }
    catch { return new Response("bad json", { status: 400 }); }

    const sub = body.subscription;
    if (!sub || !sub.endpoint) return new Response("missing subscription", { status: 400 });

    try {
      const result = await sendPush(sub, body.ttl ?? 60, env);
      return cors(new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      }));
    } catch (err) {
      return cors(new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }));
    }
  },
};

function cors(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Auth");
  return resp;
}

async function sendPush(subscription, ttl, env) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await signVapidJwt(audience, env);

  const resp = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "TTL": String(ttl),
    },
  });

  const text = await resp.text().catch(() => "");
  return { ok: resp.ok, status: resp.status, body: text.slice(0, 500) };
}

async function signVapidJwt(audience, env) {
  const header = b64uJson({ typ: "JWT", alg: "ES256" });
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600; // 12 h validity
  const payload = b64uJson({ aud: audience, exp, sub: "mailto:noreply@mootracker.local" });
  const signingInput = `${header}.${payload}`;

  const key = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64u(new Uint8Array(sig))}`;
}

async function importVapidPrivateKey(privBase64Url, pubBase64Url) {
  const priv = b64uDecodeBytes(privBase64Url);
  const pub = b64uDecodeBytes(pubBase64Url);
  if (pub[0] !== 0x04 || pub.length !== 65) throw new Error("VAPID public key must be uncompressed P-256 (65 bytes, leading 0x04)");
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);

  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: b64u(priv),
      x: b64u(x),
      y: b64u(y),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64uJson(obj) {
  return b64u(new TextEncoder().encode(JSON.stringify(obj)));
}

function b64uDecodeBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}
