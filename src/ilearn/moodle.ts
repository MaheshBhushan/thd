/**
 * The one file that talks to Moodle. Three transports exist on iLearn; this
 * client uses the first, which covers everything the official app can do:
 *
 *   1. /webservice/rest/server.php  — WS token (moodle_mobile_app service)
 *   2. /lib/ajax/service.php?sesskey — same functions, browser session cookie
 *   3. HTML pages + /pluginfile.php  — cookie-authenticated scraping
 *
 * The token is minted from a logged-in browser session via the mobile-app
 * SSO launch (iLearn logs in through Shibboleth, so login/token.php with a
 * password does not work for SSO accounts).
 */

export type Fetch = typeof fetch;

export class MoodleError extends Error {
  constructor(public errorcode: string, message: string, public fn?: string) {
    super(message);
  }
}

/** The token no longer works: unknown, revoked, or past its `validuntil`. */
export class AuthError extends MoodleError {
  constructor(detail: string) {
    super("auth", `iLearn login expired or revoked (${detail}) — run \`ilearn login\``);
  }
}

/**
 * Flatten nested params into Moodle's PHP-style form keys:
 * `{courseids: [5, 6]}` → `courseids[0]=5&courseids[1]=6`.
 * Booleans become 1/0 because PHP's PARAM_BOOL rejects "true".
 */
export function flattenParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (typeof v === "boolean") out.append(key, v ? "1" : "0");
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${key}[${k}]`);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(v, k);
  return out;
}

/**
 * Moodle answers HTTP 200 even on failure; the error lives in the body.
 * rest/server.php uses `{exception, errorcode, message}`, upload.php and
 * pluginfile.php use `{error: "<text>", errorcode}`.
 */
export function asError(body: unknown, fn?: string): MoodleError | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as { exception?: unknown; error?: unknown; errorcode?: string; message?: string };
  if ("exception" in b) return new MoodleError(b.errorcode ?? "unknown", b.message ?? "unknown Moodle error", fn);
  if (typeof b.error === "string" && typeof b.errorcode === "string") return new MoodleError(b.errorcode, b.error, fn);
  return undefined;
}

/**
 * The launch endpoint redirects to `moodlemobile://token=<base64>` where the
 * payload is `md5(site + passport):::token[:::privatetoken]`.
 */
export function decodeLaunchToken(location: string, site: string, passport: string): string {
  const m = location.match(/token=([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error("launch redirect carries no token: " + location.slice(0, 60));
  const [sig, token] = Buffer.from(m[1]!, "base64").toString().split(":::");
  const expected = new Bun.CryptoHasher("md5").update(site + passport).digest("hex");
  if (sig !== expected) throw new Error("launch token signature mismatch (wrong site or passport)");
  if (!token || !/^[0-9a-f]{32}$/.test(token)) throw new Error("launch payload has no valid token");
  return token;
}

/** Accepts a bare MoodleSession value, `MoodleSession=…`, or a full Cookie header. */
export function sessionCookie(input: string): string {
  const s = input.trim().replace(/^cookie:\s*/i, "");
  const m = s.match(/(?:^|;\s*)MoodleSession=([^;\s]+)/);
  if (m) return `MoodleSession=${m[1]}`;
  if (/^[A-Za-z0-9,-]{10,}$/.test(s)) return `MoodleSession=${s}`;
  throw new Error("input has no MoodleSession cookie");
}

/** Mint a WS token from a logged-in browser session. */
export async function tokenFromSession(site: string, cookie: string, f: Fetch = fetch): Promise<string> {
  const passport = String(Math.floor(Math.random() * 1e12));
  const url = `${site}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`;
  const r = await f(url, { headers: { Cookie: sessionCookie(cookie) }, redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  if (!loc.startsWith("moodlemobile://")) {
    throw new Error(`session not logged in (launch answered ${r.status}${loc ? " → " + loc.slice(0, 80) : ""})`);
  }
  return decodeLaunchToken(loc, site, passport);
}

const MONTHS: Record<string, number> = {
  januar: 1, jänner: 1, january: 1, februar: 2, february: 2, märz: 3, march: 3, april: 4, mai: 5, may: 5, juni: 6, june: 6,
  juli: 7, july: 7, august: 8, september: 9, oktober: 10, october: 10, november: 11, dezember: 12, december: 12,
};

/** Wall-clock time in an IANA zone → unix seconds. */
function zonedToUnix(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(guess).map((p) => [p.type, p.value]));
  const asZone = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((guess - (asZone - guess)) / 1000);
}

/**
 * Read the app token's "valid until" from /user/managetoken.php (the
 * "Security keys" page). No WS function exposes it. Returns unix seconds,
 * 0 when the cell is empty (never expires), or undefined when the page has
 * no mobile-service row or an unparseable date. Dates are localised
 * (`24. Januar 2027, 15:20` / `24 January 2027, 3:20 PM`) in the user's zone.
 */
export function parseTokenExpiry(html: string, tz = "Europe/Berlin"): number | undefined {
  const at = html.indexOf(">Moodle mobile web service<");
  if (at < 0) return undefined;
  const header = html.match(/<th class="header (c\d+)[^"]*"[^>]*>\s*(?:Gültig bis|Valid until)\s*</);
  const col = header?.[1] ?? "c2";
  const row = html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
  const cell = row.match(new RegExp(`<td class="cell ${col}[^"]*"[^>]*>([^<]*)</td>`))?.[1]?.trim();
  if (cell === undefined) return undefined;
  if (cell === "") return 0;
  const m = cell.match(/(\d{1,2})\.?\s+(\p{L}+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/u);
  const month = m && MONTHS[m[2]!.toLowerCase()];
  if (!m || !month) return undefined;
  let hour = Number(m[4]);
  if (m[6]) hour = (hour % 12) + (/p/i.test(m[6]) ? 12 : 0);
  return zonedToUnix(Number(m[3]), month, Number(m[1]), hour, Number(m[5]), tz);
}

/** Expiry of the current app token, read with the browser session used for login. */
export async function tokenExpiry(site: string, cookie: string, f: Fetch = fetch): Promise<number | undefined> {
  const r = await f(`${site}/user/managetoken.php`, { headers: { Cookie: sessionCookie(cookie) } });
  return r.ok ? parseTokenExpiry(await r.text()) : undefined;
}

/** Moodle hands out cookie URLs on pages; the token variant lives under /webservice/. */
export function tokenFileUrl(url: string, token: string): string {
  const u = new URL(url.replace(/\/pluginfile\.php\//, "/webservice/pluginfile.php/").replace("/webservice/webservice/", "/webservice/"));
  u.searchParams.set("token", token);
  return u.toString();
}

export interface UploadedFile { itemid: number; filename: string }

export class Moodle {
  constructor(public site: string, private token: string, private f: Fetch = fetch) {}

  async call<T = unknown>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = flattenParams({ wstoken: this.token, wsfunction: fn, moodlewsrestformat: "json", ...params });
    const r = await this.f(`${this.site}/webservice/rest/server.php`, { method: "POST", body });
    if (!r.ok) throw new MoodleError("http", `${fn}: HTTP ${r.status}`, fn);
    const data = await r.json();
    const err = asError(data, fn);
    if (!err) return data as T;
    if (err.errorcode === "invalidtoken") throw new AuthError(err.message);
    // An expired token surfaces as a bare accessexception, but so does calling a
    // function outside the service. Ask site info, which every token may call.
    if (err.errorcode === "accessexception" && fn !== "core_webservice_get_site_info") {
      await this.call("core_webservice_get_site_info");
    } else if (err.errorcode === "accessexception") {
      throw new AuthError(err.message);
    }
    throw err;
  }

  /** GET a pluginfile URL authenticated by token. Caller owns the body stream. */
  async download(url: string): Promise<Response> {
    const r = await this.f(tokenFileUrl(url, this.token));
    if (!r.ok) throw new MoodleError("http", `download HTTP ${r.status}: ${url}`);
    // pluginfile reports auth failures as a JSON error body with 200.
    if ((r.headers.get("content-type") ?? "").includes("application/json")) {
      const text = await r.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      const err = asError(parsed);
      if (err) throw err.errorcode === "invalidtoken" ? new AuthError(err.message) : err;
      return new Response(text, { headers: r.headers });
    }
    return r;
  }

  /** Upload files into one fresh draft area; returns the shared draft itemid. */
  async upload(files: { name: string; data: Blob }[]): Promise<number> {
    let itemid = 0;
    for (const file of files) {
      const form = new FormData();
      form.append("token", this.token);
      form.append("filearea", "draft");
      form.append("itemid", String(itemid));
      form.append("file_1", file.data, file.name);
      const r = await this.f(`${this.site}/webservice/upload.php`, { method: "POST", body: form });
      const data = await r.json();
      const err = asError(data);
      if (err) throw err.errorcode === "invalidtoken" ? new AuthError(err.message) : err;
      const first = (data as UploadedFile[])[0];
      if (!first) throw new Error(`upload of ${file.name} returned nothing`);
      itemid = first.itemid;
    }
    return itemid;
  }
}
