// Cloudflare Worker — Web Push relay for MooTracker.
//
// POST /send
//   Headers: X-Auth: <SHARED_SECRET>
//   Body:    {"subscription": {...PushSubscription...},
//             "payload"?: {title, body, url, ...},
//             "tag"?: "stable-notification-tag",
//             "ttl"?: 60}
//
// When payload is provided + the subscription has both p256dh and auth keys,
// the body is AES-128-GCM encrypted per RFC 8291/8188 ("aes128gcm" content
// coding) so the service worker can read it from event.data on the device.
// When payload is null or keys are missing, sends an empty-body push and the
// service worker falls back to its local phrase pool.
//
// Secrets (set via `wrangler secret put`):
//   VAPID_PRIVATE_KEY   base64url-encoded P-256 scalar (32 bytes)
//   VAPID_PUBLIC_KEY    base64url-encoded uncompressed P-256 point (65 bytes)
//   VAPID_SUBJECT       "mailto:..." or "https://..." identifying contact
//   SHARED_SECRET       arbitrary long random string

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/debug" && request.method === "GET") {
      const pub = (env.VAPID_PUBLIC_KEY || "").trim();
      const priv = (env.VAPID_PRIVATE_KEY || "").trim();
      const sec = (env.SHARED_SECRET || "").trim();
      return new Response(JSON.stringify({
        publicKey: { length: pub.length, head: pub.slice(0, 6), tail: pub.slice(-6), invalidChars: /[^A-Za-z0-9_-]/.test(pub) },
        privateKey: { length: priv.length, head: priv.slice(0, 4), tail: priv.slice(-4), invalidChars: /[^A-Za-z0-9_-]/.test(priv) },
        sharedSecret: { length: sec.length },
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    if ((request.headers.get("X-Auth") || "").trim() !== (env.SHARED_SECRET || "").trim()) {
      return new Response("forbidden", { status: 403 });
    }

    let body;
    try { body = await request.json(); }
    catch { return new Response("bad json", { status: 400 }); }

    const sub = body.subscription;
    if (!sub || !sub.endpoint) return new Response("missing subscription", { status: 400 });

    try {
      let payload = body.payload ?? null;
      if (body.tag) {
        payload = (payload && typeof payload === "object")
          ? { ...payload, tag: String(body.tag) }
          : { tag: String(body.tag) };
      }
      const result = await sendPush(sub, payload, body.ttl ?? 60, env);
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

async function sendPush(subscription, payload, ttl, env) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await signVapidJwt(audience, env);

  const headers = {
    "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    "TTL": String(ttl),
  };

  let body = null;
  let encrypted = false;
  const hasKeys = payload && subscription.keys && subscription.keys.p256dh && subscription.keys.auth;
  if (hasKeys) {
    try {
      body = await encryptWebPushPayload(payload, subscription);
      headers["Content-Encoding"] = "aes128gcm";
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = String(body.byteLength);
      encrypted = true;
    } catch (err) {
      // Don't fail the push if encryption setup goes wrong; fall back to
      // empty-body so the SW at least fires its fallback phrase. Surface
      // the reason so we can debug.
      console.error("encryptWebPushPayload failed:", err && err.message);
    }
  }

  const resp = await fetch(subscription.endpoint, { method: "POST", headers, body });

  const text = await resp.text().catch(() => "");
  return { ok: resp.ok, status: resp.status, encrypted, body: text.slice(0, 500) };
}

/* ─── Web Push payload encryption (RFC 8291 + RFC 8188 aes128gcm) ─── */

async function encryptWebPushPayload(payload, subscription) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const uaPublic = b64uDecodeBytes(subscription.keys.p256dh);
  const auth = b64uDecodeBytes(subscription.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("subscription.keys.p256dh must be uncompressed P-256 (65 bytes, 0x04 prefix)");
  }
  if (auth.length < 16) {
    throw new Error("subscription.keys.auth must be at least 16 bytes");
  }

  // Ephemeral application-server keypair — fresh per push for forward secrecy.
  const asKeypair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeypair.publicKey));

  // ECDH(asPriv, uaPub) → 32-byte shared secret.
  const uaPublicKey = await crypto.subtle.importKey(
    "raw", uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey },
    asKeypair.privateKey,
    256
  ));

  // PRK_key = HKDF-SHA256(salt=auth, IKM=ecdhSecret,
  //                       info="WebPush: info\0" || ua_public || as_public, L=32)
  const keyInfo = concatBytes(
    new TextEncoder().encode("WebPush: info\0"),
    uaPublic,
    asPublicRaw,
  );
  const prkKey = await hkdfBytes(auth, ecdhSecret, keyInfo, 32);

  // Per-record salt (16 random bytes).
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK = HKDF(salt, prkKey, "Content-Encoding: aes128gcm\0", 16)
  const cek = await hkdfBytes(
    salt, prkKey,
    new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
    16
  );

  // Nonce = HKDF(salt, prkKey, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdfBytes(
    salt, prkKey,
    new TextEncoder().encode("Content-Encoding: nonce\0"),
    12
  );

  // Plaintext = payload || 0x02 (last-record padding delimiter, RFC 8188 §2.1).
  const plaintext = new Uint8Array(payloadBytes.length + 1);
  plaintext.set(payloadBytes);
  plaintext[payloadBytes.length] = 0x02;

  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cekKey,
    plaintext
  ));

  // Body header (RFC 8188 §2.1):
  //   salt(16) || record_size(4 BE) || key_id_len(1) || key_id(65) || ciphertext
  // record_size is the maximum record size; 4096 is conventional and well
  // above any payload we send.
  const body = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.length);
  let off = 0;
  body.set(salt, off); off += 16;
  new DataView(body.buffer).setUint32(off, 4096, false); off += 4;
  body[off++] = 65;
  body.set(asPublicRaw, off); off += 65;
  body.set(ciphertext, off);
  return body;
}

async function hkdfBytes(salt, ikm, info, length) {
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    ikmKey,
    length * 8
  ));
}

function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.byteLength || a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.byteLength || a.length; }
  return out;
}

async function signVapidJwt(audience, env) {
  const sub = (env.VAPID_SUBJECT || "").trim();
  if (!sub || !(sub.startsWith("mailto:") || sub.startsWith("https://"))) {
    throw new Error("VAPID_SUBJECT secret must be set to a 'mailto:...' or 'https://...' value");
  }
  const header = b64uJson({ typ: "JWT", alg: "ES256" });
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600; // 12 h validity
  const payload = b64uJson({ aud: audience, exp, sub });
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
  const privClean = (privBase64Url || "").trim().replace(/^["']|["']$/g, "");
  const pubClean  = (pubBase64Url  || "").trim().replace(/^["']|["']$/g, "");
  if (!privClean) throw new Error("VAPID_PRIVATE_KEY env var is empty or missing");
  if (!pubClean)  throw new Error("VAPID_PUBLIC_KEY env var is empty or missing");
  const priv = b64uDecodeBytes(privClean);
  const pub = b64uDecodeBytes(pubClean);
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
