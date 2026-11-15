import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { binaryFor } from "./providers.ts";
import { terminate } from "./process.ts";

export type ModelOption = { id: string; name: string; efforts: string[] };
export async function codexModels(cwd: string): Promise<ModelOption[]> {
  const binary = binaryFor("codex");
  if (!binary) return [];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (models?: ModelOption[], error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      terminate(child);
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const timer = setTimeout(
      () =>
        finish(
          [],
          new Error(
            "Model catalog unavailable. Enter a model ID manually.",
          ),
        ),
      15000,
    );
    const send = (message: unknown) =>
      child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.on("error", (error) => finish([], error));
    child.on("close", () => finish([]));
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.error) return finish([]);
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "model/list", params: { limit: 100 } });
        } else if (message.id === 2) {
          finish(
            (message.result?.data ?? [])
              .filter((m: { hidden?: boolean }) => !m.hidden)
              .map(
                (m: {
                  id: string;
                  model?: string;
                  displayName?: string;
                  supportedReasoningEfforts?: { reasoningEffort: string }[];
                }) => ({
                  id: m.model ?? m.id,
                  name: m.displayName ?? m.model ?? m.id,
                  efforts: (m.supportedReasoningEfforts ?? []).map(
                    (e) => e.reasoningEffort,
                  ),
                }),
              ),
          );
        }
      } catch {
        /* Ignore non-protocol output. */
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "characterize_catalog", version: "0.1.0" },
      },
    });
  });
}
