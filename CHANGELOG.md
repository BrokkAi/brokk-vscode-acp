# Changelog

## Unreleased

- Add Git worktree-aware sessions with creation, registered-worktree reuse,
  exact checkout persistence and recovery, and guarded cleanup.
- Keep streaming activity on only the current transcript segment so tool and
  thought interleaving cannot leave duplicate blinking cursors behind.
- Default Git sessions to isolated worktrees and automatically open the
  selected checkout in a matching VS Code window.

## 0.3.8 - 2026-07-27

First public release candidate.

- Bundle Anvil and the Rust ACP host in five platform-specific VSIX packages.
- Support official-registry and custom stdio ACP agents.
- Provide durable sessions, structured transcripts, plans, permissions,
  cancellation, session configuration, and slash-command autocomplete.
- Render Markdown emphasis and inline code in assistant messages.
- Keep the composer visible while long transcripts scroll independently.
- Include complete corresponding source and third-party license reports in
  every package.
