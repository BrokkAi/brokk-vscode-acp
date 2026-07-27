import path from "node:path";
import process from "node:process";

export function resolveChildCommand(
  command,
  args,
  {
    platform = process.platform,
    npmExecPath = process.env.npm_execpath,
    nodePath = process.execPath,
  } = {},
) {
  if (platform !== "win32" || (command !== "npm" && command !== "npx")) {
    return { command, args };
  }
  if (!npmExecPath) {
    throw new Error(
      `Cannot run ${command} on Windows because npm_execpath is unavailable; invoke packaging with npm run package`,
    );
  }

  const cli =
    command === "npm"
      ? npmExecPath
      : path.win32.join(path.win32.dirname(npmExecPath), "npx-cli.js");
  return {
    command: nodePath,
    args: [cli, ...args],
  };
}
