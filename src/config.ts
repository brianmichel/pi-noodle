import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { CONFIG_DIR_SEGMENTS, CONFIG_ENV_VAR } from "./constants.ts";
import type { Mem0Config } from "./types.ts";
import { normalizeBaseUrl, normalizeOptionalString } from "./utils.ts";

const execFileAsync = promisify(execFile);

let resolvedSystemUserIdPromise: Promise<string | undefined> | undefined;

export function resolveConfigPath(): string {
  const explicitPath = normalizeOptionalString(process.env[CONFIG_ENV_VAR]);
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      ...CONFIG_DIR_SEGMENTS,
      "config.json",
    );
  }

  if (process.platform === "win32") {
    const appData = normalizeOptionalString(process.env.APPDATA);
    const baseDir = appData || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(baseDir, ...CONFIG_DIR_SEGMENTS, "config.json");
  }

  const xdgConfigHome = normalizeOptionalString(process.env.XDG_CONFIG_HOME);
  return path.join(
    xdgConfigHome || path.join(os.homedir(), ".config"),
    ...CONFIG_DIR_SEGMENTS,
    "config.json",
  );
}

export async function resolveSystemUserId(): Promise<string | undefined> {
  if (!resolvedSystemUserIdPromise) {
    resolvedSystemUserIdPromise = (async () => {
      try {
        const userInfoName = normalizeOptionalString(os.userInfo().username);
        if (userInfoName) return userInfoName;
      } catch {
        // ignore
      }

      const envUser = normalizeOptionalString(
        process.env.LOGNAME || process.env.USER || process.env.LNAME || process.env.USERNAME,
      );
      if (envUser) return envUser;

      try {
        const { stdout } = await execFileAsync("whoami");
        return normalizeOptionalString(stdout);
      } catch {
        return undefined;
      }
    })();
  }

  return resolvedSystemUserIdPromise;
}

export async function readStoredConfig(): Promise<Partial<Mem0Config>> {
  try {
    const raw = await fs.readFile(resolveConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Mem0Config>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export async function resolveConfig(): Promise<Mem0Config> {
  const stored = await readStoredConfig();
  const baseUrl = normalizeBaseUrl(stored.baseUrl || process.env.MEM0_BASE_URL || "");
  const apiKey = (stored.apiKey || process.env.MEM0_API_KEY || "").trim();
  const userId = normalizeOptionalString(stored.userId || process.env.MEM0_USER_ID)
    || await resolveSystemUserId();

  if (!baseUrl) {
    throw new Error(
      "Mem0 base URL is not configured. Run /mem0-config set <baseUrl> <apiKey> or set MEM0_BASE_URL.",
    );
  }

  if (!apiKey) {
    throw new Error(
      "Mem0 API key is not configured. Run /mem0-config set <baseUrl> <apiKey> or set MEM0_API_KEY.",
    );
  }

  return {
    baseUrl,
    apiKey,
    ...(userId ? { userId } : {}),
  };
}

export async function writeConfig(config: Mem0Config): Promise<void> {
  const configPath = resolveConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        baseUrl: normalizeBaseUrl(config.baseUrl),
        apiKey: config.apiKey.trim(),
        userId: normalizeOptionalString(config.userId),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function clearConfig(): Promise<void> {
  try {
    await fs.unlink(resolveConfigPath());
  } catch {
    // ignore
  }
}
