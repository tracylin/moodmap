import { useState, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, CartesianGrid, ReferenceLine, BarChart, Bar } from "recharts";
import './App.css'

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG — Set your Google Sheets Web App URL here after deploying
   ═══════════════════════════════════════════════════════════════════════════ */
const SHEETS_URL = "https://schttps://script.google.com/macros/s/AKfycbypVhZzY-6X3vYCK8RagdvJoBQTLUslz0iK2T9i-EzRdjZDUB3y49P8LQk8ZOgFpxb7/exec"; // paste your deployed Apps Script URL here

async function syncToSheets(mood, srm) {
  if (!SHEETS_URL) return;
  try {
    await fetch(SHEETS_URL, {
      method: "POST", mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mood, srm, ts: new Date().toISOString() }),
    });
  } catch (e) { console.warn("Sync failed:", e); }
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

const VER="0.4.0";
const MM={sev_elev:{v:3,label:"Severe Elevated",color:"#D4785C",short:"Sev ↑",bg:"#FDF0EC"},mod_elev:{v:2,label:"Moderate Elevated",color:"#D49A6A",short:"Mod ↑",bg:"#FDF5EE"},mild_elev:{v:1,label:"Mild Elevated",color:"#C9B07A",short:"Mild ↑",bg:"#FAF6ED"},normal:{v:0,label:"Within Normal",color:"#7BA08B",short:"Normal",bg:"#EFF6F1"},mild_dep:{v:-1,label:"Mild Depressed",color:"#7E9AB3",short:"Mild ↓",bg:"#EEF3F8"},mod_dep:{v:-2,label:"Moderate Depressed",color:"#6478A0",short:"Mod ↓",bg:"#EDF0F6"},sev_dep:{v:-3,label:"Severe Depressed",color:"#5A5F8A",short:"Sev ↓",bg:"#EDEEF4"}};
const MOOD_OPTS=[{key:"sev_elev",icon:"⬆⬆⬆",label:"Severe Elevated",sub:"Significant impairment · not able to work"},{key:"mod_elev",icon:"⬆⬆",label:"Moderate Elevated",sub:"Significant impairment · able to work"},{key:"mild_elev",icon:"⬆",label:"Mild Elevated",sub:"Without significant impairment"},{key:"normal",icon:"—",label:"Within Normal",sub:"No symptoms"},{key:"mild_dep",icon:"⬇",label:"Mild Depressed",sub:"Without significant impairment"},{key:"mod_dep",icon:"⬇⬇",label:"Moderate Depressed",sub:"Significant impairment · able to work"},{key:"sev_dep",icon:"⬇⬇⬇",label:"Severe Depressed",sub:"Significant impairment · not able to work"}];
const DEF_MEDS=[{key:"lamotrigine",name:"Lamotrigine",dose:"200mg"},{key:"quetiapine",name:"Quetiapine",dose:"100mg"},{key:"lithium",name:"Lithium Carbonate",dose:"300mg"},{key:"levothyroxine",name:"Levothyroxine",dose:"50mcg"},{key:"naltrexone",name:"Naltrexone",dose:"50mg"}];
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
const nowTime=()=>{const d=new Date();return`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;};
const isAMnow=()=>new Date().getHours()<12;
const GREETS=[n=>`Take it one moment at a time${n?", "+n:""}.`,n=>`No rush. You're here, and that's enough${n?", "+n:""}.`,n=>`A small step is still a step${n?", "+n:""}.`,n=>`Glad you're here${n?", "+n:""}.`,n=>`${n?n+", you":"You"} don't have to do this perfectly.`,n=>`Checking in takes courage${n?", "+n:""}.`,n=>`${n?n+", b":"B"}e gentle with yourself today.`,n=>`Ready when you are${n?", "+n:""}.`];

function loadJ(k,fb){try{const s=localStorage.getItem(k);return s?JSON.parse(s):fb;}catch{return fb;}}
function loadMood(){try{const s=localStorage.getItem("mt_mood");return s?{...SEED_MOOD,...JSON.parse(s)}:{...SEED_MOOD};}catch{return{...SEED_MOOD};}}
function saveMood(d){const u={};for(const k in d)if(!SEED_MOOD[k])u[k]=d[k];localStorage.setItem("mt_mood",JSON.stringify(u));}
function loadSRM(){try{const s=localStorage.getItem("mt_srm");return s?{...SEED_SRM,...JSON.parse(s)}:{...SEED_SRM};}catch{return{...SEED_SRM};}}
function saveSRM(d){const u={};for(const k in d)if(!SEED_SRM[k])u[k]=d[k];localStorage.setItem("mt_srm",JSON.stringify(u));}
function loadSet(){const s=loadJ("mt_set",{});if(!s.passcode)s.passcode="1234";if(!s.name)s.name="Wei";return s;}
function saveSet(s){localStorage.setItem("mt_set",JSON.stringify(s));}
function emptyItem(id){return{id,time:"",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0};}

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

  const setS=s=>{const n={...settings,...s};setSS(n);saveSet(n);};
  const setMeds=m=>{setMedsS(m);localStorage.setItem("mt_meds",JSON.stringify(m));};
  const name=settings.name||"";

  const doSaveMood=(n)=>{setMood(n);saveMood(n);syncToSheets(n,srm);};
  const doSaveSRM=(n)=>{setSrm(n);saveSRM(n);syncToSheets(mood,n);};

  return(<>
    <style>{CSS}</style>
    <div className="app"><div className="page" key={screen}>
      {screen==="welcome"&&<Welcome name={name} onGo={()=>settings.passcode?setScreen("lock"):setScreen("calendar")}/>}
      {screen==="lock"&&<Lock passcode={settings.passcode} onOk={()=>setScreen("calendar")}/>}
      {screen==="calendar"&&<Cal mood={mood} srm={srm} vm={vm} setVm={setVm} name={name} selDay={selDay} setSelDay={setSelDay} onAdd={()=>setScreen("entry")} onSrm={()=>setScreen("srm")} onHist={()=>setScreen("history")} onSet={()=>setScreen("settings")} onViewDay={()=>setScreen("dayView")}/>}
      {screen==="dayView"&&<DayView dk={selDay} mood={mood} srm={srm} meds={meds} onBack={()=>setScreen("calendar")}
        onDelMood={()=>{const n={...mood};delete n[selDay];doSaveMood(n);setScreen("calendar");}}
        onDelSRM={()=>{const n={...srm};delete n[selDay];doSaveSRM(n);setScreen("calendar");}}
        onEditMood={()=>setScreen("editDayMood")}
        onEditSRM={id=>{setSrmEditId(id);setScreen("editDaySrm");}}/>}
      {screen==="editDayMood"&&<MoodEntry mood={mood} meds={meds} editKey={selDay} onSave={e=>{doSaveMood({...mood,[selDay]:e});setScreen("dayView");}} onX={()=>setScreen("dayView")}/>}
      {screen==="editDaySrm"&&<SRMSingle id={srmEditId} srm={srm} dateKey={selDay} onSave={item=>{const ex=srm[selDay]||{items:[]};const items=[...ex.items.filter(i=>i.id!==item.id),item];doSaveSRM({...srm,[selDay]:{items}});setScreen("dayView");}} onX={()=>setScreen("dayView")}/>}
      {screen==="entry"&&<MoodEntry mood={mood} meds={meds} onSave={e=>{doSaveMood({...mood,[tdk()]:e});setScreen("confirm");}} onX={()=>setScreen("calendar")}/>}
      {screen==="srm"&&<SRMPicker srm={srm} onPick={id=>{setSrmEditId(id);setScreen("srmEdit");}} onX={()=>setScreen("calendar")}/>}
      {screen==="srmEdit"&&<SRMSingle id={srmEditId} srm={srm} onSave={item=>{const k=tdk();const ex=srm[k]||{items:[]};const items=[...ex.items.filter(i=>i.id!==item.id),item];doSaveSRM({...srm,[k]:{items}});setScreen("srm");}} onX={()=>setScreen("srm")}/>}
      {screen==="confirm"&&<Confirm msg="Mood entry logged" sub="You showed up today. That matters." onDone={()=>setScreen("calendar")}/>}
      {screen==="history"&&<Hist mood={mood} srm={srm} name={name} meds={meds} onBack={()=>setScreen("calendar")}/>}
      {screen==="settings"&&<Settings settings={settings} setS={setS} meds={meds} setMeds={setMeds} onBack={()=>setScreen("calendar")}/>}
    </div></div>
  </>);
}

/* ── WELCOME ── */
function Welcome({name,onGo}){
  const[greet]=useState(()=>GREETS[Math.floor(Math.random()*GREETS.length)](name));
  return(<div className="scr welcome">
    <div className="w-top">
      <div className="w-orb"><div className="w-orb-i"/><div className="w-orb-ring"/></div>
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
        {[1,2,3,4,5,6,7,8,9,null,0,"del"].map((n,i)=>(
          <button key={i} className={`lk${n===null?" lke":""}`}
            onClick={()=>{if(n==="del")setInput(input.slice(0,-1));else if(n!==null)tap(String(n));}}
            disabled={n===null}>
            {n==="del"?"‹":""+n}
          </button>
        ))}
      </div>
    </div>
  </div>);
}

/* ── CALENDAR ── */
function Cal({mood,srm,vm,setVm,name,selDay,setSelDay,onAdd,onSrm,onHist,onSet,onViewDay}){
  const[y,m]=vm;const days=dIn(y,m);const off=fDay(y,m);
  const now=new Date();const td=now.getFullYear()===y&&now.getMonth()===m?now.getDate():-1;
  const cells=[];
  for(let i=0;i<off;i++) cells.push(<div key={`b${i}`} className="cc ce"/>);
  for(let d=1;d<=days;d++){
    const k=dk(y,m,d);const e=mood[k];const s=srm[k];const isT=d===td;const isSel=selDay===k;
    const mc=e?.mood?MM[e.mood]:null;
    cells.push(<div key={d} className={`cc${e||s?" cl":""}${isT?" ct":""}${isSel?" csel":""}`}
      onClick={()=>{if(e||s)setSelDay(isSel?null:k);}}>
      {mc&&<div className="cd" style={{background:mc.color,opacity:.18}}/>}
      {s&&!mc&&<div className="cd" style={{background:"#7E9AB3",opacity:.1}}/>}
      <span className="cn">{d}</span>
    </div>);
  }
  let streak=0;const sd=new Date();
  for(let i=0;i<90;i++){const k=dk(sd.getFullYear(),sd.getMonth(),sd.getDate());if(mood[k]||srm[k])streak++;else if(i>0)break;sd.setDate(sd.getDate()-1);}
  const gr=()=>{const h=now.getHours();return h<12?"Good morning":h<17?"Good afternoon":"Good evening";};
  const selMood=selDay?mood[selDay]:null;const selSrm=selDay?srm[selDay]:null;
  const selLabel=selDay?`${MO[parseInt(selDay.split("-")[1])-1].slice(0,3)} ${parseInt(selDay.split("-")[2])}`:"";

  return(<div className="scr">
    <div className="cal-top">
      <div><p className="cal-gr">{gr()}{name?`, ${name}`:""}</p><h2 className="cht">{MO[m]} {y}</h2></div>
      <div className="cal-tr"><button className="bi" onClick={onSet}>⚙</button><div className="cnav"><button className="bi" onClick={()=>setVm(m===0?[y-1,11]:[y,m-1])}>‹</button><button className="bi" onClick={()=>setVm(m===11?[y+1,0]:[y,m+1])}>›</button></div></div>
    </div>
    {streak>1&&<div className="streak">✦ {streak} day streak</div>}
    <div className="cg">{DW.map(d=><div key={d} className="clb">{d}</div>)}{cells}</div>
    <div className="cleg">{Object.entries(MM).map(([k,v])=>(<div key={k} className="cli"><div className="cld" style={{background:v.color}}/><span>{v.short}</span></div>))}</div>

    {selDay&&(selMood||selSrm)&&(
      <div className="day-card" onClick={onViewDay}>
        <div className="day-card-head"><span className="day-card-date">{selLabel}</span><span className="day-card-arrow">View full log →</span></div>
        {selMood?.mood&&<div className="day-card-mood" style={{color:MM[selMood.mood].color}}>{MM[selMood.mood].label}</div>}
        {selMood?.notes&&<div className="day-card-note">{selMood.notes}</div>}
        <div className="day-chips">
          {selMood?.sleep!=null&&<span className="day-chip">Sleep {selMood.sleep}h</span>}
          {selMood?.anxiety!=null&&selMood.anxiety>0&&<span className="day-chip">Anxiety {selMood.anxiety}/3</span>}
          {selSrm&&<span className="day-chip">{selSrm.items.filter(i=>!i.didNot).length} activities</span>}
        </div>
      </div>
    )}

    <div className="cact">
      <button className="btn-p" onClick={onAdd}>{mood[tdk()]?"Edit Mood":"Log Mood"}</button>
      <button className="btn-rhythm" onClick={onSrm}>{srm[tdk()]?"Edit Rhythm":"Daily Rhythm"}</button>
      <button className="btn-s" onClick={onHist}>Insights</button>
    </div>
  </div>);
}

/* ── DAY VIEW — with edit and delete ── */
function DayView({dk:dateKey,mood,srm,meds,onBack,onDelMood,onDelSRM,onEditMood,onEditSRM}){
  const[confirmDel,setConfirmDel]=useState(null);
  const e=mood[dateKey];const s=srm[dateKey];
  const[yr,mo,dy]=(dateKey||"2026-01-01").split("-").map(Number);
  const label=`${MO[mo-1]} ${dy}, ${yr}`;
  return(<div className="scr">
    <div className="hh"><h2 className="ht">{label}</h2><button className="bi" onClick={onBack}>✕</button></div>
    {e&&(<div className="card">
      <div className="dv-head"><h3 className="ctit">Mood Log</h3><div className="dv-acts"><button className="rr-edit" onClick={onEditMood}>Edit</button><button className="rr-edit" style={{color:"#D4785C"}} onClick={()=>setConfirmDel("mood")}>Delete</button></div></div>
      {confirmDel==="mood"&&<div className="dv-confirm"><span>Delete this mood entry?</span><button className="btn-sm-p" style={{background:"#D4785C"}} onClick={onDelMood}>Delete</button><button className="btn-ghost" onClick={()=>setConfirmDel(null)}>Cancel</button></div>}
      {e.mood&&<div className="dv-mood" style={{color:MM[e.mood].color}}>{MM[e.mood].label}</div>}
      {e.sleep!=null&&<div className="dv-row">Sleep: {e.sleep} hrs</div>}
      {e.anxiety!=null&&<div className="dv-row">Anxiety: {e.anxiety} / 3</div>}
      {e.irritability!=null&&<div className="dv-row">Irritability: {e.irritability} / 3</div>}
      {e.meds&&<div className="dv-row">Meds: {Object.entries(e.meds).filter(([,v])=>v.ct>0).map(([k,v])=>{const med=meds.find(m=>m.key===k);return`${med?.name||k} ×${v.ct}`;}).join(", ")}</div>}
      {e.notes&&<div className="dv-note">{e.notes}</div>}
    </div>)}
    {s&&(<div className="card">
      <div className="dv-head"><h3 className="ctit">Daily Rhythm</h3><button className="rr-edit" style={{color:"#D4785C"}} onClick={()=>setConfirmDel("srm")}>Delete all</button></div>
      {confirmDel==="srm"&&<div className="dv-confirm"><span>Delete rhythm log?</span><button className="btn-sm-p" style={{background:"#D4785C"}} onClick={onDelSRM}>Delete</button><button className="btn-ghost" onClick={()=>setConfirmDel(null)}>Cancel</button></div>}
      {s.items.map(it=>{const ac=SRM_ACT.find(a=>a.id===it.id)||{icon:"·",label:it.id};
        return(<div key={it.id} className="dv-srm-row">
          <div className="dv-srm-info"><span className="dv-srm-icon">{ac.icon}</span><span>{ac.label}</span></div>
          <div className="dv-srm-r">
            <span className="dv-srm-time">{it.didNot?"Skipped":it.time?(it.time+" "+(it.am?"AM":"PM")):"—"}{it.withOthers?" · social":""}</span>
            <button className="rr-edit" onClick={()=>onEditSRM(it.id)}>Edit</button>
          </div>
        </div>);
      })}
    </div>)}
    {!e&&!s&&<p style={{color:"var(--t3)",fontSize:13,textAlign:"center",marginTop:40}}>No data for this day.</p>}
  </div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOOD ENTRY
   ═══════════════════════════════════════════════════════════════════════════ */
const MSTEPS=[{id:"mood",q:"How was your mood?",s:"Overall mood"},{id:"sleep",q:"Hours of sleep?",s:"Last night, roughly"},{id:"anxiety",q:"Anxiety level?",s:"0 none · 1 mild · 2 moderate · 3 severe"},{id:"irritability",q:"Irritability level?",s:"0 none · 1 mild · 2 moderate · 3 severe"},{id:"meds",q:"Medications taken",s:"Adjust pill counts"},{id:"notes",q:"Anything to note?",s:"Optional — events, thoughts, anything"}];

function MoodEntry({mood,meds,editKey,onSave,onX}){
  const targetKey=editKey||tdk();
  const[step,setStep]=useState(0);const[editIdx,setEditIdx]=useState(null);
  const[entry,setEntry]=useState(()=>{
    const t=mood[targetKey];if(t)return{...t,meds:{...t.meds}};
    const m={};meds.forEach(med=>{m[med.key]={ct:med.key==="naltrexone"?0:1};});
    return{mood:null,sleep:8,anxiety:1,irritability:1,meds:m,notes:""};
  });
  const tot=MSTEPS.length;const isR=editIdx===null&&step===tot;
  const prog=((step+(isR?1:0))/(tot+1))*100;
  const upd=(k,v)=>setEntry(e=>({...e,[k]:v}));
  const updMC=(k,v)=>setEntry(e=>({...e,meds:{...e.meds,[k]:{...e.meds[k],ct:Math.max(0,v)}}}));

  const renderStep=(si)=>{
    const st=MSTEPS[si];const isEdit=editIdx!==null;
    return(<div className="qa" key={si+"-"+isEdit}>
      <h2 className="qt">{st.q}</h2><p className="qs">{st.s}</p>
      {st.id==="mood"&&(<div className="ol">{MOOD_OPTS.map(o=>{const sel=entry.mood===o.key;const mc=MM[o.key];
        return(<button key={o.key} className={`oc${sel?" os":""}`} style={sel?{borderColor:mc.color,background:mc.bg}:{}} onClick={()=>upd("mood",o.key)}>
          <div className="ocl"><span className="oce">{o.icon}</span><div><div className="ocn">{o.label}</div><div className="ocd">{o.sub}</div></div></div>
          <div className={`or${sel?" orn":""}`} style={sel?{borderColor:mc.color,background:mc.color}:{}}>{sel&&"✓"}</div>
        </button>);})}</div>)}
      {st.id==="sleep"&&(<div className="np"><button className="br" onClick={()=>upd("sleep",Math.max(0,(entry.sleep||0)-.5))}>−</button><div className="nv"><span className="nb">{entry.sleep??0}</span><span className="nu">hrs</span></div><button className="br" onClick={()=>upd("sleep",Math.min(24,(entry.sleep||0)+.5))}>+</button></div>)}
      {(st.id==="anxiety"||st.id==="irritability")&&(<div className="sg">{SEV.map(s=>{const sel=entry[st.id]===s.v;return(<button key={s.v} className={`sc${sel?" ss":""}`} onClick={()=>upd(st.id,s.v)}><span className="sn">{s.v}</span><span className="sl">{s.l}</span></button>);})}</div>)}
      {st.id==="meds"&&(<div className="ml">{meds.map(med=>{const me=entry.meds[med.key]||{ct:0};
        return(<div key={med.key} className={`mr${me.ct>0?" mo":""}`}><div className="mi"><div className="mn">{med.name}</div><div className="md-sub">{med.dose} / pill</div></div><div className="mc"><button className="bs" onClick={()=>updMC(med.key,me.ct-1)}>−</button><span className="mv">{me.ct}</span><button className="bs" onClick={()=>updMC(med.key,me.ct+1)}>+</button></div></div>);})}</div>)}
      {st.id==="notes"&&(<textarea className="ni" value={entry.notes||""} onChange={e=>upd("notes",e.target.value)} placeholder="Had a good walk today..." rows={4}/>)}
      <button className={`btn-p en${(si===0&&!entry.mood)?" bd":""}`} onClick={()=>{if(isEdit)setEditIdx(null);else setStep(Math.min(si+1,tot));}} disabled={si===0&&!entry.mood}>{isEdit?"Done":si===tot-1?"Review":"Next"}</button>
    </div>);
  };

  return(<div className="scr ent">
    <div className="et"><button className="bi" onClick={()=>{if(editIdx!==null)setEditIdx(null);else if(step>0)setStep(step-1);else onX();}}>‹</button><span className="es">{isR?"Review":editIdx!==null?"Editing":`${(editIdx??step)+1} / ${tot}`}</span><button className="btn-ghost" onClick={onX}>Cancel</button></div>
    <div className="pb"><div className="pf" style={{width:`${prog}%`}}/></div>
    {editIdx!==null?renderStep(editIdx):(!isR?renderStep(step):(
      <div className="qa" key="rv"><h2 className="qt">Looks good?</h2><p className="qs">{new Date(targetKey+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</p>
        <div className="rc">
          <RvRow l="Mood" v={entry.mood?<span style={{color:MM[entry.mood].color,fontWeight:500}}>{MM[entry.mood].label}</span>:"—"} onEdit={()=>setEditIdx(0)}/>
          <RvRow l="Sleep" v={entry.sleep!=null?`${entry.sleep} hrs`:"—"} onEdit={()=>setEditIdx(1)}/>
          <RvRow l="Anxiety" v={entry.anxiety!=null?`${entry.anxiety}/3`:"—"} onEdit={()=>setEditIdx(2)}/>
          <RvRow l="Irritability" v={entry.irritability!=null?`${entry.irritability}/3`:"—"} onEdit={()=>setEditIdx(3)}/>
          <RvRow l="Meds" v={Object.entries(entry.meds).filter(([,v])=>v.ct>0).map(([k,v])=>`${meds.find(m=>m.key===k)?.name||k} ×${v.ct}`).join(", ")||"None"} onEdit={()=>setEditIdx(4)}/>
          <RvRow l="Notes" v={entry.notes||"—"} onEdit={()=>setEditIdx(5)}/>
        </div>
        <button className="btn-p" onClick={()=>onSave(entry)}>Confirm</button>
      </div>
    ))}
  </div>);
}

function RvRow({l,v,onEdit}){return(<div className="rr"><div className="rr-left"><span className="rl">{l}</span><span className="rv">{v}</span></div>{onEdit&&<button className="rr-edit" onClick={onEdit}>Edit</button>}</div>);}

/* ═══════════════════════════════════════════════════════════════════════════
   SRM PICKER — shows all activities, custom is one-off (session only)
   ═══════════════════════════════════════════════════════════════════════════ */
function SRMPicker({srm,onPick,onX}){
  const[sessionCustom,setSessionCustom]=useState([]);
  const allActs=[...SRM_ACT,...sessionCustom];
  const todayItems=(srm[tdk()]||{}).items||[];
  const logged=new Set(todayItems.map(i=>i.id));
  const[showAdd,setShowAdd]=useState(false);const[newLabel,setNewLabel]=useState("");

  const addCustom=()=>{
    if(!newLabel.trim())return;
    const id="c_"+Date.now();
    setSessionCustom(p=>[...p,{id,label:newLabel.trim(),icon:"·"}]);
    setNewLabel("");setShowAdd(false);
  };

  return(<div className="scr">
    <div className="hh"><h2 className="ht">Daily Rhythm</h2><button className="bi" onClick={onX}>✕</button></div>
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
        <input type="time" className="srm-ti" value={item.time} onChange={e=>upd("time",e.target.value)}/>
        <button className="srm-now" onClick={()=>{upd("time",nowTime());upd("am",isAMnow());}}>Now</button>
        <div className="srm-ap">
          <button className={`srm-ab${item.am?" srm-aon":""}`} onClick={()=>upd("am",true)}>AM</button>
          <button className={`srm-ab${!item.am?" srm-aon":""}`} onClick={()=>upd("am",false)}>PM</button>
        </div>
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
function Hist({mood,srm,name,meds,onBack}){
  const sorted=Object.entries(mood).filter(([,e])=>e.mood||e.sleep||e.anxiety!=null).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,e])=>{const[y,m,d]=k.split("-").map(Number);return{key:k,day:d,month:m,year:y,label:`${MO[m-1].slice(0,3)} ${d}`,sl:`${m}/${d}`,...e,mv:e.mood?MM[e.mood].v:null};});
  const wM=sorted.filter(e=>e.mv!=null);const wS=sorted.filter(e=>e.sleep!=null);const wA=sorted.filter(e=>e.anxiety!=null);
  const avg=a=>a.length?(a.reduce((s,x)=>s+x,0)/a.length):null;
  const moodData=wM.map(e=>({n:e.sl,mood:e.mv,f:e.label}));
  const comboData=sorted.filter(e=>e.sleep!=null||e.anxiety!=null).map(e=>({n:e.sl,sleep:e.sleep,anxiety:e.anxiety,f:e.label}));
  const notes=sorted.filter(e=>e.notes?.trim()).reverse();
  const srmSorted=Object.entries(srm).sort(([a],[b])=>a.localeCompare(b));
  const srmSocial=srmSorted.map(([k,v])=>{const[,m,d]=k.split("-").map(Number);return{name:`${m}/${d}`,social:(v.items||[]).filter(i=>!i.didNot&&i.withOthers).length,total:(v.items||[]).filter(i=>!i.didNot).length};});
  const srmTimes=srmSorted.map(([k,v])=>{const[,m,d]=k.split("-").map(Number);const out={name:`${m}/${d}`};(v.items||[]).forEach(item=>{if(item.time&&!item.didNot){const[h,mi]=(item.time||"0:0").split(":").map(Number);const tot=item.am?(h*60+mi):((h===12?12:h+12)*60+mi);out[item.id]=tot/60;}});return out;});

  const MTT=({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0].payload;const mk=Object.entries(MM).find(([,v])=>v.v===d.mood);return(<div className="tt"><div className="ttd">{d.f}</div>{mk&&<div style={{color:mk[1].color}}>{mk[1].label}</div>}</div>);};
  const CTT=({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0].payload;return(<div className="tt"><div className="ttd">{d.f}</div>{d.sleep!=null&&<div>Sleep: {d.sleep}h</div>}{d.anxiety!=null&&<div>Anxiety: {d.anxiety}/3</div>}</div>);};
  const fmtH=v=>{const h=Math.floor(v);return`${h>12?h-12:h||12}${h>=12?"pm":"am"}`;};

  const exCSV=()=>{
    let csv="Date,Mood,Sleep,Anxiety,Irritability,Medications,Notes,Rhythm Activities\n";
    const allDates=new Set([...Object.keys(mood),...Object.keys(srm)]);
    [...allDates].sort().forEach(k=>{
      const e=mood[k];const s=srm[k];
      const ms=e?.meds?Object.entries(e.meds).filter(([,v])=>v.ct>0).map(([k2,v])=>`${k2}:${v.ct}`).join("; "):"";
      const rhythm=s?.items?s.items.filter(i=>!i.didNot).map(i=>`${i.id}:${i.time||"?"}${i.am?"AM":"PM"}`).join("; "):"";
      csv+=`${k},${e?.mood||""},${e?.sleep??""},${e?.anxiety??""},${e?.irritability??""},"${ms}","${(e?.notes||"").replace(/"/g,'""')}","${rhythm}"\n`;
    });
    const b=new Blob([csv],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`mood-rhythm-${tdk()}.csv`;a.click();
  };

  return(<div className="scr">
    <div className="hh"><h2 className="ht">{name?`${name}'s `:""}Insights</h2><div className="ha"><button className="bx" onClick={exCSV}>↓ Export</button><button className="bi" onClick={onBack}>✕</button></div></div>
    <div className="sr">
      <div className="sb"><div className="sv">{sorted.length}</div><div className="sbl">Days</div></div>
      <div className="sb"><div className="sv">{avg(wS.map(e=>e.sleep))?.toFixed(1)??"—"}</div><div className="sbl">Avg Sleep</div></div>
      <div className="sb"><div className="sv">{avg(wA.map(e=>e.anxiety))?.toFixed(1)??"—"}</div><div className="sbl">Avg Anxiety</div></div>
    </div>

    {moodData.length>0&&<div className="card"><h3 className="ctit">Mood</h3><div className="cw"><ResponsiveContainer width="100%" height={180}><AreaChart data={moodData} margin={{top:8,right:8,left:-24,bottom:4}}>
      <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#D4785C" stopOpacity={.12}/><stop offset="50%" stopColor="#7BA08B" stopOpacity={.06}/><stop offset="100%" stopColor="#5A5F8A" stopOpacity={.15}/></linearGradient></defs>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/>
      <YAxis domain={[-3,3]} ticks={[-3,-2,-1,0,1,2,3]} tick={{fontSize:8,fill:"#9E9790"}} tickFormatter={v=>({3:"Sev↑",2:"Mod↑",1:"Mild↑",0:"OK","-1":"Mild↓","-2":"Mod↓","-3":"Sev↓"}[v]||v)}/>
      <ReferenceLine y={0} stroke="#7BA08B" strokeDasharray="4 4" strokeOpacity={.4}/><Tooltip content={<MTT/>}/>
      <Area type="monotone" dataKey="mood" stroke="#6478A0" strokeWidth={2} fill="url(#mg)" dot={{r:2.5,fill:"#6478A0",strokeWidth:0}} activeDot={{r:4}} connectNulls/>
    </AreaChart></ResponsiveContainer></div></div>}

    {comboData.length>0&&<div className="card"><h3 className="ctit">Sleep & Anxiety</h3><div className="cw"><ResponsiveContainer width="100%" height={150}><LineChart data={comboData} margin={{top:8,right:8,left:-24,bottom:4}}>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/><YAxis tick={{fontSize:10,fill:"#9E9790"}}/>
      <Tooltip content={<CTT/>}/><Line type="monotone" dataKey="sleep" stroke="#7BA08B" strokeWidth={1.5} dot={{r:2,fill:"#7BA08B",strokeWidth:0}} connectNulls/>
      <Line type="monotone" dataKey="anxiety" stroke="#D4785C" strokeWidth={1.5} dot={{r:2,fill:"#D4785C",strokeWidth:0}} connectNulls strokeDasharray="4 2"/>
    </LineChart></ResponsiveContainer></div><div className="cleg2"><span><span className="ll" style={{background:"#7BA08B"}}/> Sleep</span><span><span className="ll" style={{background:"#D4785C"}}/> Anxiety</span></div></div>}

    {srmSorted.length>0&&<div className="card"><h3 className="ctit">Social Engagement</h3><div className="cw"><ResponsiveContainer width="100%" height={120}><BarChart data={srmSocial} margin={{top:8,right:8,left:-24,bottom:4}}>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="name" tick={{fontSize:10,fill:"#9E9790"}}/><YAxis tick={{fontSize:10,fill:"#9E9790"}}/>
      <Bar dataKey="total" fill="#E8E4DE" radius={[4,4,0,0]}/><Bar dataKey="social" fill="#7E9AB3" radius={[4,4,0,0]}/>
    </BarChart></ResponsiveContainer></div><div className="cleg2"><span><span className="ll" style={{background:"#7E9AB3"}}/> Social</span><span><span className="ll" style={{background:"#E8E4DE"}}/> Total</span></div></div>}

    {srmTimes.length>0&&srmTimes.some(d=>d.bed||d.bedtime||d.work||d.exercise||d.outside)&&<div className="card"><h3 className="ctit">Activity Times</h3><div className="cw"><ResponsiveContainer width="100%" height={160}><LineChart data={srmTimes} margin={{top:8,right:8,left:-24,bottom:4}}>
      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="name" tick={{fontSize:10,fill:"#9E9790"}}/><YAxis tick={{fontSize:10,fill:"#9E9790"}} domain={[5,25]} tickFormatter={fmtH}/>
      <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;return(<div className="tt">{payload.filter(p=>p.value).map((p,i)=>(<div key={i} style={{color:p.stroke}}>{p.name}: {fmtH(p.value)}</div>))}</div>);}}/>
      {srmTimes.some(d=>d.bed)&&<Line type="monotone" dataKey="bed" stroke="#7E9AB3" strokeWidth={1.5} dot={{r:2,fill:"#7E9AB3",strokeWidth:0}} connectNulls name="Wake up"/>}
      {srmTimes.some(d=>d.bedtime)&&<Line type="monotone" dataKey="bedtime" stroke="#5A5F8A" strokeWidth={1.5} dot={{r:2,fill:"#5A5F8A",strokeWidth:0}} connectNulls name="Bed time"/>}
      {srmTimes.some(d=>d.work)&&<Line type="monotone" dataKey="work" stroke="#C9B07A" strokeWidth={1.5} dot={{r:2,fill:"#C9B07A",strokeWidth:0}} connectNulls name="Work"/>}
      {srmTimes.some(d=>d.exercise)&&<Line type="monotone" dataKey="exercise" stroke="#D49A6A" strokeWidth={1.5} dot={{r:2,fill:"#D49A6A",strokeWidth:0}} connectNulls name="Work out"/>}
      {srmTimes.some(d=>d.outside)&&<Line type="monotone" dataKey="outside" stroke="#7BA08B" strokeWidth={1.5} dot={{r:2,fill:"#7BA08B",strokeWidth:0}} connectNulls name="Outside"/>}
    </LineChart></ResponsiveContainer></div><div className="cleg2" style={{flexWrap:"wrap"}}><span><span className="ll" style={{background:"#7E9AB3"}}/> Wake</span><span><span className="ll" style={{background:"#5A5F8A"}}/> Bed</span><span><span className="ll" style={{background:"#C9B07A"}}/> Work</span><span><span className="ll" style={{background:"#D49A6A"}}/> Work out</span><span><span className="ll" style={{background:"#7BA08B"}}/> Outside</span></div></div>}

    {notes.length>0&&<div className="card"><h3 className="ctit">Journal Notes</h3><div className="nl">{notes.map(n=>(<div key={n.key} className="nr"><div className="nd">{n.label}</div><div className="nt">{n.notes}</div></div>))}</div></div>}
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
  const[editMedIdx,setEditMedIdx]=useState(null);const[emName,setEmName]=useState("");const[emDose,setEmDose]=useState("");
  const[showAddMed,setShowAddMed]=useState(false);const[newMedName,setNewMedName]=useState("");const[newMedDose,setNewMedDose]=useState("");
  const[reminders,setReminders]=useState(settings.reminders||[]);
  const[showAddR,setShowAddR]=useState(false);const[newRT,setNewRT]=useState("21:00");const[newRL,setNewRL]=useState("Log mood");

  const saveName=()=>{setS({name:nameVal.trim()});setNameSaved(true);setTimeout(()=>setNameSaved(false),2500);};
  const curPc=pcStep==="new"?pc1:pc2;
  const pcTap=n=>{if(pcStep==="new"){const nx=pc1+n;setPc1(nx);if(nx.length===4)setTimeout(()=>setPcStep("confirm"),200);}else if(pcStep==="confirm"){const nx=pc2+n;setPc2(nx);if(nx.length===4){if(nx===pc1){setS({passcode:nx});setPcStep(null);}else setPc2("");}}};
  const pcDel=()=>{if(pcStep==="new")setPc1(pc1.slice(0,-1));else setPc2(pc2.slice(0,-1));};
  const startEditMed=i=>{setEditMedIdx(i);setEmName(meds[i].name);setEmDose(meds[i].dose);};
  const saveEditMed=()=>{if(!emName.trim())return;const nm=[...meds];nm[editMedIdx]={...nm[editMedIdx],name:emName.trim(),dose:emDose.trim()};setMeds(nm);setEditMedIdx(null);};
  const addMed=()=>{if(!newMedName.trim())return;const key=newMedName.toLowerCase().replace(/\s+/g,"_")+"_"+Date.now();setMeds([...meds,{key,name:newMedName.trim(),dose:newMedDose.trim()||"—"}]);setNewMedName("");setNewMedDose("");setShowAddMed(false);};
  const addReminder=()=>{const nr=[...reminders,{time:newRT,label:newRL,on:true}];setReminders(nr);setS({reminders:nr});setShowAddR(false);if("Notification" in window)Notification.requestPermission();};
  const removeR=i=>{const nr=reminders.filter((_,j)=>j!==i);setReminders(nr);setS({reminders:nr});};
  const toggleR=i=>{const nr=[...reminders];nr[i]={...nr[i],on:!nr[i].on};setReminders(nr);setS({reminders:nr});};

  return(<div className="scr">
    <div className="hh"><h2 className="ht">Settings</h2><button className="bi" onClick={onBack}>✕</button></div>

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
        <div className="set-pad">{[1,2,3,4,5,6,7,8,9,null,0,"del"].map((n,i)=>(<button key={i} className={`lk lksm${n===null?" lke":""}`} onClick={()=>{if(n==="del")pcDel();else if(n!==null)pcTap(String(n));}} disabled={n===null}>{n==="del"?"‹":""+n}</button>))}</div>
        <button className="btn-ghost" onClick={()=>setPcStep(null)}>Cancel</button></div>)}
    </div>

    <div className="card">
      <h3 className="ctit">Reminders</h3>
      <p className="set-h" style={{marginBottom:10}}>Browser notifications. Keep your tab open.</p>
      {reminders.map((r,i)=>(<div key={i} className="set-reminder">
        <div><span className="set-r-time">{r.time}</span><span className="set-r-label">{r.label}</span></div>
        <div className="set-r-acts"><button className={`set-r-toggle${r.on?" set-r-on":""}`} onClick={()=>toggleR(i)}>{r.on?"On":"Off"}</button><button className="btn-ghost" style={{color:"#D4785C",fontSize:11,padding:"2px 6px"}} onClick={()=>removeR(i)}>✕</button></div>
      </div>))}
      {showAddR?(<div className="add-form" style={{marginTop:8}}>
        <div style={{display:"flex",gap:8,marginBottom:8}}><input type="time" className="srm-ti" style={{flex:1}} value={newRT} onChange={e=>setNewRT(e.target.value)}/><input className="add-input" style={{marginBottom:0}} value={newRL} onChange={e=>setNewRL(e.target.value)} placeholder="Label"/></div>
        <div className="add-btns"><button className="btn-ghost" onClick={()=>setShowAddR(false)}>Cancel</button><button className="btn-sm-p" onClick={addReminder}>Add</button></div>
      </div>):(<button className="btn-add" style={{marginTop:4}} onClick={()=>setShowAddR(true)}>+ Add reminder</button>)}
    </div>

    <div className="card">
      <h3 className="ctit">Medications</h3>
      <p className="set-h" style={{marginBottom:10}}>Edit dosage or add new medications here.</p>
      {meds.map((med,i)=>editMedIdx===i?(
        <div key={med.key} className="set-med-edit">
          <input className="add-input" value={emName} onChange={e=>setEmName(e.target.value)} placeholder="Name"/>
          <input className="add-input add-sm" value={emDose} onChange={e=>setEmDose(e.target.value)} placeholder="Dose"/>
          <div className="add-btns"><button className="btn-ghost" onClick={()=>setEditMedIdx(null)}>Cancel</button><button className="btn-sm-p" onClick={saveEditMed}>Save</button></div>
        </div>
      ):(<div key={med.key} className="set-mr"><div className="mi"><div className="mn">{med.name}</div><div className="md-sub">{med.dose}/pill</div></div>
        <div className="set-mr-acts"><button className="rr-edit" onClick={()=>startEditMed(i)}>Edit</button><button className="btn-ghost" style={{color:"#D4785C",fontSize:11,padding:"4px 6px"}} onClick={()=>setMeds(meds.filter((_,j)=>j!==i))}>Remove</button></div></div>))}
      {showAddMed?(<div className="add-form" style={{marginTop:8}}>
        <input className="add-input" value={newMedName} onChange={e=>setNewMedName(e.target.value)} placeholder="Medication name"/>
        <input className="add-input add-sm" value={newMedDose} onChange={e=>setNewMedDose(e.target.value)} placeholder="Dose (e.g. 50mg)"/>
        <div className="add-btns"><button className="btn-ghost" onClick={()=>setShowAddMed(false)}>Cancel</button><button className="btn-sm-p" onClick={addMed}>Add</button></div>
      </div>):(<button className="btn-add" style={{marginTop:8}} onClick={()=>setShowAddMed(true)}>+ Add medication</button>)}
    </div>

    {SHEETS_URL&&<div className="card"><h3 className="ctit">Google Sheets Sync</h3><p className="set-h" style={{marginTop:0}}>Active — data syncs on every save.</p></div>}
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
.scr{padding:0 20px 40px;min-height:100dvh}

.btn-p{width:100%;padding:15px 24px;border-radius:var(--r);border:none;background:var(--tx);color:#fff;font:500 15px/1 'DM Sans',sans-serif;cursor:pointer;transition:all .15s var(--ease);letter-spacing:.01em}
.btn-p:active{transform:scale(.98);opacity:.9}.btn-p.bd{opacity:.25;pointer-events:none}
.btn-s{width:100%;padding:15px 24px;border-radius:var(--r);border:1.5px solid var(--bd);background:transparent;color:var(--tx);font:500 15px/1 'DM Sans',sans-serif;cursor:pointer;transition:all .15s}
.btn-s:hover{border-color:var(--t3)}.btn-s:active{transform:scale(.98)}
.btn-rhythm{width:100%;padding:15px 24px;border-radius:var(--r);border:none;background:#6478A0;color:#fff;font:500 15px/1 'DM Sans',sans-serif;cursor:pointer;transition:all .15s var(--ease)}
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
.w-orb{width:80px;height:80px;border-radius:50%;background:linear-gradient(145deg,#EEF1F7,#E8E4DE 50%,#EFF6F1);display:flex;align-items:center;justify-content:center;margin:0 auto 28px;overflow:hidden;position:relative}
.w-orb-i{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--gn),#6478A0);opacity:.3;animation:orbP 3s ease-in-out infinite}
@keyframes orbP{0%,100%{transform:scale(1);opacity:.3}50%{transform:scale(1.1);opacity:.4}}
.w-orb-ring{position:absolute;inset:6px;border-radius:50%;border:1px solid rgba(123,160,139,.15);animation:ringP 3s ease-in-out infinite .5s}
@keyframes ringP{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.06);opacity:.6}}
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
.set-pad{display:grid;grid-template-columns:repeat(3,56px);gap:8px;margin-bottom:12px}

.cal-top{display:flex;align-items:flex-start;justify-content:space-between;padding:24px 0 16px}
.cal-tr{display:flex;gap:6px;align-items:center}.cal-gr{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:2px}
.cht{font-family:'Source Serif 4',serif;font-weight:400;font-size:22px}.cnav{display:flex;gap:4px}
.streak{display:flex;align-items:center;gap:6px;padding:10px 14px;background:var(--gbg);border-radius:var(--rs);font-size:13px;color:var(--gn);font-weight:400;margin-bottom:16px}
.cg{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:12px}
.clb{font-size:10px;font-weight:500;color:var(--t3);text-align:center;padding:4px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.cc{aspect-ratio:1;border-radius:var(--rs);display:flex;align-items:center;justify-content:center;position:relative;font-size:13px;color:var(--t2);transition:all .2s;cursor:default}
.cc.cl{cursor:pointer}.ce{pointer-events:none}.cl{font-weight:500;color:var(--tx)}
.ct .cn{font-weight:600}.ct::after{content:'';position:absolute;bottom:3px;width:4px;height:4px;border-radius:50%;background:var(--tx)}
.cd{position:absolute;inset:3px;border-radius:7px;transition:opacity .2s}
.csel{box-shadow:inset 0 0 0 1.5px var(--tx)}
.cleg{display:flex;flex-wrap:wrap;gap:6px 10px;margin-bottom:16px;padding:0 2px}
.cli{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--t3)}.cld{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.cact{display:flex;flex-direction:column;gap:10px}

.day-card{background:var(--card);border-radius:var(--r);padding:14px 16px;box-shadow:var(--sh);margin-bottom:16px;cursor:pointer;transition:all .15s;animation:si .25s var(--ease)}
.day-card:active{transform:scale(.99)}
.day-card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.day-card-date{font-size:12px;font-weight:500;color:var(--t3)}
.day-card-arrow{font-size:11px;color:var(--t3)}
.day-card-mood{font-size:15px;font-weight:500;margin-bottom:4px}
.day-card-note{font-size:13px;color:var(--t2);font-weight:300;line-height:1.4;margin-bottom:6px}
.day-chips{display:flex;flex-wrap:wrap;gap:4px}.day-chip{display:inline-block;padding:3px 8px;border-radius:6px;font-size:11px;color:var(--t2);background:var(--warm)}

.ent{padding-top:12px}.et{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.es{font-size:12px;color:var(--t3);font-weight:500;letter-spacing:.04em}
.pb{width:100%;height:3px;background:var(--bd);border-radius:2px;margin-bottom:36px;overflow:hidden}
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

.ni{width:100%;min-height:120px;border-radius:var(--r);border:1.5px solid var(--bd);padding:16px;font:15px/1.55 'DM Sans',sans-serif;resize:vertical;background:transparent;color:var(--tx);transition:border .15s;margin-bottom:12px}
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
.srm-ap{display:flex;gap:2px}
.srm-ab{padding:10px 12px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer;transition:all .15s}
.srm-aon{border-color:var(--tx);background:var(--warm);color:var(--tx)}
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
`;
