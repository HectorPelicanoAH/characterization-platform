import React, { useEffect, useState } from "react";
import type { decisionMaps } from "../server/decision-map";

export function DecisionMap({onRun}:{onRun?:(id:string)=>void}) {
  const [maps,setMaps]=useState<ReturnType<typeof decisionMaps>>([]);
  const [site,setSite]=useState(""), [key,setKey]=useState(""), [error,setError]=useState("");
  useEffect(()=>{
    let live=true;
    let timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      try{
        const response=await fetch("/api/decision-maps",{headers:{"X-Characterize":"1"}});
        if(!response.ok)throw Error("Could not load the decision map.");
        const data=await response.json();
        if(live){setMaps(data);setError("");}
      }catch(e){if(live)setError((e as Error).message);}
      if(live)timer=setTimeout(refresh,8000);
    }
    void refresh();
    return ()=>{live=false;clearTimeout(timer);};
  },[]);
  const map=maps.find(m=>m.site===site)??maps[0];
  const screen=map?.screens.find(s=>s.key===key)??map?.screens[0];
  const branches=map?.branches.filter(b=>b.source.key===screen?.key)??[];
  const connections=map?.branches.filter(b=>b.source.key!==b.target.key && (b.source.key===screen?.key || b.target.key===screen?.key))??[];
  return <section className="decision-map"><h3>Screen decision map</h3>
    {error&&<p role="alert">{error}</p>}
    {map && screen ? <>
      <div className="map-select"><label>Site<select value={map.site} onChange={e=>{setSite(e.target.value);setKey("");}}>{maps.map(m=><option key={m.site}>{m.site}</option>)}</select></label>
      <label>Screen<select value={screen.key} onChange={e=>setKey(e.target.value)}>{map.screens.map(s=><option value={s.key} key={s.key}>{s.label} · {s.key.slice(s.key.indexOf("//")+2)}</option>)}</select></label></div>
      <h4>Connected screens</h4>
      {connections.length ? <div className="map-edges">{connections.map((b,i)=><div key={i} className="map-edge">
        <button disabled={screen.key===b.source.key} onClick={()=>setKey(b.source.key)}>{b.source.label}</button>
        <span>{b.action} →</span>
        <button disabled={screen.key===b.target.key} onClick={()=>setKey(b.target.key)}>{b.target.label}{b.external?" ↗":""}</button>
      </div>)}</div>:<p>No screen transitions recorded here yet.</p>}
      <h4>Decision tree · {screen.label}</h4>
      {branches.length ? [...new Set(branches.map(b=>b.condition))].map(condition=><details key={condition} open className="map-condition"><summary>{condition}</summary>
        <ul>{branches.filter(b=>b.condition===condition).map((b,i)=><li key={i}><strong>{b.action}</strong><p>{b.outcome}</p>
          <button className="text-button" onClick={()=>onRun?.(b.runId)}>Evidence {b.ids.map(id=>"#"+id).join(", ")}</button></li>)}</ul></details>):<p>No decision outcomes recorded on this screen yet.</p>}
    </>:<p>The map appears once an exploration records a screen.</p>}
  </section>;
}
