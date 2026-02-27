import { useState, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, CartesianGrid, ReferenceLine, BarChart, Bar } from "recharts";

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG — Set your Google Sheets Web App URL here after deploying
   ═══════════════════════════════════════════════════════════════════════════ */
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbxqBSO_lSp43SH6MoLxrmhXDu5s1wC3gU_CZVtOIMtYQaxm3DVT1FmLGPdOY9K2XuHT/exec"; // paste your deployed Apps Script URL here

/* ── SYNC LAYER — sequential queue, one POST at a time ── */

const syncQueue=[];
let syncRunning=false;
let syncStatus={state:"idle",pending:0}; // "idle"|"syncing"|"done"|"error"
const syncListeners=new Set();
function notifySync(){syncListeners.forEach(fn=>fn({...syncStatus}));}

async function processQueue(){
  if(syncRunning||!syncQueue.length)return;
  syncRunning=true;
  while(syncQueue.length){
    syncStatus={state:"syncing",pending:syncQueue.length};notifySync();
    const job=syncQueue.shift();
    try{
      await fetch(SHEETS_URL,{
        method:"POST",mode:"no-cors",
        headers:{"Content-Type":"text/plain;charset=UTF-8"},
        body:JSON.stringify(job),
      });
      // Small delay between requests to avoid overwhelming Apps Script
      await new Promise(r=>setTimeout(r,300));
    }catch(e){console.warn("Sync:",e);}
  }
  syncRunning=false;
  syncStatus={state:"done",pending:0};notifySync();
  setTimeout(()=>{if(syncStatus.state==="done"){syncStatus={state:"idle",pending:0};notifySync();}},2000);
}

function enqueueSync(payload){
  if(!SHEETS_URL)return;
  syncQueue.push(payload);
  processQueue();
}

function pushMood(date, entry, medsArr){
  enqueueSync({type:"mood",date,entry,meds_ref:medsArr});
}
function pushSrm(date, items){
  enqueueSync({type:"srm",date,items});
}
function pushDeleteMood(date){
  enqueueSync({type:"delete_mood",date});
}
function pushDeleteSrm(date){
  enqueueSync({type:"delete_srm",date});
}

async function pullFromSheets(){
  if(!SHEETS_URL) return null;
  try{
    const res=await fetch(`${SHEETS_URL}?action=sync`,{method:"GET",cache:"no-store"});
    if(res&&res.ok) return await res.json();
  }catch{}
  // JSONP fallback
  try{
    const cb=`__mt_cb_${Date.now()}`;
    return await new Promise((resolve,reject)=>{
      const t=setTimeout(()=>{try{delete window[cb]}catch{};reject("timeout")},10000);
      window[cb]=(d)=>{clearTimeout(t);resolve(d);try{delete window[cb]}catch{};if(s&&s.parentNode)s.parentNode.removeChild(s);};
      var s=document.createElement("script");
      s.src=`${SHEETS_URL}?action=sync&callback=${cb}&_=${Date.now()}`;
      s.onerror=()=>{clearTimeout(t);try{delete window[cb]}catch{};if(s&&s.parentNode)s.parentNode.removeChild(s);reject("err");};
      document.body.appendChild(s);
    });
  }catch{ return null; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEED DATA
   ═══════════════════════════════════════════════════════════════════════════ */
const SEED_MOOD = {
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
  "2026-02-16":{items:[{id:"bed",time:"09:15",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"exercise",time:"03:30",am:false,didNot:false,withOthers:false,who:[],whoText:"",engagement:0}]},
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
  if(!SHEETS_URL)return null;
  if(st.state==="idle")return null;
  if(st.state==="done")return(<span className="sync-badge done">Synced</span>);
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
const WHO_OPTS=[{key:"spouse",label:"Spouse / Partner"},{key:"friend",label:"Friend"},{key:"family",label:"Family"},{key:"other",label:"Other"}];
const ENG_OPTS=[{v:1,label:"Just present"},{v:2,label:"Actively involved"},{v:3,label:"Very stimulating"}];
const SEV=[{v:0,l:"None"},{v:1,l:"Mild"},{v:2,l:"Moderate"},{v:3,l:"Severe"}];
const MO=["January","February","March","April","May","June","July","August","September","October","November","December"];
const DW=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const dk=(y,m,d)=>`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const dIn=(y,m)=>new Date(y,m+1,0).getDate();
const fDay=(y,m)=>new Date(y,m,1).getDay();
const tdk=()=>{const d=new Date();return dk(d.getFullYear(),d.getMonth(),d.getDate());};
const ydk=()=>{const d=new Date();d.setDate(d.getDate()-1);return dk(d.getFullYear(),d.getMonth(),d.getDate());};
const nowTime=()=>{const d=new Date();return`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;};
const isAMnow=()=>new Date().getHours()<12;
// Normalize time from various formats to "HH:MM"
const normTime=(v)=>{
  if(!v)return"";const s=String(v).trim();
  if(/^\d{1,2}:\d{2}$/.test(s))return s;
  // ISO "1899-12-30T19:29:00.000Z" or Date string
  if(s.includes("T")){try{const d=new Date(s);if(!isNaN(d))return`${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;}catch{}}
  // Long date string "Mon Jan 26 2026..." — extract time part
  const m=s.match(/(\d{1,2}):(\d{2}):\d{2}/);if(m)return`${m[1].padStart(2,"0")}:${m[2]}`;
  return s;
};
const GREETS=[n=>`Take it one moment at a time${n?", "+n:""}.`,n=>`No rush. You're here, and that's enough${n?", "+n:""}.`,n=>`A small step is still a step${n?", "+n:""}.`,n=>`Glad you're here${n?", "+n:""}.`,n=>`${n?n+", you":"You"} don't have to do this perfectly.`,n=>`Checking in takes courage${n?", "+n:""}.`,n=>`${n?n+", b":"B"}e gentle with yourself today.`,n=>`Ready when you are${n?", "+n:""}.`];

function loadJ(k,fb){try{const s=localStorage.getItem(k);return s?JSON.parse(s):fb;}catch{return fb;}}
function loadMood(){try{const s=localStorage.getItem("mt_mood");return s?{...SEED_MOOD,...JSON.parse(s)}:{...SEED_MOOD};}catch{return{...SEED_MOOD};}}
function saveMood(d){const u={};for(const k in d)if(!SEED_MOOD[k])u[k]=d[k];localStorage.setItem("mt_mood",JSON.stringify(u));}
function loadSRM(){try{const s=localStorage.getItem("mt_srm");return s?{...SEED_SRM,...JSON.parse(s)}:{...SEED_SRM};}catch{return{...SEED_SRM};}}
function saveSRM(d){const u={};for(const k in d)if(!SEED_SRM[k])u[k]=d[k];localStorage.setItem("mt_srm",JSON.stringify(u));}
function loadSet(){const s=loadJ("mt_set",{});if(!s.passcode)s.passcode="1234";if(!s.name)s.name="Wei";return s;}
function saveSet(s){localStorage.setItem("mt_set",JSON.stringify(s));}
function emptyItem(id){return{id,time:"",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0};}
function loadSnap(){try{const s=localStorage.getItem("mt_snap");return s?JSON.parse(s):{};}catch{return{};}}
function saveSnap(d){localStorage.setItem("mt_snap",JSON.stringify(d));}
function pushSnap(date,snap){enqueueSync({type:"snapshot",date,snap});}
function pushDeleteSnap(date,time){enqueueSync({type:"delete_snapshot",date,time});}
function pushSettings(settings,meds){enqueueSync({type:"settings",settings,meds});}

/* ═══════════════════════════════════════════════════════════════════════════
   APP — passcode ONLY after welcome
   ═══════════════════════════════════════════════════════════════════════════ */
export default function App(){
  const[screen,setScreen]=useState("welcome");
  const[mood,setMood]=useState(loadMood);
  const[srm,setSrm]=useState(loadSRM);
  const[settings,setSS]=useState(loadSet);
  const[meds,setMedsS]=useState(()=>loadJ("mt_meds",DEF_MEDS));
  const[vm,setVm]=useState(()=>{const d=new Date();return[d.getFullYear(),d.getMonth()];});
  const[selDay,setSelDay]=useState(null);
  const[srmEditId,setSrmEditId]=useState(null);
  const[srmDate,setSrmDate]=useState(tdk);
  const[snap,setSnap]=useState(loadSnap);
  const[snapEditIdx,setSnapEditIdx]=useState(null);
  const doSaveSnap=(date,snapEntry)=>{
    const n={...snap,[date]:[...(snap[date]||[]),snapEntry]};setSnap(n);saveSnap(n);pushSnap(date,snapEntry);
    // Extract weight from snapshot → save into mood data structure as weight-only entry
    if(snapEntry.weight!=null){
      const existing=mood[date]||null;
      // Only write weight if no real mood entry exists for this date, or update weight on existing
      if(!existing||existing._weightOnly){
        const we={...(existing||{}),weight:snapEntry.weight,mood:null,moods:[],_weightOnly:true};
        const nm={...mood,[date]:we};setMood(nm);saveMood(nm);
        pushMood(date,we,meds);
      } else {
        // Day already has real mood log — just update weight field silently
        const nm={...mood,[date]:{...existing,weight:snapEntry.weight}};setMood(nm);saveMood(nm);
        pushMood(date,nm[date],meds);
      }
    }
  };
  const doDeleteSnap=(date,idx)=>{const arr=[...(snap[date]||[])];const [removed]=arr.splice(idx,1);const n={...snap,[date]:arr};setSnap(n);saveSnap(n);if(removed?.time)pushDeleteSnap(date,removed.time);};
  const doUpdateSnap=(date,idx,updated)=>{const arr=[...(snap[date]||[])];const old=arr[idx];arr[idx]={...updated};const n={...snap,[date]:arr};setSnap(n);saveSnap(n);if(old?.time)pushDeleteSnap(date,old.time);pushSnap(date,updated);};
  // Pull from Google Sheets on app open (cross-device sync)
  useEffect(()=>{(async()=>{
    const resp=await pullFromSheets();
    if(!resp||resp.status!=="ok") return;
    const hasPushedSeed=localStorage.getItem("mt_seed_pushed");
    // Merge mood: remote wins, then push local-only entries ONCE
    if(resp.mood && typeof resp.mood==='object'){
      const local=loadMood();
      const remoteDates=new Set(Object.keys(resp.mood));
      let changed=false;
      for(const dt in resp.mood){
        const r=resp.mood[dt];
        const rMeds={};
        if(r.meds && typeof r.meds==='object'){
          for(const k in r.meds) if(r.meds[k]?.ct) rMeds[k]={ct:r.meds[k].ct};
        }
        local[dt]={mood:r.mood||null,mood2:r.mood2||null,sleep:r.sleep,anxiety:r.anxiety,
          irritability:r.irritability,weight:r.weight,notes:r.notes||"",meds:rMeds};
        changed=true;
      }
      if(changed){setMood({...local});saveMood(local);}
      // Push local-only entries ONCE (seed data)
      if(!hasPushedSeed){
        for(const dt in local){
          if(!remoteDates.has(dt) && (local[dt]?.mood || local[dt]?.sleep!=null)){
            pushMood(dt, local[dt], meds);
          }
        }
      }
    } else if(!hasPushedSeed) {
      const local=loadMood();
      for(const dt in local){
        if(local[dt]?.mood) pushMood(dt, local[dt], meds);
      }
    }
    // Merge SRM
    if(resp.srm && typeof resp.srm==='object'){
      const local=loadSRM();
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
      if(changed){setSrm({...local});saveSRM(local);}
      if(!hasPushedSeed){
        for(const dt in local){
          if(!remoteDates.has(dt)&&local[dt]?.items?.length) pushSrm(dt, local[dt].items);
        }
      }
    } else if(!hasPushedSeed) {
      const local=loadSRM();
      for(const dt in local){
        if(local[dt]?.items?.length) pushSrm(dt, local[dt].items);
      }
    }
    // Merge Snapshots — additive: remote array is authoritative per date
    if(resp.snap && typeof resp.snap==='object'){
      const local=loadSnap();
      let changed=false;
      for(const dt in resp.snap){
        const remoteSnaps=resp.snap[dt];
        if(!Array.isArray(remoteSnaps)||!remoteSnaps.length) continue;
        // Merge by time — remote entries win; local-only times are preserved
        const localSnaps=local[dt]||[];
        const remoteTimesSet=new Set(remoteSnaps.map(s=>s.time));
        const localOnly=localSnaps.filter(s=>!remoteTimesSet.has(s.time));
        local[dt]=[...remoteSnaps,...localOnly];
        changed=true;
      }
      if(changed){setSnap({...local});saveSnap(local);}
      // Push any local snap dates not on remote (first sync)
      if(!hasPushedSeed){
        const localSnap=loadSnap();
        const remoteDates=new Set(Object.keys(resp.snap||{}));
        for(const dt in localSnap){
          if(!remoteDates.has(dt)&&localSnap[dt]?.length){
            localSnap[dt].forEach(sn=>pushSnap(dt,sn));
          }
        }
      }
    } else if(!hasPushedSeed){
      const localSnap=loadSnap();
      for(const dt in localSnap){
        if(localSnap[dt]?.length) localSnap[dt].forEach(sn=>pushSnap(dt,sn));
      }
    }
    // Merge Settings — remote wins (allows device-to-device sync)
    if(resp.settings && typeof resp.settings==='object'){
      const rs=resp.settings;
      const cur=loadSet();
      // Only overwrite fields that are present in remote and non-empty
      const merged={...cur};
      if(rs.name) merged.name=rs.name;
      if(rs.passcode) merged.passcode=rs.passcode;
      if(Array.isArray(rs.reminders)) merged.reminders=rs.reminders;
      setSS(merged); saveSet(merged);
      if(resp.meds && Array.isArray(resp.meds) && resp.meds.length){
        setMedsS(resp.meds); localStorage.setItem("mt_meds",JSON.stringify(resp.meds));
      }
    }
    if(!hasPushedSeed) localStorage.setItem("mt_seed_pushed","1");
    // Always push current settings on first load to initialise remote
    if(!hasPushedSeed) pushSettings(loadSet(), loadJ("mt_meds", DEF_MEDS));
  })();},[]);
  // No periodic polling — sync happens on app open only.
  // Each device pushes entries on save, pulls on load.


  const setS=s=>{const n={...settings,...s};setSS(n);saveSet(n);pushSettings(n,meds);};
  const setMeds=m=>{setMedsS(m);localStorage.setItem("mt_meds",JSON.stringify(m));pushSettings(settings,m);};
  const name=settings.name||"";

  // Save mood: update local state + push ONLY this one entry to sheets
  const doSaveMood=(newMood, changedDate)=>{
    setMood(newMood); saveMood(newMood);
    if(changedDate && newMood[changedDate]){
      pushMood(changedDate, newMood[changedDate], meds);
    }
  };
  // Delete mood: remove locally + tell sheets to delete that row
  const doDeleteMood=(date)=>{
    const n={...mood}; delete n[date]; setMood(n); saveMood(n);
    pushDeleteMood(date);
  };
  const doMoveMood=(fromDate,toDate)=>{
    if(!fromDate||!toDate||fromDate===toDate) return;
    const entry=mood[fromDate]; if(!entry) return;
    const n={...mood};
    delete n[fromDate];
    n[toDate]={...entry};
    setMood(n); saveMood(n);
    pushDeleteMood(fromDate);
    pushMood(toDate, n[toDate], meds);
  };
  // Save SRM: update local state + push ONLY this date's items to sheets
  const doSaveSRM=(newSrm, changedDate)=>{
    setSrm(newSrm); saveSRM(newSrm);
    if(changedDate && newSrm[changedDate]){
      pushSrm(changedDate, newSrm[changedDate].items || []);
    }
  };
  // Delete SRM
  const doDeleteSrm=(date)=>{
    const n={...srm}; delete n[date]; setSrm(n); saveSRM(n);
    pushDeleteSrm(date);
  };

  return(<>
    <style>{CSS}</style>
    <div className="app"><div className="page" key={screen}>
      {screen==="welcome"&&<Welcome name={name} onGo={()=>settings.passcode?setScreen("lock"):setScreen("calendar")}/>}
      {screen==="lock"&&<Lock passcode={settings.passcode} onOk={()=>setScreen("calendar")}/>}
      {screen==="calendar"&&<Cal mood={mood} srm={srm} snap={snap} vm={vm} setVm={setVm} name={name} selDay={selDay} setSelDay={setSelDay} onAdd={()=>setScreen("entry")} onLogForDay={k=>{setSelDay(k);setScreen("calEntry");}} onSrm={()=>setScreen("srm")} onHist={()=>setScreen("history")} onSet={()=>setScreen("settings")} onViewDay={()=>setScreen("dayView")}/>}
      {screen==="dayView"&&<DayView dk={selDay} mood={mood} srm={srm} snap={snap} meds={meds} onBack={()=>setScreen("calendar")}
        onDelMood={()=>{doDeleteMood(selDay);setScreen("calendar");}}
        onDelSRM={()=>{doDeleteSrm(selDay);setScreen("calendar");}}
        onEditMood={()=>setScreen("editDayMood")}
        onEditSRM={id=>{setSrmEditId(id);setScreen("editDaySrm");}}
        onDelSnap={idx=>{doDeleteSnap(selDay,idx);}}
        onEditSnap={idx=>{setSnapEditIdx(idx);setScreen("editSnap");}}
        onLogMood={()=>setScreen("editDayMood")}/>}
      {screen==="editSnap"&&snapEditIdx!=null&&(()=>{
        const snaps=snap[selDay]||[];
        const sn=snaps[snapEditIdx];
        if(!sn) return null;
        return <SnapEditor snap={sn} onSave={updated=>{doUpdateSnap(selDay,snapEditIdx,updated);setScreen("dayView");}} onX={()=>setScreen("dayView")}/>;
      })()}
      {screen==="editDayMood"&&<MoodEntry mood={mood} meds={meds} editKey={selDay} onSave={e=>{doSaveMood({...mood,[selDay]:e},selDay);setScreen("dayView");}} onMoveMood={(to)=>{doMoveMood(selDay,to);setSelDay(to);setScreen("dayView");}} onX={()=>setScreen("dayView")}/>}
      {screen==="editDaySrm"&&<SRMSingle id={srmEditId} srm={srm} dateKey={selDay} onSave={item=>{const ex=srm[selDay]||{items:[]};const items=[...ex.items.filter(i=>i.id!==item.id),item];const ns={...srm,[selDay]:{items}};doSaveSRM(ns,selDay);setScreen("dayView");}} onX={()=>setScreen("dayView")}/>}
      {screen==="entry"&&<MoodEntry mood={mood} meds={meds} snap={snap} onSave={(e,k)=>{doSaveMood({...mood,[k]:e},k);setScreen("confirm");}} onSaveSnap={(s,k)=>{doSaveSnap(k,s);setScreen("confirmSnap");}} onX={()=>setScreen("calendar")}/>}
      {screen==="srm"&&<SRMPicker srm={srm} srmDate={srmDate} setSrmDate={setSrmDate} onPick={id=>{setSrmEditId(id);setScreen("srmEdit");}} onX={()=>setScreen("calendar")}/>}
      {screen==="srmEdit"&&<SRMSingle id={srmEditId} srm={srm} dateKey={srmDate} onSave={item=>{const k=srmDate;const ex=srm[k]||{items:[]};const items=[...ex.items.filter(i=>i.id!==item.id),item];const ns={...srm,[k]:{items}};doSaveSRM(ns,k);setScreen("srm");}} onX={()=>setScreen("srm")}/>}
      {screen==="confirm"&&<Confirm msg="Mood entry logged" sub="You showed up today. That matters." onDone={()=>setScreen("calendar")}/>}
      {screen==="confirmSnap"&&<Confirm msg="Snapshot saved" sub="Come back later to complete the full log." onDone={()=>setScreen("calendar")}/>}
      {screen==="blankDay"&&<BlankDayCard dateKey={selDay} snap={snap} onLogMood={()=>setScreen("calEntry")} onBack={()=>setScreen("calendar")}/>}
      {screen==="calEntry"&&<MoodEntry mood={mood} meds={meds} snap={snap} lockedDate={selDay} onSave={(e,k)=>{doSaveMood({...mood,[k]:e},k);setScreen("confirm");}} onSaveSnap={(s,k)=>{doSaveSnap(k,s);setScreen("confirmSnap");}} onX={()=>setScreen("calendar")}/>}
      {screen==="history"&&<Hist mood={mood} srm={srm} name={name} meds={meds} onBack={()=>setScreen("calendar")} onSendReport={()=>{if(!SHEETS_URL||!settings.reportEmail)return;const u=`${SHEETS_URL}?action=send_report&email=${encodeURIComponent(settings.reportEmail)}&name=${encodeURIComponent(settings.name||"")}`;fetch(u,{method:"GET",cache:"no-store"}).catch(()=>{});}} reportEmail={settings.reportEmail||""}/>}
      {screen==="settings"&&<Settings settings={settings} setS={setS} meds={meds} setMeds={setMeds} onBack={()=>setScreen("calendar")}/>}
    </div></div>
  </>);
}

/* ── WELCOME ── */
function Welcome({name,onGo}){
  const[greet]=useState(()=>GREETS[Math.floor(Math.random()*GREETS.length)](name));
  return(<div className="scr welcome">
    <div className="w-top">
      <div className="w-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><path className="w-draw" fill="none" stroke="currentColor" strokeWidth="4" d="M373.56,317.01c5.5,0,11.17,.86,16.48-.16,16.13-3.12,32.14-6.91,48.17-10.56,12.87-2.93,25.78-5.57,39.08-4.85,16.48,.9,30.11,6.89,37.72,22.56,5.23,10.77,5.09,22.07,2.21,33.42-4.25,16.73-13.72,30.36-25.84,42.25-17.73,17.4-39.19,28.49-62.49,36.39-1.42,.48-2.82,1-3.63,1.29,.92,8.27,2.11,16.12,2.55,24.02,.23,4.1-.46,8.36-1.39,12.4-5.16,22.46-26.53,32.03-46.85,21.04-12.04-6.51-21.28-16.25-29.97-26.57-3.1-3.68-6.12-7.44-8.89-11.38-1.43-2.03-2.94-2.57-5.34-2.55-18.49,.09-36.98,.02-55.47-.02-1.01,0-2.08,.09-3.03-.19-8.76-2.61-14.46,1.03-20.33,7.65-16.64,18.79-34.26,36.72-55,51.14-5.36,3.72-11.21,7.04-17.29,9.36-19.77,7.53-37.21-4.31-36.77-25.41,.18-8.83,2.02-17.95,4.88-26.33,4.28-12.53,10.13-24.52,15.32-36.74,.34-.8,.7-1.59,1.19-2.71-2.79-1.2-5.43-2.31-8.06-3.47-26.13-11.55-47.83-28.42-63.08-52.91-27.65-44.41-20.84-102.82,16.13-140.47,14.51-14.78,31.28-26.09,50.4-33.89,3.44-1.41,4.88-3.16,5.06-7.17,1.27-28.78,3.84-57.42,13.03-84.96,2.06-6.18,4.9-12.27,8.33-17.81,10.57-17.09,29.92-19.74,45.26-6.59,8.72,7.48,14.65,17.05,20.05,27.01,10.28,18.98,18.22,38.98,25.65,59.18,1.04,2.83,2.2,3.42,5.12,3.27,21.56-1.08,43.08-.51,64.51,2.29,5.78,.75,5.75,.84,8.39-4.55,9.72-19.8,19.61-39.53,33.54-56.81,3.87-4.8,8.21-9.41,13.06-13.17,18.73-14.52,40.16-9.17,50.27,12.28,5.89,12.48,8.98,25.78,11.24,39.3,3.15,18.84,3.81,37.82,2.52,56.85-.92,13.55-7.2,24.91-15.68,35.16-11.9,14.39-26.72,25.49-41.53,36.6-10.23,7.67-20.39,15.46-30.3,23.55-3.74,3.05-6.66,7.1-9.96,10.69l.75,1.57ZM215.49,103.87c-1.57,3.26-2.88,5.29-3.56,7.51-2.42,7.98-5.09,15.93-6.83,24.07-4.97,23.12-6.68,46.63-7.35,70.22-.24,8.45-3.98,13.99-12.05,16.95-12.88,4.72-25.18,10.63-36.27,18.87-21.54,16-35.72,36.67-38.67,63.69-3.6,32.9,9.43,59.04,34.66,79.56,13.97,11.36,30.25,18.32,47.22,23.82,8.31,2.69,12.94,9.14,11.44,17.23-.67,3.61-2.86,6.96-4.47,10.37-6.16,13.03-12.64,25.92-18.42,39.12-2.49,5.69-3.57,11.99-5.29,18.02,.35,.2,.71,.41,1.06,.61,1.3-.69,2.69-1.24,3.87-2.09,5.84-4.23,12.21-7.95,17.32-12.94,16.58-16.19,32.76-32.8,48.94-49.41,3.66-3.76,7.59-6.27,12.93-6.03,2.28,.11,4.54,.41,6.81,.66,24.13,2.69,48.34,3.61,72.47,.89,9.86-1.11,16.37,1.61,21.7,9.97,7.24,11.35,16.04,21.57,26.5,30.17,2.58,2.12,5.64,3.66,9.19,5.92,.64-3.32,1.32-5.74,1.55-8.2,1.24-12.97-3.88-23.88-11.83-33.5-13.13-15.9-30.19-25.99-49.72-32.11-19.69-6.17-39.55-6.6-59.66-2-8.67,1.98-16.08-3.33-17.7-11.87-1.43-7.55,3.83-14.79,12.11-16.58,16.49-3.56,33.13-4.65,49.87-2.33,34.23,4.75,63.63,18.88,86.52,45.31,1.44,1.66,2.66,1.92,4.55,1.23,6.41-2.36,12.95-4.39,19.26-7,17.67-7.3,33.65-17.13,45.82-32.25,6.44-8,11.27-16.83,12.49-27.26,.86-7.38-2.33-12.02-9.53-13.55-8.38-1.78-16.71-.54-24.87,1.29-16.05,3.59-31.96,7.83-48.02,11.36-12.54,2.75-25.29,4.45-38.09,1.9-11.93-2.37-21.22-8.28-24.71-20.79-2.6-9.33,.11-17.83,4.84-25.76,5.82-9.76,14.38-16.99,23.24-23.8,10.95-8.42,22.38-16.23,33.1-24.91,8.94-7.23,17.48-15.03,25.6-23.17,6.95-6.96,10.5-15.77,10.11-25.83-.5-12.65-.52-25.35-1.76-37.93-1.27-12.85-4.09-25.5-9.34-37.44-2.09-4.75-3.6-5.3-7.1-1.61-4.94,5.21-10.15,10.52-13.64,16.69-10.39,18.39-20.07,37.18-29.87,55.89-3.82,7.31-9.63,10.49-17.73,9.15-28.29-4.69-56.73-5.41-85.28-3.25-9.72,.74-15.36-2.69-18.75-11.74-3.77-10.07-7.43-20.19-11.46-30.16-6.51-16.08-13.28-32.07-22.83-46.66-2.23-3.41-5.15-6.36-8.4-10.3Z"/><path className="w-draw w-draw2" fill="none" stroke="currentColor" strokeWidth="4" d="M237.8,250.44c6.84-.03,13.42,1.44,19.32,4.79,2.78,1.58,4.34,.93,6.63-.65,14.6-10.05,29.85-10.97,45.43-2.45,6.72,3.67,11.66,9.32,15.21,16.06,4.06,7.7,1.65,15.98-5.59,19.99-6.94,3.85-15.14,1.41-19.59-5.84-4.31-7.01-11.23-9.26-17.6-5.2-2.14,1.37-4.01,3.88-4.96,6.28-2.43,6.17-6.64,9.91-13.12,10.58-6.37,.67-11.22-2.15-14.58-7.66-3.83-6.29-8.54-8.25-14.86-6.53-3.87,1.06-6.34,3.39-7.55,7.24-2.75,8.7-10.54,12.93-18.65,10.24-7.93-2.64-11.86-11.43-8.86-19.86,5.87-16.53,21.03-27.09,38.77-27.02Z"/></svg></div>
      <h1 className="w-t">Mood Tracker</h1>
      <p className="w-s">{greet}</p>
    </div>
    <div className="w-b"><button className="btn-p" onClick={onGo}>Continue</button></div>
  </div>);
}

/* ── LOCK — balanced keypad ── */
function Lock({passcode,onOk}){
  const[input,setInput]=useState("");const[err,setErr]=useState(false);const[shake,setShake]=useState(false);
  const tap=n=>{if(input.length>=4)return;const nx=input+n;setInput(nx);setErr(false);
    if(nx.length===4){if(nx===passcode)setTimeout(onOk,200);else{setShake(true);setErr(true);setTimeout(()=>{setInput("");setShake(false);},500);}}};
  return(<div className="scr lock-scr">
    <div className="lock-in">
      <div className="lock-ico">◑</div>
      <p className="lock-lbl">{err?"Incorrect passcode":"Enter passcode"}</p>
      <div className={`lock-dots${shake?" lock-shake":""}`}>{[0,1,2,3].map(i=><div key={i} className={`lock-dot${i<input.length?" on":""}`}/>)}</div>
      <div className="lock-pad">
        {[1,2,3,4,5,6,7,8,9].map((n)=>(
          <button key={n} className="lk" onClick={()=>tap(String(n))}>{n}</button>
        ))}
        <button className="lk lk-clear" onClick={()=>setInput("")} aria-label="Clear">C</button>
        <button className="lk" onClick={()=>tap("0")}>0</button>
        <button className="lk lk-del" onClick={()=>setInput(input.slice(0,-1))} aria-label="Delete">⌫</button>
      </div>
    </div>
  </div>);
}

/* ── CALENDAR ── */
function Cal({mood,srm,snap,vm,setVm,name,selDay,setSelDay,onAdd,onLogForDay,onSrm,onHist,onSet,onViewDay}){
  const[emptyDay,setEmptyDay]=useState(null);
  const[y,m]=vm;const days=dIn(y,m);const off=fDay(y,m);
  const now=new Date();const td=now.getFullYear()===y&&now.getMonth()===m?now.getDate():-1;
  const cells=[];
  for(let i=0;i<off;i++) cells.push(<div key={`b${i}`} className="cc ce"/>);
  for(let d=1;d<=days;d++){
    const k=dk(y,m,d);const e=mood[k];const s=srm[k];const hasSnap=(snap[k]||[]).length>0;
    const isT=d===td;const isSel=selDay===k;const hasData=e||s||hasSnap;
    const pm=primaryMood(e);const mc=pm?MM[pm]:null;
    cells.push(<div key={d} className={`cc${hasData?" cl":""}${isT?" ct":""}${isSel?" csel":""}`}
      onClick={()=>{
        if(hasData){setEmptyDay(null);setSelDay(isSel?null:k);}
        else{setSelDay(null);setEmptyDay(emptyDay===k?null:k);}
      }}>
      {mc&&<div className="cd" style={{background:mc.color,opacity:.18}}/>}
      {s&&<div className="c-srm-tick"/>}
      <span className="cn">{d}</span>
      {hasSnap&&<div className="c-snap-pip"/>}
    </div>);
  }
  let streak=0;const sd=new Date();
  for(let i=0;i<90;i++){const k=dk(sd.getFullYear(),sd.getMonth(),sd.getDate());const mk=mood[k];if((mk&&!mk._weightOnly)||srm[k]||(snap[k]||[]).length)streak++;else if(i>0)break;sd.setDate(sd.getDate()-1);}
  const gr=()=>{const h=now.getHours();return h<12?"Good morning":h<17?"Good afternoon":"Good evening";};
  const selMood=selDay?mood[selDay]:null;const selSrm=selDay?srm[selDay]:null;
  const selLabel=selDay?(()=>{const[sy,sm,sd]=selDay.split("-").map(Number);const dow=new Date(sy,sm-1,sd).getDay();return`${MO[sm-1].slice(0,3)} ${sd} · ${'Sun,Mon,Tue,Wed,Thu,Fri,Sat'.split(',')[dow]}`;})():"";

  return(<div className="scr">
    <div className="cal-top">
      <div><p className="cal-gr">{gr()}{name?`, ${name}`:""}</p><h2 className="cht">{MO[m]} {y} <SyncBadge/></h2></div>
      <div className="cal-tr"><button className="bi" onClick={onSet}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button><div className="cnav"><button className="bi" onClick={()=>setVm(m===0?[y-1,11]:[y,m-1])}>‹</button><button className="bi" onClick={()=>setVm(m===11?[y+1,0]:[y,m+1])}>›</button></div></div>
    </div>
    {streak>1&&<div className="streak">• {streak} day streak</div>}
    <div className="cg">{DW.map(d=><div key={d} className="clb">{d}</div>)}{cells}</div>
    <div className="cleg">{Object.entries(MM).map(([k,v])=>(<div key={k} className="cli"><div className="cld" style={{background:v.color}}/><span>{v.short}</span></div>))}</div>

    {(()=>{
      if(!selDay) return null;
      const selSnaps=(snap[selDay]||[]);
      const hasFullLog=selMood||selSrm;
      if(!hasFullLog&&!selSnaps.length) return null;
      return(
        <div className="day-card" onClick={onViewDay} style={{cursor:"pointer"}}>
          <div className="day-card-head">
            <span className="day-card-date">{selLabel}</span>
            <span className="day-card-arrow">View full log →</span>
          </div>
          {/* Full log mood */}
          {primaryMood(selMood)&&<div className="day-card-mood" style={{color:MM[primaryMood(selMood)].color}}>{moodLabel(selMood)}</div>}
          {selMood?.notes&&<div className="day-card-note">{selMood.notes}</div>}
          {(selMood?.sleep!=null||selMood?.anxiety!=null||selSrm)&&(
            <div className="day-chips" style={{marginBottom:selSnaps.length?8:0}}>
              {selMood?.sleep!=null&&<span className="day-chip">Sleep {selMood.sleep}h</span>}
              {selMood?.anxiety!=null&&selMood.anxiety>0&&<span className="day-chip">Anxiety {selMood.anxiety}/3</span>}
              {selSrm&&<span className="day-chip">{selSrm.items.filter(i=>!i.didNot).length} activities</span>}
            </div>
          )}
          {/* Snapshot rows */}
          {selSnaps.length>0&&(
            <div className="day-card-snaps">
              {selSnaps.map((sn,i)=>(
                <div key={i} className="day-card-snap-row">
                  <span className="day-card-snap-time">{sn.time}</span>
                  <span className="day-card-snap-mood" style={{color:MM[sn.moods?.[0]]?.color}}>
                    {sn.moods?.map(k=>MM[k]?.short||k).join(" / ")||"—"}
                  </span>
                  {sn.anxiety!=null&&sn.anxiety>0&&<span className="day-card-snap-sub">anxiety {sn.anxiety}/3</span>}
                  {sn.irritability!=null&&sn.irritability>0&&<span className="day-card-snap-sub">irritability {sn.irritability}/3</span>}
                </div>
              ))}
            </div>
          )}
          {/* CTA to log mood when no real mood entry yet */}
          {(!selMood||selMood._weightOnly)&&(selSrm||selSnaps.length>0)&&(
            <button className="day-card-log-cta" onClick={e=>{e.stopPropagation();onLogForDay(selDay);}}>
              Log mood for this day →
            </button>
          )}
        </div>
      );
    })()}

    {emptyDay&&(()=>{
      const[yr,mo,dy]=emptyDay.split("-").map(Number);
      const dow=new Date(yr,mo-1,dy).getDay();
      const lbl=`${MO[mo-1].slice(0,3)} ${dy} · ${'Sun,Mon,Tue,Wed,Thu,Fri,Sat'.split(',')[dow]}`;
      return(
        <div className="day-card" style={{animation:"si .2s var(--ease)"}}>
          <div className="day-card-head">
            <span className="day-card-date">{lbl}</span>
            <span className="day-card-arrow" style={{color:"var(--t3)"}}>No entries</span>
          </div>
          <button className="day-card-log-cta" style={{marginTop:4,width:"100%"}}
            onClick={()=>onLogForDay(emptyDay)}>
            Log mood for {lbl}
          </button>
        </div>
      );
    })()}
    <div className="cal-pad"/>
    <div className="cact">
      <button className="btn-p" onClick={onAdd}>Log Mood</button>
      <div className="cact-row">
        <button className="btn-rhythm" onClick={onSrm}>{srm[tdk()]?"Edit SRM":"SRM"}</button>
        <button className="btn-s" onClick={onHist}>Insights</button>
      </div>
    </div>
  </div>);
}

/* ── DAY VIEW — with edit and delete ── */
function DayView({dk:dateKey,mood,srm,snap,meds,onBack,onDelMood,onDelSRM,onEditMood,onEditSRM,onDelSnap,onEditSnap,onLogMood}){
  const[confirmDel,setConfirmDel]=useState(null);
  const[confirmSnapIdx,setConfirmSnapIdx]=useState(null);
  const e=mood[dateKey];const s=srm[dateKey];const snaps=(snap||{})[dateKey]||[];
  const[yr,mo,dy]=(dateKey||"2026-01-01").split("-").map(Number);
  const _dow=new Date(yr,mo-1,dy).getDay();
  const label=`${MO[mo-1]} ${dy}, ${yr} · ${'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'.split(',')[_dow]}`;
  return(<div className="scr">
    <div className="hh"><h2 className="ht">{label}</h2><button className="bi" onClick={onBack}>×</button></div>
    {!e&&onLogMood&&<button className="btn-p" style={{marginBottom:12,fontSize:13,padding:"11px 16px"}} onClick={onLogMood}>Log full day entry</button>}
    {e&&(<div className="card">
      <div className="dv-head"><h3 className="ctit">Mood Log</h3><div className="dv-acts"><button className="rr-edit" onClick={onEditMood}>Edit</button><button className="rr-edit" style={{color:"#D4785C"}} onClick={()=>setConfirmDel("mood")}>Delete</button></div></div>
      {confirmDel==="mood"&&<div className="dv-confirm"><span>Delete this mood entry?</span><button className="btn-sm-p" style={{background:"#D4785C"}} onClick={onDelMood}>Delete</button><button className="btn-ghost" onClick={()=>setConfirmDel(null)}>Cancel</button></div>}
      {primaryMood(e)&&<div className="dv-mood" style={{color:MM[primaryMood(e)].color}}>{moodLabel(e)}</div>}
      {e.sleep!=null&&<div className="dv-row">Sleep: {e.sleep} hrs</div>}
      {e.weight!=null&&<div className="dv-row">Weight: {e.weight} kg</div>}
      {e.anxiety!=null&&<div className="dv-row">Anxiety: {e.anxiety} / 3</div>}
      {e.irritability!=null&&<div className="dv-row">Irritability: {e.irritability} / 3</div>}
      {e.meds&&<div className="dv-row">Meds: {Object.entries(e.meds).filter(([,v])=>v.ct>0).map(([k,v])=>{const med=meds.find(m=>m.key===k);const d=v.dose||med?.dose;return`${med?.name||k}${d?` (${d})`:""} ×${v.ct}`;}).join(", ")}</div>}
      {e.notes&&<div className="dv-note">{e.notes}</div>}
    </div>)}
    {snaps.length>0&&(<div className="card">
      <h3 className="ctit">Snapshots</h3>
      {snaps.map((sn,i)=>(
        <div key={i} className="dv-snap-row">
          <div className="dv-snap-left">
            <span className="dv-snap-time">{sn.time}</span>
            <span className="dv-snap-mood" style={{color:MM[sn.moods?.[0]]?.color}}>
              {sn.moods?.map(k=>MM[k]?.short||k).join(" / ")||"—"}
            </span>
            {sn.anxiety!=null&&sn.anxiety>0&&<span className="dv-snap-meta">anxiety {sn.anxiety}/3</span>}
            {sn.irritability!=null&&sn.irritability>0&&<span className="dv-snap-meta">irritability {sn.irritability}/3</span>}
            {sn.notes&&<span className="dv-snap-note">{sn.notes}</span>}
          </div>
          <div className="dv-snap-acts">
            <button className="rr-edit" onClick={()=>onEditSnap(i)}>Edit</button>
            <button className="rr-edit" style={{color:"#D4785C"}} onClick={()=>setConfirmSnapIdx(i)}>Del</button>
          </div>
        </div>
      ))}
      {confirmSnapIdx!=null&&(
        <div className="dv-confirm" style={{marginTop:8}}>
          <span>Delete snapshot at {snaps[confirmSnapIdx]?.time}?</span>
          <button className="btn-sm-p" style={{background:"#D4785C"}} onClick={()=>{onDelSnap(confirmSnapIdx);setConfirmSnapIdx(null);}}>Delete</button>
          <button className="btn-ghost" onClick={()=>setConfirmSnapIdx(null)}>Cancel</button>
        </div>
      )}
    </div>)}
    {s&&(<div className="card">
      <div className="dv-head"><h3 className="ctit">SRM</h3><button className="rr-edit" style={{color:"#D4785C"}} onClick={()=>setConfirmDel("srm")}>Delete all</button></div>
      {confirmDel==="srm"&&<div className="dv-confirm"><span>Delete SRM log?</span><button className="btn-sm-p" style={{background:"#D4785C"}} onClick={onDelSRM}>Delete</button><button className="btn-ghost" onClick={()=>setConfirmDel(null)}>Cancel</button></div>}
      {s.items.map(it=>{const ac=SRM_ACT.find(a=>a.id===it.id)||{icon:"·",label:it.id};
        return(<div key={it.id} className="dv-srm-row">
          <div className="dv-srm-info"><span className="dv-srm-icon">{ac.icon}</span><span>{ac.label}</span></div>
          <div className="dv-srm-r">
            <span className="dv-srm-time">{it.didNot?"Skipped":it.time?(normTime(it.time)+" "+(it.am?"AM":"PM")):"—"}{it.withOthers?" · social":""}</span>
            <button className="rr-edit" onClick={()=>onEditSRM(it.id)}>Edit</button>
          </div>
        </div>);
      })}
    </div>)}
    {!e&&!snaps.length&&!s&&<p style={{color:"var(--t3)",fontSize:13,textAlign:"center",marginTop:40}}>No data for this day.</p>}
  </div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOOD ENTRY
   ═══════════════════════════════════════════════════════════════════════════ */
const MSTEPS=[{id:"mood",q:"How was your mood?",s:"Choose up to 2 (if it felt mixed)"},{id:"sleep",q:"Hours of sleep last night?",s:"Total hours, roughly"},{id:"anxiety",q:"Anxiety level?",s:"0 none · 1 mild · 2 moderate · 3 severe"},{id:"irritability",q:"Irritability level?",s:"0 none · 1 mild · 2 moderate · 3 severe"},{id:"meds",q:"Medications last night",s:"Pills taken yesterday evening / this morning"},{id:"weight",q:"Weight",s:"Optional daily check-in"},{id:"notes",q:"Anything to note?",s:"Optional — events, thoughts, anything"}];

/* ── MODE STEPS ── */
const MSTEPS_FULL=[
  {id:"mood",      q:{full:"How was your mood?",         now:"How are you feeling right now?"},  s:"Choose up to 2 (if it felt mixed)"},
  {id:"sleep",     q:{full:"Hours of sleep last night?",  now:null},                               s:"Total hours, roughly"},
  {id:"anxiety",   q:{full:"Anxiety level?",             now:"Anxiety right now?"},               s:"0 none · 1 mild · 2 moderate · 3 severe"},
  {id:"irritability",q:{full:"Irritability level?",     now:"Irritability right now?"},           s:"0 none · 1 mild · 2 moderate · 3 severe"},
  {id:"meds",      q:{full:"Medications last night",     now:null},                               s:"Pills taken yesterday evening / this morning"},
  {id:"weight",    q:{full:"Weight",                     now:"Weight check-in"},                  s:"Optional — syncs to your mood log"},
  {id:"notes",     q:{full:"Anything to note?",          now:"Anything to note?"},                s:"Optional — events, thoughts, anything"},
];
const SNAP_IDS=new Set(["mood","anxiety","irritability","weight","notes"]);

function MoodEntry({mood,meds,snap,editKey,lockedDate,onSave,onSaveSnap,onMoveMood,onX}){
  // mode: null=picker, "full"=full day, "now"=snapshot
  // lockedDate skips mode picker and forces full
  const[mode,setMode]=useState(editKey||lockedDate?"full":null);
  const initialKey=lockedDate||editKey||tdk();
  const[dateKey,setDateKey]=useState(initialKey);
  const targetKey=editKey||lockedDate||dateKey;

  const activeSteps=mode==="now"
    ? MSTEPS_FULL.filter(s=>SNAP_IDS.has(s.id))
    : MSTEPS_FULL;

  // Latest snapshot for this date (for reference + preselect)
  const daySnaps=(snap||{})[targetKey]||[];
  const latestSnap=daySnaps.length?daySnaps[daySnaps.length-1]:null;

  const makeDefault=()=>{
    const m={};meds.forEach(med=>{m[med.key]={ct:med.defaultCt??0};});
    // preselect mood from snapshot if present
    const preselect=latestSnap?.moods||[];
    return{moods:preselect,sleep:null,weight:null,anxiety:latestSnap?.anxiety??null,irritability:latestSnap?.irritability??null,meds:m,notes:""};
  };

  const[step,setStep]=useState(0);const[editIdx,setEditIdx]=useState(null);const[skippedSteps,setSkippedSteps]=useState(new Set());
  const[entry,setEntry]=useState(()=>{
    const t=mood[targetKey];
    if(t) return{...t,moods:moodsArr(t),meds:{...t.meds}};
    return makeDefault();
  });

  useEffect(()=>{
    if(editKey||lockedDate) return;
    const t=mood[targetKey];
    if(t) setEntry({...t,moods:moodsArr(t),meds:{...t.meds}});
    else setEntry(makeDefault());
  },[targetKey]); // eslint-disable-line

  const tot=activeSteps.length;
  const isR=editIdx===null&&step===tot;
  const prog=mode===null?0:((step+(isR?1:0))/(tot+1))*100;
  const upd=(k,v)=>setEntry(e=>({...e,[k]:v}));
  const updMC=(k,v,dose)=>setEntry(e=>({...e,meds:{...e.meds,[k]:{...e.meds[k],ct:Math.max(0,v),dose:dose||e.meds[k]?.dose}}}));
  const toggleMood=(key)=>{
    const cur=entry.moods||[];
    if(cur.includes(key)) upd("moods",cur.filter(k=>k!==key));
    else if(cur.length<2) upd("moods",[...cur,key]);
    else upd("moods",[cur[0],key]);
  };

  const renderStep=(si)=>{
    const st=activeSteps[si];const isEdit=editIdx!==null;
    const q=typeof st.q==="object"?st.q[mode]||st.q.full:st.q;
    return(<div className="qa" key={si+"-"+isEdit+"-"+mode}>
      <h2 className="qt">{q}</h2><p className="qs">{st.s}</p>

      {/* snapshot reference callout on mood step */}
      {st.id==="mood"&&latestSnap&&(
        <div className="snap-ref">
          <span className="snap-ref-label">Snapshot · {latestSnap.time}</span>
          <span className="snap-ref-val" style={{color:MM[latestSnap.moods?.[0]]?.color}}>
            {latestSnap.moods?.map(k=>MM[k]?.short||k).join(" / ")||"—"}
          </span>
          {latestSnap.anxiety!=null&&<span className="snap-ref-sub">anxiety {latestSnap.anxiety}/3</span>}
        </div>
      )}

      {st.id==="mood"&&(<div className="ol">{MOOD_OPTS.map(o=>{
        const sel=(entry.moods||[]).includes(o.key);const mc=MM[o.key];
        return(<button key={o.key} className={`oc${sel?" os":""}`} style={sel?{borderColor:mc.color,background:mc.bg}:{}} onClick={()=>toggleMood(o.key)}>
          <div className="ocl"><span className="oce">{o.icon}</span><div><div className="ocn">{o.label}</div><div className="ocd">{o.sub}</div></div></div>
          <div className={`or${sel?" orn":""}`} style={sel?{borderColor:mc.color,background:mc.color}:{}}>{sel&&"✓"}</div>
        </button>);
      })}</div>)}

      {st.id==="sleep"&&(<div className="np"><button className="br" onClick={()=>upd("sleep",entry.sleep==null?null:Math.max(0,entry.sleep-.5))} disabled={entry.sleep==null}>−</button><div className="nv">{entry.sleep==null?<span className="nb" style={{color:"var(--t3)",fontSize:32}}>—</span>:<><span className="nb">{entry.sleep}</span><span className="nu">hrs</span></>}</div><button className="br" onClick={()=>upd("sleep",entry.sleep==null?8:Math.min(24,entry.sleep+.5))}>+</button></div>)}
      {st.id==="weight"&&(<div className="wgt"><input className="wgi" type="number" inputMode="decimal" step="0.01" value={entry.weight??""} onChange={e=>upd("weight",e.target.value===""?null:Math.round(parseFloat(e.target.value)*100)/100)} placeholder="e.g. 68.45"/><div className="wgu">kg</div></div>)}
      {(st.id==="anxiety"||st.id==="irritability")&&(<div className="sg">{SEV.map(s=>{const sel=entry[st.id]===s.v;return(<button key={s.v} className={`sc${sel?" ss":""}`} onClick={()=>upd(st.id,s.v)}><span className="sn">{s.v}</span><span className="sl">{s.l}</span></button>);})}</div>)}
      {st.id==="meds"&&(<div className="ml">{meds.map(med=>{const me=entry.meds[med.key]||{ct:0};
        return(<div key={med.key} className={`mr${me.ct>0?" mo":""}`}><div className="mi"><div className="mn">{med.name}</div><div className="md-sub">{med.dose} / pill</div></div><div className="mc"><button className="bs" onClick={()=>updMC(med.key,me.ct-1)}>−</button><span className="mv">{me.ct}</span><button className="bs" onClick={()=>updMC(med.key,me.ct+1)}>+</button></div></div>);})}</div>)}
      {st.id==="notes"&&(<textarea className="ni" value={entry.notes||""} onChange={e=>upd("notes",e.target.value)} placeholder="Had a good walk today..." rows={4}/>)}

      <div className="step-btns">
        <button className={`btn-p en${(si===0&&!(entry.moods||[]).length)?" bd":""}`}
          onClick={()=>{if(isEdit)setEditIdx(null);else{const sid=activeSteps[si]?.id;setSkippedSteps(prev=>{const n=new Set(prev);n.delete(sid);return n;});setStep(Math.min(si+1,tot));}}}
          disabled={si===0&&!(entry.moods||[]).length}>
          {isEdit?"Done":si===tot-1?"Review":"Next"}
        </button>
        {si>0&&!isEdit&&<button className="btn-skip" onClick={()=>{const sid=activeSteps[si]?.id;setSkippedSteps(prev=>{const n=new Set(prev);n.add(sid);return n;});setStep(Math.min(si+1,tot));}}>skip</button>}
      </div>
    </div>);
  };

  // ── Mode picker ──
  if(mode===null){
    return(<div className="scr ent">
      <div className="et"><button className="bi" onClick={onX}>‹</button><span className="es">LOG MOOD</span><button className="btn-ghost" onClick={onX}>Cancel</button></div>
      <div className="pb"><div className="pf" style={{width:"0%"}}/></div>
      <div className="qa">
        <h2 className="qt">What are you logging?</h2>
        <p className="qs">Choose how you want to check in</p>
        <div className="mode-opts">
          <button className="mode-opt" onClick={()=>setMode("full")}>
            <div className="mode-opt-main">Full day log</div>
            <div className="mode-opt-sub">Mood, sleep, meds — the whole picture</div>
          </button>
          <button className="mode-opt" onClick={()=>{setMode("now");setDateKey(tdk());}}>
            <div className="mode-opt-main">Right now</div>
            <div className="mode-opt-sub">Quick snapshot of how you feel this moment</div>
          </button>
        </div>
      </div>
    </div>);
  }

  return(<div className="scr ent">
    <div className="et">
      <button className="bi" onClick={()=>{
        if(editIdx!==null)setEditIdx(null);
        else if(step>0)setStep(step-1);
        else if(!editKey&&!lockedDate)setMode(null);
        else onX();
      }}>‹</button>
      <span className="es">{isR?"Review":editIdx!==null?"Editing":mode==="now"?"Snapshot":`${(editIdx??step)+1} / ${tot}`}</span>
      <button className="btn-ghost" onClick={onX}>Cancel</button>
    </div>

    {!editKey&&!lockedDate&&editIdx===null&&(
      <div className="datebar">
        {mode==="now"
          ?<span className="datepill on">Today · now</span>
          :<>
            <button className={`datepill${dateKey===tdk()?" on":""}`} onClick={()=>setDateKey(tdk())}>Today</button>
            <button className={`datepill${dateKey===ydk()?" on":""}`} onClick={()=>setDateKey(ydk())}>Yesterday</button>
            <button className="datepick" onClick={()=>{const v=prompt("Enter date (YYYY-MM-DD)",dateKey);if(v&&/^\d{4}-\d{2}-\d{2}$/.test(v))setDateKey(v);}}>Pick</button>
            <span className="datecap">{new Date(dateKey+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</span>
          </>
        }
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
        <p className="qs">{new Date(targetKey+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}{mode==="now"?" · snapshot":""}</p>
        <div className="rc">
          <RvRow l="Mood" v={(entry.moods||[]).length?entry.moods.map((k,i)=>(<span key={k} style={{color:MM[k].color,fontWeight:500}}>{MM[k].label}{i<entry.moods.length-1?", ":""}</span>)):"—"} onEdit={()=>setEditIdx(0)}/>
          {mode==="full"&&<>
            <RvRow l="Sleep" v={entry.sleep!=null?`${entry.sleep} hrs`:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="sleep"))}/>
            <RvRow l="Weight" v={entry.weight!=null?`${entry.weight} kg`:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="weight"))}/>
            <RvRow l="Anxiety" v={entry.anxiety!=null?`${entry.anxiety}/3`:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="anxiety"))}/>
            <RvRow l="Irritability" v={entry.irritability!=null?`${entry.irritability}/3`:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="irritability"))}/>
            <RvRow l="Meds" v={Object.entries(entry.meds).filter(([,v])=>v.ct>0).map(([k,v])=>`${meds.find(m=>m.key===k)?.name||k} (${meds.find(m=>m.key===k)?.dose||""}) ×${v.ct}`).join(", ")||"None"} onEdit={()=>{setSkippedSteps(prev=>{const n=new Set(prev);n.delete("meds");return n;});setEditIdx(activeSteps.findIndex(s=>s.id==="meds"))}}/>
          </>}
          {mode==="now"&&<>
            <RvRow l="Anxiety" v={entry.anxiety!=null?`${entry.anxiety}/3`:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="anxiety"))}/>
            <RvRow l="Irritability" v={entry.irritability!=null?`${entry.irritability}/3`:"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="irritability"))}/>
          </>}
          <RvRow l="Notes" v={entry.notes||"—"} onEdit={()=>setEditIdx(activeSteps.findIndex(s=>s.id==="notes"))}/>
        </div>
        {mode==="now"
          ?<button className="btn-p" onClick={()=>onSaveSnap({...entry,time:nowTime(),moods:entry.moods},targetKey)}>Save Snapshot</button>
          :<>
            <button className="btn-p" onClick={()=>{const finalEntry={...entry};if(skippedSteps.has("meds")){const cleared={};Object.keys(finalEntry.meds||{}).forEach(k=>{cleared[k]={ct:0};});finalEntry.meds=cleared;}onSave(finalEntry,targetKey);}}>Confirm</button>
            {editKey&&onMoveMood&&<button className="btn-move-date" onClick={()=>{
              const v=prompt("Move entry to date (YYYY-MM-DD):",editKey);
              if(v&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v!==editKey){onMoveMood(v);}
            }}>Move to another date…</button>}
          </>
        }
      </div>
    ))}
  </div>);
}


/* ── BLANK DAY CARD — shown when tapping an empty calendar cell ── */
function BlankDayCard({dateKey,snap,onLogMood,onBack}){
  const[yr,mo,dy]=(dateKey||"2026-01-01").split("-").map(Number);
  const _dow=new Date(yr,mo-1,dy).getDay();
  const label=`${MO[mo-1]} ${dy}, ${yr} · ${'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'.split(',')[_dow]}`;
  const daySnaps=(snap||{})[dateKey]||[];
  return(<div className="scr">
    <div className="hh"><h2 className="ht">{label}</h2><button className="bi" onClick={onBack}>×</button></div>
    <div className="blank-day-card">
      <p className="blank-day-empty">No entries for this day</p>
      {daySnaps.length>0&&(
        <div className="blank-day-snaps">
          <p className="blank-day-snap-label">Snapshots</p>
          {daySnaps.map((sn,i)=>(
            <div key={i} className="blank-day-snap-row">
              <span className="blank-day-snap-time">{sn.time}</span>
              <span style={{color:MM[sn.moods?.[0]]?.color,fontWeight:500,fontSize:13}}>
                {sn.moods?.map(k=>MM[k]?.short||k).join(" / ")||"—"}
              </span>
              {sn.anxiety!=null&&<span className="blank-day-snap-sub">anxiety {sn.anxiety}/3</span>}
            </div>
          ))}
        </div>
      )}
    </div>
    <div style={{marginTop:16}}>
      <button className="btn-p" onClick={onLogMood}>Log mood for {label}</button>
    </div>
  </div>);
}


/* ── SNAP EDITOR — edit a single snapshot (mood/anxiety/irritability/notes) ── */
function SnapEditor({snap:sn,onSave,onX}){
  const[entry,setEntry]=useState({
    moods:sn.moods||[],
    anxiety:sn.anxiety??1,
    irritability:sn.irritability??1,
    notes:sn.notes||"",
    time:sn.time||nowTime()
  });
  const upd=(k,v)=>setEntry(e=>({...e,[k]:v}));
  const toggleMood=(key)=>{
    const cur=entry.moods||[];
    if(cur.includes(key)) upd("moods",cur.filter(k=>k!==key));
    else if(cur.length<2) upd("moods",[...cur,key]);
    else upd("moods",[cur[0],key]);
  };
  return(<div className="scr ent">
    <div className="et">
      <button className="bi" onClick={onX}>‹</button>
      <span className="es">Edit Snapshot · {sn.time}</span>
      <button className="btn-ghost" onClick={onX}>Cancel</button>
    </div>
    <div className="pb"><div className="pf" style={{width:"100%"}}/></div>
    <div className="qa">
      <h2 className="qt">How were you feeling?</h2>
      <p className="qs">Snapshot from {sn.time}</p>
      <div className="ol">{MOOD_OPTS.map(o=>{
        const sel=(entry.moods||[]).includes(o.key);const mc=MM[o.key];
        return(<button key={o.key} className={`oc${sel?" os":""}`} style={sel?{borderColor:mc.color,background:mc.bg}:{}} onClick={()=>toggleMood(o.key)}>
          <div className="ocl"><span className="oce">{o.icon}</span><div><div className="ocn">{o.label}</div><div className="ocd">{o.sub}</div></div></div>
          <div className={`or${sel?" orn":""}`} style={sel?{borderColor:mc.color,background:mc.color}:{}}>{sel&&"✓"}</div>
        </button>);
      })}</div>
      <h2 className="qt" style={{marginTop:24}}>Anxiety</h2>
      <div className="sg" style={{marginBottom:24}}>{SEV.map(s=>{const sel=entry.anxiety===s.v;return(<button key={s.v} className={`sc${sel?" ss":""}`} onClick={()=>upd("anxiety",s.v)}><span className="sn">{s.v}</span><span className="sl">{s.l}</span></button>);})}</div>
      <h2 className="qt">Irritability</h2>
      <div className="sg" style={{marginBottom:24}}>{SEV.map(s=>{const sel=entry.irritability===s.v;return(<button key={s.v} className={`sc${sel?" ss":""}`} onClick={()=>upd("irritability",s.v)}><span className="sn">{s.v}</span><span className="sl">{s.l}</span></button>);})}</div>
      <h2 className="qt">Notes</h2>
      <textarea className="ni" value={entry.notes} onChange={e=>upd("notes",e.target.value)} placeholder="Optional" rows={3} style={{marginBottom:16}}/>
      <button className={`btn-p${!(entry.moods||[]).length?" bd":""}`} disabled={!(entry.moods||[]).length}
        onClick={()=>onSave({...entry,time:sn.time})}>
        Save Changes
      </button>
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

  return(<div className="scr">
    <div className="hh"><h2 className="ht">SRM</h2><button className="bi" onClick={onX}>×</button></div>
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

  return(<div className="scr ent">
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
  return(<div className="scr cfs"><div className="cfi">
    <div className="cfc"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M14 25L21 32L34 18" stroke="#7BA08B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><animate attributeName="stroke-dasharray" from="0 50" to="50 50" dur="0.5s" fill="freeze"/></path></svg></div>
    <h2 className="cft">{msg}</h2><p className="cfp">{sub}</p>
  </div></div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORY — export includes SRM, notes newest first
   ═══════════════════════════════════════════════════════════════════════════ */
function Hist({mood,srm,name,meds,onBack,onSendReport,reportEmail}){
  const sorted=Object.entries(mood).filter(([k,e])=>{
    if(!e||typeof e!=='object') return false;
    if(!k||!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
    return e.mood||e.mood2||(Array.isArray(e.moods)&&e.moods.length)||e.sleep!=null||e.anxiety!=null||e.weight!=null;
  }).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,e])=>{const[y,m,d]=k.split("-").map(Number);return{key:k,day:d,month:m,year:y,label:`${MO[m-1]?.slice(0,3)||"?"} ${d}`,sl:`${m}/${d}`,...e,mv:moodValue(e)};});
  const wM=sorted.filter(e=>e.mv!=null);const wS=sorted.filter(e=>e.sleep!=null);const wA=sorted.filter(e=>e.anxiety!=null);
  const avg=a=>a.length?(a.reduce((s,x)=>s+x,0)/a.length):null;
  const moodData=wM.map(e=>({n:e.sl,mood:e.mv,f:e.label}));
  const comboData=sorted.filter(e=>e.sleep!=null||e.anxiety!=null||e.irritability!=null).map(e=>({n:e.sl,sleep:e.sleep,anxiety:e.anxiety,irritability:e.irritability,f:e.label}));
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
  const srmSorted=Object.entries(srm).sort(([a],[b])=>a.localeCompare(b));
  const srmSocial=srmSorted.map(([k,v])=>{
    const[,m,d]=k.split("-").map(Number);
    const done=(v.items||[]).filter(i=>!i.didNot);
    const socialActs=done.filter(i=>i.withOthers);
    const score=socialActs.reduce((acc,i)=>acc+(i.engagement||1),0);
    const count=socialActs.length;
    return{name:`${m}/${d}`,score,count,total:done.length,f:`${MO[m-1].slice(0,3)} ${d}`};
  });
  const srmTimes=srmSorted.map(([k,v])=>{const[,m,d]=k.split("-").map(Number);const out={name:`${m}/${d}`};(v.items||[]).forEach(item=>{if(item.time&&!item.didNot){const[h,mi]=(item.time||"0:0").split(":").map(Number);const tot=item.am?(h*60+mi):((h===12?12:h+12)*60+mi);out[item.id]=tot/60;}});return out;});

  const MTT=({active,payload})=>{try{if(!active||!payload?.length)return null;const d=payload[0]?.payload;if(!d)return null;const mk=Object.entries(MM).find(([,v])=>v.v===d.mood);return(<div className="tt"><div className="ttd">{d.f||""}</div>{mk&&<div style={{color:mk[1].color}}>{mk[1].label}</div>}</div>);}catch{return null;}};
  const CTT=({active,payload})=>{try{if(!active||!payload?.length)return null;const d=payload[0]?.payload;if(!d)return null;return(<div className="tt"><div className="ttd">{d.f||""}</div>{d.sleep!=null&&<div>Sleep: {d.sleep}h</div>}{d.anxiety!=null&&<div>Anxiety: {d.anxiety}/3</div>}{d.irritability!=null&&<div>Irritability: {d.irritability}/3</div>}</div>);}catch{return null;}};
  const fmtH=v=>{const h=Math.floor(v);return`${h>12?h-12:h||12}${h>=12?"pm":"am"}`;};

  const exCSV=()=>{
    let csv="Date,Mood,Sleep,Weight,Anxiety,Irritability,Medications,Notes,Rhythm Activities\n";
    const allDates=new Set([...Object.keys(mood),...Object.keys(srm)]);
    [...allDates].sort().forEach(k=>{
      const e=mood[k];const s=srm[k];
      const ms=e?.meds?Object.entries(e.meds).filter(([,v])=>v.ct>0).map(([k2,v])=>`${k2}:${v.ct}`).join("; "):"";
      const rhythm=s?.items?s.items.filter(i=>!i.didNot).map(i=>`${i.id}:${normTime(i.time)||"?"}${i.am?"AM":"PM"}`).join("; "):"";
      csv+=`${k},${moodKeyString(e)},${e?.sleep??""},${e?.weight??""},${e?.anxiety??""},${e?.irritability??""},"${ms}","${(e?.notes||"").replace(/"/g,'""')}","${rhythm}"\n`;
    });
    const b=new Blob([csv],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`mood-rhythm-${tdk()}.csv`;a.click();
  };

  return(<div className="scr">
    <div className="hh"><h2 className="ht">{name?`${name}'s `:""}{sorted.length>0?"Insights":"Insights"}</h2><div className="ha"><button className="bx" onClick={exCSV}>↓ Export</button><button className="bi" onClick={onBack}>×</button></div></div>
    {sorted.length===0&&<div className="card" style={{textAlign:"center",padding:"40px 20px"}}><p style={{color:"var(--t2)",fontSize:14,lineHeight:1.6}}>No mood data yet. Log your first mood entry to see insights here.</p></div>}
    {sorted.length>0&&<div className="sr">
      <div className="sb"><div className="sv">{sorted.length}</div><div className="sbl">Days</div></div>
      <div className="sb"><div className="sv">{avg(wS.map(e=>e.sleep))?.toFixed(1)??"—"}</div><div className="sbl">Avg Sleep</div></div>
      <div className="sb"><div className="sv">{avg(wA.map(e=>e.anxiety))?.toFixed(1)??"—"}</div><div className="sbl">Avg Anxiety</div></div>
    </div>}

    {moodData.length>0&&<div className="card"><h3 className="ctit">Mood</h3><div className="cw"><ResponsiveContainer width="100%" height={180}><AreaChart data={moodData} margin={{top:8,right:8,left:-24,bottom:4}}>
      <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#D4785C" stopOpacity={.12}/><stop offset="50%" stopColor="#7BA08B" stopOpacity={.06}/><stop offset="100%" stopColor="#5A5F8A" stopOpacity={.15}/></linearGradient></defs>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/>
      <YAxis domain={[-3,3]} ticks={[-3,-2,-1,0,1,2,3]} tick={{fontSize:8,fill:"#9E9790"}} tickFormatter={v=>({3:"Sev↑",2:"Mod↑",1:"Mild↑",0:"OK","-1":"Mild↓","-2":"Mod↓","-3":"Sev↓"}[v]||v)}/>
      <ReferenceLine y={0} stroke="#7BA08B" strokeDasharray="4 4" strokeOpacity={.4}/><Tooltip content={<MTT/>}/>
      <Area type="monotone" dataKey="mood" stroke="#6478A0" strokeWidth={2} fill="url(#mg)" dot={{r:2.5,fill:"#6478A0",strokeWidth:0}} activeDot={{r:4}} connectNulls/>
    </AreaChart></ResponsiveContainer></div></div>}

    {comboData.length>0&&<div className="card"><h3 className="ctit">Sleep · Anxiety · Irritability</h3><div className="cw"><ResponsiveContainer width="100%" height={150}><LineChart data={comboData} margin={{top:8,right:8,left:-24,bottom:4}}>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/><YAxis tick={{fontSize:10,fill:"#9E9790"}}/>
      <Tooltip content={<CTT/>}/>
      <Line type="monotone" dataKey="sleep" stroke="#7BA08B" strokeWidth={1.5} dot={{r:2,fill:"#7BA08B",strokeWidth:0}} connectNulls name="Sleep"/>
      <Line type="monotone" dataKey="anxiety" stroke="#D4785C" strokeWidth={1.5} dot={{r:2,fill:"#D4785C",strokeWidth:0}} connectNulls strokeDasharray="4 2" name="Anxiety"/>
      <Line type="monotone" dataKey="irritability" stroke="#C9B07A" strokeWidth={1.5} dot={{r:2,fill:"#C9B07A",strokeWidth:0}} connectNulls strokeDasharray="2 3" name="Irritability"/>
    </LineChart></ResponsiveContainer></div><div className="cleg2"><span><span className="ll" style={{background:"#7BA08B"}}/> Sleep</span><span><span className="ll" style={{background:"#D4785C"}}/> Anxiety</span><span><span className="ll" style={{background:"#C9B07A"}}/> Irritability</span></div></div>}

    

    {weightData.length>0&&<div className="card"><div className="whead"><h3 className="ctit">Weight</h3>{weightStats&&<div className="wstat"><div className="wsv">{weightStats.lastW} kg</div><div className="wsd">{weightStats.delta==null?"":(weightStats.delta>=0?`+${weightStats.delta.toFixed(1)}`:weightStats.delta.toFixed(1))}{weightStats.delta==null?"":" in ~7 entries"}</div></div>}</div><div className="cw"><ResponsiveContainer width="100%" height={140}><AreaChart data={weightData} margin={{top:8,right:8,left:-24,bottom:4}}>
      <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6478A0" stopOpacity={.15}/><stop offset="100%" stopColor="#6478A0" stopOpacity={.02}/></linearGradient></defs>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/><YAxis tick={{fontSize:10,fill:"#9E9790"}} domain={["dataMin-2","dataMax+2"]}/>
      <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0].payload;return(<div className="tt"><div className="ttd">{d.f}</div><div>Weight: {d.weight} kg</div></div>);}}/>
      <Area type="monotone" dataKey="weight" stroke="#6478A0" strokeWidth={2} fill="url(#wg)" dot={{r:2.5,fill:"#6478A0",strokeWidth:0}} activeDot={{r:4}} connectNulls/>
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
        <Line type="monotone" dataKey="score" stroke="#7E9AB3" strokeWidth={2} dot={{r:3,fill:"#7E9AB3",strokeWidth:0}} activeDot={{r:4}} connectNulls name="Social score"/>
      </LineChart></ResponsiveContainer></div>
      <div className="cleg2"><span style={{fontSize:11,color:"var(--t3)"}}>1 = just present · 2 = actively involved · 3 = very stimulating</span></div>
    </div>}

    {/* ── Activity stability: Morning anchors ── */}
    {srmTimes.length>0&&srmTimes.some(d=>d.bed||d.beverage||d.breakfast)&&<div className="card">
      <h3 className="ctit">Morning Rhythm</h3>
      <p className="card-sub">Wake-up, morning beverage, breakfast times</p>
      <div className="cw"><ResponsiveContainer width="100%" height={140}><LineChart data={srmTimes} margin={{top:8,right:8,left:-24,bottom:4}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/>
        <XAxis dataKey="name" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/>
        <YAxis tick={{fontSize:10,fill:"#9E9790"}} tickFormatter={fmtH} domain={["auto","auto"]}/>
        <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;return(<div className="tt">{payload.filter(p=>p.value!=null).map((p,i)=>(<div key={i} style={{color:p.stroke}}>{p.name}: {fmtH(p.value)}</div>))}</div>);}}/>
        {srmTimes.some(d=>d.bed)&&<Line type="monotone" dataKey="bed" stroke="#7E9AB3" strokeWidth={1.5} dot={{r:2,fill:"#7E9AB3",strokeWidth:0}} connectNulls name="Wake up"/>}
        {srmTimes.some(d=>d.beverage)&&<Line type="monotone" dataKey="beverage" stroke="#C9B07A" strokeWidth={1.5} dot={{r:2,fill:"#C9B07A",strokeWidth:0}} connectNulls name="Beverage"/>}
        {srmTimes.some(d=>d.breakfast)&&<Line type="monotone" dataKey="breakfast" stroke="#D49A6A" strokeWidth={1.5} dot={{r:2,fill:"#D49A6A",strokeWidth:0}} connectNulls name="Breakfast"/>}
      </LineChart></ResponsiveContainer></div>
      <div className="cleg2" style={{flexWrap:"wrap"}}>
        {srmTimes.some(d=>d.bed)&&<span><span className="ll" style={{background:"#7E9AB3"}}/> Wake</span>}
        {srmTimes.some(d=>d.beverage)&&<span><span className="ll" style={{background:"#C9B07A"}}/> Beverage</span>}
        {srmTimes.some(d=>d.breakfast)&&<span><span className="ll" style={{background:"#D49A6A"}}/> Breakfast</span>}
      </div>
    </div>}

    {/* ── Activity stability: Daytime ── */}
    {srmTimes.length>0&&srmTimes.some(d=>d.outside||d.work||d.exercise||d.lunch)&&<div className="card">
      <h3 className="ctit">Daytime Rhythm</h3>
      <p className="card-sub">Outside, work, exercise, lunch times</p>
      <div className="cw"><ResponsiveContainer width="100%" height={140}><LineChart data={srmTimes} margin={{top:8,right:8,left:-24,bottom:4}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/>
        <XAxis dataKey="name" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/>
        <YAxis tick={{fontSize:10,fill:"#9E9790"}} tickFormatter={fmtH} domain={["auto","auto"]}/>
        <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;return(<div className="tt">{payload.filter(p=>p.value!=null).map((p,i)=>(<div key={i} style={{color:p.stroke}}>{p.name}: {fmtH(p.value)}</div>))}</div>);}}/>
        {srmTimes.some(d=>d.outside)&&<Line type="monotone" dataKey="outside" stroke="#7BA08B" strokeWidth={1.5} dot={{r:2,fill:"#7BA08B",strokeWidth:0}} connectNulls name="Outside"/>}
        {srmTimes.some(d=>d.work)&&<Line type="monotone" dataKey="work" stroke="#C9B07A" strokeWidth={1.5} dot={{r:2,fill:"#C9B07A",strokeWidth:0}} connectNulls name="Work"/>}
        {srmTimes.some(d=>d.exercise)&&<Line type="monotone" dataKey="exercise" stroke="#D49A6A" strokeWidth={1.5} dot={{r:2,fill:"#D49A6A",strokeWidth:0}} connectNulls name="Work out"/>}
        {srmTimes.some(d=>d.lunch)&&<Line type="monotone" dataKey="lunch" stroke="#A89CC8" strokeWidth={1.5} dot={{r:2,fill:"#A89CC8",strokeWidth:0}} connectNulls name="Lunch"/>}
      </LineChart></ResponsiveContainer></div>
      <div className="cleg2" style={{flexWrap:"wrap"}}>
        {srmTimes.some(d=>d.outside)&&<span><span className="ll" style={{background:"#7BA08B"}}/> Outside</span>}
        {srmTimes.some(d=>d.work)&&<span><span className="ll" style={{background:"#C9B07A"}}/> Work</span>}
        {srmTimes.some(d=>d.exercise)&&<span><span className="ll" style={{background:"#D49A6A"}}/> Work out</span>}
        {srmTimes.some(d=>d.lunch)&&<span><span className="ll" style={{background:"#A89CC8"}}/> Lunch</span>}
      </div>
    </div>}

    {/* ── Activity stability: Evening anchors ── */}
    {srmTimes.length>0&&srmTimes.some(d=>d.dinner||d.home||d.bedtime)&&<div className="card">
      <h3 className="ctit">Evening Rhythm</h3>
      <p className="card-sub">Dinner, home return, bed time</p>
      <div className="cw"><ResponsiveContainer width="100%" height={140}><LineChart data={srmTimes} margin={{top:8,right:8,left:-24,bottom:4}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/>
        <XAxis dataKey="name" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/>
        <YAxis tick={{fontSize:10,fill:"#9E9790"}} tickFormatter={fmtH} domain={["auto","auto"]}/>
        <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;return(<div className="tt">{payload.filter(p=>p.value!=null).map((p,i)=>(<div key={i} style={{color:p.stroke}}>{p.name}: {fmtH(p.value)}</div>))}</div>);}}/>
        {srmTimes.some(d=>d.dinner)&&<Line type="monotone" dataKey="dinner" stroke="#D49A6A" strokeWidth={1.5} dot={{r:2,fill:"#D49A6A",strokeWidth:0}} connectNulls name="Dinner"/>}
        {srmTimes.some(d=>d.home)&&<Line type="monotone" dataKey="home" stroke="#7BA08B" strokeWidth={1.5} dot={{r:2,fill:"#7BA08B",strokeWidth:0}} connectNulls name="Home"/>}
        {srmTimes.some(d=>d.bedtime)&&<Line type="monotone" dataKey="bedtime" stroke="#5A5F8A" strokeWidth={1.5} dot={{r:2,fill:"#5A5F8A",strokeWidth:0}} connectNulls name="Bed time"/>}
      </LineChart></ResponsiveContainer></div>
      <div className="cleg2" style={{flexWrap:"wrap"}}>
        {srmTimes.some(d=>d.dinner)&&<span><span className="ll" style={{background:"#D49A6A"}}/> Dinner</span>}
        {srmTimes.some(d=>d.home)&&<span><span className="ll" style={{background:"#7BA08B"}}/> Home</span>}
        {srmTimes.some(d=>d.bedtime)&&<span><span className="ll" style={{background:"#5A5F8A"}}/> Bed time</span>}
      </div>
    </div>}

    {notes.length>0&&<div className="card"><h3 className="ctit">Journal Notes</h3><div className="nl">{notes.map(n=>(<div key={n.key} className="nr"><div className="nd">{n.label}</div><div className="nt">{n.notes}</div></div>))}</div></div>}
    {onSendReport&&<div className="card" style={{textAlign:"center"}}>
      <p style={{fontSize:12,color:"var(--t3)",marginBottom:10,fontWeight:300}}>{reportEmail?"Weekly report will also auto-send every Sunday.":"Set your email in Settings to enable weekly reports."}</p>
      <button className="btn-s" style={{fontSize:13,padding:"11px 16px",width:"100%",opacity:reportEmail?1:.5}} onClick={reportEmail?onSendReport:undefined} disabled={!reportEmail}>{reportEmail?"Send this week's report":"Configure email in Settings"}</button>
    </div>}
    <div style={{height:40}}/>
  </div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════════════════════════ */
function Settings({settings,setS,meds,setMeds,onBack}){
  const[nameVal,setNameVal]=useState(settings.name||"");
  const[nameSaved,setNameSaved]=useState(false);
  const[pcStep,setPcStep]=useState(null);const[pc1,setPc1]=useState("");const[pc2,setPc2]=useState("");
  const[editMedIdx,setEditMedIdx]=useState(null);const[emName,setEmName]=useState("");const[emDose,setEmDose]=useState("");const[emDefaultCt,setEmDefaultCt]=useState(0);
  const[showAddMed,setShowAddMed]=useState(false);const[newMedName,setNewMedName]=useState("");const[newMedDose,setNewMedDose]=useState("");const[newMedCt,setNewMedCt]=useState(1);
  const[reminders,setReminders]=useState(settings.reminders||[]);
  const[showAddR,setShowAddR]=useState(false);const[newRT,setNewRT]=useState("21:00");const[newRL,setNewRL]=useState("Log mood");
  const[emailVal,setEmailVal]=useState(settings.reportEmail||"");const[emailSaved,setEmailSaved]=useState(false);const[reportSending,setReportSending]=useState(false);const[reportMsg,setReportMsg]=useState("");
  const saveEmail=()=>{setS({reportEmail:emailVal.trim()});setEmailSaved(true);setTimeout(()=>setEmailSaved(false),2500);};
  const sendReport=async()=>{
    if(!SHEETS_URL||!settings.reportEmail){setReportMsg("Set email address first");return;}
    setReportSending(true);setReportMsg("");
    try{
      const u=`${SHEETS_URL}?action=send_report&email=${encodeURIComponent(settings.reportEmail)}&name=${encodeURIComponent(settings.name||"")}`;
      const res=await fetch(u,{method:"GET",cache:"no-store"});
      const data=await res.json().catch(()=>({}));
      if(data.status==="ok") setReportMsg("Report sent! Check your inbox.");
      else setReportMsg("Error: "+(data.message||"unknown"));
    }catch(e){setReportMsg("Could not send. Try again.");}
    setReportSending(false);setTimeout(()=>setReportMsg(""),5000);
  };

  const saveName=()=>{setS({name:nameVal.trim()});setNameSaved(true);setTimeout(()=>setNameSaved(false),2500);};
  const curPc=pcStep==="new"?pc1:pc2;
  const pcTap=n=>{if(pcStep==="new"){const nx=pc1+n;setPc1(nx);if(nx.length===4)setTimeout(()=>setPcStep("confirm"),200);}else if(pcStep==="confirm"){const nx=pc2+n;setPc2(nx);if(nx.length===4){if(nx===pc1){setS({passcode:nx});setPcStep(null);}else setPc2("");}}};
  const pcDel=()=>{if(pcStep==="new")setPc1(pc1.slice(0,-1));else setPc2(pc2.slice(0,-1));};
  const pcClear=()=>{if(pcStep==="new")setPc1("");else setPc2("");};
  const startEditMed=i=>{setEditMedIdx(i);setEmName(meds[i].name);setEmDose(meds[i].dose);setEmDefaultCt(meds[i].defaultCt??0);};
  const saveEditMed=()=>{if(!emName.trim())return;const nm=[...meds];nm[editMedIdx]={...nm[editMedIdx],name:emName.trim(),dose:emDose.trim(),defaultCt:Number(emDefaultCt)||0};setMeds(nm);setEditMedIdx(null);};
  const addMed=()=>{if(!newMedName.trim())return;const key=newMedName.toLowerCase().replace(/\s+/g,"_")+"_"+Date.now();setMeds([...meds,{key,name:newMedName.trim(),dose:newMedDose.trim()||"—",defaultCt:Number(newMedCt)||0}]);setNewMedName("");setNewMedDose("");setNewMedCt(1);setShowAddMed(false);};
  const addReminder=()=>{const nr=[...reminders,{time:newRT,label:newRL,on:true}];setReminders(nr);setS({reminders:nr});setShowAddR(false);if("Notification" in window)Notification.requestPermission();};
  const removeR=i=>{const nr=reminders.filter((_,j)=>j!==i);setReminders(nr);setS({reminders:nr});};
  const toggleR=i=>{const nr=[...reminders];nr[i]={...nr[i],on:!nr[i].on};setReminders(nr);setS({reminders:nr});};

  return(<div className="scr">
    <div className="hh"><h2 className="ht">Settings</h2><button className="bi" onClick={onBack}>×</button></div>

    <div className="card">
      <h3 className="ctit">Your Name</h3>
      <div className="set-nr"><input className="set-in" inputMode="text" style={{fontSize:16}} value={nameVal} onChange={e=>setNameVal(e.target.value)} placeholder="Nickname or first name"/><button className="btn-sm-p" onClick={saveName}>Save</button></div>
      {nameSaved?<p className="set-saved">Saved — hello, {nameVal.trim()}!</p>:<p className="set-h">Personalizes greetings and insights</p>}
    </div>

    <div className="card">
      <h3 className="ctit">Passcode Lock</h3>
      {settings.passcode&&!pcStep&&(<div><p className="set-h" style={{marginBottom:10}}>Passcode is set. Shown after welcome.</p>
        <div className="set-pcb"><button className="btn-s" style={{fontSize:13,padding:"10px 16px"}} onClick={()=>{setPcStep("new");setPc1("");setPc2("");}}>Change</button><button className="btn-ghost" style={{color:"#D4785C"}} onClick={()=>setS({passcode:""})}>Remove</button></div></div>)}
      {!settings.passcode&&!pcStep&&(<div><p className="set-h" style={{marginBottom:10}}>Protect your tracker with a 4-digit passcode.</p>
        <button className="btn-s" style={{fontSize:13,padding:"10px 16px"}} onClick={()=>{setPcStep("new");setPc1("");setPc2("");}}>Set Passcode</button></div>)}
      {pcStep&&(<div className="set-pcf"><p className="set-h">{pcStep==="new"?"Enter 4-digit passcode":"Confirm passcode"}</p>
        <div className="lock-dots" style={{justifyContent:"flex-start",margin:"12px 0"}}>{[0,1,2,3].map(i=><div key={i} className={`lock-dot${i<curPc.length?" on":""}`}/>)}</div>
        <div className="set-pad">{[1,2,3,4,5,6,7,8,9,"C",0,"del"].map((n,i)=>(<button key={i} className={`lk lksm${n==="del"?" lkdel":n==="C"?" lkclr":""}`} onClick={()=>{if(n==="del")pcDel();else if(n==="C")pcClear();else pcTap(String(n));}} disabled={false}>{n==="del"?"‹":""+n}</button>))}</div>
        <button className="btn-ghost" onClick={()=>setPcStep(null)}>Cancel</button></div>)}
    </div>

    <div className="card">
      <h3 className="ctit">Reminders</h3>
      <p className="set-h" style={{marginBottom:10}}>Browser notifications. Keep your tab open.</p>
      {reminders.map((r,i)=>(<div key={i} className="set-reminder">
        <div><span className="set-r-time">{r.time}</span><span className="set-r-label">{r.label}</span></div>
        <div className="set-r-acts"><button className={`set-r-toggle${r.on?" set-r-on":""}`} onClick={()=>toggleR(i)}>{r.on?"On":"Off"}</button><button className="btn-ghost" style={{color:"#D4785C",fontSize:11,padding:"2px 6px"}} onClick={()=>removeR(i)}>×</button></div>
      </div>))}
      {showAddR?(<div className="add-form" style={{marginTop:8}}>
        <div style={{display:"flex",gap:8,marginBottom:8}}><input type="time" className="srm-ti" style={{flex:1}} value={newRT} onChange={e=>setNewRT(e.target.value)}/><input className="add-input" style={{marginBottom:0}} value={newRL} onChange={e=>setNewRL(e.target.value)} placeholder="Label"/></div>
        <div className="add-btns"><button className="btn-ghost" onClick={()=>setShowAddR(false)}>Cancel</button><button className="btn-sm-p" onClick={addReminder}>Add</button></div>
      </div>):(<button className="btn-add" style={{marginTop:4}} onClick={()=>setShowAddR(true)}>+ Add reminder</button>)}
    </div>

    <div className="card">
      <h3 className="ctit">Medications</h3>
      <p className="set-h" style={{marginBottom:10}}>Dosage, daily default, and add new medications.</p>
      {meds.map((med,i)=>editMedIdx===i?(
        <div key={med.key} className="set-med-edit">
          <input className="add-input" value={emName} onChange={e=>setEmName(e.target.value)} placeholder="Name"/>
          <input className="add-input add-sm" value={emDose} onChange={e=>setEmDose(e.target.value)} placeholder="Dose per pill"/>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{fontSize:13,color:"var(--t2)",whiteSpace:"nowrap"}}>Daily default:</span><button className="bs" onClick={()=>setEmDefaultCt(Math.max(0,emDefaultCt-1))}>−</button><span className="mv">{emDefaultCt}</span><button className="bs" onClick={()=>setEmDefaultCt(emDefaultCt+1)}>+</button></div>
          <div className="add-btns"><button className="btn-ghost" onClick={()=>setEditMedIdx(null)}>Cancel</button><button className="btn-sm-p" onClick={saveEditMed}>Save</button></div>
        </div>
      ):(<div key={med.key} className="set-mr"><div className="mi"><div className="mn">{med.name}</div><div className="md-sub">{med.dose}/pill · default {med.defaultCt??0}/day</div></div>
        <div className="set-mr-acts"><button className="rr-edit" onClick={()=>startEditMed(i)}>Edit</button><button className="btn-ghost" style={{color:"#D4785C",fontSize:11,padding:"4px 6px"}} onClick={()=>setMeds(meds.filter((_,j)=>j!==i))}>Remove</button></div></div>))}
      {showAddMed?(<div className="add-form" style={{marginTop:8}}>
        <input className="add-input" value={newMedName} onChange={e=>setNewMedName(e.target.value)} placeholder="Medication name"/>
        <input className="add-input add-sm" value={newMedDose} onChange={e=>setNewMedDose(e.target.value)} placeholder="Dose (e.g. 50mg)"/>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{fontSize:13,color:"var(--t2)",whiteSpace:"nowrap"}}>Daily default:</span><button className="bs" onClick={()=>setNewMedCt(Math.max(0,newMedCt-1))}>−</button><span className="mv">{newMedCt}</span><button className="bs" onClick={()=>setNewMedCt(newMedCt+1)}>+</button></div>
        <div className="add-btns"><button className="btn-ghost" onClick={()=>setShowAddMed(false)}>Cancel</button><button className="btn-sm-p" onClick={addMed}>Add</button></div>
      </div>):(<button className="btn-add" style={{marginTop:8}} onClick={()=>setShowAddMed(true)}>+ Add medication</button>)}
    </div>

    <div className="card">
      <h3 className="ctit">Weekly Report</h3>
      <p className="set-h" style={{marginBottom:10}}>HTML email with mood insights and stats. Auto-sends every Sunday via Google Sheets.</p>
      <div className="set-nr"><input className="set-in" inputMode="email" type="email" style={{fontSize:16}} value={emailVal} onChange={e=>setEmailVal(e.target.value)} placeholder="your@email.com"/><button className="btn-sm-p" onClick={saveEmail}>Save</button></div>
      {emailSaved&&<p className="set-saved">Email saved!</p>}
      {settings.reportEmail&&<>
        <button className="btn-s" style={{fontSize:13,padding:"10px 16px",marginTop:10,width:"100%"}} onClick={sendReport} disabled={reportSending}>{reportSending?"Sending…":"Send this week's report now"}</button>
        {reportMsg&&<p className="set-saved" style={{color:reportMsg.includes("sent")?undefined:"#D4785C"}}>{reportMsg}</p>}
      </>}
    </div>

    {SHEETS_URL&&<div className="card"><h3 className="ctit">Google Sheets Sync</h3><p className="set-h" style={{marginTop:0}}>Active — entries sync one at a time. Pull from sheets on app open.</p><button className="btn-s" style={{fontSize:13,padding:"10px 16px",marginTop:8}} onClick={()=>{localStorage.removeItem("mt_seed_pushed");window.location.reload();}}>Force re-sync all data</button></div>}
    {!SHEETS_URL&&<div className="card"><h3 className="ctit">Google Sheets Sync</h3><p className="set-h" style={{marginTop:0}}>Not configured. Set SHEETS_URL in the code to enable.</p></div>}

    <p className="ver-label">Mood Tracker v{VER}</p>
    <div style={{height:40}}/>
  </div>);
}

/* ── REMINDER ENGINE ── */
if(typeof window!=="undefined"){
  setInterval(()=>{try{const set=JSON.parse(localStorage.getItem("mt_set")||"{}");if(!set.reminders)return;
    const now=new Date();const t=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    set.reminders.forEach(r=>{if(r.on&&r.time===t&&Notification.permission==="granted"){const lk="mt_n_"+r.time;const last=localStorage.getItem(lk);const td=now.toDateString();
      if(last!==td){new Notification("Mood Tracker",{body:r.label||"Time to log"});localStorage.setItem(lk,td);}}});
  }catch{}},30000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   CSS
   ═══════════════════════════════════════════════════════════════════════════ */
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=Source+Serif+4:ital,opsz,wght@0,8..60,300;0,8..60,400;0,8..60,500;1,8..60,300&display=swap');
:root{--bg:#FAF8F5;--card:#FFF;--tx:#2C2825;--t2:#6B6560;--t3:#A09890;--bd:#EBE7E1;--warm:#F5F0E8;--gn:#7BA08B;--gbg:#EFF6F1;--r:14px;--rs:10px;--sh:0 1px 3px rgba(0,0,0,.03),0 4px 12px rgba(0,0,0,.02);--ease:cubic-bezier(.16,1,.3,1)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',system-ui,sans-serif;background:var(--bg);color:var(--tx);-webkit-font-smoothing:antialiased}
.app{max-width:420px;margin:0 auto;min-height:100dvh;overflow-x:hidden}
.page{animation:pageIn .4s var(--ease)}
@keyframes pageIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.scr{padding:0 20px 140px;min-height:100dvh}

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

.welcome{display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}
.w-top{margin-bottom:60px;animation:wIn .8s var(--ease)}
@keyframes wIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.w-icon{width:80px;height:80px;margin:0 auto 24px;color:var(--tx);opacity:.7;animation:iconFloat 3s ease-in-out infinite 2s}
.w-icon svg{width:100%;height:100%}
.w-draw{stroke-dasharray:3000;stroke-dashoffset:3000;animation:drawIn 2.2s var(--ease) forwards}
.w-draw2{animation-delay:.5s}
@keyframes drawIn{0%{stroke-dashoffset:3000;fill-opacity:0}70%{fill-opacity:0}100%{stroke-dashoffset:0;fill:currentColor;fill-opacity:1;stroke-opacity:0}}
@keyframes iconFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.w-t{font-family:'Source Serif 4',serif;font-weight:400;font-size:30px;letter-spacing:-.3px;margin-bottom:10px}
.w-s{color:var(--t2);font-size:15px;line-height:1.6;max-width:280px;font-weight:300;font-style:italic}
.w-b{width:100%;max-width:280px;animation:wBIn .8s var(--ease) .3s both}
@keyframes wBIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

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
.lk{width:72px;height:56px;border-radius:12px;border:1px solid var(--bd);background:var(--card);font:300 22px 'Source Serif 4',serif;color:var(--tx);cursor:pointer;transition:all .1s;display:flex;align-items:center;justify-content:center}
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
.sync-badge{display:inline-block;font-size:10px;font-family:'DM Sans',sans-serif;font-weight:500;padding:2px 8px;border-radius:99px;vertical-align:middle;margin-left:6px}
.sync-badge.active{background:#EDF0F6;color:#6478A0;animation:syncPulse 1.5s ease-in-out infinite}
.sync-badge.done{background:#EFF6F1;color:#7BA08B}
@keyframes syncPulse{0%,100%{opacity:1}50%{opacity:.5}}
.cal-tr{display:flex;gap:6px;align-items:center}.cal-gr{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:2px}
.cht{font-family:'Source Serif 4',serif;font-weight:400;font-size:22px}.cnav{display:flex;gap:4px}
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

.ent{padding-top:12px}.et{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
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
.qt{font-family:'Source Serif 4',serif;font-size:24px;font-weight:400;letter-spacing:-.2px;margin-bottom:6px}
.qs{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:28px}.en{margin-top:8px}

.ol{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.oc{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;cursor:pointer;transition:all .15s;text-align:left;font-family:'DM Sans',sans-serif}
.oc:hover{border-color:var(--t3)}
.ocl{display:flex;align-items:center;gap:10px}.oce{font-size:13px;width:32px;text-align:center;flex-shrink:0;color:var(--t3);font-weight:500;letter-spacing:-.5px}
.ocn{font-size:14px;font-weight:400}.ocd{font-size:11px;color:var(--t3);font-weight:300;margin-top:1px}
.or{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--bd);display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;flex-shrink:0;transition:all .15s}

.np{display:flex;align-items:center;justify-content:center;gap:28px;margin:20px 0 32px}
.nv{text-align:center}.nb{font-family:'Source Serif 4',serif;font-size:48px;font-weight:300}.nu{font-size:16px;color:var(--t3);margin-left:4px}

.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px}
.sc{padding:20px 8px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;cursor:pointer;text-align:center;transition:all .15s;font-family:'DM Sans',sans-serif}
.sc:hover{border-color:var(--t3)}.ss{border-color:var(--tx);background:var(--warm)}
.sn{display:block;font-family:'Source Serif 4',serif;font-size:24px;font-weight:300;margin-bottom:4px}.sl{font-size:11px;color:var(--t2)}

.ml{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.mr{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);transition:all .15s}
.mo{border-color:var(--tx);background:var(--warm)}
.mi{flex:1}.mn{font-size:14px}.md-sub{font-size:11px;color:var(--t3);margin-top:1px}
.mc{display:flex;align-items:center;gap:10px}.mv{font-size:15px;font-weight:500;min-width:20px;text-align:center}

.ni{width:100%;min-height:120px;border-radius:var(--r);border:1.5px solid var(--bd);padding:16px;font:16px/1.55 'DM Sans',sans-serif;resize:vertical;background:transparent;color:var(--tx);transition:border .15s;margin-bottom:12px}
.ni:focus{outline:none;border-color:var(--tx)}.ni::placeholder{color:var(--t3)}

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

.hh{display:flex;align-items:center;justify-content:space-between;padding:24px 0 16px}
.ht{font-family:'Source Serif 4',serif;font-weight:400;font-size:22px}.ha{display:flex;gap:8px;align-items:center}
.sr{display:flex;gap:10px;margin-bottom:14px}
.sb{flex:1;background:var(--card);border-radius:var(--r);padding:14px 10px;box-shadow:var(--sh);text-align:center}
.sv{font-family:'Source Serif 4',serif;font-size:26px;font-weight:300}.sbl{font-size:10px;color:var(--t3);margin-top:2px}
.card{background:var(--card);border-radius:var(--r);padding:16px;box-shadow:var(--sh);margin-bottom:12px}
.ctit{font-size:10px;font-weight:500;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.cw{margin:0 -6px}
.cleg2{display:flex;gap:12px;margin-top:8px;font-size:10px;color:var(--t2);flex-wrap:wrap}
.ll{display:inline-block;width:14px;height:2px;border-radius:1px;vertical-align:middle;margin-right:3px}
.tt{background:var(--card);border:1px solid var(--bd);border-radius:var(--rs);padding:8px 12px;box-shadow:var(--sh);font-size:11px;z-index:10}
.ttd{font-weight:500;margin-bottom:2px}
.nl{display:flex;flex-direction:column}.nr{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--bd)}.nr:last-child{border-bottom:none}
.nd{font-size:11px;color:var(--t3);font-weight:500;min-width:44px;flex-shrink:0;padding-top:1px}.nt{font-size:13px;color:var(--t2);font-weight:300;line-height:1.5}

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
.ver-label{font-size:11px;color:var(--t3);text-align:center;margin-top:20px;font-weight:300}

@media(max-width:440px){.app{max-width:100%}.scr{padding:0 16px 32px}}
/* ── step navigation ── */
.step-btns{display:flex;flex-direction:column;align-items:center;gap:8px}
.btn-skip{background:none;border:none;font:300 13px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer;padding:4px 12px;letter-spacing:.01em}
.btn-skip:hover{color:var(--t2)}
/* ── move to date ── */
.btn-move-date{width:100%;margin-top:8px;padding:11px;border-radius:var(--rs);border:1px solid var(--bd);background:transparent;font:400 13px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer;text-align:center;transition:all .15s}
.btn-move-date:hover{border-color:var(--t2);color:var(--t2)}

/* ── SRM bottom-edge tick on calendar cells ── */
.c-srm-tick{position:absolute;bottom:3px;left:50%;transform:translateX(-50%);width:12px;height:2px;border-radius:1px;background:#7E9AB3;opacity:.7;pointer-events:none}

/* ── DayView snapshot rows ── */
.dv-snap-row{display:flex;align-items:flex-start;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--bd);gap:8px}
.dv-snap-row:last-child{border-bottom:none}
.dv-snap-left{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1}
.dv-snap-time{font-size:11px;color:var(--t3);font-weight:300;min-width:36px;flex-shrink:0}
.dv-snap-mood{font-size:13px;font-weight:500}
.dv-snap-meta{font-size:11px;color:var(--t3);font-weight:300}
.dv-snap-note{font-size:12px;color:var(--t2);font-weight:300;font-style:italic;width:100%;margin-top:2px}
.dv-snap-acts{display:flex;gap:4px;align-items:center;flex-shrink:0}

/* ── day-card snapshot rows ── */
.day-card-snaps{border-top:1px solid var(--bd);padding-top:8px;margin-top:4px;display:flex;flex-direction:column;gap:4px}
.day-card-snap-row{display:flex;align-items:center;gap:8px}
.day-card-snap-time{font-size:11px;color:var(--t3);font-weight:300;min-width:36px;flex-shrink:0}
.day-card-snap-mood{font-size:12px;font-weight:500}
.day-card-snap-sub{font-size:11px;color:var(--t3);font-weight:300}
.day-card-log-cta{margin-top:10px;width:100%;padding:10px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;text-align:center;transition:all .15s}
.day-card-log-cta:hover{border-color:var(--t3);color:var(--tx)}

/* ── snapshot pip on calendar cell ── */
.c-snap-pip{position:absolute;top:4px;right:4px;width:5px;height:5px;border-radius:50%;border:1.5px solid var(--t3);background:transparent;pointer-events:none}

/* ── mode picker ── */
.mode-opts{display:flex;flex-direction:column;gap:10px;margin-bottom:20px}
.mode-opt{display:flex;flex-direction:column;align-items:flex-start;padding:18px 16px;border-radius:var(--r);border:1.5px solid var(--bd);background:transparent;cursor:pointer;transition:all .15s;text-align:left;font-family:'DM Sans',sans-serif}
.mode-opt:hover{border-color:var(--t3);background:rgba(0,0,0,.01)}
.mode-opt:active{transform:scale(.99)}
.mode-opt-main{font-size:16px;font-weight:500;color:var(--tx);margin-bottom:3px}
.mode-opt-sub{font-size:12px;color:var(--t3);font-weight:300;line-height:1.4}

/* ── snapshot reference callout in mood step ── */
.snap-ref{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--warm);border-radius:var(--rs);margin-bottom:14px;flex-wrap:wrap}
.snap-ref-label{font-size:11px;color:var(--t3);font-weight:400;flex-shrink:0}
.snap-ref-val{font-size:13px;font-weight:500}
.snap-ref-sub{font-size:11px;color:var(--t3);font-weight:300}

/* ── blank day card ── */
.blank-day-card{background:var(--card);border-radius:var(--r);padding:16px;box-shadow:var(--sh)}
.blank-day-empty{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:12px}
.blank-day-snaps{border-top:1px solid var(--bd);padding-top:12px}
.blank-day-snap-label{font-size:10px;font-weight:500;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.blank-day-snap-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--bd)}
.blank-day-snap-row:last-child{border-bottom:none}
.blank-day-snap-time{font-size:12px;color:var(--t3);font-weight:300;min-width:36px}
.blank-day-snap-sub{font-size:11px;color:var(--t3);margin-left:auto}

`;