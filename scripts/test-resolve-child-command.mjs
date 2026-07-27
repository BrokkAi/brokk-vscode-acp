import assert from "node:assert/strict";

import { resolveChildCommand } from "./resolve-child-command.mjs";

const windows = {
  platform: "win32",
  npmExecPath: String.raw`C:\node\node_modules\npm\bin\npm-cli.js`,
  nodePath: String.raw`C:\node\node.exe`,
};

assert.deepEqual(resolveChildCommand("npm", ["run", "check"], windows), {
  command: windows.nodePath,
  args: [windows.npmExecPath, "run", "check"],
});
assert.deepEqual(resolveChildCommand("npx", ["--no-install", "vsce"], windows), {
  command: windows.nodePath,
  args: [String.raw`C:\node\node_modules\npm\bin\npx-cli.js`, "--no-install", "vsce"],
});
assert.deepEqual(resolveChildCommand("cargo", ["build"], windows), {
  command: "cargo",
  args: ["build"],
});
assert.deepEqual(
  resolveChildCommand("npx", ["vsce"], {
    platform: "linux",
    npmExecPath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
    nodePath: "/usr/bin/node",
  }),
  {
    command: "npx",
    args: ["vsce"],
  },
);
assert.throws(
  () =>
    resolveChildCommand("npm", ["run", "package"], {
      platform: "win32",
      npmExecPath: "",
      nodePath: windows.nodePath,
    }),
  /npm_execpath is unavailable/,
);

console.log("Packaging child-command tests passed");
