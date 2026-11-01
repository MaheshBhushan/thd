#!/usr/bin/env bun
/**
 * thd — THD webmail and iLearn from one command line.
 *
 * stdout is data, stderr is diagnostics; `--json` prints whole results as JSON.
 * Exit codes: 0 ok · 1 error · 2 sign-in needed · 64 bad usage.
 */
import { rm } from "node:fs/promises";
import { A, LoginRequired, makeIO, need, pullFlag, pullInt, pullVal, readStdin, rejectStray, UsageError, type Globals } from "./common.ts";
import { InteractionRequired, profileDir } from "./browser.ts";
import { stateDir } from "./paths.ts";
import { mailClient, mailMain, MAIL_HELP, webmailLogout, webmailSignIn } from "./mail/cli.ts";
import { SessionExpired } from "./mail/client.ts";
import * as mail from "./mail/mail.ts";
import { messageTable } from "./mail/render.ts";
import { assignmentText, date, expiryText, ilearnMain, ILEARN_HELP, postsText, rel, withIlearn } from "./ilearn/cli.ts";
import { configPath, loadConfig, saveConfig } from "./ilearn/config.ts";
import { AuthError, sessionCookie } from "./ilearn/moodle.ts";
import { ilearnBrowserLogin, loginWithSession } from "./ilearn/login.ts";
import * as core from "./ilearn/core.ts";
import { courseMailQuery, mailLinks, resolveRefs, type Resolved } from "./links.ts";
import { ilearnToday, mailToday } from "./today.ts";

const HELP = `${A.b("thd")} — THD webmail + iLearn from the terminal

  thd login [mail|ilearn] [--headed] [--cookie]
                       sign in (both by default) through one shared browser profile; the first
                       time a window opens for Microsoft, later sign-ins are automatic.
                       --cookie: paste a Cookie header (mail) / MoodleSession (ilearn) on stdin
  thd logout [--forget-browser]
                       end the webmail session, drop the iLearn token; --forget-browser also
                       deletes the Microsoft sign-in kept in the browser profile
  thd status           both logins at a glance
  thd today [--days N] iLearn deadlines (default 7 days), unread iLearn activity, unread mail
  thd link UID [-f FOLDER]
                       open the iLearn items an iLearn notification mail points to
                       (forum discussion posts, assignment status, course, activity)
  thd link --course <course> [-p N]
                       mails about an iLearn course

  thd mail …           webmail: read, search, send, organise, contacts, settings  (thd mail help)
  thd ilearn …         iLearn: courses, downloads, deadlines, submissions, grades (thd ilearn help)

  --json  full result as JSON    -q  no progress on stderr    -h  help
State: ${stateDir()} ($THD_HOME). Browser: $THD_CHROME. iLearn token override: $ILEARN_TOKEN.
Exit codes: 0 ok · 1 error · 2 sign-in needed · 64 bad usage.`;

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; login: boolean }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), login: e instanceof LoginRequired || e instanceof AuthError || e instanceof SessionExpired };
  }
}

async function cmdLogin(args: string[], g: Globals): Promise<void> {
  const { log, out } = makeIO(g);
  const headed = pullFlag(args, "--headed");
  const cookie = pullFlag(args, "--cookie");
  rejectStray(args);
  const which = args[0] ?? "all";
  if (!["all", "mail", "ilearn"].includes(which)) throw new UsageError("login takes mail, ilearn, or nothing for both");
  if (cookie && which === "all") throw new UsageError("--cookie needs a service: thd login mail --cookie | thd login ilearn --cookie");
  const result: Record<string, unknown> = {};
  if (which !== "ilearn") {
    if (cookie && process.stdin.isTTY) log("paste the webmail Cookie header (roundcube_sessid=…; roundcube_sessauth=…), then Ctrl-D");
    const s = await webmailSignIn(g, { headed, ...(cookie ? { cookieHeader: await readStdin() } : {}) });
    result.mail = { user: s.user };
    log(A.g(`✓ webmail: ${s.user ?? "signed in"}`));
  }
  if (which !== "mail") {
    if (cookie && process.stdin.isTTY) log("paste the MoodleSession cookie from your logged-in browser, then Ctrl-D");
    const r = cookie ? await loginWithSession(loadConfig().site, sessionCookie((await readStdin()).trim())) : await signInIlearn(g, headed);
    result.ilearn = { user: r.fullname, expires: r.config.expires ?? null };
    log(A.g(`✓ iLearn: ${r.fullname}`) + (r.config.expires ? A.d(` · token valid until ${date(r.config.expires)} (${expiryText(r.config.expires)})`) : ""));
  }
  out(result, () => "");
}

async function signInIlearn(g: Globals, headed: boolean) {
  try {
    return await ilearnBrowserLogin({ headed, log: makeIO(g).log });
  } catch (e) {
    if (e instanceof InteractionRequired) throw new LoginRequired(e.message);
    throw e;
  }
}

async function cmdLogout(args: string[], g: Globals): Promise<void> {
  const forget = pullFlag(args, "--forget-browser");
  rejectStray(args);
  await webmailLogout();
  const cfg = loadConfig();
  saveConfig({ site: cfg.site });
  if (forget) await rm(profileDir(), { recursive: true, force: true });
  makeIO(g).out({ ok: true }, () =>
    `signed out of webmail; iLearn token removed from ${configPath()}${forget ? "; browser profile deleted" : ""}\n` +
    A.d("(the iLearn app token itself stays valid until it expires; reset it under iLearn → Preferences → Security keys)"),
  );
}

async function cmdStatus(args: string[], g: Globals): Promise<void> {
  rejectStray(args);
  const [m, il] = await Promise.all([
    settle(mailClient(g).then(async (c) => ({ user: c.session.user ?? null, quota: await mail.quota(c) }))),
    settle(withIlearn(g, async (c) => ({ user: (await c.m.call<{ fullname: string }>("core_webservice_get_site_info")).fullname, expires: c.cfg.expires ?? null }))),
  ]);
  makeIO(g).out({ mail: m.ok ? m.value : { error: m.error }, ilearn: il.ok ? il.value : { error: il.error } }, () => [
    m.ok ? `${A.g("●")} mail    ${m.value.user ?? ""}${m.value.quota ? A.d(`  ${m.value.quota.percent}% of quota used`) : ""}` : `${A.r("●")} mail    ${m.error}`,
    il.ok ? `${A.g("●")} iLearn  ${il.value.user}${il.value.expires ? A.d(`  token until ${date(il.value.expires)} (${expiryText(il.value.expires)})`) : ""}` : `${A.r("●")} iLearn  ${il.error}`,
  ].join("\n"));
  if (!m.ok || !il.ok) throw new Silent(m.ok || il.ok ? 1 : 2);
}

/** Exit with a code after output was already printed. */
class Silent extends Error {
  constructor(readonly code: number) {
    super("");
  }
}

async function cmdToday(args: string[], g: Globals): Promise<void> {
  const days = pullInt(args, 7, "--days");
  const limit = pullInt(args, 15, "-n", "--limit");
  rejectStray(args);
  const [il, ml] = await Promise.all([settle(withIlearn(g, (c) => ilearnToday(c, days))), settle(mailClient(g).then((c) => mailToday(c, limit)))]);
  makeIO(g).out({ ilearn: il.ok ? il.value : { error: il.error }, mail: ml.ok ? ml.value : { error: ml.error } }, () => {
    const lines: string[] = [];
    if (il.ok) {
      const v = il.value;
      lines.push(A.b(`iLearn — due in the next ${days} day${days === 1 ? "" : "s"}`));
      lines.push(...(v.deadlines.length ? v.deadlines.map((e) => `  ${date(e.time).padEnd(22)} ${rel(e.time)} ${A.b(e.name)}${A.d(`  ${e.course}${e.cmid ? ` · cmid ${e.cmid}` : ""}`)}`) : [A.d("  nothing due")]));
      lines.push(A.d(`  ${v.unreadNotifications} unread notification${v.unreadNotifications === 1 ? "" : "s"} · ${v.unreadMessages} unread message${v.unreadMessages === 1 ? "" : "s"}`));
    } else lines.push(A.r(`iLearn: ${il.error}`));
    lines.push("");
    if (ml.ok) {
      const v = ml.value;
      lines.push(A.b(`Mail — ${v.unread} unread in INBOX this week`) + (v.rows.length < v.unread ? A.d(` (newest ${v.rows.length})`) : ""));
      if (v.rows.length) lines.push(messageTable(v.rows.map((r) => (r.ilearn ? { ...r, subject: `[iLearn] ${r.subject}` } : r))).replace(/^/gm, "  "));
      if (v.rows.some((r) => r.ilearn)) lines.push(A.d("  thd link UID opens what an [iLearn] mail refers to"));
    } else lines.push(A.r(`Mail: ${ml.error}`));
    return lines.join("\n");
  });
  if (!il.ok || !ml.ok) throw new Silent(il.ok || ml.ok ? 1 : 2);
}

function resolvedText(r: Resolved): string {
  const head = (s: string) => `${A.y("▸")} ${s}${r.ref.url ? A.d(`  ${r.ref.url}`) : ""}`;
  switch (r.kind) {
    case "course":
      return head(`course ${A.b(r.name)} ${A.d(`(id ${r.ref.id})`)}`);
    case "assignment":
      return `${head(`assignment cmid ${r.ref.id}`)}\n${assignmentText(r.status)}`;
    case "discussion": {
      const post = r.ref.kind === "discussion" ? r.ref.post : undefined;
      return `${head(`forum discussion ${r.ref.id}${post ? `, post ${post}` : ""}`)}\n${postsText(post ? r.posts.filter((p) => p.id === post).concat(r.posts.filter((p) => p.id !== post)) : r.posts)}`;
    }
    case "module":
      return head(`${r.modname} ${A.b(r.name)} ${A.d(`(cmid ${r.ref.id}; thd ilearn call core_course_get_course_module cmid=${r.ref.id})`)}`);
    case "error":
      return head(A.r(`${r.ref.kind} ${r.ref.id}: ${r.error}`));
  }
}

async function cmdLink(args: string[], g: Globals): Promise<void> {
  const { out } = makeIO(g);
  const folder = pullVal(args, "-f", "--folder") ?? "INBOX";
  const course = pullVal(args, "--course");
  const page = pullInt(args, 1, "-p", "--page");
  rejectStray(args);
  if (course !== undefined) {
    if (args.length) throw new UsageError(`unexpected argument ${args[0]}`);
    const c = await withIlearn(g, async (ic) => core.findCourse(ic.m, await ic.userid(), course));
    const q = courseMailQuery(c);
    const r = await mail.list(await mailClient(g), { mbox: "INBOX", query: q, headers: ["subject", "body"], scope: "all", page });
    return out({ course: { id: c.id, name: core.decodeHtml(c.fullname) }, query: q, ...r }, () =>
      `${A.b(core.decodeHtml(c.fullname))} ${A.d(`— mails matching "${q}" in all folders, page ${r.page}/${Math.max(r.pages, 1)}, ${r.total} total`)}\n${r.rows.length ? messageTable(r.rows, true) : A.d("(no mails)")}`,
    );
  }
  const uid = Number(need(args[0], "UID"));
  if (!Number.isInteger(uid) || uid < 1) throw new UsageError(`not a message UID: ${args[0]}`);
  const { view } = await mail.read(await mailClient(g), uid, folder, { peek: true });
  const links = mailLinks(view, loadConfig().site);
  if (!links.refs.length && !links.courseId) {
    return out({ subject: view.subject, links, resolved: [] }, () => `${A.b(view.subject)}\n${A.d("no iLearn links in this message")}`);
  }
  const resolved = await withIlearn(g, async (ic) => resolveRefs(ic.m, await ic.userid(), links));
  out({ subject: view.subject, from: view.from, links, resolved }, () => [`${A.b(view.subject)}${A.d(`  ${view.from}`)}`, ...resolved.map(resolvedText)].join("\n\n"));
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const g: Globals = { json: pullFlag(args, "--json"), quiet: pullFlag(args, "-q", "--quiet") };
  const help = pullFlag(args, "-h", "--help");
  const cmd = args.shift();
  if (!cmd || cmd === "help") return void console.log(HELP);
  if (help) return void console.log(cmd === "mail" ? MAIL_HELP : cmd === "ilearn" ? ILEARN_HELP : HELP);
  switch (cmd) {
    case "mail":
      return mailMain(args, g);
    case "ilearn":
      return ilearnMain(args, g);
    case "login":
      return cmdLogin(args, g);
    case "logout":
      return cmdLogout(args, g);
    case "status":
      return cmdStatus(args, g);
    case "today":
      return cmdToday(args, g);
    case "link":
      return cmdLink(args, g);
  }
  throw new UsageError(`unknown command ${cmd} (see thd --help)`);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Silent) process.exitCode = e.code;
  else {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof UsageError ? 64 : e instanceof LoginRequired || e instanceof AuthError || e instanceof SessionExpired ? 2 : 1;
    if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: msg }));
    console.error(A.r(`✗ ${msg}`) + (code === 2 ? A.d("\n  run `thd login` (in a graphical session the first time)") : ""));
    process.exitCode = code;
  }
}
