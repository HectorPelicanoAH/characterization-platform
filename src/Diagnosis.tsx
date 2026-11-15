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
        if (!r.ok) throw Error("No se pudo cargar el diagnóstico.");
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
      <a href="/">← Volver al espacio de trabajo</a>
      <div className="page-heading">
        <h1>Diagnóstico de la exploración</h1>
        {data && <p>{data.url}</p>}
      </div>
      {err && <p role="alert">{err}</p>}
      {!data && !err && <p>Cargando diagnóstico…</p>}
      {data && (
        <>
          <section className="panel">
            <h2>
              {data.issues.length
                ? "Evidencia insuficiente para validar el informe"
                : data.error
                  ? "La exploración no se completó"
                  : "Resultado de la exploración"}
            </h2>
            <p>{data.error ?? "No se registró un fallo de ejecución."}</p>
            <p>
              Un error del agente o una acción de navegador fallida no demuestra
              por sí solo un defecto en la web.
            </p>
            {data.issues.map((s) => (
              <div key={s.title}>
                <h4>{s.title}</h4>
                {s.ids.map((id) => (
                  <span key={id}>
                    {data.failed.some((e) => e.id === id) ? (
                      <a href={"#evento-" + id}>Acción fallida #{id}</a>
                    ) : (
                      "Evidencia ausente #" + id
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
                  Abrir visor en otra pestaña ↗
                </a>
                <iframe
                  title="Playwright Trace Viewer"
                  src={data.viewer}
                  style={{ width: "100%", height: "70vh", border: 0 }}
                />
              </>
            ) : (
              <p>
                No hay traza nativa guardada para esta ejecución. Puedes
                consultar los errores originales abajo. Las nuevas exploraciones
                graban la traza localmente desde la primera acción.
              </p>
            )}
          </section>
          <section className="panel">
            <h2>Acciones fallidas ({data.failed.length})</h2>
            {data.failed.map((e) => (
              <article id={"evento-" + e.id} key={e.id}>
                <h4>
                  #{e.id} · {e.tool} · {new Date(e.at).toLocaleTimeString("es")}
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
