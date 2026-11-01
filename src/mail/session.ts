/**
 * Webmail session storage and login.
 *
 * THD webmail authenticates through Microsoft Entra ID and then keeps a Roundcube session in
 * two cookies (`roundcube_sessid`, `roundcube_sessauth`) plus a per-session request token.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostCookies, interactiveFlow } from "../browser.ts";
import { stateDir } from "../paths.ts";

export const DEFAULT_BASE = "https://webmail.stud.th-deg.de/";

export interface Session {
  base: string;
  cookies: Record<string, string>;
  token: string;
  user?: string;
  createdAt: string;
}

export function baseUrl(): string {
  const b = process.env.THD_WEBMAIL_URL || DEFAULT_BASE;
  return b.endsWith("/") ? b : `${b}/`;
}

const sessionPath = () => join(stateDir(), "webmail-session.json");

export async function loadSession(): Promise<Session | null> {
  try {
    const s = JSON.parse(await readFile(sessionPath(), "utf8")) as Session;
    return s.base === baseUrl() && s.cookies?.roundcube_sessid ? s : null;
  } catch {
    return null;
  }
}

export async function saveSession(s: Session): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${sessionPath()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, sessionPath());
}

export async function clearSession(): Promise<void> {
  await rm(sessionPath(), { force: true });
}

/** True once the browser sits on a logged-in Roundcube page. */
function isMailboxUrl(url: string, base: string): boolean {
  if (!url.startsWith(base)) return false;
  const u = new URL(url);
  const task = u.searchParams.get("_task");
  return task !== null && task !== "login" && !u.pathname.includes("/login/");
}

/** Sign in through the shared browser profile and capture the Roundcube session. */
export async function webmailLogin(opts: { headed?: boolean; log?: (m: string) => void } = {}): Promise<Session> {
  const base = baseUrl();
  return interactiveFlow({
    startUrl: base,
    headed: opts.headed,
    log: opts.log,
    isDone: (url) => isMailboxUrl(url, base),
    collect: async (page, browser) => {
      await page.waitForFunction("window.rcmail && rcmail.env && rcmail.env.request_token", { timeout: 30_000 });
      const token = (await page.evaluate("rcmail.env.request_token")) as string;
      const cookies = Object.fromEntries(Object.entries(await hostCookies(browser, new URL(base).hostname)).filter(([k]) => k.startsWith("roundcube_")));
      if (!cookies.roundcube_sessid) throw new Error("logged in, but no roundcube_sessid cookie was set");
      return { base, cookies, token, createdAt: new Date().toISOString() };
    },
  });
}

/** Build a session from pasted cookies (DevTools `Cookie:` header or `name=value; ...`). */
export function sessionFromCookieHeader(header: string): Omit<Session, "token"> {
  const cookies: Record<string, string> = {};
  for (const part of header.replace(/^cookie:\s*/i, "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name.startsWith("roundcube_")) cookies[name] = part.slice(i + 1).trim();
  }
  if (!cookies.roundcube_sessid) throw new Error("no roundcube_sessid cookie in input");
  return { base: baseUrl(), cookies, createdAt: new Date().toISOString() };
}
