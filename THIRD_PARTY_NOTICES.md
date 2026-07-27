# Third-party notices

Brokk ACP's native Rust host statically incorporates open-source dependencies.
Their package inventory, license selections, and license texts are included at
`licenses/host/THIRD_PARTY_LICENSES.html` in every platform package. The report
is generated from the locked dependency graph for all supported targets.

Brokk ACP also bundles **Anvil**, Copyright BrokkAi, as a separate executable
communicating over the Agent Client Protocol. Anvil is licensed under
LGPL-3.0-only. Its LGPL and GPL texts, corresponding-source instructions, and
dependency notices are included under `licenses/anvil/` in each platform
package.

Anvil source: https://github.com/BrokkAi/anvil/tree/v0.24.0

Agents installed from the ACP Registry are separate programs and remain subject
to the license shown for each registry entry.
