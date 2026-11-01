/**
 * iLearn sign-in without pasting cookies: the shared browser profile walks
 * Shibboleth → THD tenant router → Microsoft SSO back to Moodle, then the MoodleSession
 * cookie mints the mobile-app WS token exactly as `tokenFromSession` does for a pasted one.
 */
import { hostCookies, interactiveFlow } from "../browser.ts";
import { loadConfig, saveConfig, type Config } from "./config.ts";
import { Moodle, tokenExpiry, tokenFromSession } from "./moodle.ts";

export interface IlearnLogin {
  config: Config;
  fullname: string;
}

/** Turn a logged-in MoodleSession cookie into a saved token (+ its expiry date). */
export async function loginWithSession(site: string, cookie: string): Promise<IlearnLogin> {
  const token = await tokenFromSession(site, cookie);
  const info = await new Moodle(site, token).call<{ userid: number; fullname: string }>("core_webservice_get_site_info");
  const expires = await tokenExpiry(site, cookie).catch(() => undefined);
  const config: Config = { site, token, userid: info.userid, ...(expires !== undefined && { expires }) };
  saveConfig(config);
  return { config, fullname: info.fullname };
}

export async function ilearnBrowserLogin(opts: { headed?: boolean; log?: (m: string) => void } = {}): Promise<IlearnLogin> {
  const site = loadConfig().site;
  const host = new URL(site).hostname;
  const cookie = await interactiveFlow({
    startUrl: `${site}/auth/shibboleth/index.php`,
    headed: opts.headed,
    log: opts.log,
    isDone: (url) => {
      const u = new URL(url);
      return u.hostname === host && !u.pathname.startsWith("/auth/") && !u.pathname.startsWith("/login/");
    },
    collect: async (_page, browser) => {
      const c = (await hostCookies(browser, host)).MoodleSession;
      if (!c) throw new Error("reached iLearn, but no MoodleSession cookie was set");
      return c;
    },
  });
  return loginWithSession(site, cookie);
}
