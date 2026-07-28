import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import { normalizePromptImages } from "./images";
import { SessionRecord, SessionStore } from "./sessionStore";
import { webviewHtml } from "./webview";
import {
  GitWorktreeService,
  type SessionWorktree,
  type WorktreeChoice,
  type WorktreeSelection,
  type WorktreeService,
} from "./worktrees";

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
  private currentCwd: string | undefined;
  private pendingReconnect:
    | { launch: LaunchSpec; session: HostSessionSelection; cwd: string }
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

  connect(launch: LaunchSpec, session: HostSessionSelection, cwd = workspacePath()): void {
    this.currentLaunch = launch;
    this.currentSession = session;
    this.currentCwd = cwd;
    this.send({
      type: "connect",
      command: launch.command,
      args: launch.args,
      env: launch.env,
      cwd,
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
      cwd: this.currentCwd ?? workspacePath(),
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
    const child = spawn(executable, [], {
      cwd: workspacePathOrUndefined() ?? this.context.extensionPath,
      stdio: "pipe",
    });
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
          setImmediate(() => this.connect(pending.launch, pending.session, pending.cwd));
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
      cwd: this.currentCwd ?? workspacePath(),
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
  cwd: string;
  worktree?: SessionWorktree;
}

interface WorktreeSessionHandoff {
  version: 1;
  agentId: string;
  cwd: string;
  worktree: SessionWorktree;
}

const WORKTREE_HANDOFF_KEY = "brokkAcp.worktreeSessionHandoff.v1";

export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subscription: vscode.Disposable;
  private readonly sessions: SessionStore;
  private readonly authMethods = new Map<string, EnvAuthMethod>();
  private connectionPhase: "idle" | "connecting" | "connected" = "idle";
  private activeConnectionId: number | undefined;
  private connectedAgentId: string | undefined;
  private connectedCwd: string | undefined;
  private connectedWorktree: SessionWorktree | undefined;
  private pendingConnection: PendingConnection | undefined;
  private readonly pendingWorktreeCleanup = new Map<string, SessionWorktree>();
  private worktreeChoices: WorktreeChoice[] = [];
  private worktreeError: string | undefined;
  private connectionDetail: string | undefined;
  private capabilities: Record<string, unknown> | undefined;
  private auth: { message?: string; methods: unknown[] } | undefined;
  private banner: string | undefined;
  private showStart = false;
  private restorePending = true;
  private relinkLocalId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: RustHost,
    private readonly catalog: AgentCatalog,
    private readonly worktrees: WorktreeService,
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

  async newSession(
    agentId?: string,
    worktreeSelection: WorktreeSelection = { kind: "workspace" },
  ): Promise<void> {
    const agent = this.catalog.get(agentId || this.catalog.defaultAgentId());
    if (!agent?.launch) {
      throw new Error("Choose an installed ACP agent.");
    }
    if (this.sessions.active?.status === "running") {
      throw new Error("Stop the active turn before starting another session.");
    }
    await this.catalog.select(agent.id);
    const selectedWorkspace = await this.worktrees.resolve(workspacePath(), worktreeSelection);
    if (
      selectedWorkspace.worktree &&
      !samePath(selectedWorkspace.cwd, workspacePath())
    ) {
      if (selectedWorkspace.created) {
        void this.refreshWorktrees().then(() => this.postState());
      }
      await this.handoffNewSession(agent, selectedWorkspace.cwd, selectedWorkspace.worktree);
      return;
    }
    this.startNewSession(agent, selectedWorkspace.cwd, selectedWorkspace.worktree);
  }

  async acceptPendingWorktreeHandoff(): Promise<boolean> {
    const handoff = this.context.globalState.get<WorktreeSessionHandoff>(
      WORKTREE_HANDOFF_KEY,
    );
    if (!isWorktreeSessionHandoff(handoff)) {
      return false;
    }
    let currentWorkspace: string;
    try {
      currentWorkspace = workspacePath();
    } catch {
      return false;
    }
    if (!samePath(handoff.cwd, currentWorkspace)) {
      return false;
    }
    const agent = this.catalog.get(handoff.agentId);
    if (!agent?.launch) {
      return false;
    }
    await this.context.globalState.update(WORKTREE_HANDOFF_KEY, undefined);
    try {
      await this.worktrees.validate(handoff.cwd, handoff.worktree);
    } catch (error) {
      this.showStart = true;
      this.banner =
        error instanceof Error
          ? `Could not start the worktree session: ${error.message}`
          : "Could not start the worktree session.";
      this.postState();
      return true;
    }
    await this.catalog.select(agent.id);
    this.restorePending = false;
    this.startNewSession(agent, handoff.cwd, handoff.worktree);
    await vscode.commands.executeCommand("brokkAcp.chat.focus");
    return true;
  }

  private startNewSession(
    agent: AgentChoice,
    cwd: string,
    worktree?: SessionWorktree,
  ): void {
    this.sessions.create(
      { id: agent.id, name: agent.name },
      cwd,
      worktree,
    );
    this.relinkLocalId = undefined;
    this.showStart = false;
    this.startConnection(agent, { mode: "new" }, cwd, worktree);
  }

  private async handoffNewSession(
    agent: AgentChoice,
    cwd: string,
    worktree: SessionWorktree,
  ): Promise<void> {
    const handoff: WorktreeSessionHandoff = {
      version: 1,
      agentId: agent.id,
      cwd,
      worktree,
    };
    await this.context.globalState.update(WORKTREE_HANDOFF_KEY, handoff);
    this.banner = `Opening ${worktree.name} and starting ${agent.name} there…`;
    this.postState();
    try {
      await this.openWorktreeInVsCode(cwd);
    } catch (error) {
      await this.context.globalState.update(WORKTREE_HANDOFF_KEY, undefined);
      this.startNewSession(agent, cwd, worktree);
      const detail = error instanceof Error ? error.message : String(error);
      this.banner =
        `The agent is running in ${worktree.name}, but VS Code could not open ` +
        `that checkout automatically: ${detail}`;
      this.postState();
    }
  }

  async showNewSession(agentId?: string): Promise<void> {
    if (this.sessions.active?.status === "running") {
      throw new Error("Stop the active turn before leaving this session.");
    }
    if (agentId) {
      await this.catalog.select(agentId);
    }
    this.showStart = true;
    this.relinkLocalId = undefined;
    this.banner = undefined;
    await this.refreshWorktrees();
    this.postState();
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
        void this.acceptPendingWorktreeHandoff().then((accepted) => {
          if (!accepted) {
            void this.restoreActiveSession();
          }
        });
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
            this.connectedCwd ?? workspacePath(),
            event.sessions,
            this.connectedWorktree,
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
        this.relinkLocalId = undefined;
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
          const cleanup = this.pendingWorktreeCleanup.get(event.session_id);
          this.pendingWorktreeCleanup.delete(event.session_id);
          if (cleanup) {
            void this.finishWorktreeCleanup(cleanup);
          }
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
          setImmediate(() =>
            this.launchConnection(
              pending.agent,
              pending.selection,
              pending.cwd,
              pending.worktree,
            ),
          );
        }
        break;
      case "host_exited":
        this.connectionPhase = "idle";
        this.activeConnectionId = undefined;
        this.connectedAgentId = undefined;
        this.connectedCwd = undefined;
        this.connectedWorktree = undefined;
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
          await this.refreshWorktrees();
          this.postState();
          if (!(await this.acceptPendingWorktreeHandoff())) {
            void this.restoreActiveSession();
          }
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
          await this.showNewSession();
          break;
        case "refresh_worktrees":
          await this.refreshWorktrees();
          this.postState();
          break;
        case "open_workspace": {
          const selected = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Open folder",
            title: "Open a folder for Brokk ACP",
          });
          if (selected?.[0]) {
            await vscode.commands.executeCommand("vscode.openFolder", selected[0]);
          }
          break;
        }
        case "new_session":
          if (typeof message.agent_id === "string") {
            await this.newSession(
              message.agent_id,
              parseWorktreeSelection(message.working_directory),
            );
          }
          break;
        case "relink_session":
          if (typeof message.local_id === "string") {
            await this.relinkSession(
              message.local_id,
              parseWorktreeSelection(message.working_directory),
            );
          }
          break;
        case "browse_sessions":
          if (typeof message.agent_id === "string") {
            const agent = this.requireLaunchableAgent(message.agent_id);
            await this.catalog.select(agent.id);
            const selection = parseWorktreeSelection(message.working_directory);
            if (selection.kind === "create") {
              throw new Error("Create the worktree by starting a new session first.");
            }
            const selectedWorkspace = await this.worktrees.resolve(workspacePath(), selection);
            this.showStart = true;
            this.startConnection(
              agent,
              { mode: "browse" },
              selectedWorkspace.cwd,
              selectedWorkspace.worktree,
            );
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
            this.startConnection(agent, { mode: "browse" }, workspacePath());
          }
          break;
        case "delete_session":
          if (typeof message.local_id === "string") {
            await this.deleteSession(message.local_id);
          }
          break;
        case "open_worktree": {
          const session =
            typeof message.local_id === "string"
              ? this.sessions.get(message.local_id)
              : this.sessions.active;
          if (session?.worktree) {
            await this.worktrees.validate(session.cwd, session.worktree);
            await this.openWorktreeInVsCode(session.cwd);
          }
          break;
        }
        case "prompt":
          {
            const text = typeof message.text === "string" ? message.text.trim() : "";
            const images = normalizePromptImages(message.images);
            if (!text && images.length === 0) {
              break;
            }
            if (images.length > 0 && !this.imagePromptsSupported()) {
              throw new Error("This ACP agent does not support image prompts.");
            }
            this.sessions.beginTurn(
              text,
              images.map((image) => ({
                type: "image",
                name: image.name,
                mimeType: image.mimeType,
              })),
            );
            this.postState();
            this.host.send({
              type: "prompt",
              text,
              ...(images.length ? { images } : {}),
            });
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

  private startConnection(
    agent: AgentChoice,
    selection: HostSessionSelection,
    cwd: string,
    worktree?: SessionWorktree,
  ): void {
    if (!agent.launch) {
      throw new Error("Install this ACP agent before connecting.");
    }
    const sameAgent = this.connectedAgentId === agent.id;
    const sameWorkspace = this.connectedCwd !== undefined && samePath(this.connectedCwd, cwd);
    if (this.connectionPhase === "connected" && sameAgent && sameWorkspace) {
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
      this.pendingConnection = { agent, selection, cwd, worktree };
      this.connectionDetail = sameAgent
        ? "Switching working directories…"
        : `Switching to ${agent.name}…`;
      this.host.disconnectSession();
      this.postState();
      return;
    }
    this.launchConnection(agent, selection, cwd, worktree);
  }

  private async restoreActiveSession(): Promise<void> {
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
    try {
      await this.worktrees.validate(session.cwd, session.worktree);
    } catch (error) {
      this.beginRelink(session, error);
      return;
    }
    this.sessions.activate(session.localId, true);
    this.startConnection(
      agent,
      {
        mode: "open",
        session_id: session.remoteId,
        replay: true,
      },
      session.cwd,
      session.worktree,
    );
  }

  private launchConnection(
    agent: AgentChoice,
    selection: HostSessionSelection,
    cwd: string,
    worktree?: SessionWorktree,
  ): void {
    if (!agent.launch) {
      throw new Error("Install this ACP agent before connecting.");
    }
    this.connectionPhase = "connecting";
    this.connectedAgentId = agent.id;
    this.connectedCwd = cwd;
    this.connectedWorktree = worktree;
    this.connectionDetail = `Starting ${agent.name}…`;
    this.capabilities = undefined;
    this.banner = undefined;
    this.host.connect(agent.launch, selection, cwd);
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
    try {
      await this.worktrees.validate(session.cwd, session.worktree);
    } catch (error) {
      this.beginRelink(session, error);
      return;
    }
    this.relinkLocalId = undefined;
    this.sessions.activate(localId, true);
    this.startConnection(
      agent,
      {
        mode: "open",
        session_id: session.remoteId,
        replay: true,
      },
      session.cwd,
      session.worktree,
    );
    if (session.worktree) {
      this.openWorktreeAutomatically(session.cwd, session.worktree);
    }
  }

  private async relinkSession(
    localId: string,
    selection: WorktreeSelection,
  ): Promise<void> {
    const session = this.sessions.get(localId);
    if (!session?.remoteId) {
      throw new Error("This saved ACP session can no longer be resumed.");
    }
    const selectedWorkspace = await this.worktrees.resolve(workspacePath(), selection);
    this.sessions.setWorkspace(
      localId,
      selectedWorkspace.cwd,
      selectedWorkspace.worktree,
    );
    const agent = this.requireLaunchableAgent(session.agentId);
    this.sessions.activate(localId, true);
    this.relinkLocalId = undefined;
    this.showStart = false;
    this.startConnection(
      agent,
      {
        mode: "open",
        session_id: session.remoteId,
        replay: true,
      },
      selectedWorkspace.cwd,
      selectedWorkspace.worktree,
    );
    if (selectedWorkspace.worktree) {
      this.openWorktreeAutomatically(selectedWorkspace.cwd, selectedWorkspace.worktree);
    }
    if (selectedWorkspace.created) {
      void this.refreshWorktrees().then(() => this.postState());
    }
  }

  private beginRelink(session: SessionRecord, error: unknown): void {
    this.showStart = true;
    this.relinkLocalId = session.localId;
    this.banner =
      error instanceof Error
        ? `${error.message} Choose a working directory below to relink this session.`
        : "The recorded session working directory is unavailable. Choose a replacement below.";
    this.postState();
  }

  private async openWorktreeInVsCode(cwd: string): Promise<void> {
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(cwd),
      { forceNewWindow: true },
    );
  }

  private openWorktreeAutomatically(cwd: string, worktree: SessionWorktree): void {
    void this.openWorktreeInVsCode(cwd).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.banner =
        `The agent is running in ${worktree.name}, but VS Code could not open ` +
        `that checkout automatically: ${detail}`;
      this.postState();
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
    let answer: string | undefined;
    if (session.worktree?.managed) {
      const shared = this.sessions.hasOtherSessionInWorktree(
        session.localId,
        session.worktree.worktreeRoot,
      );
      if (shared) {
        answer = await vscode.window.showWarningMessage(
          `Delete “${session.title}”? Its worktree is used by another saved session and will be kept.`,
          { modal: true },
          "Delete session",
        );
      } else {
        const dirty = await this.worktrees.isDirty(session.worktree);
        if (dirty) {
          answer = await vscode.window.showWarningMessage(
            `Delete “${session.title}”? Its worktree has uncommitted changes and will be kept at ${session.worktree.worktreeRoot}.`,
            { modal: true },
            "Delete session",
          );
        } else {
          answer = await vscode.window.showWarningMessage(
            `Delete “${session.title}”? You can also remove its clean Brokk worktree.`,
            { modal: true },
            "Delete + remove worktree",
            "Delete session",
          );
        }
      }
    } else {
      answer = await vscode.window.showWarningMessage(
        `Delete “${session.title}” from ${session.agentName}?`,
        { modal: true },
        "Delete session",
      );
    }
    if (answer === "Delete + remove worktree" && session.worktree) {
      this.pendingWorktreeCleanup.set(session.remoteId, session.worktree);
    }
    if (answer === "Delete session" || answer === "Delete + remove worktree") {
      this.host.send({ type: "delete_session", session_id: session.remoteId });
    }
  }

  private async finishWorktreeCleanup(worktree: SessionWorktree): Promise<void> {
    try {
      await this.worktrees.remove(worktree);
      this.banner = `Removed clean worktree ${worktree.name}.`;
      await this.refreshWorktrees();
    } catch (error) {
      this.banner =
        error instanceof Error
          ? error.message
          : `Could not remove worktree ${worktree.name}.`;
    }
    this.postState();
  }

  private async refreshWorktrees(): Promise<void> {
    const workspace = workspacePathOrUndefined();
    if (!workspace) {
      this.worktreeChoices = [];
      this.worktreeError = undefined;
      return;
    }
    try {
      this.worktreeChoices = await this.worktrees.list(workspace);
      this.worktreeError = undefined;
    } catch (error) {
      this.worktreeChoices = [];
      this.worktreeError =
        error instanceof Error ? error.message : "Git worktrees are unavailable.";
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

  private imagePromptsSupported(): boolean {
    const promptCapabilities = isRecord(this.capabilities?.promptCapabilities)
      ? this.capabilities.promptCapabilities
      : undefined;
    return promptCapabilities?.image === true;
  }

  private postState(): void {
    const sessionState = this.sessions.snapshot();
    const workspace = workspacePathOrUndefined();
    const relinkSession = this.relinkLocalId
      ? this.sessions.get(this.relinkLocalId)
      : undefined;
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
          canPromptImages: this.imagePromptsSupported(),
        },
        auth: this.auth,
        banner: this.banner,
        workspace: workspace
          ? {
              path: workspace,
              name: path.basename(workspace),
            }
          : undefined,
        worktrees: this.worktreeChoices,
        worktreeError: this.worktreeError,
        relinkSession: relinkSession
          ? {
              localId: relinkSession.localId,
              title: relinkSession.title,
              agentId: relinkSession.agentId,
            }
          : undefined,
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
  const chat = new ChatView(context, host, catalog, new GitWorktreeService());
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
        await chat.showNewSession(picked.agent.id);
        await vscode.commands.executeCommand("brokkAcp.chat.focus");
      }
    }),
    vscode.commands.registerCommand("brokkAcp.disconnect", () => host.disconnectSession()),
    vscode.commands.registerCommand("brokkAcp.refreshAgents", () => host.listAgents()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void chat.acceptPendingWorktreeHandoff();
      }
    }),
  );
  void chat.acceptPendingWorktreeHandoff();
}

export function workspacePath(): string {
  const workspace = workspacePathOrUndefined();
  if (!workspace) {
    throw new Error("Open a workspace before using an ACP agent.");
  }
  return workspace;
}

export function workspacePathOrUndefined(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

export function isWorktreeSessionHandoff(value: unknown): value is WorktreeSessionHandoff {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.agentId === "string" &&
    typeof value.cwd === "string" &&
    isRecord(value.worktree) &&
    typeof value.worktree.projectRoot === "string" &&
    typeof value.worktree.worktreeRoot === "string" &&
    typeof value.worktree.name === "string" &&
    typeof value.worktree.managed === "boolean"
  );
}

export function parseWorktreeSelection(value: unknown): WorktreeSelection {
  if (!isRecord(value) || value.kind === "workspace") {
    return { kind: "workspace" };
  }
  if (value.kind === "create") {
    return { kind: "create" };
  }
  if (value.kind === "existing" && typeof value.path === "string" && value.path.trim()) {
    return { kind: "existing", path: value.path };
  }
  throw new Error("Choose a valid working directory.");
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}
