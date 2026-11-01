/**
 * iLearn config: `{ site, token, userid, expires }` at <state dir>/ilearn.json
 * (written 0600 by `thd login ilearn`).
 * $ILEARN_TOKEN wins over the file so the secret never has to sit in argv.
 */
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stateDir } from "../paths.ts";

export const DEFAULT_SITE = "https://ilearn.th-deg.de";

export interface Config {
  site: string;
  token?: string;
  userid?: number;
  /** Token "valid until" as unix seconds read at login; 0 = never expires; absent = unknown. */
  expires?: number;
}

export function configPath(): string {
  return join(stateDir(), "ilearn.json");
}

function fail(msg: string): never {
  throw new Error("config: " + msg);
}

/** Validate a raw object. Exported so tests never touch the filesystem. */
export function parseConfig(raw: unknown, source = "<inline>"): Config {
  if (typeof raw !== "object" || raw === null) fail(source + " is not an object");
  const o = raw as Record<string, unknown>;
  const site = o["site"] ?? DEFAULT_SITE;
  if (typeof site !== "string" || !/^https?:\/\/[^/]+$/.test(site)) {
    fail(`site must be an origin like ${DEFAULT_SITE} (got '${String(site)}')`);
  }
  const cfg: Config = { site };
  if (typeof o["token"] === "string") cfg.token = o["token"];
  if (typeof o["userid"] === "number") cfg.userid = o["userid"];
  if (typeof o["expires"] === "number") cfg.expires = o["expires"];
  return cfg;
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return { site: DEFAULT_SITE };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(path + " is not valid JSON (" + (err as Error).message + ")");
  }
  return parseConfig(raw, path);
}

export function saveConfig(cfg: Config, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function resolveToken(cfg: Config, env: NodeJS.ProcessEnv = process.env): string {
  const t = env["ILEARN_TOKEN"] || cfg.token;
  if (t) return t;
  return fail("not logged in to iLearn — run `thd login ilearn` (or set $ILEARN_TOKEN)");
}
