import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";

type HostEvent = { type: string; [key: string]: unknown };

interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface CustomAgentConfig {
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface AgentChoice {
  id: string;
  registryId?: string;
  source: "bundled" | "custom" | "registry";
  name: string;
  version?: string;
  description: string;
  license?: string;
  ready: boolean;
  installable: boolean;
  requirement?: string;
  launch?: LaunchSpec;
}

interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  license?: string;
  installed: boolean;
  available: boolean;
  requirement?: string;
  launch?: LaunchSpec;
}

interface EnvAuthVariable {
  name: string;
  label?: string;
  secret?: boolean;
  optional?: boolean;
}

interface EnvAuthMethod {
  type: "env_var";
  id: string;
  name: string;
  vars: EnvAuthVariable[];
}

class AgentCatalog {
  private official = new Map<string, AgentChoice>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  updateOfficial(entries: unknown): void {
    if (!Array.isArray(entries)) {
      return;
    }
    this.official.clear();
    for (const value of entries) {
      const agent = value as Partial<RegistryAgent>;
      if (
        typeof agent.id !== "string" ||
        typeof agent.name !== "string" ||
        typeof agent.version !== "string" ||
        typeof agent.description !== "string"
      ) {
        continue;
      }
      const id = `registry:${agent.id}`;
      this.official.set(id, {
        id,
        registryId: agent.id,
        source: "registry",
        name: agent.name,
        version: agent.version,
        description: agent.description,
        license: typeof agent.license === "string" ? agent.license : undefined,
        ready: isLaunchSpec(agent.launch),
        installable: agent.available === true && !isLaunchSpec(agent.launch),
        requirement: typeof agent.requirement === "string" ? agent.requirement : undefined,
        launch: isLaunchSpec(agent.launch) ? agent.launch : undefined,
      });
    }
  }

  list(): AgentChoice[] {
    return [...this.localAgents(), ...this.official.values()];
  }

  get(id: string): AgentChoice | undefined {
    return this.list().find((agent) => agent.id === id);
  }

  publicList(): Array<Omit<AgentChoice, "launch" | "registryId">> {
    return this.list().map(({ launch: _launch, registryId: _registryId, ...agent }) => agent);
  }

  defaultAgentId(): string {
    const saved = this.context.workspaceState.get<string>("brokkAcp.selectedAgent");
    const configured = vscode.workspace
      .getConfiguration("brokkAcp")
      .get<string>("defaultAgent", "bundled:anvil");
    return saved || configured;
  }

  async select(id: string): Promise<void> {
    await this.context.workspaceState.update("brokkAcp.selectedAgent", id);
  }

  private localAgents(): AgentChoice[] {
    const agents: AgentChoice[] = [
      {
        id: "bundled:anvil",
        source: "bundled",
        name: "Anvil",
        description: "BrokkAI's bundled Rust ACP coding agent",
        ready: true,
        installable: false,
        launch: {
          command: resolveAnvilExecutable(this.context),
          args: [],
          env: {},
        },
      },
    ];
    const configured = vscode.workspace
      .getConfiguration("brokkAcp")
      .get<Record<string, CustomAgentConfig>>("customAgents", {});
    for (const [key, value] of Object.entries(configured)) {
      if (
        !isRecord(value) ||
        typeof value.command !== "string" ||
        !value.command.trim() ||
        (value.args !== undefined && !isStringArray(value.args)) ||
        (value.env !== undefined && !isStringRecord(value.env))
      ) {
        continue;
      }
      agents.push({
        id: `custom:${key}`,
        source: "custom",
        name: value.name?.trim() || key,
        description: value.command,
        ready: true,
        installable: false,
        launch: {
          command: value.command,
          args: value.args ?? [],
          env: value.env ?? {},
        },
      });
    }

    const legacyCommand = vscode.workspace
      .getConfiguration("brokkAcp")
      .get<string>("agent.command", "anvil")
      .trim();
    if (legacyCommand && legacyCommand !== "anvil") {
      agents.push({
        id: "custom:legacy",
        source: "custom",
        name: "Legacy custom agent",
        description: legacyCommand,
        ready: true,
        installable: false,
        launch: {
          command: legacyCommand,
          args: vscode.workspace.getConfiguration("brokkAcp").get<string[]>("agent.args", []),
          env: {},
        },
      });
    }
    return agents;
  }
}

class RustHost implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private currentLaunch: LaunchSpec | undefined;
  private pendingReconnect: LaunchSpec | undefined;
  private readonly events = new vscode.EventEmitter<HostEvent>();
  private readonly output = vscode.window.createOutputChannel("Brokk ACP");
  readonly onEvent = this.events.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async listAgents(): Promise<void> {
    await this.ensureStorage();
    this.send({
      type: "list_agents",
      storage_dir: this.context.globalStorageUri.fsPath,
      registry_url: registryUrl(),
    });
  }

  async installAgent(agentId: string): Promise<void> {
    await this.ensureStorage();
    this.send({
      type: "install_agent",
      agent_id: agentId,
      storage_dir: this.context.globalStorageUri.fsPath,
      registry_url: registryUrl(),
    });
  }

  connect(launch: LaunchSpec): void {
    const workspace = workspacePath();
    this.currentLaunch = launch;
    this.send({
      type: "connect",
      command: launch.command,
      args: launch.args,
      env: launch.env,
      cwd: workspace,
    });
  }

  send(command: object): void {
    const child = this.ensureStarted();
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  disconnectSession(): void {
    if (this.child) {
      this.child.stdin.write(`${JSON.stringify({ type: "disconnect" })}\n`);
    }
  }

  reconnectWithEnvironment(env: Record<string, string>): void {
    if (!this.currentLaunch) {
      throw new Error("No ACP agent is connected.");
    }
    this.pendingReconnect = {
      ...this.currentLaunch,
      env: { ...this.currentLaunch.env, ...env },
    };
    this.disconnectSession();
  }

  authenticationScope(): string {
    if (!this.currentLaunch) {
      throw new Error("No ACP agent is connected.");
    }
    return createHash("sha256")
      .update(JSON.stringify([this.currentLaunch.command, this.currentLaunch.args]))
      .digest("hex");
  }

  dispose(): void {
    const child = this.child;
    if (child) {
      child.stdin.write(`${JSON.stringify({ type: "disconnect" })}\n`, () => child.stdin.end());
      const forceKill = setTimeout(() => child.kill(), 1_000);
      forceKill.unref();
      child.once("exit", () => clearTimeout(forceKill));
      this.child = undefined;
    }
    this.pendingReconnect = undefined;
    this.events.dispose();
    this.output.dispose();
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    const override = vscode.workspace
      .getConfiguration("brokkAcp")
      .get<string>("host.path", "")
      .trim();
    const executable = override || this.defaultExecutable();
    const child = spawn(executable, [], { cwd: workspacePath(), stdio: "pipe" });
    this.child = child;
    child.on("error", (error) => {
      this.events.fire({ type: "error", message: `Rust host failed: ${error.message}` });
    });
    child.on("exit", (code, signal) => {
      this.events.fire({ type: "host_exited", code, signal });
      if (this.child === child) {
        this.child = undefined;
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this.output.append(text);
      this.events.fire({ type: "log", text });
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line) as HostEvent;
        if (event.type === "terminal_auth") {
          this.openAuthenticationTerminal(event);
        }
        this.events.fire(event);
        if (event.type === "disconnected" && this.pendingReconnect) {
          const launch = this.pendingReconnect;
          this.pendingReconnect = undefined;
          setImmediate(() => this.connect(launch));
        }
      } catch {
        this.events.fire({ type: "error", message: `Invalid host output: ${line}` });
      }
    });
    return child;
  }

  private openAuthenticationTerminal(event: HostEvent): void {
    const command = typeof event.command === "string" ? event.command : this.currentLaunch?.command;
    if (!command) {
      this.events.fire({ type: "error", message: "Authentication command is missing." });
      return;
    }
    const args = Array.isArray(event.args)
      ? event.args.filter((value): value is string => typeof value === "string")
      : [];
    const env = isStringRecord(event.env) ? event.env : {};
    const name = typeof event.name === "string" ? event.name : "ACP agent sign-in";
    const terminal = vscode.window.createTerminal({
      name,
      shellPath: command,
      shellArgs: args,
      env,
      cwd: workspacePath(),
    });
    terminal.show();
  }

  private async ensureStorage(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
  }

  private defaultExecutable(): string {
    const name = process.platform === "win32" ? "brokk-acp-host.exe" : "brokk-acp-host";
    const packaged = path.join(
      this.context.extensionPath,
      "bin",
      `${process.platform}-${process.arch}`,
      name,
    );
    const development = path.join(this.context.extensionPath, "target", "debug", name);
    return this.context.extensionMode === vscode.ExtensionMode.Development
      ? development
      : packaged;
  }
}

class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subscription: vscode.Disposable;
  private readonly authMethods = new Map<string, EnvAuthMethod>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: RustHost,
    private readonly catalog: AgentCatalog,
  ) {
    this.subscription = host.onEvent((event) => this.handleHostEvent(event));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = chatHtml(view.webview);
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message));
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private handleHostEvent(event: HostEvent): void {
    if (event.type === "catalog") {
      this.catalog.updateOfficial(event.agents);
      this.postCatalog(event.cached === true);
      return;
    }
    if (event.type === "auth_required") {
      this.authMethods.clear();
      if (Array.isArray(event.auth_methods)) {
        for (const method of event.auth_methods) {
          if (isEnvAuthMethod(method)) {
            this.authMethods.set(method.id, method);
          }
        }
      }
    }
    this.view?.webview.postMessage(event);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }
    try {
      switch (message.type) {
        case "ready":
          this.postCatalog(false);
          await this.host.listAgents();
          break;
        case "refresh":
          await this.host.listAgents();
          break;
        case "select_agent":
          if (typeof message.agent_id === "string") {
            await this.catalog.select(message.agent_id);
          }
          break;
        case "install":
          if (typeof message.agent_id === "string") {
            const agent = this.catalog.get(message.agent_id);
            if (agent?.source === "registry" && agent.registryId) {
              await this.host.installAgent(agent.registryId);
            }
          }
          break;
        case "connect":
          if (typeof message.agent_id === "string") {
            const agent = this.catalog.get(message.agent_id);
            if (!agent?.launch) {
              throw new Error("Install this agent before connecting.");
            }
            await this.catalog.select(agent.id);
            this.host.connect(agent.launch);
          }
          break;
        case "disconnect":
          this.host.disconnectSession();
          break;
        case "prompt":
          if (typeof message.text === "string" && message.text.trim()) {
            this.host.send({ type: "prompt", text: message.text.trim() });
          }
          break;
        case "cancel":
          this.host.send({ type: "cancel" });
          break;
        case "permission_response":
          if (typeof message.request_id === "string") {
            this.host.send({
              type: "permission_response",
              request_id: message.request_id,
              option_id: typeof message.option_id === "string" ? message.option_id : null,
            });
          }
          break;
        case "authenticate":
          if (typeof message.method_id === "string") {
            const envMethod = this.authMethods.get(message.method_id);
            if (envMethod) {
              await this.authenticateWithEnvironment(envMethod);
            } else {
              this.host.send({ type: "authenticate", method_id: message.method_id });
            }
          }
          break;
        case "retry_session":
          this.host.send({ type: "retry_session" });
          break;
        case "set_config":
          if (typeof message.config_id === "string" && isRecord(message.value)) {
            this.host.send({
              type: "set_config",
              config_id: message.config_id,
              value: message.value,
            });
          }
          break;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(text);
      this.view?.webview.postMessage({ type: "error", message: text });
    }
  }

  private postCatalog(cached: boolean): void {
    this.view?.webview.postMessage({
      type: "catalog",
      agents: this.catalog.publicList(),
      selected_agent: this.catalog.defaultAgentId(),
      cached,
    });
  }

  private async authenticateWithEnvironment(method: EnvAuthMethod): Promise<void> {
    const scope = this.host.authenticationScope();
    const values: Record<string, string> = {};
    for (const variable of method.vars) {
      const key = `brokkAcp.auth.${scope}.${method.id}.${variable.name}`;
      const saved = await this.context.secrets.get(key);
      const entered = await vscode.window.showInputBox({
        title: method.name,
        prompt: variable.label || variable.name,
        password: variable.secret !== false,
        ignoreFocusOut: true,
        placeHolder: saved
          ? "A value is saved; leave blank to reuse it"
          : variable.optional
            ? "Optional"
            : "Required",
      });
      if (entered === undefined) {
        return;
      }
      const value = entered || saved;
      if (!value) {
        if (variable.optional) {
          continue;
        }
        throw new Error(`${variable.label || variable.name} is required.`);
      }
      values[variable.name] = value;
      if (entered) {
        await this.context.secrets.store(key, entered);
      }
    }
    this.host.reconnectWithEnvironment(values);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const catalog = new AgentCatalog(context);
  const host = new RustHost(context);
  const chat = new ChatView(context, host, catalog);
  context.subscriptions.push(
    host,
    chat,
    vscode.window.registerWebviewViewProvider("brokkAcp.chat", chat),
    vscode.commands.registerCommand("brokkAcp.connect", async () => {
      const available = catalog.list().filter((agent) => agent.ready && agent.launch);
      const picked = await vscode.window.showQuickPick(
        available.map((agent) => ({
          label: agent.name,
          description: agent.source === "registry" ? agent.version : agent.source,
          agent,
        })),
        { placeHolder: "Choose an ACP agent" },
      );
      if (picked?.agent.launch) {
        await catalog.select(picked.agent.id);
        host.connect(picked.agent.launch);
      }
    }),
    vscode.commands.registerCommand("brokkAcp.disconnect", () => host.disconnectSession()),
    vscode.commands.registerCommand("brokkAcp.refreshAgents", () => host.listAgents()),
  );
}

function workspacePath(): string {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) {
    throw new Error("Open a workspace before using an ACP agent.");
  }
  return workspace;
}

function registryUrl(): string {
  return vscode.workspace
    .getConfiguration("brokkAcp")
    .get<string>(
      "registry.url",
      "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    );
}

function resolveAnvilExecutable(context: vscode.ExtensionContext): string {
  const override = vscode.workspace
    .getConfiguration("brokkAcp")
    .get<string>("anvil.path", "")
    .trim();
  if (override) {
    return override;
  }
  const name = process.platform === "win32" ? "anvil.exe" : "anvil";
  const packaged = path.join(
    context.extensionPath,
    "bin",
    `${process.platform}-${process.arch}`,
    name,
  );
  if (fs.existsSync(packaged)) {
    return packaged;
  }
  for (const profile of ["debug", "release"]) {
    const siblingDevelopment = path.resolve(
      context.extensionPath,
      "..",
      "anvil",
      "target",
      profile,
      name,
    );
    if (fs.existsSync(siblingDevelopment)) {
      return siblingDevelopment;
    }
  }
  return name;
}

function isLaunchSpec(value: unknown): value is LaunchSpec {
  if (!isRecord(value) || typeof value.command !== "string") {
    return false;
  }
  return (
    isStringArray(value.args) &&
    isStringRecord(value.env)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEnvAuthMethod(value: unknown): value is EnvAuthMethod {
  if (
    !isRecord(value) ||
    value.type !== "env_var" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Array.isArray(value.vars)
  ) {
    return false;
  }
  return value.vars.every(
    (variable) =>
      isRecord(variable) &&
      typeof variable.name === "string" &&
      (variable.label === undefined || typeof variable.label === "string") &&
      (variable.secret === undefined || typeof variable.secret === "boolean") &&
      (variable.optional === undefined || typeof variable.optional === "boolean"),
  );
}

function chatHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(18).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 12px; }
    button, select, textarea, input { font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; padding: 6px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { cursor: default; opacity: .55; }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    #status { color: var(--vscode-descriptionForeground); margin-bottom: 10px; min-height: 1.4em; }
    .agent-row, .actions, .permission-actions, .auth-actions { display: flex; align-items: center; gap: 7px; }
    .agent-row select { flex: 1; min-width: 0; }
    select, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    select { padding: 5px; }
    #agent-detail { color: var(--vscode-descriptionForeground); font-size: .92em; margin: 8px 0 12px; }
    #config { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
    .config-item { display: flex; flex-direction: column; gap: 3px; min-width: 120px; font-size: .9em; }
    #messages { display: flex; flex-direction: column; gap: 9px; margin: 12px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .message { border-left: 3px solid var(--vscode-focusBorder); padding: 3px 0 3px 9px; }
    .message.user { border-left-color: var(--vscode-charts-blue); }
    .label { color: var(--vscode-descriptionForeground); font-size: .82em; text-transform: uppercase; margin-bottom: 3px; }
    .thought { color: var(--vscode-descriptionForeground); font-style: italic; border-left: 2px solid var(--vscode-descriptionForeground); padding-left: 8px; }
    .tool { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-widget-border); padding: 8px; }
    .tool summary { cursor: pointer; font-weight: 600; }
    .permission, .auth { border: 1px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); padding: 10px; margin: 10px 0; }
    textarea { box-sizing: border-box; width: 100%; min-height: 78px; resize: vertical; padding: 8px; }
    .actions { margin-top: 8px; }
    #send { flex: 1; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="status">Starting Brokk ACP…</div>
  <div class="agent-row">
    <select id="agent" aria-label="ACP agent"></select>
    <button id="refresh" class="secondary" title="Refresh official ACP registry">↻</button>
  </div>
  <div id="agent-detail"></div>
  <div class="agent-row">
    <button id="install" class="hidden">Install</button>
    <button id="connect">Connect</button>
    <button id="disconnect" class="secondary">Disconnect</button>
  </div>
  <div id="auth"></div>
  <div id="config"></div>
  <div id="messages"></div>
  <div id="permissions"></div>
  <textarea id="prompt" placeholder="Ask the selected ACP agent…"></textarea>
  <div class="actions"><button id="send">Send</button><button id="cancel" class="secondary">Stop</button></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const status = document.getElementById('status');
    const agentSelect = document.getElementById('agent');
    const agentDetail = document.getElementById('agent-detail');
    const installButton = document.getElementById('install');
    const connectButton = document.getElementById('connect');
    const messages = document.getElementById('messages');
    const prompt = document.getElementById('prompt');
    const permissions = document.getElementById('permissions');
    const auth = document.getElementById('auth');
    const config = document.getElementById('config');
    let agents = [];
    let assistant;
    let thought;
    const tools = new Map();

    function selectedAgent() {
      return agents.find((entry) => entry.id === agentSelect.value);
    }

    function updateAgentDetail() {
      const agent = selectedAgent();
      if (!agent) return;
      const bits = [agent.description];
      if (agent.version) bits.push('v' + agent.version);
      if (agent.license) bits.push(agent.license);
      if (agent.requirement) bits.push(agent.requirement);
      agentDetail.textContent = bits.filter(Boolean).join(' · ');
      installButton.classList.toggle('hidden', !agent.installable);
      connectButton.disabled = !agent.ready;
      vscode.postMessage({ type: 'select_agent', agent_id: agent.id });
    }

    function appendMessage(kind, label, text) {
      const node = document.createElement('div');
      node.className = 'message ' + kind;
      const heading = document.createElement('div');
      heading.className = 'label';
      heading.textContent = label;
      const content = document.createElement('div');
      content.textContent = text || '';
      node.append(heading, content);
      messages.appendChild(node);
      node.scrollIntoView({ block: 'nearest' });
      return content;
    }

    function flattenOptions(options) {
      if (!Array.isArray(options)) return [];
      const flattened = [];
      for (const entry of options) {
        if (entry && Array.isArray(entry.options)) flattened.push(...entry.options);
        else flattened.push(entry);
      }
      return flattened;
    }

    function renderConfig(options) {
      config.replaceChildren();
      if (!Array.isArray(options)) return;
      for (const option of options) {
        if (!option || !option.id) continue;
        const wrapper = document.createElement('label');
        wrapper.className = 'config-item';
        const title = document.createElement('span');
        title.textContent = option.name || option.id;
        wrapper.appendChild(title);
        if (option.type === 'select') {
          const select = document.createElement('select');
          for (const choice of flattenOptions(option.options)) {
            if (!choice || typeof choice.value !== 'string') continue;
            const node = document.createElement('option');
            node.value = choice.value;
            node.textContent = choice.name || choice.value;
            node.selected = choice.value === option.currentValue;
            select.appendChild(node);
          }
          select.onchange = () => vscode.postMessage({
            type: 'set_config',
            config_id: option.id,
            value: { value: select.value }
          });
          wrapper.appendChild(select);
        } else if (option.type === 'boolean') {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = option.currentValue === true;
          checkbox.onchange = () => vscode.postMessage({
            type: 'set_config',
            config_id: option.id,
            value: { type: 'boolean', value: checkbox.checked }
          });
          wrapper.appendChild(checkbox);
        }
        config.appendChild(wrapper);
      }
    }

    function renderPermission(data) {
      const card = document.createElement('div');
      card.className = 'permission';
      const title = document.createElement('strong');
      title.textContent = (data.tool_call && data.tool_call.title) || 'Agent requests permission';
      const detail = document.createElement('div');
      detail.textContent = data.tool_call && data.tool_call.kind ? data.tool_call.kind : '';
      const actions = document.createElement('div');
      actions.className = 'permission-actions';
      for (const option of data.options || []) {
        const button = document.createElement('button');
        button.textContent = option.name || option.optionId;
        if (String(option.kind || '').startsWith('reject')) button.className = 'secondary';
        button.onclick = () => {
          vscode.postMessage({
            type: 'permission_response',
            request_id: data.request_id,
            option_id: option.optionId
          });
          card.remove();
        };
        actions.appendChild(button);
      }
      card.append(title, detail, actions);
      permissions.appendChild(card);
    }

    function renderAuth(methods) {
      auth.replaceChildren();
      const card = document.createElement('div');
      card.className = 'auth';
      const text = document.createElement('div');
      text.textContent = 'This agent needs authentication.';
      const actions = document.createElement('div');
      actions.className = 'auth-actions';
      for (const method of methods || []) {
        const button = document.createElement('button');
        button.textContent = method.name || 'Sign in';
        button.onclick = () => vscode.postMessage({
          type: 'authenticate',
          method_id: method.id
        });
        actions.appendChild(button);
      }
      const retry = document.createElement('button');
      retry.className = 'secondary';
      retry.textContent = 'Retry';
      retry.onclick = () => vscode.postMessage({ type: 'retry_session' });
      actions.appendChild(retry);
      card.append(text, actions);
      auth.appendChild(card);
    }

    function renderTool(update) {
      const id = update.toolCallId || update.tool_call_id || update.id || Math.random().toString();
      let detail = tools.get(id);
      if (!detail) {
        detail = document.createElement('details');
        detail.className = 'tool';
        const summary = document.createElement('summary');
        summary.textContent = update.title || 'Tool call';
        const body = document.createElement('pre');
        detail.append(summary, body);
        messages.appendChild(detail);
        tools.set(id, detail);
      }
      const summary = detail.querySelector('summary');
      const body = detail.querySelector('pre');
      if (summary) summary.textContent = (update.title || summary.textContent) + (update.status ? ' · ' + update.status : '');
      if (body) body.textContent = JSON.stringify(update, null, 2);
    }

    document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
    agentSelect.onchange = updateAgentDetail;
    installButton.onclick = () => {
      const agent = selectedAgent();
      if (agent) vscode.postMessage({ type: 'install', agent_id: agent.id });
    };
    connectButton.onclick = () => {
      const agent = selectedAgent();
      if (agent) vscode.postMessage({ type: 'connect', agent_id: agent.id });
    };
    document.getElementById('disconnect').onclick = () => vscode.postMessage({ type: 'disconnect' });
    document.getElementById('send').onclick = () => {
      const text = prompt.value.trim();
      if (!text) return;
      appendMessage('user', 'You', text);
      assistant = appendMessage('assistant', 'Agent', '');
      thought = undefined;
      vscode.postMessage({ type: 'prompt', text });
      prompt.value = '';
    };
    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        document.getElementById('send').click();
      }
    });
    document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });

    window.addEventListener('message', ({ data }) => {
      if (data.type === 'catalog_loading') status.textContent = 'Refreshing the ACP registry…';
      if (data.type === 'catalog') {
        agents = Array.isArray(data.agents) ? data.agents : [];
        const previous = data.selected_agent || agentSelect.value;
        agentSelect.replaceChildren();
        for (const agent of agents) {
          const option = document.createElement('option');
          option.value = agent.id;
          option.textContent = agent.name + (agent.version ? ' ' + agent.version : '') + (agent.ready ? '' : ' — install');
          agentSelect.appendChild(option);
        }
        if (agents.some((agent) => agent.id === previous)) agentSelect.value = previous;
        updateAgentDetail();
        status.textContent = data.cached ? 'Registry unavailable · showing cached agents' : 'Choose an ACP agent';
      }
      if (data.type === 'installing_agent') status.textContent = 'Installing agent…';
      if (data.type === 'agent_installed') status.textContent = 'Agent installed';
      if (data.type === 'connecting') status.textContent = 'Connecting…';
      if (data.type === 'connected') status.textContent = 'Connected to ' + (data.agent || 'ACP agent');
      if (data.type === 'auth_required') {
        status.textContent = data.message || 'Authentication required';
        renderAuth(data.auth_methods);
      }
      if (data.type === 'terminal_auth') status.textContent = 'Finish signing in in the terminal, then choose Retry';
      if (data.type === 'authenticated') {
        status.textContent = 'Authenticated · creating session…';
        auth.replaceChildren();
      }
      if (data.type === 'session_started') {
        status.textContent = 'Ready · session ' + data.session_id;
        auth.replaceChildren();
        renderConfig(data.config_options);
      }
      if (data.type === 'config_options') renderConfig(data.config_options);
      if (data.type === 'message_chunk') {
        if (!assistant) assistant = appendMessage('assistant', 'Agent', '');
        assistant.textContent += data.text;
      }
      if (data.type === 'thought_chunk') {
        if (!thought) {
          thought = document.createElement('div');
          thought.className = 'thought';
          messages.appendChild(thought);
        }
        thought.textContent += data.text;
      }
      if (data.type === 'session_update' && data.update) {
        if (data.update.sessionUpdate === 'tool_call' || data.update.sessionUpdate === 'tool_call_update') renderTool(data.update);
        if (data.update.sessionUpdate === 'config_option_update') renderConfig(data.update.configOptions);
      }
      if (data.type === 'permission_request') renderPermission(data);
      if (data.type === 'turn_completed') status.textContent = 'Ready · ' + data.stop_reason;
      if (data.type === 'error') {
        status.textContent = 'Error';
        appendMessage('error', 'Error', String(data.message || 'Unknown error'));
      }
      if (data.type === 'disconnected') {
        status.textContent = 'Disconnected';
        config.replaceChildren();
        auth.replaceChildren();
      }
      if (data.type === 'host_exited') status.textContent = 'Brokk ACP host exited';
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
