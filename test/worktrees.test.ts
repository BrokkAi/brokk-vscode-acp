import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitWorktreeService,
  parseWorktreePorcelain,
  type GitRunner,
  type SessionWorktree,
} from "../src/worktrees";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function repository(): Promise<{ root: string; nested: string }> {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brokk worktrees "));
  temporaryDirectories.push(createdRoot);
  const root = await fs.realpath(createdRoot);
  await git(root, "init", "--initial-branch=master");
  await git(root, "config", "user.name", "Brokk Test");
  await git(root, "config", "user.email", "brokk@example.test");
  const nested = path.join(root, "packages", "agent app");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "test\n");
  await fs.writeFile(path.join(nested, "index.ts"), "export {};\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return { root, nested };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("parseWorktreePorcelain", () => {
  it("parses branch, detached, locked, bare, and prunable records", () => {
    const parsed = parseWorktreePorcelain(
      [
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /repo/linked",
        "HEAD def",
        "detached",
        "locked reason",
        "",
        "worktree /repo/stale",
        "HEAD 000",
        "prunable missing",
        "",
        "worktree /repo/bare",
        "bare",
        "",
      ].join("\0"),
    );

    expect(parsed).toEqual([
      expect.objectContaining({ path: "/repo", branch: "refs/heads/main" }),
      expect.objectContaining({ path: "/repo/linked", detached: true, locked: true }),
      expect.objectContaining({ path: "/repo/stale", prunable: true }),
      expect.objectContaining({ path: "/repo/bare", bare: true }),
    ]);
  });

  it("keeps a final record when porcelain output has no trailing separator", () => {
    expect(parseWorktreePorcelain("worktree /last\0detached")).toEqual([
      expect.objectContaining({ path: "/last", detached: true }),
    ]);
  });
});

describe("GitWorktreeService", () => {
  it("creates named worktrees, preserves a nested cwd, and only removes them cleanly", async () => {
    const { root, nested } = await repository();
    const service = new GitWorktreeService(undefined, () => "Bright Fox");

    expect(await service.list(nested)).toEqual([
      expect.objectContaining({
        path: root,
        name: path.basename(root),
        branch: "master",
        current: true,
        managed: false,
      }),
    ]);

    const created = await service.resolve(nested, { kind: "create" });
    expect(created).toMatchObject({
      created: true,
      cwd: path.join(root, ".brokk", "worktrees", "bright-fox", "packages", "agent app"),
      worktree: { name: "bright-fox", managed: true, projectRoot: root },
    });
    await expect(fs.stat(created.cwd)).resolves.toBeDefined();
    await expect(
      fs.readFile(path.join(root, ".git", "info", "exclude"), "utf8"),
    ).resolves.toContain(".brokk/worktrees/");
    await service.validate(created.cwd, created.worktree);
    await expect(service.isDirty(created.worktree!)).resolves.toBe(false);
    expect(await service.list(nested)).toContainEqual(
      expect.objectContaining({ name: "bright-fox", managed: true, current: false }),
    );

    const second = await service.resolve(nested, { kind: "create" });
    expect(second.worktree?.name).toBe("bright-fox-1");
    const reusedManaged = await service.resolve(nested, {
      kind: "existing",
      path: second.worktree!.worktreeRoot,
    });
    expect(reusedManaged.worktree?.managed).toBe(false);
    await expect(service.remove(reusedManaged.worktree!)).rejects.toThrow(
      "Only worktrees created by Brokk ACP",
    );

    const dirtyFile = path.join(created.worktree!.worktreeRoot, "dirty.txt");
    await fs.writeFile(dirtyFile, "dirty\n");
    await expect(service.isDirty(created.worktree!)).resolves.toBe(true);
    await expect(service.remove(created.worktree!)).rejects.toThrow("uncommitted changes");
    await fs.unlink(dirtyFile);

    await service.remove(created.worktree!);
    await service.remove(second.worktree!);
    await expect(fs.stat(created.worktree!.worktreeRoot)).rejects.toThrow();
    await expect(service.validate(created.cwd, created.worktree)).rejects.toThrow(
      "working directory is unavailable",
    );
  });

  it("reuses only registered worktrees and never removes a reused checkout", async () => {
    const { root, nested } = await repository();
    const existingRoot = path.join(path.dirname(root), `${path.basename(root)} existing`);
    temporaryDirectories.push(existingRoot);
    await git(root, "worktree", "add", "--detach", existingRoot, "HEAD");
    const service = new GitWorktreeService();

    const resolved = await service.resolve(nested, { kind: "existing", path: existingRoot });
    expect(resolved).toEqual({
      cwd: path.join(existingRoot, "packages", "agent app"),
      created: false,
      worktree: {
        projectRoot: root,
        worktreeRoot: existingRoot,
        name: path.basename(existingRoot),
        managed: false,
      },
    });
    await service.validate(resolved.cwd, resolved.worktree);
    await expect(service.remove(resolved.worktree!)).rejects.toThrow(
      "Only worktrees created by Brokk ACP",
    );

    const ordinary = path.join(root, "ordinary");
    await fs.mkdir(ordinary);
    await expect(
      service.resolve(nested, { kind: "existing", path: ordinary }),
    ).rejects.toThrow("not available");
    await expect(
      service.validate(root, {
        ...resolved.worktree!,
        worktreeRoot: existingRoot,
      }),
    ).rejects.toThrow("outside its recorded worktree");
  });

  it("allows the current workspace outside Git but explains unavailable worktree operations", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brokk non git "));
    temporaryDirectories.push(directory);
    const service = new GitWorktreeService();

    await expect(service.resolve(directory, { kind: "workspace" })).resolves.toEqual({
      cwd: directory,
      created: false,
    });
    await expect(service.validate(directory)).resolves.toBeUndefined();
    await expect(service.list(directory)).rejects.toThrow(
      "Git worktrees require a Git repository",
    );
    await expect(service.resolve(directory, { kind: "create" })).rejects.toThrow(
      "Git worktrees require a Git repository",
    );
  });

  it("rejects unsafe roots and preserves the original creation error", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brokk fake git "));
    temporaryDirectories.push(directory);
    const outsideRunner: GitRunner = vi.fn(async (_cwd, args) => {
      if (args[0] === "rev-parse") return path.join(directory, "repo");
      return "";
    });
    await expect(new GitWorktreeService(outsideRunner).list(directory)).rejects.toThrow(
      "outside Git project",
    );

    const root = path.join(directory, "repo");
    await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
    const failingRunner: GitRunner = vi.fn(async (_cwd, args) => {
      if (args.join(" ") === "rev-parse --show-toplevel") return root;
      if (args.join(" ") === "rev-parse --git-path info/exclude") {
        return path.join(root, ".git", "info", "exclude");
      }
      if (args.slice(0, 2).join(" ") === "worktree add") {
        throw new Error("simulated add failure");
      }
      if (args.slice(0, 2).join(" ") === "worktree remove") {
        throw new Error("simulated rollback failure");
      }
      return "";
    });
    await expect(
      new GitWorktreeService(failingRunner, () => "***").resolve(root, { kind: "create" }),
    ).rejects.toThrow("simulated add failure");
  });

  it("rejects forged managed metadata that is missing from Git", async () => {
    const { root } = await repository();
    const worktree: SessionWorktree = {
      projectRoot: root,
      worktreeRoot: path.join(root, ".brokk", "worktrees", "missing"),
      name: "missing",
      managed: true,
    };
    const service = new GitWorktreeService();
    await expect(service.isDirty(worktree)).rejects.toThrow("no longer registered");
  });
});
