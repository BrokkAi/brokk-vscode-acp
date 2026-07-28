import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webviewHtml } from "../src/webview";

interface Harness {
  window: Window;
  document: Document;
  posted: Array<Record<string, unknown>>;
  sendState(state: Record<string, unknown>): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const html = webviewHtml({ cspSource: "vscode-webview://test" } as never);
  const script = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)?.[1];
  if (!script) throw new Error("missing webview client script");

  const window = new Window({ url: "https://webview.test/" });
  const posted: Array<Record<string, unknown>> = [];
  Object.assign(window, {
    acquireVsCodeApi: () => ({
      postMessage(message: Record<string, unknown>) {
        posted.push(message);
      },
    }),
  });
  window.document.write(html.replace(/<script nonce="[^"]+">[\s\S]+<\/script>/, ""));
  window.eval(script);
  await window.happyDOM.waitUntilComplete();

  return {
    window,
    document: window.document,
    posted,
    async sendState(state) {
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "app_state", state },
        }),
      );
      await window.happyDOM.waitUntilComplete();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    agents: [
      {
        id: "bundled:anvil",
        name: "Anvil",
        description: "Bundled agent",
        source: "bundled",
        ready: true,
        installable: false,
      },
      {
        id: "registry:codex",
        name: "Codex",
        version: "1.2.3",
        description: "Registry agent",
        source: "registry",
        ready: false,
        installable: true,
        requirement: "npm",
      },
    ],
    selectedAgent: "bundled:anvil",
    connection: { phase: "idle" },
    sessions: [],
    ...overrides,
  };
}

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    localId: "local-1",
    remoteId: "remote-1",
    title: "Test session",
    agentId: "bundled:anvil",
    agentName: "Anvil",
    status: "ready",
    entries: [],
    configOptions: [],
    ...overrides,
  };
}

describe("webview client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("boots, renders the agent picker, and posts start actions", async () => {
    const harness = await createHarness();
    expect(harness.posted).toContainEqual({ type: "ready" });

    await harness.sendState(baseState());
    const agent = harness.document.querySelector<HTMLSelectElement>("#agent")!;
    expect([...agent.options].map((option) => option.textContent)).toEqual([
      "Anvil",
      "Codex 1.2.3 — install",
    ]);
    expect(harness.document.querySelector("#agent-description")?.textContent).toBe(
      "Bundled agent",
    );

    harness.document.querySelector<HTMLButtonElement>("#start-button")!.click();
    expect(harness.posted.at(-1)).toEqual({
      type: "new_session",
      agent_id: "bundled:anvil",
    });

    agent.value = "registry:codex";
    agent.dispatchEvent(new harness.window.Event("change"));
    expect(harness.document.querySelector("#install-row")?.classList.contains("hidden")).toBe(
      false,
    );
    expect(harness.document.querySelector<HTMLButtonElement>("#start-button")!.disabled).toBe(
      true,
    );
    harness.document.querySelector<HTMLButtonElement>("#install-button")!.click();
    expect(harness.posted.at(-1)).toEqual({
      type: "install",
      agent_id: "registry:codex",
    });
  });

  it("summarizes session options and edits them behind Change", async () => {
    const harness = await createHarness();
    await harness.sendState(
      baseState({
        active: activeSession({
          configOptions: [
            {
              id: "mode",
              name: "Mode",
              type: "select",
              currentValue: "agent",
              options: [
                {
                  name: "Modes",
                  options: [
                    { value: "agent", name: "Agent" },
                    { value: "plan", name: "Plan" },
                  ],
                },
              ],
            },
            {
              id: "thinking",
              name: "Thinking",
              type: "boolean",
              currentValue: true,
            },
          ],
        }),
        connection: { phase: "connected", agentId: "bundled:anvil" },
      }),
    );

    expect(harness.document.querySelector("#config-summary")?.textContent).toBe("Agent · On");
    const change = harness.document.querySelector<HTMLButtonElement>("#config-button")!;
    expect(change.getAttribute("aria-expanded")).toBe("false");
    change.click();
    expect(change.textContent).toBe("Done");
    expect(change.getAttribute("aria-expanded")).toBe("true");
    expect(harness.document.querySelector("#config-panel")?.classList.contains("hidden")).toBe(
      false,
    );

    const select = harness.document.querySelector<HTMLSelectElement>(
      '#config-editor select[aria-label="Mode"]',
    )!;
    select.value = "plan";
    select.dispatchEvent(new harness.window.Event("change"));
    expect(harness.posted.at(-1)).toEqual({
      type: "set_config",
      config_id: "mode",
      value: { value: "plan" },
    });

    const checkbox =
      harness.document.querySelector<HTMLInputElement>('#config-editor input[type="checkbox"]')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new harness.window.Event("change"));
    expect(checkbox.nextElementSibling?.textContent).toBe("Off");
    expect(harness.posted.at(-1)).toEqual({
      type: "set_config",
      config_id: "thinking",
      value: { type: "boolean", value: false },
    });

    harness.window.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "Escape" }),
    );
    expect(change.textContent).toBe("Change");
    expect(change.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders transcript activity, plans, permissions, and composer actions", async () => {
    const harness = await createHarness();
    await harness.sendState(
      baseState({
        active: activeSession({
          status: "running",
          currentPlan: [
            { content: "Inspect", priority: "high", status: "completed" },
            { content: "Implement", priority: "medium", status: "in_progress" },
          ],
          entries: [
            { id: "u", kind: "user", text: "Build it", createdAt: "2026-07-28T00:00:00Z" },
            {
              id: "a",
              kind: "assistant",
              text: "**Done** with `code`",
              status: "completed",
              createdAt: "2026-07-28T00:00:01Z",
            },
            {
              id: "t",
              kind: "thought",
              text: "Thinking",
              createdAt: "2026-07-28T00:00:02Z",
            },
            {
              id: "tool",
              kind: "tool",
              title: "Read README",
              toolKind: "read",
              status: "completed",
              rawOutput: { text: "output" },
              createdAt: "2026-07-28T00:00:03Z",
            },
            {
              id: "permission",
              kind: "permission",
              requestId: "request-1",
              title: "Run tests",
              options: [
                { optionId: "allow", name: "Allow" },
                { optionId: "deny", name: "Deny" },
              ],
              createdAt: "2026-07-28T00:00:04Z",
            },
            {
              id: "error",
              kind: "error",
              text: "Something failed",
              createdAt: "2026-07-28T00:00:05Z",
            },
          ],
          usage: { used: 25, size: 100 },
        }),
        connection: { phase: "connected", detail: "Working" },
      }),
    );

    expect(harness.document.querySelector("#plan-dock")?.textContent).toContain("Implement");
    expect(harness.document.querySelector("#transcript-inner strong")?.textContent).toBe("Done");
    expect(harness.document.querySelector("#transcript-inner code")?.textContent).toBe("code");
    expect(harness.document.querySelector("#composer-hint")?.textContent).toBe("25% context");

    const permission = [...harness.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Allow",
    )!;
    permission.click();
    expect(harness.posted.at(-1)).toEqual({
      type: "permission_response",
      request_id: "request-1",
      option_id: "allow",
    });

    harness.document.querySelector<HTMLButtonElement>("#stop-button")!.click();
    expect(harness.posted.at(-1)).toEqual({ type: "cancel" });
  });

  it("offers advertised slash commands and submits prompts", async () => {
    const harness = await createHarness();
    await harness.sendState(
      baseState({
        active: activeSession({
          availableCommands: [
            { name: "review", description: "Review changes", input: { hint: "scope" } },
            { name: "setup", description: "Configure the agent" },
          ],
        }),
      }),
    );
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt")!;
    prompt.value = "/re";
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    prompt.dispatchEvent(new harness.window.Event("input"));
    expect(harness.document.querySelector("#slash-menu")?.textContent).toContain("/review");

    prompt.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(prompt.value).toBe("/review ");

    prompt.value = "  Run the review  ";
    prompt.dispatchEvent(new harness.window.Event("input"));
    harness.document.querySelector<HTMLButtonElement>("#send-button")!.click();
    expect(harness.posted.at(-1)).toEqual({ type: "prompt", text: "Run the review" });
    expect(prompt.value).toBe("");
  });

  it("renders authentication, banners, session drawers, and connection progress", async () => {
    const harness = await createHarness();
    await harness.sendState(
      baseState({
        banner: "Attention",
        auth: {
          message: "Sign in",
          methods: [{ id: "env", name: "Token" }],
        },
        connection: { phase: "connecting", detail: "Launching…" },
        active: activeSession({ status: "connecting" }),
        sessions: [
          {
            localId: "saved",
            remoteId: "remote",
            agentId: "bundled:anvil",
            agentName: "Anvil",
            title: "Saved session",
            updatedAt: new Date().toISOString(),
            status: "disconnected",
            hasTranscript: true,
          },
        ],
      }),
    );

    expect(harness.document.querySelector("#banner")?.textContent).toBe("Attention");
    expect(harness.document.querySelector("#auth-card")?.textContent).toContain("Sign in");
    expect(harness.document.querySelector("#transcript-inner")?.textContent).toContain(
      "Launching…",
    );

    harness.document.querySelector<HTMLButtonElement>("#sessions-button")!.click();
    expect(harness.document.querySelector("#drawer")?.classList.contains("hidden")).toBe(false);
    expect(harness.document.querySelector("#session-list")?.textContent).toContain("Saved session");

    const saved = harness.document.querySelector<HTMLElement>(".session-row")!;
    saved.click();
    expect(harness.posted.at(-1)).toEqual({ type: "open_session", local_id: "saved" });

    const authButton = [...harness.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Token",
    )!;
    authButton.click();
    expect(harness.posted.at(-1)).toEqual({ type: "authenticate", method_id: "env" });
  });
});
