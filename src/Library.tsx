import React,{useEffect,useState} from 'react';
import type {LibraryEntry} from '../server/library';
export function Library({runId,revision,onRun}:{runId?:string;revision?:string;onRun?:(id:string)=>void}){
  const [entries,setEntries]=useState<LibraryEntry[]>([]),[error,setError]=useState('');
  useEffect(()=>{let live=true;fetch(runId?'/api/runs/'+runId+'/scenarios':'/api/library',{headers:{'X-Characterize':'1'}}).then(async r=>{if(!r.ok)throw Error('No se pudo abrir la biblioteca');return r.json()}).then(value=>{if(live){setEntries(runId?[value]:value);setError('')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[runId,revision]);
  const [removing,setRemoving]=useState(false);
  async function remove(entry:LibraryEntry,scenario:LibraryEntry["scenarios"][number]){
    if(!window.confirm("¿Eliminar «"+scenario.title+"» de la biblioteca y sus archivos Gherkin? El informe y las evidencias originales se conservarán."))return;
    setRemoving(true); setError("");
    try{
      const res=await fetch("/api/library/"+entry.id+"/"+scenario.id,{method:"DELETE",headers:{"X-Characterize":"1"}});
      const value=await res.json(); if(!res.ok)throw Error(value.error);
      setEntries(old=>old.map(e=>e.id===entry.id?value:e));
    }catch(e){setError((e as Error).message)}finally{setRemoving(false)}
  }
  const groups = new Map<string,{host:string; label:string; rows:{entry:LibraryEntry; scenario:LibraryEntry["scenarios"][number]}[]}>();
  for(const entry of entries){
    const host=new URL(entry.url).host;
    for(const scenario of entry.scenarios){
      const key=host+"|"+scenario.groupKey;
      const group=groups.get(key)??{host,label:scenario.group,rows:[]};
      group.rows.push({entry,scenario});groups.set(key,group);
    }
  }
  function download(name:string,feature:string){
    return <a download={name+".feature"} href={'data:text/plain;charset=utf-8,'+encodeURIComponent(feature)}>Descargar .feature</a>;
  }
  return <section className="panel"><h2>{runId?'Escenarios Gherkin':'Biblioteca local'}</h2>
    <p>Los escenarios se agrupan por pantalla dentro de cada sitio. Smoke reúne los recorridos que pasan por varias pantallas.</p>
    {error && <p role="alert">{error}</p>}{!groups.size&&!error&&<p>Aún no hay escenarios recuperables.</p>}
    {[...new Set([...groups.values()].map(g=>g.host))].sort().map(host=><article key={host}><h3>{host}</h3>
    {[...groups.entries()].filter(([,g])=>g.host===host).sort(([,a],[,b])=>a.label.localeCompare(b.label,"es")).map(([key,g])=><section key={key}>
      <h4>{g.label} · {g.rows.length} {g.rows.length===1?"escenario":"escenarios"}</h4>
      {download(host+"-"+g.label.replace(/[^\p{L}0-9_-]+/gu,"-"), ["# language: es","Característica: "+g.label+" · "+host,...g.rows.map(({entry,scenario:s})=>"\n  # Ejecución "+entry.id+" · "+s.state+" · Evidencias: "+s.ids.join(", ")+(s.groupKey==="smoke"?"\n  @smoke":"")+"\n  "+s.gherkin.replaceAll("\n","\n  "))].join("\n")+"\n")}
      {g.rows.map(({entry:e,scenario:s},i)=><details className="flow-card" key={e.id+"-"+i}><summary><strong>{s.title}</strong><span className="badge">{s.state}</span></summary><div className="flow-body">
        {s.groupKey==="smoke"&&<p>Pantallas: {s.screens.map(screen=>screen.label).join(" → ")}</p>}
        <pre style={{whiteSpace:'pre-wrap'}}>{s.gherkin}</pre><p>Evidencias: {s.ids.map(id=> '#'+id).join(', ')}</p><small>{new Date(e.createdAt).toLocaleString('es')}</small>
        {onRun&&<button className="text-button" onClick={()=>onRun(e.id)}>Ver ejecución y evidencias</button>} <button className="text-button" disabled={removing||e.status==="running"} onClick={()=>void remove(e,s)}>Eliminar escenario</button></div></details>)}</section>)}</article>)}
    {runId&&entries[0]?.scenarios.length?download(runId,entries[0].feature):null}</section>;
}
