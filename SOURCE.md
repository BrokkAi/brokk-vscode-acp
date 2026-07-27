# Corresponding source

Brokk ACP is licensed under `GPL-3.0-only`. Every platform-specific VSIX
contains the complete corresponding source used to build that package under
`source/`, including:

- the TypeScript extension and webview sources;
- the Rust ACP host sources;
- locked Node.js and Rust dependency manifests;
- the packaging, test, and license-report scripts; and
- the workflow definitions used for validation and release.

A VSIX is a ZIP-compatible archive. After downloading it, extract it with a ZIP
tool and open `extension/source/`.

The development repository is:

https://github.com/BrokkAi/brokk-vscode-acp

When the repository is publicly accessible, release tags named `vX.Y.Z`
identify the same source revision as Marketplace version `X.Y.Z`. The source
included in the VSIX remains the authoritative corresponding source even when
repository access is unavailable.

The separately bundled Anvil executable has its own corresponding-source
instructions under `licenses/anvil/SOURCE.md` in every VSIX. Repository readers
can use the versioned
[Anvil 0.24.0 source and notices](https://github.com/BrokkAi/anvil/tree/v0.24.0).
