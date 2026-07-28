import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANAGED_DIRECTORY = path.join(".brokk", "worktrees");
const EXCLUDE_ENTRY = ".brokk/worktrees/";

const ADJECTIVES = [
  "bold",
  "bright",
  "calm",
  "clear",
  "eager",
  "fresh",
  "keen",
  "lucky",
  "noble",
  "quick",
  "quiet",
  "sharp",
  "swift",
  "vivid",
  "warm",
  "wise",
] as const;

const NOUNS = [
  "badger",
  "cedar",
  "eagle",
  "ember",
  "falcon",
  "forge",
  "fox",
  "grove",
  "hawk",
  "lark",
  "otter",
  "owl",
  "raven",
  "ridge",
  "robin",
  "willow",
] as const;

export interface SessionWorktree {
  projectRoot: string;
  worktreeRoot: string;
  name: string;
  managed: boolean;
}

export interface WorktreeChoice {
  path: string;
  name: string;
  branch?: string;
  managed: boolean;
  current: boolean;
}

export type WorktreeSelection =
  | { kind: "workspace" }
  | { kind: "create" }
  | { kind: "existing"; path: string };

export interface ResolvedWorkspace {
  cwd: string;
  worktree?: SessionWorktree;
  created: boolean;
}

export interface WorktreeService {
  list(cwd: string): Promise<WorktreeChoice[]>;
  resolve(cwd: string, selection: WorktreeSelection): Promise<ResolvedWorkspace>;
  validate(cwd: string, worktree?: SessionWorktree): Promise<void>;
  isDirty(worktree: SessionWorktree): Promise<boolean>;
  remove(worktree: SessionWorktree): Promise<void>;
}

interface PorcelainWorktree {
  path: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

interface ProjectContext {
  projectRoot: string;
  relativeCwd: string;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export class GitWorktreeService implements WorktreeService {
  constructor(
    private readonly runGit: GitRunner = defaultGitRunner,
    private readonly nameFactory: () => string = randomWorktreeName,
  ) {}

  async list(cwd: string): Promise<WorktreeChoice[]> {
    const context = await this.projectContext(cwd);
    const worktrees = await this.registeredWorktrees(context.projectRoot);
    return worktrees
      .filter((worktree) => !worktree.bare && !worktree.prunable)
      .map((worktree) => ({
        path: worktree.path,
        name: path.basename(worktree.path),
        branch: branchName(worktree.branch),
        managed: isInside(managedDirectory(context.projectRoot), worktree.path),
        current: samePath(worktree.path, context.projectRoot),
      }));
  }

  async resolve(cwd: string, selection: WorktreeSelection): Promise<ResolvedWorkspace> {
    if (selection.kind === "workspace") {
      return { cwd: path.resolve(cwd), created: false };
    }
    const context = await this.projectContext(cwd);
    if (selection.kind === "existing") {
      return this.resolveExisting(context, selection.path);
    }
    return this.create(context);
  }

  async validate(cwd: string, worktree?: SessionWorktree): Promise<void> {
    await requireDirectory(cwd, "Session working directory");
    if (!worktree) {
      return;
    }
    const root = path.resolve(worktree.worktreeRoot);
    if (!isInsideOrSame(root, cwd)) {
      throw new Error(`Session directory is outside its recorded worktree: ${cwd}`);
    }
    const registered = await this.registeredWorktrees(worktree.projectRoot);
    if (!registered.some((candidate) => samePath(candidate.path, root) && !candidate.prunable)) {
      throw new Error(`The recorded Git worktree is no longer registered: ${root}`);
    }
  }

  async isDirty(worktree: SessionWorktree): Promise<boolean> {
    await this.requireManagedRegistered(worktree);
    const output = await this.runGit(worktree.worktreeRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    return output.trim().length > 0;
  }

  async remove(worktree: SessionWorktree): Promise<void> {
    await this.requireManagedRegistered(worktree);
    if (await this.isDirty(worktree)) {
      throw new Error(`Worktree ${worktree.name} has uncommitted changes and was not removed.`);
    }
    await this.runGit(worktree.projectRoot, [
      "worktree",
      "remove",
      path.resolve(worktree.worktreeRoot),
    ]);
    await this.runGit(worktree.projectRoot, ["worktree", "prune"]);
  }

  private async projectContext(cwd: string): Promise<ProjectContext> {
    let projectRoot: string;
    try {
      projectRoot = await canonicalPath(
        (await this.runGit(cwd, ["rev-parse", "--show-toplevel"])).trim(),
      );
    } catch (error) {
      throw gitContextError("Git worktrees require a Git repository.", error);
    }
    const resolvedCwd = await canonicalPath(cwd);
    const relativeCwd = path.relative(projectRoot, resolvedCwd);
    if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
      throw new Error(`Workspace ${resolvedCwd} is outside Git project ${projectRoot}.`);
    }
    return { projectRoot, relativeCwd };
  }

  private async registeredWorktrees(projectRoot: string): Promise<PorcelainWorktree[]> {
    const output = await this.runGit(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
    return parseWorktreePorcelain(output);
  }

  private async resolveExisting(
    context: ProjectContext,
    requestedPath: string,
  ): Promise<ResolvedWorkspace> {
    await requireDirectory(requestedPath, "Git worktree");
    const root = await canonicalPath(requestedPath);
    const registered = await this.registeredWorktrees(context.projectRoot);
    const worktree = registered.find(
      (candidate) => samePath(candidate.path, root) && !candidate.bare && !candidate.prunable,
    );
    if (!worktree) {
      throw new Error(`Choose a registered Git worktree. ${root} is not available.`);
    }
    const sessionCwd = path.join(root, context.relativeCwd);
    await fs.mkdir(sessionCwd, { recursive: true });
    return {
      cwd: sessionCwd,
      worktree: {
        projectRoot: context.projectRoot,
        worktreeRoot: root,
        name: path.basename(root),
        // Existing worktrees are user-owned even when they happen to live in
        // Brokk's directory. Only this call's freshly-created checkout is removable.
        managed: false,
      },
      created: false,
    };
  }

  private async create(context: ProjectContext): Promise<ResolvedWorkspace> {
    const directory = managedDirectory(context.projectRoot);
    await fs.mkdir(directory, { recursive: true });
    await this.ensureExcluded(context.projectRoot);

    let root: string | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const base = safeName(this.nameFactory()) || "worktree";
      const candidate = path.join(directory, attempt === 0 ? base : `${base}-${attempt}`);
      try {
        await fs.access(candidate);
      } catch {
        root = candidate;
        break;
      }
    }
    if (!root) {
      throw new Error(`Could not find an unused worktree name under ${directory}.`);
    }

    try {
      await this.runGit(context.projectRoot, [
        "worktree",
        "add",
        "--detach",
        root,
        "HEAD",
      ]);
      const sessionCwd = path.join(root, context.relativeCwd);
      await fs.mkdir(sessionCwd, { recursive: true });
      return {
        cwd: sessionCwd,
        worktree: {
          projectRoot: context.projectRoot,
          worktreeRoot: root,
          name: path.basename(root),
          managed: true,
        },
        created: true,
      };
    } catch (error) {
      if (root) {
        try {
          await this.runGit(context.projectRoot, ["worktree", "remove", "--force", root]);
        } catch {
          // Preserve the original failure. Git leaves enough metadata for its normal prune flow.
        }
      }
      throw gitContextError(`Could not create a Git worktree under ${directory}.`, error);
    }
  }

  private async ensureExcluded(projectRoot: string): Promise<void> {
    const rawPath = (await this.runGit(projectRoot, [
      "rev-parse",
      "--git-path",
      "info/exclude",
    ])).trim();
    const excludePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
    let contents = "";
    try {
      contents = await fs.readFile(excludePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    if (contents.split(/\r?\n/).includes(EXCLUDE_ENTRY)) {
      return;
    }
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    const prefix = contents && !contents.endsWith("\n") ? "\n" : "";
    await fs.writeFile(excludePath, `${contents}${prefix}${EXCLUDE_ENTRY}\n`, "utf8");
  }

  private async requireManagedRegistered(worktree: SessionWorktree): Promise<void> {
    const projectRoot = path.resolve(worktree.projectRoot);
    const root = path.resolve(worktree.worktreeRoot);
    if (!worktree.managed || !isInside(managedDirectory(projectRoot), root)) {
      throw new Error("Only worktrees created by Brokk ACP can be removed here.");
    }
    const registered = await this.registeredWorktrees(projectRoot);
    if (!registered.some((candidate) => samePath(candidate.path, root) && !candidate.prunable)) {
      throw new Error(`Git worktree is no longer registered: ${root}`);
    }
  }
}

export function parseWorktreePorcelain(output: string): PorcelainWorktree[] {
  const records: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) {
        records.push(current);
        current = undefined;
      }
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      if (current) {
        records.push(current);
      }
      current = {
        path: path.resolve(value),
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
    } else if (current && key === "branch") {
      current.branch = value;
    } else if (current && key === "bare") {
      current.bare = true;
    } else if (current && key === "detached") {
      current.detached = true;
    } else if (current && key === "locked") {
      current.locked = true;
    } else if (current && key === "prunable") {
      current.prunable = true;
    }
  }
  if (current) {
    records.push(current);
  }
  return records;
}

async function defaultGitRunner(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

function managedDirectory(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), MANAGED_DIRECTORY);
}

function randomWorktreeName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}

function safeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function branchName(value?: string): string | undefined {
  return value?.replace(/^refs\/heads\//, "");
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isInsideOrSame(parent: string, candidate: string): boolean {
  return samePath(parent, candidate) || isInside(parent, candidate);
}

async function requireDirectory(value: string, label: string): Promise<void> {
  try {
    const status = await fs.stat(value);
    if (status.isDirectory()) {
      return;
    }
  } catch {
    // Use one clear recovery error for missing and inaccessible paths.
  }
  throw new Error(`${label} is unavailable: ${value}`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function gitContextError(message: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message.trim() : String(error);
  return new Error(detail ? `${message} ${detail}` : message);
}
