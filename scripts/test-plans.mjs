import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: [resolve("src/sessionStore.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  plugins: [
    {
      name: "vscode-test-stub",
      setup(context) {
        context.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "vscode-test-stub",
        }));
        context.onLoad({ filter: /.*/, namespace: "vscode-test-stub" }, () => ({
          contents: "export {};",
          loader: "js",
        }));
      },
    },
  ],
});

const source = bundle.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { SessionStore } = await import(moduleUrl);

function contextWith(saved) {
  return {
    workspaceState: {
      get() {
        return saved;
      },
      async update() {},
    },
  };
}

function plan(content, priority, status) {
  return { content, priority, status };
}

const store = new SessionStore(contextWith(undefined));
store.create({ id: "test-agent", name: "Test Agent" }, "/workspace");
store.beginTurn("Build plan support");
store.applySessionUpdate({
  sessionUpdate: "plan",
  entries: [
    plan("Inspect the protocol", "high", "completed"),
    plan("Build the plan dock", "medium", "in_progress"),
    { content: "Invalid status", priority: "low", status: "blocked" },
  ],
});
assert.deepEqual(store.snapshot().active.currentPlan, [
  plan("Inspect the protocol", "high", "completed"),
  plan("Build the plan dock", "medium", "in_progress"),
]);

store.applySessionUpdate({
  sessionUpdate: "plan",
  entries: [plan("Verify replacement", "low", "pending")],
});
assert.deepEqual(
  store.snapshot().active.currentPlan,
  [plan("Verify replacement", "low", "pending")],
  "each ACP plan update must replace the complete prior plan",
);

store.beginTurn("Start another task");
assert.equal(
  store.snapshot().active.currentPlan,
  undefined,
  "a new prompt must not display a stale plan from the previous turn",
);

const storedSession = {
  localId: "saved-local",
  remoteId: "saved-remote",
  agentId: "test-agent",
  agentName: "Test Agent",
  cwd: "/workspace",
  title: "Saved session",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  status: "ready",
  entries: [
    {
      id: "legacy-plan",
      kind: "plan",
      plan: [plan("Restore cached plan", "high", "in_progress")],
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  ],
  configOptions: [],
};
const restored = new SessionStore(contextWith({
  version: 1,
  activeLocalId: storedSession.localId,
  sessions: [storedSession],
}));
assert.deepEqual(
  restored.snapshot().active.currentPlan,
  [plan("Restore cached plan", "high", "in_progress")],
  "the plan dock must migrate plans cached by the inline transcript renderer",
);

restored.startReplay("saved-remote");
assert.equal(restored.snapshot().active.currentPlan, undefined);
restored.disconnected();
assert.deepEqual(
  restored.snapshot().active.currentPlan,
  [plan("Restore cached plan", "high", "in_progress")],
  "failed session replay must restore the cached plan",
);

console.log("ACP plan state tests passed");
