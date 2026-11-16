import { existsSync, accessSync, constants, mkdirSync, chmodSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { providers, type Provider, type Account } from "../shared/model.ts";
import { execute, clean } from "./process.ts";

export function copilotSignInUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || (url.port && url.port !== "443") || url.pathname !== "/login/oauth/authorize")
    throw new Error("Unexpected sign-in destination.");
  url.searchParams.set("prompt", "select_account");
  return url.href;
}

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
    { status: string; output: string; abort: AbortController; url?: string; prompt?: NonNullable<Account["login"]>["prompt"]; answer?: (value: string) => void }
  >();
  constructor(private root: string) {}
  environment(id: Provider): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of [
      "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL",
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_COPILOT_API_TOKEN",
    ]) delete env[key];
    for (const key of Object.keys(env))
      if (key.startsWith("COPILOT_") || key.startsWith("OTEL_") || key.startsWith("CLAUDE_CODE_USE_") || key === "ANTHROPIC_CUSTOM_HEADERS" || key === "GH_HOST") delete env[key];
    const home = join(this.root, "accounts", id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(home, 0o700);
    if (id === "codex") env.CODEX_HOME = home;
    if (id === "claude") env.CLAUDE_CONFIG_DIR = home;
    if (id === "copilot") {
      env.COPILOT_HOME = home;
      env.COPILOT_DISABLE_KEYTAR = "1";
      env.COPILOT_CACHE_HOME = join(home, "cache");
      env.GH_CONFIG_DIR = join(home, "gh");
    }
    return env;
  }
  private client() {
    return new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: binaryFor("copilot")!, args: ["--no-auto-update", "--no-custom-instructions", "--disable-builtin-mcps", "--disable-client-telemetry", "--sync-session=off"] }),
      env: Object.fromEntries(Object.entries(this.environment("copilot")).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      workingDirectory: this.root,
      baseDirectory: join(this.root, "accounts", "copilot"),
      mode: "empty",
      logLevel: "none",
    });
  }
  async models() {
    const client = this.client();
    try {
      await client.start();
      const models = await client.listModels();
      return models.map(model => ({ id: model.id, name: model.name, efforts: [] as string[] }));
    } finally { await client.forceStop(); }
  }
  async status(id: Provider): Promise<Account> {
    const binary = binaryFor(id);
    const login = this.logins.get(id);
    const account: Account = {
      id,
      installed: Boolean(binary),
      connected: false,
      login: login ? { status: login.status, output: login.output, url: login.url, prompt: login.prompt } : undefined,
    };
    if (!binary)
      return {
        ...account,
        message: "CLI unavailable. Run npm install in this project.",
      };
    try {
      const env = this.environment(id);
      const version = await execute(binary, ["--version"], { timeout: 10000, env });
      account.version = clean(version.stdout).trim().slice(0, 120);
      if (id === "copilot") {
        if (login?.status !== "running" && existsSync(join(this.root, "accounts", id, "config.json"))) {
          const client = this.client();
          try {
            await client.start();
            const status = await client.getAuthStatus();
            account.connected = status.isAuthenticated && status.authType === "user";
          } finally { await client.forceStop(); }
        }
        account.message = account.connected ? "Signed in through the official SDK." : "Connect your GitHub account to enable Copilot.";
      } else {
        const result = await execute(
          binary,
          id === "codex" ? ["login", "status"] : ["auth", "status"],
          { timeout: 10000, env },
        );
        account.connected = result.code === 0;
        account.message = account.connected
          ? "Signed in through the official CLI."
          : "Sign in through your browser.";
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
    if (!binary) throw new Error("CLI unavailable. Run npm install.");
    if (this.logins.get(id)?.status === "running") return;
    const login = {
      status: "running",
      output: "Opening sign-in in your browser…\n",
      abort: new AbortController(),
    };
    this.logins.set(id, login);
    if (id === "copilot") {
      void this.loginCopilot().catch(error => {
        login.status = login.abort.signal.aborted ? "cancelled" : "failed";
        login.output = clean(error.message);
      });
      return;
    }
    const args =
      id === "claude"
        ? ["auth", "login", "--claudeai"]
        : ["login"];
    void execute(binary, args, {
      cwd: this.root,
      timeout: 5 * 60 * 1000,
      signal: login.abort.signal,
      env: this.environment(id),
      onOutput: (value) => {
        login.output = (login.output + value).slice(-12000);
      },
    })
      .then((result) => {
        login.status = result.code === 0 ? "completed" : "failed";
        if (result.code !== 0)
          login.output += `\nSign-in exited with code ${result.code}.`;
      })
      .catch((error) => {
        login.status = "failed";
        login.output += "\n" + clean(error.message);
      });
  }
  cancelLogin(id: Provider) {
    this.logins.get(id)?.abort.abort();
  }
  private async loginCopilot() {
    const login = this.logins.get("copilot")!;
    const client = this.client();
    const sessionId = randomUUID();
    const timer = setTimeout(() => login.abort.abort(), 600000);
    const stop = () => { void client.forceStop(); };
    login.abort.signal.addEventListener("abort", stop, { once: true });
    try {
      await client.start();
      const session = await client.createSession({ sessionId, availableTools: [], mcpServers: {}, onPermissionRequest: async () => ({ kind: "denied-interactively-by-user" }) });
      const flow = await session.rpc.accounts.login.begin({ kind: "githubDotCom", method: "web" });
      let step = flow.step;
      for (;;) {
        if (login.abort.signal.aborted) throw new Error("Sign-in cancelled or expired.");
        let input: string | undefined;
        if (step.kind === "completed" && step.result.status === "completed") break;
        if (step.kind === "open-url") {
          login.url = copilotSignInUrl(step.url);
          login.output = "Complete sign-in on GitHub.";
        } else if (step.kind === "completed") {
          const result = step.result;
          if (result.status === "needs-plaintext-consent") {
            login.prompt = { message: "Copilot needs to store a credential without encryption in this application's private directory. Allow only on a trusted computer.", choices: [{ value: "allow", label: "Save connection" }, { value: "deny", label: "Do not save" }] };
          } else if (result.status === "needs-account-selection" && result.accounts?.length) {
            login.prompt = { message: "Choose the account to connect to Copilot.", choices: result.accounts.map(account => ({ value: account.selectionId, label: `${account.login} (${account.host})` })) };
          } else throw new Error("Copilot did not complete sign-in.");
          login.url = undefined;
          input = await new Promise<string>((resolve, reject) => {
            const abort = () => reject(new Error("Sign-in cancelled."));
            login.abort.signal.addEventListener("abort", abort, { once: true });
            login.answer = value => { login.abort.signal.removeEventListener("abort", abort); resolve(value); };
          });
          login.answer = undefined;
          login.prompt = undefined;
        } else if (step.kind !== "awaiting") throw new Error("Unsupported sign-in step.");
        step = await session.rpc.accounts.login.advance({ flowId: flow.flowId, ...(input === undefined ? {} : { input }) });
      }
      const status = await client.getAuthStatus();
      if (!status.isAuthenticated || status.authType !== "user") throw new Error("Copilot has not confirmed the account.");
      login.status = "completed";
      login.output = "Account connected.";
      await client.deleteSession(sessionId);
    } finally {
      clearTimeout(timer);
      login.abort.signal.removeEventListener("abort", stop);
      login.url = undefined;
      login.prompt = undefined;
      login.answer = undefined;
      await client.forceStop();
      rmSync(join(this.root, "accounts", "copilot", "session-state", sessionId), { recursive: true, force: true });
    }
  }
  answerLogin(id: Provider, value: string) {
    const login = this.logins.get(id);
    if (!login?.answer || !login.prompt?.choices.some(choice => choice.value === value)) throw new Error("This confirmation is no longer available.");
    login.answer(value);
    login.answer = undefined;
    login.prompt = undefined;
  }
  async disconnect(id: Provider) {
    if (this.logins.get(id)?.status === "running") throw new Error("Cancel the pending sign-in first.");
    if (id === "copilot") rmSync(join(this.root, "accounts", id, "config.json"), { force: true });
    else {
      const result = await execute(binaryFor(id)!, id === "codex" ? ["logout"] : ["auth", "logout"], { env: this.environment(id), timeout: 10000 });
      if (result.code !== 0) throw new Error("Could not disconnect the account.");
    }
    this.logins.delete(id);
  }
  shutdown() {
    for (const login of this.logins.values()) login.abort.abort();
  }
}
