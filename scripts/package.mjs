import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import extract from "extract-zip";

import { resolveChildCommand } from "./resolve-child-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const anvilVersion = "0.24.0";
const targets = {
  "darwin-arm64": {
    rust: "aarch64-apple-darwin",
    asset: `brokk-anvil-v${anvilVersion}-universal-apple-darwin.zip`,
    sha256: "3d1e227df0c3e733eda70f58fd69ac2f4db0e44ab58d9c02c0ceb9c81a5883da",
  },
  "darwin-x64": {
    rust: "x86_64-apple-darwin",
    asset: `brokk-anvil-v${anvilVersion}-universal-apple-darwin.zip`,
    sha256: "3d1e227df0c3e733eda70f58fd69ac2f4db0e44ab58d9c02c0ceb9c81a5883da",
  },
  "linux-arm64": {
    rust: "aarch64-unknown-linux-gnu",
    asset: `brokk-anvil-v${anvilVersion}-aarch64-unknown-linux-gnu.zip`,
    sha256: "215d4c94fea2edb9787c7d6294e9568566bdd45931eeaf39c9b36de8118f33d0",
  },
  "linux-x64": {
    rust: "x86_64-unknown-linux-gnu",
    asset: `brokk-anvil-v${anvilVersion}-x86_64-unknown-linux-gnu.zip`,
    sha256: "12c91311fc6d9c3c9ee581f30ce310658b2edae7c84a232fc7d31204eb2fa1f3",
  },
  "win32-x64": {
    rust: "x86_64-pc-windows-msvc",
    asset: `brokk-anvil-v${anvilVersion}-x86_64-pc-windows-msvc.zip`,
    sha256: "bdc01561148cee83e8aef972176ab8ed06768f7b2688505855dae0ddbfb09a78",
  },
};

const target = argument("--target") || inferredTarget();
const config = targets[target];
if (!config) {
  fail(`Unsupported VS Code target "${target}". Expected one of: ${Object.keys(targets).join(", ")}`);
}

run("npm", ["run", "compile:extension"]);
if (!process.env.BROKK_ACP_HOST_BINARY) {
  run("cargo", [
    "build",
    "--release",
    "--locked",
    "--package",
    "brokk-acp-host",
    "--target",
    config.rust,
  ]);
}

const runtimeDir = path.join(root, "bin", target);
fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

const hostName = target.startsWith("win32") ? "brokk-acp-host.exe" : "brokk-acp-host";
const hostBinary =
  process.env.BROKK_ACP_HOST_BINARY ||
  path.join(root, "target", config.rust, "release", hostName);
copyExecutable(hostBinary, path.join(runtimeDir, hostName));

const anvilName = target.startsWith("win32") ? "anvil.exe" : "anvil";
const suppliedAnvil = process.env.ANVIL_BINARY;
let anvilRoot;
if (suppliedAnvil) {
  copyExecutable(suppliedAnvil, path.join(runtimeDir, anvilName));
  anvilRoot = process.env.ANVIL_SOURCE_DIR || path.resolve(root, "..", "anvil");
} else {
  const extracted = await downloadAndExtractAnvil(config);
  const anvilBinary = findFile(extracted, anvilName);
  if (!anvilBinary) {
    fail(`${anvilName} was not present in ${config.asset}`);
  }
  copyExecutable(anvilBinary, path.join(runtimeDir, anvilName));
  anvilRoot = path.dirname(anvilBinary);
}
copyAnvilNotices(anvilRoot);
copyHostNotices();

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outputDirectory = path.join(root, "artifacts");
fs.mkdirSync(outputDirectory, { recursive: true });
const output =
  argument("--out") ||
  path.join(outputDirectory, `${packageJson.name}-${packageJson.version}-${target}.vsix`);
const sourceDirectory = prepareSourceBundle();
try {
  run("npx", [
    "--no-install",
    "vsce",
    "package",
    "--target",
    target,
    "--allow-missing-repository",
    "--out",
    output,
  ]);
  await verifyPackage(output, target, hostName, anvilName);
  console.log(output);
} finally {
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
}

async function downloadAndExtractAnvil(config) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "brokk-acp-anvil-"));
  const archive = process.env.ANVIL_ARCHIVE || path.join(temporary, config.asset);
  if (!process.env.ANVIL_ARCHIVE) {
    const url = `https://github.com/BrokkAi/anvil/releases/download/v${anvilVersion}/${config.asset}`;
    const response = await fetch(url);
    if (!response.ok) {
      fail(`Could not download Anvil: ${response.status} ${response.statusText}`);
    }
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (digest !== config.sha256) {
    fail(`Anvil checksum mismatch for ${config.asset}: expected ${config.sha256}, got ${digest}`);
  }
  const extracted = path.join(temporary, "extracted");
  fs.mkdirSync(extracted);
  await extract(archive, { dir: extracted });
  return extracted;
}

function copyAnvilNotices(sourceRoot) {
  const output = path.join(root, "licenses", "anvil");
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const license = findUpwardFile(sourceRoot, "LICENSE");
  if (!license) {
    fail(`Anvil LICENSE was not found from ${sourceRoot}`);
  }
  fs.copyFileSync(license, path.join(output, "LICENSE"));
  const sourceBase = path.dirname(license);
  for (const notice of [
    "SOURCE.md",
    "GPL-3.0.md",
    "THIRD_PARTY_LICENSES.html",
    "SUPPLEMENTAL_THIRD_PARTY_NOTICES.txt",
  ]) {
    const source = [path.join(sourceBase, notice), path.join(sourceBase, "licenses", notice)].find(
      (candidate) => fs.existsSync(candidate),
    );
    if (!source) {
      fail(`Anvil notice ${notice} was not found from ${sourceBase}`);
    }
    fs.copyFileSync(source, path.join(output, notice));
  }
  const readme = path.join(sourceBase, "README.md");
  if (fs.existsSync(readme)) {
    fs.copyFileSync(readme, path.join(output, "README.md"));
  }
}

function copyHostNotices() {
  const source = path.join(root, "legal", "host", "THIRD_PARTY_LICENSES.html");
  if (!fs.existsSync(source)) {
    fail("Rust host notice report is missing; run npm run license:generate");
  }
  const output = path.join(root, "licenses", "host");
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(source, path.join(output, "THIRD_PARTY_LICENSES.html"));
}

function prepareSourceBundle() {
  const output = path.join(root, "source");
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  for (const entry of [
    ".github",
    "crates",
    "docs",
    "legal",
    "scripts",
    "src",
    "Cargo.lock",
    "Cargo.toml",
    "CHANGELOG.md",
    "icon.png",
    "LICENSE",
    "package-lock.json",
    "package.json",
    "README.md",
    "SECURITY.md",
    "SOURCE.md",
    "SUPPORT.md",
    "THIRD_PARTY_NOTICES.md",
    "tsconfig.json",
  ]) {
    const source = path.join(root, entry);
    if (!fs.existsSync(source)) fail(`Corresponding-source input is missing: ${entry}`);
    fs.cpSync(source, path.join(output, entry), { recursive: true });
  }
  return output;
}

async function verifyPackage(archive, target, hostName, anvilName) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "brokk-acp-vsix-"));
  try {
    await extract(archive, { dir: temporary });
    for (const required of [
      "extension/package.json",
      "extension/changelog.md",
      "extension/LICENSE.txt",
      "extension/SECURITY.md",
      "extension/SOURCE.md",
      "extension/SUPPORT.md",
      "extension/THIRD_PARTY_NOTICES.md",
      "extension/docs/screenshots/active-session.png",
      "extension/docs/screenshots/new-session.png",
      "extension/legal/host/THIRD_PARTY_LICENSES.html",
      `extension/bin/${target}/${hostName}`,
      `extension/bin/${target}/${anvilName}`,
      "extension/licenses/anvil/LICENSE",
      "extension/licenses/anvil/SOURCE.md",
      "extension/licenses/anvil/THIRD_PARTY_LICENSES.html",
      "extension/licenses/host/THIRD_PARTY_LICENSES.html",
      "extension/source/Cargo.lock",
      "extension/source/docs/screenshots/active-session.png",
      "extension/source/docs/screenshots/new-session.png",
      "extension/source/icon.png",
      "extension/source/package-lock.json",
      "extension/source/crates/acp-host/src/main.rs",
      "extension/source/src/extension.ts",
      "extension/source/scripts/package.mjs",
    ]) {
      if (!fs.existsSync(path.join(temporary, required))) {
        fail(`Packaged VSIX is missing ${required}`);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function findUpwardFile(start, name) {
  let current = path.resolve(start);
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(current, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function findFile(directory, name) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = findFile(candidate, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function copyExecutable(source, destination) {
  if (!fs.existsSync(source)) fail(`Required executable does not exist: ${source}`);
  fs.copyFileSync(source, destination);
  if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
}

function run(command, args) {
  const invocation = resolveChildCommand(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 1}`);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function inferredTarget() {
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "win32"
          : "";
  return platform && architecture ? `${platform}-${architecture}` : "";
}

function fail(message) {
  throw new Error(message);
}
