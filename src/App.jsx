import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, CartesianGrid, ReferenceLine, BarChart, Bar } from "recharts";

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG — Set your Google Sheets Web App URL here after deploying
   ═══════════════════════════════════════════════════════════════════════════ */
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbygl23s4Fr81MqTfkGLOSTK9YOpd20qfrUpLJefmFNckgYRtxBnl8Dht3XL-pojdFMP/exec"; // paste your deployed Apps Script URL here
const WORKER_URL = "https://mootracker-push.weavergirl.workers.dev";
const APP_TOKEN = import.meta.env.VITE_APP_TOKEN || "";
const DELETE_TOMBSTONES = import.meta.env.VITE_DELETE_TOMBSTONES === "1";
const DEV_NOTES_KEY = "mt_dev_notes";
const DEV_NOTES_EVENT = "mt-dev-notes-updated";

// VAPID public key — paired with the private key held by the Cloudflare Worker
// that signs Web Push requests on behalf of this app. Safe to expose publicly.
const VAPID_PUBLIC_KEY = "BD_e-9qa7XJwI2m1ib83cWXP98HrFUdRDUeQmnA7eTLCt3F8OHkZzn-hubkvKBe8uJkfHjSG5CyHhT-0BfPPH7c";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isStandalonePWA() {
  if (typeof window === "undefined") return false;
  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.navigator && window.navigator.standalone === true) return true;
  return false;
}

async function getPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enableWebPush() {
  if (!("serviceWorker" in navigator)) throw new Error("Service worker not supported in this browser.");
  if (!("PushManager" in window)) throw new Error("Push notifications not supported in this browser.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission denied. Enable it in Settings → Notifications.");
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
}

async function disableWebPush() {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sub.unsubscribe();
    return sub;
  }
  return null;
}

// "primary" for Wei's own devices, "caretaker" for anyone helping (e.g. Cuixi).
// Derived from the device's actor setting.
function actorToRole(actor){
  return String(actor || "").trim().toLowerCase() === "wei" ? "primary" : "caretaker";
}
function getDeviceTz(){
  try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"";}catch{return "";}
}

function pushSubscribeToSheets(subscription) {
  if (!WORKER_URL || !subscription) return;
  const actor=getDeviceActor();
  enqueueSync({
    type: "push_subscribe",
    subscription: subscription.toJSON ? subscription.toJSON() : subscription,
    role: actorToRole(actor),
    actor: actor,
    tz: getDeviceTz(),
  });
}

function pushUnsubscribeFromSheets(subscription) {
  if (!WORKER_URL || !subscription) return;
  const endpoint = (subscription.toJSON ? subscription.toJSON() : subscription).endpoint;
  enqueueSync({ type: "push_unsubscribe", endpoint, actor: getDeviceActor() });
}

// When the user changes this device's actor in Settings, re-tag the existing
// subscription's role server-side so nudge routing follows immediately —
// without forcing a re-subscribe round trip.
async function pushUpdateRoleForCurrentSub(){
  if(!WORKER_URL) return;
  const sub=await getPushSubscription();
  if(!sub) return;
  const actor=getDeviceActor();
  enqueueSync({
    type:"update_push_role",
    endpoint:(sub.toJSON?sub.toJSON():sub).endpoint,
    role:actorToRole(actor),
    actor:actor,
    tz:getDeviceTz(),
  });
}

async function pushUpdateTzForCurrentSub(){
  if(!WORKER_URL) return;
  if(tzUpdateQueuedThisSession) return;
  const sub=await getPushSubscription();
  if(!sub) return;
  tzUpdateQueuedThisSession=true;
  enqueueSync({
    type:"update_push_tz",
    endpoint:(sub.toJSON?sub.toJSON():sub).endpoint,
    tz:getDeviceTz(),
    actor:getDeviceActor(),
  });
}

/* ── SYNC LAYER — sequential queue, persisted across reloads ── */

const SYNC_QUEUE_KEY="mt_sync_queue";
const DEAD_LETTER_KEY="mt_sync_deadletter";
function loadSyncQueue(){try{const v=localStorage.getItem(SYNC_QUEUE_KEY);return v?JSON.parse(v)||[]:[];}catch{return [];}}
function saveSyncQueue(q){try{localStorage.setItem(SYNC_QUEUE_KEY,JSON.stringify(q));}catch{/* localStorage unavailable or quota full; in-memory queue still retries this session */}}
// A job the server permanently rejects (4xx) can never succeed. Park it here so
// it stops blocking the entries queued behind it (the bug that hid Wei's mood).
function deadLetterJob(job,reason){
  try{
    const dl=JSON.parse(localStorage.getItem(DEAD_LETTER_KEY)||"[]");
    dl.push({job,reason,ts:new Date().toISOString()});
    localStorage.setItem(DEAD_LETTER_KEY,JSON.stringify(dl));
  }catch{/* best-effort; the important part is unblocking the live queue */}
  console.error("Sync: dropped unrecoverable job",reason,job);
}

const syncQueue=loadSyncQueue();
let syncRunning=false;
let tzUpdateQueuedThisSession=false;
let syncStatus={state:syncQueue.length?"syncing":"idle",pending:syncQueue.length}; // "idle"|"syncing"|"done"|"error"
const syncListeners=new Set();
function notifySync(){syncListeners.forEach(fn=>fn({...syncStatus}));}

async function processQueue(){
  if(syncRunning||!syncQueue.length)return;
  syncRunning=true;
  let failures=0;
  while(syncQueue.length){
    syncStatus={state:"syncing",pending:syncQueue.length};notifySync();
    const job=syncQueue[0]; // peek; only shift on success
    try{
      const res = await fetch(`${WORKER_URL}/write`,{
        method:"POST",
        headers:{"Content-Type":"application/json","X-App-Token":APP_TOKEN},
        body:JSON.stringify(job),
        keepalive:true, // survive the app being backgrounded right after a log
      });
      if(res.ok){
        syncQueue.shift();
        saveSyncQueue(syncQueue);
        failures=0;
        await new Promise(r=>setTimeout(r,300));
        continue;
      }
      // The server was REACHED but rejected the write. Only this case may
      // dead-letter — a connectivity failure (the catch below) never does, so
      // entries survive arbitrarily long outages (offline for a week is fine).
      // 4xx (except 403/429) is permanent; 5xx/403/429 may be transient, so retry but
      // cap total rejections so a deterministically-bad job can't block forever.
      const permanent = res.status>=400 && res.status<500 && res.status!==429 && res.status!==403;
      job._attempts=(job._attempts||0)+1;
      saveSyncQueue(syncQueue);
      if(permanent || job._attempts>=12){
        deadLetterJob(job, permanent?`HTTP ${res.status}`:`rejected ${job._attempts}x (last HTTP ${res.status})`);
        syncQueue.shift();
        saveSyncQueue(syncQueue);
        failures=0;
        continue;
      }
      failures++;
      if(failures>=3) break; // back off this run; retry on next enqueue or reload
      await new Promise(r=>setTimeout(r,1000*failures));
    }catch(e){
      // Network error — the server was never reached (offline, flaky wifi, DNS).
      // This is transient and may last days. NEVER dead-letter here: keep the
      // job and retry on the next reload / online / foreground event.
      console.warn("Sync (network, will retry):",e);
      failures++;
      if(failures>=3) break;
      await new Promise(r=>setTimeout(r,1000*failures));
    }
  }
  syncRunning=false;
  if(syncQueue.length){
    syncStatus={state:"error",pending:syncQueue.length};notifySync();
  } else {
    syncStatus={state:"done",pending:0};notifySync();
    setTimeout(()=>{if(syncStatus.state==="done"){syncStatus={state:"idle",pending:0};notifySync();}},2000);
  }
}

function enqueueSync(payload){
  if(!WORKER_URL)return;
  syncQueue.push(payload);
  saveSyncQueue(syncQueue);
  processQueue();
}

// Resolves once the queue has fully drained (or after timeoutMs if it gets
// stuck). Used by the "Enable notifications" flow to make sure the new
// push_subscribe row has hit the sheet before we ask the server to fire a
// test push at this specific endpoint.
async function waitForSyncIdle(timeoutMs=6000){
  await new Promise(r=>setTimeout(r,200)); // let processQueue notice the new job
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    if(!syncRunning && syncQueue.length===0) return true;
    await new Promise(r=>setTimeout(r,150));
  }
  return false;
}

// Retry any persisted jobs left over from a previous session.
if(typeof window!=="undefined" && WORKER_URL && syncQueue.length){
  setTimeout(()=>processQueue(),100);
}
if(typeof window!=="undefined" && WORKER_URL){
  window.addEventListener("online",()=>{if(syncQueue.length)processQueue();});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden&&syncQueue.length)processQueue();});
}

// This device's actor (Wei / Cuixi / free-text). Stored in its own localStorage
// key — NOT inside settings — so it stays per-device and doesn't propagate
// across users via the Sheet sync. Default "Wei".
const ACTOR_KEY="mt_actor";
function getDeviceActor(){
  try{const v=localStorage.getItem(ACTOR_KEY);return (v&&v.trim())?v.trim():"Wei";}
  catch{return "Wei";}
}
function setDeviceActor(v){
  try{localStorage.setItem(ACTOR_KEY,String(v||"Wei"));}catch{/* localStorage unavailable; actor remains per-session default */}
}
const WEI_TZ_KEY="mt_weitz";
const weiTzValidity=new Map();
function isValidWeiTz(v){
  if(!v)return false;
  if(weiTzValidity.has(v))return weiTzValidity.get(v);
  try{new Intl.DateTimeFormat(undefined,{timeZone:v});weiTzValidity.set(v,true);return true;}
  catch{weiTzValidity.set(v,false);return false;}
}
function getDeviceWeiTz(){
  try{const v=localStorage.getItem(WEI_TZ_KEY)?.trim()||"";return isValidWeiTz(v)?v:"";}
  catch{return "";}
}
function setDeviceWeiTz(v){
  try{const tz=String(v||"").trim();if(isValidWeiTz(tz))localStorage.setItem(WEI_TZ_KEY,tz);else localStorage.removeItem(WEI_TZ_KEY);}
  catch{/* localStorage unavailable or invalid timezone; use device-local fallback */}
}
const TZ_LIST=(typeof Intl!=="undefined"&&typeof Intl.supportedValuesOf==="function")?Intl.supportedValuesOf("timeZone"):["America/Los_Angeles","America/New_York","America/Chicago","America/Denver","Asia/Shanghai","Asia/Tokyo","Asia/Hong_Kong","Europe/London","Europe/Paris","Australia/Sydney"];

function pushMood(date, entry, medsArr){
  enqueueSync({type:"mood",date,entry,meds_ref:medsArr,actor:getDeviceActor()});
}
function pushSrm(date, items){
  enqueueSync({type:"srm",date,items,actor:getDeviceActor()});
}
function pushDeleteMood(date){
  enqueueSync({type:"delete_mood",date,actor:getDeviceActor()});
}
function pushDeleteSrm(date){
  enqueueSync({type:"delete_srm",date,actor:getDeviceActor()});
}

async function pullFromSheets(){
  if(!WORKER_URL) return null;
  try{
    const res=await fetch(`${WORKER_URL}/sync`,{method:"GET",cache:"no-store",headers:{"X-App-Token":APP_TOKEN}});
    if(res&&res.ok) return await res.json();
  }catch{/* Worker sync failed; keep local cache */}
  return null;
}

function sortDevNotes(notes){
  return [...notes].sort((a,b)=>String(b.ts||"").localeCompare(String(a.ts||"")));
}

function loadDevNotes(){
  try{
    const raw=localStorage.getItem(DEV_NOTES_KEY);
    const parsed=raw?JSON.parse(raw):[];
    return Array.isArray(parsed)?sortDevNotes(parsed.filter(n=>n&&typeof n.id==="string"&&typeof n.text==="string"&&typeof n.ts==="string")):[];
  }catch{return [];}
}

function saveDevNotes(notes){
  const sorted=sortDevNotes(notes);
  try{localStorage.setItem(DEV_NOTES_KEY,JSON.stringify(sorted));}catch{/* cache best-effort only */}
  try{window.dispatchEvent(new CustomEvent(DEV_NOTES_EVENT,{detail:sorted}));}catch{/* event dispatch best-effort only */}
  return sorted;
}

async function fetchDevNotesFromWorker(){
  try{
    const res=await fetch(`${WORKER_URL}/dev-notes`,{method:"GET",cache:"no-store",headers:{"X-App-Token":APP_TOKEN}});
    if(!res.ok) return null;
    const data=await res.json();
    if(Array.isArray(data.notes)) return saveDevNotes(data.notes);
  }catch{/* offline or Worker unavailable; keep local cache */}
  return null;
}

async function postDevNoteToWorker(note){
  try{
    await fetch(`${WORKER_URL}/dev-notes`,{
      method:"POST",
      headers:{"Content-Type":"application/json","X-App-Token":APP_TOKEN},
      body:JSON.stringify(note),
    });
  }catch{/* local optimistic note remains visible */}
}

async function deleteDevNoteFromWorker(id){
  try{
    await fetch(`${WORKER_URL}/dev-notes?id=${encodeURIComponent(id)}`,{method:"DELETE",headers:{"X-App-Token":APP_TOKEN}});
  }catch{/* deleted local view is authoritative for this device */}
}

function formatDevNoteTs(ts){
  const d=new Date(ts);
  if(Number.isNaN(d.getTime())) return "";
  const date=new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(d);
  const time=new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"}).format(d);
  return `${date} · ${time}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEED DATA
   ═══════════════════════════════════════════════════════════════════════════ */
const SEED_MOOD = {
  // ── Wei's 2025 record (Oct–Dec), imported from MOOD TRACKER 2025.xlsx ──
  "2025-10-01":{sleep:7,irritability:2,anxiety:1,moods:["mild_elev","normal"],meds:{lamotrigine:{ct:1},quetiapine:{ct:2}}},
  "2025-10-02":{sleep:8,irritability:2,anxiety:1,mood:"mild_dep",notes:"Ate Fried Chicken last night. Slept very late.",meds:{lamotrigine:{ct:1},quetiapine:{ct:2}}},
  "2025-10-03":{sleep:8,irritability:1,anxiety:2,mood:"normal",notes:"Took Naltrexone and had mild controlled trip, slept very late.",meds:{lamotrigine:{ct:1},quetiapine:{ct:2},naltrexone:{ct:1}}},
  "2025-10-04":{sleep:8,irritability:0,anxiety:3,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:2}}},
  "2025-10-05":{sleep:8,irritability:1,anxiety:2,moods:["mild_dep","mod_dep"],meds:{lamotrigine:{ct:1},quetiapine:{ct:2}}},
  "2025-10-06":{sleep:8,irritability:2,anxiety:3,mood:"mild_dep",notes:"Going to a moon festival gathering that I do not know most people",meds:{lamotrigine:{ct:1},quetiapine:{ct:3},naltrexone:{ct:1}}},
  "2025-10-07":{sleep:8,irritability:3,anxiety:2,mood:"mild_elev",meds:{lamotrigine:{ct:1},quetiapine:{ct:3}}},
  "2025-10-08":{sleep:7,irritability:1,anxiety:2,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:3}}},
  "2025-10-09":{sleep:9,irritability:1,anxiety:2,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:3}}},
  "2025-10-10":{sleep:7.5,irritability:1,anxiety:1,mood:"normal",notes:"Cuixi leaving for China",meds:{lamotrigine:{ct:1},quetiapine:{ct:3}}},
  "2025-10-11":{sleep:7,irritability:1,anxiety:3,mood:"mild_dep",notes:"Scratching Car, Overwhemled with work",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-12":{sleep:7,irritability:1,anxiety:1,mood:"normal",notes:"Bought a PS5 and went nuts",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-13":{sleep:6,irritability:0,anxiety:1,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-14":{sleep:6.5,irritability:0,anxiety:1,mood:"mod_dep",notes:"Three days of binge video gaming",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-15":{sleep:7,irritability:0,anxiety:2,mood:"mild_elev",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-16":{sleep:9,irritability:0,anxiety:1,moods:["normal","mod_dep"],notes:"Phone call with mom brought up some tramutaic feelings",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-17":{sleep:8.5,irritability:0,anxiety:1,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-18":{sleep:8,irritability:0,anxiety:1,mood:"mod_dep",notes:"Spent all day playing games and not leaving the house",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-19":{sleep:7,irritability:0,anxiety:2,mood:"mild_dep",notes:"Bouldering with friends, good physical and social activity",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-20":{sleep:8.5,irritability:1,anxiety:2,mood:"mod_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-21":{sleep:8.5,irritability:2,anxiety:2,mood:"mod_dep",notes:"Another all nighter playing Ghost of Yotei",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-22":{sleep:7.5,irritability:3,anxiety:3,mood:"sev_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-23":{sleep:9,irritability:1,anxiety:2,moods:["mild_elev","normal"],meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-24":{sleep:6,irritability:1,anxiety:3,moods:["mod_elev","mild_dep"],meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-25":{sleep:9,irritability:1,anxiety:2,mood:"sev_dep",notes:"Major shutdown day with some peaks of depression",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-26":{sleep:9,meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-27":{meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-28":{sleep:8,irritability:1,anxiety:1,moods:["normal","mild_dep"],meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-29":{sleep:8,irritability:2,anxiety:2,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-10-30":{sleep:8.5,moods:["mild_elev","normal"],meds:{lamotrigine:{ct:1},quetiapine:{ct:4}}},
  "2025-11-01":{sleep:6,irritability:1,anxiety:1,mood:"mild_elev",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-02":{sleep:6.5,mood:"mild_elev",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-03":{irritability:2,anxiety:3,moods:["mild_elev","normal"],meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-04":{sleep:8,irritability:1,anxiety:3,mood:"mild_elev",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-05":{sleep:10,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-06":{sleep:9,irritability:1,anxiety:1,mood:"mod_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-07":{sleep:7,irritability:1,anxiety:3,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-08":{sleep:8.5,irritability:1,anxiety:3,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-09":{sleep:7.5,irritability:1,anxiety:1,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-10":{sleep:7,anxiety:3,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-11":{meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-12":{meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-13":{meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-14":{sleep:6.5,irritability:2,anxiety:1,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-15":{sleep:8,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-16":{sleep:6,irritability:1,anxiety:1,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-17":{sleep:10,irritability:3,anxiety:2,mood:"mod_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-18":{sleep:10,irritability:2,anxiety:1,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-19":{sleep:9,irritability:1,anxiety:3,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-20":{sleep:9,irritability:1,anxiety:3,moods:["mild_dep","mod_dep"],meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-21":{sleep:9,irritability:1,anxiety:3,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-22":{mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-23":{sleep:8.5,irritability:1,anxiety:3,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-24":{sleep:6.5,irritability:2,anxiety:3,mood:"sev_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-25":{sleep:7,irritability:2,anxiety:3,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-26":{sleep:9,irritability:1,anxiety:1,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-27":{sleep:8,irritability:1,anxiety:3,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-28":{irritability:2,anxiety:3,mood:"sev_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-29":{irritability:3,anxiety:2,mood:"mod_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-30":{sleep:8.5,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-11-31":{sleep:9,irritability:2,anxiety:2,mood:"mod_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-12-01":{sleep:9,irritability:3,anxiety:3,mood:"mod_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-12-02":{sleep:9,irritability:2,anxiety:3,mood:"mod_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-12-03":{sleep:8,irritability:1,anxiety:3,mood:"mod_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-12-04":{sleep:9.5,irritability:1,anxiety:2,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-12-05":{irritability:1,anxiety:2,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-12-06":{sleep:8.5,meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-12-07":{mood:"sev_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},naltrexone:{ct:1}}},
  "2025-12-08":{irritability:2,anxiety:2,mood:"sev_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1}}},
  "2025-12-09":{sleep:8,irritability:1,anxiety:1,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-10":{sleep:7.5,irritability:1,anxiety:3,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-11":{sleep:7.5,irritability:1,anxiety:2.5,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-12":{sleep:7,anxiety:2.5,meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-13":{irritability:1,anxiety:1,mood:"mild_dep",notes:"Waking up gaming",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-14":{sleep:8,irritability:1,anxiety:2,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-15":{sleep:8,irritability:1,anxiety:2.5,mood:"normal",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-16":{meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-17":{irritability:1,anxiety:2,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-18":{sleep:9.5,meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-19":{sleep:7.5,irritability:1,anxiety:2,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-20":{sleep:8,irritability:2,anxiety:2,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-21":{sleep:8,irritability:2,anxiety:3,meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-22":{irritability:1,anxiety:3,mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-23":{sleep:7,meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-24":{meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-25":{meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-26":{meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-27":{mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-28":{mood:"mild_dep",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2025-12-29":{sleep:9,irritability:1,anxiety:3,meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2025-12-30":{sleep:9,meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:2}}},
  "2026-01-01":{sleep:8,irritability:1,anxiety:3,mood:"mod_dep",notes:"New Year, feeling anxious about the present state and future",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-02":{sleep:8,irritability:1,anxiety:1,mood:"normal",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-03":{sleep:8,irritability:1,anxiety:1,mood:"normal",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-06":{sleep:8,irritability:1,anxiety:1,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-07":{sleep:10,irritability:1,anxiety:1,mood:"normal",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-08":{sleep:8.5,irritability:1,anxiety:2,mood:"normal",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-09":{sleep:8,irritability:1,anxiety:2,mood:"normal",notes:"Potential job Interview",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-10":{sleep:9.5,irritability:1,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-15":{sleep:10,irritability:1,anxiety:1,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-16":{sleep:10,irritability:2,anxiety:2,mood:"mod_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-17":{sleep:9,irritability:1,anxiety:1,mood:"normal",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-18":{sleep:9,irritability:2,anxiety:1,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-25":{sleep:9.5,irritability:1,anxiety:2.5,mood:"mild_dep",notes:"Bouldering with Friends",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-01-26":{sleep:11,irritability:2,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4}}},
  "2026-02-01":{sleep:8,irritability:1,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-02":{sleep:9,irritability:1,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-03":{sleep:9,irritability:1,anxiety:2.5,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-04":{sleep:9,irritability:1,anxiety:2.5,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-06":{sleep:null,irritability:null,anxiety:null,mood:"sev_dep",notes:"Day of the birthday, not wanting to leave the house",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-07":{sleep:null,irritability:null,anxiety:3,mood:"sev_dep",notes:"Strong depression, brief thought of suicide",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-10":{sleep:10,irritability:2,anxiety:3,mood:"mild_dep",notes:"Photoshoot Outdoor",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-15":{sleep:null,irritability:1,anxiety:3,mood:"mild_dep",notes:"Slight episode during cleaning, Dumpling Making event, high anxiety",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-16":{sleep:8,irritability:1,anxiety:2,mood:"normal",notes:"CNY New Year, hosting, drank alcohol",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
  "2026-02-18":{sleep:null,irritability:1,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1},quetiapine:{ct:1},lithium:{ct:4},levothyroxine:{ct:1}}},
};
const SEED_SRM = {
  "2026-02-16":{items:[{id:"bed",time:"09:15",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"exercise",time:"15:30",am:false,didNot:false,withOthers:false,who:[],whoText:"",engagement:0}]},
  "2026-02-17":{items:[{id:"bed",time:"10:35",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"beverage",time:"10:45",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"breakfast",time:"11:45",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"outside",time:"11:00",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0}]},
  "2026-02-19":{items:[{id:"bed",time:"10:00",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"beverage",time:"10:25",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"breakfast",time:"10:30",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"outside",time:"10:45",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0}]},
};

const VER="0.7.0";

// Sync status hook
function useSyncStatus(){
  const[st,setSt]=useState({state:"idle",pending:0});
  useEffect(()=>{syncListeners.add(setSt);return()=>syncListeners.delete(setSt);},[]);
  return st;
}
// Sync badge — shows in calendar header
function SyncBadge(){
  const st=useSyncStatus();
  if(!WORKER_URL)return null;
  if(st.state==="idle")return null;
  if(st.state==="done")return(<span className="sync-badge done">Synced</span>);
  if(st.state==="error")return(<span className="sync-badge error" style={{color:"#B4503C",fontWeight:600}}>Not synced ({st.pending}) — reopen online</span>);
  return(<span className="sync-badge active">Syncing {st.pending}...</span>);
}
const MM={sev_elev:{v:3,label:"Severe Elevated",color:"#D4785C",short:"Sev ↑",bg:"#FDF0EC"},mod_elev:{v:2,label:"Moderate Elevated",color:"#D49A6A",short:"Mod ↑",bg:"#FDF5EE"},mild_elev:{v:1,label:"Mild Elevated",color:"#C9B07A",short:"Mild ↑",bg:"#FAF6ED"},normal:{v:0,label:"Within Normal",color:"#7BA08B",short:"Normal",bg:"#EFF6F1"},mild_dep:{v:-1,label:"Mild Depressed",color:"#7E9AB3",short:"Mild ↓",bg:"#EEF3F8"},mod_dep:{v:-2,label:"Moderate Depressed",color:"#6478A0",short:"Mod ↓",bg:"#EDF0F6"},sev_dep:{v:-3,label:"Severe Depressed",color:"#5A5F8A",short:"Sev ↓",bg:"#EDEEF4"}};
const MOOD_OPTS=[{key:"sev_elev",icon:"+3",label:"Severe Elevated",sub:"Significant impairment · not able to work"},{key:"mod_elev",icon:"+2",label:"Moderate Elevated",sub:"Significant impairment · able to work"},{key:"mild_elev",icon:"+1",label:"Mild Elevated",sub:"Without significant impairment"},{key:"normal",icon:"0",label:"Within Normal",sub:"No symptoms"},{key:"mild_dep",icon:"−1",label:"Mild Depressed",sub:"Without significant impairment"},{key:"mod_dep",icon:"−2",label:"Moderate Depressed",sub:"Significant impairment · able to work"},{key:"sev_dep",icon:"−3",label:"Severe Depressed",sub:"Significant impairment · not able to work"}];
const moodsArr=(e)=>Array.isArray(e?.moods)?e.moods:(e?.mood?[e.mood]:[]);
const primaryMood=(e)=>moodsArr(e)[0]||null;
const moodValue=(e)=>{const ms=moodsArr(e);if(!ms.length)return null;const vals=ms.map(k=>MM[k]?.v).filter(v=>v!=null);return vals.length?vals.reduce((s,x)=>s+x,0)/vals.length:null;};
const moodLabel=(e)=>moodsArr(e).map(k=>MM[k]?.label||k).join(" / ");
const moodKeyString=(e)=>moodsArr(e).join("|");
const DEF_MEDS=[{key:"lamotrigine",name:"Lamotrigine",dose:"200mg",defaultCt:1},{key:"quetiapine",name:"Quetiapine",dose:"100mg",defaultCt:1},{key:"lithium",name:"Lithium Carbonate",dose:"300mg",defaultCt:4},{key:"levothyroxine",name:"Levothyroxine",dose:"50mcg",defaultCt:1},{key:"naltrexone",name:"Naltrexone",dose:"50mg",defaultCt:0}];
const SRM_ACT=[{id:"bed",label:"Got out of bed",icon:"○"},{id:"beverage",label:"Morning beverage",icon:"◎"},{id:"breakfast",label:"Breakfast",icon:"◉"},{id:"outside",label:"Went outside",icon:"◇"},{id:"exercise",label:"Work out",icon:"△"},{id:"work",label:"Started work / study",icon:"□"},{id:"lunch",label:"Lunch",icon:"◈"},{id:"dinner",label:"Dinner",icon:"◆"},{id:"home",label:"Returned home",icon:"⌂"},{id:"bedtime",label:"Went to bed",icon:"◑"}];
// Short bubble phrase per SRM moment (no entry → falls back to the SRM_ACT label).
const SRM_PHRASE={bed:"Get up",bedtime:"Bed",breakfast:"Breakfast",lunch:"Lunch",dinner:"Dinner",outside:"Went outside",exercise:"Worked out",work:"Started work",home:"Home"};
const WHO_OPTS=[{key:"spouse",label:"Spouse / Partner"},{key:"friend",label:"Friend"},{key:"family",label:"Family"},{key:"other",label:"Other"}];
const ENG_OPTS=[{v:1,label:"Just present"},{v:2,label:"Actively involved"},{v:3,label:"Very stimulating"}];
const SEV=[{v:0,l:"None"},{v:1,l:"Mild"},{v:2,l:"Moderate"},{v:3,l:"Severe"}];
const MO=["January","February","March","April","May","June","July","August","September","October","November","December"];
const DW=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const dk=(y,m,d)=>`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const dIn=(y,m)=>new Date(y,m+1,0).getDate();
const fDay=(y,m)=>new Date(y,m,1).getDay();
// Wei's day starts at 6 AM. Anything logged before then still counts as
// "yesterday" — so if he opens at 2 AM, today's entry defaults to the
// previous calendar date. tdk() is the canonical "what is today, for Wei"
// reference used across the app (default selDay, streak, log activity).
const WEI_DAY_OFFSET_HOURS=6;
let weiDateFormatterTz="",weiDateFormatter=null,weiYMDCache={minute:null,tz:null,ymd:null};
let weiTimeFormatterTz="",weiTimeFormatter=null,weiHMCache={minute:null,tz:null,hm:null};
function weiYMD(){
  const tz=getDeviceWeiTz(),ms=Date.now()-WEI_DAY_OFFSET_HOURS*3600*1000,minute=Math.floor(ms/60000);
  if(weiYMDCache.minute===minute&&weiYMDCache.tz===tz)return weiYMDCache.ymd;
  let ymd;
  if(!tz){
    const d=new Date(ms);ymd=[d.getFullYear(),d.getMonth(),d.getDate()];
  }else{
    if(weiDateFormatterTz!==tz){
      weiDateFormatter=new Intl.DateTimeFormat("en-US",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour12:false});
      weiDateFormatterTz=tz;
    }
    const p=Object.fromEntries(weiDateFormatter.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
    ymd=[Number(p.year),Number(p.month)-1,Number(p.day)];
  }
  weiYMDCache={minute,tz,ymd};
  return ymd;
}
function weiHM(){
  const tz=getDeviceWeiTz(),ms=Date.now(),minute=Math.floor(ms/60000);
  if(weiHMCache.minute===minute&&weiHMCache.tz===tz)return weiHMCache.hm;
  let hm;
  if(!tz){
    const d=new Date(ms);hm=`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  }else{
    if(weiTimeFormatterTz!==tz){
      weiTimeFormatter=new Intl.DateTimeFormat("en-US",{timeZone:tz,hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
      weiTimeFormatterTz=tz;
    }
    const p=Object.fromEntries(weiTimeFormatter.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
    hm=`${p.hour}:${p.minute}`;
  }
  weiHMCache={minute,tz,hm};
  return hm;
}
const tdk=()=>{const[y,m,d]=weiYMD();return dk(y,m,d);};
const ydk=()=>prevDateKey(tdk());
const nowTime=()=>weiHM();
const isAMnow=()=>Number(weiHM().slice(0,2))<12;
// Normalize time from various formats to "HH:MM"
const normTime=(v)=>{
  if(!v)return"";const s=String(v).trim();
  if(/^\d{1,2}:\d{2}$/.test(s)){const[h,m]=s.split(":").map(Number);return`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;}
  const ap=s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]?\.?$/);
  if(ap){let h=Number(ap[1])%12;if(ap[3].toLowerCase()==="p")h+=12;return`${String(h).padStart(2,"0")}:${ap[2]}`;}
  // ISO string — use local time, not UTC
  if(s.includes("T")){try{const d=new Date(s);if(!isNaN(d))return`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;}catch{/* malformed legacy date string; later parsers or raw value can handle it */}}
  // Long date string — extract HH:MM
  const m=s.match(/(\d{1,2}):(\d{2}):\d{2}/);if(m)return`${String(Number(m[1])).padStart(2,"0")}:${m[2]}`;
  return s;
};
// Display 24h "HH:MM" as 12h "h:MMam/pm"
const fmt12h=(v)=>{if(!v)return"";const[h,m]=String(v).split(":").map(Number);if(!Number.isInteger(h)||!Number.isInteger(m)||h<0||h>23||m<0||m>59)return"";const ampm=h<12?"am":"pm";const h12=h%12||12;return`${h12}:${String(m).padStart(2,"0")}${ampm}`;};
// Convert legacy 12h+am-flag time to 24h. New entries have h>=13 for PM so am is irrelevant.
const to24h=(v,am)=>{if(!v)return v;const[h,m]=v.split(":").map(Number);if(h>12)return v;// already 24h PM
if(am===undefined||am===null)return v;// no flag, trust as-is
if(!am&&h!==12)return`${String(h+12).padStart(2,"0")}:${String(m).padStart(2,"0")}`;// PM
if(am&&h===12)return`00:${String(m).padStart(2,"0")}`;// 12am → 00:xx
return v;};
const GREETS=[n=>`Take it one moment at a time${n?", "+n:""}.`,n=>`No rush. You're here, and that's enough${n?", "+n:""}.`,n=>`A small step is still a step${n?", "+n:""}.`,n=>`Glad you're here${n?", "+n:""}.`,n=>`${n?n+", you":"You"} don't have to do this perfectly.`,n=>`Checking in takes courage${n?", "+n:""}.`,n=>`${n?n+", b":"B"}e gentle with yourself today.`,n=>`Ready when you are${n?", "+n:""}.`];

function loadJ(k,fb){try{const s=localStorage.getItem(k);return s?JSON.parse(s):fb;}catch{return fb;}}
const MOOD_TOUCHED_KEY="mt_mood_touched",SRM_TOUCHED_KEY="mt_srm_touched";
function validDateKey(k){return/^\d{4}-\d{2}-\d{2}$/.test(String(k||""));}
function loadTouched(k){const v=loadJ(k,{});return v&&typeof v==="object"&&!Array.isArray(v)?v:{};}
function saveTouched(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{/* localStorage unavailable; tombstone guard falls back later */}}
function markTouched(k,date,ts=new Date().toISOString()){if(!validDateKey(date))return;const m=loadTouched(k);m[date]=ts;saveTouched(k,m);}
function clearTouched(k,date){if(!validDateKey(date))return;const m=loadTouched(k);if(m[date]){delete m[date];saveTouched(k,m);}}
function markMoodTouched(date,ts){markTouched(MOOD_TOUCHED_KEY,date,ts);}
function clearMoodTouched(date){clearTouched(MOOD_TOUCHED_KEY,date);}
function markSrmTouched(date,ts){markTouched(SRM_TOUCHED_KEY,date,ts);}
function clearSrmTouched(date){clearTouched(SRM_TOUCHED_KEY,date);}
function tsMs(v){const n=Date.parse(v||"");return Number.isFinite(n)?n:0;}
function tombstoneTs(deletions,date,kind){const v=deletions?.[date]?.[kind];return typeof v==="string"?v:"";}
function tombstoneBeatsLocal(deletions,date,kind,touched){const del=tombstoneTs(deletions,date,kind);if(!del)return false;const local=touched?.[date];return!local||tsMs(del)>=tsMs(local);}
function applyDeletionTombstones(local,touched,deletions,kind){
  const suppressed=new Set();let changed=false,touchedChanged=false;
  if(!DELETE_TOMBSTONES||!deletions||typeof deletions!=="object")return{suppressed,changed,touchedChanged};
  for(const dt in deletions){
    if(!validDateKey(dt)||!tombstoneBeatsLocal(deletions,dt,kind,touched))continue;
    suppressed.add(dt);
    if(local[dt]){delete local[dt];changed=true;}
    if(touched[dt]){delete touched[dt];touchedChanged=true;}
  }
  return{suppressed,changed,touchedChanged};
}
function loadMood(){try{const s=localStorage.getItem("mt_mood");return s?{...SEED_MOOD,...JSON.parse(s)}:{...SEED_MOOD};}catch{return{...SEED_MOOD};}}
function saveMood(d){const u={};for(const k in d)if(!SEED_MOOD[k])u[k]=d[k];localStorage.setItem("mt_mood",JSON.stringify(u));}
function loadSRM(){try{const s=localStorage.getItem("mt_srm");return s?{...SEED_SRM,...JSON.parse(s)}:{...SEED_SRM};}catch{return{...SEED_SRM};}}
function saveSRM(d){const u={};for(const k in d)if(!SEED_SRM[k])u[k]=d[k];localStorage.setItem("mt_srm",JSON.stringify(u));}
function loadSet(){const s=loadJ("mt_set",{});if(!s.passcode)s.passcode="1234";if(!s.name)s.name="Wei";return s;}
function saveSet(s){localStorage.setItem("mt_set",JSON.stringify(s));}
// Log-activity tracking: set of yyyy-MM-dd dates on which the user actually
// saved an entry. Used for streak counting so back-dated entries (e.g.,
// logging last night's sleep on today's date) don't inflate the streak.
function loadLogActivity(){
  try{const v=localStorage.getItem("mt_log_activity");if(v!==null)return new Set(JSON.parse(v)||[]);}catch{/* corrupt or unavailable activity cache; first-time backfill rebuilds it */}
  // First-time backfill: attribute each existing entry to its own date.
  // Imperfect for entries that were back-dated, but preserves the user's
  // existing streak when upgrading; recordLogToday() handles all new saves.
  try{
    const set=new Set();
    const mood=loadMood();
    for(const k in mood){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const m=mood[k];
      if(m && (m.mood||m.mood2||m.sleep!=null||m.anxiety!=null||m.irritability!=null||(m.notes&&m.notes.trim())||entryHasMedState(m))) set.add(k);
    }
    const srm=loadSRM();
    for(const k in srm){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      if(srm[k]?.items?.length) set.add(k);
    }
    saveLogActivity(set);
    return set;
  }catch{return new Set();}
}
function saveLogActivity(set){try{localStorage.setItem("mt_log_activity",JSON.stringify([...set]));}catch{/* localStorage unavailable or quota full; streak activity stays in memory */}}
function recordLogToday(){const set=loadLogActivity();set.add(tdk());saveLogActivity(set);}
function emptyItem(id){return{id,time:"",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0};}
function pushSettings(settings,meds){const rest={...(settings||{})};delete rest.passcode;enqueueSync({type:"settings",settings:rest,meds});}
const MEDS_ALL_KEY="mt_meds_all",MED_EVENTS_KEY="mt_med_events";
const activeToLifecycle=meds=>(meds||[]).map(m=>({key:m.key,name:m.name,brand:null,display_pref:"generic",dose:m.dose,default_ct:m.defaultCt??0,when_taken:normalizeWhenTaken(m.whenTaken),status:"active",archived_at:null}));
function loadMedsAll(){const cached=loadJ(MEDS_ALL_KEY,null);return Array.isArray(cached)?cached:activeToLifecycle(loadJ("mt_meds",DEF_MEDS));}
function loadMedEvents(){const cached=loadJ(MED_EVENTS_KEY,[]);return Array.isArray(cached)?cached:[];}
function saveMedsAll(meds){try{localStorage.setItem(MEDS_ALL_KEY,JSON.stringify(meds));}catch{/* lifecycle cache best-effort only */}}
function saveMedEvents(events){try{localStorage.setItem(MED_EVENTS_KEY,JSON.stringify(events));}catch{/* lifecycle cache best-effort only */}}
function medByKey(medsAll,key){return(medsAll||[]).find(m=>m.key===key);}
function prettyMedKey(key){return String(key||"Unknown medication").replace(/[_-]+/g," ").replace(/\b\w/g,c=>c.toUpperCase());}
function medNames(med,key){
  if(!med)return{primary:prettyMedKey(key),secondary:""};
  const generic=String(med.name||"").trim(),brand=String(med.brand||"").trim(),pref=med.display_pref||"generic";
  if(!brand)return{primary:generic||prettyMedKey(key),secondary:""};
  if(pref==="brand")return{primary:brand,secondary:generic};
  if(pref==="both")return{primary:generic||brand,secondary:brand};
  return{primary:generic||brand,secondary:brand};
}
function medPrimary(med,key){return medNames(med,key).primary;}
const WHEN_TAKEN_OPTIONS=[
  {key:"",label:"Unset"},
  {key:"morning",label:"Morning"},
  {key:"midday",label:"Midday"},
  {key:"dinner",label:"Dinner"},
  {key:"bedtime",label:"Bedtime"},
  {key:"as_needed",label:"As needed"},
];
const WHEN_TAKEN_LABEL=Object.fromEntries(WHEN_TAKEN_OPTIONS.map(o=>[o.key,o.label.toLowerCase()]));
const WHEN_TAKEN_ORDER={morning:0,midday:1,dinner:2,bedtime:3,"":4,as_needed:5};
function normalizeWhenTaken(value){return["morning","midday","dinner","bedtime","as_needed"].includes(value)?value:"";}
function medWhenTaken(med){return normalizeWhenTaken(med?.when_taken??med?.whenTaken);}
function medWhenLabel(med){const slot=medWhenTaken(med);return slot?WHEN_TAKEN_LABEL[slot]:"";}
function medTimelineIndex(med){return WHEN_TAKEN_ORDER[medWhenTaken(med)]??WHEN_TAKEN_ORDER[""];}
function sortMedsByWhen(meds){return[...(meds||[])].sort((a,b)=>medTimelineIndex(a)-medTimelineIndex(b)||String(a.name||a.key||"").localeCompare(String(b.name||b.key||"")));}
function WhenTakenPicker({value,onChange}){return <div className="g-med-chips when-picker">{WHEN_TAKEN_OPTIONS.map(opt=><button type="button" className={`g-med-chip when${value===opt.key?" on":""}`} key={opt.key} onClick={()=>onChange(opt.key)}>{opt.label}</button>)}</div>;}
function shortMedDate(date){if(!date)return"";const[,m,d]=String(date).split("-").map(Number);return Number.isFinite(m)&&Number.isFinite(d)?`${MO[m-1]?.slice(0,3)||m} ${d}`:date;}
function medDowDate(date){if(!date)return"";const[y,m,d]=String(date).split("-").map(Number);if(!Number.isFinite(y)||!Number.isFinite(m)||!Number.isFinite(d))return date;const dt=new Date(y,m-1,d);return{dow:DW[dt.getDay()],label:`${MO[m-1]?.slice(0,3)||m} ${d}`,month:MO[m-1]||String(m)};}
function medCountLabel(ct){if(ct===null||ct===undefined||ct==="")return"—";return Number(ct)===0?"as needed":`${Number(ct)}/day`;}
function medDoseLabel(dose){return String(dose||"").trim()||"—";}
function medRegimenLabel(dose,ct){return`${medDoseLabel(dose)} · ${medCountLabel(ct)}`;}
function medNoteInput(note){return String(note||"").replace(/[\r\n]+/g," ").slice(0,500);}
function cleanMedNote(note){return String(note||"").replace(/[\r\n]+/g," ").slice(0,500).trim();}
function normalizeDailyMedState(src){
  const ctRaw=Number(src?.ct??0);
  const ct=Number.isFinite(ctRaw)?Math.max(0,ctRaw):0;
  const off=!!src?.off&&ct>0;
  const note=cleanMedNote(src?.note);
  return note?{ct,off,note}:{ct,off};
}
function medStateKind(state){
  const s=normalizeDailyMedState(state);
  if(s.off)return"off";
  if(s.ct<=0)return"missed";
  return"taken";
}
function medHasDailyState(state){
  const s=normalizeDailyMedState(state);
  return s.ct>0||s.off||!!s.note||Object.prototype.hasOwnProperty.call(state||{},"ct");
}
function entryHasMedState(entry){return Object.values(entry?.meds||{}).some(medHasDailyState);}
function medDoseQtyLabel(med,ct){
  const dose=String(med?.dose||"").trim();
  return dose?`${dose} × ${Number(ct||0)}`:`× ${Number(ct||0)}`;
}
function dailyMedForChoice(choice,med,prev={}){
  const defaultCt=Math.max(0,Number(med?.defaultCt??prev.ct??0)||0);
  const note=choice==="taken"?"":cleanMedNote(prev.note);
  const base=choice==="missed"?{ct:0,off:false}:choice==="off"?{ct:defaultCt,off:defaultCt>0}: {ct:defaultCt,off:false};
  return note&&choice!=="taken"?{...base,note}:base;
}
function defaultRoutineMedsMap(meds){
  const out={};
  (meds||[]).filter(med=>medWhenTaken(med)!=="as_needed"&&Number(med.defaultCt)>0).forEach(med=>{out[med.key]=dailyMedForChoice("taken",med);});
  return out;
}
function cloneMedsState(meds){return Object.fromEntries(Object.entries(meds||{}).map(([k,v])=>[k,{...v}]));}
function normalizeMedsForSave(meds){
  return Object.fromEntries(Object.entries(meds||{}).map(([key,state])=>{
    const s=normalizeDailyMedState(state);
    return[key,s.note?{...s,note:cleanMedNote(s.note)}:{ct:s.ct,off:s.off}];
  }));
}
function medEventAsc(a,b){return String(a.date||"").localeCompare(String(b.date||""))||String(a.ts||"").localeCompare(String(b.ts||""))||String(a.id||"").localeCompare(String(b.id||""));}
function medEventDesc(a,b){return medEventAsc(b,a);}
function medDoseNumber(dose){const n=parseFloat(String(dose||"").replace(/,/g,""));return Number.isFinite(n)?n:null;}
function medCompareDose(a,b){const na=medDoseNumber(a),nb=medDoseNumber(b);if(na!==null&&nb!==null&&na!==nb)return na>nb?1:-1;const sa=medDoseLabel(a),sb=medDoseLabel(b);return sa===sb?0:null;}
function medCompareCount(a,b){const na=Number(a),nb=Number(b);if(!Number.isFinite(na)||!Number.isFinite(nb)||na===nb)return 0;return na>nb?1:-1;}
function medIsStoppedEvent(event){return event?.event_type==="discontinued"||event?.new_ct===null||event?.new_ct===undefined;}
function medEventVerb(event,prev){
  const nowStopped=medIsStoppedEvent(event);
  const prevState=prev&&!medIsStoppedEvent(prev)?prev:null;
  if(nowStopped)return{phrase:"discontinued",was:prevState?medRegimenLabel(prevState.dose_text,prevState.new_ct):""};
  if(!prevState)return{phrase:`started · ${medRegimenLabel(event.dose_text,event.new_ct)}`,was:""};
  const doseCmp=medCompareDose(event.dose_text,prevState.dose_text);
  const ctCmp=medCompareCount(event.new_ct,prevState.new_ct);
  const doseChanged=medDoseLabel(event.dose_text)!==medDoseLabel(prevState.dose_text);
  const countChanged=Number(event.new_ct)!==Number(prevState.new_ct);
  if(doseChanged&&!countChanged){
    const word=doseCmp<0?"decreased":doseCmp>0?"increased":"changed";
    return{phrase:`dose ${word} to ${medDoseLabel(event.dose_text)}`,was:medDoseLabel(prevState.dose_text)};
  }
  if(countChanged&&!doseChanged){
    const word=ctCmp<0?"decreased":"increased";
    return{phrase:`${word} to ${medCountLabel(event.new_ct)}`,was:medCountLabel(prevState.new_ct)};
  }
  if(doseChanged&&countChanged){
    const sameDir=doseCmp!==null&&doseCmp===ctCmp;
    if(sameDir)return{phrase:`${doseCmp>0?"increased":"decreased"} to ${medRegimenLabel(event.dose_text,event.new_ct)}`,was:medRegimenLabel(prevState.dose_text,prevState.new_ct)};
    return{phrase:`dose changed to ${medRegimenLabel(event.dose_text,event.new_ct)}`,was:medRegimenLabel(prevState.dose_text,prevState.new_ct)};
  }
  return{phrase:`changed to ${medRegimenLabel(event.dose_text,event.new_ct)}`,was:medRegimenLabel(prevState.dose_text,prevState.new_ct)};
}
function medEventsWithPrev(events,key){
  const rows=(events||[]).filter(ev=>ev.med_key===key).sort(medEventAsc);
  return rows.map((event,i)=>({event,prev:rows[i-1]||null,derived:medEventVerb(event,rows[i-1]||null)}));
}
function medLatestForKey(events,key){return(events||[]).filter(ev=>ev.med_key===key).sort(medEventDesc)[0]||null;}
function medsActiveRows(medsAll){return sortMedsByWhen((medsAll||[]).filter(m=>m.status==="active")).map(m=>({key:m.key,name:m.name,dose:m.dose,defaultCt:m.default_ct??0,whenTaken:medWhenTaken(m)}));}
function routineMedsAsOfDate(medsAll,events,dateKey){
  const routine=[];
  for(const med of medsAll||[]){
    const medEvents=(events||[]).filter(ev=>ev.med_key===med.key);
    const latest=medEvents.filter(ev=>String(ev.date||"")<=String(dateKey||"")).sort(medEventDesc)[0];
    let row=null;
    if(latest&&!medIsStoppedEvent(latest)){
      row={...med,dose:latest.dose_text||med.dose||null,default_ct:latest.new_ct,defaultCt:latest.new_ct};
    }else if(!latest&&medEvents.length===0&&med.status==="active"){
      row={...med,defaultCt:med.default_ct??med.defaultCt??0};
    }
    if(row&&medWhenTaken(row)!=="as_needed"&&Number(row.default_ct??row.defaultCt)>0) routine.push(row);
  }
  return sortMedsByWhen(routine);
}
function hasPositiveMedLog(entry){return Object.values(entry?.meds||{}).some(state=>normalizeDailyMedState(state).ct>0);}
function hasIrregularMedsForDate(entry,medsAll,events,dateKey){
  const medsMap=entry?.meds||{};
  const presentIrregular=Object.values(medsMap).filter(medHasDailyState).some(state=>{const kind=medStateKind(state);return kind==="missed"||kind==="off";});
  if(presentIrregular)return true;
  if(!hasPositiveMedLog(entry))return false;
  return routineMedsAsOfDate(medsAll,events,dateKey).some(med=>{
    const raw=medsMap[med.key];
    return raw===undefined||normalizeDailyMedState(raw).ct<=0;
  });
}
function recomputeMedsAfterEvents(medsAll,events,key){
  const latest=medLatestForKey(events,key);
  if(!latest)return(medsAll||[]).filter(m=>m.key!==key);
  return(medsAll||[]).map(m=>m.key!==key?m:{...m,default_ct:medIsStoppedEvent(latest)?null:latest.new_ct,dose:latest.dose_text||null,status:medIsStoppedEvent(latest)?"archived":"active",archived_at:medIsStoppedEvent(latest)?latest.date:null});
}
function regimenBubbleLabel(event,medsAll){
  const name=medPrimary(medByKey(medsAll,event.med_key),event.med_key);
  return event.event_type==="discontinued"?`${name} → discontinued`:`${name} → ${medCountLabel(event.new_ct)}`;
}

/* ── SLEEP CHIP HELPERS ── */
function buildTimeRange(sH,sM,eH,eM){const out=[];let h=sH,m=sM;for(let i=0;i<100;i++){out.push({h,m});m+=30;if(m>=60){m=0;h=(h+1)%24;}if(out.length>1&&h===((eH*60+eM+30)/60|0)%24&&m===((eM+30)%60))break;if(out.length>48)break;}return out;}
const SLP_ALL=buildTimeRange(20,0,6,0);   // sleep: 8pm–6am
const WK_ALL=buildTimeRange(4,0,16,0);    // wake: 4am–4pm
const SLP_DAY_ALL=buildTimeRange(8,0,20,0);
const WK_DAY_ALL=buildTimeRange(10,0,22,0);
const SLP_VIS=8;                          // visible chips at a time
const SLP_DEF_OFF=SLP_ALL.findIndex(c=>c.h===23&&c.m===0);
const WK_DEF_OFF=WK_ALL.findIndex(c=>c.h===10&&c.m===0);
const SLP_DAY_DEF_OFF=SLP_DAY_ALL.findIndex(c=>c.h===10&&c.m===0);
const WK_DAY_DEF_OFF=WK_DAY_ALL.findIndex(c=>c.h===14&&c.m===0);
function slpFmt12(h,m){const ap=h<12?"am":"pm";const h12=h%12||12;return`${h12}:${String(m).padStart(2,"0")} ${ap}`;}
function slpChipLabel(h,m){const ap=h<12?" am":" pm";const h12=h%12||12;return m===0?`${h12}${ap}`:`${h12}:${String(m).padStart(2,"0")}${ap}`;}
function slpDur(sH,sM,wH,wM){let d=(wH*60+wM)-(sH*60+sM);if(d<=0)d+=1440;return Math.round(d/30)*0.5;}
function slpMinToHM(mins){const m=((mins%1440)+1440)%1440;return{h:Math.floor(m/60),m:m%60};}
function slpHMToString(t){return t?`${String(t.h).padStart(2,"0")}:${String(t.m).padStart(2,"0")}`:null;}
function slpStringToHM(value){if(!value||typeof value!=="string")return null;const[h,m]=value.split(":").map(Number);return Number.isFinite(h)&&Number.isFinite(m)?{h,m}:null;}
function normalizeSleepEpisode(ep){
  const hrs=Number(ep?.hrs);
  return{hrs:Number.isFinite(hrs)?Math.max(0,Math.round(hrs*2)/2):null,bed:slpStringToHM(ep?.bed),wake:slpStringToHM(ep?.wake)};
}
function storedSleepEpisodes(entry){
  const list=Array.isArray(entry?.sleeps)?entry.sleeps.map(normalizeSleepEpisode).filter(ep=>ep.hrs!=null||ep.bed||ep.wake):[];
  return list.length>1?list:[];
}
function sleepEpisodeTotal(episodes){return Math.round(episodes.reduce((sum,ep)=>sum+(Number(ep.hrs)||0),0)*2)/2;}
function sleepEpisodeForStorage(ep){return{hrs:ep.hrs??0,bed:slpHMToString(ep.bed),wake:slpHMToString(ep.wake)};}
function sleepEpisodeSummary(ep){const parts=[];if(ep.bed)parts.push(slpFmt12(ep.bed.h,ep.bed.m));if(ep.wake)parts.push(`${ep.bed?"→ ":""}${slpFmt12(ep.wake.h,ep.wake.m)}`);return parts.join(" ")||"time not set";}
function sleepPartLabel(ep,index){if(!ep.bed)return index===0?"sleep":`sleep ${index+1}`;const h=ep.bed.h;return h>=5&&h<12?"morning":h>=12&&h<18?"afternoon":h>=18&&h<22?"evening":"night";}
function sleepMultiCue(sleeps){const eps=Array.isArray(sleeps)?sleeps.map(normalizeSleepEpisode):[];return eps.length>1?`across ${eps.length} sleeps · ${eps.map(sleepPartLabel).join(" + ")}`:"";}
function slpDerived(sleepTime,wakeTime,hrs,editOrder){
  const filled=[];if(sleepTime)filled.push("sleep");if(wakeTime)filled.push("wake");if(hrs!==null)filled.push("hrs");
  if(filled.length<2)return null;
  if(filled.length===2){if(!sleepTime)return"sleep";if(!wakeTime)return"wake";if(hrs===null)return"hrs";}
  const neverEdited=["sleep","wake","hrs"].filter(f=>!editOrder.includes(f));
  if(neverEdited.length>0)return neverEdited[0];
  return editOrder[0]||"hrs";
}
function prevDateKey(dk){const d=new Date(dk+"T12:00:00");d.setDate(d.getDate()-1);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}

/* ═══════════════════════════════════════════════════════════════════════════
   APP — passcode ONLY after welcome
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── AUTO UPDATE ──
   On app open, fetches /version.json and compares to localStorage.
   If the build changed, reloads once to pick up new assets.
*/
function useAutoUpdate() {
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/version.json?t=" + Date.now(), { cache: "no-store" });
        if (!res.ok) return;
        const { v } = await res.json();
        const stored = localStorage.getItem("mt_app_version");
        if (stored && stored !== v) {
          localStorage.setItem("mt_app_version", v);
          window.location.reload();
        } else {
          localStorage.setItem("mt_app_version", v);
        }
      } catch (_) { /* offline or missing file — silent */ }
    };
    check();
  }, []);
}

export default function App(){
  useAutoUpdate();
  useEffect(()=>{pushUpdateTzForCurrentSub();},[]);
  const[screen,setScreen]=useState("welcome");
  const[mood,setMood]=useState(loadMood);
  const[srm,setSrm]=useState(loadSRM);
  const[settings,setSS]=useState(loadSet);
  const[meds,setMedsS]=useState(()=>loadJ("mt_meds",DEF_MEDS));
  const[medsAll,setMedsAll]=useState(loadMedsAll);
  const[medEvents,setMedEvents]=useState(loadMedEvents);
  const medsRef=useRef(meds);
  useEffect(()=>{medsRef.current=meds;},[meds]);
  const[vm,setVm]=useState(()=>{const[y,m]=weiYMD();return[y,m];});
  const[selDay,setSelDay]=useState(null);
  const[srmEditId,setSrmEditId]=useState(null);
  const[srmDate,setSrmDate]=useState(tdk);
  // Deep-link target queued during welcome/lock so a notification tap
  // doesn't bypass the passcode. Consumed by Lock's onOk and Welcome's onGo.
  const[pendingNav,setPendingNav]=useState(null);

  // Mirror `screen` into a ref so the hashchange handler can read the
  // current value without stale-closure issues (the effect binds once on
  // mount with [] deps).
  const screenRef=useRef(screen);
  useEffect(()=>{screenRef.current=screen;},[screen]);

  // Handle deep-link from a tapped notification (#log/today).
  // Behavior:
  //   • Currently at welcome/lock with passcode set → queue and route
  //     through Lock so we don't bypass the passcode.
  //   • Anywhere else → go directly to today's entry. This avoids
  //     re-locking a user mid-session just because a notif arrived.
  useEffect(()=>{
    function handleHash(){
      const h=(typeof window!=="undefined"?window.location.hash:"")||"";
      if(h==="#log/today"||h.startsWith("#log/today")){
        setSelDay(tdk());
        const stored=loadSet();
        const here=screenRef.current;
        const needsLock=stored.passcode&&(here==="welcome"||here==="lock");
        if(needsLock){
          setPendingNav("calEntry");
          setScreen("lock");
        }else{
          setScreen("calEntry");
        }
        try{ history.replaceState(null,"",window.location.pathname+window.location.search); }catch{/* history API blocked; hash route may remain in URL */}
      }
    }
    handleHash();
    window.addEventListener("hashchange",handleHash);
    return()=>window.removeEventListener("hashchange",handleHash);
  },[]);

  const consumePendingNav=()=>{
    if(pendingNav){const t=pendingNav;setPendingNav(null);setScreen(t);return true;}
    return false;
  };

  // Pull from Google Sheets on app open (cross-device sync)
  useEffect(()=>{(async()=>{
    fetchDevNotesFromWorker();
    const resp=await pullFromSheets();
    if(!resp||resp.status!=="ok") return;
    const hasPushedSeed=localStorage.getItem("mt_seed_pushed");
    const deletions=DELETE_TOMBSTONES&&resp.deletions&&typeof resp.deletions==="object"?resp.deletions:null;
    // Merge mood: remote wins, then push local-only entries ONCE
    if(resp.mood && typeof resp.mood==='object'){
      const local=loadMood();
      const touched=loadTouched(MOOD_TOUCHED_KEY);
      const remoteDates=new Set(Object.keys(resp.mood));
      let changed=false;
      for(const dt in resp.mood){
        const r=resp.mood[dt];
        const rMeds={};
        const hasRemoteMeds=r.meds && typeof r.meds==='object';
        if(hasRemoteMeds){
          for(const k in r.meds) if(r.meds[k]) rMeds[k]=normalizeDailyMedState(r.meds[k]);
        }
        // If a legacy sync response omits meds entirely, keep local meds.
        const localMeds=local[dt]?.meds||{};
        const finalMeds=hasRemoteMeds ? rMeds : localMeds;
        const rNote=(r.notes||"").trim();
        const finalNotes=rNote===""&&SEED_MOOD[dt]?.notes?SEED_MOOD[dt].notes:(r.notes||"");
        local[dt]={mood:r.mood||null,mood2:r.mood2||null,sleep:r.sleep,sleeps:Array.isArray(r.sleeps)&&r.sleeps.length>1?r.sleeps:null,anxiety:r.anxiety,
          irritability:r.irritability,weight:r.weight,notes:finalNotes,meds:finalMeds};
        changed=true;
      }
      const tombstones=applyDeletionTombstones(local,touched,deletions,"mood");
      if(tombstones.changed) changed=true;
      if(tombstones.touchedChanged) saveTouched(MOOD_TOUCHED_KEY,touched);
      if(changed){setMood({...local});saveMood(local);}
      // Recover entries that exist locally but aren't on the server.
      // Restrict to the last RECENT_DAYS — older holes are rare and
      // "Force re-sync all data" in Settings handles them on demand.
      const RECENT_DAYS=30;
      const cutoffMs=Date.now()-RECENT_DAYS*86400000;
      for(const dt in local){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
        if(!remoteDates.has(dt) && !tombstones.suppressed.has(dt) && (local[dt]?.mood || local[dt]?.sleep!=null || entryHasMedState(local[dt]))){
          const entryMs=new Date(dt+"T12:00:00").getTime();
          if(entryMs>=cutoffMs) pushMood(dt, local[dt], meds);
        }
      }
    } else if(!hasPushedSeed) {
      const local=loadMood();
      const touched=loadTouched(MOOD_TOUCHED_KEY);
      const tombstones=applyDeletionTombstones(local,touched,deletions,"mood");
      if(tombstones.changed){setMood({...local});saveMood(local);}
      if(tombstones.touchedChanged) saveTouched(MOOD_TOUCHED_KEY,touched);
      for(const dt in local){
        if(!tombstones.suppressed.has(dt)&&(local[dt]?.mood || entryHasMedState(local[dt]))) pushMood(dt, local[dt], meds);
      }
    }
    // Merge SRM
    if(resp.srm && typeof resp.srm==='object'){
      const local=loadSRM();
      const touched=loadTouched(SRM_TOUCHED_KEY);
      const remoteDates=new Set(Object.keys(resp.srm));
      let changed=false;
      for(const dt in resp.srm){
        const src=resp.srm[dt];
        // Normalize time fields in items
        if(src?.items){
          src.items=src.items.map(it=>({...it,time:normTime(it.time)}));
        }
        local[dt]=src; changed=true;
      }
      const tombstones=applyDeletionTombstones(local,touched,deletions,"srm");
      if(tombstones.changed) changed=true;
      if(tombstones.touchedChanged) saveTouched(SRM_TOUCHED_KEY,touched);
      if(changed){setSrm({...local});saveSRM(local);}
      const RECENT_DAYS_SRM=30;
      const cutoffSrmMs=Date.now()-RECENT_DAYS_SRM*86400000;
      for(const dt in local){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
        if(!remoteDates.has(dt) && !tombstones.suppressed.has(dt) && local[dt]?.items?.length){
          const entryMs=new Date(dt+"T12:00:00").getTime();
          if(entryMs>=cutoffSrmMs) pushSrm(dt, local[dt].items);
        }
      }
    } else if(!hasPushedSeed) {
      const local=loadSRM();
      const touched=loadTouched(SRM_TOUCHED_KEY);
      const tombstones=applyDeletionTombstones(local,touched,deletions,"srm");
      if(tombstones.changed){setSrm({...local});saveSRM(local);}
      if(tombstones.touchedChanged) saveTouched(SRM_TOUCHED_KEY,touched);
      for(const dt in local){
        if(!tombstones.suppressed.has(dt)&&local[dt]?.items?.length) pushSrm(dt, local[dt].items);
      }
    }
    // Merge Settings — remote wins (allows device-to-device sync)
    if(resp.settings && typeof resp.settings==='object'){
      const rs=resp.settings;
      const cur=loadSet();
      const merged={...cur};
      if(rs.name) merged.name=rs.name;
      if(Array.isArray(rs.reminders)) merged.reminders=rs.reminders;
      setSS(merged); saveSet(merged);
    }
    // Merge meds independently — don't gate on settings being present
    if(resp.meds && Array.isArray(resp.meds) && resp.meds.length){
      setMedsS(resp.meds); localStorage.setItem("mt_meds",JSON.stringify(resp.meds));
    }
    if(Array.isArray(resp.medsAll)){setMedsAll(resp.medsAll);saveMedsAll(resp.medsAll);}
    if(Array.isArray(resp.medEvents)){setMedEvents(resp.medEvents);saveMedEvents(resp.medEvents);}
    if(!hasPushedSeed) localStorage.setItem("mt_seed_pushed","1");
    if(!hasPushedSeed) pushSettings(loadSet(), loadJ("mt_meds", DEF_MEDS));
  })();},[]);
  // No periodic polling — sync happens on app open only.
  // Each device pushes entries on save, pulls on load.


  const setS=s=>{const n={...settings,...s};setSS(n);saveSet(n);pushSettings(n,medsRef.current);};
  const saveActiveMeds=m=>{setMedsS(m);medsRef.current=m;localStorage.setItem("mt_meds",JSON.stringify(m));};
  const saveLifecycle=(all,events)=>{setMedsAll(all);saveMedsAll(all);setMedEvents(events);saveMedEvents(events);};
  const doCreateMed=med=>{
    const id=crypto.randomUUID(),now=new Date().toISOString();
    const row={key:med.key,name:med.name,brand:med.brand||null,display_pref:med.display_pref,dose:med.dose||null,default_ct:med.default_ct,when_taken:normalizeWhenTaken(med.when_taken),status:"active",archived_at:null};
    const event={id,med_key:med.key,event_type:"started",old_ct:null,new_ct:med.default_ct,dose_text:med.dose||null,date:med.start_date,notes:null,source:"manual",ts:now};
    const all=[...medsAll,row],events=[event,...medEvents];
    const active=medsActiveRows(all);
    saveLifecycle(all,events);saveActiveMeds(active);
    enqueueSync({type:"med_create",id,key:row.key,name:row.name,brand:row.brand,display_pref:row.display_pref,dose:row.dose,default_ct:row.default_ct,when_taken:row.when_taken,start_date:med.start_date,actor:getDeviceActor()});
  };
  const doUpdateMedMeta=meta=>{
    const med=medByKey(medsAll,meta.key);if(!med)return;
    const row={...med,name:meta.name,brand:meta.brand||null,display_pref:meta.display_pref,when_taken:normalizeWhenTaken(meta.when_taken)};
    const all=medsAll.map(m=>m.key===med.key?row:m);
    saveLifecycle(all,medEvents);saveActiveMeds(medsActiveRows(all));
    enqueueSync({type:"med_update_meta",key:row.key,name:row.name,brand:row.brand,display_pref:row.display_pref,when_taken:row.when_taken,actor:getDeviceActor()});
  };
  const doMedEvent=change=>{
    const med=medByKey(medsAll,change.key);if(!med)return;
    const id=crypto.randomUUID(),now=new Date().toISOString(),isStop=change.event_type==="discontinued";
    const nextCt=isStop?null:change.new_ct,dose=isStop?(change.dose_text||med.dose):change.dose_text;
    const event={id,med_key:med.key,event_type:change.event_type,old_ct:med.default_ct??null,new_ct:nextCt,dose_text:dose||null,date:change.date,notes:change.notes||null,source:"manual",ts:now};
    const row={...med,default_ct:nextCt,dose:dose||null,status:isStop?"archived":"active",archived_at:isStop?change.date:null};
    const all=medsAll.map(m=>m.key===med.key?row:m),events=[event,...medEvents];
    const active=medsActiveRows(all);
    saveLifecycle(all,events);saveActiveMeds(active);
    enqueueSync({type:"med_event",id,key:med.key,event_type:change.event_type,new_ct:nextCt,dose_text:dose||null,date:change.date,notes:change.notes||null,actor:getDeviceActor()});
  };
  const doUpdateMedEvent=change=>{
    const existing=medEvents.find(ev=>ev.id===change.id&&ev.med_key===change.key);if(!existing)return;
    const isStop=change.event_type==="discontinued";
    const updated={...existing,event_type:change.event_type||existing.event_type,new_ct:isStop?null:change.new_ct,dose_text:change.dose_text||null,date:change.date,notes:change.notes||null};
    const events=medEvents.map(ev=>ev.id===change.id&&ev.med_key===change.key?updated:ev);
    const all=recomputeMedsAfterEvents(medsAll,events,change.key);
    saveLifecycle(all,events);saveActiveMeds(medsActiveRows(all));
    enqueueSync({type:"med_event_update",id:change.id,key:change.key,new_ct:updated.new_ct,dose_text:updated.dose_text,date:updated.date,notes:updated.notes,actor:getDeviceActor()});
  };
  const doDeleteMedEvent=(id,key)=>{
    const events=medEvents.filter(ev=>ev.id!==id||ev.med_key!==key);
    const all=recomputeMedsAfterEvents(medsAll,events,key);
    const active=medsActiveRows(all);
    saveLifecycle(all,events);saveActiveMeds(active);
    enqueueSync({type:"med_event_delete",id,key,actor:getDeviceActor()});
  };
  const name=settings.name||"";

  // Save mood: update local state + push ONLY this one entry to sheets
  const doSaveMood=(newMood, changedDate)=>{
    setMood(newMood); saveMood(newMood);
    if(changedDate && newMood[changedDate]){
      markMoodTouched(changedDate);
      recordLogToday();
      pushMood(changedDate, newMood[changedDate], meds);
    }
  };
  // Delete mood: remove locally + tell sheets to delete that row
  const doDeleteMood=(date)=>{
    const n={...mood}; delete n[date]; setMood(n); saveMood(n);
    clearMoodTouched(date);
    pushDeleteMood(date);
  };
  const doMoveDay=(fromDate,toDate,force=false)=>{
    if(!fromDate||!toDate||fromDate===toDate) return false;
    const moodEntry=mood[fromDate];const srmEntry=srm[fromDate];
    if(!moodEntry&&!srmEntry?.items?.length) return false;
    if(!force&&(mood[toDate]||srm[toDate]?.items?.length)) return "occupied";
    if(force&&mood[toDate]&&!moodEntry){
      const n={...mood};delete n[toDate];setMood(n);saveMood(n);pushDeleteMood(toDate);
      clearMoodTouched(toDate);
    }
    if(force&&srm[toDate]?.items?.length&&!srmEntry?.items?.length){
      const n={...srm};delete n[toDate];setSrm(n);saveSRM(n);pushDeleteSrm(toDate);
      clearSrmTouched(toDate);
    }
    if(moodEntry){
      const ts=new Date().toISOString();
      const n={...mood};delete n[fromDate];n[toDate]={...moodEntry};
      setMood(n);saveMood(n);pushDeleteMood(fromDate);pushMood(toDate,n[toDate],meds);
      clearMoodTouched(fromDate);markMoodTouched(toDate,ts);
    }
    if(srmEntry?.items?.length){
      const ts=new Date().toISOString();
      const n={...srm};delete n[fromDate];n[toDate]={...srmEntry,items:[...srmEntry.items]};
      setSrm(n);saveSRM(n);pushDeleteSrm(fromDate);pushSrm(toDate,n[toDate].items);
      clearSrmTouched(fromDate);markSrmTouched(toDate,ts);
    }
    return true;
  };
  // Save SRM: update local state + push ONLY this date's items to sheets
  const doSaveSRM=(newSrm, changedDate)=>{
    setSrm(newSrm); saveSRM(newSrm);
    if(changedDate && newSrm[changedDate]){
      markSrmTouched(changedDate);
      recordLogToday();
      pushSrm(changedDate, newSrm[changedDate].items || []);
    }
  };
  // Delete SRM
  const doDeleteSrm=(date)=>{
    const n={...srm}; delete n[date]; setSrm(n); saveSRM(n);
    clearSrmTouched(date);
    pushDeleteSrm(date);
  };
  const hasMoodFields=entry=>!!(entry&&(
    moodsArr(entry).length||entry.sleep!=null||entry.anxiety!=null||entry.irritability!=null||
    entry.weight!=null||entry.notes||entryHasMedState(entry)
  ));
  const doReplaceMood=(date,entry)=>{
    if(!hasMoodFields(entry)){doDeleteMood(date);return;}
    doSaveMood({...mood,[date]:entry},date);
  };
  const doSaveMoodBatch=(changes)=>{
    const next={...mood};
    const pushes=[],deletes=[];
    changes.forEach(({date,entry})=>{
      if(!date)return;
      if(hasMoodFields(entry)){next[date]=entry;pushes.push({date,entry});}
      else{delete next[date];deletes.push(date);}
    });
    setMood(next);saveMood(next);
    pushes.forEach(({date,entry})=>{markMoodTouched(date);recordLogToday();pushMood(date,entry,meds);});
    deletes.forEach(date=>{clearMoodTouched(date);pushDeleteMood(date);});
  };
  const doReplaceSrm=(date,items)=>{
    if(!items.length){doDeleteSrm(date);return;}
    doSaveSRM({...srm,[date]:{...(srm[date]||{}),items}},date);
  };
  const moveSelectedDay=toDate=>{
    let moved=doMoveDay(selDay,toDate);
    if(moved==="occupied"&&confirm("That date already has a record — replace it?")) moved=doMoveDay(selDay,toDate,true);
    if(moved===true) setSelDay(toDate);
    return moved;
  };

  return(<>
    <style>{CSS}</style>
    <div className="app"><div className="page" key={["calendar","history","medications","settings"].includes(screen)?"home":screen}>
      {screen==="welcome"&&<Welcome name={name} onGo={()=>{if(settings.passcode){setScreen("lock");}else if(!consumePendingNav()){setScreen("calendar");}}}/>}
      {screen==="lock"&&<Lock passcode={settings.passcode} onOk={()=>{if(!consumePendingNav()) setScreen("calendar");}}/>}
      {["calendar","history","medications","settings"].includes(screen)&&<Cal mood={mood} srm={srm} medsAll={medsAll} medEvents={medEvents} vm={vm} setVm={setVm} name={name} setSelDay={setSelDay} onAdd={()=>setScreen("entry")} onLogForDay={k=>{setSelDay(k);setScreen("calEntry");}} onSrm={()=>setScreen("srm")} onHist={()=>setScreen("history")} onMeds={()=>setScreen("medications")} onSet={()=>setScreen("settings")} onViewDay={()=>setScreen("dayView")} onQuickMood={(k,mk)=>{const qe={...(mood[k]||{}),moods:[mk]};doSaveMood({...mood,[k]:qe},k);}} onQuickUndo={(k,prev)=>{if(prev){doSaveMood({...mood,[k]:prev},k);}else{const nm={...mood};delete nm[k];setMood(nm);saveMood(nm);clearMoodTouched(k);pushDeleteMood(k);}}}/>}
      {screen==="dayView"&&<DayView dk={selDay} mood={mood} srm={srm} meds={meds} medsAll={medsAll} medEvents={medEvents} onBack={()=>setScreen("calendar")}
        onDelDay={()=>{doDeleteMood(selDay);doDeleteSrm(selDay);setScreen("calendar");}}
        onMoveDay={moveSelectedDay}
        onSaveMoodEntry={entry=>doReplaceMood(selDay,entry)}
        onSaveSrmItems={items=>doReplaceSrm(selDay,items)}
        onEditMood={()=>setScreen("editDayMood")}
        onEditSRM={id=>{setSrmEditId(id);setScreen("editDaySrm");}}
        onLogMood={()=>setScreen("editDayMood")}/>}

      {screen==="editDayMood"&&<MoodEntry mood={mood} meds={meds} srm={srm} onSaveSRM={doSaveSRM} editKey={selDay} onSave={e=>{doSaveMood({...mood,[selDay]:e},selDay);setScreen("dayView");}} onMoveMood={to=>{if(moveSelectedDay(to)===true)setScreen("dayView");}} onX={()=>setScreen("dayView")}/>}
      {screen==="editDaySrm"&&<SRMSingle id={srmEditId} srm={srm} dateKey={selDay} onSave={item=>{const ex=srm[selDay]||{items:[]};const items=[...ex.items.filter(i=>i.id!==item.id),item];const ns={...srm,[selDay]:{items}};doSaveSRM(ns,selDay);setScreen("dayView");}} onX={()=>setScreen("dayView")}/>}
      {screen==="entry"&&<MoodEntry mood={mood} meds={meds} srm={srm} onSaveSRM={doSaveSRM} onSave={(e,k,splitMeds)=>{splitMeds?doSaveMoodBatch([{date:splitMeds.yesterdayDate,entry:splitMeds.yesterdayEntry},{date:k,entry:e}]):doSaveMood({...mood,[k]:e},k);setScreen("confirm");}} onX={()=>setScreen("calendar")}/>}
      {screen==="srm"&&<SRMPicker srm={srm} srmDate={srmDate} setSrmDate={setSrmDate} onPick={id=>{setSrmEditId(id);setScreen("srmEdit");}} onX={()=>setScreen("calendar")}/>}
      {screen==="srmEdit"&&<SRMSingle id={srmEditId} srm={srm} dateKey={srmDate} onSave={item=>{const k=srmDate;const ex=srm[k]||{items:[]};const items=[...ex.items.filter(i=>i.id!==item.id),item];const ns={...srm,[k]:{items}};doSaveSRM(ns,k);setScreen("srm");}} onX={()=>setScreen("srm")}/>}
      {screen==="confirm"&&<Confirm msg="Mood entry logged" sub="You showed up today. That matters." onDone={()=>setScreen("calendar")}/>}
      {screen==="calEntry"&&<MoodEntry mood={mood} meds={meds} srm={srm} onSaveSRM={doSaveSRM} lockedDate={selDay} onSave={(e,k)=>{doSaveMood({...mood,[k]:e},k);setScreen("confirm");}} onX={()=>setScreen("calendar")}/>}
      {screen==="history"&&<Hist mood={mood} srm={srm} name={name} meds={meds} onBack={()=>setScreen("calendar")} onSendReport={()=>{if(!SHEETS_URL||!settings.reportEmail)return;const u=`${SHEETS_URL}?action=send_report&email=${encodeURIComponent(settings.reportEmail)}&name=${encodeURIComponent(settings.name||"")}`;fetch(u,{method:"GET",cache:"no-store"}).catch(()=>{});}} reportEmail={settings.reportEmail||""}/>}
      {screen==="medications"&&<Medications medsAll={medsAll} medEvents={medEvents} mood={mood} onCreate={doCreateMed} onUpdateMeta={doUpdateMedMeta} onEvent={doMedEvent} onUpdateEvent={doUpdateMedEvent} onDeleteEvent={doDeleteMedEvent} onBack={()=>setScreen("calendar")}/>}
      {screen==="settings"&&<Settings settings={settings} setS={setS} onBack={()=>setScreen("calendar")}/>}
    </div></div>
  </>);
}

const CAT_PATH_MAIN="M373.56,317.01c5.5,0,11.17,.86,16.48-.16,16.13-3.12,32.14-6.91,48.17-10.56,12.87-2.93,25.78-5.57,39.08-4.85,16.48,.9,30.11,6.89,37.72,22.56,5.23,10.77,5.09,22.07,2.21,33.42-4.25,16.73-13.72,30.36-25.84,42.25-17.73,17.4-39.19,28.49-62.49,36.39-1.42,.48-2.82,1-3.63,1.29,.92,8.27,2.11,16.12,2.55,24.02,.23,4.1-.46,8.36-1.39,12.4-5.16,22.46-26.53,32.03-46.85,21.04-12.04-6.51-21.28-16.25-29.97-26.57-3.1-3.68-6.12-7.44-8.89-11.38-1.43-2.03-2.94-2.57-5.34-2.55-18.49,.09-36.98,.02-55.47-.02-1.01,0-2.08,.09-3.03-.19-8.76-2.61-14.46,1.03-20.33,7.65-16.64,18.79-34.26,36.72-55,51.14-5.36,3.72-11.21,7.04-17.29,9.36-19.77,7.53-37.21-4.31-36.77-25.41,.18-8.83,2.02-17.95,4.88-26.33,4.28-12.53,10.13-24.52,15.32-36.74,.34-.8,.7-1.59,1.19-2.71-2.79-1.2-5.43-2.31-8.06-3.47-26.13-11.55-47.83-28.42-63.08-52.91-27.65-44.41-20.84-102.82,16.13-140.47,14.51-14.78,31.28-26.09,50.4-33.89,3.44-1.41,4.88-3.16,5.06-7.17,1.27-28.78,3.84-57.42,13.03-84.96,2.06-6.18,4.9-12.27,8.33-17.81,10.57-17.09,29.92-19.74,45.26-6.59,8.72,7.48,14.65,17.05,20.05,27.01,10.28,18.98,18.22,38.98,25.65,59.18,1.04,2.83,2.2,3.42,5.12,3.27,21.56-1.08,43.08-.51,64.51,2.29,5.78,.75,5.75,.84,8.39-4.55,9.72-19.8,19.61-39.53,33.54-56.81,3.87-4.8,8.21-9.41,13.06-13.17,18.73-14.52,40.16-9.17,50.27,12.28,5.89,12.48,8.98,25.78,11.24,39.3,3.15,18.84,3.81,37.82,2.52,56.85-.92,13.55-7.2,24.91-15.68,35.16-11.9,14.39-26.72,25.49-41.53,36.6-10.23,7.67-20.39,15.46-30.3,23.55-3.74,3.05-6.66,7.1-9.96,10.69l.75,1.57ZM215.49,103.87c-1.57,3.26-2.88,5.29-3.56,7.51-2.42,7.98-5.09,15.93-6.83,24.07-4.97,23.12-6.68,46.63-7.35,70.22-.24,8.45-3.98,13.99-12.05,16.95-12.88,4.72-25.18,10.63-36.27,18.87-21.54,16-35.72,36.67-38.67,63.69-3.6,32.9,9.43,59.04,34.66,79.56,13.97,11.36,30.25,18.32,47.22,23.82,8.31,2.69,12.94,9.14,11.44,17.23-.67,3.61-2.86,6.96-4.47,10.37-6.16,13.03-12.64,25.92-18.42,39.12-2.49,5.69-3.57,11.99-5.29,18.02,.35,.2,.71,.41,1.06,.61,1.3-.69,2.69-1.24,3.87-2.09,5.84-4.23,12.21-7.95,17.32-12.94,16.58-16.19,32.76-32.8,48.94-49.41,3.66-3.76,7.59-6.27,12.93-6.03,2.28,.11,4.54,.41,6.81,.66,24.13,2.69,48.34,3.61,72.47,.89,9.86-1.11,16.37,1.61,21.7,9.97,7.24,11.35,16.04,21.57,26.5,30.17,2.58,2.12,5.64,3.66,9.19,5.92,.64-3.32,1.32-5.74,1.55-8.2,1.24-12.97-3.88-23.88-11.83-33.5-13.13-15.9-30.19-25.99-49.72-32.11-19.69-6.17-39.55-6.6-59.66-2-8.67,1.98-16.08-3.33-17.7-11.87-1.43-7.55,3.83-14.79,12.11-16.58,16.49-3.56,33.13-4.65,49.87-2.33,34.23,4.75,63.63,18.88,86.52,45.31,1.44,1.66,2.66,1.92,4.55,1.23,6.41-2.36,12.95-4.39,19.26-7,17.67-7.3,33.65-17.13,45.82-32.25,6.44-8,11.27-16.83,12.49-27.26,.86-7.38-2.33-12.02-9.53-13.55-8.38-1.78-16.71-.54-24.87,1.29-16.05,3.59-31.96,7.83-48.02,11.36-12.54,2.75-25.29,4.45-38.09,1.9-11.93-2.37-21.22-8.28-24.71-20.79-2.6-9.33,.11-17.83,4.84-25.76,5.82-9.76,14.38-16.99,23.24-23.8,10.95-8.42,22.38-16.23,33.1-24.91,8.94-7.23,17.48-15.03,25.6-23.17,6.95-6.96,10.5-15.77,10.11-25.83-.5-12.65-.52-25.35-1.76-37.93-1.27-12.85-4.09-25.5-9.34-37.44-2.09-4.75-3.6-5.3-7.1-1.61-4.94,5.21-10.15,10.52-13.64,16.69-10.39,18.39-20.07,37.18-29.87,55.89-3.82,7.31-9.63,10.49-17.73,9.15-28.29-4.69-56.73-5.41-85.28-3.25-9.72,.74-15.36-2.69-18.75-11.74-3.77-10.07-7.43-20.19-11.46-30.16-6.51-16.08-13.28-32.07-22.83-46.66-2.23-3.41-5.15-6.36-8.4-10.3Z";
const CAT_PATH_FACE="M237.8,250.44c6.84-.03,13.42,1.44,19.32,4.79,2.78,1.58,4.34,.93,6.63-.65,14.6-10.05,29.85-10.97,45.43-2.45,6.72,3.67,11.66,9.32,15.21,16.06,4.06,7.7,1.65,15.98-5.59,19.99-6.94,3.85-15.14,1.41-19.59-5.84-4.31-7.01-11.23-9.26-17.6-5.2-2.14,1.37-4.01,3.88-4.96,6.28-2.43,6.17-6.64,9.91-13.12,10.58-6.37,.67-11.22-2.15-14.58-7.66-3.83-6.29-8.54-8.25-14.86-6.53-3.87,1.06-6.34,3.39-7.55,7.24-2.75,8.7-10.54,12.93-18.65,10.24-7.93-2.64-11.86-11.43-8.86-19.86,5.87-16.53,21.03-27.09,38.77-27.02Z";
function CatMark({className="",draw=false}){
  if(draw) return(<svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" aria-hidden="true"><path className="w-draw" fill="none" stroke="currentColor" strokeWidth="4" d={CAT_PATH_MAIN}/><path className="w-draw w-draw2" fill="none" stroke="currentColor" strokeWidth="4" d={CAT_PATH_FACE}/></svg>);
  return(<svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" aria-hidden="true"><path fill="currentColor" d={CAT_PATH_MAIN}/><path fill="currentColor" d={CAT_PATH_FACE}/></svg>);
}

/* ── WELCOME ── */
function Welcome({name,onGo}){
  const[greet]=useState(()=>GREETS[Math.floor(Math.random()*GREETS.length)](name));
  const onKeyDown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onGo();}};
  const goRef=useRef(onGo);
  useEffect(()=>{goRef.current=onGo;});
  useEffect(()=>{const t=setTimeout(()=>goRef.current(),5000);return()=>clearTimeout(t);},[]);
  return(<div className="scr g-welcome g-grain" role="button" tabIndex={0} onClick={onGo} onKeyDown={onKeyDown} aria-label="Enter app">
    <div className="g-welcome-sky"/>
    <div className="g-welcome-bubbles"><span className="g-wb"/><span className="g-wb"/><span className="g-wb"/></div>
    <div className="g-welcome-center">
      <div className="g-welcome-cat"><CatMark /></div>
      <p className="g-welcome-greet">{greet}</p>
    </div>
    <span className="g-welcome-cue" aria-hidden="true"/>
  </div>);
}

/* ── LOCK — balanced keypad ── */
function Lock({passcode,onOk}){
  const[input,setInput]=useState("");const[err,setErr]=useState(false);const[shake,setShake]=useState(false);
  const tap=n=>{if(input.length>=4)return;const nx=input+n;setInput(nx);setErr(false);
    if(nx.length===4){if(nx===passcode)setTimeout(onOk,200);else{setShake(true);setErr(true);setTimeout(()=>{setInput("");setShake(false);},500);}}};
  return(<div className="scr g-lock-scr">
    <div className="g-lock-in">
      <div className="g-lock-mark"><CatMark /></div>
      <p className={`g-lock-lbl${err?" err":""}`}>{err?"Incorrect passcode":"Enter passcode"}</p>
      <div className={`g-lock-dots${shake?" g-lock-shake":""}`}>{[0,1,2,3].map(i=><div key={i} className={`g-lock-dot${i<input.length?" on":""}`}/>)}</div>
      <div className="g-lock-pad">
        {[1,2,3,4,5,6,7,8,9].map((n)=>(
          <button key={n} className="g-lk" onClick={()=>tap(String(n))}>{n}</button>
        ))}
        <button className="g-lk g-lk-fn" onClick={()=>setInput("")} aria-label="Clear">Clear</button>
        <button className="g-lk" onClick={()=>tap("0")}>0</button>
        <button className="g-lk g-lk-fn" onClick={()=>setInput(input.slice(0,-1))} aria-label="Delete">⌫</button>
      </div>
    </div>
  </div>);
}

/* ── CALENDAR ── */
function Cal({mood,srm,medsAll,medEvents,vm,setVm,name,setSelDay,onAdd,onLogForDay,onSrm,onHist,onMeds,onSet,onViewDay,onQuickMood,onQuickUndo}){
  const[bubble,setBubble]=useState(null);
  const[toast,setToast]=useState(null);
  const swipeStart=useRef(null);
  const[navDir,setNavDir]=useState("");
  const[recentLimit,setRecentLimit]=useState(5);
  const[recentLoading,setRecentLoading]=useState(false);
  const recentLoadingRef=useRef(false);
  const[yearView,setYearView]=useState(false);
  const doQuickSave=(k,mk)=>{const prev=mood[k];onQuickMood(k,mk);setBubble(null);setToast({key:k,prev});};
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(null),4500);return()=>clearTimeout(t);},[toast]);
  const[y,m]=vm;const days=dIn(y,m);const off=fDay(y,m);
  const prevMonth=()=>{setBubble(null);setNavDir("prev");setVm(m===0?[y-1,11]:[y,m-1]);};
  const nextMonth=()=>{setBubble(null);setNavDir("next");setVm(m===11?[y+1,0]:[y,m+1]);};
  const onCalTouchStart=ev=>{const t=ev.touches[0];if(t)swipeStart.current={x:t.clientX,y:t.clientY};};
  const onCalTouchEnd=ev=>{const start=swipeStart.current;swipeStart.current=null;const t=ev.changedTouches[0];if(!start||!t)return;const dx=t.clientX-start.x;const dy=t.clientY-start.y;if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)*1.5){if(dx<0)nextMonth();else prevMonth();}};
  const[ty,tm,td0]=weiYMD();const td=ty===y&&tm===m?td0:-1;
  const cells=[];
  for(let i=0;i<off;i++) cells.push(<div key={`b${i}`} className="cc ce"/>);
  for(let d=1;d<=days;d++){
    const k=dk(y,m,d);const e=mood[k];const s=srm[k];
    const hasRegimen=medEvents.some(ev=>ev.date===k);
    const hasIrregularMeds=hasIrregularMedsForDate(e,medsAll,medEvents,k);
    const isT=d===td;const hasData=e||s||hasRegimen;
    const pm=primaryMood(e);const isFuture=k>tdk();
    cells.push(<div key={d} className={`cc${hasData?" cl":""}${isT?" ct":""}${bubble?.key===k?" cc-open":""}${isFuture?" cc-future":""}`}
      onClick={(ev)=>{if(bubble){setBubble(null);return;}if(isFuture)return;const rect=ev.currentTarget.getBoundingClientRect();setBubble({key:k,rect});}}>
      {pm&&<div className={`g-cal-glow ${G_MOOD_CLASS[pm]}`}/>}
      {(s||hasRegimen||hasIrregularMeds)&&<div className="c-cal-ticks">{s&&<span className="c-srm-tick"/>}{hasRegimen&&<span className="c-med-tick"/>}{hasIrregularMeds&&<span className="c-med-irregular-tick"/>}</div>}
      <span className="cn">{d}</span>
    </div>);
  }
  const todayLogged=!!(mood[tdk()]||srm[tdk()]?.items?.length);
  // Recent = days Wei actually wrote a note (words-only, gentle-by-default — no mood-only rows, no nudge).
  const recentEntries=Object.entries(mood||{}).filter(([rk,en])=>/^\d{4}-\d{2}-\d{2}$/.test(rk)&&typeof en.notes==="string"&&en.notes.trim()).sort(([a],[b])=>b.localeCompare(a));
  const recentShown=recentEntries.slice(0,recentLimit);
  const onRecentScroll=e=>{const el=e.currentTarget;if(recentLoadingRef.current||recentLimit>=recentEntries.length)return;if(el.scrollTop+el.clientHeight>=el.scrollHeight-56){recentLoadingRef.current=true;setRecentLoading(true);const reduce=typeof window!=="undefined"&&window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;setTimeout(()=>{setRecentLimit(n=>Math.min(n+5,recentEntries.length));setRecentLoading(false);recentLoadingRef.current=false;},reduce?120:520);}};
  const gr=()=>{const h=Number(weiHM().slice(0,2));return h<12?"Good morning":h<17?"Good afternoon":"Good evening";};

  const renderBubbleLayer=()=>(<>
    {bubble&&<div className="g-bubble-scrim" onClick={()=>setBubble(null)}/>}
    {bubble&&(()=>{
      const k=bubble.key;const en=mood[k];const s2=srm[k];const pmk=primaryMood(en);
      const[bky,bkm,bkd]=k.split("-").map(Number);const bdow=new Date(bky,bkm-1,bkd).getDay();
      const dlabel=`${k===tdk()?"Today":k===ydk()?"Yesterday":DW[bdow]} · ${MO[bkm-1].slice(0,3)} ${bkd}`;
      const bw=232;const vw=typeof window!=="undefined"?window.innerWidth:390;
      const left=Math.max(10,Math.min(vw-bw-10,bubble.rect.left+bubble.rect.width/2-bw/2));
      const top=bubble.rect.bottom+9;
      const caretLeft=bubble.rect.left+bubble.rect.width/2-left-6;
      const medCt=en?.meds?Object.values(en.meds).filter(medHasDailyState).length:0;
      const regimenEvents=medEvents.filter(ev=>ev.date===k);
      const hasExtras=!!(en&&(en.sleep!=null||medCt||en.notes||s2||regimenEvents.length));
      const srmMoments=(s2?.items||[]).filter(it=>!it.didNot);
      const srmSorted=[...srmMoments].sort((a,b)=>String(a.time?to24h(normTime(a.time),a.am):"99:99").localeCompare(String(b.time?to24h(normTime(b.time),b.am):"99:99")));
      const fmtMoment=(it)=>{const ph=SRM_PHRASE[it.id]||SRM_ACT.find(a=>a.id===it.id)?.label||it.id;const t=it.time?fmt12h(to24h(normTime(it.time),it.am)):"";return t?`${ph} ${t}`:ph;};
      return(<div className="g-bubble" style={{top,left,width:bw}}>
        <div className="g-bubble-caret" style={{left:caretLeft}}/>
        {!pmk&&srmMoments.length?(<>
          <button className="g-bubble-open" onClick={()=>{setBubble(null);setSelDay(k);onViewDay();}}>
            <span className="g-bubble-date">{dlabel}</span>
            {srmMoments.length>=3
              ? <span className="g-bubble-rhythm">{srmMoments.length} rhythm moments</span>
              : <span className="g-bubble-rhythm">{fmtMoment(srmSorted[0])}{srmSorted[1]&&<span className="g-bubble-rsub">{fmtMoment(srmSorted[1])}</span>}</span>}
          </button>
          <div className="g-bubble-prompt g-bubble-prompt-small">Add a mood</div>
          <div className="g-bubble-pick">{MOOD_PICKER_ORDER.map(mk=><button key={mk} className={`g-bubble-dot ${G_MOOD_CLASS[mk]}`} onClick={()=>doQuickSave(k,mk)} aria-label={MM[mk].label}/>)}</div>
          <div className="g-bubble-ends"><span>low</span><span>high</span></div>
        </>):!pmk?(<>
          <div className="g-bubble-date">{dlabel}</div>
          <div className="g-bubble-prompt">{k===tdk()?"How was today?":"How was it?"}</div>
          <div className="g-bubble-pick">{MOOD_PICKER_ORDER.map(mk=><button key={mk} className={`g-bubble-dot ${G_MOOD_CLASS[mk]}`} onClick={()=>doQuickSave(k,mk)} aria-label={MM[mk].label}/>)}</div>
          <div className="g-bubble-ends"><span>low</span><span>high</span></div>
          <div className="g-bubble-mini"><button className="g-bubble-go" onClick={()=>{setBubble(null);onLogForDay(k);}}>Log more →</button></div>
        </>):(<>
          <button className="g-bubble-open" onClick={()=>{setBubble(null);setSelDay(k);onViewDay();}}>
            <span className="g-bubble-date">{dlabel}</span>
            <span className="g-bubble-mood"><span className="g-bubble-cdot" style={{background:`var(--${G_MOOD_CLASS[pmk]})`}}/><span className="g-bubble-clabel">{moodLabel(en)} <small>{MM[pmk].v>0?`+${MM[pmk].v}`:MM[pmk].v}</small></span></span>
          </button>
          {hasExtras?<div className="g-bubble-sum">{[en.sleep!=null?`${en.sleep}h`:null,medCt?`${medCt} meds`:null,en.notes?"note":null,s2?"rhythm":null].filter(Boolean).join(" · ")}</div>:<div className="g-bubble-caps">Sleep · Meds · Note · Rhythm</div>}
        </>)}
          {regimenEvents[0]&&<div className="g-bubble-regimen"><i/>{regimenBubbleLabel(regimenEvents[0],medsAll)}</div>}
      </div>);
    })()}
  </>);

  if(yearView){
    const[curY,curM,curD]=weiYMD();
    const firstKey=Object.keys(mood||{}).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort()[0];
    const[firstY,firstM]=firstKey?firstKey.split("-").map(Number):[curY,curM+1];
    const months=[];
    for(let yy=firstY,mm=firstM-1;yy<curY||yy===curY&&mm<=curM;){
      months.push({year:yy,month:mm});
      if(mm===11){yy++;mm=0;}else mm++;
    }
    return(<div className="scr g-year g-ambient-sky g-grain">
      <button className="g-year-back" onClick={()=>setYearView(false)}>‹ Back</button>
      <p className="g-year-sub">A year has seasons. This is yours.</p>
      <div className="g-year-wrap">
        {months.map(({year:yy,month:mm},index)=>{
          const dim=new Date(yy,mm+1,0).getDate();
          const offset=(new Date(yy,mm,1).getDay()+6)%7;
          const ucells=[];let hasAny=false;
          for(let i=0;i<offset;i++)ucells.push(<div key={`b${i}`} className="g-year-cell"/>);
          for(let d=1;d<=dim;d++){
            const k=dk(yy,mm,d);const en=mood[k];const ms=moodsArr(en);
            const tappable=ms.length>0&&k<=tdk();if(tappable)hasAny=true;
            const isTd=yy===curY&&mm===curM&&d===curD;
            const fill=ms.length>=2?`linear-gradient(135deg, var(--${G_MOOD_CLASS[ms[0]]}) 0 50%, var(--${G_MOOD_CLASS[ms[1]]}) 50% 100%)`:ms.length?`var(--${G_MOOD_CLASS[ms[0]]})`:null;
            ucells.push(<div key={d} className={`g-year-cell${tappable?" has":""}${isTd?" today":""}`}
              onClick={tappable?(ev=>{const rect=ev.currentTarget.getBoundingClientRect();setBubble({key:k,rect});}):undefined}>
              {tappable&&<div className="g-year-dot" style={{background:fill}}/>}
            </div>);
          }
          const isNow=yy===curY&&mm===curM;
          return(<Fragment key={`${yy}-${mm}`}>
            {(index===0||months[index-1].year!==yy)&&<h1 className="g-year-h1 g-year-divider">{yy}</h1>}
            <div className={`g-year-mini${isNow?" now":""}${!hasAny&&!isNow?" g-year-empty":""}`}>
            <div className="g-year-mname">{MO[mm].slice(0,3)}</div>
            <div className="g-year-grid">{ucells}</div>
            </div>
          </Fragment>);
        })}
      </div>
      {renderBubbleLayer()}
    </div>);
  }

  return(<div className="scr g-home g-ambient-sky g-grain">
    <div className="cal-top">
      <div className="cal-mast"><p className="cal-gr">{gr()}{name?`, ${name}`:""}</p><h2 className={`cht${navDir?` cht-${navDir}`:""}`} key={`${y}-${m}`}>{MO[m]} <button className="g-home-yearbtn" onClick={()=>setYearView(true)}>{y}</button></h2></div>
      <div className="cal-tr"><SyncBadge/></div>
    </div>
    <div className={`cg${navDir?` cg-${navDir}`:""}`} key={`${y}-${m}`} onTouchStart={onCalTouchStart} onTouchEnd={onCalTouchEnd}>{DW.map(d=><div key={d} className="clb">{d}</div>)}{cells}</div>
    {recentEntries.length>0&&<div className="g-home-recent" onScroll={onRecentScroll}>
      <span className="g-home-recent-eyebrow">Recent</span>
      {recentShown.map(([rk,en])=>{const pmk=primaryMood(en);const[ry,rm,rd]=rk.split("-").map(Number);const rdow=new Date(ry,rm-1,rd).getDay();const rel=rk===tdk()?"Today":rk===ydk()?"Yesterday":DW[rdow];return(<div key={rk} className="g-home-r-item" onClick={()=>{setSelDay(rk);onViewDay();}}>
        <span className="g-home-r-dot" style={{background:pmk?`var(--${G_MOOD_CLASS[pmk]})`:"var(--g-tx4)"}}/>
        <div className="g-home-r-body"><div className="g-home-r-day">{rel} <em>· {MO[rm-1].slice(0,3)} {rd}</em></div>{en.notes&&<div className="g-home-r-note">{en.notes}</div>}</div>
      </div>);})}
      {recentLimit<recentEntries.length&&<div className="g-home-r-more">{recentLoading?<span className="g-home-r-load" aria-label="Loading more"><i/><i/><i/></span>:"Scroll for more"}</div>}
    </div>}

    {renderBubbleLayer()}
    {toast&&<div className="g-toast"><span className="g-toast-msg">Logged ✓</span><button className="g-toast-undo" onClick={()=>{onQuickUndo(toast.key,toast.prev);setToast(null);}}>Undo</button></div>}
    <div className="cal-pad"/>
    <div className="cact g-home-actions">
      <button className="g-home-log-btn" onClick={()=>{if(todayLogged){setSelDay(tdk());onViewDay();}else onAdd();}}>{todayLogged?"Today's log ✓":"Log today"}</button>
      <button className="g-home-srm-btn" onClick={onSrm}>{srm[tdk()]?"Edit rhythm moments":"Add a rhythm moment"}</button>
      <div className="g-home-nav">
        <button className="active">Month</button>
        <button onClick={onHist}>Insights</button>
        <button onClick={onMeds}>Meds</button>
        <button onClick={onSet}>Settings</button>
      </div>
    </div>
  </div>);
}

/* ── DAY VIEW — with edit and delete ── */
function DayView({dk:dateKey,mood,srm,meds,medsAll,medEvents,onBack,onDelDay,onMoveDay,onSaveMoodEntry,onSaveSrmItems,onEditMood,onEditSRM,onLogMood}){
  const[confirmDel,setConfirmDel]=useState(null);
  const[editMode,setEditMode]=useState(false);
  const[undo,setUndo]=useState(null);
  const e=mood[dateKey];const s=srm[dateKey];
  const[yr,mo,dy]=(dateKey||"2026-01-01").split("-").map(Number);
  const _dow=new Date(yr,mo-1,dy).getDay();
  const wkFull='Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'.split(',')[_dow];
  const kicker=`${wkFull} · ${MO[mo-1]} ${dy}`;
  const pm=primaryMood(e);
  const HERO_GRAD={
    dep:`radial-gradient(120% 66% at 50% 100%, rgba(216,205,232,.55) 0%, transparent 60%),
         linear-gradient(180deg, #BFC0E0 0%, #A9AAD2 46%, #BFB3CE 76%, #D8AE94 100%)`,
    neutral:`radial-gradient(120% 66% at 50% 100%, rgba(216,205,232,.55) 0%, transparent 60%),
             linear-gradient(180deg, #C9C3DE 0%, #B6B4D6 48%, #CDB6C0 78%, #E0A878 100%)`,
    elev:`radial-gradient(120% 70% at 50% 100%, rgba(240,200,150,.60) 0%, transparent 62%),
          linear-gradient(180deg, #CDC6DC 0%, #C9B9C4 44%, #E2B58E 74%, #EE9A52 100%)`,
  };
  const heroBand=!pm?"neutral":(MM[pm].v<0?"dep":MM[pm].v>0?"elev":"neutral");
  const heroBg=HERO_GRAD[heroBand];
  const srmItems=s?[...s.items].filter(it=>!it.didNot).sort((a,b)=>{const ta=a.time?to24h(normTime(a.time),a.am):"99:99";const tb=b.time?to24h(normTime(b.time),b.am):"99:99";return String(ta).localeCompare(String(tb));}):[];
  const setUndoAction=(label,run)=>setUndo({label,run});
  const clearMoodField=(field,medKey)=>{
    if(!e)return;
    const prev={...e,meds:{...(e.meds||{})},moods:moodsArr(e)};
    const next={...prev};
    if(field==="meds"){next.meds={...next.meds};delete next.meds[medKey];}
    else if(field==="moods") next.moods=[];
    else{next[field]=field==="notes"?"":null;if(field==="sleep")next.sleeps=null;}
    onSaveMoodEntry(next);
    const labels={moods:"Mood",sleep:"Sleep",anxiety:"Anxiety",irritability:"Irritability",weight:"Weight",notes:"Note"};
    setUndoAction(field==="meds"?(meds.find(m=>m.key===medKey)?.name||"Medication"):labels[field],()=>onSaveMoodEntry(prev));
  };
  const clearSrmItem=id=>{
    const prev=[...(s?.items||[])];
    const item=prev.find(it=>it.id===id);const ac=SRM_ACT.find(a=>a.id===id);
    onSaveSrmItems(prev.filter(it=>it.id!==id));
    setUndoAction(ac?.label||item?.id||"Rhythm moment",()=>onSaveSrmItems(prev));
  };
  const renderClear=(onClick,label)=>editMode?<button className="g-day-clear" aria-label={`Clear ${label}`} onClick={ev=>{ev.stopPropagation();onClick();}}>×</button>:null;
  const routineMeds=e&&hasPositiveMedLog(e)?routineMedsAsOfDate(medsAll,medEvents,dateKey):[];
  const routineByKey=Object.fromEntries(routineMeds.map(med=>[med.key,med]));
  const medForDayKey=k=>routineByKey[k]||medByKey(medsAll,k)||meds.find(m=>m.key===k)||{key:k,name:k};
  const dayMeds=e?[...new Set([...Object.keys(e.meds||{}).filter(k=>medHasDailyState(e.meds[k])),...routineMeds.filter(med=>e.meds?.[med.key]===undefined||normalizeDailyMedState(e.meds?.[med.key]).ct<=0).map(med=>med.key)])].sort((a,b)=>medTimelineIndex(medForDayKey(a))-medTimelineIndex(medForDayKey(b))||String(a).localeCompare(String(b))):[];
  return(<div className="scr g-day">
    <div className="g-day-hero" style={{background:heroBg}}>
      <button className="g-day-close" onClick={onBack}>×</button>
      <div className="g-day-hero-cap">
        <div className="g-day-kick">{kicker}</div>
        <div className="g-day-word">{pm?moodLabel(e):(e?"Logged":s?"SRM logged":"No entry")}</div>
      </div>
    </div>
    <div className={`g-day-body${editMode?" g-day-editing":""}`}>
      {!e&&onLogMood&&<button className="g-day-edit-btn" style={{marginBottom:18}} onClick={onLogMood}>Log full day entry</button>}
      {(e||s)&&<><div className="g-day-rowhead"><span className="g-day-eyebrow">Day log</span><button className="g-day-inline-edit" onClick={()=>setEditMode(v=>!v)}>{editMode?"Done":"Edit"}</button></div><div className="g-day-hair"/></>}
      {e&&<>
        <div className="g-day-vit">
          <div className="g-day-cell">{pm&&renderClear(()=>clearMoodField("moods"),"mood")}<span className="g-day-k">Mood</span><div className="g-day-v">{pm?moodLabel(e):"—"}{pm&&<small> {MM[pm].v>0?`+${MM[pm].v}`:MM[pm].v}</small>}</div></div>
          <div className="g-day-cell">{e.sleep!=null&&renderClear(()=>clearMoodField("sleep"),"sleep")}<span className="g-day-k">Sleep</span><div className="g-day-v">{e.sleep!=null?<>{e.sleep}<small> hrs</small></>:"—"}</div>{sleepMultiCue(e.sleeps)&&<div className="slp-read-cue">{sleepMultiCue(e.sleeps)}</div>}</div>
          <div className="g-day-cell">{e.anxiety!=null&&renderClear(()=>clearMoodField("anxiety"),"anxiety")}<span className="g-day-k">Anxiety</span><div className="g-day-v">{e.anxiety!=null?<>{SEV[e.anxiety].l}<small> {e.anxiety}/3</small></>:"—"}</div>{e.anxiety!=null&&<div className="g-day-scale">{[0,1,2].map(i=><i key={i} className={i<e.anxiety?"on":""}/>)}</div>}</div>
          <div className="g-day-cell">{e.irritability!=null&&renderClear(()=>clearMoodField("irritability"),"irritability")}<span className="g-day-k">Irritability</span><div className="g-day-v">{e.irritability!=null?<>{SEV[e.irritability].l}<small> {e.irritability}/3</small></>:"—"}</div>{e.irritability!=null&&<div className="g-day-scale">{[0,1,2].map(i=><i key={i} className={i<e.irritability?"on":""}/>)}</div>}</div>
        </div>
        {e.weight!=null&&<><div className="g-day-hair"/><div className="g-day-block">{renderClear(()=>clearMoodField("weight"),"weight")}<span className="g-day-k">Weight</span><div className="g-day-v">{e.weight}<small> kg</small></div></div></>}
        {e.notes&&<><div className="g-day-hair"/><div className="g-day-block">{renderClear(()=>clearMoodField("notes"),"note")}<span className="g-day-k">Note</span><p className="g-day-note">{e.notes}</p></div></>}
        {dayMeds.length>0&&<><div className="g-day-hair"/><div className="g-day-block"><span className="g-day-k">Medication</span><div className="g-day-meds">{dayMeds.map(k=>{const med=medForDayKey(k);const hasRaw=e.meds?.[k]!==undefined;const state=hasRaw?normalizeDailyMedState(e.meds?.[k]):{ct:0,off:false};const kind=medStateKind(state);const name=medPrimary(med,k);const when=medWhenLabel(med);return(<div key={k} className={`g-day-med-row ${kind}`}><span className="dotcol"><i/></span><div className="mtxt"><div className="mt1"><span className="nm">{name}</span><span className="ds">{medDoseQtyLabel(med,kind==="missed"?(med?.default_ct??med?.defaultCt??state.ct):state.ct)}</span>{when&&<span className="when-tag">{when}</span>}{hasRaw&&renderClear(()=>clearMoodField("meds",k),name)}</div>{kind==="off"&&<div className="mchip"><span className="flag">off schedule</span></div>}{kind==="missed"&&<div className="mchip"><span className="flag">not taken</span></div>}{state.note&&<div className="mnote">{state.note}</div>}</div></div>);})}</div><div className="g-day-med-key"><span><i className="off"/>off schedule</span><span><i className="miss"/>missed</span></div></div></>}
      </>}
      {srmItems.length>0&&<><div className="g-day-hair"/><div className="g-day-block"><span className="g-day-k">Social rhythm</span>
        <div className="g-day-tl">{srmItems.map(it=>{const ac=SRM_ACT.find(a=>a.id===it.id)||{label:it.id};const t=it.time?fmt12h(to24h(normTime(it.time),it.am)):"";return(<div key={it.id} className="g-day-tl-item" onClick={()=>{if(!editMode)onEditSRM(it.id);}}>
          <div className="g-day-tl-time">{t||"—"}</div><div className="g-day-tl-dot"/><div className="g-day-tl-label">{ac.label}{it.withOthers?<span className="g-day-tl-tag"> · social</span>:""}</div>
          {renderClear(()=>clearSrmItem(it.id),ac.label)}
        </div>);})}</div></div></>}
      {pm&&<><div className="g-day-hair"/><div className="g-day-block"><span className="g-day-k">Where the day landed</span>
        <div className="g-day-spectrum"><div className="g-day-spectrum-knob" style={{left:`${Math.max(0,Math.min(100,((moodValue(e)+3)/6)*100))}%`}}/></div>
        <div className="g-day-spectrum-ends"><span>depressed</span><span>elevated</span></div>
      </div></>}
      {!e&&!s&&<p className="g-day-empty">No data for this day.</p>}
      {undo&&<div className="g-day-undo"><span>{undo.label} cleared</span><button onClick={()=>{undo.run();setUndo(null);}}>Undo</button></div>}
      {editMode&&(e||s)&&<div className="g-day-manage">
        {e&&<button className="g-day-mrow" onClick={onEditMood}><span className="ic">✎</span>Re-enter values</button>}
        <button className="g-day-mrow" onClick={()=>{const v=prompt("Move day to date (YYYY-MM-DD):",dateKey);if(v&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v!==dateKey)onMoveDay(v);}}><span className="ic">→</span>Move to another date…</button>
        {confirmDel==="day"
          ? <div className="g-day-manage-confirm"><span>Delete this entire day?</span><button className="g-day-confirm-yes" onClick={()=>onDelDay()}>Delete</button><button className="g-day-confirm-no" onClick={()=>setConfirmDel(null)}>Cancel</button></div>
          : <button className="g-day-mrow g-day-mrow-danger" onClick={()=>setConfirmDel("day")}><span className="ic">⌫</span>Delete this day</button>}
      </div>}
    </div>
  </div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOOD ENTRY
   ═══════════════════════════════════════════════════════════════════════════ */
const MSTEPS=[{id:"mood",q:"How was your mood?",s:"Choose up to 2 (if it felt mixed)"},{id:"sleep",q:"Hours of sleep last night?",s:"Total hours, roughly"},{id:"anxiety",q:"Anxiety level?",s:"0 none · 1 mild · 2 moderate · 3 severe"},{id:"irritability",q:"Irritability level?",s:"0 none · 1 mild · 2 moderate · 3 severe"},{id:"meds",q:"Today's Meds",s:""},{id:"weight",q:"Weight",s:"Optional daily check-in"},{id:"notes",q:"Anything to note?",s:"Optional — events, thoughts, anything"}];

/* ── MODE STEPS ── */
const MSTEPS_FULL=[
  {id:"mood",      q:{full:"How was your mood?",         now:"How are you feeling right now?"},  s:""},
  {id:"sleep",     q:{full:"Sleep",  now:null},                               s:"Log bedtime, wake time, or just hours"},
  {id:"anx_irr",   q:{full:"Anxiety & Irritability",    now:"Anxiety & irritability"},            s:"0 none · 1 mild · 2 moderate · 3 severe"},
  {id:"meds",      q:{full:"Today's Meds",               now:null},                               s:""},
  {id:"weight",    q:{full:"Weight",                     now:"Weight check-in"},                  s:"Optional — syncs to your mood log"},
  {id:"notes",     q:{full:"Anything to note?",          now:"Anything to note?"},                s:"Optional — events, thoughts, anything"},
];

const NOTES_COPY_BY_MOOD={
  sev_dep:{q:"You showed up. Anything to set down?",s:"Or skip — coming back is the part that matters."},
  mod_dep:{q:"You showed up. Anything to set down?",s:"Or skip — coming back is the part that matters."},
  mild_dep:{q:"Anything you want to remember about today?",s:"A line is enough."},
  normal:{q:"What made today feel like today?",s:"A few words, if any come."},
  mild_elev:{q:"A lot moving today — anything to note?",s:"Even a fragment helps future-you read back."},
  mod_elev:{q:"A lot moving today — anything to note?",s:"Even a fragment helps future-you read back."},
  sev_elev:{q:"Anything you want to set down before bed?",s:"No pressure. Just one line if it helps."},
  partial:{q:"Anything to note?",s:"Optional — fragments are fine."},
};
const NOTES_MOOD_ORDER=["sev_dep","mod_dep","mild_dep","normal","mild_elev","mod_elev","sev_elev"];
const MOOD_PICKER_ORDER=["sev_dep","mod_dep","mild_dep","normal","mild_elev","mod_elev","sev_elev"];
const G_MOOD_CLASS={sev_dep:"g-mood-sev-low",mod_dep:"g-mood-mod-low",mild_dep:"g-mood-mild-low",normal:"g-mood-steady",mild_elev:"g-mood-mild-high",mod_elev:"g-mood-mod-high",sev_elev:"g-mood-sev-high"};
const G_MOOD_LABEL={sev_dep:"Severe low",mod_dep:"Moderate low",mild_dep:"Mild low",normal:"Steady",mild_elev:"Mild high",mod_elev:"Moderate high",sev_elev:"Severe high"};
const NOTE_STARTERS=[
  {label:"Today I…",insert:"Today I "},
  {label:"Mostly just…",insert:"Mostly just "},
  {label:"Felt like…",insert:"Felt like "},
];
const LONGEST_NOTE_STARTER_PREFIX=Math.max(...NOTE_STARTERS.map(s=>s.insert.length));
function notesCopyForMoods(moods){
  const ms=Array.isArray(moods)?moods:[];
  const key=NOTES_MOOD_ORDER.find(k=>ms.includes(k))||"partial";
  return NOTES_COPY_BY_MOOD[key];
}
function MoodEntry({mood,meds,srm,onSaveSRM,editKey,lockedDate,onSave,onMoveMood,onX}){
  const mode="full";
  const initialKey=lockedDate||editKey||tdk();
  const[dateKey,setDateKey]=useState(initialKey);
  const targetKey=editKey||lockedDate||dateKey;

  const activeSteps=MSTEPS_FULL;

  const makeDefault=()=>{
    return{moods:[],sleep:null,weight:null,anxiety:null,irritability:null,meds:defaultRoutineMedsMap(meds),notes:""};
  };

  const isMedsYesterdayFlow=!editKey&&!lockedDate&&targetKey===tdk();
  const yesterdayMedKey=ydk();
  const seedYesterdayMeds=()=>{
    return defaultRoutineMedsMap(meds);
  };
  const seedTodayMeds=()=>{
    const t=mood[targetKey];
    return entryHasMedState(t)?cloneMedsState(t.meds):{};
  };
  const[step,setStep]=useState(0);const[editIdx,setEditIdx]=useState(null);const[skippedSteps,setSkippedSteps]=useState(new Set());
  const notesRef=useRef(null);
  const[entry,setEntry]=useState(()=>{
    const t=mood[targetKey];
    if(t) return{...t,moods:moodsArr(t),meds:{...t.meds}};
    const d=makeDefault();
    return isMedsYesterdayFlow?{...d,meds:{}}:d;
  });
  const[yesterdayMeds,setYesterdayMeds]=useState(seedYesterdayMeds);
  const[todayMeds,setTodayMeds]=useState(seedTodayMeds);
  const[todayMedsOpen,setTodayMedsOpen]=useState(false);
  const[todayMedsTouched,setTodayMedsTouched]=useState(false);

  // ── Sleep chip state ──
  const initSleepTime=useCallback(()=>{
    const ep=storedSleepEpisodes(mood[targetKey])[0];
    if(ep?.bed)return ep.bed;
    // load existing bedtime SRM from day before
    const prevKey=prevDateKey(targetKey);
    const prevItems=(srm[prevKey]||{}).items||[];
    const bt=prevItems.find(i=>i.id==="bedtime");
    if(bt&&bt.time){const[h,m]=bt.time.split(":").map(Number);return{h,m};}
    return null;
  },[targetKey,srm,mood]);
  const initWakeTime=useCallback(()=>{
    const ep=storedSleepEpisodes(mood[targetKey])[0];
    if(ep?.wake)return ep.wake;
    const items=(srm[targetKey]||{}).items||[];
    const bd=items.find(i=>i.id==="bed");
    if(bd&&bd.time){const[h,m]=bd.time.split(":").map(Number);return{h,m};}
    return null;
  },[targetKey,srm,mood]);
  const[slpTime,setSlpTime]=useState(initSleepTime);
  const[wkTime,setWkTime]=useState(initWakeTime);
  const[slpHrs,setSlpHrs]=useState(()=>{const t=mood[targetKey];const ep=storedSleepEpisodes(t)[0];return ep?.hrs??t?.sleep??8;});
  const[slpEditOrder,setSlpEditOrder]=useState(()=>{
    // if existing data, mark those as edited
    const ord=[];
    const st=initSleepTime();const wt=initWakeTime();const t=mood[targetKey];const ep=storedSleepEpisodes(t)[0];
    if(st)ord.push("sleep");if(wt)ord.push("wake");if(ep?.hrs!=null||t?.sleep!=null)ord.push("hrs");
    return ord;
  });
  const[slpOffset,setSlpOffset]=useState(SLP_DEF_OFF);
  const[wkOffset,setWkOffset]=useState(WK_DEF_OFF);
  const[slpPicker,setSlpPicker]=useState(null); // 'sleep'|'wake'|null
  const[slpPickerDef,setSlpPickerDef]=useState(null);
  const makeExtraSleep=useCallback((episode={},index=1,open=false)=>({
    id:`sleep-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    slpTime:episode.bed||null,
    wkTime:episode.wake||null,
    slpHrs:episode.hrs??1,
    editOrder:[episode.bed?"sleep":null,episode.wake?"wake":null,episode.hrs!=null?"hrs":null].filter(Boolean),
    slpOffset:index>0?SLP_DAY_DEF_OFF:SLP_DEF_OFF,
    wkOffset:index>0?WK_DAY_DEF_OFF:WK_DEF_OFF,
    picker:null,
    pickerDef:null,
    open,
  }),[]);
  const[extraSleeps,setExtraSleeps]=useState(()=>storedSleepEpisodes(mood[targetKey]).slice(1).map((ep,i,arr)=>makeExtraSleep(ep,i+1,i===arr.length-1)));
  const[primaryOpen,setPrimaryOpen]=useState(()=>storedSleepEpisodes(mood[targetKey]).length<=1);

  const slpMarkEdited=(f)=>setSlpEditOrder(prev=>[...prev.filter(x=>x!==f),f]);
  const slpDf=slpDerived(slpTime,wkTime,slpHrs,slpEditOrder);
  const primaryEpisode=(override={})=>({hrs:override.hrs??slpHrs,bed:override.st??slpTime,wake:override.wt??wkTime});
  const uiExtraEpisode=ep=>({hrs:ep.slpHrs,bed:ep.slpTime,wake:ep.wkTime});
  const syncSleepEntry=(primary=primaryEpisode(),extras=extraSleeps)=>setEntry(e=>{
    const episodes=[primary,...extras.map(uiExtraEpisode)].filter(ep=>ep.hrs!=null||ep.bed||ep.wake);
    const total=episodes.length?sleepEpisodeTotal(episodes):null;
    return{...e,sleep:total,sleeps:episodes.length>1?episodes.map(sleepEpisodeForStorage):null};
  });

  const slpAutoCalc=(st,wt,hrs,df)=>{
    if(!df)return{st,wt,hrs};
    if(df==="hrs"&&st&&wt) return{st,wt,hrs:slpDur(st.h,st.m,wt.h,wt.m)};
    if(df==="wake"&&st&&hrs!==null){const r=slpMinToHM(st.h*60+st.m+hrs*60);return{st,wt:r,hrs};}
    if(df==="sleep"&&wt&&hrs!==null){const r=slpMinToHM(wt.h*60+wt.m-hrs*60);return{st:r,wt,hrs};}
    return{st,wt,hrs};
  };

  const doSetSlpTime=(h,m)=>{
    const newOrd=[...slpEditOrder.filter(x=>x!=="sleep"),"sleep"];
    const df=slpDerived({h,m},wkTime,slpHrs,newOrd);
    const r=slpAutoCalc({h,m},wkTime,slpHrs,df);
    setSlpTime(r.st);setWkTime(r.wt);setSlpHrs(r.hrs);setSlpEditOrder(newOrd);
    syncSleepEntry({hrs:r.hrs,bed:r.st,wake:r.wt});
  };
  const doSetWkTime=(h,m)=>{
    const newOrd=[...slpEditOrder.filter(x=>x!=="wake"),"wake"];
    const df=slpDerived(slpTime,{h,m},slpHrs,newOrd);
    const r=slpAutoCalc(slpTime,{h,m},slpHrs,df);
    setSlpTime(r.st);setWkTime(r.wt);setSlpHrs(r.hrs);setSlpEditOrder(newOrd);
    syncSleepEntry({hrs:r.hrs,bed:r.st,wake:r.wt});
  };
  const doSetSlpHrs=(v)=>{
    if(v<0)v=0;if(v>24)v=24;
    const newOrd=[...slpEditOrder.filter(x=>x!=="hrs"),"hrs"];
    const df=slpDerived(slpTime,wkTime,v,newOrd);
    const r=slpAutoCalc(slpTime,wkTime,v,df);
    setSlpTime(r.st);setWkTime(r.wt);setSlpHrs(r.hrs);setSlpEditOrder(newOrd);
    syncSleepEntry({hrs:r.hrs,bed:r.st,wake:r.wt});
  };
  const doNudgeHrs=(delta)=>{const cur=slpHrs??8;doSetSlpHrs(Math.round((cur+delta)*2)/2);};

  const slpGetVisible=(which)=>{const arr=which==="sleep"?SLP_ALL:WK_ALL;const off=which==="sleep"?slpOffset:wkOffset;return arr.slice(off,off+SLP_VIS);};
  const slpCanScooch=(which,dir)=>{const arr=which==="sleep"?SLP_ALL:WK_ALL;const off=which==="sleep"?slpOffset:wkOffset;return dir===-1?off>0:off+SLP_VIS<arr.length;};
  const slpScooch=(which,dir)=>{
    const arr=which==="sleep"?SLP_ALL:WK_ALL;const off=which==="sleep"?slpOffset:wkOffset;
    const newOff=off+dir;
    if(newOff<0||newOff+SLP_VIS>arr.length){
      let def;if(dir===-1){const f=arr[0];def=slpMinToHM(f.h*60+f.m-30);}else{const l=arr[arr.length-1];def=slpMinToHM(l.h*60+l.m+30);}
      setSlpPicker(which);setSlpPickerDef(def);return;
    }
    if(which==="sleep")setSlpOffset(newOff);else setWkOffset(newOff);
  };
  const slpConfirmPicker=(val)=>{if(!val)return;const[h,m]=val.split(":").map(Number);if(slpPicker==="sleep")doSetSlpTime(h,m);else doSetWkTime(h,m);setSlpPicker(null);setSlpPickerDef(null);};
  const slpCancelPicker=()=>{setSlpPicker(null);setSlpPickerDef(null);};
  const updateExtraSleeps=updater=>{
    setExtraSleeps(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      syncSleepEntry(primaryEpisode(),next);
      return next;
    });
  };
  const extraArrays=which=>which==="sleep"?SLP_DAY_ALL:WK_DAY_ALL;
  const extraGetVisible=(ep,which)=>{
    const arr=extraArrays(which);const off=which==="sleep"?ep.slpOffset:ep.wkOffset;
    return arr.slice(off,off+SLP_VIS);
  };
  const extraScooch=(id,which,dir)=>updateExtraSleeps(prev=>prev.map(ep=>{
    if(ep.id!==id)return ep;
    const arr=extraArrays(which);const off=which==="sleep"?ep.slpOffset:ep.wkOffset;const newOff=off+dir;
    if(newOff<0||newOff+SLP_VIS>arr.length){
      let def;if(dir===-1){const f=arr[0];def=slpMinToHM(f.h*60+f.m-30);}else{const l=arr[arr.length-1];def=slpMinToHM(l.h*60+l.m+30);}
      return{...ep,picker:which,pickerDef:def};
    }
    return which==="sleep"?{...ep,slpOffset:newOff}:{...ep,wkOffset:newOff};
  }));
  const extraSet=(id,field,h,m)=>updateExtraSleeps(prev=>prev.map(ep=>{
    if(ep.id!==id)return ep;
    const newOrd=[...ep.editOrder.filter(x=>x!==field),field];
    const st=field==="sleep"?{h,m}:ep.slpTime;
    const wt=field==="wake"?{h,m}:ep.wkTime;
    const df=slpDerived(st,wt,ep.slpHrs,newOrd);
    const r=slpAutoCalc(st,wt,ep.slpHrs,df);
    return{...ep,slpTime:r.st,wkTime:r.wt,slpHrs:r.hrs,editOrder:newOrd};
  }));
  const extraNudgeHrs=(id,delta)=>updateExtraSleeps(prev=>prev.map(ep=>{
    if(ep.id!==id)return ep;
    const hrs=Math.max(0,Math.min(24,Math.round(((ep.slpHrs??1)+delta)*2)/2));
    const newOrd=[...ep.editOrder.filter(x=>x!=="hrs"),"hrs"];
    const df=slpDerived(ep.slpTime,ep.wkTime,hrs,newOrd);
    const r=slpAutoCalc(ep.slpTime,ep.wkTime,hrs,df);
    return{...ep,slpTime:r.st,wkTime:r.wt,slpHrs:r.hrs,editOrder:newOrd};
  }));
  const extraConfirmPicker=(id,val)=>{
    if(!val)return;
    const[h,m]=val.split(":").map(Number);
    updateExtraSleeps(prev=>prev.map(ep=>{
      if(ep.id!==id)return ep;
      const field=ep.picker;
      if(!field)return{...ep,picker:null,pickerDef:null};
      const newOrd=[...ep.editOrder.filter(x=>x!==field),field];
      const st=field==="sleep"?{h,m}:ep.slpTime;
      const wt=field==="wake"?{h,m}:ep.wkTime;
      const df=slpDerived(st,wt,ep.slpHrs,newOrd);
      const r=slpAutoCalc(st,wt,ep.slpHrs,df);
      return{...ep,slpTime:r.st,wkTime:r.wt,slpHrs:r.hrs,editOrder:newOrd,picker:null,pickerDef:null};
    }));
  };
  const extraCancelPicker=id=>updateExtraSleeps(prev=>prev.map(ep=>ep.id===id?{...ep,picker:null,pickerDef:null}:ep));
  const addExtraSleep=()=>{const next=makeExtraSleep({},extraSleeps.length+1,true);setPrimaryOpen(false);updateExtraSleeps(prev=>[...prev.map(ep=>({...ep,open:false})),next]);};
  const removeExtraSleep=id=>updateExtraSleeps(prev=>prev.filter(ep=>ep.id!==id));
  const toggleExtraOpen=id=>updateExtraSleeps(prev=>prev.map(ep=>ep.id===id?{...ep,open:!ep.open}:{...ep,open:false}));

  useEffect(()=>{
    if(editKey||lockedDate) return;
    const t=mood[targetKey];
    const episodes=storedSleepEpisodes(t);
    if(t) setEntry({...t,moods:moodsArr(t),meds:{...t.meds}});
    else{const d=makeDefault();setEntry(isMedsYesterdayFlow?{...d,meds:{}}:d);}
    setYesterdayMeds(seedYesterdayMeds());
    setTodayMeds(seedTodayMeds());
    setTodayMedsOpen(false);
    setTodayMedsTouched(false);
    setSlpTime(episodes[0]?.bed??initSleepTime());
    setWkTime(episodes[0]?.wake??initWakeTime());
    setSlpHrs(episodes[0]?.hrs??t?.sleep??8);
    setSlpEditOrder([episodes[0]?.bed||initSleepTime()?"sleep":null,episodes[0]?.wake||initWakeTime()?"wake":null,episodes[0]?.hrs!=null||t?.sleep!=null?"hrs":null].filter(Boolean));
    setExtraSleeps(episodes.slice(1).map((ep,i,arr)=>makeExtraSleep(ep,i+1,i===arr.length-1)));
    setPrimaryOpen(episodes.length<=1);
  },[targetKey]); // eslint-disable-line

  const tot=activeSteps.length;
  const isR=editIdx===null&&step===tot;
  const prog=((step+(isR?1:0))/(tot+1))*100;
  const upd=(k,v)=>setEntry(e=>({...e,[k]:v}));
  const updateMedChoiceInMap=(map,med,choice)=>{
    const prev=map?.[med.key]||dailyMedForChoice("taken",med);
    return{...map,[med.key]:dailyMedForChoice(choice,med,prev)};
  };
  const updateMedNoteInMap=(map,med,note)=>{
    const prev=map?.[med.key]||dailyMedForChoice("taken",med);
    const state=medStateKind(prev)==="taken"?dailyMedForChoice("off",med,prev):normalizeDailyMedState(prev);
    const raw=medNoteInput(note);
    return{...map,[med.key]:raw?{...state,note:raw}:{ct:state.ct,off:state.off}};
  };
  const togglePrnInMap=(map,med)=>{
    const medsNext={...map};
    if(medsNext[med.key]) delete medsNext[med.key];
    else medsNext[med.key]={ct:Math.max(1,Number(med.defaultCt)||1),off:false};
    return medsNext;
  };
  const nudgePrnInMap=(map,med,delta)=>{
    const prev=normalizeDailyMedState(map?.[med.key]||{ct:1});
    const next=Math.max(0.5,Math.round((prev.ct+delta)*2)/2);
    return{...map,[med.key]:{ct:next,off:false}};
  };
  const updMedChoice=(med,choice)=>setEntry(e=>({...e,meds:updateMedChoiceInMap(e.meds,med,choice)}));
  const updMedNote=(med,note)=>setEntry(e=>({...e,meds:updateMedNoteInMap(e.meds,med,note)}));
  const togglePrnMed=med=>setEntry(e=>({...e,meds:togglePrnInMap(e.meds,med)}));
  const nudgePrnMed=(med,delta)=>setEntry(e=>({...e,meds:nudgePrnInMap(e.meds,med,delta)}));
  const updateYesterdayChoice=(med,choice)=>setYesterdayMeds(prev=>updateMedChoiceInMap(prev,med,choice));
  const updateYesterdayNote=(med,note)=>setYesterdayMeds(prev=>updateMedNoteInMap(prev,med,note));
  const toggleYesterdayPrn=med=>setYesterdayMeds(prev=>togglePrnInMap(prev,med));
  const nudgeYesterdayPrn=(med,delta)=>setYesterdayMeds(prev=>nudgePrnInMap(prev,med,delta));
  const updateTodayChoice=(med,choice)=>{setTodayMedsTouched(true);setTodayMeds(prev=>updateMedChoiceInMap(prev,med,choice));};
  const updateTodayNote=(med,note)=>{setTodayMedsTouched(true);setTodayMeds(prev=>updateMedNoteInMap(prev,med,note));};
  const toggleTodayPrn=med=>{setTodayMedsTouched(true);setTodayMeds(prev=>togglePrnInMap(prev,med));};
  const nudgeTodayPrn=(med,delta)=>{setTodayMedsTouched(true);setTodayMeds(prev=>nudgePrnInMap(prev,med,delta));};
  const notesText=entry.notes||"";
  const activeNoteStarter=NOTE_STARTERS.find(starter=>starter.insert===notesText)||null;
  const showNoteStarters=notesText===""||!!activeNoteStarter;
  const renderMedsLog=({medMap,onChoice,onNote,onTogglePrn,onNudgePrn,defaultTaken})=>{
    const routine=sortMedsByWhen(meds.filter(med=>medWhenTaken(med)!=="as_needed"&&Number(med.defaultCt)>0));
    const prn=sortMedsByWhen(meds.filter(med=>medWhenTaken(med)==="as_needed"));
    return <div className="ml g-med-log">
      {routine.length>0&&<div className="med-log-section">
        <div className="sect-h"><span className="sect-k">Routine</span></div>
        {routine.map(med=>{const raw=medMap?.[med.key];const hasRaw=raw!==undefined;const me=hasRaw?normalizeDailyMedState(raw):dailyMedForChoice("taken",med);const kind=hasRaw||defaultTaken?medStateKind(me):"none";const when=medWhenLabel(med);const noteValue=raw?.note??"";return(
          <div key={med.key} className={`mr med-log-row state-${kind}`}>
            <div className="mr-main"><div className="mi"><div className="mn">{med.name}</div><div className="md-sub"><span>{medDoseQtyLabel(med,Math.max(me.ct,med.defaultCt??0))}</span>{when&&<span className="when-tag">{when}</span>}</div></div><div className="segA" role="group" aria-label={`${med.name} status`}>
              <button type="button" className={kind==="missed"?"sel-miss":""} aria-label={`${med.name} missed`} onClick={()=>onChoice(med,"missed")}><span className="g g-line"/></button>
              <button type="button" className={kind==="off"?"sel-off":""} aria-label={`${med.name} off schedule`} onClick={()=>onChoice(med,"off")}><span className="g g-half">◑</span></button>
              <button type="button" className={kind==="taken"?"sel-took":""} aria-label={`${med.name} taken`} onClick={()=>onChoice(med,"taken")}><span className="g g-check">✓</span></button>
            </div></div>
            {kind!=="taken"&&kind!=="none"&&<div className="offnote"><div className="nhead"><span className="ntitle">anything to note?</span><span className="noptional">optional</span></div><input value={noteValue} maxLength={500} placeholder="add a note if you want to" onChange={ev=>onNote(med,ev.target.value)}/></div>}
          </div>
        );})}
        <div className="med-state-legend"><span><span className="gi"><span className="g g-check">✓</span></span>taken</span><span><span className="gi"><span className="g g-half">◑</span></span>off schedule</span><span><span className="gi"><span className="g g-line"/></span>missed</span></div>
      </div>}
      {prn.length>0&&<div className="med-log-section">
        <div className="sect-h"><span className="sect-k">As needed</span><span className="sect-hint">only if you took it</span></div>
        {prn.map(med=>{const state=medMap?.[med.key]?normalizeDailyMedState(medMap[med.key]):null;const when=medWhenLabel(med);return <div key={med.key} className={`mr med-log-row prn${state?" on":""}`}><div className="mr-main"><div className="mi"><div className="mn">{med.name}</div><div className="md-sub"><span>{med.dose||"as needed"}</span>{when&&<span className="when-tag">{when}</span>}</div></div><div className="prn-ctl"><button type="button" className={`prn-tog${state?" on":""}`} onClick={()=>onTogglePrn(med)}><span className="g">✓</span>took it</button>{state&&<div className="prn-ct"><button type="button" onClick={()=>onNudgePrn(med,-0.5)}>−</button><span className="n">{state.ct}</span><button type="button" onClick={()=>onNudgePrn(med,0.5)}>+</button></div>}</div></div></div>;})}
      </div>}
    </div>;
  };
  const renderMedsReviewMap=(medMap,emptyText="None")=>{
    const logged=Object.entries(medMap||{}).filter(([,v])=>medHasDailyState(v));
    if(!logged.length)return emptyText;
    if(logged.every(([,v])=>medStateKind(v)==="taken"))return"All taken";
    return logged.map(([k,v])=>{
      const med=meds.find(m=>m.key===k);
      const state=normalizeDailyMedState(v);
      const kind=medStateKind(state);
      const label=kind==="off"?"off schedule":kind==="missed"?"not taken":"taken";
      return <span className={`rv-med rv-med-${kind}`} key={k}><b>{med?.name||k}</b><span className="rv-med-detail">{medDoseQtyLabel(med,kind==="missed"?(med?.default_ct??med?.defaultCt??state.ct):state.ct)} · {label}{state.note?` · ${state.note}`:""}</span></span>;
    });
  };
  const renderMedsReview=()=>{
    if(skippedSteps.has("meds"))return"Not logged";
    if(!isMedsYesterdayFlow)return renderMedsReviewMap(entry.meds);
    const todayHasMeds=entryHasMedState({meds:todayMeds});
    return <div className="rv-meds-days">
      <div className="rv-meds-day"><span className="rv-meds-day-k">Yesterday · {new Date(yesterdayMedKey+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</span><div>{renderMedsReviewMap(yesterdayMeds)}</div></div>
      {todayMedsOpen&&<div className="rv-meds-day"><span className="rv-meds-day-k">Today · {new Date(tdk()+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</span><div>{todayHasMeds?renderMedsReviewMap(todayMeds):"Not logged"}</div></div>}
    </div>;
  };
  const toggleMood=(key)=>{
    const cur=entry.moods||[];
    if(cur.includes(key)) upd("moods",cur.filter(k=>k!==key));
    else if(cur.length<2) upd("moods",[...cur,key]);
    else upd("moods",[cur[0],key]);
  };
  const handleNoteStarter=(starter)=>{
    if(notesText===starter.insert){
      upd("notes","");
      return;
    }
    upd("notes",starter.insert);
    requestAnimationFrame(()=>{
      const el=notesRef.current;
      if(!el) return;
      el.focus();
      el.setSelectionRange(starter.insert.length,starter.insert.length);
    });
  };

  const renderStep=(si)=>{
    const st=activeSteps[si];const isEdit=editIdx!==null;
    const notesCopy=st.id==="notes"?notesCopyForMoods(entry.moods):null;
    const q=st.id==="meds"&&isMedsYesterdayFlow?"Meds Check":notesCopy?.q||(typeof st.q==="object"?st.q.full:st.q);
    const sub=st.id==="meds"&&isMedsYesterdayFlow?"Log yesterday's meds":notesCopy?.s||st.s;
    return(<div className="qa" key={si+"-"+isEdit}>
      <h2 className={`qt${st.id==="notes"?" qt-notes":""}`}>{q}</h2>{sub&&<p className="qs">{sub}</p>}

      {st.id==="mood"&&(<div className="g-mood-picker">
        <div className="g-mood-dots">{MOOD_PICKER_ORDER.map(key=>{
          const sel=(entry.moods||[]).includes(key);const mc=MM[key];
          return(<button key={key} className={`g-mood-dot ${G_MOOD_CLASS[key]}${sel?" sel":""}`} onClick={()=>toggleMood(key)} aria-label={mc.label}/>);
        })}</div>
        <div className="g-mood-ends"><span>low</span><span>high</span></div>
        <div className="g-mood-read">
          {(entry.moods||[]).length?entry.moods.map(key=><div key={key} className="g-mood-read-line"><div className="g-mood-read-main"><span>{G_MOOD_LABEL[key]||MM[key]?.label}</span><small>{MM[key]?.v>0?`+${MM[key].v}`:MM[key]?.v}</small></div><em>{MOOD_OPTS.find(o=>o.key===key)?.sub}</em></div>):<div className="g-mood-empty">If it felt mixed, pick the two closest.</div>}
        </div>
      </div>)}

      {st.id==="sleep"&&(<div className="slp-multi">
        {extraSleeps.length>0&&<div className="slp-ep-head"><span className="slp-ep-title">Sleep 1</span><button type="button" className="slp-ep-x" onClick={()=>setPrimaryOpen(v=>!v)}>{primaryOpen?"⌃":"⌄"} <span className="lbl">{primaryOpen?"done":"edit"}</span></button></div>}
        {primaryOpen||extraSleeps.length===0?<SleepChips
          slpTime={slpTime} wkTime={wkTime} slpHrs={slpHrs} slpDf={slpDf}
          slpOffset={slpOffset} wkOffset={wkOffset}
          slpPicker={slpPicker} slpPickerDef={slpPickerDef}
          onSetSlp={doSetSlpTime} onSetWk={doSetWkTime} onNudgeHrs={doNudgeHrs}
          onScooch={slpScooch} getVisible={slpGetVisible} canScooch={slpCanScooch}
          onConfirmPicker={slpConfirmPicker} onCancelPicker={slpCancelPicker}
        />:<div className="slp-ep-sum"><span className="h">{slpHrs??0}<span className="slp-hrs-unit"> hrs</span></span><span className="r">{sleepEpisodeSummary(primaryEpisode())}</span></div>}
        {extraSleeps.map((ep,index)=>{const df=slpDerived(ep.slpTime,ep.wkTime,ep.slpHrs,ep.editOrder);return <Fragment key={ep.id}>
          <hr className="slp-ep-sep"/>
          <div className="slp-ep-head"><span className="slp-ep-title">Sleep {index+2}</span><button type="button" className="slp-ep-x" onClick={()=>removeExtraSleep(ep.id)}>✕ <span className="lbl">remove</span></button></div>
          {ep.open?<SleepChips
            slpTime={ep.slpTime} wkTime={ep.wkTime} slpHrs={ep.slpHrs} slpDf={df}
            slpOffset={ep.slpOffset} wkOffset={ep.wkOffset}
            slpPicker={ep.picker} slpPickerDef={ep.pickerDef}
            sleepAll={SLP_DAY_ALL} wakeAll={WK_DAY_ALL}
            onSetSlp={(h,m)=>extraSet(ep.id,"sleep",h,m)} onSetWk={(h,m)=>extraSet(ep.id,"wake",h,m)} onNudgeHrs={delta=>extraNudgeHrs(ep.id,delta)}
            onScooch={(which,dir)=>extraScooch(ep.id,which,dir)} getVisible={which=>extraGetVisible(ep,which)} canScooch={()=>true}
            onConfirmPicker={val=>extraConfirmPicker(ep.id,val)} onCancelPicker={()=>extraCancelPicker(ep.id)}
          />:<button type="button" className="slp-ep-sum slp-ep-sum-btn" onClick={()=>toggleExtraOpen(ep.id)}><span className="h">{ep.slpHrs??0}<span className="slp-hrs-unit"> hrs</span></span><span className="r">{sleepEpisodeSummary(uiExtraEpisode(ep))}</span><span className="chev">⌄ edit</span></button>}
        </Fragment>;})}
        <div className="slp-add"><button type="button" onClick={addExtraSleep}><span className="pl">+</span> Add another sleep</button></div>
        {extraSleeps.length===0&&<p className="slp-add-help">Only if Wei slept more than once today.</p>}
        {extraSleeps.length>0&&<p className="slp-total-cue">Total {entry.sleep??sleepEpisodeTotal([primaryEpisode(),...extraSleeps.map(uiExtraEpisode)])} hrs across {extraSleeps.length+1} sleeps.</p>}
      </div>)}
      {st.id==="weight"&&(<div className="wgt"><input className="wgi" type="number" inputMode="decimal" step="0.01" value={entry.weight??""} onChange={e=>upd("weight",e.target.value===""?null:Math.round(parseFloat(e.target.value)*100)/100)} placeholder="e.g. 68.45"/><div className="wgu">kg</div></div>)}
      {st.id==="anx_irr"&&(<div className="ai-combo">
        {[{field:"anxiety",label:"Anxiety"},{field:"irritability",label:"Irritability"}].map(({field,label})=>{
          const val=entry[field];const fillPct=val!=null?(val/3)*100:0;
          return(<div key={field} className="ai-row">
            <div className="ai-head"><span className="ai-label">{label}</span>{val!=null&&<span className="ai-val">{SEV[val].l}</span>}</div>
            <div className="ai-track-wrap">
              <div className="ai-track-bg"/>
              <div className="ai-track-fill" style={{width:fillPct+"%"}}/>
              <div className="ai-dots">{SEV.map(s=>{
                const cls=val!=null&&s.v<val?"ai-past":val===s.v?"ai-active":"";
                return(<button key={s.v} className={`ai-dot-btn ${cls}`} onClick={()=>upd(field,s.v)}><div className="ai-ring"/></button>);
              })}</div>
            </div>
            <div className="ai-labels">{SEV.map(s=>(<span key={s.v} className={`ai-lbl${val===s.v?" ai-lbl-on":""}`}>{s.l}</span>))}</div>
          </div>);
        })}
      </div>)}
      {st.id==="meds"&&(isMedsYesterdayFlow?<div className="meds-yday">
        <div className="meds-dayline"><span/> {new Date(yesterdayMedKey+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"})}</div>
        {renderMedsLog({medMap:yesterdayMeds,onChoice:updateYesterdayChoice,onNote:updateYesterdayNote,onTogglePrn:toggleYesterdayPrn,onNudgePrn:nudgeYesterdayPrn,defaultTaken:true})}
        <button type="button" className={`meds-also-row${todayMedsOpen?" open":""}`} onClick={()=>setTodayMedsOpen(v=>!v)}>
          <span className="chev">›</span>
          <span className="also-tx"><span className="a1">Also log today?</span><span className="a2">If today's doses are done too. Optional.</span></span>
        </button>
        {todayMedsOpen&&<div className="meds-today-drawer">
          <div className="meds-today-head"><span>Today's meds</span><small>{new Date(tdk()+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"})}</small></div>
          <p className="meds-today-note">Only fill this in if today's doses have already happened.</p>
          {renderMedsLog({medMap:todayMeds,onChoice:updateTodayChoice,onNote:updateTodayNote,onTogglePrn:toggleTodayPrn,onNudgePrn:nudgeTodayPrn,defaultTaken:false})}
        </div>}
      </div>:renderMedsLog({medMap:entry.meds,onChoice:updMedChoice,onNote:updMedNote,onTogglePrn:togglePrnMed,onNudgePrn:nudgePrnMed,defaultTaken:true}))}
      {st.id==="notes"&&(<>
        <div className={`note-starter-wrap${showNoteStarters?"":" note-starter-hidden"}`} aria-hidden={!showNoteStarters}>
          <div className="starter-label">if it helps —</div>
          <div className="starters">{NOTE_STARTERS.map(starter=>(
            <button key={starter.label} type="button" className={`starter${activeNoteStarter?.insert===starter.insert?" starter-dim":""}`} tabIndex={showNoteStarters?0:-1} onClick={()=>handleNoteStarter(starter)}>{starter.label}</button>
          ))}</div>
        </div>
        <textarea ref={notesRef} className="ni" value={notesText} onChange={e=>upd("notes",e.target.value)} placeholder="Whatever's on your mind. Fragments are fine." rows={4}/>
      </>)}

      <div className="step-btns">
        <button className={`btn-p en${(si===0&&!(entry.moods||[]).length)?" bd":""}`}
          onClick={()=>{if(isEdit)setEditIdx(null);else{const sid=activeSteps[si]?.id;setSkippedSteps(prev=>{const n=new Set(prev);n.delete(sid);return n;});setStep(Math.min(si+1,tot));}}}
          disabled={si===0&&!(entry.moods||[]).length}>
          {isEdit?"Done":si===tot-1?"Review":"Next"}
        </button>
        {!isEdit&&<button className="btn-skip" onClick={()=>{const sid=activeSteps[si]?.id;setSkippedSteps(prev=>{const n=new Set(prev);n.add(sid);return n;});setStep(Math.min(si+1,tot));}}>Skip for now</button>}
      </div>
    </div>);
  };

  return(<div className={`scr ent ${isR?"g-review":"g-entry"} g-ambient-sky g-grain`}>
    <div className="et">
      <button className="bi" onClick={()=>{
        if(editIdx!==null)setEditIdx(null);
        else if(step>0)setStep(step-1);
        else onX();
      }}>‹</button>
      <span className="es">{isR?"Review":editIdx!==null?"Editing":`${(editIdx??step)+1} / ${tot}`}</span>
      <button className="btn-ghost" onClick={onX}>Cancel</button>
    </div>

    {!editKey&&!lockedDate&&editIdx===null&&(
      <div className="datebar">
        <button className={`datepill${dateKey===tdk()?" on":""}`} onClick={()=>setDateKey(tdk())}>Today</button>
        <button className={`datepill${dateKey===ydk()?" on":""}`} onClick={()=>setDateKey(ydk())}>Yesterday</button>
        <button className="datepick" onClick={()=>{const v=prompt("Enter date (YYYY-MM-DD)",dateKey);if(v&&/^\d{4}-\d{2}-\d{2}$/.test(v))setDateKey(v);}}>Pick</button>
        <span className="datecap">{new Date(dateKey+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</span>
      </div>
    )}
    {lockedDate&&editIdx===null&&(
      <div className="datebar">
        <span className="datepill on">{new Date(lockedDate+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</span>
      </div>
    )}
    <div className="pb"><div className="pf" style={{width:`${prog}%`}}/></div>

    {editIdx!==null?renderStep(editIdx):(!isR?renderStep(step):(
      <div className="qa" key="rv">
        <h2 className="qt">Looks good?</h2>
        <p className="qs">{new Date(targetKey+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</p>
        <div className="rc">
          <RvRow l="Mood" v={(entry.moods||[]).length?entry.moods.map((k,i)=>(<span key={k} className="rv-mood"><span className={`rv-dot ${G_MOOD_CLASS[k]}`}/>{MM[k].label}<span className="rv-muted"> · {MM[k].v>0?`+${MM[k].v}`:MM[k].v}</span>{i<entry.moods.length-1?", ":""}</span>)):"—"} onEdit={()=>setEditIdx(0)}/>
          <RvRow l="Sleep" v={entry.sleep!=null?<>{slpTime&&<span style={{color:"var(--t2)",fontSize:12}}>{slpFmt12(slpTime.h,slpTime.m)} → </span>}{wkTime&&<span style={{color:"var(--t2)",fontSize:12}}>{slpFmt12(wkTime.h,wkTime.m)} · </span>}{entry.sleep} hrs{sleepMultiCue(entry.sleeps)&&<span className="rv-sleep-cue">{sleepMultiCue(entry.sleeps)}</span>}</>:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="sleep"))}/>
            <RvRow l="Weight" v={entry.weight!=null?`${entry.weight} kg`:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="weight"))}/>
            <RvRow l="Anxiety / Irritability" v={entry.anxiety!=null||entry.irritability!=null?`${entry.anxiety??"—"} / ${entry.irritability??"—"}`:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="anx_irr"))}/>
            <RvRow l="Meds" v={renderMedsReview()} onEdit={()=>{setSkippedSteps(prev=>{const n=new Set(prev);n.delete("meds");return n;});setEditIdx(activeSteps.findIndex(s=>s.id==="meds"))}}/>
          <RvRow l="Notes" v={entry.notes||"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="notes"))}/>
        </div>
        <button className="btn-p" onClick={()=>{
          const sleepEpisodes=[primaryEpisode(),...extraSleeps.map(uiExtraEpisode)].filter(ep=>ep.hrs!=null||ep.bed||ep.wake);
          const todayMedsForSave=isMedsYesterdayFlow
            ? (todayMedsTouched?normalizeMedsForSave(todayMeds):normalizeMedsForSave(entry.meds))
            : normalizeMedsForSave(entry.meds);
          const finalEntry={...entry,sleep:sleepEpisodes.length?sleepEpisodeTotal(sleepEpisodes):null,sleeps:sleepEpisodes.length>1?sleepEpisodes.map(sleepEpisodeForStorage):null,meds:todayMedsForSave};
          if(skippedSteps.has("meds")) finalEntry.meds={};
          // Save SRM bedtime (day before) and bed/wake (selected date)
          if(onSaveSRM){
            let updSrm={...(srm||{})};
            if(slpTime){
              const prevKey=prevDateKey(targetKey);
              const prevItems=(updSrm[prevKey]||{}).items||[];
              const btItem={...emptyItem("bedtime"),time:`${String(slpTime.h).padStart(2,"0")}:${String(slpTime.m).padStart(2,"0")}`,am:slpTime.h<12};
              updSrm[prevKey]={items:[...prevItems.filter(i=>i.id!=="bedtime"),btItem]};
              onSaveSRM(updSrm,prevKey);
            }
            if(wkTime){
              const curItems=(updSrm[targetKey]||{}).items||[];
              const bdItem={...emptyItem("bed"),time:`${String(wkTime.h).padStart(2,"0")}:${String(wkTime.m).padStart(2,"0")}`,am:wkTime.h<12};
              updSrm[targetKey]={items:[...curItems.filter(i=>i.id!=="bed"),bdItem]};
              onSaveSRM(updSrm,targetKey);
            }
          }
          const splitMeds=!skippedSteps.has("meds")&&isMedsYesterdayFlow&&entryHasMedState({meds:yesterdayMeds})?{
            yesterdayDate:yesterdayMedKey,
            yesterdayEntry:{...(mood[yesterdayMedKey]||{}),meds:normalizeMedsForSave(yesterdayMeds)},
          }:null;
          onSave(finalEntry,targetKey,splitMeds);
        }}>Save entry</button>
        {editKey&&onMoveMood&&<button className="btn-move-date" onClick={()=>{
          const v=prompt("Move entry to date (YYYY-MM-DD):",editKey);
          if(v&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v!==editKey){onMoveMood(v);}
        }}>Move to another date…</button>}
      </div>
    ))}
  </div>);
}
/* ── SLEEP CHIPS COMPONENT ── */
function SleepChips({slpTime,wkTime,slpHrs,slpDf,slpOffset,wkOffset,slpPicker,slpPickerDef,sleepAll=SLP_ALL,wakeAll=WK_ALL,onSetSlp,onSetWk,onNudgeHrs,onScooch,getVisible,canScooch,onConfirmPicker,onCancelPicker}){
  const pickerRef=useCallback(node=>{if(node)setTimeout(()=>node.focus(),50);},[]);

  const renderRow=(which,selTime,onSet)=>{
    const visible=getVisible(which);
    const selVis=selTime&&visible.some(c=>c.h===selTime.h&&c.m===selTime.m);
    const selOff=selTime&&!selVis;
    const allArr=which==="sleep"?sleepAll:wakeAll;
    const off=which==="sleep"?slpOffset:wkOffset;

    let leftExtra=null,rightExtra=null;
    if(selOff){
      const selIdx=allArr.findIndex(c=>c.h===selTime.h&&c.m===selTime.m);
      const firstIdx=allArr.findIndex(c=>c.h===visible[0].h&&c.m===visible[0].m);
      const chip=<button key="offsel" className="slp-chip slp-chip-offsel" onClick={()=>onSet(selTime.h,selTime.m)}>{slpFmt12(selTime.h,selTime.m)}</button>;
      if(selIdx===-1){
        const rsm=allArr[0].h*60+allArr[0].m;
        const sm=((selTime.h*60+selTime.m)-rsm+1440)%1440;
        const fvm=((visible[0].h*60+visible[0].m)-rsm+1440)%1440;
        if(sm<fvm)leftExtra=chip;else rightExtra=chip;
      } else if(selIdx<firstIdx)leftExtra=chip;else rightExtra=chip;
    }

    const chips=visible.map(c=>{
      const on=selTime&&selTime.h===c.h&&selTime.m===c.m;
      return<button key={c.h+"-"+c.m} className={`slp-chip${on?" slp-chip-on":""}`} onClick={()=>onSet(c.h,c.m)}>{slpChipLabel(c.h,c.m)}</button>;
    });

    const picker=slpPicker===which?(<div className="slp-edge-picker">
      <input ref={pickerRef} type="time" className="slp-edge-ti" defaultValue={slpPickerDef?`${String(slpPickerDef.h).padStart(2,"0")}:${String(slpPickerDef.m).padStart(2,"0")}`:""} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();onConfirmPicker(e.target.value);}}}/>
      <button className="slp-edge-ok" onClick={()=>{const inp=document.querySelector(".slp-edge-ti");if(inp)onConfirmPicker(inp.value);}}>OK</button>
      <button className="slp-edge-x" onClick={onCancelPicker}>✕</button>
    </div>):null;

    return<><div className="slp-chips">
      <button className="slp-chip slp-chip-arr" onClick={()=>onScooch(which,-1)}>◂</button>
      {leftExtra}{chips}{rightExtra}
      <button className="slp-chip slp-chip-arr" onClick={()=>onScooch(which,1)}>▸</button>
    </div>{picker}</>;
  };

  return(<div>
    <div className="slp-section">
      <div className="slp-label"><span>Slept at</span>{slpTime&&<span className={`slp-val${slpDf==="sleep"?" slp-val-calc":""}`}>{slpFmt12(slpTime.h,slpTime.m)}{slpDf==="sleep"?" ~":""}</span>}</div>
      {renderRow("sleep",slpTime,onSetSlp)}
    </div>
    <div className="slp-section">
      <div className="slp-label"><span>Up at</span>{wkTime&&<span className={`slp-val${slpDf==="wake"?" slp-val-calc":""}`}>{slpFmt12(wkTime.h,wkTime.m)}{slpDf==="wake"?" ~":""}</span>}</div>
      {renderRow("wake",wkTime,onSetWk)}
    </div>
    <hr className="slp-div"/>
    <div className="slp-hrs-sec">
      <div className="slp-label" style={{justifyContent:"center",marginBottom:6}}><span>Sleep hours</span></div>
      <div className="slp-hrs-calc">{slpDf==="hrs"?"~":""}</div>
      <div className="slp-hrs-row">
        <button className="slp-hrs-btn" onClick={()=>onNudgeHrs(-0.5)} disabled={slpHrs===null||slpHrs<=0}>−</button>
        <div className="slp-hrs-val">
          <span className={`slp-hrs-num${slpDf==="hrs"?" slp-hrs-num-calc":""}`}>{slpHrs??8}</span>
          <span className="slp-hrs-unit">hrs</span>
        </div>
        <button className="slp-hrs-btn" onClick={()=>onNudgeHrs(0.5)}>+</button>
      </div>
    </div>
  </div>);
}

function RvRow({l,v,onEdit}){return(<div className="rr"><div className="rr-left"><span className="rl">{l}</span><span className="rv">{v}</span></div>{onEdit&&<button className="rr-edit" onClick={onEdit}>Edit</button>}</div>);}

/* ═══════════════════════════════════════════════════════════════════════════
   SRM PICKER — shows all activities, custom is one-off (session only)
   ═══════════════════════════════════════════════════════════════════════════ */
function SRMPicker({srm,srmDate,setSrmDate,onPick,onX}){
  const[sessionCustom,setSessionCustom]=useState([]);
  const allActs=[...SRM_ACT,...sessionCustom];
  const dateItems=(srm[srmDate]||{}).items||[];
  const logged=new Set(dateItems.map(i=>i.id));
  const[showAdd,setShowAdd]=useState(false);const[newLabel,setNewLabel]=useState("");

  const addCustom=()=>{
    if(!newLabel.trim())return;
    const id="c_"+Date.now();
    setSessionCustom(p=>[...p,{id,label:newLabel.trim(),icon:"·"}]);
    setNewLabel("");setShowAdd(false);
  };

  return(<div className="scr g-srm-picker g-ambient-sky g-grain">
    <div className="hh"><h2 className="ht">Social rhythm</h2><button className="bi" onClick={onX}>×</button></div>
    <div className="datebar">
      <button className={`datepill${srmDate===tdk()?" on":""}`} onClick={()=>setSrmDate(tdk())}>Today</button>
      <button className={`datepill${srmDate===ydk()?" on":""}`} onClick={()=>setSrmDate(ydk())}>Yesterday</button>
      <button className="datepick" onClick={()=>{const v=prompt("Enter date (YYYY-MM-DD)",srmDate);if(v&&/^\d{4}-\d{2}-\d{2}$/.test(v))setSrmDate(v);}}>Pick</button>
      <span className="datecap">{new Date(srmDate+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</span>
    </div>
    <p className="srm-pick-sub">Tap an activity to log it. Come back later for the rest.</p>
    <div className="srm-pick-grid">
      {allActs.map(a=>{
        const done=logged.has(a.id);
        return(<button key={a.id} className={`srm-pick-item${done?" srm-pick-done":""}`} onClick={()=>onPick(a.id)}>
          <span className="srm-pick-icon">{a.icon}</span>
          <span className="srm-pick-label">{a.label}</span>
          {done&&<span className="srm-pick-check">✓</span>}
        </button>);
      })}
    </div>
    {showAdd?(
      <div className="add-form" style={{marginTop:12}}>
        <input className="add-input" value={newLabel} onChange={e=>setNewLabel(e.target.value)} placeholder="Activity name"/>
        <div className="add-btns"><button className="btn-ghost" onClick={()=>setShowAdd(false)}>Cancel</button><button className="btn-sm-p" onClick={addCustom}>Add</button></div>
      </div>
    ):(<button className="btn-add" style={{marginTop:12}} onClick={()=>setShowAdd(true)}>+ Add one-off activity</button>)}
  </div>);
}

/* ── SRM Single Activity Logger ── */
function SRMSingle({id,srm,dateKey,onSave,onX}){
  const targetKey=dateKey||tdk();
  const act=SRM_ACT.find(a=>a.id===id)||{icon:"·",label:id};
  const existing=(srm[targetKey]||{}).items||[];
  const exItem=existing.find(i=>i.id===id);
  const[item,setItem]=useState(exItem||emptyItem(id));
  const upd=(f,v)=>setItem(p=>({...p,[f]:v}));
  const updWho=k=>setItem(p=>({...p,who:p.who.includes(k)?p.who.filter(w=>w!==k):[...p.who,k]}));

  return(<div className="scr ent g-srm-single g-ambient-sky g-grain">
    <div className="et"><button className="bi" onClick={onX}>‹</button><span className="es">{act.label}</span><button className="btn-ghost" onClick={onX}>Cancel</button></div>
    <div className="qa">
      <div className="srm-em">{act.icon}</div>
      <h2 className="qt">{act.label}</h2>
      <div className="srm-tr">
        <label className="srm-lb">Time</label>
        <input type="time" className="srm-ti" value={item.time} onChange={e=>{const v=e.target.value;const h=parseInt(v.split(":")[0],10);setItem(p=>({...p,time:v,am:h<12}));}}/>
        <button className="srm-now" onClick={()=>{const t=nowTime();setItem(p=>({...p,time:t,am:isAMnow()}));}}>Now</button>
      </div>
      <button className={`srm-skip${item.didNot?" srm-skip-on":""}`} onClick={()=>upd("didNot",!item.didNot)}>{item.didNot?"✓ ":""}Didn't do this</button>
      {!item.didNot&&(<>
        <div className="srm-sec"><label className="srm-lb">Were others involved?</label>
          <div className="srm-yn"><button className={`srm-yb${item.withOthers?" srm-yb-on":""}`} onClick={()=>upd("withOthers",true)}>Yes</button><button className={`srm-yb${!item.withOthers?" srm-yb-on":""}`} onClick={()=>upd("withOthers",false)}>No</button></div>
        </div>
        {item.withOthers&&(<>
          <div className="srm-sec"><label className="srm-lb">Who?</label>
            <div className="srm-who-grid">{WHO_OPTS.map(w=>(<button key={w.key} className={`srm-wb${item.who.includes(w.key)?" srm-wb-on":""}`} onClick={()=>updWho(w.key)}>{w.label}</button>))}</div>
            {item.who.some(w=>w!=="spouse")&&<input className="srm-who-text" value={item.whoText} onChange={e=>upd("whoText",e.target.value)} placeholder="Name (optional)"/>}
          </div>
          <div className="srm-sec"><label className="srm-lb">Level of engagement</label>
            <div className="srm-eng">{ENG_OPTS.map(e=>(<button key={e.v} className={`srm-eb${item.engagement===e.v?" srm-eb-on":""}`} onClick={()=>upd("engagement",e.v)}>{e.label}</button>))}</div>
          </div>
        </>)}
      </>)}
      <button className="btn-p en" onClick={()=>onSave(item)}>Save</button>
    </div>
  </div>);
}

/* ── CONFIRM ── */
function Confirm({msg,sub,onDone}){
  useEffect(()=>{const t=setTimeout(onDone,2200);return()=>clearTimeout(t);},[onDone]);
  return(<div className="scr cfs g-confirm g-ambient-sky g-grain"><div className="cfi">
    <div className="cfc"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path className="cfdraw" d="M14 25L21 32L34 18" stroke="#8FB2A4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
    <h2 className="cft">{msg}</h2><p className="cfp">{sub}</p>
  </div></div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORY — export includes SRM, notes newest first
   ═══════════════════════════════════════════════════════════════════════════ */
/* ── BOTTOM SHEET — wraps Insights & Settings. Drag-to-dismiss is armed ONLY
   from the head (grabber + title row); the body scrolls normally. Slide-up on
   mount, swipe-down / scrim-tap / × to close. prefers-reduced-motion → no slide.
   Close: dy>120px OR downward flick >0.5px/ms; upward over-drag rubber-bands. ── */
function BottomSheet({onClose,sheetClass,title,actions,children}){
  const scrimRef=useRef(null),sheetRef=useRef(null),headRef=useRef(null);
  const[open,setOpen]=useState(false);
  const reduce=typeof window!=="undefined"&&window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(()=>{const r=requestAnimationFrame(()=>setOpen(true));return()=>cancelAnimationFrame(r);},[]);

  const doClose=useCallback(()=>{
    const s=sheetRef.current;if(s)s.style.transform="";
    setOpen(false);
    setTimeout(onClose,reduce?0:340);
  },[onClose,reduce]);

  useEffect(()=>{
    const head=headRef.current,sheet=sheetRef.current,scrim=scrimRef.current;
    if(!head||!sheet)return;
    let sy=null,ly=null,lt=null,dy=0;
    const start=(e)=>{const t=e.touches?e.touches[0]:e;sy=ly=t.clientY;lt=performance.now();dy=0;sheet.classList.add("g-sheet-drag");};
    const move=(e)=>{if(sy===null)return;const t=e.touches?e.touches[0]:e;dy=t.clientY-sy;const a=dy<0?dy*0.35:dy;sheet.style.transform=`translateY(${a}px)`;if(scrim)scrim.style.opacity=String(Math.max(0,1-a/sheet.offsetHeight));ly=t.clientY;lt=performance.now();if(e.cancelable)e.preventDefault();};
    const end=()=>{if(sy===null)return;const v=(ly-sy)/(performance.now()-lt+1);sheet.classList.remove("g-sheet-drag");if(scrim)scrim.style.opacity="";if(dy>120||v>0.5)doClose();else sheet.style.transform="";sy=ly=lt=null;dy=0;};
    const md=(e)=>{start(e);const mv=(ev)=>move(ev),mu=()=>{end();window.removeEventListener("mousemove",mv);window.removeEventListener("mouseup",mu);};window.addEventListener("mousemove",mv);window.addEventListener("mouseup",mu);};
    head.addEventListener("touchstart",start,{passive:true});
    head.addEventListener("touchmove",move,{passive:false});
    head.addEventListener("touchend",end);
    head.addEventListener("mousedown",md);
    return()=>{head.removeEventListener("touchstart",start);head.removeEventListener("touchmove",move);head.removeEventListener("touchend",end);head.removeEventListener("mousedown",md);};
  },[doClose]);

  return(
    <div ref={scrimRef} className={`g-sheet-scrim${open?" open":""}`} onClick={doClose}>
      <div ref={sheetRef} className={`g-sheet g-ambient-sky g-grain ${sheetClass||""}${open?" open":""}`} onClick={e=>e.stopPropagation()}>
        <div ref={headRef} className="g-sheet-head">
          <span className="g-sheet-bar"/>
          <div className="g-sheet-head-row"><h2 className="ht">{title}</h2><div className="ha">{actions}<button className="bi" onClick={doClose} aria-label="Close">×</button></div></div>
        </div>
        <div className="g-sheet-body">{children}</div>
      </div>
    </div>
  );
}

function Hist({mood,srm,meds,onBack}){
  const [range,setRange]=useState("1m");
  const [overlays,setOverlays]=useState({sleep:false,weight:false,social:false});
  const [sleepTip,setSleepTip]=useState(null);
  useEffect(()=>{
    const closeSleepTip=()=>setSleepTip(null);
    document.addEventListener("click",closeSleepTip);
    return()=>document.removeEventListener("click",closeSleepTip);
  },[]);
  const validKey=k=>!!k&&/^\d{4}-\d{2}-\d{2}$/.test(k);
  const parseKey=k=>new Date(`${k}T00:00:00`);
  const nextKey=k=>{const d=parseKey(k);d.setDate(d.getDate()+1);return dk(d.getFullYear(),d.getMonth(),d.getDate());};
  const latestKey=[...Object.keys(mood||{}),...Object.keys(srm||{})].filter(validKey).sort().pop();
  const inRange=k=>{
    if(!latestKey||range==="all") return true;
    const days={["1w"]:7,["1m"]:30,["3m"]:90}[range]||9999;
    const cutoff=parseKey(latestKey);cutoff.setDate(cutoff.getDate()-days);
    return parseKey(k)>=cutoff;
  };
  const validMoodEntry=([k,e])=>{
    if(!e||typeof e!=='object') return false;
    if(!validKey(k)) return false;
    return e.mood||e.mood2||(Array.isArray(e.moods)&&e.moods.length)||e.sleep!=null||e.anxiety!=null||e.weight!=null;
  };
  const hasMoodData=Object.entries(mood||{}).some(validMoodEntry);
  const sorted=Object.entries(mood||{}).filter(entry=>validMoodEntry(entry)&&inRange(entry[0])).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,e])=>{const[y,m,d]=k.split("-").map(Number);return{key:k,day:d,month:m,year:y,label:`${MO[m-1]?.slice(0,3)||"?"} ${d}`,sl:`${m}/${d}`,...e,mv:moodValue(e)};});
  const wM=sorted.filter(e=>e.mv!=null);
  const avg=a=>a.length?(a.reduce((s,x)=>s+x,0)/a.length):null;
  const moodAvg=avg(wM.map(e=>e.mv));
  const moodData=wM.map(e=>({n:e.sl,mood:e.mv,f:e.label}));
  const comboData=sorted.filter(e=>e.anxiety!=null||e.irritability!=null).map(e=>({n:e.sl,sleep:e.sleep,anxiety:e.anxiety,irritability:e.irritability,f:e.label,key:e.key}));
  const weightData=sorted.filter(e=>e.weight!=null).map(e=>({n:e.sl,weight:e.weight,f:e.label}));
  const weightStats=(()=>{
    if(!weightData||weightData.length===0) return null;
    const last=weightData[weightData.length-1];
    const lastW=last.weight;
    const prev=weightData.length>7?weightData[weightData.length-8]:weightData[0];
    const delta=(prev&&prev.weight!=null)?(lastW-prev.weight):null;
    return { lastW, delta, lastDate:last.f, prevDate:prev?.f };
  })();

  const notes=sorted.filter(e=>e.notes?.trim()).reverse();
  const srmSorted=Object.entries(srm||{}).filter(([k])=>validKey(k)&&inRange(k)).sort(([a],[b])=>a.localeCompare(b));
  const srmSocial=srmSorted.map(([k,v])=>{
    const[,m,d]=k.split("-").map(Number);
    const done=(v.items||[]).filter(i=>!i.didNot);
    const socialActs=done.filter(i=>i.withOthers);
    const score=socialActs.reduce((acc,i)=>acc+(i.engagement||1),0);
    const count=socialActs.length;
    return{name:`${m}/${d}`,score,count,total:done.length,f:`${MO[m-1].slice(0,3)} ${d}`};
  });
  const socialMap=Object.fromEntries(srmSocial.map(d=>[d.name,d.score]));
  const weightMap=Object.fromEntries(weightData.map(d=>[d.n,d.weight]));
  const comboOverlayData=comboData.map(d=>({...d,weight:weightMap[d.n]??null,social:socialMap[d.n]??null}));
  const fitDomain=(vals,pad=1)=>{
    const nums=vals.filter(v=>v!=null&&Number.isFinite(v));
    if(!nums.length) return ["auto","auto"];
    const mn=Math.min(...nums),mx=Math.max(...nums);
    if(mn===mx) return [mn-pad,mx+pad];
    return [mn-pad,mx+pad];
  };
  const timeHours=item=>{
    if(!item||item.didNot||!item.time)return null;
    const t=to24h(normTime(item.time),item.am);
    const[h,mi]=String(t||"").split(":").map(Number);
    if(!Number.isFinite(h)||!Number.isFinite(mi))return null;
    return h+mi/60;
  };
  const nightClock=h=>{
    const hh=((h%24)+24)%24;
    const hr=Math.floor(hh);
    const mn=Math.round((hh-hr)*60);
    const ampm=hr>=12?"pm":"am";
    const h12=hr%12||12;
    return mn===0?`${h12}${ampm}`:`${h12}:${String(mn).padStart(2,"0")}${ampm}`;
  };
  const sleepZone=h=>h<5?"very-short":h<7?"short":h<10?"healthy":"long";
  const sleepColor=z=>({"very-short":"var(--g-sleep-very-short)",short:"var(--g-sleep-short)",healthy:"var(--g-sleep-healthy)",long:"var(--g-sleep-long)"}[z]);
  const Y_TOP=20,Y_BOTTOM=36;
  const yPct=h=>`${((h-Y_TOP)/(Y_BOTTOM-Y_TOP))*100}%`;
  const nights=srmSorted.map(([k,v])=>{
    const bedtime=(v.items||[]).find(i=>i.id==="bedtime");
    const wake=((srm||{})[nextKey(k)]?.items||[]).find(i=>i.id==="bed");
    let bt=timeHours(bedtime);const wk=timeHours(wake);
    if(bt!=null&&bt<6)bt+=24;
    const[,m,d]=k.split("-").map(Number);
    if(bt==null||wk==null)return{key:k,n:`${m}/${d}`,label:`${MO[m-1].slice(0,3)} ${d}`,bed:null,wake:null,dur:null};
    const dur=(wk+24)-bt;
    return{key:k,n:`${m}/${d}`,label:`${MO[m-1].slice(0,3)} ${d}`,bed:bt,wake:wk+24,dur,zone:sleepZone(dur)};
  });
  const validNights=nights.filter(n=>n.dur!=null);
  const sleepAvg=avg(validNights.map(n=>n.dur));
  const sleepAvgBed=avg(validNights.map(n=>n.bed));
  const sleepAvgWake=avg(validNights.map(n=>n.wake));
  const sleepXLabels=new Set(nights.length?[0,Math.floor(nights.length*.25),Math.floor(nights.length*.5),Math.floor(nights.length*.75),nights.length-1]:[]);
  const sleepZones=[
    {key:"very-short",label:"<5h",color:"var(--g-sleep-very-short)"},
    {key:"short",label:"5–7h",color:"var(--g-sleep-short)"},
    {key:"healthy",label:"7–10h",color:"var(--g-sleep-healthy)"},
    {key:"long",label:">10h",color:"var(--g-sleep-long)"}
  ];
  const sleepZoneCounts=Object.fromEntries(sleepZones.map(z=>[z.key,0]));
  validNights.forEach(n=>{sleepZoneCounts[n.zone]=(sleepZoneCounts[n.zone]||0)+1;});
  const sleepDist=sleepZones.map(z=>({...z,pct:validNights.length?Math.round((sleepZoneCounts[z.key]/validNights.length)*100):0})).filter(z=>z.pct>0);

  const MTT=({active,payload})=>{try{if(!active||!payload?.length)return null;const d=payload[0]?.payload;if(!d)return null;const mk=Object.entries(MM).find(([,v])=>v.v===d.mood);return(<div className="tt"><div className="ttd">{d.f||""}</div>{mk&&<div style={{color:mk[1].color}}>{mk[1].label}</div>}</div>);}catch{return null;}};
  const CTT=({active,payload})=>{try{if(!active||!payload?.length)return null;const d=payload[0]?.payload;if(!d)return null;return(<div className="tt"><div className="ttd">{d.f||""}</div>{d.anxiety!=null&&<div>Anxiety: {d.anxiety}/3</div>}{d.irritability!=null&&<div>Irritability: {d.irritability}/3</div>}{overlays.sleep&&d.sleep!=null&&<div>Sleep: {d.sleep}h</div>}{overlays.weight&&d.weight!=null&&<div>Weight: {d.weight} kg</div>}{overlays.social&&d.social!=null&&<div>Social: {d.social}</div>}</div>);}catch{return null;}};

  const exCSV=()=>{
    let csv="Date,Mood,Sleep,Weight,Anxiety,Irritability,Medications,Notes,Rhythm Activities\n";
    const allDates=new Set([...Object.keys(mood),...Object.keys(srm)]);
    [...allDates].sort().forEach(k=>{
      const e=mood[k];const s=srm[k];
      const ms=e?.meds?Object.entries(e.meds).filter(([,v])=>medHasDailyState(v)).map(([k2,v])=>{const state=normalizeDailyMedState(v);const label=state.off?"off schedule":state.ct<=0?"not taken":"taken";return `${k2}:${state.ct}:${label}${state.note?` (${state.note.replace(/"/g,"'")})`:""}`;}).join("; "):"";
      const rhythm=s?.items?s.items.filter(i=>!i.didNot).map(i=>`${i.id}:${fmt12h(normTime(i.time))||"?"}`).join("; "):"";
      csv+=`${k},${moodKeyString(e)},${e?.sleep??""},${e?.weight??""},${e?.anxiety??""},${e?.irritability??""},"${ms}","${(e?.notes||"").replace(/"/g,'""')}","${rhythm}"\n`;
    });
    const b=new Blob([csv],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`mood-rhythm-${tdk()}.csv`;a.click();
  };

  return(<BottomSheet onClose={onBack} sheetClass="g-insights" title="Insights" actions={<button className="bx" onClick={exCSV} aria-label="Export"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4M5 11v8h14v-8"/></svg></button>}>
    {!hasMoodData&&<div className="card" style={{textAlign:"center",padding:"40px 20px"}}><p style={{color:"var(--t2)",fontSize:14,lineHeight:1.6}}>No mood data yet. Log your first mood entry to see insights here.</p></div>}
    {hasMoodData&&<div className="sr">
      <div className="sb"><div className="sv">{moodAvg==null?"—":moodAvg>0?`+${moodAvg.toFixed(1)}`:moodAvg.toFixed(1)}</div><div className="sbl">Avg Mood</div></div>
      <div className="sb"><div className="sv">{sleepAvg==null?"—":sleepAvg.toFixed(1)}{sleepAvg!=null&&<small> hrs</small>}</div><div className="sbl">Avg Sleep</div></div>
    </div>}
    {hasMoodData&&<div className="range-bar">{[["1w","1W"],["1m","1M"],["3m","3M"],["all","All"]].map(([k,l])=><button key={k} className={`range-chip ${range===k?"on":""}`} onClick={()=>{setRange(k);setSleepTip(null);}}>{l}</button>)}</div>}

    {moodData.length>0&&<div className="card"><h3 className="ctit">Mood</h3><div className="cw"><ResponsiveContainer width="100%" height={180}><AreaChart data={moodData} margin={{top:8,right:8,left:-24,bottom:4}}>
      <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7C7EAE" stopOpacity={.13}/><stop offset="100%" stopColor="#7C7EAE" stopOpacity={.02}/></linearGradient></defs>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/>
      <YAxis domain={[-3,3]} ticks={[-3,-2,-1,0,1,2,3]} tick={{fontSize:8,fill:"#9E9790"}} tickFormatter={v=>({3:"Sev↑",2:"Mod↑",1:"Mild↑",0:"OK","-1":"Mild↓","-2":"Mod↓","-3":"Sev↓"}[v]||v)}/>
      <ReferenceLine y={0} stroke="#B3A8CC" strokeDasharray="4 4" strokeOpacity={.6}/><Tooltip content={<MTT/>}/>
      <Area type="monotone" dataKey="mood" stroke="#7C7EAE" strokeWidth={2} fill="url(#mg)" dot={{r:2.5,fill:"#7C7EAE",strokeWidth:0}} activeDot={{r:4}} connectNulls/>
    </AreaChart></ResponsiveContainer></div></div>}

    {nights.length>0&&<div className="card sleep-card">
      <div className="slp-head"><span className="v">{sleepAvg==null?"—":sleepAvg.toFixed(1)}</span><span className="u">h avg</span><span className="meta">{validNights.length} {validNights.length===1?"night":"nights"} · {validNights.length?`${Math.min(...validNights.map(n=>n.dur)).toFixed(1)}–${Math.max(...validNights.map(n=>n.dur)).toFixed(1)}h`:"—"}</span></div>
      <div className="sleep-grid">
        <div className="chart-body">
          {sleepAvgBed!=null&&<div className="ref-line" style={{top:yPct(sleepAvgBed)}}/>}
          {sleepAvgWake!=null&&<div className="ref-line" style={{top:yPct(sleepAvgWake)}}/>}
          <div className="bars">{nights.map((n,i)=><div key={n.key} className={`col ${sleepTip===i?"show":""}`} data-d={n.key}>
            {n.dur!=null&&<button className="bar" aria-label={`${n.dur.toFixed(1)} hours on ${n.label}`} style={{top:yPct(n.bed),height:`${((n.wake-n.bed)/(Y_BOTTOM-Y_TOP))*100}%`,background:sleepColor(n.zone)}} onClick={e=>{e.stopPropagation();setSleepTip(sleepTip===i?null:i);}}>
              <span className="tip" style={(((n.bed-Y_TOP)/(Y_BOTTOM-Y_TOP))*100)<15?{top:`calc(${yPct(n.wake)} + 8px)`}:{bottom:`calc(${100-((n.bed-Y_TOP)/(Y_BOTTOM-Y_TOP))*100}% + 8px)`}}><b>{n.dur.toFixed(1)}h</b> · {n.label}<br/>{nightClock(n.bed)} → {nightClock(n.wake)}</span>
            </button>}
          </div>)}</div>
        </div>
        <span className="y-label y-top">8pm</span>
        <span className="y-label y-mid">4am</span>
        <span className="y-label y-bot">12pm</span>
        {sleepAvgBed!=null&&<span className="ref-label" style={{top:yPct(sleepAvgBed)}}><b>{nightClock(sleepAvgBed)}</b>average</span>}
        {sleepAvgWake!=null&&<span className="ref-label" style={{top:yPct(sleepAvgWake)}}><b>{nightClock(sleepAvgWake)}</b>average</span>}
      </div>
      <div className="xax">{nights.map((n,i)=><span key={n.key}>{sleepXLabels.has(i)?n.n:""}</span>)}</div>
      <div className="dist">
        <div className="dist-pcts">{sleepDist.map(z=><span key={z.key} style={{flex:z.pct}}>{z.pct>=8?`${z.pct}%`:""}</span>)}</div>
        <div className="dist-strip">{sleepDist.map(z=><span key={z.key} className="dist-seg" style={{flex:z.pct,background:z.color}}/>)}</div>
        <div className="dist-labels">{sleepDist.map(z=><span key={z.key} style={{flex:z.pct}}>{z.pct>=8?z.label:""}</span>)}</div>
      </div>
    </div>}

    {comboData.length>0&&<div className="card"><h3 className="ctit">Anxiety · Irritability</h3><div className="cw"><ResponsiveContainer width="100%" height={150}><LineChart data={comboOverlayData} margin={{top:8,right:8,left:-24,bottom:4}}>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/><YAxis yAxisId="symptoms" domain={[0,3]} ticks={[0,1,2,3]} tick={{fontSize:10,fill:"#9E9790"}}/>
      <YAxis yAxisId="sleep" orientation="right" hide domain={fitDomain(comboOverlayData.map(d=>d.sleep),1)}/>
      <YAxis yAxisId="weight" orientation="right" hide domain={fitDomain(comboOverlayData.map(d=>d.weight),2)}/>
      <YAxis yAxisId="social" orientation="right" hide domain={fitDomain(comboOverlayData.map(d=>d.social),1)}/>
      <Tooltip content={<CTT/>}/>
      <Line yAxisId="symptoms" type="monotone" dataKey="anxiety" stroke="#7A7268" strokeWidth={1.8} dot={{r:2,fill:"#7A7268",strokeWidth:0}} connectNulls name="Anxiety"/>
      <Line yAxisId="symptoms" type="monotone" dataKey="irritability" stroke="#ADA593" strokeWidth={1.8} dot={{r:2,fill:"#ADA593",strokeWidth:0}} connectNulls name="Irritability"/>
      {overlays.sleep&&<Line yAxisId="sleep" type="monotone" dataKey="sleep" stroke="#9AA0BE" strokeWidth={1.5} dot={{r:2,fill:"#9AA0BE",strokeWidth:0}} connectNulls strokeDasharray="5 3" name="Sleep"/>}
      {overlays.weight&&<Line yAxisId="weight" type="monotone" dataKey="weight" stroke="#A89CC8" strokeWidth={1.5} dot={{r:2,fill:"#A89CC8",strokeWidth:0}} connectNulls strokeDasharray="4 3" name="Weight"/>}
      {overlays.social&&<Line yAxisId="social" type="monotone" dataKey="social" stroke="#8896BE" strokeWidth={1.5} dot={{r:2.5,fill:"#8896BE",strokeWidth:0}} connectNulls strokeDasharray="3 3" name="Social"/>}
    </LineChart></ResponsiveContainer></div><div className="ov-bar">{[{key:"sleep",label:"Sleep",color:"#9AA0BE"},{key:"weight",label:"Weight",color:"#A89CC8"},{key:"social",label:"Social",color:"#8896BE"}].map(o=><button key={o.key} className={`ov-chip ${overlays[o.key]?"on":""}`} onClick={()=>setOverlays({...overlays,[o.key]:!overlays[o.key]})}><span className="ov-dot" style={{background:o.color}}/>{o.label}</button>)}</div><div className="cleg2"><span><span className="ll" style={{background:"#7A7268"}}/> Anxiety</span><span><span className="ll" style={{background:"#ADA593"}}/> Irritability</span>{overlays.sleep&&<span><span className="ll" style={{background:"#9AA0BE"}}/> Sleep</span>}{overlays.weight&&<span><span className="ll" style={{background:"#A89CC8"}}/> Weight</span>}{overlays.social&&<span><span className="ll" style={{background:"#8896BE"}}/> Social</span>}</div></div>}

    

    {weightData.length>0&&<div className="card"><div className="whead"><h3 className="ctit">Weight</h3>{weightStats&&<div className="wstat"><div className="wsv">{weightStats.lastW} kg</div><div className="wsd">{weightStats.delta==null?"":(weightStats.delta>=0?`+${weightStats.delta.toFixed(1)}`:weightStats.delta.toFixed(1))}{weightStats.delta==null?"":" in ~7 entries"}</div></div>}</div><div className="cw"><ResponsiveContainer width="100%" height={140}><AreaChart data={weightData} margin={{top:8,right:8,left:-24,bottom:4}}>
      <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7C7EAE" stopOpacity={.16}/><stop offset="100%" stopColor="#7C7EAE" stopOpacity={.02}/></linearGradient></defs>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/><YAxis tick={{fontSize:10,fill:"#9E9790"}} domain={["dataMin-2","dataMax+2"]}/>
      <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0].payload;return(<div className="tt"><div className="ttd">{d.f}</div><div>Weight: {d.weight} kg</div></div>);}}/>
      <Area type="monotone" dataKey="weight" stroke="#7C7EAE" strokeWidth={2} fill="url(#wg)" dot={{r:2.5,fill:"#7C7EAE",strokeWidth:0}} activeDot={{r:4}} connectNulls/>
    </AreaChart></ResponsiveContainer></div></div>}
    {/* ── Social engagement score ── */}
    {srmSocial.length>0&&srmSocial.some(d=>d.score>0)&&<div className="card">
      <h3 className="ctit">Social Stimulation</h3>
      <p className="card-sub">Sum of engagement levels across all social activities per day</p>
      <div className="cw"><ResponsiveContainer width="100%" height={130}><LineChart data={srmSocial} margin={{top:8,right:8,left:-24,bottom:4}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/>
        <XAxis dataKey="name" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/>
        <YAxis tick={{fontSize:10,fill:"#9E9790"}} allowDecimals={false}/>
        <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0]?.payload;if(!d)return null;return(<div className="tt"><div className="ttd">{d.f}</div><div>Score: {d.score}</div><div style={{color:"var(--t3)",fontSize:11}}>{d.count} social {d.count===1?"activity":"activities"}</div></div>);}}/>
        <Line type="monotone" dataKey="score" stroke="#8896BE" strokeWidth={2} dot={{r:3,fill:"#8896BE",strokeWidth:0}} activeDot={{r:4}} connectNulls name="Social score"/>
      </LineChart></ResponsiveContainer></div>
      <div className="cleg2"><span style={{fontSize:11,color:"var(--t3)"}}>1 = just present · 2 = actively involved · 3 = very stimulating</span></div>
    </div>}

    {notes.length>0&&<div className="notes-card"><h3 className="notes-h">Notes</h3><p className="notes-sub">in Wei's own words · {notes.length} {notes.length===1?"note":"notes"} in range</p><div className="nl">{notes.map(n=>{const mk=primaryMood(n);const meta=MM[mk];const showMood=mk&&mk!=="normal";return(<div key={n.key} className="nr"><div className="n-meta"><span className="n-dot" style={{background:meta?.color||"var(--g-tx3)"}}/><span className="n-date">{n.label}</span>{showMood&&<span className="n-mood">· {meta?.label.toLowerCase()}</span>}</div><div className="nt">{n.notes}</div></div>);})}</div></div>}
  </BottomSheet>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════════════════════════ */
function RemindersCard({settings, setS}){
  // Push pipeline state machine
  const [pushState,setPushState]=useState("loading"); // loading | unsupported | needsHomescreen | needsPermission | denied | active
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState("");
  const [testResult,setTestResult]=useState(null);
  const [pulse,setPulse]=useState(false);

  const supportsPush=typeof window!=="undefined"&&"serviceWorker" in navigator&&"PushManager" in window;
  const isPWA=isStandalonePWA();
  const isIOS=typeof navigator!=="undefined"&&/iPhone|iPad|iPod/.test(navigator.userAgent);

  useEffect(()=>{
    (async()=>{
      if(!supportsPush){setPushState("unsupported");return;}
      if(isIOS&&!isPWA){setPushState("needsHomescreen");return;}
      if(typeof Notification!=="undefined"&&Notification.permission==="denied"){setPushState("denied");return;}
      try{
        const sub=await getPushSubscription();
        if(sub){
          setPushState("active");
        }else{
          setPushState("needsPermission");
        }
      }catch{setPushState("needsPermission");}
    })();
  },[supportsPush,isIOS,isPWA]);

  const enable=async()=>{
    setBusy(true);setMsg("");
    try{
      const sub=await enableWebPush();
      pushSubscribeToSheets(sub);
      setPushState("active");
      setPulse(true);setTimeout(()=>setPulse(false),1200);
      setMsg("Notifications on — sending a test…");
      // Wait for the push_subscribe row to land on the sheet before testing,
      // otherwise the server won't yet know about this device's endpoint.
      await waitForSyncIdle();
      fireTest(true);
    }catch(e){
      const m=String(e?.message||e);
      setMsg(m);
      if(/denied/i.test(m)) setPushState("denied");
    }
    setBusy(false);
  };

  const fireTest=async(isAutoTest=false)=>{
    if(!isAutoTest) setBusy(true);
    setTestResult(null);
    try{
      // Scope the test strictly to this device's subscription. If we can't
      // read a local endpoint we bail rather than fan out to every device —
      // that fan-out behavior is preserved only for the URL-bar debug path
      // (hitting ?action=test_push directly with no endpoint param).
      let endpoint="";
      try{
        const localSub=await getPushSubscription();
        endpoint=(localSub && (localSub.toJSON?localSub.toJSON():localSub).endpoint) || "";
      }catch{/* subscription lookup failed; test flow will show the missing-device message */}
      if(!endpoint){
        setTestResult("fail");
        setMsg("Couldn't find this device's subscription. Disable and re-enable notifications.");
        if(!isAutoTest) setBusy(false);
        setTimeout(()=>setTestResult(null),3000);
        return;
      }
      const url=`${SHEETS_URL}?action=test_push&endpoint=${encodeURIComponent(endpoint)}`;
      const res=await fetch(url,{method:"GET",cache:"no-store"});
      const data=await res.json();
      if(data?.count>=1&&data.results.every(r=>r.ok)){
        setTestResult("ok");
        setMsg(isAutoTest?"Notifications on — check your Notification Center.":"Test sent — check your Notification Center.");
      }else if(data?.count===0){
        setTestResult("fail");
        setMsg("This device isn't registered yet — try again in a few seconds.");
      }else{
        setTestResult("fail");
        const detail=data?.results?.[0]?.body||"";
        setMsg(`Test failed${detail?": "+String(detail).slice(0,80):"."} Open MooTracker from the Home Screen icon, not Safari.`);
      }
    }catch{
      setTestResult("fail");
      setMsg("Couldn't reach the server.");
    }
    if(!isAutoTest) setBusy(false);
    setTimeout(()=>setTestResult(null),3000);
  };

  // Unsubscribe this device — removes the push subscription locally AND from
  // the server. Reverts the status row to "Allow notifications" so the user
  // can re-enable later (will create a fresh subscription).
  const disableOnDevice=async()=>{
    setBusy(true);setMsg("");
    try{
      const sub=await disableWebPush();
      if(sub) pushUnsubscribeFromSheets(sub);
      setPushState("needsPermission");
      setMsg("Notifications disabled on this device.");
    }catch(e){setMsg(String(e?.message||e));}
    setBusy(false);
  };

  const isActive=pushState==="active";
  const canToggle=pushState==="active"||pushState==="needsPermission";
  const onToggle=()=>{
    if(busy) return;
    if(isActive) disableOnDevice();
    else if(pushState==="needsPermission") enable();
  };

  return(<div className="card">
    <h3 className="ctit">Reminders</h3>

    {pushState==="unsupported"&&<div className="rem-status rem-warn"><span className="rem-dot rem-dot-amber"/><span>Background reminders aren't supported here.</span></div>}

    {pushState==="denied"&&<div className="rem-status rem-warn"><span className="rem-dot rem-dot-red"/><span>Notifications blocked. iOS Settings → MooTracker → Notifications → Allow.</span></div>}

    {pushState==="needsHomescreen"&&<div className="rem-install">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>
      <div className="rem-install-body">
        <div className="rem-install-title">Install on Home Screen</div>
        <p>For reminders even when MooTracker is closed:</p>
        <ol><li>Tap the <b>Share</b> button at the bottom of Safari</li><li>Choose <b>Add to Home Screen</b></li><li>Open MooTracker from your icon</li></ol>
      </div>
    </div>}

    {canToggle&&(<div className="rem-smart">
      <div className="rem-smart-row">
        <div className="rem-smart-text">
          <div className="rem-smart-title">Notifications on this device</div>
        </div>
        {isActive&&<button className="btn-ghost rem-status-btn" disabled={busy} onClick={()=>fireTest(false)}>{busy?"…":testResult==="ok"?"✓ Sent":testResult==="fail"?"× Failed":"Test"}</button>}
        <button className={`rem-toggle${isActive?" rem-toggle-on":""}${pulse?" rem-toggle-pulse":""}`} role="switch" aria-checked={isActive} aria-label={`Notifications on this device ${isActive?"on":"off"}`} disabled={busy} onClick={onToggle}>
          <div className="rem-toggle-knob"/>
        </button>
      </div>
    </div>)}

    {msg&&<p className="set-h rem-msg">{msg}</p>}
  </div>);
}

// Actor selector — who's using this device. Stored per-device (NOT synced),
// so Cuixi marking her device "Cuixi" doesn't change Wei's other devices.
// Affects who's credited for saves and which audience this device's push
// subscription falls into ("primary" = Wei, anything else = "caretaker").
function ActorCard(){
  const [current,setCurrent]=useState(()=>getDeviceActor());
  const isCustom=current!=="Wei"&&current!=="Cuixi";
  const [mode,setMode]=useState(isCustom?"Other":current);
  const [customVal,setCustomVal]=useState(isCustom?current:"");
  const [savedFlash,setSavedFlash]=useState(false);
  const [stats,setStats]=useState(null);
  useEffect(()=>{
    if(!SHEETS_URL) return;
    (async()=>{try{const res=await fetch(`${SHEETS_URL}?action=log_stats`,{method:"GET",cache:"no-store"});if(res?.ok) setStats(await res.json());}catch{/* log-stats optional; user card renders without it */}})();
  },[]);

  const commit=async(actor)=>{
    if(!actor) return;
    setDeviceActor(actor);
    setCurrent(actor);
    setSavedFlash(true);setTimeout(()=>setSavedFlash(false),1500);
    try{ await pushUpdateRoleForCurrentSub(); }catch{/* role retag enqueue failed; actor is still saved locally */}
  };

  const pick=(label)=>{
    setMode(label);
    if(label==="Wei"||label==="Cuixi") commit(label);
    else if(label==="Other"&&customVal.trim()) commit(customVal.trim());
  };

  const commitCustom=()=>{
    const v=customVal.trim();
    if(v) commit(v);
  };

  const weekDays=stats?.thisWeek?.distinctDays ?? 0;
  const weekByActor=stats?.thisWeek?.byActor || {};
  const weekWei=weekByActor["Wei"] || 0;
  const weekOthers=Object.entries(weekByActor).filter(([k])=>k!=="Wei");
  const weekSplit=(weekOthers.length>0 && weekDays>0)?`Wei ${weekWei}${weekOthers.map(([k,v])=>` · ${k} ${v}`).join("")}`:null;
  const lastLog=stats?.lastLog || null;
  const lastLogActor=stats?.lastLogActor || "";

  return(<div className="card">
    <h3 className="ctit">This device's user</h3>
    <div className="actor-pills">
      {["Wei","Cuixi","Other"].map(label=>(
        <button key={label} className={`actor-pill${mode===label?" actor-pill-on":""}`} onClick={()=>pick(label)}>{label}</button>
      ))}
    </div>
    {mode==="Other"&&(<div style={{marginTop:8,display:"flex",gap:8}}>
      <input className="add-input" style={{marginBottom:0,flex:1}} value={customVal} onChange={e=>setCustomVal(e.target.value)} onBlur={commitCustom} onKeyDown={e=>{if(e.key==="Enter") commitCustom();}} placeholder="Name (e.g. Mom)"/>
      <button className="btn-sm-p" onClick={commitCustom} disabled={!customVal.trim()}>Save</button>
    </div>)}
    {savedFlash&&<p className="set-saved" style={{marginTop:8}}>Set to {current}.</p>}
    {(weekDays>0||lastLog)&&<div className="actor-stats">
      {weekDays>0&&<div className="actor-stats-week">{weekDays} day{weekDays===1?"":"s"} logged this week</div>}
      {weekSplit&&<div className="actor-stats-faint">{weekSplit}</div>}
      {lastLog&&<div className="actor-stats-faint">Last: {lastLog}{lastLogActor?` · ${lastLogActor}`:""}</div>}
    </div>}
  </div>);
}

function DevNotesSection(){
  const[notes,setNotes]=useState(loadDevNotes);
  const[composing,setComposing]=useState(false);
  const[showPast,setShowPast]=useState(false);
  const[text,setText]=useState("");

  useEffect(()=>{
    const onUpdated=e=>setNotes(Array.isArray(e.detail)?e.detail:loadDevNotes());
    window.addEventListener(DEV_NOTES_EVENT,onUpdated);
    return()=>window.removeEventListener(DEV_NOTES_EVENT,onUpdated);
  },[]);

  const hasNotes=notes.length>0;
  const saveNote=()=>{
    const body=text.trim();
    if(!body) return;
    const note={id:crypto.randomUUID(),text:body,ts:new Date().toISOString()};
    setNotes(saveDevNotes([note,...loadDevNotes()]));
    postDevNoteToWorker(note);
    setText("");
    setComposing(false);
    setShowPast(true);
  };
  const deleteNote=id=>{
    const next=loadDevNotes().filter(n=>n.id!==id);
    setNotes(saveDevNotes(next));
    if(next.length===0) setShowPast(false);
    deleteDevNoteFromWorker(id);
  };

  return(<div className="dev-notes-section">
    <button className="btn-add-note" onClick={()=>setComposing(true)}>Add a Dev Note</button>
    {composing&&<div className="compose">
      <textarea value={text} onChange={e=>setText(e.target.value)} placeholder="Bug, idea, troubleshoot step…"/>
      <div className="compose-actions">
        <button className="btn-ghost" onClick={()=>{setText("");setComposing(false);}}>Cancel</button>
        <button className="btn-sm-p" onClick={saveNote} disabled={!text.trim()}>Save</button>
      </div>
    </div>}
    {hasNotes&&<button className="btn-view-notes" onClick={()=>setShowPast(!showPast)}>{showPast?"Hide":"Dev Notes"}</button>}
    {hasNotes&&showPast&&<div className="past-notes">
      {notes.map(note=><div className="past-item" key={note.id}>
        <div className="past-content">
          <div className="past-ts">{formatDevNoteTs(note.ts)}</div>
          <div className="past-text">{note.text}</div>
        </div>
        <button className="btn-del" onClick={()=>deleteNote(note.id)} aria-label="Delete dev note">&times;</button>
      </div>)}
    </div>}
  </div>);
}

function Medications({medsAll,medEvents,mood,onCreate,onUpdateMeta,onEvent,onUpdateEvent,onDeleteEvent,onBack}){
  const[mode,setMode]=useState("list");
  const[openId,setOpenId]=useState(null);
  const[deleteId,setDeleteId]=useState(null);
  const[filterKey,setFilterKey]=useState("");
  const[discOpen,setDiscOpen]=useState(false);
  const[editing,setEditing]=useState(null);
  const[selectedKey,setSelectedKey]=useState("");
  const[dose,setDose]=useState("");
  const[count,setCount]=useState(1);
  const[date,setDate]=useState(tdk);
  const[reason,setReason]=useState("");
  const[discontinue,setDiscontinue]=useState(false);
  const[generic,setGeneric]=useState("");
  const[brand,setBrand]=useState("");
  const[displayPref,setDisplayPref]=useState("generic");
  const[whenTaken,setWhenTaken]=useState("");
  const[formError,setFormError]=useState("");
  const active=sortMedsByWhen(medsAll.filter(m=>m.status==="active")),stopped=sortMedsByWhen(medsAll.filter(m=>m.status!=="active"));
  const medColor=key=>["#7C7EAE","#9DB28E","#E9C77E","#D4785C","#8DAEA6","#C0BBAF"][Math.max(0,medsAll.findIndex(m=>m.key===key))%6];
  const eventsFor=key=>medEventsWithPrev(medEvents,key);
  const firstDoseDate=key=>Object.entries(mood||{}).filter(([,entry])=>(entry.meds?.[key]?.ct??0)>0).map(([k])=>k).sort()[0]||"";
  const spanStart=med=>eventsFor(med.key).find(row=>row.event.event_type==="reactivated"||row.event.event_type==="started")?.event.date||firstDoseDate(med.key);
  const medMeta=med=>{
    const start=spanStart(med);
    if(med.status==="active")return start?`since ${shortMedDate(start)}`:"";
    const stop=eventsFor(med.key).find(row=>row.event.event_type==="discontinued")?.event.date||med.archived_at;
    return[start,stop].filter(Boolean).map(shortMedDate).join(" – ");
  };
  const changeCount=dir=>setCount(c=>{const n=Number(c)||0;if(dir>0)return n<1?n+.5:n+1;if(n<=0)return 0;if(n<=1)return Math.max(0,n-.5);return n-1;});
  const reset=()=>{setMode("list");setEditing(null);setSelectedKey("");setDose("");setCount(1);setDate(tdk());setReason("");setDiscontinue(false);setGeneric("");setBrand("");setDisplayPref("generic");setWhenTaken("");setFormError("");};
  const beginChange=key=>{
    const med=medByKey(medsAll,key)||active[0]||stopped[0];if(!med){setMode("new");return;}
    setEditing(null);setSelectedKey(med.key);setDose(med.dose||"");setCount(Number(med.default_ct??0));setDate(tdk());setReason("");setDiscontinue(false);setFormError("");setMode("change");
  };
  const beginInfo=key=>{
    const med=medByKey(medsAll,key);if(!med)return;
    setEditing(null);setSelectedKey(med.key);setGeneric(med.name||"");setBrand(med.brand||"");setDisplayPref(med.brand?med.display_pref||"both":"generic");setWhenTaken(medWhenTaken(med));setFormError("");setMode("info");
  };
  const beginEdit=row=>{
    const ev=row.event;
    setEditing(row);setSelectedKey(ev.med_key);setDose(ev.dose_text||"");setCount(Number(ev.new_ct??0));setDate(ev.date||tdk());setReason(ev.notes||"");setDiscontinue(medIsStoppedEvent(ev));setFormError("");setMode("change");
  };
  const saveChange=()=>{
    const med=medByKey(medsAll,selectedKey);if(!med)return;
    const oldCt=editing?editing.prev?.new_ct:med.default_ct;
    const oldDose=editing?editing.prev?.dose_text:med.dose;
    const newDose=dose.trim()||oldDose||med.dose||null;
    const doseChanged=medDoseLabel(newDose)!==medDoseLabel(oldDose);
    const countChanged=Number(count)!==Number(oldCt??0);
    let eventType;
    if(discontinue)eventType="discontinued";
    else if(!editing&&med.status!=="active")eventType="reactivated";
    else if(countChanged)eventType=Number(count)>Number(oldCt??0)?"increased":"decreased";
    else if(doseChanged){const cmp=medCompareDose(newDose,oldDose);eventType=cmp<0?"decreased":"increased";}
    else{setFormError("Change the strength or daily count, or choose Discontinue.");return;}
    if(editing)onUpdateEvent({id:editing.event.id,key:med.key,event_type:eventType,new_ct:Number(count),dose_text:newDose,date,notes:reason.trim()});
    else onEvent({key:med.key,event_type:eventType,new_ct:Number(count),dose_text:newDose,date,notes:reason.trim()});
    reset();
  };
  const saveNew=()=>{
    const g=generic.trim(),b=brand.trim();if(!g&&!b){setFormError("Enter a generic or brand name.");return;}
    const name=g||b,key=(g||b).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"")+"_"+Date.now();
    onCreate({key,name,brand:b||null,display_pref:b?displayPref:"generic",dose:dose.trim()||null,default_ct:Number(count)||0,when_taken:whenTaken,start_date:date});
    reset();
  };
  const saveInfo=()=>{
    const med=medByKey(medsAll,selectedKey);if(!med)return;
    const g=generic.trim(),b=brand.trim();if(!g&&!b){setFormError("Enter a generic or brand name.");return;}
    onUpdateMeta({key:med.key,name:g||b,brand:b||null,display_pref:b?displayPref:"generic",when_taken:whenTaken});
    reset();
  };
  const selected=medByKey(medsAll,selectedKey);
  const priorDose=editing?editing.prev?.dose_text:selected?.dose;
  const priorCt=editing?editing.prev?.new_ct:selected?.default_ct;
  const preview=selected?medEventVerb({event_type:discontinue?"discontinued":"changed",dose_text:dose.trim()||priorDose,new_ct:discontinue?null:Number(count)},editing?.prev||{dose_text:priorDose,new_ct:priorCt}):null;
  const allRows=medsAll.flatMap(m=>medEventsWithPrev(medEvents,m.key).map(row=>({...row,med:m}))).sort((a,b)=>medEventDesc(a.event,b.event));
  const filteredRows=filterKey?allRows.filter(row=>row.event.med_key===filterKey):allRows;
  const snapshotFor=row=>{
    const rows=[];
    for(const med of medsAll){
      const latest=(medEvents||[]).filter(ev=>ev.med_key===med.key&&String(ev.date||"")<=String(row.event.date||"")).sort(medEventDesc)[0];
      if(latest&&!medIsStoppedEvent(latest))rows.push({med,event:latest,subject:med.key===row.event.med_key});
    }
    if(!rows.some(r=>r.med.key===row.event.med_key)){
      const med=medByKey(medsAll,row.event.med_key)||row.med;
      rows.push({med,event:row.event,subject:true});
    }
    return rows;
  };
  const renderHistoryRow=(row,isLast)=>{
    const ev=row.event,med=row.med,names=medNames(med,ev.med_key),dt=medDowDate(ev.date),isOpen=openId===ev.id;
    return(<div className={`g-med-te${isOpen?" open":""}${medIsStoppedEvent(ev)?" stop":""}${isLast?" lastinmon":""}`} key={ev.id}>
      <span className="g-med-tdot" style={{background:medColor(ev.med_key)}}/>
      <button className="g-med-te-head" onClick={()=>{setOpenId(isOpen?null:ev.id);setDeleteId(null);}}>
        <span className="g-med-te-chev">›</span>
        <span className="g-med-te-date"><span>{dt.dow}</span>{dt.label}</span>
        <span className="g-med-te-line"><span className="g-med-te-name" onClick={e=>{e.stopPropagation();setFilterKey(ev.med_key);}}>{names.primary}</span> {row.derived.phrase}{row.derived.was&&<span className="g-med-was"> (was {row.derived.was})</span>}</span>
        {ev.notes&&<span className="g-med-te-why">{ev.notes}</span>}
      </button>
      {isOpen&&<div className="g-med-snap tall"><div className="g-med-snap-in">
        {snapshotFor(row).map(s=>{
          const sn=medNames(s.med,s.med.key);
          return <div className={`g-med-snap-row${s.subject?" subject":""}`} key={s.med.key}>
            <span className="g-med-snap-tick" style={{"--tick":medColor(s.med.key)}}/>
            <span className="g-med-snap-stack"><span className="g-med-snap-nm">{sn.primary}</span>
              {s.subject?<span className="g-med-snap-tr"><span>{row.prev&&!medIsStoppedEvent(row.prev)?medRegimenLabel(row.prev.dose_text,row.prev.new_ct):"none"}</span><i>→</i>{medIsStoppedEvent(ev)?"discontinued":medRegimenLabel(ev.dose_text,ev.new_ct)}</span>:<span className="g-med-snap-dose">{medRegimenLabel(s.event.dose_text,s.event.new_ct)}</span>}
            </span>
          </div>;
        })}
        {deleteId===ev.id?<div className="g-med-te-confirm"><span>Remove this change?</span><button onClick={()=>setDeleteId(null)}>Keep</button><button className="remove" onClick={()=>{onDeleteEvent(ev.id,ev.med_key);setDeleteId(null);setOpenId(null);}}>Remove</button></div>:<div className="g-med-te-actions"><button className="edit" onClick={()=>beginEdit(row)}><span>✎</span>Edit</button><button className="del" onClick={()=>setDeleteId(ev.id)}>Delete</button></div>}
      </div></div>}
    </div>);
  };
  const historyGroups=[];
  for(const row of filteredRows){
    const month=medDowDate(row.event.date).month;
    let group=historyGroups[historyGroups.length-1];
    if(!group||group.month!==month){group={month,rows:[]};historyGroups.push(group);}
    group.rows.push(row);
  }

  return(<BottomSheet onClose={onBack} sheetClass="g-medications" title={mode==="list"?"Medications":mode==="new"?"New medication":mode==="info"?"Med info":editing?"Edit change":"Record a change"}>
    {mode==="list"&&<>
      <div className="g-med-card">
        <span className="g-med-ctit">Taking now</span>
        {active.length?active.map(m=>{const n=medNames(m,m.key),when=medWhenLabel(m);return <button className="g-med-now-row" key={m.key} onClick={()=>beginInfo(m.key)}><span className="g-med-sw" style={{background:medColor(m.key)}}/><span className="g-med-now-name"><b>{n.primary}</b>{n.secondary&&<small>{n.secondary}</small>}</span><span className="g-med-dose">{medRegimenLabel(m.dose,m.default_ct)}{when&&<small>{when}</small>}</span></button>;}):<p className="g-med-empty">No active medications.</p>}
      </div>
      {stopped.length>0&&<div className={`g-med-disc${discOpen?" open":""}`}><button className="g-med-disc-head" onClick={()=>setDiscOpen(v=>!v)}><span>{stopped.length} discontinued</span><i>›</i></button>{discOpen&&<div className="g-med-disc-body">{stopped.map(m=>{const n=medNames(m,m.key),when=medWhenLabel(m);return <button className="g-med-disc-row" key={m.key} onClick={()=>beginInfo(m.key)}><span className="g-med-sw" style={{background:medColor(m.key)}}/><span className="g-med-now-name"><b>{n.primary}</b>{n.secondary&&<small>{n.secondary}</small>}{when&&<small>{when}</small>}</span><span className="g-med-disc-range">{medMeta(m)}</span></button>;})}</div>}</div>}
      <div className="g-med-actions-slot"><button className="g-med-add top" onClick={()=>beginChange(active[0]?.key||stopped[0]?.key)}><span>+</span> Record a change</button></div>
      <div className="g-med-card">
        <div className="g-med-hist-head"><span className="g-med-ctit">History</span>{filterKey&&<button className="g-med-filter" onClick={()=>setFilterKey("")}>× {medPrimary(medByKey(medsAll,filterKey),filterKey)}</button>}</div>
        {historyGroups.length?historyGroups.map(group=><Fragment key={group.month}><div className="g-med-mon">{group.month}</div>{group.rows.map((row,i)=>renderHistoryRow(row,i===group.rows.length-1))}</Fragment>):<p className="g-med-empty">No recorded changes yet.</p>}
      </div>
    </>}
    {mode==="change"&&selected&&<>
      <div className="g-med-card">
        <div className="g-med-field"><label>Medication</label><div className="g-med-chips">{[...active,...stopped].map(m=><button className={`g-med-chip${m.key===selectedKey?" on":""}`} key={m.key} onClick={()=>!editing&&beginChange(m.key)}>{medPrimary(m,m.key)}</button>)}{!editing&&<button className="g-med-chip new" onClick={()=>{setMode("new");setFormError("");}}>+ New</button>}</div></div>
        <div className="g-med-field"><label>Change</label><div className="g-med-two"><div><input className="g-med-input" value={dose} onChange={e=>setDose(e.target.value)} placeholder="100mg"/><small>Was {medDoseLabel(priorDose)}</small></div><div><div className="g-med-step"><button onClick={()=>changeCount(-1)}>−</button><b>{count}</b><button onClick={()=>changeCount(1)}>+</button><span>/ day</span></div><small>Was {medCountLabel(priorCt)}</small></div></div>
        <button className={`g-med-stop${discontinue?" on":""}`} onClick={()=>setDiscontinue(v=>!v)}>⊘ Discontinue</button></div>
        <div className="g-med-field"><label>Effective date</label><input type="date" className="g-med-input" value={date} onChange={e=>setDate(e.target.value)}/></div>
        <div className="g-med-field"><label>Reason</label><textarea className="g-med-textarea" value={reason} onChange={e=>setReason(e.target.value)} placeholder="Prescriber instruction, side effect, or taper"/></div>
        {preview&&<div className="g-med-preview"><span>{editing?"Will update":"Will record"}</span><p><b>{medPrimary(selected,selected.key)}</b> {preview.phrase}{preview.was&&<em> (was {preview.was})</em>}<small>Effective {shortMedDate(date)}</small>{reason.trim()&&<small>{reason.trim()}</small>}</p></div>}
        {formError&&<p className="g-med-error">{formError}</p>}
      </div>
      <div className="g-med-actions"><button onClick={reset}>Cancel</button><button className="primary" onClick={saveChange}>Save</button></div>
    </>}
    {mode==="new"&&<>
      <div className="g-med-card">
        <div className="g-med-field"><label>Name</label><small>Generic / scientific name</small><input className="g-med-input" value={generic} onChange={e=>setGeneric(e.target.value)} placeholder=""/><small>Brand or nickname</small><input className="g-med-input" value={brand} onChange={e=>setBrand(e.target.value)} placeholder=""/><em>Either can be left blank.</em></div>
        <div className="g-med-field"><label>Show as</label><div className="g-med-seg">{["generic","both","brand"].map(pref=><button className={displayPref===pref?"on":""} key={pref} onClick={()=>setDisplayPref(pref)}>{pref[0].toUpperCase()+pref.slice(1)}</button>)}</div></div>
        <div className="g-med-field"><label>Starting dose</label><div className="g-med-two"><div><input className="g-med-input" value={dose} onChange={e=>setDose(e.target.value)} placeholder="100mg"/><small>Dose per pill</small></div><div><div className="g-med-step"><button onClick={()=>changeCount(-1)}>−</button><b>{count}</b><button onClick={()=>changeCount(1)}>+</button><span>/ day</span></div><small>Daily count</small></div></div></div>
        <div className="g-med-field"><label>When taken</label><WhenTakenPicker value={whenTaken} onChange={setWhenTaken}/></div>
        <div className="g-med-field"><label>Effective date</label><input type="date" className="g-med-input" value={date} onChange={e=>setDate(e.target.value)}/></div>
        {formError&&<p className="g-med-error">{formError}</p>}
      </div>
      <div className="g-med-actions"><button onClick={reset}>Cancel</button><button className="primary" onClick={saveNew}>Add</button></div>
    </>}
    {mode==="info"&&selected&&<>
      <div className="g-med-card">
        <div className="g-med-field"><label>Name</label><small>Generic / scientific name</small><input className="g-med-input" value={generic} onChange={e=>setGeneric(e.target.value)} placeholder=""/><small>Brand or nickname</small><input className="g-med-input" value={brand} onChange={e=>setBrand(e.target.value)} placeholder=""/><em>Either can be left blank.</em></div>
        <div className="g-med-field"><label>Show as</label><div className="g-med-seg">{["generic","both","brand"].map(pref=><button className={displayPref===pref?"on":""} key={pref} onClick={()=>setDisplayPref(pref)}>{pref[0].toUpperCase()+pref.slice(1)}</button>)}</div></div>
        <div className="g-med-field"><label>When taken</label><WhenTakenPicker value={whenTaken} onChange={setWhenTaken}/></div>
        {formError&&<p className="g-med-error">{formError}</p>}
      </div>
      <div className="g-med-actions"><button onClick={reset}>Cancel</button><button className="primary" onClick={saveInfo}>Save</button></div>
    </>}
  </BottomSheet>);
}

function Settings({settings,setS,onBack}){
  const[pcStep,setPcStep]=useState(null);const[pc1,setPc1]=useState("");const[pc2,setPc2]=useState("");
  const[showAdvanced,setShowAdvanced]=useState(false);
  const[weiTz,setWeiTz]=useState(getDeviceWeiTz());

  const curPc=pcStep==="new"?pc1:pc2;
  const pcTap=n=>{if(pcStep==="new"){const nx=pc1+n;setPc1(nx);if(nx.length===4)setTimeout(()=>setPcStep("confirm"),200);}else if(pcStep==="confirm"){const nx=pc2+n;setPc2(nx);if(nx.length===4){if(nx===pc1){setS({passcode:nx});setPcStep(null);}else setPc2("");}}};
  const pcDel=()=>{if(pcStep==="new")setPc1(pc1.slice(0,-1));else setPc2(pc2.slice(0,-1));};
  const pcClear=()=>{if(pcStep==="new")setPc1("");else setPc2("");};
  return(<BottomSheet onClose={onBack} sheetClass="g-settings" title="Settings">

    <ActorCard/>

    <RemindersCard settings={settings} setS={setS}/>

    <div className="card set-quiet">
      <h3 className="ctit">Passcode Lock</h3>
      {settings.passcode&&!pcStep&&(<div><p className="set-h" style={{marginBottom:10}}>Passcode is set.</p>
        <div className="set-pcb"><button className="btn-s" style={{fontSize:13,padding:"10px 16px"}} onClick={()=>{setPcStep("new");setPc1("");setPc2("");}}>Change</button><button className="btn-ghost" style={{color:"#D4785C"}} onClick={()=>setS({passcode:""})}>Remove</button></div></div>)}
      {!settings.passcode&&!pcStep&&(<div><button className="btn-s" style={{fontSize:13,padding:"10px 16px"}} onClick={()=>{setPcStep("new");setPc1("");setPc2("");}}>Set Passcode</button></div>)}
      {pcStep&&(<div className="set-pcf"><p className="set-h">{pcStep==="new"?"Enter 4-digit passcode":"Confirm passcode"}</p>
        <div className="lock-dots" style={{justifyContent:"flex-start",margin:"12px 0"}}>{[0,1,2,3].map(i=><div key={i} className={`lock-dot${i<curPc.length?" on":""}`}/>)}</div>
        <div className="set-pad">{[1,2,3,4,5,6,7,8,9,"C",0,"del"].map((n,i)=>(<button key={i} className={`lk lksm${n==="del"?" lkdel":n==="C"?" lkclr":""}`} onClick={()=>{if(n==="del")pcDel();else if(n==="C")pcClear();else pcTap(String(n));}} disabled={false}>{n==="del"?"‹":""+n}</button>))}</div>
        <button className="btn-ghost" onClick={()=>setPcStep(null)}>Cancel</button></div>)}
    </div>

    <button className="settings-advanced-toggle" aria-expanded={showAdvanced} onClick={()=>setShowAdvanced(!showAdvanced)}><span>Advanced</span><span className="adv-chev" aria-hidden="true">⌄</span></button>
    {showAdvanced&&<div className="settings-advanced">
      <div className="card"><h3 className="ctit">Wei's time zone</h3>
        <p className="set-h" style={{marginTop:0}}>Set this to Wei's time zone if you log from a different one — dates land on Wei's day, not yours. Leave on the default if you and Wei share a time zone.</p>
        <select className="add-input" style={{marginTop:10,marginBottom:0}} value={weiTz} onChange={e=>{setDeviceWeiTz(e.target.value);setWeiTz(getDeviceWeiTz());}}>
          <option value="">This device's time zone (default)</option>
          {TZ_LIST.map(z=><option key={z} value={z}>{z}</option>)}
        </select>
        <p className="set-saved" style={{marginTop:8}}>Wei's today: {tdk()} · {weiHM()}</p>
      </div>
      {SHEETS_URL&&<div className="card"><h3 className="ctit">Google Sheets Sync</h3><p className="set-h" style={{marginTop:0}}>Active — entries sync one at a time. Pull from sheets on app open.</p><button className="btn-s" style={{fontSize:13,padding:"10px 16px",marginTop:8}} onClick={()=>{localStorage.removeItem("mt_seed_pushed");window.location.reload();}}>Force re-sync all data</button></div>}
      {!SHEETS_URL&&<div className="card"><h3 className="ctit">Google Sheets Sync</h3><p className="set-h" style={{marginTop:0}}>Not configured. Set SHEETS_URL in the code to enable.</p></div>}
      <DevNotesSection/>
      <p className="ver-label">MooTracker v{VER}</p>
    </div>}
  </BottomSheet>);
}

/* ── REMINDER ENGINE ── */
if(typeof window!=="undefined"){
  setInterval(()=>{try{const set=JSON.parse(localStorage.getItem("mt_set")||"{}");if(!set.reminders)return;
    const t=weiHM();
    set.reminders.forEach(r=>{if(r.on&&r.time===t&&Notification.permission==="granted"){const lk="mt_n_"+r.time;const last=localStorage.getItem(lk);const td=tdk();
      if(last!==td){new Notification("MooTracker",{body:r.label||"Time to log"});localStorage.setItem(lk,td);}}});
  }catch{/* legacy reminder state invalid or notification blocked; interval can try again later */}},30000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   CSS
   ═══════════════════════════════════════════════════════════════════════════ */
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=Inter:opsz,wght@14..32,300;14..32,400;14..32,500;14..32,600&family=Source+Serif+4:ital,opsz,wght@0,8..60,300;0,8..60,400;0,8..60,500;1,8..60,300&display=swap');
:root{--bg:#F7F2EA;--card:#FFFCF6;--tx:#3A332E;--t2:#857F76;--t3:#C8C0B5;--bd:#EEE7DC;--warm:#F2EBDF;--gn:#7BA08B;--gbg:#EFF6F1;--r:14px;--rs:10px;--sh:0 1px 2px rgba(60,40,20,.025),0 12px 28px rgba(60,40,20,.05);--ease:cubic-bezier(.16,1,.3,1);--z-very-short:#B0573D;--z-short:#D49479;--z-healthy:#9DB28E;--z-long:#7E89A8;--wei:#8FA889;--g-bg:#F5F3EE;--g-surface:#ECE8E0;--g-card:#FBFAF6;--g-line:#E2DED4;--g-tx:#1C1C1A;--g-tx2:#6E6A60;--g-tx3:#9A968C;--g-tx4:#C0BBAF;--g-warm-err:#BE7355;--g-mood-sev-low:#5B5E86;--g-mood-mod-low:#7C7EAE;--g-mood-mild-low:#B3A8CC;--g-mood-steady:#CFC9AE;--g-mood-mild-high:#E9C77E;--g-mood-mod-high:#EE9A52;--g-mood-sev-high:#E96A33;--g-sleep-very-short:#C9B9CE;--g-sleep-short:#B3A8D0;--g-sleep-healthy:#93A2CC;--g-sleep-long:#8AB4C8;--g-anx:#7A7268;--g-irr:#ADA593}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
input,textarea,select{font-size:16px}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--tx);-webkit-font-smoothing:antialiased}
.app{max-width:420px;margin:0 auto;min-height:100dvh;overflow-x:hidden}
.page{animation:pageIn .4s var(--ease)}
@keyframes pageIn{from{opacity:0}to{opacity:1}}
.scr{padding:env(safe-area-inset-top) 20px 140px;min-height:100dvh}

.btn-p{width:100%;padding:15px 24px;border-radius:var(--r);border:none;background:var(--tx);color:#fff;font:500 15px/1 'DM Sans',sans-serif;cursor:pointer;transition:all .15s var(--ease);letter-spacing:.01em}
.btn-p:active{transform:scale(.98);opacity:.9}.btn-p.bd{opacity:.25;pointer-events:none}
.btn-s{padding:15px 24px;border-radius:var(--r);border:1.5px solid var(--bd);background:transparent;color:var(--tx);font:500 15px/1 'DM Sans',sans-serif;cursor:pointer;transition:all .15s}
.btn-s:hover{border-color:var(--t3)}.btn-s:active{transform:scale(.98)}
.btn-rhythm{padding:15px 24px;border-radius:var(--r);border:none;background:#6478A0;color:#fff;font:500 15px/1 'DM Sans',sans-serif;cursor:pointer;transition:all .15s var(--ease)}
.btn-rhythm:active{transform:scale(.98);opacity:.9}
.bi{width:36px;height:36px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font-size:16px;color:var(--t2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
.bi:hover{border-color:var(--t3)}
.btn-ghost{border:none;background:none;color:var(--t3);font:400 13px 'DM Sans',sans-serif;cursor:pointer;padding:8px}
.br{width:52px;height:52px;border-radius:50%;border:1.5px solid var(--bd);background:transparent;font-size:22px;color:var(--tx);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
.br:hover{border-color:var(--t3)}.br:active{transform:scale(.92)}
.bs{width:30px;height:30px;border-radius:8px;border:1px solid var(--bd);background:transparent;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--tx)}
.bx{padding:7px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;transition:all .15s}
.bx:hover{border-color:var(--t3)}
.btn-sm-p{padding:8px 16px;border-radius:var(--rs);border:none;background:var(--tx);color:#fff;font:500 13px 'DM Sans',sans-serif;cursor:pointer}
.btn-add{width:100%;padding:12px;border-radius:var(--rs);border:1.5px dashed var(--bd);background:transparent;color:var(--t3);font:400 13px 'DM Sans',sans-serif;cursor:pointer;transition:all .15s}
.btn-add:hover{border-color:var(--t2);color:var(--t2)}

.g-ambient-sky{position:relative;overflow:hidden;background:radial-gradient(135% 44% at 50% 100%, rgba(233,176,120,.20) 0%, transparent 62%),radial-gradient(125% 40% at 50% 0%, rgba(150,142,184,.15) 0%, transparent 56%),var(--g-bg)}
.g-ambient-sky>*{position:relative;z-index:1}
.g-grain{position:relative;overflow:hidden}
.g-grain::after{content:"";position:absolute;inset:0;z-index:0;pointer-events:none;opacity:.15;mix-blend-mode:soft-light;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.55'/%3E%3C/svg%3E");background-size:160px 160px}
.g-card{background:var(--g-card);border:1px solid var(--g-line);border-radius:16px;box-shadow:none}
.g-btn-p,.g-btn-s,.g-btn-ghost{border-radius:999px;font:500 15px/1 'Inter',system-ui,sans-serif;cursor:pointer;transition:background .15s,color .15s,border-color .15s,transform .15s}
.g-btn-p{border:1px solid var(--g-tx);background:var(--g-tx);color:#fff;padding:14px 22px}
.g-btn-s{border:1px solid var(--g-line);background:transparent;color:var(--g-tx);padding:14px 22px}
.g-btn-ghost{border:none;background:transparent;color:var(--g-tx3);padding:10px 12px}
.g-btn-danger{color:var(--g-warm-err)}
.g-btn-danger.g-btn-p{border-color:var(--g-warm-err);background:var(--g-warm-err);color:#fff}
.g-btn-danger.g-btn-s{border-color:var(--g-warm-err);color:var(--g-warm-err)}
.g-btn-p:active,.g-btn-s:active,.g-btn-ghost:active{transform:scale(.98)}

.g-welcome{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;overflow:hidden;padding:0 32px 40px;background:var(--g-bg);font-family:'Inter',system-ui,sans-serif;color:var(--g-tx)}
.scr.g-welcome{min-height:calc(100dvh + env(safe-area-inset-bottom));padding:0 32px calc(40px + env(safe-area-inset-bottom))}
.g-welcome::after{z-index:3}
.g-welcome-sky{position:absolute;inset:-22%;z-index:0;background:radial-gradient(120% 72% at 50% 100%, #F8EFDB 0%, transparent 60%),linear-gradient(180deg, #DBD7E6 0%, #E4DFD1 42%, #F1E1C2 74%, #ECC79E 100%);transform-origin:50% 100%;animation:gSkyRise .9s ease both,gSkyBreathe 9s ease-in-out .9s infinite alternate}
.g-welcome-bubbles{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:hidden}
.g-wb{position:absolute;border-radius:50%;opacity:0;background:radial-gradient(circle,rgba(233,199,126,.35) 0%,transparent 70%);animation:gBubbleFloat linear infinite}
.g-wb:nth-child(1){width:120px;height:120px;left:12%;animation-duration:22s;animation-delay:0s;background:radial-gradient(circle,rgba(179,168,204,.30) 0%,transparent 70%)}
.g-wb:nth-child(2){width:80px;height:80px;left:62%;animation-duration:27s;animation-delay:6s}
.g-wb:nth-child(3){width:150px;height:150px;left:38%;animation-duration:32s;animation-delay:12s;background:radial-gradient(circle,rgba(233,176,120,.28) 0%,transparent 70%)}
.g-welcome-center{position:relative;z-index:4;display:flex;flex-direction:column;align-items:center;transform:translateY(-32px)}
.g-welcome-cat{width:144px;height:144px;color:var(--g-tx);transform-origin:50% 66%;animation:gCatWake .9s cubic-bezier(.2,.85,.25,1) both,gCatBreathe 4.6s ease-in-out 1s infinite alternate}
.g-welcome-cat svg{width:100%;height:100%;display:block}
.g-welcome-greet{margin-top:14px;max-width:268px;color:rgba(28,28,26,.72);font:300 18px/1.5 'Inter',system-ui,sans-serif;letter-spacing:0;animation:gWelcomeRise 1.2s ease 1s both}
.g-welcome-cue{position:absolute;z-index:4;bottom:calc(28px + env(safe-area-inset-bottom));width:30px;height:4px;border-radius:999px;background:rgba(28,28,26,.36);animation:gCueBreathe 2.8s ease-in-out 1s infinite}
@keyframes gSkyRise{from{opacity:0;transform:scale(1.05) translateY(3%)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes gSkyBreathe{from{transform:scale(1)}to{transform:scale(1.06) translateY(-1.2%)}}
@keyframes gCatWake{from{opacity:0;transform:translateY(12px) scale(.9);filter:blur(3px)}to{opacity:1;transform:translateY(0) scale(1);filter:blur(0)}}
@keyframes gCatBreathe{0%{transform:translateY(0) scale(1) rotate(-1deg)}100%{transform:translateY(-4px) scale(1.06) rotate(1deg)}}
@keyframes gBubbleFloat{0%{transform:translateY(110%) scale(.9);opacity:0}15%{opacity:1}85%{opacity:1}100%{transform:translateY(-20%) scale(1.05);opacity:0}}
@keyframes gWelcomeRise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes gCueBreathe{0%,100%{opacity:.34;transform:scaleX(.86)}50%{opacity:.58;transform:scaleX(1)}}
.welcome{display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}
.w-top{margin-bottom:60px;animation:wIn .8s var(--ease)}
@keyframes wIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.w-icon{width:80px;height:80px;margin:0 auto 24px;color:var(--tx);opacity:.7;animation:iconFloat 3s ease-in-out infinite 2s}
.w-icon svg{width:100%;height:100%}
.w-draw{stroke-dasharray:3000;stroke-dashoffset:3000;animation:drawIn 2.2s var(--ease) forwards}
.w-draw2{animation-delay:.5s}
@keyframes drawIn{0%{stroke-dashoffset:3000;fill-opacity:0}70%{fill-opacity:0}100%{stroke-dashoffset:0;fill:currentColor;fill-opacity:1;stroke-opacity:0}}
@keyframes iconFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.w-t{font-family:'Inter',system-ui,sans-serif;font-weight:400;font-size:30px;letter-spacing:-.3px;margin-bottom:10px}
.w-s{color:var(--t2);font-size:15px;line-height:1.6;max-width:280px;font-weight:300;font-style:italic}
.w-b{width:100%;max-width:280px;animation:wBIn .8s var(--ease) .3s both}
@keyframes wBIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

.g-lock-scr{position:relative;display:flex;align-items:center;justify-content:center;flex-direction:column;background:var(--g-bg);overflow:hidden;font-family:'Inter',system-ui,sans-serif;padding:0}
.scr.g-lock-scr{padding:0}
.g-lock-scr::before{content:"";position:absolute;left:-20%;right:-20%;bottom:-10%;height:50%;background:radial-gradient(110% 80% at 50% 100%, rgba(233,176,120,.20) 0%, transparent 65%);pointer-events:none}
.g-lock-in{position:relative;z-index:1;width:100%;min-height:100dvh;text-align:center;display:flex;flex-direction:column;align-items:center;padding:calc(84px + env(safe-area-inset-top)) 30px calc(40px + env(safe-area-inset-bottom))}
.g-lock-mark{width:74px;height:74px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--g-tx);background:radial-gradient(circle at 50% 55%, rgba(233,199,126,.45) 0%, rgba(179,168,204,.22) 60%, transparent 78%)}
.g-lock-mark svg{width:52px;height:52px}
.g-lock-lbl{margin-top:22px;font:400 14px/1.4 'Inter',system-ui,sans-serif;color:var(--g-tx2);min-height:20px}
.g-lock-lbl.err{color:var(--g-warm-err)}
.g-lock-dots{display:flex;gap:16px;justify-content:center;margin-top:20px}
.g-lock-dot{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--g-tx4);background:transparent;transition:background .2s,border-color .2s}
.g-lock-dot.on{background:var(--g-tx);border-color:var(--g-tx)}
.g-lock-shake{animation:gLockShake .45s ease}
@keyframes gLockShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
.g-lock-pad{margin-top:auto;display:grid;grid-template-columns:repeat(3,76px);gap:14px;justify-content:center}
.g-lk{width:76px;height:76px;border-radius:50%;border:none;background:var(--g-surface);font:400 30px/1 'Inter',system-ui,sans-serif;color:var(--g-tx);cursor:pointer;transition:background .1s,transform .1s;display:flex;align-items:center;justify-content:center}
.g-lk:active{background:#E2DDD2;transform:scale(.98)}
.g-lk-fn{background:transparent;color:var(--g-tx3);font-size:16px}
.g-lk-fn:active{background:var(--g-surface)}
.lock-scr{display:flex;align-items:center;justify-content:center;flex-direction:column}
.lock-in{text-align:center}
.lock-ico{font-size:28px;margin-bottom:16px;color:var(--t3);opacity:.6}
.lock-lbl{font-size:14px;color:var(--t2);margin-bottom:20px;font-weight:300;min-height:20px}
.lock-dots{display:flex;gap:12px;justify-content:center;margin-bottom:32px}
.lock-dot{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--bd);background:transparent;transition:all .2s}
.lock-dot.on{background:var(--tx);border-color:var(--tx)}
.lock-shake{animation:shake .4s ease}
@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
.lock-pad{display:grid;grid-template-columns:repeat(3,72px);gap:10px;justify-content:center}
.lk{width:72px;height:56px;border-radius:12px;border:1px solid var(--bd);background:var(--card);font:300 22px 'Inter',system-ui,sans-serif;color:var(--tx);cursor:pointer;transition:all .1s;display:flex;align-items:center;justify-content:center}
.lk:active{background:var(--warm);transform:scale(.95)}
.lke{border:none!important;background:transparent!important;cursor:default;pointer-events:none}
.lksm{width:56px;height:44px;font-size:18px}
.lkdel{background:transparent;border:none;color:var(--t2)}
.lkdel:active{background:transparent;transform:scale(.95)}
.lkclr{background:transparent;border:1px solid var(--bd);color:var(--t2)}
.whead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}
.wstat{text-align:right}
.wsv{font-weight:500;font-size:16px}
.wsd{font-size:12px;color:var(--t3)}

.set-pad{display:grid;grid-template-columns:repeat(3,56px);gap:8px;margin-bottom:12px}

.cal-top{display:flex;align-items:flex-start;justify-content:space-between;padding:24px 0 16px}
.sync-badge{display:inline-block;font-size:10px;font-family:'Inter',system-ui,sans-serif;font-weight:500;padding:2px 8px;border-radius:99px;vertical-align:middle;margin-left:6px}
.sync-badge.active{background:#EDF0F6;color:#6478A0;animation:syncPulse 1.5s ease-in-out infinite}
.sync-badge.done{background:#EFF6F1;color:#7BA08B}
@keyframes syncPulse{0%,100%{opacity:1}50%{opacity:.5}}
.cal-tr{display:flex;gap:6px;align-items:center}.cal-gr{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:2px}
.cht{font-family:'Inter',system-ui,sans-serif;font-weight:400;font-size:22px}.cnav{display:flex;gap:4px}
.streak{display:flex;align-items:center;gap:6px;padding:10px 14px;background:var(--gbg);border-radius:var(--rs);font-size:13px;color:var(--gn);font-weight:400;margin-bottom:16px}
.cg{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:12px}
.clb{font-size:10px;font-weight:500;color:var(--t3);text-align:center;padding:4px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.cc{aspect-ratio:1;border-radius:var(--rs);display:flex;align-items:center;justify-content:center;position:relative;font-size:13px;color:var(--t2);transition:all .2s;cursor:default}
.cc.cl{cursor:pointer}.ce{pointer-events:none}.cl{font-weight:500;color:var(--tx)}
.ct .cn{font-weight:600}.ct::after{content:'';position:absolute;bottom:3px;width:4px;height:4px;border-radius:50%;background:var(--tx)}
.cd{position:absolute;inset:3px;border-radius:7px;transition:opacity .2s}
.csel{}
.cleg{display:flex;flex-wrap:wrap;gap:6px 10px;margin-bottom:16px;padding:0 2px}
.cli{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--t3)}.cld{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.cact{position:fixed;left:0;right:0;bottom:0;padding:12px 20px calc(16px + env(safe-area-inset-bottom, 0px));background:linear-gradient(to top,var(--bg) 70%,transparent);z-index:50;display:flex;flex-direction:column;gap:10px;max-width:420px;margin:0 auto}
.cact-row{display:flex;gap:10px}
.cact-row > button{flex:1}
.cal-pad{height:140px}

.day-card{background:var(--card);border-radius:var(--r);padding:14px 16px;box-shadow:var(--sh);cursor:pointer;transition:all .15s;animation:si .25s var(--ease);margin-bottom:4px}
.day-card:active{transform:scale(.99)}
.day-card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.day-card-date{font-size:12px;font-weight:500;color:var(--t3)}
.day-card-arrow{font-size:11px;color:var(--t3)}
.day-card-mood{font-size:15px;font-weight:500;margin-bottom:4px}
.day-card-note{font-size:13px;color:var(--t2);font-weight:300;line-height:1.4;margin-bottom:6px}
.day-chips{display:flex;flex-wrap:wrap;gap:4px}.day-chip{display:inline-block;padding:3px 8px;border-radius:6px;font-size:11px;color:var(--t2);background:var(--warm)}

.ent{padding-top:22px}.et{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.scr.g-entry{padding:calc(26px + env(safe-area-inset-top)) 22px calc(72px + env(safe-area-inset-bottom,0px));font-family:'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-entry::after{z-index:0}
.g-entry .et{position:relative;z-index:1;gap:12px;margin-bottom:14px}
.g-entry .bi{width:30px;height:30px;border:none;border-radius:50%;background:var(--g-surface);color:var(--g-tx2)}
.g-entry .btn-ghost{font-family:'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .es{font:500 11px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3);letter-spacing:.1em;text-transform:uppercase}
.g-entry .pb{position:relative;z-index:1;height:3px;background:var(--g-line);margin-bottom:18px}
.g-entry .pf{background:var(--g-tx)}
.g-entry .datebar{position:relative;z-index:1;margin-bottom:14px}
.g-entry .datepill,.g-entry .datepick{border:1px solid var(--g-line);background:transparent;color:var(--g-tx2);font:500 12px/1 'Inter',system-ui,sans-serif}
.g-entry .datepill.on{border-color:var(--g-tx);background:var(--g-surface);color:var(--g-tx)}
.g-entry .datecap{font:300 12px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .qa{position:relative;z-index:1;display:flex;min-height:calc(100dvh - 126px);flex-direction:column;animation:si .3s var(--ease)}
.g-entry .qt{font:500 21px/1.2 'Inter',system-ui,sans-serif;letter-spacing:-.4px;margin-bottom:10px;color:var(--g-tx)}
.g-entry .qs{font:300 13px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-bottom:22px}
.g-entry .step-btns{margin-top:auto;padding-top:18px}
.g-entry .btn-p{border-radius:999px;background:var(--g-tx);font-family:'Inter',system-ui,sans-serif;color:var(--g-bg)}
.g-entry .btn-skip{border:none;background:transparent;color:var(--g-tx3);font:400 12px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.scr.g-review{padding:calc(26px + env(safe-area-inset-top)) 22px calc(72px + env(safe-area-inset-bottom,0px));font-family:'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-review::after{z-index:0}
.g-review .et,.g-review .pb,.g-review .qa{position:relative;z-index:1}
.g-review .et{gap:12px;margin-bottom:16px}
.g-review .bi{width:30px;height:30px;border:none;border-radius:50%;background:var(--g-surface);color:var(--g-tx2)}
.g-review .btn-ghost{font-family:'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-review .es{font:500 13px/1 'Inter',system-ui,sans-serif;color:var(--g-tx2);letter-spacing:0;text-transform:none}
.g-review .pb{height:3px;background:var(--g-line);margin-bottom:22px}
.g-review .pf{background:var(--g-tx)}
.g-review .qa{display:flex;min-height:calc(100dvh - 116px);flex-direction:column;animation:si .3s var(--ease)}
.g-review .qt{font:500 22px/1.2 'Inter',system-ui,sans-serif;letter-spacing:-.4px;margin-bottom:5px;color:var(--g-tx)}
.g-review .qs{font:300 13px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-bottom:20px}
.g-review .rc{margin:0 0 18px;background:transparent;border-radius:0;box-shadow:none;padding:0}
.g-review .rr{padding:14px 0;border-bottom:1px solid var(--g-line);gap:12px}
.g-review .rl{display:block;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--g-tx3);margin-bottom:5px}
.g-review .rv{font:400 14px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-review .rv-med{display:flex;flex-direction:column;align-items:stretch;gap:3px;padding:4px 0}
.g-review .rv-med b{font-weight:500}
.g-review .rv-med-detail{color:var(--g-tx3);font-size:12px;white-space:normal;overflow-wrap:anywhere}
.g-review .rv-med-off .rv-med-detail{color:var(--g-sleep-healthy)}
.g-review .rv-med-missed .rv-med-detail{color:var(--g-warm-err)}
.g-review .rr-edit{color:var(--g-tx3);font:500 12px/1 'Inter',system-ui,sans-serif;padding:2px 4px}
.g-review .btn-p{width:100%;margin-top:auto;border-radius:999px;background:var(--g-tx);font-family:'Inter',system-ui,sans-serif;color:var(--g-bg)}
.rv-mood{display:inline-flex;align-items:center;color:var(--g-tx)}
.rv-muted{color:var(--g-tx3);font-size:13px}
.rv-dot{position:relative;display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:baseline;overflow:hidden;flex-shrink:0}
.rv-dot::before{content:"";position:absolute;inset:-8px;border-radius:50%}
.es{font-size:12px;color:var(--t3);font-weight:500;letter-spacing:.04em}
.pb{width:100%;height:3px;background:var(--bd);border-radius:2px;margin-bottom:18px;overflow:hidden}
.datebar{display:flex;align-items:center;gap:8px;margin:0 0 14px;flex-wrap:wrap}
.datepill{padding:8px 12px;border-radius:999px;border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer}
.datepill.on{border-color:var(--tx);background:var(--warm);color:var(--tx)}
.datepick{padding:8px 10px;border-radius:999px;border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer}
.datecap{font-size:12px;color:var(--t3);font-weight:300;margin-left:auto}
.wgt{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.wgi{flex:1;padding:14px 14px;border-radius:var(--r);border:1.5px solid var(--bd);background:transparent;color:var(--tx);font:400 16px 'DM Sans',sans-serif;outline:none}
.wgi:focus{border-color:var(--tx)}
.wgu{font-size:13px;color:var(--t3);font-weight:500;padding-right:6px}
.pf{height:100%;background:var(--tx);border-radius:2px;transition:width .4s var(--ease)}
.qa{animation:si .3s var(--ease)}
@keyframes si{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}
.qt{font-family:'Inter',system-ui,sans-serif;font-size:24px;font-weight:400;letter-spacing:-.2px;margin-bottom:6px}
.qs{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:28px}.en{margin-top:8px}
.note-starter-wrap{opacity:1;transition:opacity .15s var(--ease);margin-bottom:10px}
.note-starter-hidden{opacity:0;pointer-events:none}
.starter-label{font-size:11px;color:var(--t3);font-weight:300;font-style:italic;margin-bottom:8px}
.starters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.starter{flex:1 1 0;min-width:0;border:1.5px solid var(--bd);border-radius:4px;background:var(--warm);color:var(--t2);font:400 13px 'DM Sans',sans-serif;text-align:left;line-height:1.3;padding:10px 12px;cursor:pointer;transition:background .15s,border-color .15s,color .15s,opacity .15s,transform .15s}
.starter:hover{border-color:#C9C2B5;background:#ECE7DD;color:var(--tx)}
.starter:active{transform:scale(.98)}
.starter-dim{opacity:.48}

.ol{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.oc{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;cursor:pointer;transition:all .15s;text-align:left;font-family:'DM Sans',sans-serif}
.oc:hover{border-color:var(--t3)}
.ocl{display:flex;align-items:center;gap:10px}.oce{font-size:13px;width:32px;text-align:center;flex-shrink:0;color:var(--t3);font-weight:500;letter-spacing:-.5px}
.ocn{font-size:14px;font-weight:400}.ocd{font-size:11px;color:var(--t3);font-weight:300;margin-top:1px}
.or{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--bd);display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;flex-shrink:0;transition:all .15s}

.g-mood-picker{padding-top:20px}
.g-mood-dots{display:flex;align-items:center;justify-content:space-between;margin:8px 0 6px}
.g-mood-dot{width:30px;height:30px;border:none;border-radius:50%;position:relative;background:transparent;cursor:pointer;transition:box-shadow .15s,transform .15s}
.g-mood-dot:active{transform:scale(.94)}
.g-mood-dot::before{content:"";position:absolute;inset:0;border-radius:50%}
.g-mood-dot.sel{box-shadow:0 0 0 2px var(--g-bg),0 0 0 4px var(--g-tx)}
.g-mood-sev-low::before{background:radial-gradient(circle,rgba(91,94,134,.95) 0%,rgba(91,94,134,.6) 45%,transparent 74%)}
.g-mood-mod-low::before{background:radial-gradient(circle,rgba(124,126,174,.92) 0%,rgba(124,126,174,.58) 45%,transparent 74%)}
.g-mood-mild-low::before{background:radial-gradient(circle,rgba(179,168,204,.9) 0%,rgba(179,168,204,.55) 45%,transparent 74%)}
.g-mood-steady::before{background:radial-gradient(circle,rgba(207,201,174,.82) 0%,rgba(207,201,174,.46) 45%,transparent 74%)}
.g-mood-mild-high::before{background:radial-gradient(circle,rgba(233,199,126,.9) 0%,rgba(233,199,126,.55) 45%,transparent 74%)}
.g-mood-mod-high::before{background:radial-gradient(circle,rgba(238,154,82,.93) 0%,rgba(238,154,82,.58) 45%,transparent 74%)}
.g-mood-sev-high::before{background:radial-gradient(circle,rgba(233,106,51,.95) 0%,rgba(233,106,51,.62) 45%,transparent 74%)}
.g-mood-ends{display:flex;justify-content:space-between;color:var(--g-tx3);font:400 10px/1 'Inter',system-ui,sans-serif}
.g-mood-read{min-height:126px;margin-top:20px;text-align:center}
.g-mood-read-line{display:flex;flex-direction:column;align-items:center;margin-bottom:14px}
.g-mood-read-main{display:flex;align-items:center;justify-content:center;gap:8px}
.g-mood-read-line span{font:500 24px/1.15 'Inter',system-ui,sans-serif;letter-spacing:-.4px;color:var(--g-tx)}
.g-mood-read-line small{font:400 14px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-mood-read-line em{max-width:240px;margin-top:4px;font:300 12px/1.35 'Inter',system-ui,sans-serif;color:var(--g-tx3);font-style:normal}
.g-mood-empty{color:var(--g-tx3);font:300 13px/1.4 'Inter',system-ui,sans-serif}

.np{display:flex;align-items:center;justify-content:center;gap:28px;margin:20px 0 32px}
.nv{text-align:center}.nb{font-family:'Inter',system-ui,sans-serif;font-size:48px;font-weight:400}.nu{font-size:16px;color:var(--t3);margin-left:4px}

/* ── Sleep chips ── */
.slp-section{margin-bottom:20px}
.slp-label{font-size:13px;color:var(--t2);font-weight:400;margin-bottom:10px;display:flex;justify-content:space-between;align-items:baseline}
.slp-val{font-family:'Inter',system-ui,sans-serif;font-size:15px;font-weight:400;color:var(--tx)}
.slp-val-calc{color:var(--t3);font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:300}
.slp-chips{display:flex;flex-wrap:wrap;gap:6px 7px}
.slp-chip{padding:10px 12px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:400 13px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;text-align:center;transition:all .15s;white-space:nowrap}
.slp-chip:active{transform:scale(.95)}
.slp-chip-on{border-color:var(--tx);background:var(--warm);color:var(--tx);font-weight:500}
.slp-chip-arr{padding:10px 12px;color:var(--t3);font-size:15px}
.slp-chip-arr:hover{color:var(--t2);border-color:var(--t3)}
.slp-chip-arr:active{transform:scale(.92);background:var(--warm)}
.slp-chip-offsel{border-color:var(--tx);background:var(--warm);color:var(--tx);font-weight:500;font-size:11px}
.slp-div{border:none;border-top:1px dashed var(--bd);margin:20px 0}
.slp-hrs-sec{margin-bottom:20px}
.slp-hrs-row{display:flex;align-items:center;justify-content:center;gap:20px;margin-bottom:4px}
.slp-hrs-btn{width:44px;height:44px;border-radius:50%;border:1.5px solid var(--bd);background:transparent;font-size:20px;color:var(--tx);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
.slp-hrs-btn:active{transform:scale(.92)}.slp-hrs-btn:disabled{opacity:.3;pointer-events:none}
.slp-hrs-val{text-align:center;min-width:80px}
.slp-hrs-num{font-family:'Inter',system-ui,sans-serif;font-size:40px;font-weight:400}
.slp-hrs-unit{font-size:14px;color:var(--t3);margin-left:3px}
.slp-hrs-calc{font-size:11px;color:var(--t3);font-weight:300;text-align:center;margin-bottom:2px;min-height:14px}
.slp-hrs-num-calc{opacity:.7}
.slp-edge-picker{display:flex;align-items:center;gap:8px;margin-top:8px;animation:si .2s var(--ease)}
.slp-edge-ti{flex:1;padding:8px 12px;border-radius:8px;border:1.5px solid var(--tx);font:400 14px 'DM Sans',sans-serif;color:var(--tx);background:transparent;outline:none}
.slp-edge-ok{padding:8px 14px;border-radius:8px;border:none;background:var(--tx);color:#fff;font:500 12px 'DM Sans',sans-serif;cursor:pointer}
.slp-edge-ok:active{transform:scale(.95)}
.slp-edge-x{padding:8px 10px;border:none;background:none;color:var(--t3);font:400 13px 'DM Sans',sans-serif;cursor:pointer}

.g-entry .slp-section{margin-bottom:16px}
.g-entry .slp-label{margin-bottom:8px;font-family:'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .slp-label span:first-child{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.g-entry .slp-val{font:500 14px/1 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-entry .slp-val-calc{font:400 14px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .slp-chips{display:grid;grid-template-columns:24px repeat(4,minmax(0,1fr)) 24px;grid-auto-rows:auto;gap:6px;align-items:stretch}
.g-entry .slp-chip{min-width:0;padding:7px 0;border:1px solid var(--g-line);border-radius:8px;background:transparent;color:var(--g-tx2);font:400 11px/1 'Inter',system-ui,sans-serif}
.g-entry .slp-chip-on{border-color:var(--g-tx);background:var(--g-tx);color:var(--g-bg)}
.g-entry .slp-chip-arr{grid-row:1/3;padding:0;color:var(--g-tx2);font-size:11px}
.g-entry .slp-chip-arr:last-child{grid-column:6}
.g-entry .slp-chip-offsel{display:none}
.g-entry .slp-div{border-top:1px solid var(--g-line);margin:16px 0}
.g-entry .slp-hrs-sec{text-align:center}
.g-entry .slp-hrs-row{gap:22px;margin-top:10px}
.g-entry .slp-hrs-btn{width:40px;height:40px;border:1px solid var(--g-line);color:var(--g-tx2);font-family:'Inter',system-ui,sans-serif}
.g-entry .slp-hrs-num{font-family:'Inter',system-ui,sans-serif;font-size:34px;font-weight:400;letter-spacing:-1px}
.g-entry .slp-hrs-unit{font-size:13px;color:var(--g-tx3)}
.g-entry .slp-edge-ti{border-color:var(--g-tx);font-family:'Inter',system-ui,sans-serif}
.g-entry .slp-edge-ok{border-radius:999px;background:var(--g-tx);font-family:'Inter',system-ui,sans-serif}
.g-entry .slp-add{margin:18px 0 2px;display:flex;justify-content:center}
.g-entry .slp-add button{border:1px dashed var(--g-line);background:transparent;color:var(--g-tx2);font:500 12.5px/1 'Inter',system-ui,sans-serif;padding:11px 16px;border-radius:999px;display:inline-flex;align-items:center;gap:7px}
.g-entry .slp-add .pl{font-size:14px;color:var(--g-tx3)}
.g-entry .slp-add-help,.g-entry .slp-total-cue{text-align:center;font:400 11px/1.4 'Inter',system-ui,sans-serif;color:var(--g-tx4);margin:7px 0 0}
.g-entry .slp-ep-head{display:flex;align-items:center;justify-content:space-between;margin:2px 0 12px}
.g-entry .slp-ep-title{font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--g-tx3)}
.g-entry .slp-ep-x{border:none;background:none;color:var(--g-tx3);font:400 14px/1 'Inter',system-ui,sans-serif;display:inline-flex;align-items:center;gap:5px}
.g-entry .slp-ep-x .lbl{font-size:11px}
.g-entry .slp-ep-sep{border:0;border-top:1px solid var(--g-line);margin:22px 0 18px}
.g-entry .slp-ep-sum{display:flex;align-items:baseline;gap:8px;width:100%;border:0;background:transparent;text-align:left;color:var(--g-tx);padding:0}
.g-entry .slp-ep-sum .h{font:400 22px/1 'Inter',system-ui,sans-serif}
.g-entry .slp-ep-sum .r{font:400 12px/1.25 'Inter',system-ui,sans-serif;color:var(--g-tx3);flex:1}
.g-entry .slp-ep-sum .chev{font:400 11px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.slp-read-cue,.rv-sleep-cue{display:block;margin-top:7px;font:400 11.5px/1.35 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.slp-read-cue::before,.rv-sleep-cue::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--g-sleep-healthy);margin-right:6px;vertical-align:middle}

.ai-combo{display:flex;flex-direction:column;gap:36px;margin-bottom:24px}
.ai-row{}
.ai-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px}
.ai-label{font:500 15px 'DM Sans',sans-serif;color:var(--tx)}
.ai-val{font:400 13px 'DM Sans',sans-serif;color:var(--t3)}
.ai-track-wrap{position:relative;padding:0 14px;height:44px;display:flex;align-items:center}
.ai-track-bg{position:absolute;left:14px;right:14px;height:3px;background:var(--bd);border-radius:2px}
.ai-track-fill{position:absolute;left:14px;height:3px;background:var(--tx);border-radius:2px;transition:width .35s var(--ease);max-width:calc(100% - 28px)}
.ai-dots{display:flex;justify-content:space-between;width:100%;position:relative;z-index:1}
.ai-dot-btn{width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;-webkit-tap-highlight-color:transparent;padding:0}
.ai-dot-btn:active{transform:scale(.92)}
.ai-ring{width:18px;height:18px;border-radius:50%;border:2px solid var(--bd);background:var(--bg);transition:all .3s var(--ease)}
.ai-dot-btn.ai-active .ai-ring{width:22px;height:22px;border-color:var(--tx);background:var(--tx);box-shadow:0 0 0 4px rgba(44,40,37,.08)}
.ai-dot-btn.ai-past .ai-ring{width:10px;height:10px;border-color:var(--tx);background:var(--tx)}
.ai-labels{display:flex;justify-content:space-between;padding:0 6px;margin-top:4px}
.ai-lbl{font:400 11px 'DM Sans',sans-serif;color:var(--t3);width:44px;text-align:center;transition:color .25s}
.ai-lbl-on{color:var(--tx);font-weight:500}
.g-entry .ai-combo{gap:28px}
.g-entry .ai-head{margin-bottom:14px}
.g-entry .ai-label{font:500 14px/1 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-entry .ai-val{font:400 13px/1 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-entry .ai-track-wrap{height:28px;padding:0 7px}
.g-entry .ai-track-bg{left:7px;right:7px;height:3px;background:var(--g-line)}
.g-entry .ai-track-fill{left:7px;height:3px;background:var(--g-tx3);max-width:calc(100% - 14px)}
.g-entry .ai-dot-btn{width:28px;height:28px}
.g-entry .ai-ring{width:14px;height:14px;border-color:var(--g-line);background:var(--g-bg)}
.g-entry .ai-dot-btn.ai-active .ai-ring{width:14px;height:14px;border-color:var(--g-tx);background:var(--g-tx2);box-shadow:none}
.g-entry .ai-dot-btn.ai-past .ai-ring{width:14px;height:14px;border-color:transparent;background:var(--g-tx2)}
.g-entry .ai-labels{padding:0;margin-top:9px}
.g-entry .ai-lbl{width:auto;font:400 10px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .ai-lbl-on{color:var(--g-tx2);font-weight:500}
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:0}
.sc{padding:20px 8px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;cursor:pointer;text-align:center;transition:all .15s;font-family:'DM Sans',sans-serif}
.sc:hover{border-color:var(--t3)}.ss{border-color:var(--tx);background:var(--warm)}
.sn{display:block;font-family:'Inter',system-ui,sans-serif;font-size:24px;font-weight:300;margin-bottom:4px}.sl{font-size:11px;color:var(--t2)}

.ml{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.mr{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);transition:all .15s}
.mo{border-color:var(--tx);background:var(--warm)}
.mi{flex:1}.mn{font-size:14px}.md-sub{font-size:11px;color:var(--t3);margin-top:1px}
.mc{display:flex;align-items:center;gap:10px}.mv{font-size:15px;font-weight:500;min-width:20px;text-align:center}

.g-entry .ml{gap:0;margin-bottom:12px}
.g-entry .mr{padding:11px 0;border:0;border-bottom:1px solid var(--g-line);border-radius:0;background:transparent}
.g-entry .mo{border-color:var(--g-line);background:transparent}
.g-entry .mr:not(.mo):not(.med-log-row) .mn,.g-entry .mr:not(.mo) .mv{color:var(--g-tx3)}
.g-entry .mi{min-width:0}
.g-entry .mn{font:500 13px/1.25 'Inter',system-ui,sans-serif;color:var(--g-tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.g-entry .md-sub{font:400 10px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-top:1px}
.g-entry .mc{gap:12px;flex-shrink:0}
.g-entry .bs{width:30px;height:30px;border-radius:50%;border:1px solid var(--g-line);color:var(--g-tx2)}
.g-entry .mv{font:500 15px/1 'Inter',system-ui,sans-serif;min-width:16px}
.g-entry .med-log-row{display:block;padding:13px 0}
.g-entry .med-log-row .mr-main{display:flex;align-items:center;gap:13px}
.g-entry .med-log-row .mi{flex:1}
.g-entry .med-log-section+.med-log-section{margin-top:16px}
.g-entry .sect-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:2px 0 4px}
.g-entry .sect-k{font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.11em;text-transform:uppercase;color:var(--g-tx3)}
.g-entry .sect-hint{font:300 10.5px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx4)}
.g-entry .md-sub{display:flex;align-items:center;gap:6px;min-width:0}
.g-entry .when-tag,.g-day-med-row .when-tag{display:inline-flex;align-items:center;gap:5px;color:var(--g-tx4);white-space:nowrap}
.g-entry .when-tag::before,.g-day-med-row .when-tag::before{content:"";width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.7}
.g-entry .segA{display:inline-flex;flex-shrink:0;border:1px solid var(--g-line);border-radius:999px;overflow:hidden;background:var(--g-bg)}
.g-entry .segA button{appearance:none;border:none;background:transparent;width:38px;height:30px;display:flex;align-items:center;justify-content:center;color:var(--g-tx4);border-right:1px solid var(--g-line);cursor:pointer}
.g-entry .segA button:last-child{border-right:none}
.g-entry .segA .g-line{display:inline-block;width:13px;height:2px;border-radius:2px;background:currentColor}
.g-entry .segA .g-half,.g-entry .segA .g-check{font-size:14px;line-height:1}
.g-entry .segA button.sel-took{background:var(--g-tx);color:var(--g-bg)}
.g-entry .segA button.sel-off{background:var(--g-tx);color:var(--g-bg)}
.g-entry .segA button.sel-miss{background:var(--g-tx);color:var(--g-bg)}
.g-entry .offnote{margin:9px 0 2px}
.g-entry .offnote .nhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:7px}
.g-entry .offnote .ntitle{font:400 11px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-entry .offnote .noptional{font:400 9.5px/1 'Inter',system-ui,sans-serif;color:var(--g-tx4);letter-spacing:.05em}
.g-entry .offnote input{width:100%;border:1px solid var(--g-line);border-radius:999px;background:var(--g-card);color:var(--g-tx);font:400 12.5px/1.4 'Inter',system-ui,sans-serif;padding:9px 14px}
.g-entry .offnote input::placeholder{color:var(--g-tx4);font-weight:300}
.g-entry .prn-ctl{display:flex;align-items:center;gap:9px;flex-shrink:0}
.g-entry .prn-tog{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--g-line);border-radius:999px;background:transparent;color:var(--g-tx2);font:500 12px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-entry .prn-tog .g{font-size:12px;color:var(--g-tx4)}
.g-entry .prn-tog.on{background:var(--g-tx);border-color:var(--g-tx);color:var(--g-bg)}
.g-entry .prn-tog.on .g{color:var(--g-bg)}
.g-entry .prn-ct{display:inline-flex;align-items:center;height:32px;border:1px solid var(--g-line);border-radius:999px;overflow:hidden;background:var(--g-bg)}
.g-entry .prn-ct button{width:30px;height:30px;border:0;background:transparent;color:var(--g-tx2);font:500 15px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-entry .prn-ct .n{min-width:26px;text-align:center;font:500 12px/1 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-entry .med-log-row:has(+ .med-state-legend){border-bottom:0}
.g-entry .med-state-legend{display:flex;align-items:center;flex-wrap:wrap;gap:7px 16px;margin-top:18px;padding-top:13px;border-top:1px solid var(--g-line)}
.g-entry .med-state-legend span{display:inline-flex;align-items:center;gap:7px;font:400 10.5px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .med-state-legend .gi{width:17px;height:17px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;color:var(--g-tx4);flex:0 0 17px}
.g-entry .med-state-legend .g-line{display:inline-block;width:11px;height:2px;border-radius:2px;background:currentColor}
.g-entry .meds-dayline{display:inline-flex;align-items:center;gap:7px;margin:0 0 14px;font:500 12px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .meds-dayline span{width:5px;height:5px;border-radius:50%;background:var(--g-tx4)}
.g-entry .meds-also-row{margin-top:18px;width:100%;border:1px solid var(--g-line);border-radius:12px;background:var(--g-card);padding:13px 15px;display:flex;align-items:center;gap:11px;text-align:left;color:var(--g-tx);cursor:pointer}
.g-entry .meds-also-row .chev{color:var(--g-tx4);font-size:13px;transition:transform .15s;flex:0 0 auto}
.g-entry .meds-also-row.open .chev{transform:rotate(90deg)}
.g-entry .meds-also-row .also-tx{display:flex;flex-direction:column;gap:3px;min-width:0}
.g-entry .meds-also-row .a1{font:500 13px/1.25 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-entry .meds-also-row .a2{font:400 11.5px/1.35 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .meds-today-drawer{position:relative;margin-top:12px;border:1px solid var(--g-line);border-radius:12px;background:var(--g-card);padding:14px 15px 14px}
.g-entry .meds-today-drawer::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:3px;border-radius:3px;background:var(--g-sleep-healthy);opacity:.5}
.g-entry .meds-today-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.g-entry .meds-today-head span{font:600 13px/1 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-entry .meds-today-head small{font:400 11px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .meds-today-note{font:400 11.5px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin:8px 0 4px}
.g-review .rv-meds-days{display:flex;flex-direction:column;gap:12px}
.g-review .rv-meds-day-k{display:block;margin-bottom:5px;font:600 10.5px/1 'Inter',system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--g-tx3)}

.ni{width:100%;min-height:120px;border-radius:var(--r);border:1.5px solid var(--bd);padding:16px;font:16px/1.55 'DM Sans',sans-serif;resize:vertical;background:transparent;color:var(--tx);caret-color:#8A847B;transition:border .15s;margin-bottom:12px;touch-action:manipulation}
.ni:focus{outline:none;border-color:var(--tx)}.ni::placeholder{color:var(--t3)}

.g-entry .wgt{justify-content:center;align-items:baseline;margin:30px 0 18px}
.g-entry .wgi{max-width:180px;padding:10px 6px;border:0;border-bottom:1.5px solid var(--g-tx4);border-radius:0;background:transparent;font:400 40px/1 'Inter',system-ui,sans-serif;letter-spacing:-1px;text-align:center}
.g-entry .wgu{font:400 16px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-entry .starter-label{font:400 11px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3);font-style:normal;margin-bottom:8px}
.g-entry .starters{gap:7px;margin-bottom:14px}
.g-entry .starter{flex:0 0 auto;border:1px solid var(--g-line);border-radius:999px;background:transparent;color:var(--g-tx2);font:400 12px/1 'Inter',system-ui,sans-serif;padding:7px 12px}
.g-entry .ni{min-height:300px;border:1px solid var(--g-line);border-radius:0;background:#FCFBF8;color:var(--g-tx2);font:300 14px/1.85 'Inter',system-ui,sans-serif;resize:none}
.g-entry .ni::placeholder{color:var(--g-tx4)}

.rc{background:var(--card);border-radius:var(--r);padding:4px 16px;box-shadow:var(--sh);margin-bottom:16px}
.rr{display:flex;justify-content:space-between;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--bd);gap:8px}
.rr:last-child{border-bottom:none}
.rr-left{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.rl{font-size:11px;color:var(--t3)}.rv{font-size:13px;line-height:1.4;word-break:break-word}
.rr-edit{border:none;background:none;color:#6478A0;font:500 12px 'DM Sans',sans-serif;cursor:pointer;padding:4px 0;flex-shrink:0}

.srm-pick-sub{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:16px;line-height:1.5}
.srm-pick-grid{display:flex;flex-direction:column;gap:6px}
.srm-pick-item{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;cursor:pointer;transition:all .15s;text-align:left;font-family:'DM Sans',sans-serif}
.srm-pick-item:hover{border-color:var(--t3);background:rgba(0,0,0,.01)}
.srm-pick-item:active{transform:scale(.99)}
.srm-pick-done{border-color:var(--gn);background:var(--gbg)}
.srm-pick-icon{font-size:16px;color:var(--t3);width:24px;text-align:center;flex-shrink:0}
.srm-pick-label{font-size:14px;font-weight:400;flex:1}
.srm-pick-check{color:var(--gn);font-size:14px;font-weight:500}
.g-srm-picker,.g-srm-single,.g-confirm{padding:calc(26px + env(safe-area-inset-top)) 22px 28px;font-family:'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-srm-picker::after,.g-srm-single::after,.g-confirm::after{z-index:0}
.g-srm-picker > *,.g-srm-single > *,.g-confirm > *{position:relative;z-index:1}
.g-srm-picker .hh{padding:0 0 14px}
.g-srm-picker .ht{font:500 22px/1.15 'Inter',system-ui,sans-serif;letter-spacing:-.5px;color:var(--g-tx)}
.g-srm-picker .bi,.g-srm-single .bi{width:30px;height:30px;border:none;border-radius:50%;background:var(--g-surface);color:var(--g-tx2);font-family:'Inter',system-ui,sans-serif}
.g-srm-picker .datebar{margin:0 0 12px;gap:6px}
.g-srm-picker .datepill,.g-srm-picker .datepick{padding:7px 12px;border:1px solid var(--g-line);background:transparent;color:var(--g-tx3);font:500 12px/1 'Inter',system-ui,sans-serif}
.g-srm-picker .datepill.on{border-color:var(--g-tx);background:var(--g-surface);color:var(--g-tx)}
.g-srm-picker .datecap{font:300 11px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-srm-picker .srm-pick-sub{font:300 13px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-bottom:14px}
.g-srm-picker .srm-pick-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.g-srm-picker .srm-pick-item{position:relative;display:flex;min-height:78px;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:7px;padding:13px;border:1px solid var(--g-line);border-radius:14px;background:var(--g-card);font-family:'Inter',system-ui,sans-serif;color:var(--g-tx);box-shadow:none}
.g-srm-picker .srm-pick-item:hover{border-color:var(--g-line);background:var(--g-card)}
.g-srm-picker .srm-pick-item:active{transform:scale(.985)}
.g-srm-picker .srm-pick-done{border-color:var(--g-line);background:var(--g-card);opacity:.55}
.g-srm-picker .srm-pick-icon{width:auto;font-size:17px;line-height:1;color:var(--g-tx2)}
.g-srm-picker .srm-pick-label{font:500 13px/1.25 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-srm-picker .srm-pick-check{position:absolute;top:11px;right:12px;color:#8FB2A4;font:600 12px/1 'Inter',system-ui,sans-serif}
.g-srm-picker .btn-add{width:100%;margin-top:10px!important;padding:11px;border-radius:12px;border:1px dashed var(--g-tx4);background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif}
.g-srm-picker .add-form{margin-top:10px!important;padding:12px;border:1px solid var(--g-line);border-radius:12px;background:rgba(251,250,246,.58)}
.g-srm-picker .add-input{border-bottom:1px solid var(--g-line);font:400 14px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-srm-picker .add-input::placeholder{color:var(--g-tx4)}
.g-srm-picker .btn-sm-p{border-radius:999px;background:var(--g-tx);font-family:'Inter',system-ui,sans-serif;color:var(--g-bg)}
.g-srm-picker .btn-ghost,.g-srm-single .btn-ghost{font-family:'Inter',system-ui,sans-serif;color:var(--g-tx3)}

.srm-em{font-size:24px;margin-bottom:12px;color:var(--t3)}
.srm-tr{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.srm-lb{font-size:12px;color:var(--t3);font-weight:500;min-width:40px}
.srm-ti{flex:1;padding:10px 12px;border-radius:var(--rs);border:1.5px solid var(--bd);font:400 15px 'DM Sans',sans-serif;color:var(--tx);background:transparent;outline:none;min-width:100px}
.srm-ti:focus{border-color:var(--tx)}
.srm-now{padding:10px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;transition:all .15s;white-space:nowrap}
.srm-now:hover{border-color:var(--t3)}.srm-now:active{background:var(--warm)}

.srm-skip{padding:7px 12px;border-radius:var(--rs);border:none;background:transparent;font:300 12px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer;transition:all .15s;text-align:left;margin-bottom:16px}
.srm-skip:hover{color:var(--t2)}.srm-skip-on{color:var(--tx);font-weight:400}
.srm-sec{margin-bottom:16px}
.srm-yn{display:flex;gap:6px;margin-top:8px}
.srm-yb{flex:1;padding:12px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:400 14px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;text-align:center;transition:all .15s}
.srm-yb:hover{border-color:var(--t3)}.srm-yb-on{border-color:var(--tx);background:var(--warm);color:var(--tx);font-weight:500}
.srm-who-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
.srm-wb{padding:10px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:400 13px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;text-align:center;transition:all .15s}
.srm-wb:hover{border-color:var(--t3)}.srm-wb-on{border-color:var(--tx);background:var(--warm);color:var(--tx)}
.srm-who-text{width:100%;margin-top:8px;padding:8px 12px;border-radius:var(--rs);border:1.5px solid var(--bd);font:300 13px 'DM Sans',sans-serif;color:var(--tx);background:transparent;outline:none}
.srm-who-text:focus{border-color:var(--tx)}.srm-who-text::placeholder{color:var(--t3)}
.srm-eng{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.srm-eb{padding:12px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:400 13px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;text-align:left;transition:all .15s}
.srm-eb:hover{border-color:var(--t3)}.srm-eb-on{border-color:var(--tx);background:var(--warm);color:var(--tx)}
.g-srm-single{display:flex;min-height:100dvh;flex-direction:column}
.g-srm-single .et{gap:12px;margin-bottom:22px}
.g-srm-single .es{font:500 13px/1 'Inter',system-ui,sans-serif;color:var(--g-tx2);letter-spacing:0;text-transform:none}
.g-srm-single .qa{display:flex;flex:1;min-height:auto;flex-direction:column;padding:0;animation:si .3s var(--ease)}
.g-srm-single .srm-em{font-size:32px;line-height:1;color:var(--g-tx2);margin-bottom:8px}
.g-srm-single .qt{font:500 22px/1.2 'Inter',system-ui,sans-serif;letter-spacing:-.4px;color:var(--g-tx);margin-bottom:14px}
.g-srm-single .srm-tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;margin-bottom:14px;align-items:center}
.g-srm-single .srm-lb{display:block;min-width:0;margin-bottom:8px;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--g-tx3)}
.g-srm-single .srm-tr .srm-lb{grid-column:1/-1;margin-bottom:0}
.g-srm-single .srm-ti{width:100%;min-width:0;max-width:100%;box-sizing:border-box;-webkit-appearance:none;appearance:none;min-height:50px;padding:13px 14px;border:1px solid var(--g-line);border-radius:12px;background:#fff;color:var(--g-tx);font:500 18px/1.2 'Inter',system-ui,sans-serif}
.g-srm-single .srm-ti:focus{border-color:var(--g-tx);box-shadow:none}
.g-srm-single .srm-now{padding:12px 16px;border:1px solid var(--g-tx3);border-radius:12px;background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif}
.g-srm-single .srm-now:active{background:var(--g-surface)}
.g-srm-single .srm-skip{align-self:flex-start;margin:0 0 22px;padding:11px 16px;border:1px solid var(--g-line);border-radius:999px;background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif}
.g-srm-single .srm-skip-on{border-color:var(--g-tx);background:var(--g-surface);color:var(--g-tx)}
.g-srm-single .srm-sec{margin-bottom:22px}
.g-srm-single .srm-yn{gap:8px;margin-top:0}
.g-srm-single .srm-yb,.g-srm-single .srm-wb,.g-srm-single .srm-eb{border:1px solid var(--g-line);border-radius:12px;background:transparent;color:var(--g-tx2);font-family:'Inter',system-ui,sans-serif;font-weight:500}
.g-srm-single .srm-yb{padding:12px;font-size:14px}
.g-srm-single .srm-who-grid{gap:8px;margin-top:0}
.g-srm-single .srm-wb{padding:11px;font-size:13px}
.g-srm-single .srm-eng{gap:8px;margin-top:0}
.g-srm-single .srm-eb{padding:12px 14px;font-size:13px}
.g-srm-single .srm-yb-on,.g-srm-single .srm-wb-on,.g-srm-single .srm-eb-on{border-color:var(--g-tx);background:var(--g-surface);color:var(--g-tx)}
.g-srm-single .srm-who-text{border:1px solid var(--g-line);border-radius:12px;background:#fff;color:var(--g-tx);font:400 13px/1.2 'Inter',system-ui,sans-serif}
.g-srm-single .srm-who-text::placeholder{color:var(--g-tx4)}
.g-srm-single .btn-p{width:100%;margin-top:auto;border-radius:999px;background:var(--g-tx);font-family:'Inter',system-ui,sans-serif;color:var(--g-bg)}

.add-form{padding:12px;border:1.5px solid var(--bd);border-radius:var(--rs)}
.add-input{width:100%;border:none;border-bottom:1px solid var(--bd);background:transparent;font:400 14px 'DM Sans',sans-serif;padding:8px 0;outline:none;margin-bottom:8px;color:var(--tx)}
.add-input::placeholder{color:var(--t3)}.add-sm{font-size:12px}
.add-btns{display:flex;gap:8px;justify-content:flex-end}

.cfs{display:flex;align-items:center;justify-content:center}
.cfi{text-align:center;animation:pi .5s var(--ease)}
@keyframes pi{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}
.cfc{width:88px;height:88px;border-radius:50%;background:var(--gbg);display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
.cft{font-family:'Source Serif 4',serif;font-size:26px;font-weight:400;margin-bottom:8px}
.cfp{color:var(--t2);font-size:15px;font-weight:300}
.g-confirm{display:flex;align-items:center;justify-content:center;min-height:100dvh}
.g-confirm .cfi{padding:0 40px;text-align:center;animation:gConfirmIn .55s var(--ease)}
.g-confirm .cfc{width:80px;height:80px;background:rgba(143,178,164,.16);margin:0 auto;animation:gCheckPop .4s cubic-bezier(.2,.85,.25,1) both}
.g-confirm .cft{font:500 20px/1.2 'Inter',system-ui,sans-serif;letter-spacing:-.3px;color:var(--g-tx);margin:22px 0 0}
.g-confirm .cfp{font:300 14px/1.5 'Inter',system-ui,sans-serif;color:var(--g-tx2);margin-top:8px}

/* ── R8 settings ── */
/* Insights/Settings now open as bottom sheets (slide-up) — gModalIn stays for .g-day only */
@keyframes gModalIn{from{opacity:0;transform:scale(.97) translateY(8px)}to{opacity:1;transform:none}}
/* ── Bottom sheet (Insights & Settings) ── */
.g-sheet-scrim{position:fixed;inset:0;z-index:80;background:rgba(28,28,26,.32);opacity:0;transition:opacity .34s ease}
.g-sheet-scrim.open{opacity:1}
.g-sheet{position:fixed;left:0;right:0;bottom:0;z-index:81;max-width:420px;margin:0 auto;height:92dvh;display:flex;flex-direction:column;padding:0;border-radius:22px 22px 0 0;box-shadow:0 -8px 44px rgba(28,28,26,.20);transform:translateY(100%);transition:transform .34s cubic-bezier(.2,.85,.25,1);overflow:hidden;will-change:transform}
.g-sheet.open{transform:translateY(0)}
.g-sheet.g-sheet-drag{transition:none}
.g-sheet.g-insights,.g-sheet.g-settings,.g-sheet.g-medications{padding:0;min-height:0}
.g-sheet-head{flex-shrink:0;padding:8px 20px 12px;cursor:grab;touch-action:none;user-select:none}
.g-sheet-head:active{cursor:grabbing}
.g-sheet-bar{display:block;width:38px;height:5px;border-radius:3px;background:var(--g-tx4);margin:0 auto 12px}
.g-sheet-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.g-sheet-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-width:none;padding:0 20px calc(28px + env(safe-area-inset-bottom))}
.g-sheet-body::-webkit-scrollbar{display:none}
@media(prefers-reduced-motion:reduce){.g-sheet{transition:none;transform:none}.g-sheet-scrim{transition:none}}
.g-settings::after{z-index:0}
.g-settings > *{position:relative;z-index:1}
.g-settings .hh{padding:0 0 14px;align-items:flex-start}
.g-settings .ht{font:500 24px/1.15 'Inter',system-ui,sans-serif;letter-spacing:-.6px;color:var(--g-tx)}
.g-settings .bi{width:40px;height:40px;border-radius:10px;border:1px solid var(--g-line);background:transparent;color:var(--g-tx2);font-family:'Inter',system-ui,sans-serif}
.g-settings .card{background:var(--g-card);border:1px solid var(--g-line);border-radius:16px;box-shadow:none;padding:14px;margin-bottom:12px}
.g-settings .ctit{display:block;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--g-tx3);margin-bottom:12px}
/* HH: secondary controls (Passcode + Advanced) read as one quieter group, not loud cards */
.g-settings .set-quiet,.g-settings .settings-advanced .card{background:transparent;border:none;border-radius:0;padding:13px 2px;margin-bottom:0;border-top:1px solid var(--g-line)}
.g-settings .set-quiet .ctit,.g-settings .settings-advanced .ctit{font:500 13px/1.2 'Inter',system-ui,sans-serif;letter-spacing:0;text-transform:none;color:var(--g-tx2);margin-bottom:9px}
.g-settings .set-h,.g-settings .hint{font:300 12px/1.4 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-settings .set-saved{font:400 12px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-top:8px}
.g-settings .actor-pills{display:flex;gap:8px}
.g-settings .actor-pill{flex:1;padding:10px;border-radius:10px;border:1px solid var(--g-line);background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-settings .actor-pill-on{border-color:var(--g-tx);background:var(--g-surface);color:var(--g-tx)}
.g-settings .actor-stats{margin-top:14px;padding-top:12px;border-top:1px solid var(--g-line)}
.g-settings .actor-stats-week{font:400 13px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-settings .actor-stats-faint{font:400 12px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-top:3px}
.g-settings .add-input{width:100%;border:1px solid var(--g-line);border-radius:10px;background:transparent;color:var(--g-tx);font:400 14px/1.2 'Inter',system-ui,sans-serif;padding:10px 12px;margin-bottom:8px}
.g-settings .add-input::placeholder{color:var(--g-tx4)}
.g-settings .btn-sm-p{border-radius:999px;border:none;background:var(--g-tx);color:var(--g-bg);font:500 13px/1 'Inter',system-ui,sans-serif;padding:10px 16px}
.g-settings .btn-add{width:100%;border:1px dashed var(--g-tx4);border-radius:12px;background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif;padding:11px}
.g-settings .btn-s{border:1px solid var(--g-tx4);border-radius:999px;background:transparent;color:var(--g-tx2);font-family:'Inter',system-ui,sans-serif}
.g-settings .btn-ghost{border:none;background:none;color:var(--g-tx3);font-family:'Inter',system-ui,sans-serif}
.g-settings .bs{width:30px;height:30px;border-radius:50%;border:1px solid var(--g-line);background:transparent;color:var(--g-tx2)}
.g-settings .mv{font:500 15px/1 'Inter',system-ui,sans-serif;color:var(--g-tx);min-width:16px;text-align:center}
.g-settings .set-mr{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--g-line)}
.g-settings .set-mr .mi{flex:1;min-width:0}
.g-settings .set-mr .mn{font:500 14px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-settings .set-mr .md-sub{font:400 12px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-top:1px}
.g-settings .set-mr-acts{display:flex;gap:4px;align-items:center;flex-shrink:0}
.g-settings .rr-edit{border:none;background:none;color:var(--g-tx2);font:500 12px/1 'Inter',system-ui,sans-serif;padding:4px 6px;cursor:pointer}
.g-settings .rem-smart-row{display:flex;align-items:center;gap:12px}
.g-settings .rem-smart-title{font:400 14px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-settings .rem-toggle{background:var(--g-surface)}
.g-settings .rem-toggle-on{background:var(--g-tx)}
.g-settings .rem-toggle-knob{background:#fff}
.g-settings .rem-status-btn{padding:6px 12px;border:1px solid var(--g-line);border-radius:999px;color:var(--g-tx2);font:500 12px/1 'Inter',system-ui,sans-serif}
.g-settings .lk{background:var(--g-surface);border:none;color:var(--g-tx);font-family:'Inter',system-ui,sans-serif}
.g-settings .lock-dot{border-color:var(--g-tx4)}
.g-settings .lock-dot.on{background:var(--g-tx);border-color:var(--g-tx)}
.g-settings .dev-notes-section{margin-top:18px}
.g-settings .btn-add-note{width:100%;border:1px solid var(--g-line);border-radius:12px;background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif;padding:12px}
.g-settings .btn-view-notes{display:block;margin:12px auto 0;border:none;background:none;color:var(--g-tx3);font:500 12px/1 'Inter',system-ui,sans-serif}
.g-settings .past-item{border-bottom:1px solid var(--g-line)}
.g-settings .past-ts{font:500 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--g-tx4)}
.g-settings .past-text{font:300 13px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx2);margin-top:2px}
.g-settings .btn-del{color:var(--g-tx4)}
.g-settings .ver-label{margin-top:10px;text-align:center;font:300 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.04em;color:var(--g-tx4)}
.g-settings .settings-advanced-toggle{display:flex;width:100%;align-items:center;justify-content:space-between;margin-top:0;padding:14px 2px;border:none;border-top:1px solid var(--g-line);border-radius:0;background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-settings .settings-advanced-toggle .adv-chev{color:var(--g-tx3);transition:transform .2s}
.g-settings .settings-advanced-toggle[aria-expanded="true"] .adv-chev{transform:rotate(180deg)}
.g-settings .settings-advanced{margin-top:10px}

/* ── MED-2 medication lifecycle sheet ── */
.g-medications::after{z-index:0}
.g-medications > *{position:relative;z-index:1}
.g-sheet.g-medications .ht{font:500 26px/1.1 'Inter',system-ui,sans-serif;letter-spacing:-.7px;color:var(--g-tx)}
.g-med-card{background:var(--g-card);border:1px solid var(--g-line);border-radius:16px;box-shadow:none;padding:16px;margin-bottom:12px}
.g-med-ctit{display:block;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--g-tx3);margin-bottom:12px}
.g-med-now-row,.g-med-disc-row{display:flex;width:100%;align-items:center;gap:12px;padding:16px 0;border:none;border-bottom:1px solid var(--g-line);background:none;text-align:left;cursor:pointer}
.g-med-now-row:first-of-type{padding-top:2px}
.g-med-now-row:last-of-type,.g-med-disc-row:last-child{border-bottom:none;padding-bottom:2px}
.g-med-sw{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.g-med-now-name{flex:1;min-width:0}
.g-med-now-name b{display:block;font:500 15px/1.2 'Inter',system-ui,sans-serif;letter-spacing:-.15px;color:var(--g-tx)}
.g-med-now-name small{display:block;margin-top:3px;font:300 11px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-med-dose{font:400 13px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx2);text-align:right;flex-shrink:0;white-space:nowrap}
.g-med-dose small{display:block;margin-top:3px;font:300 11px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-med-disc{margin-bottom:12px}
.g-med-disc-head{display:flex;width:100%;align-items:center;gap:8px;padding:13px 16px;background:transparent;border:1px solid var(--g-line);border-radius:14px;cursor:pointer;color:var(--g-tx2)}
.g-med-disc-head span{flex:1;text-align:left;font:400 13px/1 'Inter',system-ui,sans-serif}
.g-med-disc-head i{font-style:normal;color:var(--g-tx4);font-size:16px;transition:transform .2s}
.g-med-disc.open .g-med-disc-head{border-radius:14px 14px 0 0}
.g-med-disc.open .g-med-disc-head i{transform:rotate(90deg)}
.g-med-disc-body{border:1px solid var(--g-line);border-top:none;border-radius:0 0 14px 14px;padding:0 16px}
.g-med-disc-row{align-items:center;padding:14px 0}
.g-med-disc-row .g-med-now-name b{font-weight:400;color:var(--g-tx2)}
.g-med-disc-range{flex-shrink:0;max-width:42%;text-align:right;color:var(--g-tx3);font:300 12px/1.25 'Inter',system-ui,sans-serif}
.g-med-actions-slot{margin:24px 0 24px}
.g-med-empty{padding:12px 2px;font:300 12px/1.4 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-med-add{display:flex;width:100%;align-items:center;justify-content:center;gap:7px;margin-top:22px;padding:14px;border:1px solid var(--g-tx);border-radius:13px;background:var(--g-tx);color:var(--g-bg);font:500 14px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-med-add.top{margin-top:0}
.g-med-add span{font-size:16px;color:var(--g-bg)}
.g-med-hist-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.g-med-hist-head .g-med-ctit{margin:0}
.g-med-filter{border:1px solid var(--g-tx);border-radius:999px;background:var(--g-surface);color:var(--g-tx);font:500 12px/1 'Inter',system-ui,sans-serif;padding:6px 10px;cursor:pointer}
.g-med-mon{font:400 12px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin:18px 2px 2px}
.g-med-mon:first-of-type{margin-top:2px}
.g-med-te{position:relative;padding:0 0 18px 22px}
.g-med-te::before{content:"";position:absolute;left:4px;top:13px;bottom:0;width:1px;background:var(--g-line)}
.g-med-te.lastinmon::before{display:none}
.g-med-tdot{position:absolute;left:0;top:8px;width:9px;height:9px;border-radius:50%;border:2px solid var(--g-bg);z-index:1}
.g-med-te-head{display:block;width:100%;position:relative;padding:6px 0 2px;border:none;background:none;text-align:left;cursor:pointer}
.g-med-te-date{display:block;font:500 11.5px/1 'Inter',system-ui,sans-serif;letter-spacing:-.1px;color:var(--g-tx2)}
.g-med-te-date span{color:var(--g-tx3);font-weight:400;margin-right:5px}
.g-med-te-line{display:block;margin-top:5px;font:400 14px/1.5 'Inter',system-ui,sans-serif;color:var(--g-tx2);padding-right:18px}
.g-med-te-name{font-weight:500;letter-spacing:-.1px;color:var(--g-tx)}
.g-med-was{color:var(--g-tx3)}
.g-med-te-why{display:block;margin-top:6px;font:300 12px/1.4 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-med-te-chev{position:absolute;right:0;top:7px;font-size:15px;color:var(--g-tx4);transition:transform .2s}
.g-med-te.open .g-med-te-chev{transform:rotate(90deg);color:var(--g-tx3)}
.g-med-te.stop .g-med-te-line{color:var(--g-tx3)}
.g-med-te.stop .g-med-te-name{font-weight:400;color:var(--g-tx2)}
.g-med-snap-in{margin:8px 0 6px;padding:2px 0 0 2px}
.g-med-snap-row{display:flex;align-items:flex-start;gap:11px;padding:9px 0}
.g-med-snap-tick{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:5px;background:var(--tick,var(--g-tx4))}
.g-med-snap-stack{min-width:0;flex:1}
.g-med-snap-nm{font:400 13px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-med-snap-dose{display:block;margin-top:3px;font:400 12.5px/1.35 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-med-snap-row.subject .g-med-snap-tick{background:var(--g-mood-mod-high)}
.g-med-snap-row.subject .g-med-snap-nm{color:var(--g-tx);font-weight:500}
.g-med-snap-tr{display:block;margin-top:3px;font:400 12.5px/1.35 'Inter',system-ui,sans-serif;color:#B9743C}
.g-med-snap-tr span{color:var(--g-tx3)}
.g-med-snap-tr i{font-style:normal;color:rgba(238,154,82,.7);margin:0 6px}
.g-med-te-actions,.g-med-te-confirm{display:flex;align-items:center;gap:18px;margin:6px 0 2px;padding:13px 0 2px 2px;border-top:1px solid var(--g-line)}
.g-med-te-actions button,.g-med-te-confirm button{border:none;background:none;cursor:pointer;font:500 11.5px/1 'Inter',system-ui,sans-serif;padding:2px 0}
.g-med-te-actions .edit{color:var(--g-tx2)}
.g-med-te-actions .edit span{margin-right:6px;color:var(--g-tx3);font-weight:400}
.g-med-te-actions .del{color:var(--g-tx4);margin-left:auto}
.g-med-te-confirm span{flex:1;font:300 11.5px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-med-te-confirm button{color:var(--g-tx2)}
.g-med-te-confirm .remove{color:var(--g-warm-err)}
.g-med-field{margin-bottom:19px}
.g-med-field>label{display:block;margin-bottom:10px;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.11em;text-transform:uppercase;color:var(--g-tx3)}
.g-med-field small,.g-med-field em{display:block;margin:7px 2px;font:300 11px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx4);font-style:normal}
.g-med-chips{display:flex;flex-wrap:wrap;gap:7px}
.g-med-chip{padding:8px 12px;border:1px solid var(--g-line);border-radius:999px;background:transparent;color:var(--g-tx2);font:400 12px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-med-chip.on{border-color:var(--g-tx);background:var(--g-surface);color:var(--g-tx);font-weight:500}
.g-med-chip.new{border-style:dashed;color:var(--g-tx3)}
.g-med-chip.when{padding:8px 11px}
.g-med-chips.when-picker{gap:8px}
.g-med-input,.g-med-textarea{width:100%;border:1px solid var(--g-line);border-radius:11px;background:var(--g-card);color:var(--g-tx);font:400 16px/1.2 'Inter',system-ui,sans-serif;padding:11px 12px}
.g-med-textarea{min-height:68px;resize:none;line-height:1.45}
.g-med-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.g-med-step{display:flex;min-height:44px;align-items:center;gap:9px}
.g-med-step button{width:32px;height:32px;border:1px solid var(--g-line);border-radius:9px;background:var(--g-card);color:var(--g-tx2);font-size:18px;cursor:pointer}
.g-med-step b{min-width:17px;text-align:center;font:500 17px/1 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-med-step span{font:300 11px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-med-stop{padding:8px 12px;border:1px solid #E3CFC4;border-radius:999px;background:transparent;color:var(--g-warm-err);font:500 12px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-med-stop.on{background:rgba(190,115,85,.09)}
.g-med-seg{display:flex;overflow:hidden;border:1px solid var(--g-line);border-radius:10px}
.g-med-seg button{flex:1;padding:10px 0;border:none;border-left:1px solid var(--g-line);background:transparent;color:var(--g-tx3);font:500 12px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-med-seg button:first-child{border-left:none}
.g-med-seg button.on{background:var(--g-surface);color:var(--g-tx)}
.g-med-actions{display:flex;gap:10px;margin-top:24px}
.g-med-actions button{flex:1;padding:14px;border:1px solid var(--g-line);border-radius:12px;background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-med-actions button.primary{flex:2;border-color:var(--g-tx);background:var(--g-tx);color:var(--g-bg)}
.g-med-error{margin:-7px 0 10px;color:var(--g-warm-err);font:400 12px/1.35 'Inter',system-ui,sans-serif}
.g-med-preview{margin-top:4px;padding:14px;background:var(--g-surface);border-radius:12px}
.g-med-preview>span{display:block;margin-bottom:6px;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--g-tx3)}
.g-med-preview p{font:400 14px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-med-preview b{font-weight:500;color:var(--g-tx)}
.g-med-preview em{font-style:normal;color:var(--g-tx3)}
.g-med-preview small{display:block;margin-top:5px;color:var(--g-tx3)}

/* ── R9 home calendar ── */
.g-home{height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.g-home::after{z-index:0}
.g-home > *{position:relative;z-index:1}
.g-home .cal-top{padding:32px 0 0;flex-shrink:0;z-index:56;pointer-events:none}
.g-home .cnav{pointer-events:auto}
.g-home .cal-gr{font:400 13px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin:0 0 9px}
.g-home .cht{font:500 41px/1 'Inter',system-ui,sans-serif;letter-spacing:-1.5px;color:var(--g-tx)}
.g-home-yearbtn{font:inherit;letter-spacing:inherit;line-height:inherit;vertical-align:baseline;color:inherit;background:none;border:none;padding:0;margin:0;cursor:pointer;pointer-events:auto}
/* KK: year view — zoom-out of the month calendar, same dot vocabulary */
.g-year{height:100dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:calc(48px + env(safe-area-inset-bottom,0px))}
.g-year-back{display:inline-flex;align-items:center;gap:5px;border:none;background:none;color:var(--g-tx3);font:400 14px/1 'Inter',system-ui,sans-serif;cursor:pointer;margin-bottom:14px;padding:8px 0;min-height:40px}
.g-year-h1{font:500 41px/1 'Inter',system-ui,sans-serif;letter-spacing:-1.5px;color:var(--g-tx)}
.g-year-divider{grid-column:1/-1;margin:8px 0 0}
.g-year-sub{font:300 13px/1.4 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-bottom:22px}
.g-year-wrap{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px 14px}
.g-year-mname{font:500 12px/1 'Inter',system-ui,sans-serif;color:var(--g-tx2);margin-bottom:7px}
.g-year-mini.now .g-year-mname{color:var(--g-mood-mod-high)}
.g-year-mini.g-year-empty .g-year-mname{color:var(--g-tx4)}
.g-year-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.g-year-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;position:relative}
.g-year-cell.has{cursor:pointer}
.g-year-dot{width:7px;height:7px;border-radius:50%;transition:transform .12s}
.g-year-cell.has:active .g-year-dot{transform:scale(1.5)}
.g-year-cell.today::after{content:"";position:absolute;width:13px;height:13px;border-radius:50%;border:1.4px solid var(--g-mood-mod-high);opacity:.55}
.g-home .cht.cht-next{animation:cgInNext .28s cubic-bezier(.2,.85,.25,1) both}
.g-home .cht.cht-prev{animation:cgInPrev .28s cubic-bezier(.2,.85,.25,1) both}
.g-home .cal-tr{flex-direction:column;align-items:flex-end;gap:8px}
.g-home .sync-badge{margin-left:0}
.g-home .bi{border:1px solid var(--g-line);color:var(--g-tx2);border-radius:10px}
.g-home .cg{flex-shrink:0;gap:3px;margin:26px 0 0;touch-action:none}
@keyframes cgInNext{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
@keyframes cgInPrev{from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:none}}
.g-home .cg.cg-next{animation:cgInNext .28s cubic-bezier(.2,.85,.25,1) both}
.g-home .cg.cg-prev{animation:cgInPrev .28s cubic-bezier(.2,.85,.25,1) both}
.g-home .clb{font:500 11px/1 'Inter',system-ui,sans-serif;color:var(--g-tx4);text-align:center;padding:0 0 6px;text-transform:none;letter-spacing:0}
.g-home .cc{aspect-ratio:1/0.84;border-radius:0;background:transparent;cursor:pointer}
.g-home .cn{position:relative;z-index:2;font:400 13px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3);font-variant-numeric:tabular-nums}
.g-home .cc.cl .cn{color:var(--g-tx2);font-weight:500}
.g-home .cc.ct .cn{font-weight:600;color:var(--g-tx)}
.g-home .cc.ct::after{content:"";position:absolute;inset:14%;border:1.5px solid var(--g-tx);border-radius:50%;background:none;width:auto;height:auto;z-index:1}
.g-home .cc.csel::after{content:"";position:absolute;inset:14%;border:1.5px solid var(--g-tx3);border-radius:50%;background:transparent;width:auto;height:auto;bottom:auto;z-index:1}
.g-cal-glow{position:absolute;top:50%;left:50%;width:34px;height:34px;transform:translate(-50%,-50%);border-radius:50%;z-index:0;pointer-events:none}
.g-cal-glow::before{content:"";position:absolute;inset:0;border-radius:50%}
.g-cal-glow.g-mood-sev-low::before{background:radial-gradient(circle,rgba(91,94,134,1) 0%,rgba(91,94,134,.7) 52%,transparent 80%)}
.g-cal-glow.g-mood-mod-low::before{background:radial-gradient(circle,rgba(124,126,174,1) 0%,rgba(124,126,174,.66) 52%,transparent 80%)}
.g-cal-glow.g-mood-mild-low::before{background:radial-gradient(circle,rgba(179,168,204,1) 0%,rgba(179,168,204,.62) 52%,transparent 80%)}
.g-cal-glow.g-mood-steady::before{background:radial-gradient(circle,rgba(207,201,174,.95) 0%,rgba(207,201,174,.55) 52%,transparent 80%)}
.g-cal-glow.g-mood-mild-high::before{background:radial-gradient(circle,rgba(233,199,126,1) 0%,rgba(233,199,126,.62) 52%,transparent 80%)}
.g-cal-glow.g-mood-mod-high::before{background:radial-gradient(circle,rgba(238,154,82,1) 0%,rgba(238,154,82,.66) 52%,transparent 80%)}
.g-cal-glow.g-mood-sev-high::before{background:radial-gradient(circle,rgba(233,106,51,1) 0%,rgba(233,106,51,.7) 52%,transparent 80%)}
.g-home-recent{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-width:none;margin:34px 0 0;padding-bottom:166px}
.g-home-recent::-webkit-scrollbar{display:none}
.g-home-recent-eyebrow{display:block;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--g-tx3);margin-bottom:11px}
.g-home-r-item{display:flex;gap:12px;align-items:flex-start;margin-bottom:14px;cursor:pointer}
.g-home-r-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;filter:blur(.4px);margin-top:3px}
.g-home-r-body{flex:1;min-width:0}
.g-home-r-day{font:500 12px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-home-r-day em{font-style:normal;color:var(--g-tx3);font-weight:400}
.g-home-r-note{margin-top:2px;color:var(--g-tx);font:400 13px/1.5 'Inter',system-ui,sans-serif;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.g-home-r-more{text-align:center;padding:6px 0 10px;min-height:22px;font:400 12px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx4)}
.g-home-r-load{display:inline-flex;gap:5px;align-items:center;justify-content:center}
.g-home-r-load i{width:5px;height:5px;border-radius:50%;background:var(--g-tx4);animation:rLoad 1.1s ease-in-out infinite}
.g-home-r-load i:nth-child(2){animation-delay:.16s}
.g-home-r-load i:nth-child(3){animation-delay:.32s}
@keyframes rLoad{0%,100%{opacity:.28;transform:translateY(0)}50%{opacity:.85;transform:translateY(-2px)}}
@media(prefers-reduced-motion:reduce){.g-home-r-load i{animation:none;opacity:.6}}
.g-home .day-card{background:var(--g-card);border:1px solid var(--g-line);border-radius:16px;box-shadow:none}
.g-home .day-card-date{font:500 13px/1 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-home .day-card-arrow{font:500 12px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-home .day-card-note{font:300 13px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-home .day-chip{background:var(--g-surface);color:var(--g-tx2);border-radius:8px}
.g-home-actions{position:fixed;z-index:56;background:linear-gradient(to top,var(--g-bg) 75%,transparent)}
.g-home-log-btn{width:100%;padding:16px;border-radius:999px;border:none;background:var(--g-tx);color:var(--g-bg);font:500 15px/1 'Inter',system-ui,sans-serif;letter-spacing:.02em;cursor:pointer}
.g-home-srm-btn{width:100%;padding:12px;border-radius:999px;border:1px solid var(--g-tx4);background:transparent;color:var(--g-tx2);font:500 13px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-home-nav{display:flex;justify-content:center;gap:25px;padding:6px 0 0}
.g-home-nav button{border:none;background:none;font:500 11px/1 'Inter',system-ui,sans-serif;color:var(--g-tx4);cursor:pointer}
.g-home-nav button.active{color:var(--g-tx);font-weight:600}
.g-home .cal-pad{display:none}
/* ── R10 quick-add bubble ── */
.g-home .cc-future{cursor:default}
.g-home .cc-future .cn{opacity:.5}
.g-home .cc.cc-open::after{content:"";position:absolute;inset:10%;border:2px solid var(--g-tx);border-radius:50%;background:none;width:auto;height:auto;z-index:1}
.g-bubble{position:fixed;z-index:60;background:var(--g-bg);border-radius:18px;box-shadow:0 14px 42px rgba(0,0,0,.2);padding:12px 14px 11px;transform-origin:50% 0;animation:gBubbleIn .22s cubic-bezier(.2,.85,.25,1) both}
.g-bubble-scrim{position:fixed;inset:0;z-index:55;background:transparent}
@keyframes gBubbleIn{from{opacity:0;transform:scale(.92) translateY(-6px)}to{opacity:1;transform:none}}
.g-bubble-caret{position:absolute;width:13px;height:13px;background:var(--g-bg);transform:rotate(45deg);top:-6px;box-shadow:-3px -3px 7px rgba(0,0,0,.03)}
.g-bubble-open{display:block;width:100%;border:none;background:none;text-align:left;color:inherit;cursor:pointer}
.g-bubble-date{font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:var(--g-tx3)}
.g-bubble-prompt{font:500 16px/1.2 'Inter',system-ui,sans-serif;letter-spacing:-.2px;color:var(--g-tx);margin-top:4px}
.g-bubble-prompt-small{font-size:12px;color:var(--g-tx3);margin-top:12px}
.g-bubble-rhythm{display:block;margin-top:9px;font:500 14px/1.35 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-bubble-rsub{display:block;margin-top:3px;font:400 12px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-bubble-pick{display:flex;justify-content:space-between;align-items:center;margin:11px 0 5px}
.g-bubble-dot{width:24px;height:24px;border-radius:50%;border:none;background:transparent;position:relative;cursor:pointer;flex-shrink:0}
.g-bubble-dot::before{content:"";position:absolute;inset:0;border-radius:50%}
.g-bubble-dot:active{transform:scale(.9)}
.g-bubble-ends{display:flex;justify-content:space-between}
.g-bubble-ends span{font:400 9px/1 'Inter',system-ui,sans-serif;color:var(--g-tx4)}
.g-bubble-mini{display:flex;justify-content:flex-end;margin-top:10px}
.g-bubble-go{border:none;background:none;font:500 12.5px/1 'Inter',system-ui,sans-serif;color:var(--g-tx);cursor:pointer}
.g-bubble-mood{display:flex;align-items:center;gap:9px;margin:9px 0 6px}
.g-bubble-cdot{width:20px;height:20px;border-radius:50%;flex-shrink:0}
.g-bubble-clabel{font:500 17px/1.1 'Inter',system-ui,sans-serif;letter-spacing:-.2px;color:var(--g-tx)}
.g-bubble-clabel small{font-size:12px;color:var(--g-tx3)}
.g-bubble-caps{font:600 9px/1.3 'Inter',system-ui,sans-serif;letter-spacing:.11em;text-transform:uppercase;color:var(--g-tx3)}
.g-bubble-sum{font:400 11.5px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-bubble-regimen{display:flex;align-items:center;gap:7px;margin-top:8px;font:400 12px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-bubble-regimen i{width:7px;height:7px;flex-shrink:0;border-radius:50%;background:var(--g-mood-mod-high)}
.g-toast{position:fixed;left:50%;bottom:calc(186px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:61;display:flex;align-items:center;gap:14px;background:var(--g-tx);color:var(--g-bg);border-radius:999px;padding:10px 16px;box-shadow:0 8px 28px rgba(0,0,0,.22);animation:gToastIn .18s var(--ease);white-space:nowrap}
@keyframes gToastIn{from{opacity:0;transform:translateX(-50%) translateY(4px)}to{opacity:1;transform:translateX(-50%)}}
.g-toast-msg{font:400 13px/1 'Inter',system-ui,sans-serif}
.g-toast-undo{border:none;background:none;color:var(--g-bg);font:600 13px/1 'Inter',system-ui,sans-serif;cursor:pointer;text-decoration:underline}

/* ── R9b day detail ── */
.g-day{padding:0;background:var(--g-bg);min-height:100dvh;font-family:'Inter',system-ui,sans-serif;color:var(--g-tx);animation:gModalIn .34s cubic-bezier(.2,.85,.25,1) both}
.scr.g-day{padding:0}
.g-day-hero{position:relative;height:300px;flex-shrink:0;overflow:hidden}
.g-day-hero::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.18;mix-blend-mode:soft-light;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='hn'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23hn)'/%3E%3C/svg%3E")}
.g-day-close{position:absolute;top:calc(18px + env(safe-area-inset-top));right:18px;z-index:3;width:40px;height:40px;border-radius:50%;border:none;background:rgba(255,255,255,.42);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:#1C1C1A;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.g-day-hero-cap{position:absolute;left:24px;right:24px;bottom:24px;z-index:2}
.g-day-kick{font:600 11px/1 'Inter',system-ui,sans-serif;letter-spacing:.13em;text-transform:uppercase;color:rgba(28,28,26,.6);margin-bottom:6px}
.g-day-word{font:500 36px/1 'Inter',system-ui,sans-serif;letter-spacing:-1.3px;color:#1C1C1A}
.g-day-body{padding:22px 24px 40px}
.g-day-rowhead{display:flex;align-items:center;justify-content:space-between;padding-bottom:14px}
.g-day-inline-edit{border:none;background:none;color:var(--g-tx2);font:500 12px/1 'Inter',system-ui,sans-serif;cursor:pointer}
.g-day-eyebrow,.g-day-k{display:block;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--g-tx3)}
.g-day-hair{height:1px;background:var(--g-line)}
.g-day-vit{display:grid;grid-template-columns:1fr 1fr}
.g-day-cell,.g-day-block{position:relative}
.g-day-cell{padding:16px 0}
.g-day-cell:nth-child(odd){padding-right:18px;border-right:1px solid var(--g-line)}
.g-day-cell:nth-child(even){padding-left:18px}
.g-day-cell:nth-child(1),.g-day-cell:nth-child(2){border-bottom:1px solid var(--g-line)}
.g-day-cell .g-day-k{margin-bottom:8px}
.g-day-v{font:400 21px/1.15 'Inter',system-ui,sans-serif;letter-spacing:-.4px;color:var(--g-tx)}
.g-day-v small{font-size:13px;color:var(--g-tx3)}
.g-day-scale{display:flex;gap:3px;margin-top:9px}
.g-day-scale i{flex:1;height:4px;border-radius:2px;background:var(--g-line)}
.g-day-scale i.on{background:var(--g-tx2)}
.g-day-block{padding:16px 0}
.g-day-block .g-day-k{margin-bottom:10px}
.g-day-note{font:300 15px/1.5 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-day-meds{display:flex;flex-direction:column;gap:9px}
.g-day-med-line{display:flex;align-items:center;gap:8px;font:400 13px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-day-med-line.skip{color:var(--g-tx3)}
.g-day-med-line>i{width:7px;height:7px;flex-shrink:0;border-radius:50%;background:var(--g-tx4)}
.g-day-med-line.skip>i{background:transparent;border:1px solid #9AA0BE}
.g-day-med-row{display:flex;align-items:flex-start;gap:8px;font:400 13px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-day-med-row .dotcol{width:16px;flex:0 0 16px;display:flex;justify-content:flex-start}
.g-day-med-row .dotcol i{width:7px;height:7px;border-radius:50%;background:var(--g-tx4);margin-top:5px}
.g-day-med-row .mtxt{display:flex;flex-direction:column;min-width:0;flex:1}
.g-day-med-row .mt1{display:flex;align-items:baseline;gap:7px;min-width:0;flex-wrap:nowrap}
.g-day-med-row .nm{font-weight:500;color:var(--g-tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.g-day-med-row .ds{color:var(--g-tx3);font-size:12px;white-space:nowrap;flex:0 0 auto}
.g-day-med-row .when-tag{font-size:11px;flex:0 0 auto}
.g-day-med-row .mchip{margin-top:4px}
.g-day-med-row .flag{display:inline-block;font:700 9px/1 'Inter',system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase;border-radius:999px;padding:4px 9px;white-space:nowrap;border:0}
.g-day-med-row.off .flag{background:var(--g-sleep-healthy);color:var(--g-tx)}
.g-day-med-row.missed .flag{background:var(--g-warm-err);color:var(--g-card)}
.g-day-med-row .mnote{margin:6px 0 3px;padding-left:10px;border-left:2px solid var(--g-line);font:300 11.5px/1.45 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-day-med-key{display:flex;align-items:center;gap:14px;margin-top:14px;padding-top:11px;border-top:1px solid var(--g-line)}
.g-day-med-key span{display:inline-flex;align-items:center;gap:6px;font:400 10px/1 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-day-med-key i{width:9px;height:9px;border-radius:50%;flex:0 0 9px}
.g-day-med-key i.off{background:var(--g-sleep-healthy)}
.g-day-med-key i.miss{background:var(--g-warm-err)}
.g-day-clear{flex-shrink:0;width:20px;height:20px;border:1px solid rgba(212,120,92,.42);border-radius:50%;background:rgba(212,120,92,.09);color:var(--g-warm-err);font:500 15px/17px 'Inter',system-ui,sans-serif;cursor:pointer}
.g-day-cell>.g-day-clear,.g-day-block>.g-day-clear{position:absolute;top:12px;right:0}
.g-day-tl-item{display:flex;gap:14px;align-items:flex-start;padding:8px 0;cursor:pointer}
.g-day-tl-time{width:64px;flex-shrink:0;font:400 13px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx);font-variant-numeric:tabular-nums}
.g-day-tl-dot{position:relative;width:9px;flex-shrink:0;display:flex;justify-content:center;margin-top:6px}
.g-day-tl-dot::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--g-tx3)}
.g-day-tl-label{flex:1;font:400 14px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-day-tl-tag{color:var(--g-tx3);font-size:11px}
.g-day-spectrum{position:relative;height:7px;border-radius:6px;background:linear-gradient(90deg,#5B5E86,#8E8FB8,#C9C3DE,#E8E4C0,#F2C879,#F2914A,#E0431C)}
.g-day-spectrum-knob{position:absolute;top:50%;width:15px;height:15px;border-radius:50%;background:var(--g-bg);border:2px solid var(--g-tx);transform:translate(-50%,-50%)}
.g-day-spectrum-ends{display:flex;justify-content:space-between;margin-top:8px}
.g-day-spectrum-ends span{font:400 10px/1 'Inter',system-ui,sans-serif;color:var(--g-tx4)}
.g-day-empty{color:var(--g-tx3);font-size:13px;text-align:center;margin-top:40px}
.g-day-foot{padding-top:20px}
.g-day-edit-btn{width:100%;padding:15px;border-radius:999px;border:none;background:var(--g-tx);color:var(--g-bg);font:500 14px/1 'Inter',system-ui,sans-serif;letter-spacing:.02em;cursor:pointer}
.g-day-del-row{display:flex;justify-content:center;gap:16px;flex-wrap:wrap;margin-top:14px}
.g-day-del{border:none;background:none;color:var(--g-tx3);font:400 12px/1 'Inter',system-ui,sans-serif;cursor:pointer;padding:6px}
.g-day-confirm{font:400 12px/1.6 'Inter',system-ui,sans-serif;color:var(--g-tx2);display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.g-day-confirm-yes{border:none;background:none;color:var(--g-warm-err);font-weight:600;cursor:pointer}
.g-day-confirm-no{border:none;background:none;color:var(--g-tx3);cursor:pointer}
.g-day-move{display:block;margin:10px auto 0;border:none;background:none;color:var(--g-tx3);font:400 12px/1 'Inter',system-ui,sans-serif;cursor:pointer;padding:6px}
.g-day-undo{position:sticky;bottom:12px;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:14px 0 0;padding:10px 13px;border:1px solid var(--g-line);border-radius:12px;background:var(--g-card);box-shadow:0 6px 22px rgba(28,28,26,.08);color:var(--g-tx2);font:400 12px/1.2 'Inter',system-ui,sans-serif}
.g-day-undo button{border:none;background:none;color:var(--g-tx);font:600 12px/1 'Inter',system-ui,sans-serif;cursor:pointer}
/* BB: edit mode — single left rail + "manage this day" group */
.g-day-editing .g-day-vit{grid-template-columns:1fr}
.g-day-editing .g-day-cell{padding:14px 0 14px 30px;border-right:none}
.g-day-editing .g-day-block{padding-left:30px}
.g-day-editing .g-day-cell>.g-day-clear,.g-day-editing .g-day-block>.g-day-clear{left:5px;top:50%;right:auto;transform:translateY(-50%)}
.g-day-manage{margin-top:18px;border-top:1px solid var(--g-line);padding-top:8px}
.g-day-mrow{display:flex;align-items:center;gap:12px;width:100%;border:none;background:none;padding:13px 2px;font:400 14px/1 'Inter',system-ui,sans-serif;color:var(--g-tx2);cursor:pointer;text-align:left}
.g-day-mrow .ic{width:18px;text-align:center;color:var(--g-tx3);flex-shrink:0}
.g-day-mrow-danger,.g-day-mrow-danger .ic{color:var(--g-warm-err)}
.g-day-manage-confirm{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:13px 2px;font:400 13px/1.4 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.cfdraw{stroke-dasharray:40;stroke-dashoffset:40;animation:gCheckDraw .55s cubic-bezier(.2,.85,.25,1) .15s forwards}
@keyframes gCheckDraw{to{stroke-dashoffset:0}}
@keyframes gConfirmIn{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes gCheckPop{from{transform:scale(.8);opacity:0}to{transform:none;opacity:1}}

.hh{display:flex;align-items:center;justify-content:space-between;padding:24px 0 16px}
.ht{font-family:'Source Serif 4',serif;font-weight:400;font-size:22px}.ha{display:flex;gap:8px;align-items:center}
.sr{display:flex;gap:10px;margin-bottom:14px}
.sb{flex:1;background:var(--card);border-radius:var(--r);padding:14px 10px;box-shadow:var(--sh);text-align:center}
.sv{font-family:'Source Serif 4',serif;font-size:26px;font-weight:300}.sbl{font-size:10px;color:var(--t3);margin-top:2px}
.range-bar{display:flex;gap:6px;margin-bottom:14px;padding:0 2px}
.range-chip{padding:8px 12px;border-radius:999px;border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;transition:all .15s}
.range-chip:active{transform:scale(.95)}
.range-chip.on{border-color:var(--tx);background:var(--warm);color:var(--tx)}
.card{background:var(--card);border-radius:var(--r);padding:16px;box-shadow:var(--sh);margin-bottom:12px}
.ctit{font-size:10px;font-weight:500;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.cw{margin:0 -6px}
.ov-bar{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.ov-chip{padding:6px 12px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:400 11px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:5px}
.ov-chip:active{transform:scale(.95)}
.ov-chip.on{border-color:var(--tx);background:var(--warm);color:var(--tx);font-weight:500}
.ov-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.cleg2{display:flex;gap:12px;margin-top:8px;font-size:10px;color:var(--t2);flex-wrap:wrap}
.ll{display:inline-block;width:14px;height:2px;border-radius:1px;vertical-align:middle;margin-right:3px}
.sleep-card{border-radius:22px;padding:26px 24px 22px}
.slp-head{display:flex;align-items:baseline;gap:10px;margin-bottom:24px}
.slp-head .v{font-family:'Source Serif 4',serif;font-size:46px;font-weight:300;line-height:1;letter-spacing:0}
.slp-head .u{font-family:'Source Serif 4',serif;font-size:19px;font-weight:300;color:var(--t2)}
.slp-head .meta{margin-left:auto;font-size:11px;color:var(--t3);font-weight:400;text-align:right;line-height:1.5}
.sleep-grid{position:relative;height:240px;margin-bottom:14px}
.y-label{position:absolute;left:0;font-size:10.5px;color:var(--t3);font-weight:400;line-height:1;letter-spacing:.02em;text-transform:lowercase}
.y-top{top:0}.y-mid{top:calc(50% - 6px)}.y-bot{bottom:0}
.chart-body{position:absolute;left:32px;right:50px;top:0;bottom:0;overflow:visible}
.ref-line{position:absolute;left:0;right:0;height:0;border-top:1px dashed #C8C0B5;opacity:.7;pointer-events:none;z-index:1}
.ref-label{position:absolute;right:0;width:46px;padding-left:6px;font-family:'Source Serif 4',serif;font-style:italic;font-size:9.5px;color:var(--t3);font-weight:300;line-height:1.2;letter-spacing:.01em;pointer-events:none;transform:translateY(-50%);text-align:left;white-space:nowrap;z-index:4}
.ref-label b{display:block;font-style:normal;font-weight:400;color:var(--tx);font-size:11px;letter-spacing:0;margin-bottom:1px}
.bars{position:absolute;inset:0;display:flex;align-items:stretch;gap:2px;z-index:2}
.col{flex:1;min-width:0;position:relative;display:flex;justify-content:center}
.bar{position:absolute;left:50%;transform:translateX(-50%);width:100%;max-width:11px;border:none;border-radius:2px;padding:0;cursor:pointer;transition:opacity .2s,transform .2s var(--ease)}
.bar:hover{opacity:.9}
.tip{position:absolute;left:50%;transform:translateX(-50%);background:var(--tx);color:#FFFCF6;font-size:11px;padding:6px 10px;border-radius:8px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s;z-index:5;line-height:1.4;font-weight:400;text-align:left}
.tip b{font-weight:500}
.col.show .tip{opacity:1}
.xax{display:flex;gap:2px;padding-left:32px;padding-right:50px;margin-top:4px;font-size:10px;color:var(--t3);font-weight:400}
.xax span{flex:1;text-align:center;letter-spacing:.02em}
.dist{margin-top:24px}
.dist-pcts{display:flex;height:14px;margin-bottom:5px;gap:2px;font-size:11px;color:var(--tx);font-weight:500;font-family:'Source Serif 4',serif;letter-spacing:0}
.dist-pcts span{height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap}
.dist-strip{display:flex;height:8px;border-radius:3px;overflow:hidden;margin-bottom:6px;gap:2px}
.dist-seg{height:100%}
.dist-labels{display:flex;gap:2px;font-size:10px;color:var(--t3);font-weight:400;letter-spacing:.02em}
.dist-labels span{display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap}
.tt{background:var(--card);border:1px solid var(--bd);border-radius:var(--rs);padding:8px 12px;box-shadow:var(--sh);font-size:11px;z-index:10}
.ttd{font-weight:500;margin-bottom:2px}
.notes-card{background:var(--card);border-radius:var(--r);padding:24px 22px 20px;box-shadow:var(--sh);margin-bottom:12px}
.notes-h{font-family:'Source Serif 4',serif;font-weight:400;font-size:20px;letter-spacing:0;margin-bottom:4px}
.notes-sub{font-size:11px;color:var(--t3);font-weight:300;margin-bottom:18px}
.nl{display:flex;flex-direction:column;gap:18px}.nr{display:grid;grid-template-columns:auto 1fr;column-gap:14px;row-gap:6px;padding-bottom:18px;border-bottom:1px solid var(--bd)}.nr:last-child{padding-bottom:0;border-bottom:none}
.n-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--t2);font-weight:500;letter-spacing:.02em;grid-column:1/-1}
.n-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;opacity:.85}.n-date{font-family:'DM Sans',sans-serif}.n-mood{color:var(--t3);font-weight:400;font-size:10.5px;text-transform:lowercase}
.nd{font-size:11px;color:var(--t3);font-weight:500;min-width:44px;flex-shrink:0;padding-top:1px}.nt{font-family:'Source Serif 4',serif;font-size:15px;line-height:1.55;color:var(--tx);font-weight:400;grid-column:1/-1}
.g-insights{padding:30px 24px 26px;font-family:'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-insights::after{z-index:0}
.g-insights > *{position:relative;z-index:1}
.g-insights .hh{padding:0 0 14px;align-items:flex-start}
.g-insights .ht{font:500 24px/1.15 'Inter',system-ui,sans-serif;letter-spacing:-.6px;color:var(--g-tx)}
.g-insights .ha{gap:8px}
.g-insights .bx{display:flex;width:40px;height:40px;align-items:center;justify-content:center;padding:0;border:1px solid var(--g-line);border-radius:10px;background:transparent;color:var(--g-tx2);cursor:pointer}
.g-insights .bx svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.g-insights .bi{width:40px;height:40px;border:1px solid var(--g-line);border-radius:10px;background:transparent;color:var(--g-tx2);font-family:'Inter',system-ui,sans-serif}
.g-insights .sr{gap:10px;margin-bottom:14px;padding:0}
.g-insights .sb{background:var(--g-card);border:1px solid var(--g-line);border-radius:14px;box-shadow:none;padding:13px 10px}
.g-insights .sv{font:400 25px/1 'Inter',system-ui,sans-serif;letter-spacing:-.5px;color:var(--g-tx)}
.g-insights .sv small{font-size:12px;color:var(--g-tx3);letter-spacing:0}
.g-insights .sbl{font:400 10px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx3);margin-top:5px}
.g-insights .range-bar{gap:7px;margin-bottom:14px;padding:0}
.g-insights .range-chip{padding:7px 14px;border:1px solid var(--g-line);border-radius:999px;background:transparent;color:var(--g-tx3);font:500 12px/1 'Inter',system-ui,sans-serif}
.g-insights .range-chip.on{border-color:var(--g-tx);background:var(--g-surface);color:var(--g-tx)}
.g-insights .card,.g-insights .notes-card{background:var(--g-card);border:1px solid var(--g-line);border-radius:16px;box-shadow:none;padding:16px;margin-bottom:12px}
.g-insights .ctit,.g-insights .notes-h{display:block;font:600 10px/1 'Inter',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--g-tx3);margin-bottom:10px}
.g-insights .cw{margin:0 -6px}
.g-insights .recharts-cartesian-grid line{stroke:var(--g-line)}
.g-insights .recharts-text{font-family:'Inter',system-ui,sans-serif}
.g-insights .ov-bar{gap:7px;margin-top:11px}
.g-insights .ov-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid var(--g-line);border-radius:10px;background:transparent;color:var(--g-tx2);font:400 11px/1 'Inter',system-ui,sans-serif}
.g-insights .ov-chip.on{border-color:var(--g-tx);background:var(--g-surface);color:var(--g-tx)}
.g-insights .cleg2{gap:12px;margin-top:9px;color:var(--g-tx2);font:400 10px/1.4 'Inter',system-ui,sans-serif}
.g-insights .card-sub,.g-insights .notes-sub{font:300 11px/1.4 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-insights .sleep-card{border-radius:16px;padding:16px}
.g-insights .slp-head{gap:6px;margin-bottom:14px}
.g-insights .slp-head .v{font:400 24px/1 'Inter',system-ui,sans-serif;letter-spacing:-.5px;color:var(--g-tx)}
.g-insights .slp-head .u,.g-insights .slp-head .meta{font:300 12px/1.3 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-insights .sleep-grid{height:150px;padding-left:58px;margin-bottom:0}
.g-insights .chart-body{left:58px;right:0}
.g-insights .y-label{left:0;color:var(--g-tx3);font:400 10px/1 'Inter',system-ui,sans-serif}
.g-insights .ref-label{left:0;right:auto;width:54px;padding-left:0;color:var(--g-tx3);font:400 10px/1.1 'Inter',system-ui,sans-serif}
.g-insights .ref-label b{font:600 10px/1.1 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-insights .ref-line{border-top-color:#BFB9AC}
.g-insights .bar{max-width:none;left:1px;right:1px;width:auto;transform:none;border-radius:4px}
.g-insights .xax{padding-left:58px;padding-right:0;color:var(--g-tx3);font:400 9px/1 'Inter',system-ui,sans-serif}
.g-insights .dist{padding-left:58px;margin-top:14px}
.g-insights .dist-pcts,.g-insights .dist-labels{color:var(--g-tx3);font:400 9px/1 'Inter',system-ui,sans-serif}
.g-insights .dist-strip{height:6px;gap:0}
.g-insights .whead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.g-insights .wstat{text-align:right}
.g-insights .wsv{font:500 15px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx)}
.g-insights .wsd{font:300 12px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx3)}
.g-insights .tt{border:1px solid var(--g-line);background:var(--g-card);box-shadow:none;color:var(--g-tx);font-family:'Inter',system-ui,sans-serif}
.g-insights .nl{gap:0}
.g-insights .nr{display:flex;flex-direction:column;gap:3px;padding:9px 0;border-bottom:1px solid var(--g-line)}
.g-insights .nr:last-child{border-bottom:none}
.g-insights .n-meta{gap:6px;font:500 11px/1.2 'Inter',system-ui,sans-serif;color:var(--g-tx2);letter-spacing:0}
.g-insights .n-date{font-family:'Inter',system-ui,sans-serif}
.g-insights .n-mood{color:var(--g-tx3);font:400 11px/1.2 'Inter',system-ui,sans-serif;text-transform:none}
.g-insights .nt{font:300 13px/1.5 'Inter',system-ui,sans-serif;color:var(--g-tx2)}
.g-insights .ht,.g-settings .ht,.g-entry .qt,.g-srm-picker .ht,.g-srm-single .qt{font-weight:500;font-size:42px;line-height:1.08;letter-spacing:-1.2px;color:var(--g-tx)}
.g-sheet .ht{font:500 38px/1.05 'Inter',system-ui,sans-serif;letter-spacing:-1.4px;color:var(--g-tx)}
@media(max-width:380px){
  .g-entry .qt,.g-srm-picker .ht{font-size:38px}
  .g-entry .qt-notes{font-size:36px}
  .g-srm-picker{padding-top:calc(32px + env(safe-area-inset-top))}
}

.dv-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.dv-acts{display:flex;gap:8px}
.dv-mood{font-size:17px;font-weight:500;margin-bottom:8px}
.dv-row{font-size:13px;color:var(--t2);padding:6px 0;border-bottom:1px solid var(--bd);font-weight:300}
.dv-row:last-child{border-bottom:none}
.dv-note{font-size:13px;color:var(--t2);font-weight:300;font-style:italic;margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);line-height:1.5}
.dv-confirm{display:flex;align-items:center;gap:8px;padding:10px;background:#FDF0EC;border-radius:var(--rs);margin-bottom:10px;font-size:12px}
.dv-confirm span{flex:1}
.dv-srm-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bd);gap:8px}
.dv-srm-row:last-child{border-bottom:none}
.dv-srm-info{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:300;color:var(--t2)}
.dv-srm-icon{color:var(--t3);width:20px;text-align:center}
.dv-srm-r{display:flex;align-items:center;gap:8px}
.dv-srm-time{font-size:12px;color:var(--t3);font-weight:300}

.set-nr{display:flex;gap:8px;align-items:center}
.set-in{flex:1;padding:10px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);font-size:16px;font-family:'DM Sans',sans-serif;font-weight:400;color:var(--tx);background:transparent;outline:none;-webkit-text-size-adjust:100%}
.set-in:focus{border-color:var(--tx)}.set-in::placeholder{color:var(--t3)}
.set-h{font-size:12px;color:var(--t3);font-weight:300;margin-top:8px}
.set-saved{font-size:12px;color:var(--gn);font-weight:400;margin-top:8px;animation:si .3s var(--ease)}
.set-pcb{display:flex;gap:8px}.set-pcf{margin-top:8px}
.set-mr{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--bd)}.set-mr:last-of-type{border-bottom:none}
.set-mr-acts{display:flex;gap:4px;align-items:center}
.set-med-edit{padding:12px;border:1.5px solid var(--bd);border-radius:var(--rs);margin-bottom:8px}
.set-reminder{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--bd)}
.set-reminder:last-of-type{border-bottom:none}
.set-r-time{font-family:'Source Serif 4',serif;font-size:16px;margin-right:8px}
.set-r-label{font-size:12px;color:var(--t3)}
.set-r-acts{display:flex;gap:6px;align-items:center}
.set-r-toggle{padding:4px 10px;border-radius:6px;border:1px solid var(--bd);background:transparent;font:500 11px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer}
.set-r-on{border-color:var(--gn);color:var(--gn);background:var(--gbg)}
/* ── new merged Reminders card ── */
.rem-status{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px;min-height:44px}
.rem-status.rem-warn{background:#FAF6ED;color:#8A6A1E}
.rem-status-btn{padding:6px 14px;font-size:12px;flex-shrink:0}
.rem-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.rem-dot-amber{background:#E5B86B}
.rem-dot-red{background:#D4785C}
@keyframes remPulse{0%{box-shadow:0 0 0 0 rgba(123,160,139,.6)}70%{box-shadow:0 0 0 8px rgba(123,160,139,0)}100%{box-shadow:0 0 0 0 rgba(123,160,139,0)}}
.rem-toggle-pulse{animation:remPulse 1.2s ease-out 1}
.rem-toggle:disabled{opacity:.55;cursor:wait}
.rem-install{display:flex;gap:12px;padding:14px;border-radius:8px;background:#FAF6ED;color:#8A6A1E;margin-bottom:12px;align-items:flex-start}
.rem-install svg{margin-top:2px;flex-shrink:0}
.rem-install-body{flex:1;font-size:13px;line-height:1.5}
.rem-install-title{font-weight:600;margin-bottom:4px}
.rem-install p{margin:0 0 6px}
.rem-install ol{margin:0;padding-left:18px}
.rem-install ol li{margin-bottom:2px}
.rem-inactive{padding:8px 12px;background:#FAF6ED;color:#8A6A1E;border-radius:6px;font-size:12px;margin-bottom:12px}
.rem-empty{text-align:center;padding:32px 16px}
.rem-empty-emoji{font-size:32px;margin-bottom:8px}
.rem-empty-title{font-family:'Source Serif 4',serif;font-size:18px;margin-bottom:6px;color:var(--t1)}
.rem-empty-sub{font-size:13px;color:var(--t2);margin-bottom:16px;line-height:1.5}
.rem-list{display:flex;flex-direction:column;gap:0}
.rem-row{display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--bd);transition:opacity 150ms ease}
.rem-row:last-child{border-bottom:none}
.rem-row-off{opacity:.55}
.rem-row-main{flex:1;text-align:left;background:transparent;border:none;padding:0;cursor:pointer;font-family:inherit;min-height:44px;display:flex;flex-direction:column;justify-content:center}
.rem-row-main:active{background:var(--gbg);border-radius:6px;margin:-4px;padding:4px}
.rem-row-time{font-family:'Source Serif 4',serif;font-size:17px;color:var(--t1)}
.rem-row-label{font-size:13px;color:var(--t2);margin-top:2px}
.rem-toggle{position:relative;width:42px;height:24px;border-radius:12px;background:#D8D2C9;border:none;cursor:pointer;padding:0;transition:background-color 150ms ease;flex-shrink:0;margin-left:8px}
.rem-toggle.rem-toggle-on{background:#7BA08B}
.rem-toggle-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.15);transition:left 200ms cubic-bezier(.4,0,.2,1)}
.rem-toggle.rem-toggle-on .rem-toggle-knob{left:20px}
.rem-form{padding:14px;border:1.5px solid var(--bd);border-radius:8px;margin:8px 0;background:var(--gbg)}
.rem-form-lbl{display:block;font-size:11px;color:var(--t2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px}
.rem-form-time{margin-bottom:12px}
.rem-form-label{margin-bottom:12px}
.rem-form-acts{display:flex;gap:8px;align-items:center}
.rem-form-del{background:transparent;border:none;color:#D4785C;font-size:13px;cursor:pointer;padding:4px 8px}
.rem-add{margin-top:8px}
.rem-msg{margin-top:10px;font-size:12px;line-height:1.5}
.rem-smart{padding-top:4px}
.rem-smart-row{display:flex;align-items:flex-start;gap:12px;padding:8px 0}
.rem-smart-text{flex:1;min-width:0}
.rem-smart-title{font-size:14px;color:var(--t1);font-weight:500}
.rem-stats{margin-top:10px;padding-top:10px;border-top:1px solid var(--bd);display:flex;flex-direction:column;gap:4px}
.rem-stats-row{font-size:12px;color:var(--t2)}
.rem-stats-v{color:var(--t1)}
.rem-stats-faint{color:var(--t3);font-size:11px}
.rem-stats-week{font-size:13px;color:var(--t1);font-family:'Source Serif 4',serif}
.actor-pills{display:flex;gap:6px;flex-wrap:wrap}
.actor-pill{flex:1;min-width:80px;padding:8px 12px;border-radius:8px;border:1px solid var(--bd);background:transparent;font-size:13px;color:var(--t2);cursor:pointer;transition:all 150ms ease;font-family:inherit}
.actor-pill:hover{background:var(--gbg)}
.actor-pill-on{border-color:var(--gn);color:var(--gn);background:var(--gbg)}
.dev-notes-section{margin-top:32px;display:flex;flex-direction:column;align-items:center;gap:0}
.btn-add-note{padding:10px 20px;border:none;border-radius:9px;background:var(--tx);color:#fff;font:500 13px/1 'DM Sans',sans-serif;cursor:pointer;transition:opacity .15s}
.btn-add-note:hover{opacity:.85}
.btn-add-note:active{transform:scale(.98);opacity:.8}
.btn-view-notes{padding:0;border:none;background:transparent;color:var(--t3);font:300 11.5px/1 'DM Sans',sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:2px;transition:color .15s}
.btn-view-notes:hover{color:var(--t2)}
.compose{margin-top:12px;width:100%;animation:fadeIn .15s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.compose textarea{width:100%;min-height:64px;padding:10px 12px;border:1.5px solid var(--bd);border-radius:10px;background:var(--card);color:var(--tx);font:300 16px/1.45 'DM Sans',sans-serif;resize:vertical;outline:none;transition:border-color .15s;-webkit-text-size-adjust:100%;text-size-adjust:100%;touch-action:manipulation}
.compose textarea:focus{border-color:var(--t2)}
.compose textarea::placeholder{color:var(--t3)}
.compose-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.dev-notes-section .btn-ghost{padding:6px 12px;border:none;border-radius:7px;background:transparent;color:var(--t2);font:400 12px/1 'DM Sans',sans-serif;cursor:pointer}
.dev-notes-section .btn-sm-p{padding:6px 14px;border:none;border-radius:7px;background:var(--tx);color:#fff;font:500 12px/1 'DM Sans',sans-serif;cursor:pointer}
.dev-notes-section .btn-sm-p:disabled{opacity:.3}
.past-notes{margin-top:8px;width:100%;animation:fadeIn .15s ease}
.past-item{padding:8px 0;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.past-item:last-child{border-bottom:none}
.past-content{flex:1;min-width:0}
.past-ts{font-size:10.5px;color:var(--t3);margin-bottom:2px}
.past-text{font-size:12.5px;line-height:1.4;color:var(--t2);white-space:pre-wrap;word-break:break-word}
.btn-del{flex-shrink:0;border:none;background:transparent;color:var(--t3);font-size:13px;cursor:pointer;padding:2px 4px;transition:color .12s}
.btn-del:hover{color:#D4785C}
@media(prefers-reduced-motion:reduce){.rem-toggle-pulse,.rem-toggle-knob,.rem-row{animation:none!important;transition:none!important}}
.ver-label{font-size:11px;color:var(--t3);text-align:center;margin-top:20px;font-weight:300}

@media(max-width:440px){.app{max-width:100%}.scr{padding:env(safe-area-inset-top) 16px 32px}}
/* ── step navigation ── */
.step-btns{display:flex;flex-direction:column;align-items:center;gap:8px}
.btn-skip{background:none;border:none;font:300 13px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer;padding:4px 12px;letter-spacing:.01em}
.g-entry .btn-skip{margin-bottom:calc(32px + env(safe-area-inset-bottom,0px))}
.btn-skip:hover{color:var(--t2)}
/* ── move to date ── */
.btn-move-date{width:100%;margin-top:8px;padding:11px;border-radius:var(--rs);border:1px solid var(--bd);background:transparent;font:400 13px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer;text-align:center;transition:all .15s}
.btn-move-date:hover{border-color:var(--t2);color:var(--t2)}

/* ── SRM bottom-edge tick on calendar cells ── */
.c-cal-ticks{position:absolute;bottom:4px;left:50%;z-index:2;display:flex;gap:3px;transform:translateX(-50%);pointer-events:none}
.c-srm-tick,.c-med-tick,.c-med-irregular-tick{width:4px;height:4px;border-radius:50%;background:var(--g-tx3);opacity:.65;filter:blur(.5px)}
.c-med-tick{background:var(--g-mood-mod-high);opacity:1;filter:none}
.c-med-irregular-tick{background:var(--g-warm-err)}

@media(prefers-reduced-motion:reduce){
  .g-welcome-cat,.g-welcome-sky,.g-wb,.g-welcome-cue,.cfdraw,.g-confirm .cfc,
  .g-bubble,.g-insights,.g-settings,.g-medications,.g-day,.g-home .cg,.g-home .cht,.page{animation:none!important}
  .g-welcome-bubbles{display:none}
}

.day-card-log-cta{margin-top:10px;width:100%;padding:10px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;text-align:center;transition:all .15s}
.day-card-log-cta:hover{border-color:var(--t3);color:var(--tx)}


`;
