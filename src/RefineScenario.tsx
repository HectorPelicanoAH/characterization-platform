import React, { useEffect, useRef, useState } from "react";
import type { LibraryEntry } from "../server/library.ts";
import type { RefinementJob } from "../shared/refinement.ts";

export function RefineScenario({ entry, scenario, onClose, onSaved }: {
  entry: LibraryEntry; scenario: LibraryEntry["scenarios"][number]; onClose: () => void; onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [comment, setComment] = useState("");
  const [job, setJob] = useState<RefinementJob>();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = busy || job?.status === "running";
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  useEffect(() => {
    if (job?.status !== "running") return;
    const abort = new AbortController();
    const timer = window.setInterval(() => {
      fetch("/api/refinements/" + job.id, { headers: { "X-Characterize": "1" }, signal: abort.signal })
        .then(async response => { const value = await response.json(); if (!response.ok) throw Error(value.error); return value as RefinementJob; })
        .then(value => {
          setJob(value);
          if (value.status === "ready") setChosen(value.changes.filter(change => change.selected).map(change => change.target));
        }).catch(error => { if (!abort.signal.aborted) { setError(error.message); setJob(current => current && ({ ...current, status: "failed" })); } });
    }, 1000);
    return () => { window.clearInterval(timer); abort.abort(); };
  }, [job?.id, job?.status]);

  async function analyze(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const message = job?.status === "questions" ? job.questions.map((question, index) => question + "\nAnswer: " + answers[index]).join("\n\n") : comment;
    try {
      const response = await fetch("/api/library/" + entry.id + "/" + scenario.id + "/refine", {
        method: "POST", headers: { "X-Characterize": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ comment: message, parentId: job && ["ready", "questions"].includes(job.status) ? job.id : undefined }),
      });
      const value = await response.json(); if (!response.ok) throw Error(value.error);
      setJob(value); setComment(""); setAnswers({});
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    if (!job) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/refinements/" + job.id + "/apply", {
        method: "POST", headers: { "X-Characterize": "1", "Content-Type": "application/json" }, body: JSON.stringify({ targets: chosen }),
      });
      const value = await response.json(); if (!response.ok) throw Error(value.error);
      onSaved();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function close() {
    if (busy) return;
    if (job?.status === "running") {
      try { await fetch("/api/refinements/" + job.id, { method: "DELETE", headers: { "X-Characterize": "1" } }); } catch { /* Closing never saves a proposal. */ }
    }
    onClose();
  }
  return <dialog ref={dialog} className="refine-dialog" aria-labelledby="refine-title" onCancel={event => { event.preventDefault(); void close(); }}>
    <div className="refine-heading"><h2 id="refine-title">Refine with AI</h2><button type="button" className="text-button" aria-label="Close refinement" disabled={busy} onClick={() => void close()}>{working ? "Cancel review" : "Close"}</button></div>
    <p className="refine-context">{scenario.title}</p>
    {error && <p role="alert">{error}</p>}
    {job?.status === "failed" && job.error && <p role="alert">{job.error}</p>}
    {job?.summary && <p>{job.summary}</p>}
    {working && <p role="status">Reviewing your request and related scenarios…</p>}
    {job?.status === "ready" && <div className="refine-proposals">
      <p>Choose the changes to save. Related scenarios are optional.</p>
      {job.changes.map(change => <div className="refine-proposal" key={change.target}>
        <label className="refine-choice"><input type="checkbox" checked={chosen.includes(change.target)} disabled={change.selected || working}
          onChange={event => setChosen(current => event.target.checked ? [...current, change.target] : current.filter(target => target !== change.target))} />
          <strong>{change.title}</strong>{change.selected && <span className="badge">Selected scenario</span>}</label>
        <p>{change.reason}</p>
        {change.observations > 1 && <p className="small">Applies to {change.observations} grouped observations.</p>}
        <details><summary>Original scenario</summary><pre>{change.before}</pre></details>
        <pre aria-label={"Proposed scenario: " + change.title}>{change.after}</pre>
      </div>)}
      <p className="small">This updates Gherkin and its downloads. Evidence is preserved; generated Playwright tests need a separate review.</p>
      <button type="button" className="button primary" disabled={working} onClick={() => void save()}>Save {chosen.length === 1 ? "scenario" : chosen.length + " scenarios"}</button>
    </div>}
    <form onSubmit={event => void analyze(event)} className="refine-form">
      {job?.status === "questions" ? <>
        <p>A few details are needed before proposing changes.</p>
        {job.questions.map((question, index) => <label key={index}>{question}<textarea required maxLength={1000} rows={2} value={answers[index] ?? ""}
          disabled={working} onChange={event => setAnswers(current => ({ ...current, [index]: event.target.value }))} /></label>)}
      </> : <label htmlFor="refine-comment">{job?.status === "ready" ? "Adjust this proposal" : "What would you like to improve?"}
        <textarea id="refine-comment" autoFocus required maxLength={6000} rows={4} value={comment} disabled={working}
          placeholder="For example: use English business language, remove incidental UI copy and parameterize values. Check whether other scenarios need the same change."
          onChange={event => setComment(event.target.value)} /></label>}
      <div className="refine-footer"><button type="submit" className="button secondary" disabled={working}>{job?.status === "questions" ? "Review answers" : job?.status === "ready" ? "Review adjustment" : "Review with AI"}</button>
        {!job && <span className="small">You’ll review the proposals before saving.</span>}</div>
    </form>
  </dialog>;
}
