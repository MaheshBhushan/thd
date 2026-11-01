/**
 * Roundcube HTTP client: the only module that talks to the webmail server.
 *
 * Wire protocol (observed on webmail.stud.th-deg.de, Roundcube 1.6.20):
 *   - AJAX: `GET|POST /?_task=T&_action=A&_remote=1` with header `X-Roundcube-Request: <token>`;
 *     JSON reply `{action, env, texts, exec}`.
 *   - Form posts (compose/send, save-prefs, identities, …): urlencoded or multipart POST with
 *     `_token`, usually `_framed=1`; HTML reply whose inline script calls `parent.rcmail.*`.
 *   - Downloads: plain GET (`_action=viewsource|get`, `plugin.zipdownload.messages`).
 *   - The server rotates `roundcube_sessauth` via Set-Cookie; it must be persisted.
 *   - An expired session answers AJAX with `this.session_error(...)`, pages with a login page
 *     or a redirect to login.microsoftonline.com.
 */
import { displayMessages, pageCalls, pageEnv, parseAjax, type AjaxResult, type ExecCall } from "./protocol.ts";
import type { Session } from "./session.ts";

export type Params = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

export class WebmailError extends Error {}
export class SessionExpired extends WebmailError {}

export interface ClientDeps {
  fetch?: typeof fetch;
  /** Produce a fresh session when the current one has expired. */
  relogin?: () => Promise<Session>;
  /** Persist session changes (rotated cookies, new login). */
  save?: (s: Session) => Promise<void>;
}

export interface PageResult {
  html: string;
  env: Record<string, unknown>;
  calls: ExecCall[];
  errors: string[];
  notices: string[];
  /** Final URL after redirects. */
  url: string;
}

const TIMEOUT_MS = 180_000;

function appendParams(target: URLSearchParams | FormData, params: Params): void {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false) continue;
    if (Array.isArray(v)) {
      // Roundcube accepts both `_uid=1,2,3` and repeated keys; arrays named `x[]` repeat.
      if (k.endsWith("[]")) for (const item of v) target.append(k, String(item));
      else target.append(k, v.join(","));
    } else target.append(k, v === true ? "1" : String(v));
  }
}

export class Client {
  session: Session;
  private readonly fetch: typeof fetch;
  private readonly deps: ClientDeps;
  private relogged = false;

  constructor(session: Session, deps: ClientDeps = {}) {
    this.session = session;
    this.deps = deps;
    this.fetch = deps.fetch ?? fetch;
  }

  url(params: Params): string {
    const u = new URL(this.session.base);
    appendParams(u.searchParams, params);
    return u.toString();
  }

  private cookieHeader(): string {
    return Object.entries(this.session.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private async absorbCookies(res: Response): Promise<void> {
    let changed = false;
    for (const sc of res.headers.getSetCookie()) {
      const [kv = ""] = sc.split(";");
      const i = kv.indexOf("=");
      if (i <= 0) continue;
      const name = kv.slice(0, i).trim();
      const value = kv.slice(i + 1).trim();
      if (!name.startsWith("roundcube_")) continue;
      const expired = /expires=Thu, 01[- ]Jan[- ]1970/i.test(sc) || value === "deleted" || value === "-del-";
      if (expired) {
        if (name in this.session.cookies) { delete this.session.cookies[name]; changed = true; }
      } else if (this.session.cookies[name] !== value) {
        this.session.cookies[name] = value;
        changed = true;
      }
    }
    if (changed) await this.deps.save?.(this.session);
  }

  /** Low-level request following same-origin redirects manually so cookies are tracked. */
  async request(params: Params, init: { method?: "GET" | "POST"; body?: URLSearchParams | FormData; ajax?: boolean } = {}): Promise<Response> {
    let url = this.url(params);
    let method = init.method ?? "GET";
    let body: URLSearchParams | FormData | undefined = init.body;
    for (let hop = 0; hop < 6; hop++) {
      const headers: Record<string, string> = { Cookie: this.cookieHeader(), "User-Agent": "thd-webmail-cli/0.1 (+Roundcube)" };
      if (init.ajax) {
        headers["X-Roundcube-Request"] = this.session.token;
        headers["X-Requested-With"] = "XMLHttpRequest";
      }
      const res = await this.fetch(url, { method, body, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      await this.absorbCookies(res);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, url);
        if (next.origin !== new URL(this.session.base).origin) throw new SessionExpired(`redirected to ${next.host} (login required)`);
        if (next.searchParams.get("_task") === "login") throw new SessionExpired("session expired");
        url = next.toString();
        method = "GET";
        body = undefined;
        continue;
      }
      return res;
    }
    throw new WebmailError("too many redirects");
  }

  /** Run `fn`, logging in again once if the session has expired. */
  private async withRelogin<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof SessionExpired) || !this.deps.relogin || this.relogged) throw e;
      this.relogged = true;
      this.session = await this.deps.relogin();
      await this.deps.save?.(this.session);
      return await fn();
    }
  }

  /** AJAX call (`_remote=1`). POST sends params in the body as Roundcube's http_post does. */
  async ajax(task: string, action: string, params: Params = {}, opts: { post?: boolean; body?: FormData; allowErrors?: boolean } = {}): Promise<AjaxResult> {
    return this.withRelogin(async () => {
      let res: Response;
      if (opts.body) {
        // Uploads carry their args in the query string, as rcmail.file_upload() does.
        res = await this.request({ _task: task, _action: action, ...params, _remote: 1 }, { method: "POST", body: opts.body, ajax: true });
      } else if (opts.post) {
        const body = new URLSearchParams();
        appendParams(body, { ...params, _remote: 1 });
        res = await this.request({ _task: task, _action: action }, { method: "POST", body, ajax: true });
      } else {
        res = await this.request({ _task: task, _action: action, ...params, _remote: 1 }, { ajax: true });
      }
      const text = await res.text();
      if (res.status === 401 || res.status === 403) throw new SessionExpired(`HTTP ${res.status}`);
      if (!res.ok) throw new WebmailError(`${task}/${action}: HTTP ${res.status} ${text.slice(0, 200)}`);
      const r = parseAjax(text);
      if (r.sessionExpired) throw new SessionExpired("session expired");
      if (r.errors.length && !opts.allowErrors) throw new WebmailError(r.errors.join("; "));
      return r;
    });
  }

  private pageResult(html: string, url: string): PageResult {
    const env = pageEnv(html);
    if (env.task === "login" || /<form[^>]+name="login-form"/.test(html)) throw new SessionExpired("session expired");
    const calls = pageCalls(html);
    if (calls.some((c) => c.method === "session_error")) throw new SessionExpired("session expired");
    return { html, env, calls, ...displayMessages(calls), url };
  }

  /** GET an HTML page (forms, compose, settings). */
  async page(params: Params): Promise<PageResult> {
    return this.withRelogin(async () => {
      const res = await this.request(params);
      const html = await res.text();
      if (!res.ok) throw new WebmailError(`HTTP ${res.status} for ${params._task}/${params._action}`);
      return this.pageResult(html, res.url || this.url(params));
    });
  }

  /** Submit a form the way the browser does (urlencoded unless a file is attached). */
  async submit(query: Params, fields: [string, string | Blob, string?][], opts: { allowErrors?: boolean } = {}): Promise<PageResult> {
    return this.withRelogin(async () => {
      const multipart = fields.some(([, v]) => typeof v !== "string");
      let body: URLSearchParams | FormData;
      if (multipart) {
        const fd = new FormData();
        for (const [k, v, fname] of fields) {
          if (typeof v === "string") fd.append(k, v);
          else fd.append(k, v, fname);
        }
        if (!fields.some(([k]) => k === "_token")) fd.append("_token", this.session.token);
        body = fd;
      } else {
        const us = new URLSearchParams();
        for (const [k, v] of fields) us.append(k, v as string);
        if (!us.has("_token")) us.append("_token", this.session.token);
        body = us;
      }
      const res = await this.request(query, { method: "POST", body });
      const html = await res.text();
      if (!res.ok) throw new WebmailError(`HTTP ${res.status} for ${query._task}/${query._action}`);
      const r = this.pageResult(html, res.url);
      if (r.errors.length && !opts.allowErrors) throw new WebmailError(r.errors.join("; "));
      return r;
    });
  }

  /**
   * GET (or POST, for zipdownload) a file. An HTML reply without an attachment disposition is
   * a Roundcube page standing in for the file: an expired session or an error.
   */
  async download(params: Params, post?: Params): Promise<Response> {
    return this.withRelogin(async () => {
      let res: Response;
      if (post) {
        const body = new URLSearchParams();
        appendParams(body, { ...post, _token: this.session.token });
        res = await this.request(params, { method: "POST", body });
      } else {
        // goto_url(…, secure=true) in app.js: file downloads carry `_token` or fail the CSRF check.
        res = await this.request({ ...params, _token: this.session.token });
      }
      if (!res.ok) throw new WebmailError(`download failed: HTTP ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      const disposition = res.headers.get("content-disposition") ?? "";
      if (ct.startsWith("text/html") && !disposition.startsWith("attachment")) {
        const page = this.pageResult(await res.text(), res.url);
        throw new WebmailError(page.errors.join("; ") || "server returned a page instead of a file");
      }
      return res;
    });
  }
}
