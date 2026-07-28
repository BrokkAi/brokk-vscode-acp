import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import { SessionRecord, SessionStore } from "./sessionStore";
import { webviewHtml } from "./webview";

type HostEvent = { type: string; [key: string]: unknown };

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface HostSessionSelection {
  mode: "browse" | "new" | "open";
  session_id?: string;
  replay?: boolean;
}

interface CustomAgentConfig {
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentChoice {
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

export interface EnvAuthMethod {
  type: "env_var";
  id: string;
  name: string;
  vars: EnvAuthVariable[];
}

export class AgentCatalog {
  private official = new Map<string, AgentChoice>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  updateOfficial(entries: unknown): void {
    if (!Array.isArray(entries)) {
      return;
    }
    this.official.clear();
    for (const value of entries) {
      if (!isRecord(value)) {
        continue;
      }
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

export class RustHost implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private currentLaunch: LaunchSpec | undefined;
  private currentSession: HostSessionSelection = { mode: "browse" };
  private pendingReconnect:
    | { launch: LaunchSpec; session: HostSessionSelection }
    | undefined;
  private readonly events = new vscode.EventEmitter<HostEvent>();
  private readonly output = vscode.window.createOutputChannel("Brokk ACP");
  readonly onEvent = this.events.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async listAgents(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    this.send({
      type: "list_agents",
      storage_dir: this.context.globalStorageUri.fsPath,
      registry_url: registryUrl(),
    });
  }

  async installAgent(agentId: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    this.send({
      type: "install_agent",
      agent_id: agentId,
      storage_dir: this.context.globalStorageUri.fsPath,
      registry_url: registryUrl(),
    });
  }

  connect(launch: LaunchSpec, session: HostSessionSelection): void {
    this.currentLaunch = launch;
    this.currentSession = session;
    this.send({
      type: "connect",
      command: launch.command,
      args: launch.args,
      env: launch.env,
      cwd: workspacePath(),
      session,
    });
  }

  send(command: object): void {
    this.ensureStarted().stdin.write(`${JSON.stringify(command)}\n`);
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
      launch: {
        ...this.currentLaunch,
        env: { ...this.currentLaunch.env, ...env },
      },
      session: this.currentSession,
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
          const pending = this.pendingReconnect;
          this.pendingReconnect = undefined;
          setImmediate(() => this.connect(pending.launch, pending.session));
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

interface PendingConnection {
  agent: AgentChoice;
  selection: HostSessionSelection;
}

export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subscription: vscode.Disposable;
  private readonly sessions: SessionStore;
  private readonly authMethods = new Map<string, EnvAuthMethod>();
  private connectionPhase: "idle" | "connecting" | "connected" = "idle";
  private activeConnectionId: number | undefined;
  private connectedAgentId: string | undefined;
  private pendingConnection: PendingConnection | undefined;
  private connectionDetail: string | undefined;
  private capabilities: Record<string, unknown> | undefined;
  private auth: { message?: string; methods: unknown[] } | undefined;
  private banner: string | undefined;
  private showStart = false;
  private restorePending = true;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: RustHost,
    private readonly catalog: AgentCatalog,
  ) {
    this.sessions = new SessionStore(context);
    this.subscription = host.onEvent((event) => this.handleHostEvent(event));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewHtml(view.webview);
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message));
  }

  dispose(): void {
    this.subscription.dispose();
  }

  async newSession(agentId?: string): Promise<void> {
    const agent = this.catalog.get(agentId || this.catalog.defaultAgentId());
    if (!agent?.launch) {
      throw new Error("Choose an installed ACP agent.");
    }
    if (this.sessions.active?.status === "running") {
      throw new Error("Stop the active turn before starting another session.");
    }
    await this.catalog.select(agent.id);
    this.sessions.create({ id: agent.id, name: agent.name }, workspacePath());
    this.showStart = false;
    this.startConnection(agent, { mode: "new" });
  }

  private handleHostEvent(event: HostEvent): void {
    const eventConnectionId =
      typeof event.connection_id === "number" ? event.connection_id : undefined;
    if (
      eventConnectionId !== undefined &&
      this.activeConnectionId !== undefined &&
      eventConnectionId !== this.activeConnectionId &&
      (event.type === "connection_progress" ||
        event.type === "connected" ||
        event.type === "error" ||
        event.type === "disconnected")
    ) {
      return;
    }

    switch (event.type) {
      case "catalog":
        this.catalog.updateOfficial(event.agents);
        this.restoreActiveSession();
        break;
      case "catalog_loading":
        break;
      case "installing_agent":
        this.banner = "Installing ACP agent…";
        break;
      case "agent_installed":
        this.banner = undefined;
        break;
      case "connecting":
        this.activeConnectionId = eventConnectionId;
        this.connectionPhase = "connecting";
        this.connectionDetail = "Starting the ACP agent process…";
        this.sessions.setConnecting();
        this.banner = undefined;
        break;
      case "connection_progress":
        if (typeof event.message === "string") {
          this.connectionDetail = event.message;
        }
        break;
      case "connected":
        this.connectionPhase = "connected";
        this.connectionDetail = "ACP handshake complete. Opening the session…";
        this.capabilities = isRecord(event.agent_capabilities)
          ? event.agent_capabilities
          : undefined;
        this.sessions.setConnected(
          typeof event.agent === "string" ? event.agent : undefined,
          event.agent_capabilities,
        );
        break;
      case "agent_sessions": {
        this.connectionDetail = undefined;
        const agent = this.connectedAgentId ? this.catalog.get(this.connectedAgentId) : undefined;
        if (agent) {
          this.sessions.mergeRemoteSessions(
            { id: agent.id, name: agent.name },
            workspacePath(),
            event.sessions,
          );
        }
        break;
      }
      case "session_list_error":
        this.banner =
          typeof event.message === "string"
            ? `Session discovery failed: ${event.message}`
            : "Session discovery failed for this agent.";
        break;
      case "session_replay_started":
        this.connectionDetail = "Loading the saved transcript…";
        if (typeof event.session_id === "string") {
          this.sessions.startReplay(event.session_id);
        }
        break;
      case "session_started":
        this.connectionDetail = undefined;
        if (typeof event.session_id === "string") {
          this.sessions.setSessionStarted(
            event.session_id,
            typeof event.method === "string" ? event.method : "new",
            event.config_options,
            event.modes,
          );
        }
        this.auth = undefined;
        this.banner = undefined;
        this.showStart = false;
        break;
      case "turn_started":
        this.sessions.turnStarted();
        break;
      case "turn_completed":
        this.sessions.turnCompleted(
          typeof event.stop_reason === "string" ? event.stop_reason : undefined,
          event.usage,
        );
        break;
      case "session_update":
        this.sessions.applySessionUpdate(event.update);
        break;
      case "config_options":
        this.sessions.setConfigOptions(event.config_options);
        break;
      case "permission_request":
        if (typeof event.request_id === "string") {
          this.sessions.addPermission(event.request_id, event.tool_call, event.options);
        }
        break;
      case "auth_required":
        this.authMethods.clear();
        if (Array.isArray(event.auth_methods)) {
          for (const method of event.auth_methods) {
            if (isEnvAuthMethod(method)) {
              this.authMethods.set(method.id, method);
            }
          }
        }
        this.auth = {
          message: typeof event.message === "string" ? event.message : undefined,
          methods: Array.isArray(event.auth_methods) ? event.auth_methods : [],
        };
        break;
      case "terminal_auth":
        this.banner = "Finish signing in in the terminal, then choose Retry.";
        break;
      case "authenticated":
        this.auth = undefined;
        this.banner = "Signed in. Opening session…";
        break;
      case "session_deleted":
        if (this.connectedAgentId && typeof event.session_id === "string") {
          this.sessions.removeByRemoteId(this.connectedAgentId, event.session_id);
        }
        break;
      case "error": {
        const message = typeof event.message === "string" ? event.message : "Unknown ACP error";
        this.connectionDetail = undefined;
        if (this.sessions.active && !this.showStart) {
          this.sessions.addError(message);
        } else {
          this.banner = message;
        }
        break;
      }
      case "disconnected":
        this.connectionPhase = "idle";
        this.activeConnectionId = undefined;
        this.connectionDetail = undefined;
        this.sessions.disconnected();
        this.capabilities = undefined;
        this.auth = undefined;
        if (this.pendingConnection) {
          const pending = this.pendingConnection;
          this.pendingConnection = undefined;
          setImmediate(() => this.launchConnection(pending.agent, pending.selection));
        }
        break;
      case "host_exited":
        this.connectionPhase = "idle";
        this.activeConnectionId = undefined;
        this.connectedAgentId = undefined;
        this.connectionDetail = undefined;
        this.sessions.disconnected();
        this.banner = "The Brokk ACP host exited.";
        break;
    }
    this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }
    try {
      switch (message.type) {
        case "ready":
          this.postState();
          await this.host.listAgents();
          this.restoreActiveSession();
          break;
        case "select_agent":
          if (typeof message.agent_id === "string") {
            await this.catalog.select(message.agent_id);
            this.postState();
          }
          break;
        case "install":
          await this.installAgent(message.agent_id);
          break;
        case "show_start":
          if (this.sessions.active?.status === "running") {
            throw new Error("Stop the active turn before leaving this session.");
          }
          this.showStart = true;
          this.banner = undefined;
          this.postState();
          break;
        case "new_session":
          if (typeof message.agent_id === "string") {
            await this.newSession(message.agent_id);
          }
          break;
        case "browse_sessions":
          if (typeof message.agent_id === "string") {
            const agent = this.requireLaunchableAgent(message.agent_id);
            await this.catalog.select(agent.id);
            this.showStart = true;
            this.startConnection(agent, { mode: "browse" });
          }
          break;
        case "open_session":
          if (typeof message.local_id === "string") {
            await this.openSession(message.local_id);
          }
          break;
        case "refresh_sessions":
          if (this.connectionPhase === "connected") {
            this.host.send({ type: "refresh_sessions" });
          } else {
            const agent = this.requireLaunchableAgent(this.catalog.defaultAgentId());
            this.startConnection(agent, { mode: "browse" });
          }
          break;
        case "delete_session":
          if (typeof message.local_id === "string") {
            await this.deleteSession(message.local_id);
          }
          break;
        case "prompt":
          if (typeof message.text === "string" && message.text.trim()) {
            const text = message.text.trim();
            this.sessions.beginTurn(text);
            this.postState();
            this.host.send({ type: "prompt", text });
          }
          break;
        case "cancel":
          this.host.send({ type: "cancel" });
          break;
        case "permission_response":
          if (typeof message.request_id === "string") {
            const optionId = typeof message.option_id === "string" ? message.option_id : null;
            this.sessions.resolvePermission(message.request_id, optionId);
            this.postState();
            this.host.send({
              type: "permission_response",
              request_id: message.request_id,
              option_id: optionId,
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
      this.banner = text;
      this.postState();
      void vscode.window.showErrorMessage(text);
    }
  }

  private startConnection(agent: AgentChoice, selection: HostSessionSelection): void {
    if (!agent.launch) {
      throw new Error("Install this ACP agent before connecting.");
    }
    const sameAgent = this.connectedAgentId === agent.id;
    if (this.connectionPhase === "connected" && sameAgent) {
      this.connectionDetail =
        selection.mode === "new"
          ? "Creating a new session…"
          : selection.mode === "open"
            ? "Opening the selected session…"
            : "Loading available sessions…";
      if (selection.mode === "new") {
        this.host.send({ type: "new_session" });
      } else if (selection.mode === "open" && selection.session_id) {
        this.host.send({
          type: "open_session",
          session_id: selection.session_id,
          replay: selection.replay !== false,
        });
      } else {
        this.host.send({ type: "refresh_sessions" });
      }
      this.postState();
      return;
    }
    if (this.connectionPhase !== "idle") {
      this.pendingConnection = { agent, selection };
      this.connectionDetail = `Switching to ${agent.name}…`;
      this.host.disconnectSession();
      this.postState();
      return;
    }
    this.launchConnection(agent, selection);
  }

  private restoreActiveSession(): void {
    if (!this.restorePending || this.connectionPhase !== "idle") {
      return;
    }
    const session = this.sessions.active;
    if (!session?.remoteId) {
      this.restorePending = false;
      return;
    }
    const agent = this.catalog.get(session.agentId);
    if (!agent?.launch) {
      return;
    }
    this.restorePending = false;
    this.sessions.activate(session.localId, true);
    this.startConnection(agent, {
      mode: "open",
      session_id: session.remoteId,
      replay: true,
    });
  }

  private launchConnection(agent: AgentChoice, selection: HostSessionSelection): void {
    if (!agent.launch) {
      throw new Error("Install this ACP agent before connecting.");
    }
    this.connectionPhase = "connecting";
    this.connectedAgentId = agent.id;
    this.connectionDetail = `Starting ${agent.name}…`;
    this.capabilities = undefined;
    this.banner = undefined;
    this.host.connect(agent.launch, selection);
    this.postState();
  }

  private async openSession(localId: string): Promise<void> {
    const session = this.sessions.get(localId);
    if (!session) {
      throw new Error("This session is no longer available.");
    }
    this.showStart = false;
    if (!session.remoteId) {
      this.sessions.activate(localId);
      this.banner = "This locally cached session has no ACP session ID and cannot be resumed.";
      this.postState();
      return;
    }
    const agent = this.requireLaunchableAgent(session.agentId);
    this.sessions.activate(localId, true);
    this.startConnection(agent, {
      mode: "open",
      session_id: session.remoteId,
      replay: true,
    });
  }

  private async deleteSession(localId: string): Promise<void> {
    const session = this.sessions.get(localId);
    if (!session?.remoteId) {
      return;
    }
    if (
      this.connectionPhase !== "connected" ||
      this.connectedAgentId !== session.agentId
    ) {
      throw new Error("Connect to this session's agent before deleting it.");
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete “${session.title}” from ${session.agentName}?`,
      { modal: true },
      "Delete",
    );
    if (answer === "Delete") {
      this.host.send({ type: "delete_session", session_id: session.remoteId });
    }
  }

  private async installAgent(agentId: unknown): Promise<void> {
    if (typeof agentId !== "string") {
      return;
    }
    const agent = this.catalog.get(agentId);
    if (agent?.source === "registry" && agent.registryId) {
      await this.host.installAgent(agent.registryId);
    }
  }

  private requireLaunchableAgent(agentId: string): AgentChoice {
    const agent = this.catalog.get(agentId);
    if (!agent?.launch) {
      throw new Error("Install this ACP agent before connecting.");
    }
    return agent;
  }

  private postState(): void {
    const sessionState = this.sessions.snapshot();
    const sessionCapabilities = isRecord(this.capabilities?.sessionCapabilities)
      ? this.capabilities.sessionCapabilities
      : undefined;
    this.view?.webview.postMessage({
      type: "app_state",
      state: {
        agents: this.catalog.publicList(),
        selectedAgent: this.catalog.defaultAgentId(),
        active: this.showStart ? undefined : sessionState.active,
        sessions: sessionState.sessions,
        connection: {
          phase: this.connectionPhase,
          agentId: this.connectedAgentId,
          detail: this.connectionDetail,
          canList: sessionCapabilities?.list !== undefined,
          canDelete: sessionCapabilities?.delete !== undefined,
        },
        auth: this.auth,
        banner: this.banner,
      },
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
        { placeHolder: "Choose an ACP agent for a new session" },
      );
      if (picked) {
        await chat.newSession(picked.agent.id);
      }
    }),
    vscode.commands.registerCommand("brokkAcp.disconnect", () => host.disconnectSession()),
    vscode.commands.registerCommand("brokkAcp.refreshAgents", () => host.listAgents()),
  );
}

export function workspacePath(): string {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) {
    throw new Error("Open a workspace before using an ACP agent.");
  }
  return workspace;
}

export function registryUrl(): string {
  return vscode.workspace
    .getConfiguration("brokkAcp")
    .get<string>(
      "registry.url",
      "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    );
}

export function resolveAnvilExecutable(context: vscode.ExtensionContext): string {
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

export function isLaunchSpec(value: unknown): value is LaunchSpec {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    isStringArray(value.args) &&
    isStringRecord(value.env)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isEnvAuthMethod(value: unknown): value is EnvAuthMethod {
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
