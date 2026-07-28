import { EventEmitter as NodeEventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const config = new Map<string, unknown>();
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  return {
    config,
    registeredCommands,
    createDirectory: vi.fn(async () => undefined),
    createOutputChannel: vi.fn(),
    createTerminal: vi.fn(),
    showErrorMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showInputBox: vi.fn(async () => undefined),
    showQuickPick: vi.fn(async () => undefined),
    executeCommand: vi.fn(async () => undefined),
    registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
    spawn: vi.fn(),
    createInterface: vi.fn(),
  };
});

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T) {
      for (const listener of this.listeners) listener(value);
    }
    dispose() {
      this.listeners.clear();
    }
  }

  mocks.createOutputChannel.mockImplementation(() => ({
    append: vi.fn(),
    dispose: vi.fn(),
  }));
  mocks.createTerminal.mockImplementation(() => ({
    show: vi.fn(),
    dispose: vi.fn(),
  }));

  return {
    EventEmitter,
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
      fs: { createDirectory: mocks.createDirectory },
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, fallback: unknown) =>
          mocks.config.has(key) ? mocks.config.get(key) : fallback,
        ),
      })),
    },
    window: {
      createOutputChannel: mocks.createOutputChannel,
      createTerminal: mocks.createTerminal,
      showErrorMessage: mocks.showErrorMessage,
      showWarningMessage: mocks.showWarningMessage,
      showInputBox: mocks.showInputBox,
      showQuickPick: mocks.showQuickPick,
      registerWebviewViewProvider: mocks.registerWebviewViewProvider,
    },
    commands: {
      executeCommand: mocks.executeCommand,
      registerCommand: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
        mocks.registeredCommands.set(name, handler);
        return { dispose: vi.fn() };
      }),
    },
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: mocks.spawn };
});

vi.mock("node:readline", async () => {
  const actual = await vi.importActual<typeof import("node:readline")>("node:readline");
  return { ...actual, createInterface: mocks.createInterface };
});

import * as vscode from "vscode";
import {
  activate,
  AgentCatalog,
  ChatView,
  isEnvAuthMethod,
  isLaunchSpec,
  isRecord,
  isStringArray,
  isStringRecord,
  parseWorktreeSelection,
  registryUrl,
  resolveAnvilExecutable,
  RustHost,
  workspacePath,
  type AgentChoice,
  type HostSessionSelection,
  type LaunchSpec,
} from "../src/extension";
import type {
  ResolvedWorkspace,
  SessionWorktree,
  WorktreeChoice,
  WorktreeSelection,
} from "../src/worktrees";

function extensionContext(saved?: unknown) {
  const workspaceValues = new Map<string, unknown>();
  if (saved !== undefined) workspaceValues.set("brokkAcp.sessions.v1", saved);
  return {
    extensionPath: "/extension",
    extensionMode: vscode.ExtensionMode.Production,
    globalStorageUri: { fsPath: "/storage" },
    subscriptions: [] as Array<{ dispose(): unknown }>,
    workspaceState: {
      get: vi.fn((key: string) => workspaceValues.get(key)),
      update: vi.fn(async (key: string, value: unknown) => {
        workspaceValues.set(key, value);
      }),
    },
    secrets: {
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
    },
  } as unknown as vscode.ExtensionContext;
}

function launch(command = "agent"): LaunchSpec {
  return { command, args: ["--stdio"], env: { BASE: "1" } };
}

function agent(overrides: Partial<AgentChoice> = {}): AgentChoice {
  return {
    id: "custom:agent",
    source: "custom",
    name: "Agent",
    description: "Test agent",
    ready: true,
    installable: false,
    launch: launch(),
    ...overrides,
  };
}

class FakeHost {
  readonly sent: object[] = [];
  readonly connected: Array<{ launch: LaunchSpec; session: HostSessionSelection; cwd: string }> = [];
  readonly installed: string[] = [];
  listCalls = 0;
  disconnectCalls = 0;
  reconnects: Array<Record<string, string>> = [];
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  readonly onEvent = (listener: (event: Record<string, unknown>) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(event: Record<string, unknown>) {
    for (const listener of this.listeners) listener(event);
  }
  async listAgents() {
    this.listCalls += 1;
  }
  async installAgent(id: string) {
    this.installed.push(id);
  }
  connect(spec: LaunchSpec, session: HostSessionSelection, cwd = "/workspace") {
    this.connected.push({ launch: spec, session, cwd });
  }
  send(command: object) {
    this.sent.push(command);
  }
  disconnectSession() {
    this.disconnectCalls += 1;
  }
  authenticationScope() {
    return "scope";
  }
  reconnectWithEnvironment(env: Record<string, string>) {
    this.reconnects.push(env);
  }
}

class FakeWorktrees {
  choices: WorktreeChoice[] = [];
  resolveResult: ResolvedWorkspace | undefined;
  dirty = false;
  validationError: Error | undefined;
  removalError: Error | undefined;
  readonly resolved: Array<{ cwd: string; selection: WorktreeSelection }> = [];
  readonly validated: Array<{ cwd: string; worktree?: SessionWorktree }> = [];
  readonly removed: SessionWorktree[] = [];

  async list(): Promise<WorktreeChoice[]> {
    return this.choices;
  }

  async resolve(cwd: string, selection: WorktreeSelection): Promise<ResolvedWorkspace> {
    this.resolved.push({ cwd, selection });
    if (this.resolveResult) {
      return this.resolveResult;
    }
    if (selection.kind === "existing") {
      return {
        cwd: selection.path,
        created: false,
        worktree: {
          projectRoot: "/workspace",
          worktreeRoot: selection.path,
          name: "existing",
          managed: false,
        },
      };
    }
    if (selection.kind === "create") {
      return {
        cwd: "/workspace/.brokk/worktrees/bright-fox",
        created: true,
        worktree: {
          projectRoot: "/workspace",
          worktreeRoot: "/workspace/.brokk/worktrees/bright-fox",
          name: "bright-fox",
          managed: true,
        },
      };
    }
    return { cwd, created: false };
  }

  async validate(cwd: string, worktree?: SessionWorktree): Promise<void> {
    this.validated.push({ cwd, worktree });
    if (this.validationError) throw this.validationError;
  }

  async isDirty(): Promise<boolean> {
    return this.dirty;
  }

  async remove(worktree: SessionWorktree): Promise<void> {
    this.removed.push(worktree);
    if (this.removalError) throw this.removalError;
  }
}

function fakeView() {
  let receive: ((message: unknown) => unknown) | undefined;
  const posted: unknown[] = [];
  const webview = {
    cspSource: "vscode-webview://test",
    options: {},
    html: "",
    onDidReceiveMessage: vi.fn((handler: (message: unknown) => unknown) => {
      receive = handler;
      return { dispose: vi.fn() };
    }),
    postMessage: vi.fn(async (message: unknown) => {
      posted.push(message);
      return true;
    }),
  };
  return {
    view: { webview } as unknown as vscode.WebviewView,
    webview,
    posted,
    receive: (message: unknown) => receive?.(message),
  };
}

function catalogWith(context: vscode.ExtensionContext, choices: AgentChoice[]) {
  const catalog = new AgentCatalog(context);
  vi.spyOn(catalog, "list").mockReturnValue(choices);
  vi.spyOn(catalog, "get").mockImplementation((id) => choices.find((choice) => choice.id === id));
  vi.spyOn(catalog, "publicList").mockReturnValue(
    choices.map(({ launch: _launch, registryId: _registryId, ...choice }) => choice),
  );
  vi.spyOn(catalog, "defaultAgentId").mockReturnValue(choices[0]?.id ?? "bundled:anvil");
  return catalog;
}

function fakeChild() {
  const child = new NodeEventEmitter() as NodeEventEmitter & {
    stdin: PassThrough & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  const stdin = new PassThrough() as typeof child.stdin;
  stdin.write = vi.fn((...args: unknown[]) => {
    const callback = args.find((value) => typeof value === "function") as (() => void) | undefined;
    callback?.();
    return true;
  });
  stdin.end = vi.fn();
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  mocks.config.clear();
  mocks.registeredCommands.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [
    { uri: { fsPath: "/workspace" } },
  ];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("extension validation helpers", () => {
  it("validates launch, records, arrays, and auth methods", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isStringArray(["a", "b"])).toBe(true);
    expect(isStringArray(["a", 1])).toBe(false);
    expect(isStringRecord({ A: "1" })).toBe(true);
    expect(isStringRecord({ A: 1 })).toBe(false);
    expect(isLaunchSpec(launch())).toBe(true);
    expect(isLaunchSpec({ command: "a", args: [], env: { A: 1 } })).toBe(false);
    expect(
      isEnvAuthMethod({
        type: "env_var",
        id: "token",
        name: "Token",
        vars: [{ name: "API_KEY", label: "Key", secret: true, optional: false }],
      }),
    ).toBe(true);
    expect(isEnvAuthMethod({ type: "terminal", id: "bad", name: "Bad", vars: [] })).toBe(false);
    expect(
      isEnvAuthMethod({
        type: "env_var",
        id: "bad",
        name: "Bad",
        vars: [{ name: 7 }],
      }),
    ).toBe(false);
  });

  it("resolves workspace and registry configuration", () => {
    mocks.config.set("registry.url", "https://registry.test/index.json");
    mocks.config.set("anvil.path", " /custom/anvil ");
    expect(workspacePath()).toBe("/workspace");
    expect(registryUrl()).toBe("https://registry.test/index.json");
    expect(resolveAnvilExecutable(extensionContext())).toBe("/custom/anvil");

    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
    expect(() => workspacePath()).toThrow("Open a workspace");
  });

  it("validates working-directory selections from the webview", () => {
    expect(parseWorktreeSelection(undefined)).toEqual({ kind: "workspace" });
    expect(parseWorktreeSelection({ kind: "workspace" })).toEqual({ kind: "workspace" });
    expect(parseWorktreeSelection({ kind: "create" })).toEqual({ kind: "create" });
    expect(parseWorktreeSelection({ kind: "existing", path: "/work/tree" })).toEqual({
      kind: "existing",
      path: "/work/tree",
    });
    expect(() => parseWorktreeSelection({ kind: "existing", path: "" })).toThrow(
      "valid working directory",
    );
    expect(() => parseWorktreeSelection({ kind: "other" })).toThrow(
      "valid working directory",
    );
  });
});

describe("AgentCatalog", () => {
  it("combines bundled, custom, legacy, and validated registry agents", async () => {
    const context = extensionContext();
    mocks.config.set("customAgents", {
      good: { name: " Custom ", command: "custom", args: ["--x"], env: { KEY: "value" } },
      simple: { command: "simple" },
      empty: { command: "" },
      badArgs: { command: "bad", args: [7] },
      badEnv: { command: "bad", env: { KEY: 7 } },
    });
    mocks.config.set("agent.command", "legacy");
    mocks.config.set("agent.args", ["--legacy"]);
    const catalog = new AgentCatalog(context);
    catalog.updateOfficial("invalid");
    catalog.updateOfficial([
      null,
      { id: "bad" },
      {
        id: "codex",
        name: "Codex",
        version: "1.0",
        description: "Official",
        license: "Apache-2.0",
        available: true,
      },
      {
        id: "ready",
        name: "Ready",
        version: "2.0",
        description: "Installed",
        launch: launch("ready"),
      },
    ]);

    expect(catalog.list().map((choice) => choice.id)).toEqual([
      "bundled:anvil",
      "custom:good",
      "custom:simple",
      "custom:legacy",
      "registry:codex",
      "registry:ready",
    ]);
    expect(catalog.get("registry:codex")).toMatchObject({
      installable: true,
      ready: false,
      license: "Apache-2.0",
    });
    expect(catalog.publicList()[0]).not.toHaveProperty("launch");
    await catalog.select("registry:ready");
    expect(context.workspaceState.update).toHaveBeenCalledWith(
      "brokkAcp.selectedAgent",
      "registry:ready",
    );
  });

  it("uses saved and configured default agents", () => {
    const context = extensionContext();
    mocks.config.set("defaultAgent", "custom:configured");
    const catalog = new AgentCatalog(context);
    expect(catalog.defaultAgentId()).toBe("custom:configured");
    vi.mocked(context.workspaceState.get).mockReturnValue("custom:saved");
    expect(catalog.defaultAgentId()).toBe("custom:saved");
  });
});

describe("RustHost", () => {
  it("starts once, writes commands, logs events, reconnects, and disposes", async () => {
    const context = extensionContext();
    const child = fakeChild();
    const lines = new NodeEventEmitter();
    mocks.spawn.mockReturnValue(child);
    mocks.createInterface.mockReturnValue(lines);
    const host = new RustHost(context);
    const events: Array<Record<string, unknown>> = [];
    host.onEvent((event) => events.push(event));

    await host.listAgents();
    await host.installAgent("codex");
    host.connect(launch(), { mode: "new" }, "/chosen/worktree");
    expect(mocks.createDirectory).toHaveBeenCalledWith(context.globalStorageUri);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.stdin.write).toHaveBeenCalledTimes(3);
    expect(child.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"cwd":"/chosen/worktree"'),
    );

    child.stderr.emit("data", Buffer.from("host log"));
    lines.emit("line", JSON.stringify({ type: "connected", agent: "Agent" }));
    lines.emit(
      "line",
      JSON.stringify({ type: "terminal_auth", command: "agent", args: [], env: {} }),
    );
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/chosen/worktree" }),
    );
    lines.emit("line", "not json");
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "log", text: "host log" },
        { type: "connected", agent: "Agent" },
        { type: "error", message: "Invalid host output: not json" },
      ]),
    );

    const firstScope = host.authenticationScope();
    expect(firstScope).toMatch(/^[a-f0-9]{64}$/);
    host.reconnectWithEnvironment({ TOKEN: "secret" });
    lines.emit("line", JSON.stringify({ type: "disconnected" }));
    await vi.runAllTimersAsync();
    expect(child.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"TOKEN":"secret"'),
    );

    child.emit("error", new Error("boom"));
    child.emit("exit", 1, null);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "error", message: "Rust host failed: boom" },
        { type: "host_exited", code: 1, signal: null },
      ]),
    );

    host.dispose();
  });

  it("opens terminal authentication and reports missing commands", () => {
    const context = extensionContext();
    const child = fakeChild();
    const lines = new NodeEventEmitter();
    mocks.spawn.mockReturnValue(child);
    mocks.createInterface.mockReturnValue(lines);
    const host = new RustHost(context);
    const events: Array<Record<string, unknown>> = [];
    host.onEvent((event) => events.push(event));
    host.send({ type: "ping" });

    lines.emit(
      "line",
      JSON.stringify({
        type: "terminal_auth",
        name: "Login",
        command: "agent",
        args: ["login", 7],
        env: { TOKEN: "x" },
      }),
    );
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Login",
        shellPath: "agent",
        shellArgs: ["login"],
        env: { TOKEN: "x" },
        cwd: "/workspace",
      }),
    );

    const disconnectedHost = new RustHost(context);
    expect(() => disconnectedHost.authenticationScope()).toThrow("No ACP agent");
    expect(() => disconnectedHost.reconnectWithEnvironment({ TOKEN: "x" })).toThrow(
      "No ACP agent",
    );
  });

  it("uses authentication fallbacks and shuts down a live host cleanly", async () => {
    const context = extensionContext();
    const child = fakeChild();
    const lines = new NodeEventEmitter();
    mocks.spawn.mockReturnValue(child);
    mocks.createInterface.mockReturnValue(lines);
    const host = new RustHost(context);
    const events: Array<Record<string, unknown>> = [];
    host.onEvent((event) => events.push(event));

    host.send({ type: "ping" });
    lines.emit("line", JSON.stringify({ type: "terminal_auth" }));
    expect(events).toContainEqual({
      type: "error",
      message: "Authentication command is missing.",
    });

    host.connect(launch("fallback-agent"), { mode: "browse" });
    lines.emit(
      "line",
      JSON.stringify({
        type: "terminal_auth",
        args: "invalid",
        env: { TOKEN: 7 },
      }),
    );
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ACP agent sign-in",
        shellPath: "fallback-agent",
        shellArgs: [],
        env: {},
      }),
    );

    host.disconnectSession();
    host.dispose();
    expect(child.stdin.end).toHaveBeenCalled();
    child.emit("exit", 0, null);
    await vi.runAllTimersAsync();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("ChatView", () => {
  it("handles connection and session event lifecycles", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const choice = agent();
    const catalog = catalogWith(context, [choice]);
    const chat = new ChatView(context, host as never, catalog, new FakeWorktrees());
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);
    expect(resolved.webview.options).toEqual({ enableScripts: true });
    expect(resolved.webview.html).toContain("Brokk ACP");

    await resolved.receive({ type: "ready" });
    expect(host.listCalls).toBe(1);
    await chat.newSession(choice.id);
    expect(host.connected.at(-1)?.session).toEqual({ mode: "new" });

    host.fire({ type: "connecting", connection_id: 1 });
    host.fire({ type: "connection_progress", connection_id: 1, message: "Handshake" });
    host.fire({
      type: "connected",
      connection_id: 1,
      agent: "Renamed",
      agent_capabilities: {
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {}, delete: {} },
      },
    });
    host.fire({
      type: "session_started",
      connection_id: 1,
      session_id: "remote",
      method: "new",
      config_options: [{ id: "model" }],
      modes: {},
    });
    host.fire({ type: "turn_started" });
    host.fire({
      type: "session_update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    });
    host.fire({ type: "config_options", config_options: [{ id: "mode" }] });
    host.fire({ type: "turn_completed", stop_reason: "end_turn", usage: { used: 1 } });

    const state = (resolved.posted.at(-1) as { state: Record<string, unknown> }).state;
    expect(state.connection).toMatchObject({
      phase: "connected",
      agentId: choice.id,
      canList: true,
      canDelete: true,
      canPromptImages: true,
    });
    expect(state.active).toMatchObject({
      remoteId: "remote",
      status: "ready",
      configOptions: [{ id: "mode" }],
    });

    host.fire({
      type: "connection_progress",
      connection_id: 999,
      message: "stale",
    });
    expect((chat as never as { connectionDetail: string }).connectionDetail).not.toBe("stale");
  });

  it("handles catalog, browsing, remote sessions, replay, deletion, and errors", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const choice = agent();
    const registry = agent({
      id: "registry:codex",
      registryId: "codex",
      source: "registry",
      installable: true,
      ready: false,
      launch: undefined,
    });
    const catalog = catalogWith(context, [choice, registry]);
    const updateOfficial = vi.spyOn(catalog, "updateOfficial");
    const chat = new ChatView(context, host as never, catalog, new FakeWorktrees());
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);

    host.fire({ type: "catalog_loading" });
    host.fire({ type: "catalog", agents: [{ id: "codex" }] });
    expect(updateOfficial).toHaveBeenCalled();
    host.fire({ type: "installing_agent" });
    host.fire({ type: "agent_installed" });
    await resolved.receive({ type: "install", agent_id: registry.id });
    expect(host.installed).toEqual(["codex"]);

    await resolved.receive({ type: "browse_sessions", agent_id: choice.id });
    expect(host.connected.at(-1)?.session).toEqual({ mode: "browse" });
    host.fire({ type: "connecting", connection_id: 2 });
    host.fire({
      type: "connected",
      connection_id: 2,
      agent_capabilities: { sessionCapabilities: { list: {} } },
    });
    host.fire({
      type: "agent_sessions",
      sessions: [{ sessionId: "saved", title: "Saved" }],
    });
    const saved = (chat as never as { sessions: { snapshot(): { sessions: Array<{ localId: string }> } } })
      .sessions.snapshot().sessions[0]!;
    await resolved.receive({ type: "open_session", local_id: saved.localId });
    expect(host.sent.at(-1)).toMatchObject({ type: "open_session", session_id: "saved" });

    host.fire({ type: "session_replay_started", session_id: "saved" });
    host.fire({ type: "session_list_error", message: "No list" });
    host.fire({ type: "session_deleted", session_id: "saved" });
    host.fire({ type: "error", message: "Failed" });
    host.fire({ type: "host_exited" });
    expect((resolved.posted.at(-1) as { state: { banner: string } }).state.banner).toBe(
      "The Brokk ACP host exited.",
    );
  });

  it("routes prompts, cancellation, permissions, config, refresh, and switching", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const first = agent();
    const second = agent({ id: "custom:second", name: "Second", launch: launch("second") });
    const catalog = catalogWith(context, [first, second]);
    const chat = new ChatView(context, host as never, catalog, new FakeWorktrees());
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);
    await chat.newSession(first.id);
    host.fire({ type: "connecting", connection_id: 3 });
    host.fire({
      type: "connected",
      connection_id: 3,
      agent_capabilities: { promptCapabilities: { image: true } },
    });
    host.fire({ type: "session_started", session_id: "remote", method: "new" });

    await resolved.receive({ type: "prompt", text: "  Build  " });
    expect(host.sent.at(-1)).toEqual({ type: "prompt", text: "Build" });
    await resolved.receive({ type: "cancel" });
    await resolved.receive({
      type: "permission_response",
      request_id: "request",
      option_id: "allow",
    });
    await resolved.receive({ type: "retry_session" });
    await resolved.receive({
      type: "set_config",
      config_id: "mode",
      value: { value: "plan" },
    });
    expect(host.sent).toEqual(
      expect.arrayContaining([
        { type: "cancel" },
        { type: "permission_response", request_id: "request", option_id: "allow" },
        { type: "retry_session" },
        { type: "set_config", config_id: "mode", value: { value: "plan" } },
      ]),
    );

    await resolved.receive({ type: "refresh_sessions" });
    expect(host.sent.at(-1)).toEqual({ type: "refresh_sessions" });
    host.fire({ type: "turn_completed", stop_reason: "end_turn" });
    await resolved.receive({
      type: "prompt",
      text: "",
      images: [
        {
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          name: "screen.png",
        },
      ],
    });
    expect(host.sent.at(-1)).toEqual({
      type: "prompt",
      text: "",
      images: [
        {
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          name: "screen.png",
        },
      ],
    });
    expect(
      (chat as never as {
        sessions: { active: { entries: Array<{ attachments?: unknown[] }> } };
      }).sessions.active.entries.at(-1)?.attachments,
    ).toEqual([
      { type: "image", name: "screen.png", mimeType: "image/png" },
    ]);
    host.fire({ type: "turn_completed", stop_reason: "end_turn" });
    await resolved.receive({ type: "new_session", agent_id: second.id });
    expect(host.disconnectCalls).toBe(1);
    host.fire({ type: "disconnected", connection_id: 3 });
    await vi.runAllTimersAsync();
    expect(host.connected.at(-1)?.launch.command).toBe("second");
  });

  it("handles authentication values, cancellation, validation errors, and deletion", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const choice = agent();
    const catalog = catalogWith(context, [choice]);
    const chat = new ChatView(context, host as never, catalog, new FakeWorktrees());
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);
    await chat.newSession(choice.id);
    host.fire({ type: "connecting", connection_id: 4 });
    host.fire({ type: "connected", connection_id: 4, agent_capabilities: {} });
    host.fire({ type: "session_started", session_id: "remote", method: "new" });

    host.fire({
      type: "auth_required",
      message: "Token required",
      auth_methods: [
        {
          type: "env_var",
          id: "env",
          name: "Token",
          vars: [
            { name: "TOKEN", label: "API token", secret: true },
            { name: "OPTIONAL", optional: true },
          ],
        },
        { type: "terminal", id: "terminal", name: "Terminal" },
      ],
    });
    mocks.showInputBox.mockResolvedValueOnce("secret").mockResolvedValueOnce("");
    await resolved.receive({ type: "authenticate", method_id: "env" });
    expect(context.secrets.store).toHaveBeenCalledWith(
      "brokkAcp.auth.scope.env.TOKEN",
      "secret",
    );
    expect(host.reconnects).toEqual([{ TOKEN: "secret" }]);
    await resolved.receive({ type: "authenticate", method_id: "terminal" });
    expect(host.sent.at(-1)).toEqual({ type: "authenticate", method_id: "terminal" });
    host.fire({ type: "terminal_auth" });
    host.fire({ type: "authenticated" });

    mocks.showWarningMessage.mockResolvedValueOnce("Delete session");
    const localId = (chat as never as { sessions: { active: { localId: string } } }).sessions.active
      .localId;
    await resolved.receive({ type: "delete_session", local_id: localId });
    expect(host.sent.at(-1)).toEqual({ type: "delete_session", session_id: "remote" });

    await resolved.receive({ type: "show_start" });
    await resolved.receive({ type: "new_session", agent_id: "missing" });
    expect(mocks.showErrorMessage).toHaveBeenCalledWith("Choose an installed ACP agent.");
    await resolved.receive(null);
    await resolved.receive({ type: 7 });
  });

  it("rejects malformed images and agents without image prompt support", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const choice = agent();
    const chat = new ChatView(
      context,
      host as never,
      catalogWith(context, [choice]),
      new FakeWorktrees(),
    );
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);
    await chat.newSession(choice.id);
    host.fire({ type: "connecting", connection_id: 8 });
    host.fire({
      type: "connected",
      connection_id: 8,
      agent_capabilities: { promptCapabilities: { image: false } },
    });
    host.fire({ type: "session_started", session_id: "remote", method: "new" });

    await resolved.receive({
      type: "prompt",
      text: "Look",
      images: [
        {
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          name: "screen.png",
        },
      ],
    });
    expect(mocks.showErrorMessage).toHaveBeenLastCalledWith(
      "This ACP agent does not support image prompts.",
    );
    expect(host.sent).not.toContainEqual(expect.objectContaining({ type: "prompt" }));

    await resolved.receive({
      type: "prompt",
      images: [{ data: "bad", mimeType: "image/png" }],
    });
    expect(mocks.showErrorMessage).toHaveBeenLastCalledWith(
      "Image 1 is not valid base64.",
    );
  });

  it("covers rejected messages and safe session edge cases", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const choice = agent();
    const catalog = catalogWith(context, [choice]);
    const chat = new ChatView(context, host as never, catalog, new FakeWorktrees());
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);

    await chat.newSession();
    host.fire({ type: "connecting" });
    host.fire({ type: "connection_progress" });
    host.fire({ type: "connected", agent_capabilities: "invalid" });
    host.fire({ type: "agent_sessions", sessions: [] });
    host.fire({ type: "session_list_error" });
    host.fire({ type: "session_replay_started" });
    host.fire({ type: "session_started", session_id: "remote" });
    host.fire({ type: "permission_request", request_id: 7 });
    host.fire({ type: "auth_required", auth_methods: "invalid" });
    host.fire({ type: "session_deleted", session_id: 7 });
    host.fire({ type: "error" });
    host.fire({ type: "disconnected" });

    for (const message of [
      { type: "select_agent", agent_id: 7 },
      { type: "new_session", agent_id: 7 },
      { type: "browse_sessions", agent_id: 7 },
      { type: "open_session", local_id: 7 },
      { type: "delete_session", local_id: 7 },
      { type: "prompt", text: "   " },
      { type: "prompt", text: 7 },
      { type: "permission_response", request_id: 7 },
      { type: "authenticate", method_id: 7 },
      { type: "set_config", config_id: 7, value: {} },
      { type: "set_config", config_id: "mode", value: "invalid" },
      { type: "unknown" },
    ]) {
      await resolved.receive(message);
    }
    await resolved.receive({
      type: "permission_response",
      request_id: "request",
    });
    expect(host.sent.at(-1)).toEqual({
      type: "permission_response",
      request_id: "request",
      option_id: null,
    });

    await chat.newSession(choice.id);
    const localId = (chat as never as { sessions: { active: { localId: string } } }).sessions.active
      .localId;
    await resolved.receive({ type: "open_session", local_id: localId });
    expect(
      (resolved.posted.at(-1) as { state: { banner: string } }).state.banner,
    ).toContain("no ACP session ID");
    await resolved.receive({ type: "open_session", local_id: "missing" });
    expect(mocks.showErrorMessage).toHaveBeenCalledWith("This session is no longer available.");
    await resolved.receive({ type: "delete_session", local_id: localId });
  });

  it("blocks navigation during turns and rejects unavailable agents", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const unavailable = agent({
      id: "registry:missing",
      source: "registry",
      launch: undefined,
      ready: false,
    });
    const choice = agent();
    const catalog = catalogWith(context, [choice, unavailable]);
    const chat = new ChatView(context, host as never, catalog, new FakeWorktrees());
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);
    await chat.newSession(choice.id);
    host.fire({ type: "connecting", connection_id: 9 });
    host.fire({ type: "connected", connection_id: 9, agent_capabilities: {} });
    host.fire({ type: "session_started", session_id: "remote" });
    await resolved.receive({ type: "prompt", text: "running" });

    await expect(chat.newSession(choice.id)).rejects.toThrow("Stop the active turn");
    await resolved.receive({ type: "show_start" });
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Stop the active turn before leaving this session.",
    );
    host.fire({ type: "turn_completed" });
    await resolved.receive({ type: "browse_sessions", agent_id: unavailable.id });
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Install this ACP agent before connecting.",
    );

    await chat.newSession(choice.id);
    expect(host.sent.at(-1)).toEqual({ type: "new_session" });
  });

  it("routes each worktree through a distinct host connection and opens it in VS Code", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const choice = agent();
    const worktrees = new FakeWorktrees();
    const chat = new ChatView(
      context,
      host as never,
      catalogWith(context, [choice]),
      worktrees,
    );
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);

    await resolved.receive({
      type: "new_session",
      agent_id: choice.id,
      working_directory: { kind: "create" },
    });
    expect(worktrees.resolved).toEqual([
      { cwd: "/workspace", selection: { kind: "create" } },
    ]);
    expect(host.connected.at(-1)).toMatchObject({
      cwd: "/workspace/.brokk/worktrees/bright-fox",
      session: { mode: "new" },
    });
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      { fsPath: "/workspace/.brokk/worktrees/bright-fox" },
      { forceNewWindow: true },
    );

    host.fire({ type: "connecting", connection_id: 22 });
    host.fire({ type: "connected", connection_id: 22, agent_capabilities: {} });
    host.fire({ type: "session_started", session_id: "worktree-session", method: "new" });
    mocks.executeCommand.mockClear();
    await resolved.receive({ type: "open_worktree" });
    expect(worktrees.validated.at(-1)?.cwd).toBe(
      "/workspace/.brokk/worktrees/bright-fox",
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      { fsPath: "/workspace/.brokk/worktrees/bright-fox" },
      { forceNewWindow: true },
    );

    await resolved.receive({ type: "show_start" });
    await resolved.receive({
      type: "new_session",
      agent_id: choice.id,
      working_directory: { kind: "existing", path: "/other/worktree" },
    });
    expect(host.disconnectCalls).toBe(1);
    host.fire({ type: "disconnected", connection_id: 22 });
    await vi.runAllTimersAsync();
    expect(host.connected.at(-1)).toMatchObject({
      cwd: "/other/worktree",
      session: { mode: "new" },
    });
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      { fsPath: "/other/worktree" },
      { forceNewWindow: true },
    );
  });

  it("keeps the worktree agent connection when VS Code cannot open the checkout", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const choice = agent();
    const chat = new ChatView(
      context,
      host as never,
      catalogWith(context, [choice]),
      new FakeWorktrees(),
    );
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);
    mocks.executeCommand.mockRejectedValueOnce(new Error("window blocked"));

    await chat.newSession(choice.id, { kind: "create" });
    await Promise.resolve();

    expect(host.connected.at(-1)?.cwd).toBe(
      "/workspace/.brokk/worktrees/bright-fox",
    );
    expect(
      (resolved.posted.at(-1) as { state: { banner: string } }).state.banner,
    ).toContain("agent is running in bright-fox");
    expect(
      (resolved.posted.at(-1) as { state: { banner: string } }).state.banner,
    ).toContain("window blocked");
  });

  it("offers safe managed-worktree cleanup only after ACP session deletion", async () => {
    const context = extensionContext();
    const host = new FakeHost();
    const choice = agent();
    const worktrees = new FakeWorktrees();
    const chat = new ChatView(
      context,
      host as never,
      catalogWith(context, [choice]),
      worktrees,
    );
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);
    await chat.newSession(choice.id, { kind: "create" });
    host.fire({ type: "connecting", connection_id: 23 });
    host.fire({ type: "connected", connection_id: 23, agent_capabilities: {} });
    host.fire({ type: "session_started", session_id: "managed", method: "new" });

    mocks.showWarningMessage.mockResolvedValueOnce("Delete + remove worktree");
    const localId = (chat as never as { sessions: { active: { localId: string } } }).sessions.active
      .localId;
    await resolved.receive({ type: "delete_session", local_id: localId });
    expect(host.sent.at(-1)).toEqual({ type: "delete_session", session_id: "managed" });
    expect(worktrees.removed).toEqual([]);

    host.fire({ type: "session_deleted", session_id: "managed" });
    await vi.runAllTimersAsync();
    expect(worktrees.removed).toEqual([
      expect.objectContaining({ name: "bright-fox", managed: true }),
    ]);
  });

  it("does not silently restore a session whose recorded worktree disappeared", async () => {
    const savedWorktree: SessionWorktree = {
      projectRoot: "/workspace",
      worktreeRoot: "/workspace/.brokk/worktrees/gone",
      name: "gone",
      managed: true,
    };
    const saved = {
      version: 1,
      activeLocalId: "local",
      sessions: [
        {
          localId: "local",
          remoteId: "remote",
          agentId: "custom:agent",
          agentName: "Agent",
          cwd: "/workspace/.brokk/worktrees/gone",
          worktree: savedWorktree,
          title: "Missing checkout",
          createdAt: "2026-07-28T00:00:00.000Z",
          updatedAt: "2026-07-28T00:00:00.000Z",
          status: "ready",
          entries: [],
          configOptions: [],
        },
      ],
    };
    const context = extensionContext(saved);
    const host = new FakeHost();
    const worktrees = new FakeWorktrees();
    worktrees.validationError = new Error("Session working directory is unavailable");
    const chat = new ChatView(
      context,
      host as never,
      catalogWith(context, [agent()]),
      worktrees,
    );
    const resolved = fakeView();
    chat.resolveWebviewView(resolved.view);

    await resolved.receive({ type: "ready" });
    await Promise.resolve();
    expect(host.connected).toEqual([]);
    expect(
      (resolved.posted.at(-1) as { state: { banner: string } }).state.banner,
    ).toContain("relink this session");
    expect(
      (resolved.posted.at(-1) as {
        state: { relinkSession: { localId: string; title: string } };
      }).state.relinkSession,
    ).toEqual({ localId: "local", title: "Missing checkout", agentId: "custom:agent" });

    await resolved.receive({
      type: "relink_session",
      local_id: "local",
      working_directory: { kind: "workspace" },
    });
    expect(host.connected.at(-1)).toMatchObject({
      cwd: "/workspace",
      session: { mode: "open", session_id: "remote", replay: true },
    });
  });
});

describe("activate", () => {
  it("registers the view and commands and starts selected agents", async () => {
    const context = extensionContext();
    mocks.showQuickPick.mockImplementation(async (items: unknown[]) => items[0]);
    activate(context);
    expect(mocks.registerWebviewViewProvider).toHaveBeenCalledWith(
      "brokkAcp.chat",
      expect.anything(),
    );
    expect(mocks.registeredCommands.has("brokkAcp.connect")).toBe(true);
    expect(mocks.registeredCommands.has("brokkAcp.disconnect")).toBe(true);
    expect(mocks.registeredCommands.has("brokkAcp.refreshAgents")).toBe(true);
    expect(context.subscriptions.length).toBe(6);

    await mocks.registeredCommands.get("brokkAcp.connect")?.();
    expect(mocks.executeCommand).toHaveBeenCalledWith("brokkAcp.chat.focus");
    expect(context.workspaceState.update).toHaveBeenCalledWith(
      "brokkAcp.selectedAgent",
      "bundled:anvil",
    );
  });
});
