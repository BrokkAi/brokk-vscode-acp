import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const threshold = 80;
const reportPath = path.resolve(process.argv[2] ?? "coverage-rust.lcov");
const sourceRoot = path.resolve("crates/acp-host/src");

function rustSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return rustSources(candidate);
    return entry.isFile() && entry.name.endsWith(".rs") ? [candidate] : [];
  });
}

function productionBoundary(source) {
  const match = /\n#\[cfg\(test\)\]\nmod tests \{/.exec(source);
  if (!match) return Number.POSITIVE_INFINITY;
  return source.slice(0, match.index + 1).split("\n").length;
}

const records = new Map();
for (const record of fs.readFileSync(reportPath, "utf8").split("end_of_record")) {
  const filename = /^SF:(.+)$/m.exec(record)?.[1];
  if (!filename) continue;
  const lines = new Map();
  for (const match of record.matchAll(/^DA:(\d+),(\d+)/gm)) {
    const line = Number(match[1]);
    lines.set(line, (lines.get(line) ?? 0) + Number(match[2]));
  }
  records.set(path.resolve(filename), lines);
}

const results = rustSources(sourceRoot)
  .sort()
  .map((filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const boundary = productionBoundary(source);
    const lines = records.get(path.resolve(filename));
    if (!lines) {
      return { filename, covered: 0, total: 0, percent: 0, missing: true };
    }
    const production = [...lines].filter(([line]) => line < boundary);
    const covered = production.filter(([, count]) => count > 0).length;
    const total = production.length;
    return {
      filename,
      covered,
      total,
      percent: total === 0 ? 100 : (covered / total) * 100,
      missing: false,
    };
  });

console.log("Rust production line coverage (inline test bodies excluded):");
for (const result of results) {
  const relative = path.relative(process.cwd(), result.filename);
  const detail = result.missing
    ? "missing from LCOV report"
    : `${result.percent.toFixed(2)}% (${result.covered}/${result.total})`;
  console.log(`  ${relative}: ${detail}`);
}

const failures = results.filter(
  (result) => result.missing || result.total === 0 || result.percent < threshold,
);
if (failures.length > 0) {
  console.error(`Every Rust source module must have at least ${threshold}% production line coverage.`);
  process.exit(1);
}
