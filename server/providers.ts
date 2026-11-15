import { existsSync, accessSync, constants, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { providers, type Provider, type Account } from "../shared/model.ts";
import { execute, clean } from "./process.ts";
import { saveJSON } from "./store.ts";

export function binaryFor(provider: Provider): string | undefined {
  const candidates = [
    ...(process.env.PATH ?? "").split(":").map((dir) => join(dir, provider)),
    resolve("node_modules/.bin", provider),
    ...(provider === "codex"
      ? [
          "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        ]
      : []),
    join(homedir(), ".local", "bin", provider),
  ];
  return candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export class Accounts {
  private logins = new Map<
    Provider,
    { status: string; output: string; abort: AbortController }
  >();
  private copilotConnected = false;
  constructor(private root: string) {
    const marker = join(root, "accounts.json");
    if (existsSync(marker)) {
      try {
        this.copilotConnected =
          JSON.parse(readFileSync(marker, "utf8")).copilot === true;
      } catch {}
    }
  }
  async status(id: Provider): Promise<Account> {
    const binary = binaryFor(id);
    const login = this.logins.get(id);
    const account: Account = {
      id,
      installed: Boolean(binary),
      connected: false,
      login: login ? { status: login.status, output: login.output } : undefined,
    };
    if (!binary)
      return {
        ...account,
        message: "CLI no instalada. Ejecuta npm install en este proyecto.",
      };
    try {
      const version = await execute(binary, ["--version"], { timeout: 10000 });
      account.version = clean(version.stdout).trim().slice(0, 120);
      if (id === "copilot") {
        account.connected = this.copilotConnected;
        account.message = this.copilotConnected
          ? "Login completado. El acceso se comprueba de nuevo al ejecutar."
          : "Conecta tu cuenta de GitHub para habilitar Copilot.";
      } else {
        const result = await execute(
          binary,
          id === "codex" ? ["login", "status"] : ["auth", "status"],
          { timeout: 10000 },
        );
        account.connected = result.code === 0;
        account.message = account.connected
          ? "Sesión disponible en la CLI oficial."
          : "Inicia sesión en el navegador.";
      }
    } catch (error) {
      account.message = (error as Error).message;
    }
    return account;
  }
  async all() {
    return Promise.all(providers.map((id) => this.status(id)));
  }
  startLogin(id: Provider) {
    const binary = binaryFor(id);
    if (!binary) throw new Error("CLI no instalada. Ejecuta npm install.");
    if (this.logins.get(id)?.status === "running") return;
    const login = {
      status: "running",
      output: "Abriendo el login oficial en tu navegador…\n",
      abort: new AbortController(),
    };
    this.logins.set(id, login);
    const args =
      id === "claude"
        ? ["auth", "login"]
        : id === "copilot"
          ? ["login", "--web-flow"]
          : ["login"];
    void execute(binary, args, {
      cwd: this.root,
      timeout: 5 * 60 * 1000,
      signal: login.abort.signal,
      onOutput: (value) => {
        login.output = (login.output + value).slice(-12000);
      },
    })
      .then((result) => {
        login.status = result.code === 0 ? "completed" : "failed";
        if (id === "copilot" && result.code === 0) {
          this.copilotConnected = true;
          saveJSON(join(this.root, "accounts.json"), { copilot: true });
        }
        if (result.code !== 0)
          login.output += `\nEl login terminó con código ${result.code}.`;
      })
      .catch((error) => {
        login.status = "failed";
        login.output += "\n" + clean(error.message);
      });
  }
  cancelLogin(id: Provider) {
    this.logins.get(id)?.abort.abort();
  }
  shutdown() {
    for (const login of this.logins.values()) login.abort.abort();
  }
}
