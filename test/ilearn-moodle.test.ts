import { describe, expect, test } from "bun:test";
import { AuthError, Moodle, MoodleError, asError, decodeLaunchToken, flattenParams, parseTokenExpiry, sessionCookie, tokenFileUrl, tokenFromSession, type Fetch } from "../src/ilearn/moodle.ts";

const SITE = "https://ilearn.th-deg.de";
const TOKEN = "0123456789abcdef0123456789abcdef";
const md5 = (s: string) => new Bun.CryptoHasher("md5").update(s).digest("hex");
const launch = (passport: string, sig = md5(SITE + passport)) =>
  "moodlemobile://token=" + Buffer.from(`${sig}:::${TOKEN}:::${"p".repeat(64)}`).toString("base64");

/** A fetch that answers every request with one JSON body and records what was sent. */
function fakeFetch(body: unknown, init: ResponseInit = {}) {
  const sent: { url: string; body: string }[] = [];
  const f = (async (url: string | URL | Request, req?: RequestInit) => {
    sent.push({ url: String(url), body: req?.body instanceof URLSearchParams ? req.body.toString() : "" });
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
  }) as unknown as Fetch;
  return { f, sent };
}

describe("flattenParams", () => {
  test("arrays and nested objects use PHP bracket keys", () => {
    const p = flattenParams({ courseids: [5, 6], plugindata: { onlinetext_editor: { text: "hi", format: 1 } } });
    expect([...p]).toEqual([
      ["courseids[0]", "5"], ["courseids[1]", "6"],
      ["plugindata[onlinetext_editor][text]", "hi"], ["plugindata[onlinetext_editor][format]", "1"],
    ]);
  });

  test("booleans become 1/0 because PARAM_BOOL rejects 'true'", () => {
    expect(flattenParams({ a: true, b: false }).toString()).toBe("a=1&b=0");
  });

  test("undefined params are omitted instead of sent as 'undefined'", () => {
    expect(flattenParams({ a: undefined, b: 1 }).toString()).toBe("b=1");
  });
});

describe("asError", () => {
  test("rest/server.php error shape: {exception, errorcode, message}", () => {
    const e = asError({ exception: "dml_missing_record_exception", errorcode: "invalidrecord", message: "nope" });
    expect(e?.errorcode).toBe("invalidrecord");
    expect(e?.message).toBe("nope");
  });

  test("upload.php error shape: {error: text, errorcode}", () => {
    expect(asError({ error: "Ungültiges Token", errorcode: "invalidtoken", stacktrace: null })?.errorcode).toBe("invalidtoken");
  });

  test("successful payloads are not errors, including AJAX-style {error: false}", () => {
    expect(asError([{ id: 1 }])).toBeUndefined();
    expect(asError({ courses: [], warnings: [] })).toBeUndefined();
    expect(asError({ error: false, data: {} })).toBeUndefined();
  });
});

describe("Moodle.call", () => {
  test("an HTTP 200 carrying an exception body throws", async () => {
    const { f } = fakeFetch({ exception: "x", errorcode: "invalidrecord", message: "missing" });
    await expect(new Moodle(SITE, TOKEN, f).call("core_course_get_contents", { courseid: 9 })).rejects.toThrow("missing");
  });

  test("an unknown or revoked token is an AuthError telling the user to log in again", async () => {
    const { f } = fakeFetch({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Ungültiges Token" });
    const p = new Moodle(SITE, TOKEN, f).call("core_webservice_get_site_info");
    await expect(p).rejects.toBeInstanceOf(AuthError);
    await expect(p).rejects.toThrow(/ilearn login/);
  });

  /** Answers per wsfunction, so the site-info re-check can differ from the original call. */
  function perFunction(answers: Record<string, unknown>): Fetch {
    return (async (_url: string | URL | Request, req?: RequestInit) => {
      const fn = new URLSearchParams(String(req?.body)).get("wsfunction")!;
      return new Response(JSON.stringify(answers[fn]));
    }) as unknown as Fetch;
  }
  const access = { exception: "webservice_access_exception", errorcode: "accessexception", message: "Zugriffskontrollfehler" };

  test("an expired token (bare accessexception everywhere) is an AuthError", async () => {
    const f = perFunction({ mod_forum_get_forum_discussions: access, core_webservice_get_site_info: access });
    await expect(new Moodle(SITE, TOKEN, f).call("mod_forum_get_forum_discussions")).rejects.toBeInstanceOf(AuthError);
  });

  test("accessexception on one function while site info works is a permission error, not an expired login", async () => {
    const f = perFunction({ core_role_assign_roles: access, core_webservice_get_site_info: { userid: 1 } });
    const p = new Moodle(SITE, TOKEN, f).call("core_role_assign_roles");
    await expect(p).rejects.toThrow("Zugriffskontrollfehler");
    await expect(p).rejects.not.toBeInstanceOf(AuthError);
  });

  test("posts token, function and json format to the REST endpoint", async () => {
    const { f, sent } = fakeFetch([]);
    await new Moodle(SITE, TOKEN, f).call("mod_assign_get_assignments", { courseids: [7] });
    expect(sent[0]!.url).toBe(`${SITE}/webservice/rest/server.php`);
    const body = new URLSearchParams(sent[0]!.body);
    expect(body.get("wstoken")).toBe(TOKEN);
    expect(body.get("wsfunction")).toBe("mod_assign_get_assignments");
    expect(body.get("moodlewsrestformat")).toBe("json");
    expect(body.get("courseids[0]")).toBe("7");
  });

  test("a pluginfile JSON error with status 200 fails the download", async () => {
    const { f } = fakeFetch({ error: "Zugriff verweigert", errorcode: "nopermissions" });
    await expect(new Moodle(SITE, TOKEN, f).download(`${SITE}/pluginfile.php/1/x.pdf`)).rejects.toBeInstanceOf(MoodleError);
  });
});

describe("launch token", () => {
  test("decodes a correctly signed moodlemobile:// redirect", () => {
    expect(decodeLaunchToken(launch("42"), SITE, "42")).toBe(TOKEN);
  });

  test("rejects a redirect signed for another passport", () => {
    expect(() => decodeLaunchToken(launch("42"), SITE, "43")).toThrow(/signature mismatch/);
  });

  test("tokenFromSession sends only the MoodleSession cookie and reads the redirect", async () => {
    let cookie = "";
    const f = (async (url: string | URL | Request, req?: RequestInit) => {
      cookie = new Headers(req?.headers).get("cookie") ?? "";
      const passport = new URL(String(url)).searchParams.get("passport")!;
      return new Response(null, { status: 302, headers: { location: launch(passport) } });
    }) as unknown as Fetch;
    expect(await tokenFromSession(SITE, "_saml_idp=x; MoodleSession=abc123def456; other=y", f)).toBe(TOKEN);
    expect(cookie).toBe("MoodleSession=abc123def456");
  });

  test("a logged-out session (redirect to the login page) is a clear error", async () => {
    const f = (async () => new Response(null, { status: 303, headers: { location: `${SITE}/login/index.php` } })) as unknown as Fetch;
    await expect(tokenFromSession(SITE, "MoodleSession=abc123def456", f)).rejects.toThrow(/not logged in/);
  });
});

describe("sessionCookie", () => {
  test("accepts a bare value, a pair, or a full Cookie header", () => {
    expect(sessionCookie("abc123def456")).toBe("MoodleSession=abc123def456");
    expect(sessionCookie("MoodleSession=abc123def456")).toBe("MoodleSession=abc123def456");
    expect(sessionCookie("Cookie: a=1; MoodleSession=abc123def456; b=2")).toBe("MoodleSession=abc123def456");
  });

  test("rejects input with no session cookie", () => {
    expect(() => sessionCookie("a=1; b=2")).toThrow(/MoodleSession/);
  });
});

describe("tokenFileUrl", () => {
  test("rewrites the cookie pluginfile path to the token one", () => {
    expect(tokenFileUrl(`${SITE}/pluginfile.php/1/mod_resource/content/1/a.pdf?forcedownload=1`, "T"))
      .toBe(`${SITE}/webservice/pluginfile.php/1/mod_resource/content/1/a.pdf?forcedownload=1&token=T`);
  });

  test("leaves an already-webservice URL on a single /webservice/ prefix", () => {
    expect(tokenFileUrl(`${SITE}/webservice/pluginfile.php/1/a.pdf`, "T")).toBe(`${SITE}/webservice/pluginfile.php/1/a.pdf?token=T`);
  });
});

describe("parseTokenExpiry", () => {
  // Shape of iLearn's /user/managetoken.php as served on 2026-11-01 (German UI).
  const page = (validUntil: string, header = "Gültig bis") => `
<table class="generaltable"><thead><tr>
<th class="header c0" style="text-align:left;" scope="col">Name</th>
<th class="header c1" style="text-align:left;" scope="col">Service</th>
<th class="header c2" style="text-align:left;" scope="col">${header}</th>
<th class="header c3" style="text-align:center;" scope="col">Letzter Zugriff</th>
</tr></thead><tbody>
<tr class=""><td class="cell c0" style="text-align:left;">Webservice-3LvAb</td><td class="cell c1" style="text-align:left;">Attendance</td><td class="cell c2" style="text-align:left;"></td><td class="cell c3">x</td></tr>
<tr class="">
<td class="cell c0" style="text-align:left;">Webservice-q4bD4</td>
<td class="cell c1" style="text-align:left;">Moodle mobile web service</td>
<td class="cell c2" style="text-align:left;">${validUntil}</td>
<td class="cell c3" style="text-align:center;">1. November 2026, 22:15</td>
</tr></tbody></table>`;

  test("reads the German date of the mobile-service row as Berlin time (CET in winter)", () => {
    expect(parseTokenExpiry(page("24. Januar 2027, 15:20"))).toBe(Date.UTC(2027, 0, 24, 14, 20) / 1000);
  });

  test("applies summer time (CEST) for a date in July", () => {
    expect(parseTokenExpiry(page("24. Juli 2027, 15:20"))).toBe(Date.UTC(2027, 6, 24, 13, 20) / 1000);
  });

  test("reads the English UI with a 12-hour clock", () => {
    expect(parseTokenExpiry(page("24 January 2027, 3:20 PM", "Valid until"))).toBe(Date.UTC(2027, 0, 24, 14, 20) / 1000);
  });

  test("an empty cell means the token never expires", () => {
    expect(parseTokenExpiry(page(""))).toBe(0);
  });

  test("a page without the mobile-service row (e.g. logged out) is unknown, not 'never'", () => {
    expect(parseTokenExpiry("<html>Sie sind als Gast angemeldet</html>")).toBeUndefined();
  });
});
