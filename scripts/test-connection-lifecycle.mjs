import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostPath =
  process.env.BROKK_ACP_HOST_BINARY ||
  path.join(root, "target", "debug", process.platform === "win32" ? "brokk-acp-host.exe" : "brokk-acp-host");
const host = spawn(hostPath, [], {
  cwd: root,
  stdio: ["pipe", "pipe", "inherit"],
});

const hangingAgent = "process.stdin.resume();";
const responsiveAgent = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  let result;
  if (message.method === "initialize") {
    result = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        mcpCapabilities: {},
        sessionCapabilities: { list: {}, resume: {} }
      },
      authMethods: [],
      agentInfo: { name: "Lifecycle Test ACP", version: "1.0.0" }
    };
  } else if (message.method === "session/list") {
    result = { sessions: [] };
  } else if (message.method === "session/new") {
    result = { sessionId: "lifecycle-test-session", configOptions: [] };
  } else {
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
`;

const events = [];
let buffer = "";
let stage = "replace_hung";
let completed = false;

const timeout = setTimeout(() => {
  finish(new Error(`connection lifecycle test timed out:\n${JSON.stringify(events, null, 2)}`));
}, 8_000);

host.on("error", finish);
host.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      break;
    }
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const event = JSON.parse(line);
    events.push(event);

    if (event.type === "connecting" && stage === "replace_hung") {
      stage = "replace_with_valid";
      setTimeout(() => {
        connect(responsiveAgent, "new");
      }, 50);
    } else if (
      event.type === "session_started" &&
      event.session_id === "lifecycle-test-session" &&
      stage === "replace_with_valid"
    ) {
      stage = "disconnect_valid";
      send({ type: "disconnect" });
    } else if (
      event.type === "disconnected" &&
      event.reason === "requested" &&
      stage === "disconnect_valid"
    ) {
      stage = "cancel_hung";
      connect(hangingAgent, "browse");
    } else if (event.type === "connecting" && stage === "cancel_hung") {
      stage = "await_cancel";
      setTimeout(() => send({ type: "disconnect" }), 50);
    } else if (
      event.type === "disconnected" &&
      event.reason === "requested" &&
      stage === "await_cancel"
    ) {
      stage = "recover_after_cancel";
      connect(responsiveAgent, "new");
    } else if (
      event.type === "session_started" &&
      event.session_id === "lifecycle-test-session" &&
      stage === "recover_after_cancel"
    ) {
      stage = "finish_disconnect";
      send({ type: "disconnect" });
    } else if (
      event.type === "disconnected" &&
      event.reason === "requested" &&
      stage === "finish_disconnect"
    ) {
      completed = true;
      try {
        const disconnected = events.find(
          (candidate) => candidate.type === "disconnected" && candidate.reason === "replaced",
        );
        const connected = events.find(
          (candidate) =>
            candidate.type === "connected" && candidate.agent === "Lifecycle Test ACP",
        );
        assert.ok(disconnected, "the hung connection should be replaced");
        assert.ok(connected, "the replacement ACP agent should initialize");
        assert.equal(
          events.filter(
            (candidate) =>
              candidate.type === "session_started" &&
              candidate.session_id === "lifecycle-test-session",
          ).length,
          2,
          "a valid ACP session should start after both replacement and cancellation",
        );
        finish();
      } catch (error) {
        finish(error);
      }
    }
  }
});

connect(hangingAgent, "browse");

function connect(agentScript, mode) {
  send({
    type: "connect",
    command: process.execPath,
    args: ["-e", agentScript],
    cwd: root,
    session: { mode },
  });
}

function send(command) {
  host.stdin.write(`${JSON.stringify(command)}\n`);
}

function finish(error) {
  if (completed || error) {
    clearTimeout(timeout);
  }
  if (!host.killed) {
    host.stdin.end();
    host.kill();
  }
  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else if (completed) {
    console.log("connection lifecycle replacement passed");
  }
}
