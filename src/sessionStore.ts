import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  latestLegacyPlan,
  normalizePlanEntries,
  type SessionPlanEntry,
} from "./plans";
import type { SessionWorktree } from "./worktrees";

export type SessionStatus =
  | "connecting"
  | "ready"
  | "running"
  | "disconnected"
  | "error";

export interface TranscriptAttachment {
  type: "image";
  name: string;
  mimeType: string;
}

export interface TranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "thought" | "tool" | "plan" | "permission" | "notice" | "error";
  turnId?: string;
  text?: string;
  title?: string;
  status?: string;
  toolCallId?: string;
  toolKind?: string;
  content?: unknown[];
  locations?: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
  plan?: unknown[];
  requestId?: string;
  options?: unknown[];
  resolvedOptionId?: string | null;
  attachments?: TranscriptAttachment[];
  createdAt: string;
}

export interface SessionRecord {
  localId: string;
  remoteId?: string;
  agentId: string;
  agentName: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  entries: TranscriptEntry[];
  configOptions: unknown[];
  modes?: unknown;
  usage?: unknown;
  capabilities?: unknown;
  availableCommands?: unknown[];
  currentModeId?: string;
  currentPlan?: SessionPlanEntry[];
  worktree?: SessionWorktree;
}

export interface SessionSummary {
  localId: string;
  remoteId?: string;
  agentId: string;
  agentName: string;
  cwd: string;
  worktree?: SessionWorktree;
  title: string;
  updatedAt: string;
  status: SessionStatus;
  hasTranscript: boolean;
}

interface StoredSessions {
  version: 1;
  activeLocalId?: string;
  sessions: SessionRecord[];
}

interface AgentIdentity {
  id: string;
  name: string;
}

const STORAGE_KEY = "brokkAcp.sessions.v1";
const MAX_SESSIONS = 60;
const MAX_ENTRIES = 400;

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private activeLocalId: string | undefined;
  private activeTurnId: string | undefined;
  private replaying = false;
  private replayBackup: TranscriptEntry[] | undefined;
  private replayPlanBackup: SessionPlanEntry[] | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<StoredSessions>(STORAGE_KEY);
    if (saved?.version === 1 && Array.isArray(saved.sessions)) {
      for (const session of saved.sessions) {
        if (isSessionRecord(session)) {
          const currentPlan = Array.isArray(session.currentPlan)
            ? normalizePlanEntries(session.currentPlan)
            : latestLegacyPlan(session.entries);
          this.sessions.set(session.localId, {
            ...session,
            currentPlan,
            status: "disconnected",
          });
        }
      }
      if (saved.activeLocalId && this.sessions.has(saved.activeLocalId)) {
        this.activeLocalId = saved.activeLocalId;
      }
    }
  }

  get active(): SessionRecord | undefined {
    return this.activeLocalId ? this.sessions.get(this.activeLocalId) : undefined;
  }

  get(localId: string): SessionRecord | undefined {
    return this.sessions.get(localId);
  }

  setWorkspace(localId: string, cwd: string, worktree?: SessionWorktree): SessionRecord | undefined {
    const session = this.sessions.get(localId);
    if (!session) {
      return undefined;
    }
    session.cwd = cwd;
    session.worktree = worktree;
    this.touch(session);
    return session;
  }

  hasOtherSessionInWorktree(localId: string, worktreeRoot: string): boolean {
    return [...this.sessions.values()].some(
      (session) =>
        session.localId !== localId && session.worktree?.worktreeRoot === worktreeRoot,
    );
  }

  create(agent: AgentIdentity, cwd: string, worktree?: SessionWorktree): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      localId: randomUUID(),
      agentId: agent.id,
      agentName: agent.name,
      cwd,
      title: "New session",
      createdAt: now,
      updatedAt: now,
      status: "connecting",
      entries: [],
      configOptions: [],
      worktree,
    };
    this.sessions.set(session.localId, session);
    this.activate(session.localId);
    return session;
  }

  activate(localId: string, replay = false): SessionRecord | undefined {
    const session = this.sessions.get(localId);
    if (!session) {
      return undefined;
    }
    if (this.active && this.active.localId !== localId && this.active.status !== "error") {
      this.active.status = "disconnected";
    }
    this.activeLocalId = localId;
    this.activeTurnId = undefined;
    this.replaying = false;
    this.replayBackup = undefined;
    this.replayPlanBackup = undefined;
    session.status = "connecting";
    this.touch(session);
    return session;
  }

  startReplay(remoteId: string): void {
    const session = this.active;
    if (!session || session.remoteId !== remoteId) {
      return;
    }
    this.replayBackup = structuredClone(session.entries);
    this.replayPlanBackup = session.currentPlan
      ? structuredClone(session.currentPlan)
      : undefined;
    session.entries = [];
    session.currentPlan = undefined;
    this.activeTurnId = undefined;
    this.replaying = true;
    this.touch(session);
  }

  setConnecting(): void {
    if (this.active) {
      this.active.status = "connecting";
      this.touch(this.active);
    }
  }

  setConnected(agentName?: string, capabilities?: unknown): void {
    if (!this.active) {
      return;
    }
    if (agentName) {
      this.active.agentName = agentName;
    }
    this.active.capabilities = capabilities;
    this.touch(this.active);
  }

  setSessionStarted(
    remoteId: string,
    method: string,
    configOptions: unknown,
    modes: unknown,
  ): void {
    const active = this.active;
    if (!active) {
      return;
    }
    active.remoteId = remoteId;
    active.configOptions = Array.isArray(configOptions) ? configOptions : [];
    active.modes = modes;
    active.status = "ready";
    this.replaying = false;
    this.replayBackup = undefined;
    this.replayPlanBackup = undefined;
    for (const entry of active.entries) {
      if (entry.status === "streaming") {
        entry.status = "completed";
      }
    }
    if (method === "new" && active.entries.length === 0) {
      active.title = "New session";
    }
    this.touch(active);
  }

  mergeRemoteSessions(
    agent: AgentIdentity,
    cwd: string,
    values: unknown,
    worktree?: SessionWorktree,
  ): void {
    if (!Array.isArray(values)) {
      return;
    }
    for (const value of values) {
      if (!isRecord(value) || typeof value.sessionId !== "string") {
        continue;
      }
      const existing = [...this.sessions.values()].find(
        (session) => session.agentId === agent.id && session.remoteId === value.sessionId,
      );
      const updatedAt =
        typeof value.updatedAt === "string" ? value.updatedAt : existing?.updatedAt ?? new Date().toISOString();
      const title =
        typeof value.title === "string" && value.title.trim()
          ? value.title.trim()
          : existing?.title ?? "Untitled session";
      if (existing) {
        existing.title = title;
        existing.updatedAt = updatedAt;
        if (worktree) {
          existing.cwd = cwd;
          existing.worktree = worktree;
        } else if (!existing.worktree && typeof value.cwd === "string") {
          existing.cwd = value.cwd;
        }
        continue;
      }
      const localId = randomUUID();
      this.sessions.set(localId, {
        localId,
        remoteId: value.sessionId,
        agentId: agent.id,
        agentName: agent.name,
        cwd: worktree ? cwd : typeof value.cwd === "string" ? value.cwd : cwd,
        worktree,
        title,
        createdAt: updatedAt,
        updatedAt,
        status: "disconnected",
        entries: [],
        configOptions: [],
      });
    }
    this.persist();
  }

  beginTurn(text: string, attachments: TranscriptAttachment[] = []): void {
    const session = this.active;
    if (!session) {
      return;
    }
    this.completeStreamingContent(session);
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    session.status = "running";
    session.currentPlan = undefined;
    session.entries.push({
      id: randomUUID(),
      kind: "user",
      turnId,
      text: text || undefined,
      attachments: attachments.length ? structuredClone(attachments) : undefined,
      createdAt: new Date().toISOString(),
    });
    if (session.title === "New session") {
      session.title = text.trim()
        ? titleFromPrompt(text)
        : attachments.length
          ? titleFromPrompt(`Image: ${attachments[0].name}`)
          : "Image prompt";
    }
    this.touch(session);
  }

  turnStarted(): void {
    if (this.active) {
      this.active.status = "running";
      this.touch(this.active);
    }
  }

  turnCompleted(stopReason?: string, usage?: unknown): void {
    const session = this.active;
    if (!session) {
      return;
    }
    session.status = "ready";
    session.usage = usage ?? session.usage;
    this.completeStreamingContent(session, stopReason || "completed");
    this.activeTurnId = undefined;
    this.touch(session);
  }

  applySessionUpdate(value: unknown): void {
    const session = this.active;
    if (!session || !isRecord(value) || typeof value.sessionUpdate !== "string") {
      return;
    }
    switch (value.sessionUpdate) {
      case "user_message_chunk":
        this.appendContent("user", value.content);
        break;
      case "agent_message_chunk":
        this.appendContent("assistant", value.content);
        break;
      case "agent_thought_chunk":
        this.appendContent("thought", value.content);
        break;
      case "tool_call":
        this.upsertTool(value, false);
        break;
      case "tool_call_update":
        this.upsertTool(value, true);
        break;
      case "plan":
        session.currentPlan = normalizePlanEntries(value.entries);
        break;
      case "config_option_update":
        session.configOptions = Array.isArray(value.configOptions) ? value.configOptions : [];
        break;
      case "session_info_update":
        if (typeof value.title === "string" && value.title.trim()) {
          session.title = value.title.trim();
        }
        if (typeof value.updatedAt === "string") {
          session.updatedAt = value.updatedAt;
        }
        break;
      case "usage_update":
        session.usage = {
          used: value.used,
          size: value.size,
          cost: value.cost,
        };
        break;
      case "available_commands_update":
        session.availableCommands = Array.isArray(value.availableCommands)
          ? value.availableCommands
          : [];
        break;
      case "current_mode_update":
        if (typeof value.currentModeId === "string") {
          session.currentModeId = value.currentModeId;
        }
        break;
    }
    this.touch(session);
  }

  setConfigOptions(value: unknown): void {
    if (this.active) {
      this.active.configOptions = Array.isArray(value) ? value : [];
      this.touch(this.active);
    }
  }

  addPermission(requestId: string, toolCall: unknown, options: unknown): void {
    const session = this.active;
    if (!session) {
      return;
    }
    this.completeStreamingContent(session);
    const tool = isRecord(toolCall) ? toolCall : {};
    session.entries.push({
      id: randomUUID(),
      kind: "permission",
      turnId: this.activeTurnId,
      title: typeof tool.title === "string" ? tool.title : "Permission required",
      toolKind: typeof tool.kind === "string" ? tool.kind : undefined,
      requestId,
      options: Array.isArray(options) ? options : [],
      createdAt: new Date().toISOString(),
    });
    this.touch(session);
  }

  resolvePermission(requestId: string, optionId: string | null): void {
    const entry = this.active?.entries.find(
      (candidate) => candidate.kind === "permission" && candidate.requestId === requestId,
    );
    if (entry) {
      entry.resolvedOptionId = optionId;
      this.touch(this.active!);
    }
  }

  addError(message: string): void {
    const session = this.active;
    if (!session) {
      return;
    }
    this.completeStreamingContent(session, "error");
    session.status = "error";
    session.entries.push({
      id: randomUUID(),
      kind: "error",
      text: message,
      createdAt: new Date().toISOString(),
    });
    this.touch(session);
  }

  disconnected(): void {
    const session = this.active;
    if (session) {
      if (this.replaying) {
        if (this.replayBackup) {
          session.entries = this.replayBackup;
        }
        session.currentPlan = this.replayPlanBackup;
      }
      if (session.status !== "error") {
        session.status = "disconnected";
      }
      this.completeStreamingContent(session);
      this.touch(session);
    }
    this.activeTurnId = undefined;
    this.replaying = false;
    this.replayBackup = undefined;
    this.replayPlanBackup = undefined;
  }

  removeByRemoteId(agentId: string, remoteId: string): void {
    for (const [localId, session] of this.sessions) {
      if (session.agentId === agentId && session.remoteId === remoteId) {
        this.sessions.delete(localId);
        if (this.activeLocalId === localId) {
          this.activeLocalId = undefined;
        }
      }
    }
    this.persist();
  }

  snapshot(): { active?: SessionRecord; sessions: SessionSummary[] } {
    const sessions = [...this.sessions.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_SESSIONS)
      .map((session) => ({
        localId: session.localId,
        remoteId: session.remoteId,
        agentId: session.agentId,
        agentName: session.agentName,
        cwd: session.cwd,
        worktree: session.worktree,
        title: session.title,
        updatedAt: session.updatedAt,
        status: session.status,
        hasTranscript: session.entries.length > 0,
      }));
    return {
      active: this.active ? structuredClone(this.active) : undefined,
      sessions,
    };
  }

  private appendContent(kind: "user" | "assistant" | "thought", content: unknown): void {
    const session = this.active;
    if (!session) {
      return;
    }
    const text = contentText(content);
    const attachment = kind === "user" ? contentAttachment(content) : undefined;
    if (!text && !attachment) {
      return;
    }
    let turnId = this.activeTurnId;
    if (
      this.replaying &&
      kind === "user" &&
      session.entries.at(-1)?.kind !== "user"
    ) {
      turnId = randomUUID();
      this.activeTurnId = turnId;
      session.currentPlan = undefined;
    }
    if (!turnId) {
      turnId = randomUUID();
      this.activeTurnId = turnId;
    }
    const last = session.entries.at(-1);
    if (last?.kind === kind && last.turnId === turnId && last.status === "streaming") {
      if (text) {
        last.text = `${last.text ?? ""}${text}`;
      }
      if (attachment) {
        last.attachments = [...(last.attachments ?? []), attachment];
      }
      return;
    }
    this.completeStreamingContent(session);
    session.entries.push({
      id: randomUUID(),
      kind,
      turnId,
      text: text || undefined,
      attachments: attachment ? [attachment] : undefined,
      status: "streaming",
      createdAt: new Date().toISOString(),
    });
  }

  private upsertTool(value: Record<string, unknown>, partial: boolean): void {
    const session = this.active;
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (!session || !toolCallId) {
      return;
    }
    let entry = session.entries.find(
      (candidate) => candidate.kind === "tool" && candidate.toolCallId === toolCallId,
    );
    if (!entry) {
      this.completeStreamingContent(session);
      entry = {
        id: randomUUID(),
        kind: "tool",
        turnId: this.activeTurnId,
        toolCallId,
        title: typeof value.title === "string" ? value.title : "Tool call",
        status: typeof value.status === "string" ? value.status : "pending",
        createdAt: new Date().toISOString(),
      };
      session.entries.push(entry);
    }
    const assign = <K extends keyof TranscriptEntry>(key: K, next: TranscriptEntry[K]): void => {
      if (!partial || next !== undefined) {
        entry![key] = next;
      }
    };
    assign("title", typeof value.title === "string" ? value.title : undefined);
    assign("status", typeof value.status === "string" ? value.status : undefined);
    assign("toolKind", typeof value.kind === "string" ? value.kind : undefined);
    assign("content", Array.isArray(value.content) ? value.content : undefined);
    assign("locations", Array.isArray(value.locations) ? value.locations : undefined);
    assign("rawInput", value.rawInput);
    assign("rawOutput", value.rawOutput);
  }

  private completeStreamingContent(
    session: SessionRecord,
    status = "completed",
  ): void {
    for (const entry of session.entries) {
      if (
        entry.status === "streaming" &&
        (entry.kind === "user" || entry.kind === "assistant" || entry.kind === "thought")
      ) {
        entry.status = status;
      }
    }
  }

  private touch(session: SessionRecord): void {
    session.updatedAt = new Date().toISOString();
    if (session.entries.length > MAX_ENTRIES) {
      session.entries.splice(0, session.entries.length - MAX_ENTRIES);
    }
    this.persist();
  }

  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      const sessions = [...this.sessions.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_SESSIONS);
      void this.context.workspaceState.update(STORAGE_KEY, {
        version: 1,
        activeLocalId: this.activeLocalId,
        sessions,
      } satisfies StoredSessions);
    }, 120);
  }
}

function titleFromPrompt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 52 ? compact : `${compact.slice(0, 49)}…`;
}

function contentText(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  if (value.type === "text" && typeof value.text === "string") {
    return value.text;
  }
  if (value.type === "resource_link" && typeof value.name === "string") {
    return `[${value.name}]`;
  }
  return "";
}

function contentAttachment(value: unknown): TranscriptAttachment | undefined {
  if (!isRecord(value) || value.type !== "image") {
    return undefined;
  }
  const mimeType = typeof value.mimeType === "string" ? value.mimeType : "image";
  const uri = typeof value.uri === "string" ? value.uri : "";
  const rawName = uri.split(/[\\/]/).at(-1);
  let name = "Image";
  if (rawName) {
    try {
      name = decodeURIComponent(rawName);
    } catch {
      name = rawName;
    }
  }
  return { type: "image", name, mimeType };
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    isRecord(value) &&
    typeof value.localId === "string" &&
    typeof value.agentId === "string" &&
    typeof value.agentName === "string" &&
    typeof value.cwd === "string" &&
    typeof value.title === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.entries) &&
    Array.isArray(value.configOptions) &&
    (value.worktree === undefined || isSessionWorktree(value.worktree))
  );
}

function isSessionWorktree(value: unknown): value is SessionWorktree {
  return (
    isRecord(value) &&
    typeof value.projectRoot === "string" &&
    typeof value.worktreeRoot === "string" &&
    typeof value.name === "string" &&
    typeof value.managed === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
