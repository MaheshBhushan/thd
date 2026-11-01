/**
 * `thd ilearn …` — THD iLearn (Moodle) over the mobile web-service API.
 */
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { A, LoginRequired, makeIO, need, pullFlag, pullInt, pullVal, rejectStray, UsageError, type Globals } from "../common.ts";
import { InteractionRequired } from "../browser.ts";
import { configPath, loadConfig, resolveToken, type Config } from "./config.ts";
import { AuthError, Moodle } from "./moodle.ts";
import { ilearnBrowserLogin } from "./login.ts";
import * as core from "./core.ts";

/** Warn this many days before the app token's "valid until". */
const WARN_DAYS = 7;

export const ILEARN_HELP = `${A.b("thd ilearn")} — iLearn (Moodle)

${A.b("account")}
  status                        is the login still valid, and until when (exit 2 if not)
  whoami                        account + site info

${A.b("courses")}
  courses [--past|--future|--all]   enrolled courses (default: in progress)
  course <course>               sections and activities (cmid, type, name, files)
  download [<course>...]        fetch course files into ./iLearn/<course>/ (default: all in-progress)
      -o, --out DIR             target root (default ./iLearn)
      --all-types               also page/book/etc. HTML files, not just resources + folders
      --dry-run                 list what would be fetched
  fetch <url> [-o FILE]         download any pluginfile URL with your token

${A.b("work")}
  deadlines [--days N]          upcoming due dates (default 30 days)
  assignments [<course>]        assignments with due dates
  assignment <cmid>             submission status, files, grade, feedback
  submit <cmid> [FILE...] [--text T] [--final]
                                save a submission draft; --final also submits for grading
  grades [<course>]             overview, or grade items of one course

${A.b("social")}
  notifications [-n N]          recent notifications
  messages [-n N]               conversations with last message
  forum <cmid> [-n N]           discussions in a forum
  discussion <id> [-n N]        posts of one forum discussion

${A.b("anything else")}
  functions [FILTER]            the ~450 web-service functions your token may call
  call <wsfunction> [k=v ...]   call one raw; arrays as k[0]=v or k=[..] JSON; prints JSON

<course> is a numeric id or a unique piece of its name, e.g. "statistical".
Token: $ILEARN_TOKEN, else ${configPath()}. Signing in is automatic (shared browser profile);
\`thd login ilearn --cookie\` accepts a pasted MoodleSession cookie instead.`;

export const date = (t: number) => (t ? new Date(t * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1 << 20 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1 << 20)).toFixed(1)} MB`);
export const expiryText = (t: number) => {
  const days = (t * 1000 - Date.now()) / 86400000;
  return days < 0 ? "expired" : days < 1 ? `${Math.max(1, Math.round(days * 24))}h left` : `${Math.floor(days)} days left`;
};

/** Relative due time, padded to a fixed width before colouring so columns stay aligned. */
export const rel = (t: number) => {
  const d = (t * 1000 - Date.now()) / 86400000;
  const pad = (s: string) => s.padEnd(12);
  if (d < 0) return A.r(pad(`${Math.ceil(-d)}d overdue`));
  return d < 1 ? A.y(pad(`${Math.round(d * 24)}h left`)) : d < 3 ? A.y(pad(`${Math.floor(d)}d left`)) : pad(`${Math.floor(d)}d left`);
};

export interface IlearnClient {
  m: Moodle;
  cfg: Config;
  userid: () => Promise<number>;
}

/**
 * A Moodle client from the saved token, signing in through the browser when there is none
 * or it has passed its recorded expiry. `fresh` forces a new sign-in (after an AuthError).
 */
export async function ilearnClient(g: Globals, fresh = false): Promise<IlearnClient> {
  const { log } = makeIO(g);
  let cfg = loadConfig();
  const envToken = process.env.ILEARN_TOKEN;
  const expired = !envToken && cfg.expires !== undefined && cfg.expires > 0 && cfg.expires <= Date.now() / 1000;
  if (!envToken && (fresh || !cfg.token || expired)) {
    log(A.d("signing in to iLearn…"));
    try {
      cfg = (await ilearnBrowserLogin({ log })).config;
    } catch (e) {
      if (e instanceof InteractionRequired) throw new LoginRequired(e.message);
      throw e;
    }
  } else if (!envToken && cfg.expires && cfg.expires - Date.now() / 1000 < WARN_DAYS * 86400) {
    log(A.y(`⚠ iLearn token expires ${date(cfg.expires)} (${expiryText(cfg.expires)}); afterwards thd signs in again automatically.`));
  }
  const m = new Moodle(cfg.site, resolveToken(cfg));
  let uid = envToken ? undefined : cfg.userid;
  return { m, cfg, userid: async () => (uid ??= (await m.call<{ userid: number }>("core_webservice_get_site_info")).userid) };
}

/** Run an iLearn action; a rejected token triggers one automatic sign-in and a retry. */
export async function withIlearn<T>(g: Globals, fn: (c: IlearnClient) => Promise<T>): Promise<T> {
  try {
    return await fn(await ilearnClient(g));
  } catch (e) {
    if (!(e instanceof AuthError) || process.env.ILEARN_TOKEN) throw e;
    return await fn(await ilearnClient(g, true));
  }
}

export async function ilearnMain(args: string[], g: Globals): Promise<void> {
  const { log, out } = makeIO(g);
  if (!args.length || args[0] === "help") return void console.log(ILEARN_HELP);
  const cmd = args.shift()!;
  // Per-command flags are pulled before the stray-flag check so typos fail before any network work.
  const flags = {
    past: pullFlag(args, "--past"), future: pullFlag(args, "--future"), all: pullFlag(args, "--all"),
    allTypes: pullFlag(args, "--all-types"), dryRun: pullFlag(args, "--dry-run"), final: pullFlag(args, "--final"),
    out: pullVal(args, "-o", "--out"), text: pullVal(args, "--text"),
    days: pullInt(args, 30, "--days"), n: pullInt(args, 20, "-n", "--limit"),
  };
  rejectStray(args);
  const idArg = (what: string) => {
    const v = need(args[0], what);
    if (!/^\d+$/.test(v)) throw new UsageError(`${what} must be a number (got '${v}')`);
    return Number(v);
  };

  if (cmd === "status") {
    const cfg = loadConfig();
    const expires = process.env.ILEARN_TOKEN ? undefined : cfg.expires;
    const token = process.env.ILEARN_TOKEN || cfg.token;
    const s = token
      ? await new Moodle(cfg.site, token).call<{ fullname: string; userid: number }>("core_webservice_get_site_info").catch((e) => {
          if (e instanceof AuthError) return undefined;
          throw e;
        })
      : undefined;
    const res = { valid: !!s, user: s?.fullname ?? null, userid: s?.userid ?? null, expires: expires ?? null, site: cfg.site };
    out(res, () => [
      s ? `${A.g("● logged in")} as ${s.fullname} (${s.userid})` : `${A.r("● not logged in / expired")} — run \`thd login ilearn\``,
      expires ? `token valid until ${date(expires)} (${expiryText(expires)})` : expires === 0 ? "token never expires" : A.d("token expiry unknown"),
    ].join("\n"));
    if (!s) throw new LoginRequired("iLearn login invalid");
    return;
  }

  // Validate shapes that don't need the network before signing in.
  if (["assignment", "submit", "forum", "discussion"].includes(cmd)) idArg(cmd === "discussion" ? "discussion id" : "cmid");
  if (cmd === "call") need(args[0], "wsfunction name (see `thd ilearn functions`)");
  if (cmd === "fetch") need(args[0], "URL");
  if (cmd === "course") need(args[0], "<course>");

  await withIlearn(g, async ({ m, cfg, userid }) => {
    switch (cmd) {
      case "whoami": {
        const s = await m.call<{ fullname: string; username: string; userid: number; sitename: string; release: string; functions: unknown[] }>("core_webservice_get_site_info");
        const expires = cfg.expires;
        return out({ ...s, expires: expires ?? null }, () => `${s.fullname} <${s.username}> id ${s.userid}\n${A.d(`${s.sitename} · Moodle ${s.release} · ${s.functions.length} functions`)}${expires ? A.d(`\nlogin valid until ${date(expires)} (${expiryText(expires)})`) : ""}`);
      }
      case "courses": {
        const cls: core.Classification = flags.all ? "all" : flags.past ? "past" : flags.future ? "future" : "inprogress";
        const cs = await core.listCourses(m, await userid(), cls);
        return out(cs, () => cs.map((c) => `${A.b(String(c.id).padStart(6))}  ${core.decodeHtml(c.fullname)}${c.hasprogress && typeof c.progress === "number" ? A.d(`  ${Math.round(c.progress)}%`) : ""}`).join("\n") || A.d("no courses"));
      }
      case "course": {
        const c = await core.findCourse(m, await userid(), args[0]!);
        const sections = await core.courseContents(m, c.id);
        return out({ course: c, sections }, () => [
          A.b(core.decodeHtml(c.fullname)) + A.d(`  id ${c.id}`),
          ...sections.filter((s) => s.modules.length).flatMap((s) => [
            "", A.y(core.decodeHtml(s.name)),
            ...s.modules.map((mod) => {
              const files = (mod.contents ?? []).filter((f) => f.type === "file");
              const extra = mod.modname === "url" ? A.d("  → " + (mod.contents?.[0]?.fileurl ?? "")) : files.length ? A.d(`  ${files.length} file${files.length > 1 ? "s" : ""}, ${size(files.reduce((n, f) => n + f.filesize, 0))}`) : "";
              return `  ${A.d(String(mod.id).padStart(7))} ${mod.modname.padEnd(10)} ${core.decodeHtml(mod.name)}${extra}`;
            }),
          ]),
        ].join("\n"));
      }
      case "download": {
        const all = await core.listCourses(m, await userid(), "all");
        const targets = args.length ? args.map((q) => core.resolveCourse(all, q)) : await core.listCourses(m, await userid(), "inprogress");
        const root = resolve(flags.out ?? "iLearn");
        const ass = await core.assignments(m, targets.map((c) => c.id));
        const summary: { course: string; events: core.DownloadEvent[] }[] = [];
        for (const c of targets) {
          const name = core.safeName(c.fullname);
          log(A.d(`▸ ${name}`));
          const jobs = core.planFiles(await core.courseContents(m, c.id), ass.filter((a) => a.courseid === c.id), { all: flags.allTypes });
          const events = await core.downloadFiles(m, jobs, `${root}/${name}`, {
            dryRun: flags.dryRun,
            onEvent: (e) => {
              if (e.kind === "done") log(A.d(`  ↓ ${e.job.path} (${size(e.job.size)})`));
              if (e.kind === "fail") console.error(A.r(`  ✗ ${e.job.path}: ${e.error}`));
              if (e.kind === "plan" && !g.json) console.log(`${name}/${e.job.path}\t${size(e.job.size)}`);
            },
          });
          summary.push({ course: name, events });
        }
        const count = (k: core.DownloadEvent["kind"]) => summary.reduce((n, s) => n + s.events.filter((e) => e.kind === k).length, 0);
        if (g.json) console.log(JSON.stringify({ root, courses: summary }, null, 2));
        log(A.d(`${count("done")} downloaded, ${count("skip")} up to date${flags.dryRun ? `, ${count("plan")} to fetch` : ""}, ${count("fail")} failed → ${root}`));
        if (count("fail")) throw new Error(`${count("fail")} download(s) failed`);
        return;
      }
      case "fetch": {
        const url = args[0]!;
        const r = await m.download(url);
        const file = flags.out ?? (decodeURIComponent(basename(new URL(url).pathname)) || "download");
        if (file === "-") return void (await Bun.write(Bun.stdout, r));
        const bytes = await Bun.write(file, r);
        log(A.d(`saved ${file} (${size(bytes)})`));
        return;
      }
      case "deadlines": {
        const ev = await core.deadlines(m, flags.days);
        return out(ev, () => ev.map((e) => `${date(e.time).padEnd(22)} ${rel(e.time)} ${A.b(e.name)}${A.d(`  ${e.course}${e.cmid ? ` · cmid ${e.cmid}` : ""}`)}`).join("\n") || A.d(`nothing due in ${flags.days} days`));
      }
      case "assignments": {
        const ids = args[0] ? [(await core.findCourse(m, await userid(), args[0])).id] : [];
        const as = (await core.assignments(m, ids)).sort((a, b) => b.duedate - a.duedate);
        return out(as, () => as.map((a) => `${A.d(String(a.cmid).padStart(7))}  ${date(a.duedate).padEnd(22)} ${A.b(core.decodeHtml(a.name))}${A.d("  " + core.decodeHtml(a.course))}`).join("\n") || A.d("no assignments"));
      }
      case "assignment": {
        const s = await core.assignmentStatus(m, idArg("cmid"));
        return out(s, () => assignmentText(s));
      }
      case "submit": {
        const cmid = idArg("cmid");
        const paths = args.slice(1);
        for (const p of paths) if (!existsSync(p)) throw new UsageError(`no such file: ${p}`);
        const files = paths.map((p) => ({ name: basename(p), data: Bun.file(p) }));
        log(A.d(`uploading ${files.length} file(s)${flags.text !== undefined ? " + text" : ""} to cmid ${cmid}${flags.final ? " and submitting for grading" : " as draft"}…`));
        const s = await core.submitAssignment(m, cmid, { files, text: flags.text, final: flags.final });
        return out(s, () => `${A.g("✓")} ${s.name}: status ${s.status}; files ${s.files.join(", ") || "—"}${s.status === "draft" ? A.y("\n  draft only — rerun with --final when ready") : ""}`);
      }
      case "grades": {
        const courseid = args[0] ? (await core.findCourse(m, await userid(), args[0])).id : undefined;
        const gr = await core.grades(m, await userid(), courseid);
        return out(gr, () => gr.map((x) => "item" in x
          ? `${x.grade.padStart(8)} ${A.d(x.percentage.padStart(9))}  ${x.type === "course" ? A.b(x.item) : x.item}${x.feedback ? A.d("  — " + x.feedback) : ""}`
          : `${x.grade.padStart(8)}  ${x.course}`).join("\n"));
      }
      case "notifications": {
        const r = await core.notifications(m, await userid(), flags.n);
        return out(r, () => [A.d(`${r.unread} unread`), ...r.items.map((n) => `${n.read ? " " : A.y("●")} ${date(n.time).padEnd(22)} ${n.subject}`)].join("\n"));
      }
      case "messages": {
        const cs = await core.conversations(m, await userid(), flags.n);
        return out(cs, () => cs.map((c) => `${c.unread ? A.y(`(${c.unread})`) : "   "} ${A.b(c.name)}${c.last ? A.d(`  ${date(c.last.time)}: ${c.last.text.replace(/\s+/g, " ").slice(0, 80)}`) : ""}`).join("\n") || A.d("no conversations"));
      }
      case "forum": {
        const ds = await core.forumDiscussions(m, idArg("cmid"), flags.n);
        return out(ds, () => ds.map((d) => `${A.d(String(d.id).padStart(7))} ${date(d.time).padEnd(22)} ${A.b(d.subject)}${A.d(`  ${d.author} · ${d.replies} replies`)}`).join("\n") || A.d("no discussions"));
      }
      case "discussion": {
        const posts = await core.discussionPosts(m, idArg("discussion id"), flags.n);
        return out(posts, () => postsText(posts));
      }
      case "functions": {
        const s = await m.call<{ functions: { name: string }[] }>("core_webservice_get_site_info");
        const names = s.functions.map((f) => f.name).filter((n) => !args[0] || n.includes(args[0])).sort();
        return out(names, () => names.join("\n"));
      }
      case "call":
        return void console.log(JSON.stringify(await m.call(args[0]!, core.parseCallArgs(args.slice(1))), null, 2));
      default:
        throw new UsageError(`unknown ilearn command '${cmd}' — see thd ilearn help`);
    }
  });
}

export function assignmentText(s: core.AssignmentStatus): string {
  return [
    A.b(s.name) + A.d(`  ${s.course}`),
    `due ${date(s.duedate)}${s.duedate ? "  " + rel(s.duedate) : ""}${s.cutoffdate ? A.d(`  (cut-off ${date(s.cutoffdate)})`) : ""}`,
    `status ${s.status === "submitted" ? A.g(s.status) : A.y(s.status)} · grading ${s.gradingstatus}${s.locked ? A.r(" · locked") : ""}${s.canedit ? "" : A.d(" · read-only")}`,
    s.attachments.length ? `handouts: ${s.attachments.join(", ")}` : "",
    s.files.length ? `your files: ${s.files.join(", ")}` : "",
    ...s.text.map((t) => `your text: ${t}`),
    s.grade ? `grade: ${A.b(s.grade)}` : "",
    ...s.feedback.map((f) => `feedback: ${f}`),
    s.intro ? "\n" + s.intro : "",
  ].filter(Boolean).join("\n");
}

export function postsText(posts: core.Post[]): string {
  return posts.map((p) => `${A.b(p.subject)}${A.d(`  ${p.author} · ${date(p.time)} · post ${p.id}`)}\n${p.message}`).join("\n\n") || A.d("no posts");
}
