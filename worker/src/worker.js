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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/sync" && request.method === "GET") {
      try {
        const mood = {};
        const { results: moodRows = [] } = await env.DB.prepare(
          "SELECT * FROM mood_entries"
        ).all();

        for (const row of moodRows) {
          const moods = parseJsonArray(row.moods);
          mood[row.date] = {
            mood: moods[0] || null,
            mood2: moods[1] || null,
            sleep: row.sleep,
            irritability: row.irritability,
            anxiety: row.anxiety,
            notes: row.notes,
            weight: row.weight,
            meds: {},
          };
        }

        const { results: doseRows = [] } = await env.DB.prepare(
          "SELECT date, med_key, count FROM daily_med_doses"
        ).all();
        for (const row of doseRows) {
          if (!mood[row.date]) continue;
          mood[row.date].meds[row.med_key] = { ct: row.count };
        }

        const srm = {};
        const { results: srmRows = [] } = await env.DB.prepare(
          "SELECT * FROM srm_items ORDER BY date"
        ).all();
        for (const row of srmRows) {
          if (!srm[row.date]) srm[row.date] = { items: [] };
          srm[row.date].items.push({
            id: row.id,
            time: row.time,
            am: Boolean(row.am),
            didNot: Boolean(row.did_not),
            withOthers: Boolean(row.with_others),
            who: parseJsonArray(row.who),
            whoText: row.who_text || "",
            engagement: row.engagement,
          });
        }

        const settingsRow = await env.DB.prepare(
          "SELECT value FROM settings WHERE key = 'settings'"
        ).first();
        const settings = settingsRow ? parseJsonValue(settingsRow.value, null) : null;

        const { results: medRows = [] } = await env.DB.prepare(
          "SELECT key, name, dose, default_ct FROM medications WHERE status = 'active' ORDER BY sort_order"
        ).all();
        const meds = medRows.length
          ? medRows.map((row) => ({ key: row.key, name: row.name, dose: row.dose, defaultCt: row.default_ct ?? 0 }))
          : null;
        const { results: medsAll = [] } = await env.DB.prepare(
          "SELECT key, name, brand, display_pref, dose, default_ct, status, archived_at FROM medications ORDER BY sort_order"
        ).all();
        const { results: medEvents = [] } = await env.DB.prepare(
          "SELECT * FROM med_events ORDER BY date DESC, ts DESC"
        ).all();

        return cors(jsonResponse({ status: "ok", mood, srm, settings, meds, medsAll, medEvents }));
      } catch (err) {
        return cors(jsonResponse({ status: "error", message: String(err) }, 500));
      }
    }

    if (url.pathname === "/write" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return cors(jsonResponse({ ok: false, error: "bad json" }, 400)); }

      const type = body.type;
      if (!type) return cors(jsonResponse({ ok: false, error: "missing type" }, 400));

      try {
        const now = new Date().toISOString();

        if (type === "mood") {
          const date = body.date;
          const entry = body.entry || {};
          const medsRef = body.meds_ref || [];
          await writeToD1(env, { mood: { [date]: entry }, meds: medsRef });
          await env.DB.prepare("INSERT INTO log_activity (ts, entry_date, actor, type) VALUES (?, ?, ?, ?)").bind(now, date, body.actor || "Wei", "mood").run();

        } else if (type === "srm") {
          const date = body.date;
          await writeToD1(env, { srm: { [date]: { items: body.items || [] } } });
          await env.DB.prepare("INSERT INTO log_activity (ts, entry_date, actor, type) VALUES (?, ?, ?, ?)").bind(now, date, body.actor || "Wei", "srm").run();

        } else if (type === "delete_mood") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM mood_entries WHERE date = ?").bind(body.date),
            env.DB.prepare("DELETE FROM daily_med_doses WHERE date = ?").bind(body.date),
          ]);
          await env.DB.prepare("INSERT INTO log_activity (ts, entry_date, actor, type) VALUES (?, ?, ?, ?)").bind(now, body.date, body.actor || "Wei", "delete_mood").run();

        } else if (type === "delete_srm") {
          await env.DB.prepare("DELETE FROM srm_items WHERE date = ?").bind(body.date).run();
          await env.DB.prepare("INSERT INTO log_activity (ts, entry_date, actor, type) VALUES (?, ?, ?, ?)").bind(now, body.date, body.actor || "Wei", "delete_srm").run();

        } else if (type === "settings") {
          await writeToD1(env, { settings: body.settings, meds: body.meds });
          await reconcileActiveMedications(env, body.meds, now);

        } else if (type === "med_create") {
          await createMedication(env, body, now);

        } else if (type === "med_event") {
          await recordMedicationEvent(env, body, now);

        } else if (type === "med_event_delete") {
          await deleteMedicationEvent(env, body);

        } else if (type === "med_event_update") {
          await updateMedicationEvent(env, body);

        } else if (type === "med_update_meta") {
          await updateMedicationMeta(env, body);

        } else if (type === "push_subscribe" || type === "push_unsubscribe" || type === "update_push_role" || type === "update_push_tz") {
          // Push subscription management — forward to Apps Script only.
          // Push scheduling reads from the Sheet until Phase 4.

        } else {
          return cors(jsonResponse({ ok: false, error: "unknown type" }, 400));
        }

        // Async Sheet sync — fire-and-forget
        ctx.waitUntil(syncToSheet(body, env));

        return cors(jsonResponse({ ok: true }));
      } catch (err) {
        return cors(jsonResponse({ ok: false, error: String(err) }, 500));
      }
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      if (!checkAuth(request, env)) {
        return cors(new Response("forbidden", { status: 403 }));
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return cors(jsonResponse({ ok: false, error: "bad json" }, 400));
      }

      try {
        const counts = await writeToD1(env, body);
        return cors(jsonResponse({ ok: true, counts }));
      } catch (err) {
        return cors(jsonResponse({ ok: false, error: String(err) }, 500));
      }
    }

    if (url.pathname === "/delete" && request.method === "POST") {
      if (!checkAuth(request, env)) {
        return cors(new Response("forbidden", { status: 403 }));
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return cors(jsonResponse({ ok: false, error: "bad json" }, 400));
      }

      try {
        if (body.type === "mood" && body.date) {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM mood_entries WHERE date = ?").bind(body.date),
            env.DB.prepare("DELETE FROM daily_med_doses WHERE date = ?").bind(body.date),
          ]);
        } else if (body.type === "srm" && body.date) {
          await env.DB.prepare("DELETE FROM srm_items WHERE date = ?").bind(body.date).run();
        }
        return cors(jsonResponse({ ok: true }));
      } catch (err) {
        return cors(jsonResponse({ ok: false, error: String(err) }, 500));
      }
    }

    if (url.pathname === "/seed-med-history" && request.method === "POST") {
      if (!checkAuth(request, env)) {
        return cors(new Response("forbidden", { status: 403 }));
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return cors(jsonResponse({ ok: false, error: "bad json" }, 400));
      }

      try {
        const mode = optionalString(body.mode) || "dry";
        if (mode !== "dry" && mode !== "commit") {
          return cors(jsonResponse({ ok: false, error: "invalid mode" }, 400));
        }
        const result = await seedMedicationHistory(env, mode);
        return cors(jsonResponse(result));
      } catch (err) {
        return cors(jsonResponse({ ok: false, error: String(err) }, 500));
      }
    }

    if (url.pathname === "/dev-notes") {
      if (request.method === "GET") {
        try {
          const { results } = await env.DB.prepare(
            "SELECT id, text, ts FROM dev_notes ORDER BY ts DESC"
          ).all();
          return cors(jsonResponse({ ok: true, notes: results || [] }));
        } catch (err) {
          return cors(jsonResponse({ ok: false, error: String(err) }, 500));
        }
      }

      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return cors(jsonResponse({ ok: false, error: "bad json" }, 400));
        }

        const id = typeof body.id === "string" ? body.id.trim() : "";
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const ts = typeof body.ts === "string" ? body.ts.trim() : "";
        if (!id || !text || !ts) {
          return cors(jsonResponse({ ok: false, error: "missing fields" }, 400));
        }

        try {
          await env.DB.prepare(
            "INSERT INTO dev_notes (id, text, ts) VALUES (?, ?, ?)"
          ).bind(id, text, ts).run();
          return cors(jsonResponse({ ok: true, id }));
        } catch (err) {
          return cors(jsonResponse({ ok: false, error: String(err) }, 500));
        }
      }

      if (request.method === "DELETE") {
        const id = (url.searchParams.get("id") || "").trim();
        if (!id) return cors(jsonResponse({ ok: false, error: "missing id" }, 400));

        try {
          await env.DB.prepare("DELETE FROM dev_notes WHERE id = ?").bind(id).run();
          return cors(jsonResponse({ ok: true }));
        } catch (err) {
          return cors(jsonResponse({ ok: false, error: String(err) }, 500));
        }
      }
    }

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

    if (!checkAuth(request, env)) {
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
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Auth");
  return resp;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function checkAuth(request, env) {
  return (request.headers.get("X-Auth") || "").trim() === (env.SHARED_SECRET || "").trim();
}

async function writeToD1(env, body) {
  const now = new Date().toISOString();
  const statements = [];
  let moodCount = 0;
  let srmCount = 0;
  let medsCount = 0;

  for (const [date, entry] of Object.entries(body.mood || {})) {
    moodCount += 1;
    statements.push(env.DB.prepare("DELETE FROM daily_med_doses WHERE date = ?").bind(date));
    const moods = Array.isArray(entry.moods) && entry.moods.length
      ? entry.moods.filter(Boolean)
      : [entry.mood, entry.mood2].filter(Boolean);
    statements.push(env.DB.prepare(
      "INSERT OR REPLACE INTO mood_entries (date, day, moods, sleep, irritability, anxiety, notes, weight, actor, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Wei', ?)"
    ).bind(
      date, dayName(date), JSON.stringify(moods),
      nullableNumber(entry.sleep), nullableInteger(entry.irritability), nullableInteger(entry.anxiety),
      entry.notes ?? null, nullableNumber(entry.weight), now,
    ));

    for (const [medKey, med] of Object.entries(entry.meds || {})) {
      const count = Number(med && med.ct);
      if (count > 0) {
        statements.push(env.DB.prepare("INSERT OR REPLACE INTO daily_med_doses (date, med_key, count) VALUES (?, ?, ?)").bind(date, medKey, count));
      }
    }
  }

  for (const [date, day] of Object.entries(body.srm || {})) {
    statements.push(env.DB.prepare("DELETE FROM srm_items WHERE date = ?").bind(date));
    for (const item of day.items || []) {
      srmCount += 1;
      statements.push(env.DB.prepare(
        "INSERT OR REPLACE INTO srm_items (id, date, time, am, did_not, with_others, who, who_text, engagement, actor, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Wei', ?)"
      ).bind(
        item.id ?? crypto.randomUUID(), date, item.time ?? null,
        item.am ? 1 : 0, item.didNot ? 1 : 0, item.withOthers ? 1 : 0,
        JSON.stringify(Array.isArray(item.who) ? item.who : []), item.whoText ?? "",
        nullableInteger(item.engagement) ?? 0, now,
      ));
    }
  }

  if (body.settings !== null && body.settings !== undefined) {
    statements.push(env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)").bind(JSON.stringify(body.settings)));
  }

  if (Array.isArray(body.meds) && body.meds.length) {
    body.meds.forEach((med, i) => {
      medsCount += 1;
      statements.push(env.DB.prepare(
        "INSERT INTO medications (id, key, name, dose, default_ct, status, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(key) DO UPDATE SET name=CASE WHEN medications.status = 'active' THEN excluded.name ELSE medications.name END, dose=CASE WHEN medications.status = 'active' THEN excluded.dose ELSE medications.dose END, default_ct=CASE WHEN medications.status = 'active' THEN excluded.default_ct ELSE medications.default_ct END"
      ).bind(crypto.randomUUID(), med.key, med.name, med.dose ?? null, med.defaultCt ?? 0, i, now));
    });
  }

  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }

  return { mood: moodCount, srm: srmCount, meds: medsCount };
}

async function syncToSheet(payload, env) {
  const sheetsUrl = env.SHEETS_URL;
  if (!sheetsUrl) return;
  try {
    await fetch(sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, _fromWorker: true }),
    });
  } catch (e) {
    console.error("Sheet sync failed (non-blocking):", e);
  }
}

const MED_EVENT_TYPES = new Set(["increased", "decreased", "discontinued", "reactivated"]);
const MED_DISPLAY_PREFS = new Set(["generic", "both", "brand"]);

async function createMedication(env, body, now) {
  const key = requiredString(body.key, "key");
  const name = requiredString(body.name, "name");
  const eventId = requiredString(body.id || body.event_id, "id");
  const startDate = requiredDate(body.start_date, "start_date");
  const displayPref = displayPreference(body.display_pref);
  const defaultCt = requiredCount(body.default_ct, "default_ct");
  const brand = optionalString(body.brand);
  const dose = optionalString(body.dose);
  const existing = await env.DB.prepare("SELECT key FROM medications WHERE key = ?").bind(key).first();
  if (existing) return;
  const existingEvent = await env.DB.prepare("SELECT id FROM med_events WHERE id = ?").bind(eventId).first();
  if (existingEvent) return;
  const maxSort = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM medications").first();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO medications (id, key, name, brand, display_pref, dose, default_ct, status, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)"
    ).bind(crypto.randomUUID(), key, name, brand, displayPref, dose, defaultCt, Number(maxSort?.max_sort ?? -1) + 1, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO med_events (id, med_key, event_type, old_value, new_value, date, notes, ts, new_ct, old_ct, dose_text, source) VALUES (?, ?, 'started', NULL, ?, ?, NULL, ?, ?, NULL, ?, 'manual')"
    ).bind(eventId, key, String(defaultCt), startDate, now, defaultCt, dose),
  ]);
}

async function recordMedicationEvent(env, body, now) {
  const id = requiredString(body.id, "id");
  const key = requiredString(body.key, "key");
  const eventType = requiredString(body.event_type, "event_type");
  if (!MED_EVENT_TYPES.has(eventType)) throw new Error("invalid event_type");
  const date = requiredDate(body.date, "date");
  const existingEvent = await env.DB.prepare("SELECT id FROM med_events WHERE id = ?").bind(id).first();
  if (existingEvent) return;
  const med = await env.DB.prepare("SELECT key, dose, default_ct, status FROM medications WHERE key = ?").bind(key).first();
  if (!med) throw new Error("unknown medication");
  if (eventType === "reactivated" && med.status === "active") throw new Error("medication is already active");
  if (eventType !== "reactivated" && med.status !== "active") throw new Error("archived medication must be reactivated");

  const oldCt = nullableNumber(med.default_ct);
  const newCt = eventType === "discontinued" ? null : requiredCount(body.new_ct, "new_ct");
  const doseText = optionalString(body.dose_text) ?? optionalString(med.dose);
  const status = eventType === "discontinued" ? "archived" : "active";
  const archivedAt = eventType === "discontinued" ? date : null;

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO med_events (id, med_key, event_type, old_value, new_value, date, notes, ts, new_ct, old_ct, dose_text, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')"
    ).bind(id, key, eventType, oldCt === null ? null : String(oldCt), newCt === null ? null : String(newCt), date, optionalString(body.notes), now, newCt, oldCt, doseText),
    env.DB.prepare(
      "UPDATE medications SET default_ct = ?, dose = ?, status = ?, archived_at = ? WHERE key = ?"
    ).bind(newCt, doseText, status, archivedAt, key),
  ]);
}

async function deleteMedicationEvent(env, body) {
  const id = requiredString(body.id, "id");
  const key = requiredString(body.key, "key");
  await env.DB.prepare("DELETE FROM med_events WHERE id = ? AND med_key = ?").bind(id, key).run();

  const med = await env.DB.prepare("SELECT key FROM medications WHERE key = ?").bind(key).first();
  if (!med) return;
  const latest = await env.DB.prepare(
    "SELECT event_type, date, new_ct, dose_text FROM med_events WHERE med_key = ? ORDER BY date DESC, ts DESC, id DESC LIMIT 1"
  ).bind(key).first();
  if (!latest) {
    await env.DB.prepare("DELETE FROM medications WHERE key = ?").bind(key).run();
    return;
  }

  const isStopped = latest.event_type === "discontinued";
  await env.DB.prepare(
    "UPDATE medications SET default_ct = ?, dose = ?, status = ?, archived_at = ? WHERE key = ?"
  ).bind(isStopped ? null : latest.new_ct, latest.dose_text, isStopped ? "archived" : "active", isStopped ? latest.date : null, key).run();
}

async function updateMedicationEvent(env, body) {
  const id = requiredString(body.id, "id");
  const key = requiredString(body.key, "key");
  const date = requiredDate(body.date, "date");
  const event = await env.DB.prepare("SELECT id, event_type, dose_text FROM med_events WHERE id = ? AND med_key = ?").bind(id, key).first();
  if (!event) return;

  const newCt = body.new_ct === null ? null : requiredCount(body.new_ct, "new_ct");
  const eventType = newCt === null ? "discontinued" : event.event_type === "discontinued" ? "reactivated" : event.event_type;
  const doseText = optionalString(body.dose_text) ?? event.dose_text ?? null;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE med_events SET event_type = ?, new_value = ?, date = ?, notes = ?, new_ct = ?, dose_text = ? WHERE id = ? AND med_key = ?"
    ).bind(eventType, newCt === null ? null : String(newCt), date, optionalString(body.notes), newCt, doseText, id, key),
  ]);

  const latest = await env.DB.prepare(
    "SELECT event_type, date, new_ct, dose_text FROM med_events WHERE med_key = ? ORDER BY date DESC, ts DESC, id DESC LIMIT 1"
  ).bind(key).first();
  if (!latest) {
    await env.DB.prepare("DELETE FROM medications WHERE key = ?").bind(key).run();
    return;
  }

  const latestStopped = latest.event_type === "discontinued";
  await env.DB.prepare(
    "UPDATE medications SET default_ct = ?, dose = ?, status = ?, archived_at = ? WHERE key = ?"
  ).bind(latestStopped ? null : latest.new_ct, latest.dose_text, latestStopped ? "archived" : "active", latestStopped ? latest.date : null, key).run();
}

async function seedMedicationHistory(env, mode) {
  const meds = await computeSeedMedicationHistory(env);
  if (mode === "dry") return { ok: true, mode, meds: publicSeedMedicationHistory(meds) };

  const now = new Date().toISOString();
  const statements = [];
  let inserted = 0;
  for (const med of meds) {
    statements.push(env.DB.prepare("DELETE FROM med_events WHERE med_key = ? AND source = 'seed'").bind(med.key));
    for (const event of med.seeded) {
      inserted += 1;
      statements.push(env.DB.prepare(
        "INSERT INTO med_events (id, med_key, event_type, old_value, new_value, date, notes, ts, new_ct, old_ct, dose_text, source) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'seed')"
      ).bind(
        crypto.randomUUID(), med.key, event.event_type,
        event.old_ct === null ? null : String(event.old_ct),
        event.new_ct === null ? null : String(event.new_ct),
        event.date, now, event.new_ct, event.old_ct, event.dose_text,
      ));
    }
  }
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }
  return { ok: true, mode, inserted, meds: publicSeedMedicationHistory(meds) };
}

function publicSeedMedicationHistory(meds) {
  return meds.map((med) => ({
    ...med,
    seeded: med.seeded.map(({ event_type, date, new_ct, old_ct }) => ({ event_type, date, new_ct, old_ct })),
  }));
}

async function computeSeedMedicationHistory(env) {
  const { results: meds = [] } = await env.DB.prepare(
    "SELECT key, name, dose FROM medications ORDER BY sort_order"
  ).all();
  const { results: rows = [] } = await env.DB.prepare(
    "SELECT med_key, date, count FROM daily_med_doses ORDER BY med_key, date"
  ).all();
  const { results: manualStarted = [] } = await env.DB.prepare(
    "SELECT DISTINCT med_key FROM med_events WHERE source = 'manual' AND event_type = 'started'"
  ).all();
  const manualStartedKeys = new Set(manualStarted.map((row) => row.med_key));
  const rowsByMed = new Map();
  for (const row of rows) {
    const count = nullableNumber(row.count);
    if (count === null) continue;
    if (!rowsByMed.has(row.med_key)) rowsByMed.set(row.med_key, []);
    rowsByMed.get(row.med_key).push({ date: row.date, count });
  }

  return meds.map((med) => {
    if (manualStartedKeys.has(med.key)) {
      return { key: med.key, name: med.name, seeded: [], skipped: "has manual history" };
    }
    const seeded = deriveSeedEvents(rowsByMed.get(med.key) || [], med.dose);
    return {
      key: med.key,
      name: med.name,
      seeded,
      skipped: seeded.length ? false : "as-needed / never stabilized",
    };
  });
}

function deriveSeedEvents(series, doseText) {
  const runs = stableRuns(series, 3);
  const events = [];
  let current = null;
  for (const run of runs) {
    if (current === null) {
      if (run.count > 0) {
        events.push(seedEvent("started", run.date, run.count, null, doseText));
        current = run.count;
      }
      continue;
    }
    if (run.count === current) continue;
    if (run.count === 0) {
      events.push(seedEvent("discontinued", run.date, null, current, doseText));
      current = 0;
    } else if (current === 0) {
      events.push(seedEvent("reactivated", run.date, run.count, null, doseText));
      current = run.count;
    } else {
      events.push(seedEvent(run.count > current ? "increased" : "decreased", run.date, run.count, current, doseText));
      current = run.count;
    }
  }
  return events;
}

function stableRuns(series, threshold) {
  const runs = [];
  let current = null;
  for (const item of series) {
    if (current && current.count === item.count) {
      current.end = item.date;
      current.length += 1;
    } else {
      if (current && current.length >= threshold) runs.push(current);
      current = { count: item.count, date: item.date, end: item.date, length: 1 };
    }
  }
  if (current && current.length >= threshold) runs.push(current);
  return runs;
}

function seedEvent(eventType, date, newCt, oldCt, doseText) {
  return { event_type: eventType, date, new_ct: newCt, old_ct: oldCt, dose_text: doseText || null };
}

async function updateMedicationMeta(env, body) {
  const key = requiredString(body.key, "key");
  const name = requiredString(body.name, "name");
  const displayPref = displayPreference(body.display_pref);
  const result = await env.DB.prepare(
    "UPDATE medications SET name = ?, brand = ?, display_pref = ? WHERE key = ?"
  ).bind(name, optionalString(body.brand), displayPref, key).run();
  if (!result.meta?.changes) throw new Error("unknown medication");
}

async function reconcileActiveMedications(env, meds, now) {
  if (!Array.isArray(meds)) return;
  const keys = [...new Set(meds.map((med) => optionalString(med?.key)).filter(Boolean))];
  const archivedAt = now.slice(0, 10);
  const statements = [];
  if (keys.length) {
    const placeholders = keys.map(() => "?").join(", ");
    statements.push(env.DB.prepare(
      `UPDATE medications SET status = 'archived', archived_at = ? WHERE status = 'active' AND key NOT IN (${placeholders})`
    ).bind(archivedAt, ...keys));
  } else {
    statements.push(env.DB.prepare(
      "UPDATE medications SET status = 'archived', archived_at = ? WHERE status = 'active'"
    ).bind(archivedAt));
  }
  await env.DB.batch(statements);
}

function requiredString(value, field) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`missing ${field}`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredDate(value, field) {
  const normalized = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(`invalid ${field}`);
  return normalized;
}

function requiredCount(value, field) {
  const count = nullableNumber(value);
  if (count === null || count < 0) throw new Error(`invalid ${field}`);
  return count;
}

function displayPreference(value) {
  const pref = optionalString(value) || "generic";
  if (!MED_DISPLAY_PREFS.has(pref)) throw new Error("invalid display_pref");
  return pref;
}

function parseJsonArray(value) {
  const parsed = parseJsonValue(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJsonValue(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function dayName(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const parsed = new Date(`${date}T12:00:00`);
  // Invalid date -> getDay() is NaN -> days[NaN] is undefined, which D1 rejects
  // with D1_TYPE_ERROR (a 500 the client then retries forever). Fall back to null.
  return days[parsed.getDay()] ?? null;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function nullableInteger(value) {
  const num = nullableNumber(value);
  return num === null ? null : Math.trunc(num);
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
