/**
 * `thd mail …` — THD Roundcube webmail (webmail.stud.th-deg.de).
 *
 * stdout is data, stderr is diagnostics. `--json` prints the whole result as JSON.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { A, LoginRequired, makeIO, need, pullFlag, pullVal, pullVals, readStdin, rejectStray, UsageError, type Globals } from "../common.ts";
import { InteractionRequired } from "../browser.ts";
import { Client, SessionExpired, WebmailError } from "./client.ts";
import * as mail from "./mail.ts";
import * as composeMod from "./compose.ts";
import * as contacts from "./contacts.ts";
import * as settings from "./settings.ts";
import { formFields, humanSize, messageTable, messageView, table } from "./render.ts";
import { clearSession, loadSession, saveSession, sessionFromCookieHeader, webmailLogin, type Session } from "./session.ts";
import type { HtmlForm } from "./protocol.ts";

export const MAIL_HELP = `thd mail — THD webmail (Roundcube)

Account
  status                          account, quota, session

Reading
  folders [--counts]              all folders with unread (and total) counts
  list [FOLDER] [-p N] [--sort none|date|arrival|from|to|subject|size] [--asc]
       [--unread|--flagged|--unanswered|--deleted|--filter IMAP] [--since 1W|1M|1Y] [--before 1W|1M|1Y]
       [--threads|--no-threads]
  search QUERY [-f FOLDER] [--in subject,from,to,cc,bcc,body,text] [--subfolders|--all-folders]
       [--unread|--flagged|…] [--since …] [-p N]
  read UID [-f FOLDER] [--headers] [--html] [--peek]     (--peek leaves it unread)
  source UID [-f FOLDER] [-o FILE]                       raw .eml
  save UID [N…] [-f FOLDER] [-o DIR]                     save attachments (all, or numbers from read)
  check [FOLDER]                                         check for new mail
  export FOLDER [UID…] [--mode mbox|eml|maildir] -o FILE.zip

Organising (UID… may be "all")
  mark read|unread|flagged|unflagged|deleted|undeleted UID… [-f FOLDER]
  mark-all-read [FOLDER]
  move TARGET UID… [-f FOLDER]      copy TARGET UID… [-f FOLDER]
  delete UID… [-f FOLDER] [--permanent]                  to Trash unless already there
  archive UID… [-f FOLDER]
  empty FOLDER                      permanently delete everything in FOLDER
  compact FOLDER                    expunge messages flagged deleted
  import FOLDER FILE…               upload .eml/.mbox/.zip into FOLDER

Writing  (body: --body TEXT | --body-file FILE | stdin)
  send --to ADDR [--cc] [--bcc] [--subject S] [--attach FILE]… [--from IDENTITY] [--html]
       [--priority lowest|low|normal|high|highest] [--receipt] [--dsn] [--reply-to ADDR]
       [--save-to FOLDER|--no-save] [--draft]
  reply UID [-f FOLDER] [--all|--list] [send options]    quotes the original below your text
  forward UID --to ADDR [-f FOLDER] [--as-attachment] [send options]
  draft UID [send options] [--draft]                     open a draft, apply changes, send (or re-save)
  resend UID [-f FOLDER] [send options]                  "Edit as new"
  bounce UID --to ADDR [--cc] [--bcc] [-f FOLDER]        redirect unchanged

Contacts  (sources: 0 personal, 1 collected, 2 trusted, thd directory)
  contacts sources
  contacts list [--source S] [--group GID] [-p N]
  contacts search QUERY [--source S] [-p N]
  contacts show CID [--source S] [--vcard]
  contacts add [--source S] [--group GID] [contact fields]
  contacts edit CID [--source S] [contact fields]
  contacts delete CID… [--source S]
  contacts copy|move CID… --to SOURCE [--to-group GID] [--source S]
  contacts export [CID…] [--source S] [--group GID] [-o FILE]
  contacts import FILE… [--source S] [--replace]
  contact fields: --first --last --middle --prefix --suffix --name --nickname --org --dept --title
                  --email ADDR[:home|work|other]… --phone NUM[:mobile|work|…]… --birthday --gender --notes
                  --set FIELD=VALUE (any form field)
  groups [--source S]               groups create NAME | rename GID NAME | delete GID |
                                    add GID CID… | remove GID CID…   (all take --source, default 0)

Settings  (FIELD=VALUE edits; FIELD=@file reads the value from a file)
  prefs                             list sections
  prefs SECTION [--choices]         show fields
  prefs SECTION FIELD=VALUE…        change
  identities                        identity show ID | identity set ID FIELD=VALUE… |
                                    identity add FIELD=VALUE… | identity delete ID
  responses                         response show ID | response add FIELD=VALUE… |
                                    response set ID FIELD=VALUE… | response delete ID
  folder create NAME [--parent P] | rename FOLDER NEWNAME | delete FOLDER | info FOLDER |
         subscribe FOLDER | unsubscribe FOLDER | set FOLDER FIELD=VALUE…
  share FOLDER | share set FOLDER USER RIGHTS | share remove FOLDER USER   (rights: lrswipkxtea)
  filters [--set S]                 server-side filters
  filter show ID | filter add FIELD=VALUE… | filter set ID FIELD=VALUE… [--choices]
         enable ID | disable ID | delete ID | move ID POSITION
  sieve [--set S]                   print the raw Sieve script;  sieve put FILE [--set S]
  filtersets                        filterset activate|deactivate|delete NAME | filterset add FIELD=VALUE…

Exit codes: 0 ok · 1 error · 2 sign-in needed · 64 bad usage.`;

// ---- argv helpers -----------------------------------------------------------------------

function uidsOf(list: string[]): number[] | "*" {
  if (list.length === 1 && (list[0] === "all" || list[0] === "*")) return "*";
  if (!list.length) throw new UsageError("missing UID(s)");
  return list.flatMap((s) => s.split(",")).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`not a message UID: ${s}`);
    return n;
  });
}

function oneUid(s: string | undefined): number {
  const u = uidsOf([need(s, "UID")]);
  if (u === "*" || u.length !== 1) throw new UsageError("expected a single UID");
  return u[0]!;
}

async function editsOf(args: string[]): Promise<Record<string, string>> {
  const edits: Record<string, string> = {};
  for (const a of args) {
    const i = a.indexOf("=");
    if (i <= 0) throw new UsageError(`expected FIELD=VALUE, got "${a}"`);
    const v = a.slice(i + 1);
    edits[a.slice(0, i)] = v.startsWith("@") && v.length > 1 ? await readFile(v.slice(1), "utf8") : v;
  }
  return edits;
}

// ---- session & output -------------------------------------------------------------------

let globals: Globals = { json: false, quiet: false };
const log = (m: string) => makeIO(globals).log(m);
const out = (data: unknown, human: () => string) => makeIO(globals).out(data, human);

/** Browser sign-in that becomes LoginRequired when a person is needed but unavailable. */
async function signIn<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InteractionRequired) throw new LoginRequired(e.message);
    throw e;
  }
}

/** Webmail client from the saved session; signs in (and re-signs after expiry) automatically. */
export async function mailClient(g: Globals): Promise<Client> {
  const relogin = () => {
    makeIO(g).log(A.d("signing in to webmail…"));
    return signIn(() => webmailLogin({ log: makeIO(g).log }));
  };
  let s = await loadSession();
  if (!s) {
    s = await relogin();
    await saveSession(s);
  }
  return new Client(s, { save: saveSession, relogin });
}

const client = () => mailClient(globals);

const done = (notices: string[], fallback: string) => out({ ok: true, messages: notices }, () => (notices.length ? notices : [fallback]).join("\n"));

function showForm(form: HtmlForm, choices: boolean): void {
  out(settings.visibleFields(form), () => formFields(form, { choices }));
}

// ---- body/attachment input --------------------------------------------------------------

async function composeInput(args: string[]): Promise<composeMod.ComposeInput> {
  const input: composeMod.ComposeInput = {};
  const to = pullVals(args, "--to");
  const cc = pullVals(args, "--cc");
  const bcc = pullVals(args, "--bcc");
  if (to.length) input.to = to.join(", ");
  if (cc.length) input.cc = cc.join(", ");
  if (bcc.length) input.bcc = bcc.join(", ");
  input.subject = pullVal(args, "--subject", "-s");
  input.replyTo = pullVal(args, "--reply-to");
  input.followupTo = pullVal(args, "--followup-to");
  input.from = pullVal(args, "--from");
  const prio = pullVal(args, "--priority");
  if (prio) {
    if (!["lowest", "low", "normal", "high", "highest"].includes(prio)) throw new UsageError("--priority: lowest|low|normal|high|highest");
    input.priority = prio as composeMod.ComposeInput["priority"];
  }
  if (pullFlag(args, "--receipt")) input.receipt = true;
  if (pullFlag(args, "--dsn")) input.dsn = true;
  if (pullFlag(args, "--html")) input.html = true;
  if (pullFlag(args, "--draft")) input.draft = true;
  const saveTo = pullVal(args, "--save-to");
  if (pullFlag(args, "--no-save")) input.saveTo = "";
  else if (saveTo !== undefined) input.saveTo = saveTo;
  const body = pullVal(args, "--body", "-b");
  const bodyFile = pullVal(args, "--body-file");
  const attach = pullVals(args, "--attach", "-a");
  if (body !== undefined) input.body = body;
  else if (bodyFile) input.body = bodyFile === "-" ? await readStdin() : await readFile(bodyFile, "utf8");
  else if (!process.stdin.isTTY) input.body = await readStdin();
  if (attach.length) {
    input.attachments = [];
    for (const p of attach) {
      const f = Bun.file(p);
      if (!(await f.exists())) throw new UsageError(`attachment not found: ${p}`);
      input.attachments.push({ name: basename(p), data: f });
    }
  }
  return input;
}

async function filesOf(paths: string[]): Promise<{ name: string; data: Blob }[]> {
  if (!paths.length) throw new UsageError("missing FILE(s)");
  const files = [];
  for (const p of paths) {
    const f = Bun.file(p);
    if (!(await f.exists())) throw new UsageError(`file not found: ${p}`);
    files.push({ name: basename(p), data: f });
  }
  return files;
}

async function writeOut(path: string | undefined, data: Uint8Array | string): Promise<void> {
  if (!path || path === "-") process.stdout.write(data);
  else {
    await writeFile(path, data);
    log(`wrote ${path}`);
  }
}

// ---- commands ---------------------------------------------------------------------------

function listOptions(args: string[], mbox: string): mail.ListOptions {
  const o: mail.ListOptions = { mbox };
  const page = pullVal(args, "--page", "-p");
  if (page) {
    o.page = Number(page);
    if (!Number.isInteger(o.page) || o.page < 1) throw new UsageError("--page must be a positive integer");
  }
  const sort = pullVal(args, "--sort");
  if (sort) {
    if (!["none", "date", "arrival", "from", "to", "subject", "size", "cc"].includes(sort)) throw new UsageError("--sort: none|date|arrival|from|to|cc|subject|size");
    o.sort = sort;
    o.order = pullFlag(args, "--asc") ? "ASC" : "DESC";
  }
  const filters: string[] = [];
  if (pullFlag(args, "--unread")) filters.push("UNSEEN");
  if (pullFlag(args, "--flagged")) filters.push("FLAGGED");
  if (pullFlag(args, "--unanswered")) filters.push("UNANSWERED");
  if (pullFlag(args, "--deleted")) filters.push("DELETED");
  const raw = pullVal(args, "--filter");
  if (raw) filters.push(raw);
  if (filters.length) o.filter = filters.join(" ");
  const since = pullVal(args, "--since");
  const before = pullVal(args, "--before");
  for (const v of [since, before]) if (v && !/^[1-9]\d*[WMY]$/i.test(v)) throw new UsageError("--since/--before take 1W, 1M, 1Y");
  if (since) o.interval = since.toUpperCase();
  if (before) o.interval = `-${before.toUpperCase()}`;
  if (pullFlag(args, "--subfolders")) o.scope = "sub";
  if (pullFlag(args, "--all-folders")) o.scope = "all";
  if (pullFlag(args, "--threads")) o.threads = true;
  if (pullFlag(args, "--no-threads")) o.threads = false;
  const inHeaders = pullVal(args, "--in");
  if (inHeaders) {
    const valid = ["subject", "from", "to", "cc", "bcc", "body", "text", "replyto", "followupto"];
    o.headers = inHeaders.split(",").map((s) => s.trim());
    const bad = o.headers.filter((h) => !valid.includes(h));
    if (bad.length) throw new UsageError(`--in: ${valid.join(",")}`);
  }
  return o;
}

async function cmdList(args: string[], search: boolean): Promise<void> {
  const folder = pullVal(args, "--folder", "-f");
  const o = listOptions(args, folder ?? "INBOX");
  rejectStray(args);
  if (search) o.query = need(args.join(" "), "QUERY");
  else if (args.length > 1) throw new UsageError(`unexpected argument ${args[1]}`);
  else if (args[0]) o.mbox = args[0];
  const c = await client();
  const r = await mail.list(c, o);
  out(r, () => {
    const head = `${r.mbox} — page ${r.page}/${Math.max(r.pages, 1)}, ${r.total} message${r.total === 1 ? "" : "s"}`;
    return r.rows.length ? `${head}\n${messageTable(r.rows, o.scope === "all" || o.scope === "sub")}` : `${head}\n(no messages)`;
  });
}

async function cmdMail(cmd: string, args: string[]): Promise<boolean> {
  const folderOf = () => pullVal(args, "--folder", "-f") ?? "INBOX";
  switch (cmd) {
    case "folders": {
      const counts = pullFlag(args, "--counts");
      rejectStray(args);
      const f = await mail.folders(await client(), { counts });
      out(f, () =>
        table(
          f.map((x) => [x.id, String(x.unread ?? (x.subscribed ? 0 : "-")), ...(counts ? [String(x.total ?? "")] : []), x.subscribed ? "" : "unsubscribed"]),
          ["FOLDER", "UNREAD", ...(counts ? ["TOTAL"] : []), ""],
        ),
      );
      return true;
    }
    case "list":
    case "search":
      await cmdList(args, cmd === "search");
      return true;
    case "read": {
      const mbox = folderOf();
      const headers = pullFlag(args, "--headers");
      const html = pullFlag(args, "--html");
      const peek = pullFlag(args, "--peek");
      rejectStray(args);
      const { view } = await mail.read(await client(), oneUid(args[0]), mbox, { peek });
      out(view, () => messageView(view, { headers, html }));
      return true;
    }
    case "source": {
      const mbox = folderOf();
      const o = pullVal(args, "--output", "-o");
      rejectStray(args);
      await writeOut(o, await mail.source(await client(), oneUid(args[0]), mbox));
      return true;
    }
    case "save": {
      const mbox = folderOf();
      const dir = pullVal(args, "--output", "-o") ?? ".";
      rejectStray(args);
      const uid = oneUid(args.shift());
      const which = args.map(Number);
      const { parsed } = await mail.read(await client(), uid, mbox, { peek: true });
      await mkdir(dir, { recursive: true });
      const saved: string[] = [];
      for (const [i, a] of parsed.attachments.entries()) {
        if (which.length && !which.includes(i + 1)) continue;
        const name = basename(a.filename ?? `part-${i + 1}`).replace(/^\.+/, "_") || `part-${i + 1}`;
        const path = join(dir, name);
        await writeFile(path, a.content);
        saved.push(path);
      }
      if (!saved.length) throw new WebmailError("no matching attachments");
      out(saved, () => saved.join("\n"));
      return true;
    }
    case "check": {
      rejectStray(args);
      const r = await mail.checkRecent(await client(), args[0] ?? "INBOX");
      out(r, () => `${Object.entries(r.unread).map(([k, v]) => `${k}: ${v} unread`).join("\n")}${r.rows.length ? `\n${messageTable(r.rows)}` : ""}`);
      return true;
    }
    case "export": {
      const mode = (pullVal(args, "--mode") ?? "mbox") as "mbox" | "eml" | "maildir";
      if (!["mbox", "eml", "maildir"].includes(mode)) throw new UsageError("--mode: mbox|eml|maildir");
      const o = pullVal(args, "--output", "-o");
      rejectStray(args);
      const folder = need(args.shift(), "FOLDER");
      const res = await mail.zip(await client(), folder, args.length ? uidsOf(args) : "*", mode);
      await writeOut(o ?? `${folder.replace(/\W+/g, "_")}.zip`, new Uint8Array(await res.arrayBuffer()));
      return true;
    }
    case "mark": {
      const mbox = folderOf();
      rejectStray(args);
      const flagArg = need(args.shift(), "FLAG");
      const flag = ({ deleted: "delete", undeleted: "undelete" } as Record<string, mail.Flag>)[flagArg] ?? (flagArg as mail.Flag);
      if (!mail.FLAGS.includes(flag)) throw new UsageError("FLAG: read|unread|flagged|unflagged|deleted|undeleted");
      await mail.mark(await client(), uidsOf(args), mbox, flag);
      done([], `marked ${flagArg}`);
      return true;
    }
    case "mark-all-read": {
      rejectStray(args);
      await mail.mark(await client(), "*", args[0] ?? "INBOX", "read");
      done([], `all messages in ${args[0] ?? "INBOX"} marked read`);
      return true;
    }
    case "move":
    case "copy": {
      const mbox = folderOf();
      rejectStray(args);
      const target = need(args.shift(), "TARGET folder");
      const fn = cmd === "move" ? mail.move : mail.copy;
      done(await fn(await client(), uidsOf(args), mbox, target), `${cmd === "move" ? "moved" : "copied"} to ${target}`);
      return true;
    }
    case "delete": {
      const mbox = folderOf();
      const permanent = pullFlag(args, "--permanent");
      rejectStray(args);
      const what = await mail.remove(await client(), uidsOf(args), mbox, { permanent });
      done([], what);
      return true;
    }
    case "archive": {
      const mbox = folderOf();
      rejectStray(args);
      done(await mail.archive(await client(), uidsOf(args), mbox), "archived");
      return true;
    }
    case "empty":
      rejectStray(args);
      done(await mail.purge(await client(), need(args[0], "FOLDER")), `${args[0]} emptied`);
      return true;
    case "compact":
      rejectStray(args);
      done(await mail.expunge(await client(), need(args[0], "FOLDER")), `${args[0]} compacted`);
      return true;
    case "import": {
      rejectStray(args);
      const folder = need(args.shift(), "FOLDER");
      done(await mail.importMessages(await client(), folder, await filesOf(args)), `imported into ${folder}`);
      return true;
    }
    case "send":
    case "reply":
    case "forward":
    case "draft":
    case "resend": {
      const mbox = pullVal(args, "--folder", "-f");
      const all = pullFlag(args, "--all") ? "all" : pullFlag(args, "--list") ? "list" : undefined;
      const asAttachment = pullFlag(args, "--as-attachment");
      const input = await composeInput(args);
      rejectStray(args);
      let mode: composeMod.ComposeMode;
      if (cmd === "send") mode = { kind: "new" };
      else {
        const uid = oneUid(args.shift());
        if (cmd === "reply") mode = { kind: "reply", uid, mbox: mbox ?? "INBOX", ...(all ? { all } : {}) };
        else if (cmd === "forward") mode = { kind: "forward", uid, mbox: mbox ?? "INBOX", asAttachment };
        else if (cmd === "draft") mode = { kind: "draft", uid, mbox: mbox ?? "Drafts" };
        else mode = { kind: "edit", uid, mbox: mbox ?? "INBOX" };
      }
      if (args.length) throw new UsageError(`unexpected argument ${args[0]}`);
      if (cmd === "send" && !input.draft && !input.to && !input.cc && !input.bcc) throw new UsageError("send needs --to, --cc or --bcc");
      if (cmd === "forward" && !input.draft && !input.to) throw new UsageError("forward needs --to");
      const r = await composeMod.compose(await client(), mode, input);
      out(r, () => r.notices.join("\n"));
      return true;
    }
    case "bounce": {
      const mbox = folderOf();
      const to = pullVals(args, "--to").join(", ");
      const cc = pullVals(args, "--cc").join(", ");
      const bcc = pullVals(args, "--bcc").join(", ");
      rejectStray(args);
      if (!to && !cc && !bcc) throw new UsageError("bounce needs --to");
      done(await mail.bounce(await client(), oneUid(args[0]), mbox, to, cc, bcc), "message redirected");
      return true;
    }
  }
  return false;
}

async function contactInput(args: string[]): Promise<contacts.ContactInput> {
  const i: contacts.ContactInput = {};
  const map: [keyof contacts.ContactInput, string][] = [
    ["first", "--first"], ["last", "--last"], ["middle", "--middle"], ["prefix", "--prefix"], ["suffix", "--suffix"],
    ["name", "--name"], ["nickname", "--nickname"], ["organization", "--org"], ["department", "--dept"], ["jobtitle", "--title"],
    ["birthday", "--birthday"], ["gender", "--gender"], ["notes", "--notes"],
  ];
  for (const [k, flag] of map) {
    const v = pullVal(args, flag);
    if (v !== undefined) (i as Record<string, unknown>)[k] = v;
  }
  const emails = pullVals(args, "--email");
  const phones = pullVals(args, "--phone");
  if (emails.length) i.emails = emails;
  if (phones.length) i.phones = phones;
  const sets = pullVals(args, "--set");
  if (sets.length) i.extra = await editsOf(sets);
  return i;
}

async function cmdContacts(args: string[]): Promise<void> {
  const sub = args.shift() ?? "list";
  const source = pullVal(args, "--source");
  const group = pullVal(args, "--group");
  const pageArg = pullVal(args, "--page", "-p");
  const page = pageArg ? Number(pageArg) : undefined;
  const c = await client();
  const rowsOut = (r: contacts.ContactPage) =>
    out(r, () => (r.rows.length ? table(r.rows.map((x) => [x.cid, x.name, x.email ?? "", x.type === "group" ? "group" : ""]), ["ID", "NAME", "EMAIL", ""]) : "(no contacts)") + (r.pages > 1 ? `\npage ${r.page}/${r.pages}` : ""));
  switch (sub) {
    case "sources": {
      rejectStray(args);
      const r = await contacts.sources(c);
      out(r, () => table(r.sources.map((s) => [s.id, s.name, s.readonly ? "read-only" : "writable", s.groups ? `${r.groups.filter((g) => g.source === s.id).length} groups` : ""]), ["ID", "NAME", "", ""]));
      return;
    }
    case "list":
      rejectStray(args);
      rowsOut(await contacts.list(c, { source: source ?? "0", group, page }));
      return;
    case "search":
      rejectStray(args);
      rowsOut(await contacts.search(c, need(args.join(" "), "QUERY"), { source, group, page }));
      return;
    case "show": {
      const vcard = pullFlag(args, "--vcard");
      rejectStray(args);
      const ref = await contacts.resolveCid(c, need(args[0], "CID"), source);
      const text = await contacts.exportVcf(c, ref);
      if (vcard) return void process.stdout.write(text);
      const cards = contacts.parseVcards(text);
      out(cards, () => cards.map((card) => Object.entries(card).map(([k, v]) => `${k.padEnd(12)} ${v.join("\n" + " ".repeat(13))}`).join("\n")).join("\n\n"));
      return;
    }
    case "add": {
      const input = await contactInput(args);
      rejectStray(args);
      done(await contacts.add(c, source ?? "0", input, group), "contact added");
      return;
    }
    case "edit": {
      const input = await contactInput(args);
      rejectStray(args);
      const ref = await contacts.resolveCid(c, need(args[0], "CID"), source);
      done(await contacts.edit(c, ref.cid, ref.source, input), "contact saved");
      return;
    }
    case "delete": {
      rejectStray(args);
      if (!args.length) throw new UsageError("missing CID(s)");
      const ref = await contacts.resolveCid(c, args[0]!, source);
      const ids = await Promise.all(args.map(async (a) => (await contacts.resolveCid(c, a, ref.source)).cid));
      done(await contacts.remove(c, ids, ref.source), "deleted");
      return;
    }
    case "copy":
    case "move": {
      const to = need(pullVal(args, "--to"), "--to SOURCE");
      const toGroup = pullVal(args, "--to-group");
      rejectStray(args);
      if (!args.length) throw new UsageError("missing CID(s)");
      const ref = await contacts.resolveCid(c, args[0]!, source);
      const ids = await Promise.all(args.map(async (a) => (await contacts.resolveCid(c, a, ref.source)).cid));
      done(await contacts.transfer(c, sub, ids, ref.source, to, toGroup), sub === "copy" ? "copied" : "moved");
      return;
    }
    case "export": {
      const o = pullVal(args, "--output", "-o");
      rejectStray(args);
      await writeOut(o, await contacts.exportVcf(c, { source: source ?? "0", group, ...(args.length ? { cid: args.join(",") } : {}) }));
      return;
    }
    case "import": {
      const replace = pullFlag(args, "--replace");
      rejectStray(args);
      done(await contacts.importVcf(c, source ?? "0", await filesOf(args), { replace }), "imported");
      return;
    }
  }
  throw new UsageError(`unknown contacts command ${sub}`);
}

async function cmdGroups(args: string[]): Promise<void> {
  const sub = args.shift() ?? "list";
  const source = pullVal(args, "--source") ?? "0";
  rejectStray(args);
  const c = await client();
  switch (sub) {
    case "list": {
      const r = await contacts.sources(c);
      const g = r.groups.filter((x) => x.source === source);
      out(g, () => (g.length ? table(g.map((x) => [x.id, x.name]), ["GID", "NAME"]) : "(no groups)"));
      return;
    }
    case "create":
      return done(await contacts.groupCreate(c, source, need(args[0], "NAME")), "group created");
    case "rename":
      return done(await contacts.groupRename(c, source, need(args[0], "GID"), need(args[1], "NAME")), "group renamed");
    case "delete":
      return done(await contacts.groupDelete(c, source, need(args[0], "GID")), "group deleted");
    case "add":
    case "remove": {
      const gid = need(args.shift(), "GID");
      if (!args.length) throw new UsageError("missing CID(s)");
      return done(await contacts.groupMembers(c, sub === "add" ? "add" : "del", source, gid, args), "group updated");
    }
  }
  throw new UsageError(`unknown groups command ${sub}`);
}

async function cmdSettings(cmd: string, args: string[]): Promise<boolean> {
  const choices = pullFlag(args, "--choices");
  switch (cmd) {
    case "prefs": {
      rejectStray(args);
      const c = await client();
      const section = args.shift();
      if (!section) {
        const s = await settings.prefSections(c);
        out(s, () => table(s.map((x) => [x.id, x.name]), ["SECTION", "NAME"]));
        return true;
      }
      const form = await settings.prefsForm(c, section);
      if (!args.length) showForm(form, choices);
      else done(await settings.submitForm(c, form, await editsOf(args)), "saved");
      return true;
    }
    case "identities":
    case "responses": {
      rejectStray(args);
      const c = await client();
      const rows = cmd === "identities" ? await settings.identities(c) : await settings.responses(c);
      out(rows, () => (rows.length ? table(rows.map((r) => [r.id, r.text]), ["ID", cmd === "identities" ? "IDENTITY" : "NAME"]) : `(no ${cmd})`));
      return true;
    }
    case "identity":
    case "response": {
      rejectStray(args);
      const c = await client();
      const sub = need(args.shift(), "subcommand");
      const formFor = cmd === "identity" ? settings.identityForm : settings.responseForm;
      if (sub === "show") showForm(await formFor(c, need(args[0], "ID")), choices);
      else if (sub === "set") {
        const form = await formFor(c, need(args.shift(), "ID"));
        done(await settings.submitForm(c, form, await editsOf(args)), "saved");
      } else if (sub === "add") done(await settings.submitForm(c, await formFor(c), await editsOf(args)), "added");
      else if (sub === "delete") done(await (cmd === "identity" ? settings.deleteIdentity : settings.deleteResponse)(c, need(args[0], "ID")), "deleted");
      else throw new UsageError(`unknown ${cmd} command ${sub}`);
      return true;
    }
    case "folder": {
      const parent = pullVal(args, "--parent");
      rejectStray(args);
      const sub = need(args.shift(), "subcommand");
      const c = await client();
      const name = need(args.shift(), "FOLDER");
      switch (sub) {
        case "create":
          done(await settings.createFolder(c, name, parent ?? ""), `created ${name}`);
          break;
        case "rename":
          done(await settings.renameFolder(c, name, need(args[0], "NEWNAME"), parent), "renamed");
          break;
        case "delete":
          done(await settings.deleteFolder(c, name), `deleted ${name}`);
          break;
        case "subscribe":
        case "unsubscribe":
          done(await settings.subscribe(c, name, sub === "subscribe"), `${sub}d ${name}`);
          break;
        case "info": {
          const i = await settings.folderInfo(c, name);
          const { form, ...rest } = i;
          out({ ...rest, fields: settings.visibleFields(form).filter((f) => !f.name.startsWith("acl") && f.name !== "usertype") }, () =>
            `${name}: ${i.messages} messages, ${i.size}\n${formFields({ ...form, fields: form.fields.filter((f) => !f.name.startsWith("acl") && f.name !== "usertype") })}`,
          );
          break;
        }
        case "set":
          done(await settings.submitForm(c, await settings.folderForm(c, name), await editsOf(args)), "saved");
          break;
        default:
          throw new UsageError(`unknown folder command ${sub}`);
      }
      return true;
    }
    case "share": {
      rejectStray(args);
      const c = await client();
      if (args[0] === "set") {
        const [, mbox, user, rights] = args;
        done(await settings.aclSet(c, need(mbox, "FOLDER"), need(user, "USER"), need(rights, "RIGHTS")), "sharing saved");
      } else if (args[0] === "remove") {
        done(await settings.aclDelete(c, need(args[1], "FOLDER"), need(args[2], "USER")), "sharing removed");
      } else {
        const i = await settings.folderInfo(c, need(args[0], "FOLDER"));
        const acl = i.acl;
        out(acl, () => (Object.keys(acl).length ? table(Object.entries(acl).map(([u, r]) => [u, String(r)]), ["USER", "RIGHTS"]) : "(not shared)"));
      }
      return true;
    }
    case "filters": {
      const set = pullVal(args, "--set");
      rejectStray(args);
      const r = await settings.filters(await client(), set);
      out(r, () => `set ${r.set}\n${r.filters.length ? table(r.filters.map((f) => [f.id, f.enabled ? "on" : "off", f.name]), ["ID", "", "NAME"]) : "(no filters)"}`);
      return true;
    }
    case "filter": {
      const set = pullVal(args, "--set");
      rejectStray(args);
      const sub = need(args.shift(), "subcommand");
      const c = await client();
      switch (sub) {
        case "show":
          showForm(await settings.filterForm(c, need(args[0], "ID"), set), choices);
          break;
        case "add":
          if (!args.length) showForm(await settings.filterForm(c, undefined, set), choices);
          else done(await settings.submitForm(c, await settings.filterForm(c, undefined, set), await editsOf(args)), "filter added");
          break;
        case "set": {
          const form = await settings.filterForm(c, need(args.shift(), "ID"), set);
          done(await settings.submitForm(c, form, await editsOf(args)), "filter saved");
          break;
        }
        case "enable":
        case "disable":
          done(await settings.setFilterEnabled(c, need(args[0], "ID"), sub === "enable", set), `filter ${sub}d`);
          break;
        case "delete":
          done(await settings.deleteFilter(c, need(args[0], "ID"), set), "filter deleted");
          break;
        case "move":
          done(await settings.moveFilter(c, need(args[0], "ID"), need(args[1], "POSITION"), set), "filter moved");
          break;
        default:
          throw new UsageError(`unknown filter command ${sub}`);
      }
      return true;
    }
    case "sieve": {
      const set = pullVal(args, "--set");
      rejectStray(args);
      const c = await client();
      const form = await settings.rawScriptForm(c, set);
      if (args[0] === "put") {
        const path = need(args[1], "FILE");
        const script = path === "-" ? await readStdin() : await readFile(path, "utf8");
        done(await settings.submitForm(c, form, { rawsetcontent: script }), "script saved");
      } else {
        const script = form.fields.find((f) => f.name === "rawsetcontent")?.value ?? "";
        out({ script }, () => script);
      }
      return true;
    }
    case "filtersets": {
      rejectStray(args);
      const s = await settings.filterSets(await client());
      out(s, () => table(s.map((x) => [x.name, x.active ? "active" : ""]), ["SET", ""]));
      return true;
    }
    case "filterset": {
      rejectStray(args);
      const sub = need(args.shift(), "subcommand");
      const c = await client();
      if (sub === "add") {
        const form = await settings.newSetForm(c);
        if (!args.length) showForm(form, choices);
        else done(await settings.submitForm(c, form, await editsOf(args)), "filter set added");
      } else {
        const act = ({ activate: "setact", deactivate: "deact", delete: "setdel" } as const)[sub as "activate"];
        if (!act) throw new UsageError(`unknown filterset command ${sub}`);
        done(await settings.setAction(c, act, need(args[0], "NAME")), `${sub}d`);
      }
      return true;
    }
  }
  return false;
}

/** Sign in via the shared browser, or from a pasted Cookie header (`--cookie`). */
export async function webmailSignIn(g: Globals, opts: { headed?: boolean; cookieHeader?: string }): Promise<Session> {
  const { log } = makeIO(g);
  let s: Session;
  if (opts.cookieHeader !== undefined) {
    const partial = sessionFromCookieHeader(opts.cookieHeader);
    const probe = new Client({ ...partial, token: "" });
    const page = await probe.page({ _task: "mail" });
    const token = page.env.request_token as string | undefined;
    if (!token) throw new WebmailError("cookies did not open a webmail session");
    s = { ...probe.session, token };
  } else {
    s = await signIn(() => webmailLogin({ headed: opts.headed, log }));
  }
  await saveSession(s);
  s.user = (await settings.identities(new Client(s, { save: saveSession })))[0]?.text;
  await saveSession(s);
  return s;
}

/** End the Roundcube session server-side and forget it locally. */
export async function webmailLogout(): Promise<void> {
  const s = await loadSession();
  if (s) {
    // Server-side logout redirects to the Microsoft sign-out page, which ends our interest.
    await new Client(s).request({ _task: "logout", _token: s.token }).catch((e) => {
      if (!(e instanceof SessionExpired)) throw e;
    });
  }
  await clearSession();
}

export async function mailMain(args: string[], g: Globals): Promise<void> {
  globals = g;
  if (!args.length || args[0] === "help") return void console.log(MAIL_HELP);
  const cmd = args.shift()!;
  if (cmd === "status") {
    rejectStray(args);
    const c = await mailClient(g);
    const [q, ids] = await Promise.all([mail.quota(c), settings.identities(c)]);
    const st = { user: ids.map((i) => i.text), quota: q, session: { since: c.session.createdAt } };
    return out(st, () => [`account  ${st.user.join(", ")}`, q ? `quota    ${humanSize(q.used * 1024)} of ${humanSize(q.total * 1024)} (${q.percent}%)` : "", `session  since ${st.session.since}`].filter(Boolean).join("\n"));
  }
  if (cmd === "contacts") await cmdContacts(args);
  else if (cmd === "groups") await cmdGroups(args);
  else if (!((await cmdMail(cmd, args)) || (await cmdSettings(cmd, args)))) throw new UsageError(`unknown mail command ${cmd} (see thd mail help)`);
}
