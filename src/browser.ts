/**
 * The one module that drives a browser (puppeteer-core + system Chrome).
 *
 * Webmail and iLearn both end at THD's Microsoft Entra tenant (iLearn via the Shibboleth IdP
 * at idp.th-deg.de, whose tenant router forwards students to Microsoft). One persistent Chrome
 * profile therefore holds a single Microsoft SSO session for both: after one interactive
 * sign-in ("Stay signed in"), later logins to either service complete headless.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { stateDir } from "./paths.ts";

export const profileDir = () => join(stateDir(), "chrome-profile");

export class InteractionRequired extends Error {}

export function findChrome(): string {
  const env = process.env.THD_CHROME;
  if (env) return env;
  for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("no Chrome/Chromium found; set THD_CHROME to the browser executable");
}

export interface FlowOptions<T> {
  startUrl: string;
  /** The flow has reached the logged-in service. */
  isDone: (url: string) => boolean;
  collect: (page: Page, browser: Browser) => Promise<T>;
  headed: boolean;
  timeoutMs: number;
  log?: (msg: string) => void;
}

/** Inputs that mean a human has to type or choose something (Microsoft, MFA, IdP forms). */
const NEEDS_INPUT = `Boolean(document.querySelector('input[type="email"]:not([aria-hidden="true"]), input[type="password"], input[name="otc"], #idDiv_SAOTCS_Proofs, #tilesHolder, input[name="j_username"]'))`;

/**
 * THD's IdP tenant router asks "Student / Employee" on every visit. It is not a credential
 * prompt, so answer it for the student tenant (override with THD_TENANT=staff or similar).
 */
const PICK_TENANT = `(() => {
  const want = ${JSON.stringify(process.env.THD_TENANT || "stud")};
  const input = document.querySelector('form input[name="tenant"][value="' + want + '"]');
  if (!input) return false;
  input.form.requestSubmit ? input.form.requestSubmit() : input.form.submit();
  return true;
})()`;

/**
 * Open `startUrl` in the shared profile and wait for `isDone`. Headless runs throw
 * InteractionRequired as soon as a sign-in form appears; headed runs wait for the user.
 */
export async function browserFlow<T>(o: FlowOptions<T>): Promise<T> {
  // Lazy: puppeteer-core is large and only logins need it; every other command stays fast.
  const puppeteer = await import("puppeteer-core");
  const log = o.log ?? (() => {});
  await mkdir(profileDir(), { recursive: true, mode: 0o700 });
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !o.headed,
    userDataDir: profileDir(),
    defaultViewport: o.headed ? null : { width: 1200, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check", "--disable-features=Translate"],
  });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto(o.startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const deadline = Date.now() + o.timeoutMs;
    let announced = false;
    let stuckSince = 0;
    let lastUrl = "";
    while (!o.isDone(page.url())) {
      if (Date.now() > deadline) throw new Error(`sign-in did not finish within ${Math.round(o.timeoutMs / 1000)}s (last page: ${new URL(page.url()).host})`);
      const url = page.url();
      if (new URL(url).pathname.startsWith("/router/")) await page.evaluate(PICK_TENANT).catch(() => false);
      if (url !== lastUrl) {
        lastUrl = url;
        stuckSince = Date.now();
      }
      if (!o.headed) {
        // Silent SSO hops through redirects within seconds; a sign-in form or a page that
        // stops moving needs a human.
        const needsInput = (await page.evaluate(NEEDS_INPUT).catch(() => false)) as boolean;
        if (needsInput || Date.now() - stuckSince > 20_000) throw new InteractionRequired(`sign-in at ${new URL(url).host} needs interaction`);
      } else if (!announced) {
        log("complete the sign-in in the browser window (choose “Stay signed in” to make later logins automatic)");
        announced = true;
      }
      await Bun.sleep(400);
    }
    return await o.collect(page, browser);
  } finally {
    await browser.close();
  }
}

/** Run a flow headless; if a person is needed, retry it in a visible window when possible. */
export async function interactiveFlow<T>(o: Omit<FlowOptions<T>, "headed" | "timeoutMs"> & { headed?: boolean }): Promise<T> {
  if (!o.headed) {
    try {
      return await browserFlow({ ...o, headed: false, timeoutMs: 60_000 });
    } catch (e) {
      if (!(e instanceof InteractionRequired)) throw e;
      const graphical = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) || process.platform === "darwin";
      if (!graphical || !process.stdin.isTTY) throw new InteractionRequired(`${e.message}: run \`thd login\` in a graphical session`);
      o.log?.(`${e.message}; opening a browser window…`);
    }
  }
  return browserFlow({ ...o, headed: true, timeoutMs: 300_000 });
}

/** Cookies of the profile for one host (exact or parent-domain cookies). */
export async function hostCookies(browser: Browser, host: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of await browser.cookies()) {
    const d = c.domain.replace(/^\./, "");
    if (host === d || host.endsWith(`.${d}`)) out[c.name] = c.value;
  }
  return out;
}
