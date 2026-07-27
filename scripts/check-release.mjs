import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const cargoManifest = fs.readFileSync(path.join(root, "crates", "acp-host", "Cargo.toml"), "utf8");
const cargoLock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
const packageScript = fs.readFileSync(path.join(root, "scripts", "package.mjs"), "utf8");
const notices = fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const hostNotices = fs.readFileSync(
  path.join(root, "legal", "host", "THIRD_PARTY_LICENSES.html"),
  "utf8",
);

const extensionVersion = packageJson.version;
assert.match(extensionVersion, /^\d+\.\d+\.\d+$/, "extension version must be stable SemVer");
assert.equal(packageLock.version, extensionVersion, "package-lock top-level version is stale");
assert.equal(packageLock.packages?.[""]?.version, extensionVersion, "package-lock root version is stale");

const cargoVersion = match(cargoManifest, /^\[package\][\s\S]*?^version = "([^"]+)"/m, "Cargo version");
assert.equal(cargoVersion, extensionVersion, "Rust host and extension versions differ");
assert.match(
  cargoLock,
  new RegExp(`name = "brokk-acp-host"\\nversion = "${escapeRegex(extensionVersion)}"`),
  "Cargo.lock host version is stale",
);
assert.ok(
  changelog.includes(`## ${extensionVersion} - `),
  `CHANGELOG.md has no ${extensionVersion} release`,
);
assert.ok(
  hostNotices.includes(`brokk-acp-host ${extensionVersion}</a>`),
  "Rust host notice report has the wrong version",
);

const anvilVersion = match(packageScript, /const anvilVersion = "([^"]+)"/, "Anvil package version");
assert.ok(
  notices.includes(`/anvil/tree/v${anvilVersion}`),
  "Anvil source notice does not match the package pin",
);

for (const required of [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SOURCE.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "legal/host/THIRD_PARTY_LICENSES.html",
]) {
  assert.ok(fs.existsSync(path.join(root, required)), `required release file is missing: ${required}`);
}

const tag = option("--tag") || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "");
if (tag) {
  assert.equal(tag, `v${extensionVersion}`, `release tag must be v${extensionVersion}`);
}

console.log(
  `Release metadata is consistent: Brokk ACP ${extensionVersion}, Anvil ${anvilVersion}` +
    (tag ? `, tag ${tag}` : ""),
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function match(text, pattern, label) {
  const result = text.match(pattern);
  assert.ok(result, `could not read ${label}`);
  return result[1];
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
