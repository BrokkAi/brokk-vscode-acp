import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trackedOutput = path.join(root, "legal", "host", "THIRD_PARTY_LICENSES.html");
const checking = process.argv.includes("--check");
const temporaryDirectory = checking
  ? fs.mkdtempSync(path.join(os.tmpdir(), "brokk-acp-licenses-"))
  : undefined;
const output = checking
  ? path.join(temporaryDirectory, "THIRD_PARTY_LICENSES.html")
  : trackedOutput;

try {
  const version = run("cargo", ["about", "--version"], true).trim();
  assert.match(
    version,
    /^cargo-about 0\.9\.1$/,
    `cargo-about 0.9.1 is required; found ${version || "no version"}`,
  );
  run("cargo", [
    "about",
    "generate",
    "--offline",
    "--config",
    "legal/host/about.toml",
    "--locked",
    "--fail",
    "legal/host/about.hbs",
    "-o",
    output,
  ]);

  const generated = fs.readFileSync(output, "utf8").replace(/[ \t]+$/gm, "");
  fs.writeFileSync(output, generated);
  const packageVersion = readCargoVersion();
  assert.ok(generated.includes("brokk-acp-host"), "notice report omits brokk-acp-host");
  assert.ok(
    generated.includes(`brokk-acp-host ${packageVersion}</a>`),
    "notice report has the wrong host version",
  );

  if (checking) {
    assert.ok(fs.existsSync(trackedOutput), "tracked host notice report is missing");
    assert.equal(
      generated,
      fs.readFileSync(trackedOutput, "utf8"),
      "host notice report is stale; run npm run license:generate",
    );
    console.log("Rust host third-party notices are current");
  } else {
    console.log(`Generated ${path.relative(root, trackedOutput)}`);
  }
} finally {
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readCargoVersion() {
  const manifest = fs.readFileSync(path.join(root, "crates", "acp-host", "Cargo.toml"), "utf8");
  const match = manifest.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m);
  assert.ok(match, "could not read brokk-acp-host version");
  return match[1];
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status ?? 1}`);
  }
  return capture ? result.stdout : "";
}
