import { useState, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, CartesianGrid, ReferenceLine, BarChart, Bar } from "recharts";

/* ═══════════════════════════════════════════════════════════════════════════
   SEED DATA
   ═══════════════════════════════════════════════════════════════════════════ */
const SEED_MOOD = {
  "2026-01-01":{sleep:8,irritability:1,anxiety:3,mood:"mod_dep",notes:"New Year, feeling anxious about the present state and future",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-02":{sleep:8,irritability:1,anxiety:1,mood:"normal",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-03":{sleep:8,irritability:1,anxiety:1,mood:"normal",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-06":{sleep:8,irritability:1,anxiety:1,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-07":{sleep:10,irritability:1,anxiety:1,mood:"normal",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-08":{sleep:8.5,irritability:1,anxiety:2,mood:"normal",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-09":{sleep:8,irritability:1,anxiety:2,mood:"normal",notes:"Potential job Interview",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-10":{sleep:9.5,irritability:1,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-15":{sleep:10,irritability:1,anxiety:1,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-16":{sleep:10,irritability:2,anxiety:2,mood:"mod_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-17":{sleep:9,irritability:1,anxiety:1,mood:"normal",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-18":{sleep:9,irritability:2,anxiety:1,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-25":{sleep:9.5,irritability:1,anxiety:2.5,mood:"mild_dep",notes:"Bouldering with Friends",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-01-26":{sleep:11,irritability:2,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"}}},
  "2026-02-01":{sleep:8,irritability:1,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-02":{sleep:9,irritability:1,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-03":{sleep:9,irritability:1,anxiety:2.5,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-04":{sleep:9,irritability:1,anxiety:2.5,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-06":{sleep:null,irritability:null,anxiety:null,mood:"sev_dep",notes:"Day of the birthday, not wanting to leave the house",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-07":{sleep:null,irritability:null,anxiety:3,mood:"sev_dep",notes:"Strong depression, brief thought of suicide",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-10":{sleep:10,irritability:2,anxiety:3,mood:"mild_dep",notes:"Photoshoot Outdoor",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-15":{sleep:null,irritability:1,anxiety:3,mood:"mild_dep",notes:"Slight episode during cleaning, Dumpling Making event, high anxiety",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-16":{sleep:8,irritability:1,anxiety:2,mood:"normal",notes:"CNY New Year, hosting, drank alcohol",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
  "2026-02-18":{sleep:null,irritability:1,anxiety:2,mood:"mild_dep",notes:"",meds:{lamotrigine:{ct:1,dose:"200mg"},quetiapine:{ct:1,dose:"100mg"},lithium:{ct:4,dose:"300mg"},levothyroxine:{ct:1,dose:"50mcg"}}},
};
const SEED_SRM = {
  "2026-02-16":{items:[{id:"bed",time:"09:15",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"exercise",time:"03:30",am:false,didNot:false,withOthers:false,who:[],whoText:"",engagement:0}]},
  "2026-02-17":{items:[{id:"bed",time:"10:35",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"beverage",time:"10:45",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"breakfast",time:"11:45",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"outside",time:"11:00",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0}]},
  "2026-02-19":{items:[{id:"bed",time:"10:00",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"beverage",time:"10:25",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"breakfast",time:"10:30",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0},{id:"outside",time:"10:45",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0}]},
};

/* ═══════════════════════════════════════════════════════════════════════════ */
const MM={sev_elev:{v:3,label:"Severe Elevated",color:"#D4785C",short:"Sev ↑",bg:"#FDF0EC"},mod_elev:{v:2,label:"Moderate Elevated",color:"#D49A6A",short:"Mod ↑",bg:"#FDF5EE"},mild_elev:{v:1,label:"Mild Elevated",color:"#C9B07A",short:"Mild ↑",bg:"#FAF6ED"},normal:{v:0,label:"Within Normal",color:"#7BA08B",short:"Normal",bg:"#EFF6F1"},mild_dep:{v:-1,label:"Mild Depressed",color:"#7E9AB3",short:"Mild ↓",bg:"#EEF3F8"},mod_dep:{v:-2,label:"Moderate Depressed",color:"#6478A0",short:"Mod ↓",bg:"#EDF0F6"},sev_dep:{v:-3,label:"Severe Depressed",color:"#5A5F8A",short:"Sev ↓",bg:"#EDEEF4"}};
const MOOD_OPTS=[{key:"sev_elev",emoji:"⚡",label:"Severe Elevated",sub:"Significant impairment · not able to work"},{key:"mod_elev",emoji:"↗",label:"Moderate Elevated",sub:"Significant impairment · able to work"},{key:"mild_elev",emoji:"☀",label:"Mild Elevated",sub:"Without significant impairment"},{key:"normal",emoji:"◐",label:"Within Normal",sub:"No symptoms"},{key:"mild_dep",emoji:"☁",label:"Mild Depressed",sub:"Without significant impairment"},{key:"mod_dep",emoji:"🌧",label:"Moderate Depressed",sub:"Significant impairment · able to work"},{key:"sev_dep",emoji:"■",label:"Severe Depressed",sub:"Significant impairment · not able to work"}];
const DEF_MEDS=[{key:"lamotrigine",name:"Lamotrigine",dose:"200mg"},{key:"quetiapine",name:"Quetiapine",dose:"100mg"},{key:"lithium",name:"Lithium Carbonate",dose:"300mg"},{key:"levothyroxine",name:"Levothyroxine",dose:"50mcg"},{key:"naltrexone",name:"Naltrexone",dose:"50mg"}];
const SRM_ACT=[{id:"bed",label:"Got out of bed",emoji:"🛏"},{id:"beverage",label:"Morning beverage",emoji:"☕"},{id:"breakfast",label:"Breakfast",emoji:"🍳"},{id:"outside",label:"Went outside",emoji:"🚪"},{id:"exercise",label:"Physical exercise",emoji:"🏃"},{id:"work",label:"Started work / study",emoji:"💼"},{id:"lunch",label:"Lunch",emoji:"🥗"},{id:"dinner",label:"Dinner",emoji:"🍽"},{id:"home",label:"Returned home",emoji:"🏠"},{id:"bedtime",label:"Went to bed",emoji:"🌙"}];
const WHO_OPTS=[{key:"spouse",label:"Spouse / Partner"},{key:"friend",label:"Friend"},{key:"family",label:"Family member"},{key:"other",label:"Other"}];
const ENG_OPTS=[{v:1,label:"Just present"},{v:2,label:"Actively involved"},{v:3,label:"Very stimulating"}];
const SEV=[{v:0,l:"None"},{v:1,l:"Mild"},{v:2,l:"Moderate"},{v:3,l:"Severe"}];
const MO=["January","February","March","April","May","June","July","August","September","October","November","December"];
const DW=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const dk=(y,m,d)=>`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const dIn=(y,m)=>new Date(y,m+1,0).getDate();
const fDay=(y,m)=>new Date(y,m,1).getDay();
const tdk=()=>{const d=new Date();return dk(d.getFullYear(),d.getMonth(),d.getDate());};

function loadJ(k,fb){try{const s=localStorage.getItem(k);return s?JSON.parse(s):fb;}catch{return fb;}}
function loadMood(){try{const s=localStorage.getItem("mt_mood");return s?{...SEED_MOOD,...JSON.parse(s)}:{...SEED_MOOD};}catch{return{...SEED_MOOD};}}
function saveMood(d){const u={};for(const k in d)if(!SEED_MOOD[k])u[k]=d[k];localStorage.setItem("mt_mood",JSON.stringify(u));}
function loadSRM(){try{const s=localStorage.getItem("mt_srm");return s?{...SEED_SRM,...JSON.parse(s)}:{...SEED_SRM};}catch{return{...SEED_SRM};}}
function saveSRM(d){const u={};for(const k in d)if(!SEED_SRM[k])u[k]=d[k];localStorage.setItem("mt_srm",JSON.stringify(u));}
function loadSettings(){return loadJ("mt_set",{});}
function saveSettings(s){localStorage.setItem("mt_set",JSON.stringify(s));}
function loadMeds(){return loadJ("mt_meds",DEF_MEDS);}
function saveMedsLS(m){localStorage.setItem("mt_meds",JSON.stringify(m));}

/* ═══════════════════════════════════════════════════════════════════════════
   APP
   ═══════════════════════════════════════════════════════════════════════════ */
export default function App(){
  const[screen,setScreen]=useState("welcome");
  const[mood,setMood]=useState(loadMood);
  const[srm,setSrm]=useState(loadSRM);
  const[settings,setSS]=useState(loadSettings);
  const[meds,setMedsS]=useState(loadMeds);
  const[vm,setVm]=useState(()=>{const d=new Date();return[d.getFullYear(),d.getMonth()];});
  const[locked,setLocked]=useState(!!loadSettings().passcode);

  const setS=s=>{const n={...settings,...s};setSS(n);saveSettings(n);};
  const setMeds=m=>{setMedsS(m);saveMedsLS(m);};
  const name=settings.name||"";

  const go=useCallback(s=>{
    if((s==="entry"||s==="srm")&&settings.passcode&&locked){
      setScreen("lock");window.__afterUnlock=s;
    } else setScreen(s);
  },[settings.passcode,locked]);

  return(<>
    <style>{CSS}</style>
    <div className="app">
      {screen==="welcome"&&<Welcome onGo={s=>setScreen(s)}/>}
      {screen==="lock"&&<Lock passcode={settings.passcode} onOk={()=>{setLocked(false);setScreen(window.__afterUnlock||"calendar");}} onX={()=>setScreen("calendar")}/>}
      {screen==="calendar"&&<Cal mood={mood} srm={srm} vm={vm} setVm={setVm} name={name} onAdd={()=>go("entry")} onSrm={()=>go("srm")} onHist={()=>setScreen("history")} onSet={()=>setScreen("settings")}/>}
      {screen==="entry"&&<MoodEntry mood={mood} meds={meds} onSave={e=>{const k=tdk();const n={...mood,[k]:e};setMood(n);saveMood(n);setScreen("confirm");}} onX={()=>setScreen("calendar")}/>}
      {screen==="srm"&&<SRMEntry srm={srm} onSave={e=>{const k=tdk();const n={...srm,[k]:e};setSrm(n);saveSRM(n);setScreen("confirmS");}} onX={()=>setScreen("calendar")}/>}
      {screen==="confirm"&&<Confirm msg="Mood entry logged" sub="You showed up today. That matters." onDone={()=>setScreen("calendar")}/>}
      {screen==="confirmS"&&<Confirm msg="Rhythm logged" sub="Tracking your rhythm is a powerful step." onDone={()=>setScreen("calendar")}/>}
      {screen==="history"&&<Hist mood={mood} srm={srm} name={name} onBack={()=>setScreen("calendar")}/>}
      {screen==="settings"&&<Settings settings={settings} setS={setS} meds={meds} setMeds={setMeds} onBack={()=>setScreen("calendar")}/>}
    </div>
  </>);
}

/* ── WELCOME ── */
function Welcome({onGo}){
  return(<div className="scr welcome">
    <div className="w-top">
      <div className="w-orb"><div className="w-orb-i"/></div>
      <h1 className="w-t">Mood Tracker</h1>
      <p className="w-s">A quiet place to check in with yourself. Track mood, sleep, rhythm, and medication — at your own pace.</p>
    </div>
    <div className="w-b"><button className="btn-p" onClick={()=>onGo("calendar")}>Get Started</button></div>
  </div>);
}

/* ── LOCK ── */
function Lock({passcode,onOk,onX}){
  const[input,setInput]=useState("");
  const[err,setErr]=useState(false);
  const[shake,setShake]=useState(false);
  const tap=n=>{if(input.length>=4)return;const nx=input+n;setInput(nx);setErr(false);
    if(nx.length===4){if(nx===passcode)setTimeout(onOk,200);else{setShake(true);setErr(true);setTimeout(()=>{setInput("");setShake(false);},500);}}
  };
  return(<div className="scr lock-scr">
    <button className="btn-ghost lock-x" onClick={onX}>Cancel</button>
    <div className="lock-in">
      <div className="lock-ico">🔒</div>
      <p className="lock-lbl">{err?"Incorrect passcode":"Enter passcode"}</p>
      <div className={`lock-dots${shake?" lock-shake":""}`}>{[0,1,2,3].map(i=><div key={i} className={`lock-dot${i<input.length?" on":""}`}/>)}</div>
      <div className="lock-pad">
        {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((n,i)=>(<button key={i} className={`lk${n===""?" lke":""}`} onClick={()=>n==="⌫"?setInput(input.slice(0,-1)):n!==""&&tap(String(n))} disabled={n===""}>{n}</button>))}
      </div>
    </div>
  </div>);
}

/* ── CALENDAR ── */
function Cal({mood,srm,vm,setVm,name,onAdd,onSrm,onHist,onSet}){
  const[y,m]=vm;const days=dIn(y,m);const off=fDay(y,m);
  const now=new Date();const td=now.getFullYear()===y&&now.getMonth()===m?now.getDate():-1;
  const cells=[];
  for(let i=0;i<off;i++) cells.push(<div key={`b${i}`} className="cc ce"/>);
  for(let d=1;d<=days;d++){
    const k=dk(y,m,d);const e=mood[k];const s=srm[k];const isT=d===td;
    const mc=e?.mood?MM[e.mood]:null;
    cells.push(<div key={d} className={`cc${e||s?" cl":""}${isT?" ct":""}`}>
      {mc&&<div className="cd" style={{background:mc.color,opacity:.2}}/>}
      {s&&!mc&&<div className="cd" style={{background:"#C9B07A",opacity:.12}}/>}
      <span className="cn">{d}</span>
    </div>);
  }
  let streak=0;const sd=new Date();
  for(let i=0;i<90;i++){const k=dk(sd.getFullYear(),sd.getMonth(),sd.getDate());if(mood[k]||srm[k])streak++;else if(i>0)break;sd.setDate(sd.getDate()-1);}
  const gr=()=>{const h=now.getHours();return h<12?"Good morning":h<17?"Good afternoon":"Good evening";};
  return(<div className="scr">
    <div className="cal-top">
      <div><p className="cal-gr">{gr()}{name?`, ${name}`:""}</p><h2 className="cht">{MO[m]} {y}</h2></div>
      <div className="cal-tr"><button className="bi" onClick={onSet} title="Settings">⚙</button><div className="cnav"><button className="bi" onClick={()=>setVm(m===0?[y-1,11]:[y,m-1])}>‹</button><button className="bi" onClick={()=>setVm(m===11?[y+1,0]:[y,m+1])}>›</button></div></div>
    </div>
    {streak>1&&<div className="streak">✦ {streak} day streak{name?`, ${name}`:""}</div>}
    <div className="cg">{DW.map(d=><div key={d} className="clb">{d}</div>)}{cells}</div>
    <div className="cleg">{Object.entries(MM).map(([k,v])=>(<div key={k} className="cli"><div className="cld" style={{background:v.color}}/><span>{v.short}</span></div>))}</div>
    <div className="cact">
      <button className="btn-p" onClick={onAdd}>{mood[tdk()]?"Edit Mood Entry":"Log Mood"}</button>
      <button className="btn-p" onClick={onSrm}>{srm[tdk()]?"Edit Daily Rhythm":"Log Daily Rhythm"}</button>
      <button className="btn-s" onClick={onHist}>View Insights</button>
    </div>
  </div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOOD ENTRY — meds read-only dose, no add button
   ═══════════════════════════════════════════════════════════════════════════ */
const MSTEPS=[
  {id:"mood",q:"How was your mood?",s:"Yesterday's overall mood"},
  {id:"sleep",q:"Hours of sleep last night?",s:"Roughly, in half hours"},
  {id:"anxiety",q:"Anxiety level?",s:"0 none · 1 mild · 2 moderate · 3 severe"},
  {id:"irritability",q:"Irritability level?",s:"0 none · 1 mild · 2 moderate · 3 severe"},
  {id:"meds",q:"Medications taken yesterday",s:"Adjust pill counts"},
  {id:"notes",q:"Anything to note?",s:"Optional — events, thoughts, anything"},
];

function MoodEntry({mood,meds,onSave,onX}){
  const[step,setStep]=useState(0);
  const[entry,setEntry]=useState(()=>{
    const t=mood[tdk()];
    if(t)return{...t,meds:{...t.meds}};
    const m={};meds.forEach(med=>{m[med.key]={ct:med.key==="naltrexone"?0:1,dose:med.dose};});
    return{mood:null,sleep:8,anxiety:1,irritability:1,meds:m,notes:""};
  });
  const tot=MSTEPS.length;const isR=step===tot;
  const prog=((step+(isR?1:0))/(tot+1))*100;
  const canN=step===0?entry.mood!==null:true;
  const upd=(k,v)=>setEntry(e=>({...e,[k]:v}));
  const updMC=(k,v)=>setEntry(e=>({...e,meds:{...e.meds,[k]:{...e.meds[k],ct:Math.max(0,v)}}}));

  const [editIdx,setEditIdx]=useState(null); // for review per-item edit

  // If editIdx is set, show that step instead of review
  const showStep=editIdx!==null?editIdx:step;
  const showReview=editIdx===null&&isR;

  const renderStep=(si)=>{
    const st=MSTEPS[si];
    return(<div className="qa" key={si}>
      <h2 className="qt">{st.q}</h2><p className="qs">{st.s}</p>
      {st.id==="mood"&&(<div className="ol">{MOOD_OPTS.map(o=>{const sel=entry.mood===o.key;const mc=MM[o.key];
        return(<button key={o.key} className={`oc${sel?" os":""}`} style={sel?{borderColor:mc.color,background:mc.bg}:{}} onClick={()=>upd("mood",o.key)}>
          <div className="ocl"><span className="oce">{o.emoji}</span><div><div className="ocn">{o.label}</div><div className="ocd">{o.sub}</div></div></div>
          <div className={`or${sel?" orn":""}`} style={sel?{borderColor:mc.color,background:mc.color}:{}}>{sel?"✓":""}</div>
        </button>);})}</div>)}
      {st.id==="sleep"&&(<div className="np">
        <button className="br" onClick={()=>upd("sleep",Math.max(0,(entry.sleep||0)-.5))}>−</button>
        <div className="nv"><span className="nb">{entry.sleep??0}</span><span className="nu">hrs</span></div>
        <button className="br" onClick={()=>upd("sleep",Math.min(24,(entry.sleep||0)+.5))}>+</button>
      </div>)}
      {(st.id==="anxiety"||st.id==="irritability")&&(<div className="sg">{SEV.map(s=>{const sel=entry[st.id]===s.v;
        return(<button key={s.v} className={`sc${sel?" ss":""}`} onClick={()=>upd(st.id,s.v)}><span className="sn">{s.v}</span><span className="sl">{s.l}</span></button>);})}</div>)}
      {st.id==="meds"&&(<div className="ml">{meds.map(med=>{const me=entry.meds[med.key]||{ct:0,dose:med.dose};
        return(<div key={med.key} className={`mr${me.ct>0?" mo":""}`}>
          <div className="mi"><div className="mn">{med.name}</div><div className="md-sub">{med.dose} / pill</div></div>
          <div className="mc"><button className="bs" onClick={()=>updMC(med.key,me.ct-1)}>−</button><span className="mv">{me.ct}</span><button className="bs" onClick={()=>updMC(med.key,me.ct+1)}>+</button></div>
        </div>);})}</div>)}
      {st.id==="notes"&&(<textarea className="ni" value={entry.notes||""} onChange={e=>upd("notes",e.target.value)} placeholder="Had a good walk today..." rows={4}/>)}
      <button className={`btn-p en${(si===0&&!entry.mood)?" bd":""}`}
        onClick={()=>{if(editIdx!==null){setEditIdx(null);}else setStep(Math.min(si+1,tot));}}
        disabled={si===0&&!entry.mood}>
        {editIdx!==null?"Done":si===tot-1?"Review":"Next"}
      </button>
    </div>);
  };

  return(<div className="scr ent">
    <div className="et">
      <button className="bi" onClick={()=>{if(editIdx!==null)setEditIdx(null);else if(step>0)setStep(step-1);else onX();}}>‹</button>
      <span className="es">{showReview?"Review":editIdx!==null?"Editing":`${showStep+1} / ${tot}`}</span>
      <button className="btn-ghost" onClick={onX}>Cancel</button>
    </div>
    <div className="pb"><div className="pf" style={{width:`${prog}%`}}/></div>
    {editIdx!==null?renderStep(editIdx):(!isR?renderStep(step):(
      <div className="qa" key="rv">
        <h2 className="qt">Looks good?</h2>
        <p className="qs">{new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</p>
        <div className="rc">
          <RvRow l="Mood" v={entry.mood?<span style={{color:MM[entry.mood].color,fontWeight:500}}>{MM[entry.mood].label}</span>:"—"} onEdit={()=>setEditIdx(0)}/>
          <RvRow l="Sleep" v={entry.sleep!=null?`${entry.sleep} hrs`:"—"} onEdit={()=>setEditIdx(1)}/>
          <RvRow l="Anxiety" v={entry.anxiety!=null?`${entry.anxiety} / 3`:"—"} onEdit={()=>setEditIdx(2)}/>
          <RvRow l="Irritability" v={entry.irritability!=null?`${entry.irritability} / 3`:"—"} onEdit={()=>setEditIdx(3)}/>
          <RvRow l="Medications" v={Object.entries(entry.meds).filter(([,v])=>v.ct>0).map(([k,v])=>`${meds.find(m=>m.key===k)?.name||k} ×${v.ct}`).join(", ")||"None"} onEdit={()=>setEditIdx(4)}/>
          <RvRow l="Notes" v={entry.notes||"—"} onEdit={()=>setEditIdx(5)}/>
        </div>
        <button className="btn-p" onClick={()=>onSave(entry)}>Confirm</button>
      </div>
    ))}
  </div>);
}

function RvRow({l,v,onEdit}){
  return(<div className="rr"><div className="rr-left"><span className="rl">{l}</span><span className="rv">{v}</span></div><button className="rr-edit" onClick={onEdit}>Edit</button></div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SRM ENTRY — improved social context, per-item edit in review
   ═══════════════════════════════════════════════════════════════════════════ */
function emptyItem(id){return{id,time:"",am:true,didNot:false,withOthers:false,who:[],whoText:"",engagement:0};}

function SRMEntry({srm,onSave,onX}){
  const[customActs,setCA]=useState(()=>loadJ("mt_ca",[]));
  const allActs=[...SRM_ACT,...customActs];

  const[items,setItems]=useState(()=>{
    const ex=srm[tdk()];
    if(ex?.items){const map={};ex.items.forEach(i=>{map[i.id]=i;});return allActs.map(a=>map[a.id]||emptyItem(a.id));}
    return allActs.map(a=>emptyItem(a.id));
  });

  const[step,setStep]=useState(0);
  const[editIdx,setEditIdx]=useState(null);
  const[showAddAct,setShowAddAct]=useState(false);
  const[newActLabel,setNewActLabel]=useState("");

  const tot=items.length;
  const isReview=editIdx===null&&step===tot;
  const si=editIdx!==null?editIdx:step;
  const prog=((step+(isReview?1:0))/(tot+2))*100;

  const cur=items[si]||emptyItem("?");
  const act=allActs[si]||{emoji:"📌",label:cur.id};

  const upd=(field,val)=>setItems(p=>{const n=[...p];n[si]={...n[si],[field]:val};return n;});
  const updWho=(key)=>setItems(p=>{const n=[...p];const c=n[si];const w=c.who.includes(key)?c.who.filter(k=>k!==key):[...c.who,key];n[si]={...c,who:w};return n;});

  const addCustom=()=>{
    if(!newActLabel.trim())return;
    const id="c_"+Date.now();
    const na=[...customActs,{id,label:newActLabel.trim(),emoji:"📌"}];
    setCA(na);localStorage.setItem("mt_ca",JSON.stringify(na));
    setItems(p=>[...p,emptyItem(id)]);
    setNewActLabel("");setShowAddAct(false);
  };

  const renderActivity=(idx)=>{
    const it=items[idx];const ac=allActs[idx]||customActs.find(c=>c.id===it?.id)||{emoji:"📌",label:it?.id};
    if(!it)return null;
    return(<div className="qa" key={idx+"a"}>
      <div className="srm-em">{ac.emoji}</div>
      <h2 className="qt">{ac.label}</h2>
      <p className="qs">What time? With anyone?</p>

      {/* Time */}
      <div className="srm-tr">
        <label className="srm-lb">Time</label>
        <input type="time" className="srm-ti" value={it.time} onChange={e=>upd("time",e.target.value)}/>
        <div className="srm-ap">
          <button className={`srm-ab${it.am?" srm-aon":""}`} onClick={()=>upd("am",true)}>AM</button>
          <button className={`srm-ab${!it.am?" srm-aon":""}`} onClick={()=>upd("am",false)}>PM</button>
        </div>
      </div>

      {/* Didn't do — secondary, below time */}
      <button className={`srm-skip${it.didNot?" srm-skip-on":""}`} onClick={()=>upd("didNot",!it.didNot)}>
        {it.didNot?"✓ ":""}Didn't do this today
      </button>

      {!it.didNot&&(<>
        {/* Social: others involved? */}
        <div className="srm-sec">
          <label className="srm-lb">Were others involved?</label>
          <div className="srm-yn">
            <button className={`srm-yb${it.withOthers?" srm-yb-on":""}`} onClick={()=>upd("withOthers",true)}>Yes</button>
            <button className={`srm-yb${!it.withOthers?" srm-yb-on":""}`} onClick={()=>upd("withOthers",false)}>No</button>
          </div>
        </div>

        {it.withOthers&&(<>
          <div className="srm-sec">
            <label className="srm-lb">Who?</label>
            <div className="srm-who-grid">
              {WHO_OPTS.map(w=>(<button key={w.key} className={`srm-wb${it.who.includes(w.key)?" srm-wb-on":""}`} onClick={()=>updWho(w.key)}>{w.label}</button>))}
            </div>
            {it.who.some(w=>w!=="spouse")&&(
              <input className="srm-who-text" value={it.whoText} onChange={e=>upd("whoText",e.target.value)} placeholder="Name (optional)"/>
            )}
          </div>

          <div className="srm-sec">
            <label className="srm-lb">Level of engagement</label>
            <div className="srm-eng">
              {ENG_OPTS.map(e=>(<button key={e.v} className={`srm-eb${it.engagement===e.v?" srm-eb-on":""}`} onClick={()=>upd("engagement",e.v)}>{e.v}. {e.label}</button>))}
            </div>
          </div>
        </>)}
      </>)}

      <button className="btn-p en" onClick={()=>{if(editIdx!==null)setEditIdx(null);else setStep(Math.min(idx+1,tot));}}>
        {editIdx!==null?"Done":idx===tot-1?"Review":"Next"}
      </button>
    </div>);
  };

  const socialSummary=(it)=>{
    if(it.didNot)return"Skipped";
    let s=it.time?(it.time+" "+(it.am?"AM":"PM")):"No time";
    if(it.withOthers){
      const whoLabels=it.who.map(w=>WHO_OPTS.find(o=>o.key===w)?.label||w);
      s+=` · with ${whoLabels.join(", ")}`;
      if(it.whoText)s+=` (${it.whoText})`;
      const eng=ENG_OPTS.find(e=>e.v===it.engagement);
      if(eng)s+=` · ${eng.label.toLowerCase()}`;
    } else {s+=" · alone";}
    return s;
  };

  return(<div className="scr ent">
    <div className="et">
      <button className="bi" onClick={()=>{if(editIdx!==null)setEditIdx(null);else if(step>0)setStep(step-1);else onX();}}>‹</button>
      <span className="es">{isReview?"Review":editIdx!==null?"Editing":`${si+1} / ${tot}`}</span>
      <button className="btn-ghost" onClick={onX}>Cancel</button>
    </div>
    <div className="pb"><div className="pf" style={{width:`${prog}%`}}/></div>

    {editIdx!==null?renderActivity(editIdx):(!isReview?renderActivity(step):(
      <div className="qa" key="rv">
        <h2 className="qt">Your daily rhythm</h2>
        <p className="qs">{new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</p>
        <div className="rc">
          {items.map((it,i)=>{
            const ac=allActs[i]||{emoji:"📌",label:it.id};
            return(<RvRow key={it.id} l={`${ac.emoji} ${ac.label}`} v={socialSummary(it)} onEdit={()=>setEditIdx(i)}/>);
          })}
        </div>

        {/* Add activity here in review */}
        {showAddAct?(
          <div className="add-form">
            <input className="add-input" value={newActLabel} onChange={e=>setNewActLabel(e.target.value)} placeholder="Activity name"/>
            <div className="add-btns"><button className="btn-ghost" onClick={()=>setShowAddAct(false)}>Cancel</button><button className="btn-sm-p" onClick={addCustom}>Add</button></div>
          </div>
        ):(<button className="btn-add" onClick={()=>setShowAddAct(true)}>+ Add another activity</button>)}

        <button className="btn-p" style={{marginTop:12}} onClick={()=>onSave({items})}>Confirm</button>
      </div>
    ))}
  </div>);
}

/* ── CONFIRM ── */
function Confirm({msg,sub,onDone}){
  useEffect(()=>{const t=setTimeout(onDone,2400);return()=>clearTimeout(t);},[onDone]);
  return(<div className="scr cfs"><div className="cfi">
    <div className="cfc"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M14 25L21 32L34 18" stroke="#7BA08B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><animate attributeName="stroke-dasharray" from="0 50" to="50 50" dur="0.5s" fill="freeze"/></path></svg></div>
    <h2 className="cft">{msg}</h2><p className="cfp">{sub}</p>
  </div></div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORY
   ═══════════════════════════════════════════════════════════════════════════ */
function Hist({mood,srm,name,onBack}){
  const sorted=Object.entries(mood).filter(([,e])=>e.mood||e.sleep||e.anxiety!=null).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,e])=>{const[y,m,d]=k.split("-").map(Number);return{key:k,day:d,month:m,year:y,label:`${MO[m-1].slice(0,3)} ${d}`,sl:`${m}/${d}`,...e,mv:e.mood?MM[e.mood].v:null};});
  const wM=sorted.filter(e=>e.mv!=null);const wS=sorted.filter(e=>e.sleep!=null);const wA=sorted.filter(e=>e.anxiety!=null);
  const avg=a=>a.length?(a.reduce((s,x)=>s+x,0)/a.length):null;
  const moodData=wM.map(e=>({n:e.sl,mood:e.mv,f:e.label}));
  const comboData=sorted.filter(e=>e.sleep!=null||e.anxiety!=null).map(e=>({n:e.sl,sleep:e.sleep,anxiety:e.anxiety,f:e.label}));
  const notes=sorted.filter(e=>e.notes?.trim());
  const srmSorted=Object.entries(srm).sort(([a],[b])=>a.localeCompare(b));
  const srmSocial=srmSorted.map(([k,v])=>{const[,m,d]=k.split("-").map(Number);const social=(v.items||[]).filter(i=>!i.didNot&&i.withOthers).length;const total=(v.items||[]).filter(i=>!i.didNot).length;return{name:`${m}/${d}`,social,total};});
  const srmChartData=srmSorted.map(([k,v])=>{const[,m,d]=k.split("-").map(Number);const out={name:`${m}/${d}`};(v.items||[]).forEach(item=>{if(item.time&&!item.didNot){const[h,mi]=(item.time||"0:0").split(":").map(Number);const totalMin=item.am?(h*60+mi):((h===12?12:h+12)*60+mi);out[item.id]=totalMin/60;}});return out;});

  const MTT=({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0].payload;const mk=Object.entries(MM).find(([,v])=>v.v===d.mood);return(<div className="tt"><div className="ttd">{d.f}</div>{mk&&<div style={{color:mk[1].color}}>{mk[1].label}</div>}</div>);};
  const CTT=({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0].payload;return(<div className="tt"><div className="ttd">{d.f}</div>{d.sleep!=null&&<div>Sleep: {d.sleep} hrs</div>}{d.anxiety!=null&&<div>Anxiety: {d.anxiety}/3</div>}</div>);};
  const exCSV=()=>{const h="Date,Mood,Sleep,Anxiety,Irritability,Medications,Notes\n";const r=sorted.map(e=>{const ms=e.meds?Object.entries(e.meds).filter(([,v])=>v.ct>0).map(([k,v])=>`${k}:${v.ct}`).join("; "):"";return`${e.key},${e.mood||""},${e.sleep??""},${e.anxiety??""},${e.irritability??""},"${ms}","${(e.notes||"").replace(/"/g,'""')}"`;}).join("\n");const b=new Blob([h+r],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`mood-tracker-${tdk()}.csv`;a.click();};

  return(<div className="scr">
    <div className="hh"><h2 className="ht">{name?`${name}'s `:""}Insights</h2><div className="ha"><button className="bx" onClick={exCSV}>↓ Export</button><button className="bi" onClick={onBack}>✕</button></div></div>
    <div className="sr">
      <div className="sb"><div className="sv">{sorted.length}</div><div className="sbl">Days Logged</div></div>
      <div className="sb"><div className="sv">{avg(wS.map(e=>e.sleep))?.toFixed(1)??"—"}</div><div className="sbl">Avg Sleep</div></div>
      <div className="sb"><div className="sv">{avg(wA.map(e=>e.anxiety))?.toFixed(1)??"—"}</div><div className="sbl">Avg Anxiety</div></div>
    </div>
    <div className="card"><h3 className="ctit">Mood Over Time</h3><div className="cw">
      <ResponsiveContainer width="100%" height={200}><AreaChart data={moodData} margin={{top:8,right:8,left:-24,bottom:4}}>
        <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#D4785C" stopOpacity={.15}/><stop offset="50%" stopColor="#7BA08B" stopOpacity={.08}/><stop offset="100%" stopColor="#5A5F8A" stopOpacity={.2}/></linearGradient></defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/>
        <YAxis domain={[-3,3]} ticks={[-3,-2,-1,0,1,2,3]} tick={{fontSize:9,fill:"#9E9790"}} tickFormatter={v=>{const m={3:"Sev↑",2:"Mod↑",1:"Mild↑",0:"OK","-1":"Mild↓","-2":"Mod↓","-3":"Sev↓"};return m[v]||v;}}/>
        <ReferenceLine y={0} stroke="#7BA08B" strokeDasharray="4 4" strokeOpacity={.5}/><Tooltip content={<MTT/>}/>
        <Area type="monotone" dataKey="mood" stroke="#6478A0" strokeWidth={2} fill="url(#mg)" dot={{r:3,fill:"#6478A0",strokeWidth:0}} activeDot={{r:5,fill:"#6478A0"}} connectNulls/>
      </AreaChart></ResponsiveContainer>
    </div><div className="mleg">{Object.entries(MM).map(([k,v])=>(<div key={k} className="cli"><div className="cld" style={{background:v.color}}/><span>{v.short}</span></div>))}</div></div>

    <div className="card"><h3 className="ctit">Sleep & Anxiety</h3><div className="cw">
      <ResponsiveContainer width="100%" height={180}><LineChart data={comboData} margin={{top:8,right:8,left:-24,bottom:4}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="n" tick={{fontSize:10,fill:"#9E9790"}} interval="preserveStartEnd"/><YAxis tick={{fontSize:10,fill:"#9E9790"}}/>
        <Tooltip content={<CTT/>}/><Line type="monotone" dataKey="sleep" stroke="#7BA08B" strokeWidth={2} dot={{r:2.5,fill:"#7BA08B",strokeWidth:0}} connectNulls/>
        <Line type="monotone" dataKey="anxiety" stroke="#D4785C" strokeWidth={2} dot={{r:2.5,fill:"#D4785C",strokeWidth:0}} connectNulls strokeDasharray="4 2"/>
      </LineChart></ResponsiveContainer>
    </div><div className="cleg2"><span><span className="ll" style={{background:"#7BA08B"}}/> Sleep</span><span><span className="ll" style={{background:"#D4785C"}}/> Anxiety</span></div></div>

    {srmSorted.length>0&&(<div className="card"><h3 className="ctit">Rhythm — Social Engagement</h3><div className="cw">
      <ResponsiveContainer width="100%" height={140}><BarChart data={srmSocial} margin={{top:8,right:8,left:-24,bottom:4}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="name" tick={{fontSize:10,fill:"#9E9790"}}/><YAxis tick={{fontSize:10,fill:"#9E9790"}}/>
        <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0].payload;return(<div className="tt"><div className="ttd">{d.name}</div><div>{d.social}/{d.total} social</div></div>);}}/>
        <Bar dataKey="total" fill="#E8E4DE" radius={[4,4,0,0]}/><Bar dataKey="social" fill="#C9B07A" radius={[4,4,0,0]}/>
      </BarChart></ResponsiveContainer>
    </div><div className="cleg2"><span><span className="ll" style={{background:"#C9B07A"}}/> Social</span><span><span className="ll" style={{background:"#E8E4DE"}}/> Total</span></div></div>)}

    {srmChartData.length>0&&srmChartData.some(d=>d.bed||d.bedtime)&&(<div className="card"><h3 className="ctit">Rhythm — Wake & Bed Times</h3><div className="cw">
      <ResponsiveContainer width="100%" height={150}><LineChart data={srmChartData} margin={{top:8,right:8,left:-24,bottom:4}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DE" vertical={false}/><XAxis dataKey="name" tick={{fontSize:10,fill:"#9E9790"}}/><YAxis tick={{fontSize:10,fill:"#9E9790"}} domain={[6,24]} tickFormatter={v=>{const h=Math.floor(v);return`${h>12?h-12:h}${h>=12?"pm":"am"}`;}}/>
        <Tooltip content={({active,payload})=>{if(!active||!payload?.length)return null;return(<div className="tt">{payload.filter(p=>p.value).map((p,i)=>(<div key={i}>{p.dataKey==="bed"?"Wake":p.dataKey}: {Math.floor(p.value)}:{String(Math.round((p.value%1)*60)).padStart(2,"0")}</div>))}</div>);}}/>
        <Line type="monotone" dataKey="bed" stroke="#7E9AB3" strokeWidth={2} dot={{r:3,fill:"#7E9AB3",strokeWidth:0}} connectNulls/>
        <Line type="monotone" dataKey="bedtime" stroke="#5A5F8A" strokeWidth={2} dot={{r:3,fill:"#5A5F8A",strokeWidth:0}} connectNulls/>
      </LineChart></ResponsiveContainer>
    </div><div className="cleg2"><span><span className="ll" style={{background:"#7E9AB3"}}/> Wake</span><span><span className="ll" style={{background:"#5A5F8A"}}/> Bed</span></div></div>)}

    {notes.length>0&&(<div className="card"><h3 className="ctit">Journal Notes</h3><div className="nl">{notes.map(n=>(<div key={n.key} className="nr"><div className="nd">{n.label}</div><div className="nt">{n.notes}</div></div>))}</div></div>)}
    <div style={{height:40}}/>
  </div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SETTINGS — editable meds + add, name, passcode
   ═══════════════════════════════════════════════════════════════════════════ */
function Settings({settings,setS,meds,setMeds,onBack}){
  const[nameVal,setNameVal]=useState(settings.name||"");
  const[pcStep,setPcStep]=useState(null);
  const[pc1,setPc1]=useState("");const[pc2,setPc2]=useState("");
  const[editMedIdx,setEditMedIdx]=useState(null);
  const[emName,setEmName]=useState("");const[emDose,setEmDose]=useState("");
  const[showAdd,setShowAdd]=useState(false);
  const[newName,setNewName]=useState("");const[newDose,setNewDose]=useState("");

  const saveName=()=>setS({name:nameVal.trim()});
  const startPc=()=>{setPcStep("new");setPc1("");setPc2("");};
  const curPc=pcStep==="new"?pc1:pc2;
  const pcTap=n=>{
    if(pcStep==="new"){const nx=pc1+n;setPc1(nx);if(nx.length===4)setTimeout(()=>setPcStep("confirm"),200);}
    else if(pcStep==="confirm"){const nx=pc2+n;setPc2(nx);if(nx.length===4){if(nx===pc1){setS({passcode:nx});setPcStep(null);}else setPc2("");}}
  };
  const pcDel=()=>{if(pcStep==="new")setPc1(pc1.slice(0,-1));else if(pcStep==="confirm")setPc2(pc2.slice(0,-1));};

  const startEditMed=(i)=>{setEditMedIdx(i);setEmName(meds[i].name);setEmDose(meds[i].dose);};
  const saveEditMed=()=>{if(!emName.trim())return;const nm=[...meds];nm[editMedIdx]={...nm[editMedIdx],name:emName.trim(),dose:emDose.trim()};setMeds(nm);setEditMedIdx(null);};
  const removeMed=(i)=>{setMeds(meds.filter((_,j)=>j!==i));};
  const addMed=()=>{if(!newName.trim())return;const key=newName.toLowerCase().replace(/\s+/g,"_")+"_"+Date.now();setMeds([...meds,{key,name:newName.trim(),dose:newDose.trim()||"—"}]);setNewName("");setNewDose("");setShowAdd(false);};

  return(<div className="scr">
    <div className="hh"><h2 className="ht">Settings</h2><button className="bi" onClick={onBack}>✕</button></div>

    <div className="card">
      <h3 className="ctit">Your Name</h3>
      <div className="set-nr"><input className="set-in" value={nameVal} onChange={e=>setNameVal(e.target.value)} placeholder="Nickname or first name"/><button className="btn-sm-p" onClick={saveName}>Save</button></div>
      <p className="set-h">Used to personalize greetings and insights</p>
    </div>

    <div className="card">
      <h3 className="ctit">Passcode Lock</h3>
      {settings.passcode&&!pcStep&&(<div>
        <p className="set-h" style={{marginBottom:10}}>Passcode is set. Required before logging.</p>
        <div className="set-pcb"><button className="btn-s" style={{fontSize:13,padding:"10px 16px"}} onClick={startPc}>Change</button><button className="btn-ghost" style={{color:"#D4785C"}} onClick={()=>setS({passcode:""})}>Remove</button></div>
      </div>)}
      {!settings.passcode&&!pcStep&&(<div>
        <p className="set-h" style={{marginBottom:10}}>Protect entries with a 4-digit passcode.</p>
        <button className="btn-s" style={{fontSize:13,padding:"10px 16px"}} onClick={startPc}>Set Passcode</button>
      </div>)}
      {pcStep&&(<div className="set-pcf">
        <p className="set-h">{pcStep==="new"?"Enter a 4-digit passcode":"Confirm your passcode"}</p>
        <div className="lock-dots" style={{justifyContent:"flex-start",margin:"12px 0"}}>{[0,1,2,3].map(i=><div key={i} className={`lock-dot${i<curPc.length?" on":""}`}/>)}</div>
        <div className="set-pad">{[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((n,i)=>(<button key={i} className={`lk lksm${n===""?" lke":""}`} onClick={()=>n==="⌫"?pcDel():n!==""&&pcTap(String(n))} disabled={n===""}>{n}</button>))}</div>
        <button className="btn-ghost" onClick={()=>setPcStep(null)}>Cancel</button>
      </div>)}
    </div>

    <div className="card">
      <h3 className="ctit">Medications</h3>
      <p className="set-h" style={{marginBottom:10}}>These appear during mood logging. Edit dosage or add new ones here.</p>
      {meds.map((med,i)=>editMedIdx===i?(
        <div key={med.key} className="set-med-edit">
          <input className="add-input" value={emName} onChange={e=>setEmName(e.target.value)} placeholder="Name"/>
          <input className="add-input add-sm" value={emDose} onChange={e=>setEmDose(e.target.value)} placeholder="Dose (e.g. 50mg)"/>
          <div className="add-btns"><button className="btn-ghost" onClick={()=>setEditMedIdx(null)}>Cancel</button><button className="btn-sm-p" onClick={saveEditMed}>Save</button></div>
        </div>
      ):(
        <div key={med.key} className="set-mr">
          <div className="mi"><div className="mn">{med.name}</div><div className="md-sub">{med.dose} / pill</div></div>
          <div className="set-mr-acts">
            <button className="rr-edit" onClick={()=>startEditMed(i)}>Edit</button>
            <button className="btn-ghost" style={{color:"#D4785C",fontSize:12,padding:"4px 8px"}} onClick={()=>removeMed(i)}>Remove</button>
          </div>
        </div>
      ))}
      {showAdd?(
        <div className="add-form" style={{marginTop:8}}>
          <input className="add-input" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Medication name"/>
          <input className="add-input add-sm" value={newDose} onChange={e=>setNewDose(e.target.value)} placeholder="Dose (e.g. 50mg)"/>
          <div className="add-btns"><button className="btn-ghost" onClick={()=>setShowAdd(false)}>Cancel</button><button className="btn-sm-p" onClick={addMed}>Add</button></div>
        </div>
      ):(<button className="btn-add" style={{marginTop:8}} onClick={()=>setShowAdd(true)}>+ Add medication</button>)}
    </div>
    <div style={{height:40}}/>
  </div>);
}

/* ═══════════════════════════════════════════════════════════════════════════
   CSS
   ═══════════════════════════════════════════════════════════════════════════ */
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=Source+Serif+4:ital,opsz,wght@0,8..60,300;0,8..60,400;0,8..60,500;1,8..60,300&display=swap');
:root{--bg:#FAF8F5;--card:#FFF;--tx:#2C2825;--t2:#6B6560;--t3:#A09890;--bd:#EBE7E1;--warm:#F5F0E8;--gn:#7BA08B;--gbg:#EFF6F1;--ac:#C9B07A;--abg:#FAF6ED;--r:14px;--rs:10px;--sh:0 1px 3px rgba(0,0,0,.03),0 6px 16px rgba(0,0,0,.02);--ease:cubic-bezier(.16,1,.3,1)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',system-ui,sans-serif;background:var(--bg);color:var(--tx);-webkit-font-smoothing:antialiased}
.app{max-width:420px;margin:0 auto;min-height:100dvh;overflow-x:hidden}
.scr{padding:0 20px 40px;animation:fu .35s var(--ease);min-height:100dvh}
@keyframes fu{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

.btn-p{width:100%;padding:15px 24px;border-radius:var(--r);border:none;background:var(--tx);color:#fff;font:500 15px/1 'DM Sans',sans-serif;cursor:pointer;transition:all .15s var(--ease);letter-spacing:.01em}
.btn-p:active{transform:scale(.98);opacity:.9}.btn-p.bd{opacity:.25;pointer-events:none}
.btn-s{width:100%;padding:15px 24px;border-radius:var(--r);border:1.5px solid var(--bd);background:transparent;color:var(--tx);font:500 15px/1 'DM Sans',sans-serif;cursor:pointer;transition:all .15s}
.btn-s:hover{border-color:var(--t3)}.btn-s:active{transform:scale(.98)}
.bi{width:36px;height:36px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font-size:16px;color:var(--t2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
.bi:hover{border-color:var(--t3)}
.btn-ghost{border:none;background:none;color:var(--t3);font:400 13px 'DM Sans',sans-serif;cursor:pointer;padding:8px}
.br{width:52px;height:52px;border-radius:50%;border:1.5px solid var(--bd);background:transparent;font-size:22px;color:var(--tx);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
.br:hover{border-color:var(--t3)}.br:active{transform:scale(.92)}
.bs{width:30px;height:30px;border-radius:8px;border:1px solid var(--bd);background:transparent;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--tx)}
.bx{padding:7px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t2);cursor:pointer;transition:all .15s}
.bx:hover{border-color:var(--t3)}
.btn-sm-p{padding:8px 16px;border-radius:var(--rs);border:none;background:var(--tx);color:#fff;font:500 13px 'DM Sans',sans-serif;cursor:pointer;transition:all .1s}
.btn-sm-p:active{transform:scale(.96)}
.btn-add{width:100%;padding:12px;border-radius:var(--rs);border:1.5px dashed var(--bd);background:transparent;color:var(--t3);font:400 13px 'DM Sans',sans-serif;cursor:pointer;transition:all .15s}
.btn-add:hover{border-color:var(--t2);color:var(--t2)}

.welcome{display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}
.w-top{margin-bottom:60px}
.w-orb{width:80px;height:80px;border-radius:50%;background:linear-gradient(145deg,#EEF1F7,#E8E4DE 50%,#EFF6F1);display:flex;align-items:center;justify-content:center;margin:0 auto 28px;overflow:hidden}
.w-orb-i{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--gn),#6478A0);opacity:.35}
.w-t{font-family:'Source Serif 4',serif;font-weight:400;font-size:30px;letter-spacing:-.3px;margin-bottom:10px}
.w-s{color:var(--t2);font-size:15px;line-height:1.55;max-width:300px;font-weight:300}
.w-b{width:100%;max-width:280px}

.lock-scr{display:flex;align-items:center;justify-content:center;flex-direction:column;position:relative}
.lock-x{position:absolute;top:20px;right:20px}
.lock-in{text-align:center}.lock-ico{font-size:32px;margin-bottom:16px}
.lock-lbl{font-size:14px;color:var(--t2);margin-bottom:20px;font-weight:400;min-height:20px}
.lock-dots{display:flex;gap:12px;justify-content:center;margin-bottom:32px}
.lock-dot{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--bd);background:transparent;transition:all .2s}
.lock-dot.on{background:var(--tx);border-color:var(--tx)}
.lock-shake{animation:shake .4s ease}
@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
.lock-pad{display:grid;grid-template-columns:repeat(3,72px);gap:10px;justify-content:center}
.lk{width:72px;height:56px;border-radius:12px;border:1px solid var(--bd);background:var(--card);font:400 22px 'Source Serif 4',serif;color:var(--tx);cursor:pointer;transition:all .1s;display:flex;align-items:center;justify-content:center}
.lk:active{background:var(--warm);transform:scale(.95)}.lke{border:none;background:transparent;cursor:default}
.lksm{width:56px;height:44px;font-size:18px}
.set-pad{display:grid;grid-template-columns:repeat(3,56px);gap:8px;margin-bottom:12px}

.cal-top{display:flex;align-items:flex-start;justify-content:space-between;padding:24px 0 16px}
.cal-tr{display:flex;gap:6px;align-items:center}
.cal-gr{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:2px}
.cht{font-family:'Source Serif 4',serif;font-weight:400;font-size:22px}.cnav{display:flex;gap:4px}
.streak{display:flex;align-items:center;gap:6px;padding:10px 14px;background:var(--gbg);border-radius:var(--rs);font-size:13px;color:var(--gn);font-weight:400;margin-bottom:16px}
.cg{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:16px}
.clb{font-size:10px;font-weight:500;color:var(--t3);text-align:center;padding:4px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.cc{aspect-ratio:1;border-radius:var(--rs);display:flex;align-items:center;justify-content:center;position:relative;font-size:13px;color:var(--t2);transition:all .15s}
.ce{pointer-events:none}.cl{font-weight:500;color:var(--tx)}
.ct .cn{font-weight:600}.ct::after{content:'';position:absolute;bottom:3px;width:4px;height:4px;border-radius:50%;background:var(--tx)}
.cd{position:absolute;inset:3px;border-radius:7px}
.cleg,.mleg{display:flex;flex-wrap:wrap;gap:6px 10px;margin-bottom:24px;padding:0 2px}.mleg{margin-top:12px;margin-bottom:0}
.cli{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--t3)}.cld{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.cact{display:flex;flex-direction:column;gap:10px}

.ent{padding-top:12px}
.et{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.es{font-size:12px;color:var(--t3);font-weight:500;letter-spacing:.04em}
.pb{width:100%;height:3px;background:var(--bd);border-radius:2px;margin-bottom:36px;overflow:hidden}
.pf{height:100%;background:var(--tx);border-radius:2px;transition:width .4s var(--ease)}
.qa{animation:si .3s var(--ease)}
@keyframes si{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
.qt{font-family:'Source Serif 4',serif;font-size:24px;font-weight:400;letter-spacing:-.2px;margin-bottom:6px}
.qs{font-size:13px;color:var(--t3);font-weight:300;margin-bottom:28px}.en{margin-top:8px}

.ol{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.oc{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;cursor:pointer;transition:all .15s;text-align:left;font-family:'DM Sans',sans-serif}
.oc:hover{border-color:var(--t3)}
.ocl{display:flex;align-items:center;gap:10px}.oce{font-size:18px;width:28px;text-align:center;flex-shrink:0}
.ocn{font-size:14px;font-weight:400}.ocd{font-size:11px;color:var(--t3);font-weight:300;margin-top:1px}
.or{width:20px;height:20px;border-radius:50%;border:1.5px solid var(--bd);display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;flex-shrink:0;transition:all .15s}

.np{display:flex;align-items:center;justify-content:center;gap:28px;margin:20px 0 32px}
.nv{text-align:center}.nb{font-family:'Source Serif 4',serif;font-size:48px;font-weight:400}.nu{font-size:16px;color:var(--t3);margin-left:4px}

.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px}
.sc{padding:20px 8px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;cursor:pointer;text-align:center;transition:all .15s;font-family:'DM Sans',sans-serif}
.sc:hover{border-color:var(--t3)}.ss{border-color:var(--tx);background:var(--warm)}
.sn{display:block;font-family:'Source Serif 4',serif;font-size:24px;font-weight:400;margin-bottom:4px}.sl{font-size:11px;color:var(--t2)}

.ml{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.mr{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);transition:all .15s}
.mo{border-color:var(--tx);background:var(--warm)}
.mi{flex:1}.mn{font-size:14px}.md-sub{font-size:11px;color:var(--t3);margin-top:1px}
.mc{display:flex;align-items:center;gap:10px}.mv{font-size:15px;font-weight:500;min-width:20px;text-align:center}

.ni{width:100%;min-height:120px;border-radius:var(--r);border:1.5px solid var(--bd);padding:16px;font:15px/1.55 'DM Sans',sans-serif;resize:vertical;background:transparent;color:var(--tx);transition:border .15s;margin-bottom:12px}
.ni:focus{outline:none;border-color:var(--tx)}.ni::placeholder{color:var(--t3)}

.rc{background:var(--card);border-radius:var(--r);padding:4px 18px;box-shadow:var(--sh);margin-bottom:16px}
.rr{display:flex;justify-content:space-between;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--bd);gap:8px}
.rr:last-child{border-bottom:none}
.rr-left{flex:1;display:flex;flex-direction:column;gap:3px;min-width:0}
.rl{font-size:12px;color:var(--t3);flex-shrink:0}.rv{font-size:13px;line-height:1.4;word-break:break-word}
.rr-edit{border:none;background:none;color:var(--ac);font:500 12px 'DM Sans',sans-serif;cursor:pointer;padding:4px 0;flex-shrink:0;transition:color .15s}
.rr-edit:hover{color:#b89d65}
.rb{display:flex;gap:10px}.rb .btn-s{flex:1}

.srm-em{font-size:36px;margin-bottom:12px}
.srm-tr{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.srm-lb{font-size:12px;color:var(--t3);font-weight:500;min-width:48px}
.srm-ti{flex:1;padding:10px 12px;border-radius:var(--rs);border:1.5px solid var(--bd);font:400 15px 'DM Sans',sans-serif;color:var(--tx);background:transparent;outline:none}
.srm-ti:focus{border-color:var(--tx)}
.srm-ap{display:flex;gap:2px}
.srm-ab{padding:10px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);background:transparent;font:500 12px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer;transition:all .15s}
.srm-aon{border-color:var(--tx);background:var(--warm);color:var(--tx)}
.srm-skip{padding:8px 14px;border-radius:var(--rs);border:1px solid var(--bd);background:transparent;font:300 12px 'DM Sans',sans-serif;color:var(--t3);cursor:pointer;transition:all .15s;width:100%;text-align:left;margin-bottom:16px}
.srm-skip:hover{border-color:var(--t3)}.srm-skip-on{border-color:var(--t3);background:var(--warm);color:var(--tx);font-weight:400}

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
.sb{flex:1;background:var(--card);border-radius:var(--r);padding:16px 12px;box-shadow:var(--sh);text-align:center}
.sv{font-family:'Source Serif 4',serif;font-size:28px;font-weight:400}.sbl{font-size:11px;color:var(--t3);margin-top:2px}
.card{background:var(--card);border-radius:var(--r);padding:18px;box-shadow:var(--sh);margin-bottom:14px}
.ctit{font-size:11px;font-weight:500;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
.cw{margin:0 -8px}
.cleg2{display:flex;gap:16px;margin-top:10px;font-size:11px;color:var(--t2)}
.ll{display:inline-block;width:16px;height:2px;border-radius:1px;vertical-align:middle;margin-right:4px}
.tt{background:var(--card);border:1px solid var(--bd);border-radius:var(--rs);padding:8px 12px;box-shadow:var(--sh);font-size:12px;z-index:10}
.ttd{font-weight:500;margin-bottom:2px}
.nl{display:flex;flex-direction:column}
.nr{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--bd)}.nr:last-child{border-bottom:none}
.nd{font-size:11px;color:var(--t3);font-weight:500;min-width:48px;flex-shrink:0;padding-top:1px}
.nt{font-size:13px;color:var(--t2);font-weight:300;line-height:1.5}

.set-nr{display:flex;gap:8px;align-items:center}
.set-in{flex:1;padding:10px 14px;border-radius:var(--rs);border:1.5px solid var(--bd);font:400 14px 'DM Sans',sans-serif;color:var(--tx);background:transparent;outline:none}
.set-in:focus{border-color:var(--tx)}.set-in::placeholder{color:var(--t3)}
.set-h{font-size:12px;color:var(--t3);font-weight:300;margin-top:8px}
.set-pcb{display:flex;gap:8px}.set-pcf{margin-top:8px}
.set-mr{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--bd)}
.set-mr:last-of-type{border-bottom:none}
.set-mr-acts{display:flex;gap:4px;align-items:center}
.set-med-edit{padding:12px;border:1.5px solid var(--bd);border-radius:var(--rs);margin-bottom:8px}

@media(max-width:440px){.app{max-width:100%}.scr{padding:0 16px 32px}}
`;
