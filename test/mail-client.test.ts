import { expect, test } from "bun:test";
import { Client, SessionExpired } from "../src/mail/client.ts";
import type { Session } from "../src/mail/session.ts";

const base = "https://webmail.example/";
const session = (sessid: string): Session => ({ base, cookies: { roundcube_sessid: sessid, roundcube_sessauth: "a" }, token: "tok", createdAt: "" });
const json = (exec: string, headers: Record<string, string> = {}) => new Response(JSON.stringify({ action: "list", exec }), { headers: { "content-type": "application/json", ...headers } });

test("a rotated roundcube_sessauth cookie is adopted and persisted", async () => {
  const saved: Session[] = [];
  const fetch = (async () => json("", { "set-cookie": "roundcube_sessauth=b-rotated; path=/; secure; HttpOnly" })) as unknown as typeof globalThis.fetch;
  const c = new Client(session("s1"), { fetch, save: async (s) => void saved.push(structuredClone(s)) });
  await c.ajax("mail", "list");
  expect(c.session.cookies.roundcube_sessauth).toBe("b-rotated");
  expect(saved.at(-1)?.cookies.roundcube_sessauth).toBe("b-rotated");
});

test("an expired session logs in again once and retries with the new cookies and token", async () => {
  const seen: { cookie: string; token: string }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    seen.push({ cookie: h.Cookie!, token: h["X-Roundcube-Request"]! });
    return h.Cookie!.includes("old") ? json('this.session_error("/?_task=login&_err=session");') : json('this.set_unread_count("INBOX",3,true);');
  }) as unknown as typeof globalThis.fetch;
  const fresh = { ...session("new"), token: "tok2" };
  const c = new Client(session("old"), { fetch, relogin: async () => fresh });
  const r = await c.ajax("mail", "getunread");
  expect(r.calls[0]?.args).toEqual(["INBOX", 3, true]);
  expect(seen.map((s) => [s.cookie.includes("new"), s.token])).toEqual([[false, "tok"], [true, "tok2"]]);
});

test("a redirect to Microsoft sign-in is a session expiry, not a page to parse", async () => {
  const fetch = (async () => new Response(null, { status: 302, headers: { location: "https://login.microsoftonline.com/x/oauth2/v2.0/authorize" } })) as unknown as typeof globalThis.fetch;
  const c = new Client(session("s"), { fetch });
  expect(c.page({ _task: "mail" })).rejects.toBeInstanceOf(SessionExpired);
});
