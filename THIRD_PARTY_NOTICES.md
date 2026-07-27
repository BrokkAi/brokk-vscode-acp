# Third-party notices

This notice covers third-party software distributed with Brokk ACP. Brokk ACP's
own license is [GPL-3.0-only](LICENSE).

## Native ACP host

The `brokk-acp-host` executable statically incorporates Rust dependencies. The
repository tracks their complete package inventory, selected licenses, and
license texts in
[legal/host/THIRD_PARTY_LICENSES.html](legal/host/THIRD_PARTY_LICENSES.html).
That report is generated from the locked dependency graph for every supported
VSIX target.

Every platform package includes the same report at
`licenses/host/THIRD_PARTY_LICENSES.html`. Run `npm run license:check` to verify
that the tracked report still matches `Cargo.lock`.

## Bundled Anvil

Brokk ACP bundles **Anvil 0.24.0**, Copyright BrokkAi, as a separate executable
communicating over the Agent Client Protocol. Anvil is licensed under
LGPL-3.0-only.

The repository does not duplicate Anvil's generated dependency report. The
versioned source and notices used by this release are:

- [Anvil 0.24.0 source](https://github.com/BrokkAi/anvil/tree/v0.24.0)
- [LGPL-3.0-only license](https://github.com/BrokkAi/anvil/blob/v0.24.0/LICENSE)
- [corresponding-source instructions](https://github.com/BrokkAi/anvil/blob/v0.24.0/licenses/SOURCE.md)
- [third-party dependency licenses](https://github.com/BrokkAi/anvil/blob/v0.24.0/licenses/THIRD_PARTY_LICENSES.html)
- [supplemental dependency notices](https://github.com/BrokkAi/anvil/blob/v0.24.0/licenses/SUPPLEMENTAL_THIRD_PARTY_NOTICES.txt)
- [GPL-3.0 text](https://github.com/BrokkAi/anvil/blob/v0.24.0/licenses/GPL-3.0.md)

Packaging verifies Anvil's release archive checksum and copies those materials
into every VSIX under `licenses/anvil/`. Packaging fails if any required notice
is missing.

## Registry agents

Agents installed from the ACP Registry are separate programs. They are not part
of the Brokk ACP distribution and remain subject to the license shown for each
registry entry.
