# Brokk ACP for VS Code

A Rust-powered Agent Client Protocol client for Visual Studio Code.

The extension uses a deliberately small TypeScript adapter for VS Code APIs and a native Rust
sidecar for agent process management and the ACP state machine.

## Architecture

```text
VS Code extension host (TypeScript)
  └─ newline-delimited JSON commands/events
       └─ brokk-acp-host (Rust)
            └─ ACP v1 JSON-RPC over stdio
                 └─ Anvil or another ACP agent
```

TypeScript owns only the VS Code lifecycle, commands, settings, and webview. Rust owns the agent
process, ACP negotiation, sessions, prompt streaming, and cancellation. Keeping the native host as
a separate process prevents an ACP or Rust failure from crashing VS Code's extension host and lets
the Rust client be reused by other frontends later.

## Development

Requirements: Rust, Node.js 20 or newer, and an ACP agent such as Anvil on `PATH`.

```bash
npm install
npm run compile
```

Open this directory in VS Code and run the `Run Extension` launch configuration. Open the Brokk
ACP activity-bar view and press **Connect**. The default agent command is `anvil`; change
`brokkAcp.agent.command` and `brokkAcp.agent.args` in settings to use another ACP agent.

## Current milestone

- Launch an arbitrary stdio ACP agent from the Rust host.
- Negotiate ACP v1 and create a session for the current workspace.
- Stream agent message and thought chunks into a VS Code webview.
- Send prompts, cancel the active turn, and disconnect cleanly.

Filesystem, terminal, permission, elicitation, session-history, and configuration-option UI support
are the next protocol surfaces to add.

Host diagnostics are written to the **Brokk ACP** output channel. The Rust host reserves stdout for
its newline-delimited event stream; agent stderr is forwarded to the same output channel.
