const { SHEETS_URL, WORKER_URL, SHARED_SECRET } = process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

requireEnv("SHEETS_URL", SHEETS_URL);
requireEnv("WORKER_URL", WORKER_URL);
requireEnv("SHARED_SECRET", SHARED_SECRET);

const sheetsSyncUrl = new URL(SHEETS_URL);
sheetsSyncUrl.searchParams.set("action", "sync");

const workerBaseUrl = WORKER_URL.replace(/\/+$/, "");

function countObjectKeys(value) {
  return value && typeof value === "object" ? Object.keys(value).length : 0;
}

function countMeds(value) {
  return Array.isArray(value) ? value.length : 0;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${url} returned non-JSON response: ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

async function main() {
  console.log(`Fetching Sheet sync data from ${sheetsSyncUrl.toString()}`);
  const sheetData = await fetchJson(sheetsSyncUrl.toString());

  if (!sheetData || sheetData.status !== "ok") {
    throw new Error(`Sheet sync did not return status ok: ${JSON.stringify(sheetData)}`);
  }

  const originalCounts = {
    mood: countObjectKeys(sheetData.mood),
    srm: countObjectKeys(sheetData.srm),
    meds: countMeds(sheetData.meds),
  };
  console.log("Source counts:", originalCounts);

  const ingestUrl = `${workerBaseUrl}/ingest`;
  console.log(`Posting bulk data to ${ingestUrl}`);
  const ingestResult = await fetchJson(ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth": SHARED_SECRET,
    },
    body: JSON.stringify({
      mood: sheetData.mood,
      srm: sheetData.srm,
      settings: sheetData.settings,
      meds: sheetData.meds,
    }),
  });
  console.log("Ingest response:", ingestResult);

  const syncUrl = `${workerBaseUrl}/sync`;
  console.log(`Verifying Worker sync data from ${syncUrl}`);
  const workerData = await fetchJson(syncUrl);
  const workerCounts = {
    mood: countObjectKeys(workerData.mood),
    srm: countObjectKeys(workerData.srm),
    meds: countMeds(workerData.meds),
  };
  console.log("Worker counts:", workerCounts);

  for (const key of ["mood", "srm", "meds"]) {
    const passed = originalCounts[key] === workerCounts[key];
    console.log(`${key}: ${passed ? "PASS" : "FAIL"} (${workerCounts[key]} / ${originalCounts[key]})`);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
