import { spawn, type ChildProcess } from "node:child_process";

export function clean(text: string) {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]+)\b/g,
      "[REDACTED]",
    )
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
}
export function terminate(child: ChildProcess) {
  if (!child.pid) return;
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  kill("SIGTERM");
  const timer = setTimeout(() => kill("SIGKILL"), 2000);
  timer.unref();
}
export function execute(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    timeout?: number;
    idleTimeout?: number;
    idleTimeoutFor?: () => number;
    deadlineAt?: () => number | undefined;
    activityAt?: () => number;
    signal?: AbortSignal;
    onOutput?: (text: string, kind: "out" | "err") => void;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      if (options.signal?.aborted) return reject(new Error("Cancelled"));
      const env = { ...(options.env ?? process.env) };
      delete env.CLAUDECODE;
      const child = spawn(binary, args, {
        cwd: options.cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        timedOut = false,
        overflow = false;
      let lastActivity = Date.now();
      let idleTimedOut = false;
      let idleLimit = options.idleTimeout;
      const abort = () => terminate(child);
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, options.timeout ?? 15000);
      const idleTimer = options.idleTimeout ? setInterval(() => {
        lastActivity = Math.max(lastActivity, options.activityAt?.() ?? 0);
        const deadline = options.deadlineAt?.();
        if (deadline && Date.now() >= deadline) {
          timedOut = true;
          clearInterval(idleTimer);
          terminate(child);
          return;
        }
        idleLimit = options.idleTimeoutFor?.() ?? options.idleTimeout;
        if (Date.now() - lastActivity < idleLimit!) return;
        idleTimedOut = true;
        clearInterval(idleTimer);
        terminate(child);
      }, Math.min(1000, options.idleTimeout)) : undefined;
      const output = (kind: "out" | "err", data: Buffer) => {
        const value = data.toString();
        lastActivity = Date.now();
        if (stdout.length + stderr.length + value.length > 8_000_000) {
          overflow = true;
          terminate(child);
          return;
        }
        if (kind === "out") stdout += value;
        else stderr += value;
        options.onOutput?.(clean(value), kind);
      };
      child.stdout.on("data", (data) => output("out", data));
      child.stderr.on("data", (data) => output("err", data));
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(idleTimer);
        options.signal?.removeEventListener("abort", abort);
      };
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        cleanup();
        if (options.signal?.aborted) reject(new Error("Cancelled"));
        else if (idleTimedOut) reject(new Error("Exploration stopped after " + Math.ceil(idleLimit! / 1000) + " seconds without provider or browser activity. Recorded evidence has been preserved."));
        else if (timedOut)
          reject(new Error("Execution timed out."));
        else if (overflow)
          reject(
            new Error("Provider output exceeds the 8 MB limit."),
          );
        else resolve({ code: code ?? 1, stdout, stderr });
      });
    },
  );
}
