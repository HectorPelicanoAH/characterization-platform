import { ThemeToggle } from "./ThemeToggle";
import React, { useEffect, useState } from "react";
import type { Evidence } from "../shared/model";
type Diagnosis = {
  url: string;
  status: string;
  error?: string;
  viewer: string | null;
  issues: { title: string; ids: number[] }[];
  failed: Evidence[];
};
export function Diagnosis({ id }: { id: string }) {
  const [data, set] = useState<Diagnosis>(),
    [err, error] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/runs/" + id + "/diagnosis", {
      headers: { "X-Characterize": "1" },
    })
      .then(async (r) => {
        if (!r.ok) throw Error("Could not load diagnostics.");
        return r.json();
      })
      .then((d) => {
        if (live) set(d);
      })
      .catch((e) => {
        if (live) error(e.message);
      });
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <main>
      <ThemeToggle /> <a href="/">← Back to workspace</a>
      <div className="page-heading">
        <h1>Exploration diagnostics</h1>
        {data && <p>{data.url}</p>}
      </div>
      {err && <p role="alert">{err}</p>}
      {!data && !err && <p>Loading diagnostics…</p>}
      {data && (
        <>
          <section className="panel">
            <h2>
              {data.issues.length
                ? "Insufficient evidence to validate the report"
                : data.error
                  ? "Exploration incomplete"
                  : "Exploration result"}
            </h2>
            <p>{data.error ?? "No execution failure was recorded."}</p>
            <p>
              Review the evidence to determine whether a failed browser action reflects a defect in the site.
            </p>
            {data.issues.map((s) => (
              <div key={s.title}>
                <h4>{s.title}</h4>
                {s.ids.map((id) => (
                  <span key={id}>
                    {data.failed.some((e) => e.id === id) ? (
                      <a href={"#evento-" + id}>Failed action #{id}</a>
                    ) : (
                      "Missing evidence #" + id
                    )}{" "}
                  </span>
                ))}
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>Playwright Trace Viewer</h2>
            {data.viewer ? (
              <>
                <a href={data.viewer} target="_blank" rel="noreferrer">
                  Open viewer in another tab ↗
                </a>
                <iframe
                  title="Playwright Trace Viewer"
                  src={data.viewer}
                  style={{ width: "100%", height: "70vh", border: 0 }}
                />
              </>
            ) : (
              <p>
                No native trace was saved for this run. Review the original errors below. New explorations record a local trace from the first action.
              </p>
            )}
          </section>
          <section className="panel">
            <h2>Failed actions ({data.failed.length})</h2>
            {data.failed.map((e) => (
              <article id={"evento-" + e.id} key={e.id}>
                <h4>
                  #{e.id} · {e.tool} · {new Date(e.at).toLocaleTimeString("en")}
                </h4>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {e.detail}
                </pre>
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
