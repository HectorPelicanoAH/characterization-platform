import { ThemeToggle } from "./ThemeToggle";
import { Diagnosis } from "./Diagnosis";
import { Library } from "./Library";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  Code2,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe2,
  History,
  Layers3,
  LoaderCircle,
  Play,
  Plus,
  Radar,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  scopes,
  type Account,
  type Provider,
  type Run,
  type RunInput,
  type Settings,
} from "../shared/model";
import "./style.css";

async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "X-Characterize": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? "The operation could not be completed.");
  return value;
}
const providerInfo = {
  codex: {
    name: "Codex",
    company: "OpenAI",
    mark: "◎",
    description: "Your ChatGPT account",
    color: "green",
  },
  claude: {
    name: "Claude",
    company: "Anthropic",
    mark: "✳",
    description: "Your Claude account",
    color: "clay",
  },
  copilot: {
    name: "Copilot",
    company: "GitHub",
    mark: "⌘",
    description: "Your GitHub account",
    color: "purple",
  },
};
const statusNames: Record<Run["status"], string> = {
  running: "Running",
  completed: "Generated",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};
function readableDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function App() {
  const [page, setPage] = useState<"settings" | "explore" | "library" | "result">("settings");
  const [settings, setSettings] = useState<Settings>({
    context: "",
    directories: [],
  });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [history, setHistory] = useState<(Run & { flowCount: number; removedFromRecent?:boolean })[]>([]);
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [models, setModels] = useState<
    { id: string; name: string; efforts: string[] }[]
  >([]);
  const [preview, setPreview] = useState<{
    files: { path: string; characters: number }[];
    warnings: string[];
    characters: number;
  }>();
  const [input, setInput] = useState<RunInput>({
    url: "",
    provider: "codex",
    model: "",
    effort: "default",
    scope: "standard",
    prompt: "",
    headed: true,
  });
  const connected = accounts.filter((a) => a.connected);
  const working = run?.status === "running";

  async function attempt(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function refreshAccounts() {
    setAccounts(await api<Account[]>("/accounts"));
  }
  async function refreshHistory() {
    setHistory((await api<(Run & { flowCount: number; removedFromRecent?:boolean })[]>("/runs")).filter(r=>!r.removedFromRecent));
  }
  useEffect(() => {
    void attempt("load", async () => {
      const [saved, accountList, previous] = await Promise.all([
        api<Settings>("/settings"),
        api<Account[]>("/accounts"),
        api<(Run & { flowCount: number; removedFromRecent?:boolean })[]>("/runs"),
      ]);
      setSettings(saved);
      setAccounts(accountList);
      setHistory(previous.filter(r=>!r.removedFromRecent));
      const first = accountList.find((a) => a.connected);
      const latest = previous[0];
      setInput(old => ({ ...old, url: latest?.url ?? "", prompt: latest?.prompt ?? "", provider: first?.id ?? old.provider }));
      if (first) {
        setPage("explore");
      }
      setLoaded(true);
    });
  }, []);
  const loggingIn = accounts.some((a) => a.login?.status === "running");
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    setModels([]);
    void api<{ id: string; name: string; efforts: string[] }[]>(
      "/models/" + input.provider,
    )
      .then((value) => {
        if (alive) setModels(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [input.provider, loaded]);
  useEffect(() => {
    if (!loggingIn) return;
    const interval = setInterval(() => {
      void refreshAccounts().catch((e) => setError(e.message));
    }, 2000);
    return () => clearInterval(interval);
  }, [loggingIn]);
  useEffect(() => {
    if (!working || !run) return;
    let alive = true;
    const interval = setInterval(async () => {
      try {
        const updated = await api<Run>("/runs/" + run.id);
        if (!alive) return;
        setRun(updated);
        if (updated.status !== "running") await refreshHistory();
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }, 1500);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [working, run?.id]);
  function updateSettings(value: Partial<Settings>) {
    setSettings((old) => ({ ...old, ...value }));
    setDirty(true);
    setPreview(undefined);
  }
  async function saveSettings() {
    const saved = await api<Settings>("/settings", settings, "PUT");
    setSettings(saved);
    setDirty(false);
    setNotice("Settings saved.");
  }
  async function download() {
    const response = await fetch(`/api/runs/${run!.id}/export`, {
      headers: { "X-Characterize": "1" },
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `characterization-${run!.id.slice(0, 8)}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("explore");
          }}
        >
          <span className="brand-mark">
            <Radar size={23} />
          </span>
          <span>
            characterize<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={page === "settings" ? "nav-item selected" : "nav-item"}
            onClick={() => setPage("settings")}
          >
            <Settings2 size={18} />
            <span>Settings</span>
            <span className="step-count">01</span>
          </button>
          <button
            className={page === "explore" ? "nav-item selected" : "nav-item"}
            onClick={() => setPage("explore")}
          >
            <Radar size={18} />
            <span>Characterization</span>
            <span className="step-count">02</span>
          </button>
          <button className={page==="library"?"nav-item selected":"nav-item"} onClick={()=>setPage("library")}><FolderOpen size={18}/> Local library</button>
        </nav>
        <div className="sidebar-history">
          <div className="workspace-label">
            RECENT EXPLORATIONS <History size={13} />
          </div>
          {!history.length && (
            <p className="muted small history-empty">
              Your explorations will appear here.
            </p>
          )}
          {history.slice(0, 8).map((item) => (
            <div key={item.id} className="recent-row"><button
              className={
                "history-link " +
                (run?.id === item.id && page === "result" ? "active" : "")
              }
              onClick={() =>
                void attempt("history", async () => {
                  setRun(await api<Run>("/runs/" + item.id));
                  setPage("result");
                })
              }
            >
              <span className={"history-dot " + item.status} />
              <span>
                <strong>{new URL(item.url).hostname}</strong>
                <small>{readableDate(item.createdAt)}</small>
              </span>
            </button>
            <button className="recent-remove" disabled={Boolean(busy)||item.status==="running"} aria-label={"Remove from recent explorations: "+new URL(item.url).hostname} title="Remove from recent explorations" onClick={()=>{
              if(!window.confirm("Remove this exploration from recent history? Its scenarios and evidence will be kept."))return;
              void attempt("remove-recent",async()=>{await api("/recent/"+item.id,undefined,"DELETE");await refreshHistory();setNotice("Exploration removed from recent history.");});
            }}><Trash2 size={15}/></button></div>
          ))}
        </div>
        <div className="sidebar-bottom">
          <span className="local-dot" />
          <span>Local environment</span>
          <span className="mono">v0.1</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            Workspace <span className="breadcrumb">/</span>{" "}
            <strong>
              {page === "settings" ? "Settings" : page==="library" ? "Local library" : "Characterization"}
            </strong>
          </span>
          <ThemeToggle />
          <span className="local-badge">
            <span className={connected.length ? "local-dot" : "offline-dot"} />
            {connected.length
              ? `${connected.length} connected account${connected.length > 1 ? "s" : ""}`
              : "No account connected"}
          </span>
        </header>
        <main>
          {error && (
            <div role="alert" className="alert error">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              <CheckCircle2 size={17} />
              {notice}
            </div>
          )}
          {!loaded ? (
            <div className="loading">
              <LoaderCircle className="spin" />
              Loading your workspace…
            </div>
          ) : page==="library" ? <Library onRun={id=>void attempt("history",async()=>{setRun(await api<Run>("/runs/"+id));setPage("result")})}/> : page === "settings" ? (
            <>
              <div className="page-heading">
                <div className="eyebrow">WORKSPACE SETUP</div>
                <h1>Give your agent context.</h1>
                <p>
                  Connect an AI account and choose the instructions it should follow.
                </p>
              </div>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>
                      <span className="section-number">01</span> Connect an AI account
                    </h2>
                    <p>
                      Choose at least one provider. You can connect several.
                    </p>
                  </div>
                  <span className="badge required">Required</span>
                </div>
                <div className="providers">
                  {(["codex", "claude", "copilot"] as Provider[]).map((id) => {
                    const info = providerInfo[id],
                      account = accounts.find((a) => a.id === id);
                    return (
                      <div
                        key={id}
                        className={
                          "provider-card " +
                          (account?.connected ? "connected" : "")
                        }
                      >
                        <div className="provider-top">
                          <span className={"provider-logo " + info.color}>
                            {info.mark}
                          </span>
                          {account?.connected && (
                            <span className="connected-label">
                              <Check size={12} /> Connected
                            </span>
                          )}
                        </div>
                        <h3>
                          {info.name}
                          <span>{info.company}</span>
                        </h3>
                        <p>{info.description}</p>
                        <button
                          className={
                            account?.connected
                              ? "button secondary provider-button"
                              : "button provider-button"
                          }
                          disabled={
                            Boolean(busy) ||
                            account?.login?.status === "running" ||
                            !account?.installed
                          }
                          onClick={() =>
                            void attempt("login", async () => {
                              await api(`/accounts/${id}/login`, {});
                              await refreshAccounts();
                            })
                          }
                        >
                          {account?.login?.status === "running" ? (
                            <>
                              <LoaderCircle size={15} className="spin" />
                              Waiting for sign-in…
                            </>
                          ) : account?.connected ? (
                            <>
                              Reconnect <ExternalLink size={14} />
                            </>
                          ) : (
                            <>
                              Connect {info.name} <ExternalLink size={14} />
                            </>
                          )}
                        </button>
                        {!account?.installed && (
                          <small className="provider-note">
                            CLI unavailable. Run npm install.
                          </small>
                        )}
                        {account?.login && (
                          <details
                            className="login-detail"
                            open={
                              account.login.status === "running" ||
                              account.login.status === "failed"
                            }
                          >
                            <summary>Sign-in status</summary>
                            <pre>{account.login.output}</pre>
                            {account.login.status === "running" && (
                              <button
                                className="text-button"
                                onClick={() =>
                                  void attempt("cancel-login", async () => {
                                    await api(`/accounts/${id}/cancel`, {});
                                    await refreshAccounts();
                                  })
                                }
                              >
                                Cancel sign-in
                              </button>
                            )}
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="panel-note">
                  <ShieldCheck size={16} />
                  <span>
                    Sign-in opens in your browser. Each provider’s official CLI manages its credentials.
                  </span>
                  <button
                    className="text-button"
                    disabled={Boolean(busy)}
                    onClick={() => void attempt("refresh", refreshAccounts)}
                  >
                    Refresh status
                  </button>
                </div>
              </section>
              <section className="panel context-panel">
                <div className="section-heading">
                  <div>
                    <h2>
                      <span className="section-number">02</span> Add context
                    </h2>
                    <p>
                      Give the agent product knowledge, instructions and constraints.
                    </p>
                  </div>
                  <span className="badge">Optional</span>
                </div>
                <label className="field-label" htmlFor="context">
                  Agent instructions
                </label>
                <textarea
                  id="context"
                  value={settings.context}
                  maxLength={30000}
                  onChange={(e) => updateSettings({ context: e.target.value })}
                  placeholder="Prioritize search, product pages and the cart in our B2B store…"
                  rows={4}
                />
                <div className="field-heading">
                  <label className="field-label">Context directories</label>
                  <span className="small muted">
                    Skills · Instructions · Guardrails
                  </span>
                </div>
                {settings.directories.map((directory, index) => (
                  <div className="directory-input" key={index}>
                    <FolderOpen size={17} />
                    <input
                      aria-label={`Directory ${index + 1}`}
                      value={directory}
                      onChange={(e) =>
                        updateSettings({
                          directories: settings.directories.map((old, i) =>
                            i === index ? e.target.value : old,
                          ),
                        })
                      }
                      placeholder="/path/to/project/.agents"
                    />
                    <button
                      aria-label={`Remove directory ${index + 1}`}
                      onClick={() =>
                        updateSettings({
                          directories: settings.directories.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <button
                  className="add-directory"
                  disabled={settings.directories.length >= 12}
                  onClick={() =>
                    updateSettings({
                      directories: [...settings.directories, ""],
                    })
                  }
                >
                  <Plus size={16} />
                  {settings.directories.length
                    ? "Add another directory"
                    : "Add a local directory"}
                  <span>Absolute path</span>
                </button>
                <div className="context-footer">
                  <p className="small muted">
                    <FileText size={14} />
                    The agent reads text files and sends the selected context to your AI provider.
                  </p>
                  <button
                    className="text-button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void attempt("preview", async () =>
                        setPreview(await api("/context/preview", settings)),
                      )
                    }
                  >
                    Review files
                  </button>
                </div>
                {preview && (
                  <div className="context-preview">
                    <strong>
                      {preview.files.length} files ·{" "}
                      {preview.characters.toLocaleString("en")} characters
                    </strong>
                    {preview.files.map((file) => (
                      <div key={file.path} className="mono small">
                        {file.path}
                      </div>
                    ))}
                    {preview.warnings.map((warning, i) => (
                      <p className="small" key={i}>
                        {warning}
                      </p>
                    ))}
                  </div>
                )}
              </section>
              <div className="page-footer">
                <span className="small muted">
                  {dirty
                    ? "You have unsaved changes."
                    : "Connect one account to get started."}
                </span>
                <div className="button-group">
                  <button
                    className="button secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void attempt("save", saveSettings)}
                  >
                    Save settings
                  </button>
                  <button
                    className="button primary"
                    disabled={!connected.length || Boolean(busy)}
                    onClick={() =>
                      void attempt("continue", async () => {
                        await saveSettings();
                        setInput((old) => ({
                          ...old,
                          provider: connected.some((a) => a.id === old.provider)
                            ? old.provider
                            : connected[0].id,
                        }));
                        setPage("explore");
                      })
                    }
                  >
                    Start exploring <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            </>
          ) : page === "result" && run ? (
            <>
              <button
                className="text-button back"
                onClick={() => setPage("explore")}
              >
                <ArrowLeft size={15} /> New exploration
              </button>
              <div className="page-heading result-heading">
                <div>
                  <div className="eyebrow">
                    EXPLORATION · {scopes[run.scope].label.toUpperCase()}
                  </div>
                  <h1>{new URL(run.url).hostname}</h1>
                  <p className="mono target-url">{run.url}</p>
                </div>
                <span className={"status-pill " + run.status}>
                  {working && <LoaderCircle size={13} className="spin" />}
                  {statusNames[run.status]}
                </span>
              </div>
              <div className="result-stats">
                <div>
                  <span>PROVIDER</span>
                  <strong>{providerInfo[run.provider].name}</strong>
                  <small>{run.model || "Default model"}</small>
                </div>
                <div>
                  <span>OBSERVED ACTIONS</span>
                  <strong>
                    {run.evidence.filter((e) => e.ok).length}
                    <small> / {scopes[run.scope].calls}</small>
                  </strong>
                  <small>Recorded by Playwright</small>
                </div>
                <div>
                  <span>GENERATED FLOWS</span>
                  <strong>{run.report?.flows.length ?? "—"}</strong>
                  <small>Awaiting execution</small>
                </div>
                <div>
                  <span>APPLIED CONTEXT</span>
                  <strong>
                    {run.contextFiles.length}
                    <small> files</small>
                  </strong>
                  <small>{readableDate(run.createdAt)}</small>
                </div>
              </div>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>
                      <CircleDot size={18} /> {run.phase}
                    </h2>
                    <p>
                      {working
                        ? "The agent is exploring the site and recording its behavior."
                        : run.report?.summary ||
                          "Review the evidence and diagnostics for this exploration."}
                    </p>
                  </div>
                  {working ? (
                    <button
                      className="button secondary"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void attempt("cancel", async () => {
                          await api(`/runs/${run.id}/cancel`, {});
                        })
                      }
                    >
                      <Square size={13} /> Stop
                    </button>
                  ) : run.report ? (
                    <button
                      className="button primary"
                      onClick={() => void attempt("download", download)}
                      disabled={Boolean(busy)}
                    >
                      <ArrowDownToLine size={16} /> Download suite
                    </button>
                  ) : null}
                </div>
                {run.error && <div className="alert error">{run.error}</div>}
                <a className="button secondary diagnosis-link" href={"/diagnostico/"+run.id}>View diagnostics and trace</a>
                {working && (
                  <div className="progress-track">
                    <span />
                  </div>
                )}
                <details className="evidence-list" open={working}>
                  <summary>
                    <Terminal size={15} /> Observed journey{" "}
                    <span>{run.evidence.length} events</span>
                    <ChevronDown size={15} />
                  </summary>
                  {!run.evidence.length && (
                    <p className="muted small">
                      {working
                        ? "Waiting for the agent to connect to Playwright…"
                        : "No navigation evidence available."}
                    </p>
                  )}
                  {run.evidence.map((event) => (
                    <details key={event.id} className="evidence-event">
                      <summary>
                        <span
                          className={"evidence-dot " + (event.ok ? "ok" : "")}
                        />
                        <span className="mono">
                          #{event.id} {event.tool.replace("browser_", "")}
                        </span>
                        {event.externalUrl && (
                          <span className="badge">External destination</span>
                        )}
                        <time>
                          {new Date(event.at).toLocaleTimeString("en")}
                        </time>
                      </summary>
                      <pre>{event.detail}</pre>
                    </details>
                  ))}
                </details>
              </section>
              <Library runId={run.id} revision={run.status+run.evidence.length}/>
              {run.report && (
                <section className="flows-section">
                  <div className="section-heading">
                    <div>
                      <h2>
                        Characterized behavior{" "}
                        <span className="count-badge">
                          {run.report.flows.length}
                        </span>
                      </h2>
                      <p>
                        Each flow records observed behavior. Run the generated tests to verify it.
                      </p>
                    </div>
                    <Code2 size={21} />
                  </div>
                  {run.report.flows.map((flow, index) => (
                    <details className="flow-card" key={index}>
                      <summary>
                        <span className="flow-index">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <strong>{flow.title}</strong>
                        <span className="badge">Generated</span>
                        <ChevronDown size={17} />
                      </summary>
                      <div className="flow-body">
                        <h4>Steps</h4>
                        <ol>
                          {flow.steps.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ol>
                        <h4>Observed outcome</h4>
                        <p>{flow.observed}</p>
                        <p className="small muted">
                          Evidence:{" "}
                          {flow.evidenceIds.map((id) => "#" + id).join(", ")}
                        </p>
                        <h4>Playwright test</h4>
                        <pre className="code-preview">{flow.testCode}</pre>
                      </div>
                    </details>
                  ))}
                </section>
              )}
              {Boolean(run.report?.gaps.length || run.warnings.length) && (
                <section className="panel limits">
                  <h2>Coverage and remaining work</h2>
                  <ul>
                    {[...run.warnings, ...(run.report?.gaps ?? [])].map(
                      (gap, i) => (
                        <li key={i}>{gap}</li>
                      ),
                    )}
                  </ul>
                </section>
              )}
              {!!run.logs.length && (
                <details className="panel diagnostics">
                  <summary>Provider diagnostics</summary>
                  <pre>{run.logs.join("")}</pre>
                </details>
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div className="eyebrow">
                  CHARACTERIZATION
                </div>
                <h1>Discover what your site does.</h1>
                <p>
                  An agent explores your product and turns existing flows into characterization tests.
                </p>
              </div>
              <div className="explore-layout">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void attempt("start", async () => {
                      if (dirty) await saveSettings();
                      const started = await api<Run>("/runs", input);
                      setRun(started);
                      setPage("result");
                      await refreshHistory();
                    });
                  }}
                >
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <h2>
                          <Globe2 size={19} /> Explore a website
                        </h2>
                        <p>
                          Enter a public URL or an environment you can access from this computer.
                        </p>
                      </div>
                    </div>
                    <label className="field-label" htmlFor="url">
                      Starting URL <span className="required-star">*</span>
                    </label>
                    <div className="url-input">
                      <Globe2 size={18} />
                      <input
                        id="url"
                        type="url"
                        required
                        placeholder="https://example.com"
                        value={input.url}
                        onChange={(e) =>
                          setInput({ ...input, url: e.target.value })
                        }
                      />
                    </div>
                    <label className="field-label spaced" htmlFor="prompt">
                      What should the agent focus on?{" "}
                      <span className="muted normal">Optional</span>
                    </label>
                    <textarea
                      id="prompt"
                      rows={4}
                      value={input.prompt}
                      maxLength={30000}
                      onChange={(e) =>
                        setInput({ ...input, prompt: e.target.value })
                      }
                      placeholder="Explore the catalog, filters and product pages. Include empty states and validation messages…"
                    />
                  </section>
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <h2>
                          <Layers3 size={19} /> Coverage depth
                        </h2>
                        <p>Choose how thoroughly the agent explores your site.</p>
                      </div>
                    </div>
                    <div className="scope-grid">
                      {Object.entries(scopes).map(([key, scope], i) => (
                        <label
                          className={
                            "scope-card " +
                            (input.scope === key ? "active" : "")
                          }
                          key={key}
                        >
                          <input
                            type="radio"
                            name="scope"
                            value={key}
                            checked={input.scope === key}
                            onChange={() =>
                              setInput({
                                ...input,
                                scope: key as RunInput["scope"],
                              })
                            }
                          />
                          <div className="scope-top">
                            <span className="scope-bars">
                              {[0, 1, 2, 3].map((n) => (
                                <i key={n} className={n <= i ? "filled" : ""} />
                              ))}
                            </span>
                            {input.scope === key ? (
                              <CheckCircle2 size={16} />
                            ) : (
                              <Circle size={16} />
                            )}
                          </div>
                          <strong>{scope.label}</strong>
                          <p>{scope.description}</p>
                          <small>Up to {scope.calls} actions</small>
                        </label>
                      ))}
                    </div>
                  </section>
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <h2>
                          <Sparkles size={18} /> Configure the agent
                        </h2>
                      </div>
                    </div>
                    <div className="agent-fields">
                      <label className="field-label">
                        Provider
                        <select
                          value={input.provider}
                          onChange={(e) =>
                            setInput({
                              ...input,
                              provider: e.target.value as Provider,
                              model: "",
                              effort: "default",
                            })
                          }
                        >
                          {(["codex", "claude", "copilot"] as Provider[]).map(
                            (id) => (
                              <option
                                key={id}
                                value={id}
                                disabled={
                                  !accounts.find((a) => a.id === id)?.connected
                                }
                              >
                                {providerInfo[id].name}
                                {accounts.find((a) => a.id === id)?.connected
                                  ? ""
                                  : " · Disconnected"}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label className="field-label">
                        Model
                        <input
                          value={input.model}
                          onChange={(e) =>
                            setInput({ ...input, model: e.target.value })
                          }
                          list="models"
                          placeholder="Provider default"
                        />
                        <datalist id="models">
                          {models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name}
                            </option>
                          ))}
                        </datalist>
                      </label>
                      <label className="field-label">
                        Reasoning effort
                        <select
                          value={input.effort}
                          onChange={(e) =>
                            setInput({
                              ...input,
                              effort: e.target.value as RunInput["effort"],
                            })
                          }
                        >
                          <option value="default">Default</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="xhigh">Very high</option>
                        </select>
                      </label>
                    </div>
                    <p className="small muted model-note">
                      Enter any model ID available to your account. Supported reasoning levels depend on the model.
                    </p>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={input.headed}
                        onChange={(e) =>
                          setInput({ ...input, headed: e.target.checked })
                        }
                      />
                      <span>Show the browser during exploration</span>
                    </label>
                  </section>
                  {!connected.length && (
                    <div className="alert">
                      <span>Connect an AI account to get started.</span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setPage("settings")}
                      >
                        Open settings <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                  <div className="page-footer">
                    <span className="small muted">
                      {scopes[input.scope].minutes} min maximum · Stop at any time.
                    </span>
                    <button
                      className="button primary launch"
                      type="submit"
                      disabled={
                        Boolean(busy) ||
                        !accounts.find((a) => a.id === input.provider)
                          ?.connected
                      }
                    >
                      {busy === "start" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Play size={15} />
                      )}{" "}
                      Start characterization
                    </button>
                  </div>
                </form>
                <aside className="explore-aside">
                  <div className="outcome-illustration">
                    <div className="illustration-orbit" />
                    <div className="illustration-window">
                      <div>
                        <i />
                        <i />
                        <i />
                      </div>
                      <span />
                      <span />
                      <span />
                      <b>
                        <Check size={16} />
                      </b>
                    </div>
                    <span className="illustration-tag">
                      <Code2 size={14} /> Playwright
                    </span>
                  </div>
                  <div className="eyebrow">EXPLORATION OUTPUT</div>
                  <h3>
                    A functional snapshot
                    <br />
                    of your product.
                  </h3>
                  <p>
                    Characterization tests capture how the site behaves today, including unexpected outcomes.
                  </p>
                  <ul className="outcomes">
                    <li>
                      <Check size={15} />
                      Observed flows and outcomes
                    </li>
                    <li>
                      <Check size={15} />
                      Playwright tests with assertions
                    </li>
                    <li>
                      <Check size={15} />
                      Evidence for each journey
                    </li>
                    <li>
                      <Check size={15} />
                      Coverage and remaining gaps
                    </li>
                  </ul>
                  <div className="aside-divider" />
                  <div className="context-summary">
                    <FolderOpen size={17} />
                    <div>
                      <strong>Exploration context</strong>
                      <span>
                        {settings.directories.length} directories ·{" "}
                        {settings.context
                          ? "Instructions included"
                          : "No additional instructions"}
                      </span>
                      <button
                        className="text-button"
                        onClick={() => setPage("settings")}
                      >
                        Edit context <ArrowRight size={13} />
                      </button>
                    </div>
                  </div>
                  <p className="domain-note">
                    <ExternalLink size={14} />
                    The agent follows routes and subdomains within the site. External redirects are recorded as cases.
                  </p>
                </aside>
              </div>
            </>
          )}
          <footer className="main-footer">
            <Radar size={13} /> Characterize{" "}
            <span>Record how your site behaves today.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(location.pathname.match(/^\/diagnostico\/([a-f0-9-]{36})$/) ? <Diagnosis id={location.pathname.split("/")[2]}/> : <App />);
