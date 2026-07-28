import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { SessionStore, type SessionRecord } from "../src/sessionStore";

const STORAGE_KEY = "brokkAcp.sessions.v1";

function contextWith(saved?: unknown) {
  const update = vi.fn(async () => undefined);
  const context = {
    workspaceState: {
      get: vi.fn((key: string) => (key === STORAGE_KEY ? saved : undefined)),
      update,
    },
  } as unknown as vscode.ExtensionContext;
  return { context, update };
}

function storedSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    localId: "local-1",
    remoteId: "remote-1",
    agentId: "agent-1",
    agentName: "Agent One",
    cwd: "/workspace",
    title: "Saved",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:01.000Z",
    status: "ready",
    entries: [],
    configOptions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("SessionStore persistence and lifecycle", () => {
  it("restores valid sessions, legacy plans, and the active selection", () => {
    const saved = {
      version: 1,
      activeLocalId: "local-1",
      sessions: [
        storedSession({
          entries: [
            {
              id: "plan-entry",
              kind: "plan",
              plan: [{ content: "Restore", priority: "high", status: "in_progress" }],
              createdAt: "2026-07-27T00:00:00.000Z",
            },
          ],
        }),
        { localId: "invalid" },
      ],
    };
    const { context } = contextWith(saved);
    const store = new SessionStore(context);

    expect(store.active?.status).toBe("disconnected");
    expect(store.active?.currentPlan).toEqual([
      { content: "Restore", priority: "high", status: "in_progress" },
    ]);
    expect(store.get("missing")).toBeUndefined();
    expect(store.snapshot().sessions).toHaveLength(1);
  });

  it("creates, activates, connects, and starts sessions", () => {
    const { context, update } = contextWith();
    const store = new SessionStore(context);
    expect(store.activate("missing")).toBeUndefined();

    const first = store.create({ id: "one", name: "One" }, "/workspace");
    store.setConnected("Renamed", { sessionCapabilities: { list: {} } });
    store.setConfigOptions([{ id: "model" }]);
    store.setSessionStarted("remote", "new", [{ id: "mode" }], { currentModeId: "agent" });

    expect(store.active).toMatchObject({
      localId: first.localId,
      remoteId: "remote",
      agentName: "Renamed",
      status: "ready",
      title: "New session",
      configOptions: [{ id: "mode" }],
    });

    const second = store.create({ id: "two", name: "Two" }, "/other");
    expect(store.get(first.localId)?.status).toBe("disconnected");
    expect(store.activate(first.localId)?.status).toBe("connecting");
    expect(store.get(second.localId)?.status).toBe("disconnected");

    store.setConnecting();
    vi.runAllTimers();
    expect(update).toHaveBeenCalled();
  });

  it("records streamed turns, tools, plans, usage, commands, and modes", () => {
    const { context } = contextWith();
    const store = new SessionStore(context);
    store.create({ id: "agent", name: "Agent" }, "/workspace");
    store.setSessionStarted("remote", "new", [], undefined);

    store.beginTurn(
      "A deliberately long prompt that should be shortened to a useful session title in the list",
    );
    store.turnStarted();
    store.applySessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello " },
    });
    store.applySessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    });
    store.applySessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "resource_link", name: "README.md" },
    });
    store.applySessionUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "image", data: "ignored" },
    });
    store.applySessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read file",
      status: "pending",
      kind: "read",
      content: [{ type: "text", text: "input" }],
      locations: [{ path: "README.md" }],
      rawInput: { path: "README.md" },
    });
    store.applySessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { text: "done" },
    });
    store.applySessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-2",
      title: "New partial tool",
    });
    store.applySessionUpdate({
      sessionUpdate: "plan",
      entries: [{ content: "Test", priority: "medium", status: "in_progress" }],
    });
    store.applySessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: [{ id: "model" }],
    });
    store.applySessionUpdate({
      sessionUpdate: "session_info_update",
      title: " Agent supplied title ",
      updatedAt: "2026-07-28T01:00:00.000Z",
    });
    store.applySessionUpdate({
      sessionUpdate: "usage_update",
      used: 10,
      size: 100,
      cost: { amount: 0.01 },
    });
    store.applySessionUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review" }],
    });
    store.applySessionUpdate({
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    });
    store.applySessionUpdate({ sessionUpdate: "current_mode_update", currentModeId: 7 });
    store.applySessionUpdate({ sessionUpdate: "unknown" });
    store.applySessionUpdate(null);
    store.turnCompleted("end_turn", { used: 11 });

    const active = store.snapshot().active!;
    expect(active.title).toBe("Agent supplied title");
    expect(active.status).toBe("ready");
    expect(active.entries.find((entry) => entry.kind === "assistant")).toMatchObject({
      text: "Hello world",
      status: "end_turn",
    });
    expect(active.entries.find((entry) => entry.kind === "thought")?.text).toBe("[README.md]");
    expect(
      active.entries.find(
        (entry) => entry.kind === "user" && entry.attachments?.length,
      )?.attachments,
    ).toEqual([{ type: "image", name: "Image", mimeType: "image" }]);
    expect(active.entries.find((entry) => entry.toolCallId === "tool-1")).toMatchObject({
      title: "Read file",
      status: "completed",
      toolKind: "read",
      rawOutput: { text: "done" },
    });
    expect(active.entries.find((entry) => entry.toolCallId === "tool-2")?.title).toBe(
      "New partial tool",
    );
    expect(active.currentPlan).toEqual([
      { content: "Test", priority: "medium", status: "in_progress" },
    ]);
    expect(active.configOptions).toEqual([{ id: "model" }]);
    expect(active.usage).toEqual({ used: 11 });
    expect(active.availableCommands).toEqual([{ name: "review" }]);
    expect(active.currentModeId).toBe("plan");
  });

  it("backs up a cached transcript during replay and restores it on disconnect", () => {
    const record = storedSession({
      entries: [
        {
          id: "cached",
          kind: "assistant",
          text: "Cached",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
      ],
      currentPlan: [{ content: "Cached plan", priority: "low", status: "pending" }],
    });
    const { context } = contextWith({
      version: 1,
      activeLocalId: record.localId,
      sessions: [record],
    });
    const store = new SessionStore(context);

    store.startReplay("wrong");
    expect(store.active?.entries).toHaveLength(1);
    store.startReplay("remote-1");
    expect(store.active?.entries).toEqual([]);
    store.applySessionUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Replay prompt" },
    });
    store.applySessionUpdate({
      sessionUpdate: "user_message_chunk",
      content: {
        type: "image",
        mimeType: "image/png",
        uri: "file:///tmp/Replay%20image.png",
      },
    });
    store.applySessionUpdate({
      sessionUpdate: "user_message_chunk",
      content: {
        type: "image",
        mimeType: "image/jpeg",
        uri: "file:///tmp/%E0%A4%A",
      },
    });
    expect(store.active?.entries[0]?.attachments).toEqual([
      { type: "image", name: "Replay image.png", mimeType: "image/png" },
      { type: "image", name: "%E0%A4%A", mimeType: "image/jpeg" },
    ]);
    store.applySessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Replay response" },
    });
    store.disconnected();

    expect(store.active?.entries[0]?.text).toBe("Cached");
    expect(store.active?.currentPlan?.[0]?.content).toBe("Cached plan");

    store.startReplay("remote-1");
    store.setSessionStarted("remote-1", "load", [], undefined);
    store.disconnected();
    expect(store.active?.entries).toEqual([]);
  });

  it("records image-only prompts without persisting encoded image data", () => {
    const { context } = contextWith();
    const store = new SessionStore(context);
    store.create({ id: "agent", name: "Agent" }, "/workspace");
    store.beginTurn("", [
      { type: "image", name: "screen.png", mimeType: "image/png" },
    ]);

    expect(store.active?.title).toBe("Image: screen.png");
    expect(store.active?.entries.at(-1)).toMatchObject({
      kind: "user",
      text: undefined,
      attachments: [
        { type: "image", name: "screen.png", mimeType: "image/png" },
      ],
    });
    expect(JSON.stringify(store.active)).not.toContain("base64");
  });

  it("merges, updates, sorts, and removes remote sessions", () => {
    const { context } = contextWith();
    const store = new SessionStore(context);
    store.mergeRemoteSessions({ id: "agent", name: "Agent" }, "/default", "bad");
    store.mergeRemoteSessions({ id: "agent", name: "Agent" }, "/default", [
      null,
      {},
      {
        sessionId: "remote-a",
        title: " First ",
        cwd: "/first",
        updatedAt: "2026-07-28T01:00:00.000Z",
      },
      { sessionId: "remote-b" },
    ]);
    const first = store.snapshot().sessions.find((session) => session.remoteId === "remote-a")!;
    store.mergeRemoteSessions({ id: "agent", name: "Agent" }, "/default", [
      {
        sessionId: "remote-a",
        title: "Updated",
        cwd: "/updated",
        updatedAt: "2026-07-28T02:00:00.000Z",
      },
    ]);

    expect(store.get(first.localId)).toMatchObject({
      title: "Updated",
      cwd: "/updated",
      updatedAt: "2026-07-28T02:00:00.000Z",
    });
    expect(store.snapshot().sessions[0]?.title).toBe("Updated");

    store.activate(first.localId);
    store.removeByRemoteId("other", "remote-a");
    expect(store.active).toBeDefined();
    store.removeByRemoteId("agent", "remote-a");
    expect(store.active).toBeUndefined();
  });

  it("tracks permissions, errors, and disconnection states", () => {
    const { context } = contextWith();
    const store = new SessionStore(context);
    store.addPermission("none", {}, []);
    store.addError("ignored");
    store.disconnected();

    store.create({ id: "agent", name: "Agent" }, "/workspace");
    store.beginTurn("Prompt");
    store.addPermission(
      "permission-1",
      { title: "Run command", kind: "execute" },
      [{ optionId: "allow" }],
    );
    store.resolvePermission("missing", null);
    store.resolvePermission("permission-1", "allow");
    expect(store.active?.entries.at(-1)).toMatchObject({
      kind: "permission",
      title: "Run command",
      toolKind: "execute",
      resolvedOptionId: "allow",
    });

    store.addError("Agent failed");
    store.disconnected();
    expect(store.active?.status).toBe("error");
    expect(store.active?.entries.at(-1)).toMatchObject({
      kind: "error",
      text: "Agent failed",
    });
  });
});
