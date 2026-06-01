import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function runGit(args: string[], cwd: string): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

export function normalizeGitRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  const withoutGitSuffix = trimmed.replace(/\.git$/i, "");
  const sshLike = withoutGitSuffix.match(/^(?:ssh:\/\/)?git@([^/:]+)[:/]([^\s]+)$/i);
  if (sshLike) {
    return `${sshLike[1]}/${sshLike[2]}`.replace(/^\/*/, "");
  }

  try {
    const url = new URL(withoutGitSuffix);
    if (!url.hostname || !url.pathname) return null;
    return `${url.hostname}${url.pathname}`.replace(/^\/*/, "");
  } catch {
    return null;
  }
}

export function deriveProjectKey(cwd = process.cwd()): string | null {
  const absoluteCwd = resolve(cwd);
  const repoRoot = runGit(["rev-parse", "--show-toplevel"], absoluteCwd);
  const gitCwd = repoRoot ?? absoluteCwd;

  const remote = runGit(["config", "--get", "remote.origin.url"], gitCwd);
  const normalizedRemote = remote ? normalizeGitRemote(remote) : null;
  if (normalizedRemote) return normalizedRemote;

  try {
    return `cwd:${realpathSync(gitCwd)}`;
  } catch {
    return `cwd:${gitCwd}`;
  }
}
