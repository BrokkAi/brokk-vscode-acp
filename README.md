# Brokk ACP for VS Code

Brokk ACP is an open Agent Client Protocol client for Visual Studio Code. It
ships with Anvil as the zero-configuration default, discovers agents from the
official ACP Registry, and accepts arbitrary custom stdio ACP servers.

## What works

- Bundled Anvil in platform-specific VSIX packages.
- Live discovery from the
  [official ACP Registry](https://agentclientprotocol.com/get-started/registry),
  with an offline cache.
- Registry binary installs with platform selection, SHA-256 verification, and
  traversal-safe extraction.
- Registry `npx` and `uvx` agents when the corresponding runner is on `PATH`.
- Any custom stdio ACP agent configured with a command, arguments, and
  environment.
- ACP v1 initialization, agent, terminal, and environment-variable
  authentication.
- Durable workspace session history backed by ACP `session/list`,
  `session/new`, `session/load`, `session/resume`, and `session/delete`.
- Structured streaming transcripts for messages, thoughts, plans, tool calls,
  permissions, usage, cancellation, and dynamic session configuration.
- Permission requests, workspace-scoped text file access, and client-owned
  terminal execution.
- Session metadata and transcripts persist across VS Code reloads; reopening an
  ACP session replays the authoritative history from the agent.

The registry lists **agents** (ACP servers). Brokk ACP is the client that
installs and launches them.

## Architecture

```text
VS Code extension host (thin TypeScript adapter)
  └─ newline-delimited JSON commands/events
       └─ brokk-acp-host (Rust)
            ├─ ACP registry + verified installer
            ├─ permissions, filesystem, and terminals
            └─ ACP v1 JSON-RPC over stdio
                 └─ bundled Anvil, registry agent, or custom agent
```

Rust owns the ACP state machine, agent processes, registry, installs,
permissions, filesystem boundary, and terminal lifecycle. TypeScript owns the
VS Code APIs, webview, integrated authentication terminal, and process relay.
Environment credentials are collected with VS Code's password UI and retained
only in VS Code Secret Storage.
The sidecar boundary keeps an ACP failure out of the extension host and leaves
the Rust client reusable by other BrokkAI frontends.

## Use

1. Install the VSIX for the machine running the VS Code extension host.
2. Open a folder or workspace.
3. Open **Brokk ACP** in the Activity Bar.
4. Choose bundled **Anvil**, a registry agent, or a custom agent.
5. Start a new session or reopen one from the session drawer.
6. Prompt the agent; tool activity, plans, permissions, and output stay grouped
   into the same turn.

Binary registry agents are downloaded into VS Code's extension global-storage
directory. Package agents use their version-pinned registry command through
`npx --yes` or `uvx`; install Node.js or
[uv](https://docs.astral.sh/uv/) when a selected agent requires one of those
runners.

## Custom ACP agents

Add agents to user or workspace settings:

```json
{
  "brokkAcp.customAgents": {
    "my-agent": {
      "name": "My ACP Agent",
      "command": "/absolute/path/to/my-agent",
      "args": ["--acp"],
      "env": {
        "MY_AGENT_PROFILE": "work"
      }
    }
  }
}
```

The older `brokkAcp.agent.command` and `brokkAcp.agent.args` settings remain
readable for compatibility but are deprecated.

## Security boundary

ACP agents are coding agents and may request file edits or commands. The
extension:

- asks the user using the exact permission choices supplied by the agent;
- advertises file access only for the open workspace;
- resolves existing paths and write ancestors before allowing access;
- runs client-owned terminal commands inside the workspace;
- caps retained terminal output; and
- verifies registry checksums before installing binary distributions.

Only use custom registry URLs and custom agent commands that you trust.

## Development

Requirements: Rust, Node.js 20 or newer, and a local Anvil checkout next to this
repository for the default development agent.

```bash
npm install
npm run check
npm run compile
```

Open this directory in VS Code and run the `Run Extension` launch
configuration. Development mode looks for Anvil at
`../anvil/target/{debug,release}/anvil`; `brokkAcp.anvil.path` overrides it.

Validation commands:

```bash
cargo test --workspace --locked
npm run check
npm run test:lifecycle
npm run compile
```

## Packaging

Platform packages keep native binaries small and ensure that Anvil matches the
extension host:

```bash
npm run package -- --target darwin-arm64
```

Supported targets are `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64`, and `win32-x64`. The packaging script pins Anvil 0.24.0, verifies
the release archive digest, bundles the matching Rust host, and includes
Anvil's LGPL license and source notices. The package workflow builds all five
VSIX files on tags.

## Next protocol surfaces

Follow-up milestones are side-by-side simultaneous agents, session forking,
image/resource attachments, ACP elicitation forms, clickable diff navigation,
and deeper workspace-aware context controls.

## License

Brokk ACP is licensed under the GNU General Public License, version 3 only.
See [LICENSE](LICENSE). Bundled and installed agents retain their own licenses;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
