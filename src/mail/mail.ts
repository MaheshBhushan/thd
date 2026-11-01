/**
 * Mail actions (task=mail). Each function maps to the request the web UI sends for the
 * same button; see the comment on each for the observed endpoint.
 */
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { convert as htmlToText } from "html-to-text";
import { parseHTML } from "linkedom";
import { Client, WebmailError, type PageResult } from "./client.ts";
import { callsOf, messageRows, parseForms, serializeForm, type MessageRow } from "./protocol.ts";

export interface Folder {
  id: string;
  name: string;
  subscribed: boolean;
  /** Special folders (Inbox, Drafts, …) cannot be unsubscribed, renamed or deleted. */
  protected: boolean;
  special?: string;
  unread?: number;
  total?: number;
}

export interface Quota {
  used: number;
  total: number;
  percent: number;
  title: string;
}

/** Mail UI page (env: special folder names, server prefs), cached per client. */
const mailPageCache = new WeakMap<Client, Promise<PageResult>>();
function mailPage(c: Client): Promise<PageResult> {
  let p = mailPageCache.get(c);
  if (!p) {
    p = c.page({ _task: "mail", _mbox: "INBOX" });
    mailPageCache.set(c, p);
  }
  return p;
}

export async function mailEnv(c: Client): Promise<Record<string, unknown>> {
  return (await mailPage(c)).env;
}

/** Folder list from Settings → Folders (all folders incl. unsubscribed), unread from `getunread`. */
export async function folders(c: Client, opts: { counts?: boolean } = {}): Promise<Folder[]> {
  const page = await c.page({ _task: "settings", _action: "folders" });
  const { document } = parseHTML(page.html);
  const out: Folder[] = [];
  for (const li of document.querySelectorAll("li.mailbox")) {
    const box = li.querySelector('input[name="_subscribed[]"]');
    if (!box) continue; // the virtual root row
    const id = box.getAttribute("value") ?? "";
    const special = (li.getAttribute("class") ?? "").split(/\s+/).find((k: string) => ["inbox", "drafts", "sent", "junk", "trash", "archive"].includes(k));
    out.push({
      id,
      name: (li.querySelector("a")?.textContent ?? id).trim(),
      subscribed: box.hasAttribute("checked"),
      protected: box.hasAttribute("disabled"),
      ...(special ? { special } : {}),
    });
  }
  // getunread reports subscribed folders: this.set_unread_count(mbox, count, is_current)
  const unread = await c.ajax("mail", "getunread", { _page: 1 });
  for (const [mbox, n] of callsOf(unread, "set_unread_count")) {
    const f = out.find((x) => x.id === mbox);
    if (f) f.unread = Number(n);
  }
  if (opts.counts) {
    for (const f of out) {
      const r = await c.ajax("mail", "list", { _mbox: f.id, _page: 1, _layout: "widescreen" });
      f.total = Number(r.env.messagecount ?? 0);
    }
  }
  return out;
}

/** Quota from the page's `rcmail.set_quota({used,total,percent,…})` call (KiB). */
export async function quota(c: Client): Promise<Quota | null> {
  const q = callsOf(await mailPage(c), "set_quota")[0]?.[0] as Quota | undefined;
  return q ? { used: q.used, total: q.total, percent: q.percent, title: q.title } : null;
}

export interface ListOptions {
  mbox: string;
  page?: number;
  /** Sort column: none, date, arrival, from, to, subject, size; persisted server-side like the UI. */
  sort?: string;
  order?: "ASC" | "DESC";
  /** Quick-search text, matched against `headers`. */
  query?: string;
  /** subject,from,to,cc,bcc,body,text,replyto,followupto */
  headers?: string[];
  /** ALL, UNSEEN, SEEN, FLAGGED, UNFLAGGED, UNANSWERED, DELETED, UNDELETED, or a raw IMAP filter. */
  filter?: string;
  /** base (this folder), sub (with subfolders), all (all folders) */
  scope?: "base" | "sub" | "all";
  /** Age limit: 1W, 1M, 1Y (newer than) or -1W, -1M, -1Y (older than). */
  interval?: string;
  /** Toggle the saved list mode (threads/list), like the UI's list options. */
  threads?: boolean;
}

export interface ListResult {
  mbox: string;
  page: number;
  pages: number;
  total: number;
  rows: MessageRow[];
  searchId?: string;
}

/**
 * Message list. Plain listing: GET `_action=list&_mbox&_page[&_sort=col_ORDER]`.
 * Searching/filtering: GET `_action=search&_q&_headers&_filter&_scope&_interval&_mbox`, which
 * stores the result set server-side; further pages are `list` with `_search=<id>`.
 */
export async function list(c: Client, o: ListOptions): Promise<ListResult> {
  const page = o.page ?? 1;
  const searching = Boolean(o.query || (o.filter && o.filter !== "ALL") || o.interval || (o.scope && o.scope !== "base"));
  let searchId: string | undefined;
  if (o.threads !== undefined) {
    // set_list_options(): list request carrying _threads persists the list mode.
    await c.ajax("mail", "list", { _mbox: o.mbox, _page: 1, _threads: o.threads ? 1 : 0, _layout: "widescreen" });
  }
  // `_sort=<col>_<ORDER>` is saved as the user's sort pref; "none" saves an empty column (server order).
  const sort = o.sort ? `${o.sort === "none" ? "" : o.sort}_${o.order ?? "DESC"}` : undefined;
  let r;
  if (searching) {
    r = await c.ajax("mail", "search", {
      _q: o.query ?? "",
      _headers: o.query ? (o.headers?.length ? o.headers : ["subject", "from"]).join(",") : undefined,
      _filter: o.filter ?? "ALL",
      _scope: o.scope ?? "base",
      _interval: o.interval ?? "",
      _mbox: o.mbox,
      _layout: "widescreen",
      _sort: sort,
    });
    searchId = (r.env.search_request as string | undefined) ?? undefined;
    if (page > 1 && searchId) r = await c.ajax("mail", "list", { _mbox: o.mbox, _page: page, _search: searchId, _layout: "widescreen" });
  } else {
    r = await c.ajax("mail", "list", { _mbox: o.mbox, _page: page, _sort: sort, _layout: "widescreen", _refresh: 1 });
  }
  return {
    mbox: o.mbox,
    page: Number(r.env.current_page ?? page),
    pages: Number(r.env.pagecount ?? 0),
    total: Number(r.env.messagecount ?? 0),
    rows: messageRows(r, o.mbox),
    ...(searchId ? { searchId } : {}),
  };
}

/** Raw RFC 822 source: GET `_action=viewsource&_uid&_mbox` (`_save=1` is the .eml download). */
export async function source(c: Client, uid: number, mbox: string): Promise<Uint8Array> {
  const res = await c.download({ _task: "mail", _action: "viewsource", _uid: uid, _mbox: mbox });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new WebmailError(`message ${uid} not found in ${mbox}`);
  return bytes;
}

export interface MessageView {
  uid: number;
  mbox: string;
  messageId?: string;
  date?: string;
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  attachments: { index: number; filename: string; contentType: string; size: number; inline: boolean }[];
  headers: Record<string, string>;
}

const addr = (a: AddressObject | AddressObject[] | undefined): string => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a?.text ?? "");

export function viewOf(uid: number, mbox: string, m: ParsedMail): MessageView {
  const headers: Record<string, string> = {};
  for (const line of m.headerLines) {
    const i = line.line.indexOf(":");
    const name = line.line.slice(0, i);
    if (!(name in headers)) headers[name] = line.line.slice(i + 1).replace(/\r?\n\s+/g, " ").trim();
  }
  const text = m.text?.trim() || (m.html ? htmlToText(m.html, { wordwrap: 100, selectors: [{ selector: "img", format: "skip" }] }) : "");
  const view: MessageView = {
    uid,
    mbox,
    from: addr(m.from),
    to: addr(m.to),
    subject: m.subject ?? "",
    text,
    attachments: m.attachments.map((a, index) => ({ index: index + 1, filename: a.filename ?? `part-${index + 1}`, contentType: a.contentType, size: a.size, inline: a.contentDisposition === "inline" })),
    headers,
  };
  if (m.messageId) view.messageId = m.messageId;
  if (m.date) view.date = m.date.toISOString();
  if (m.cc) view.cc = addr(m.cc);
  if (m.replyTo) view.replyTo = m.replyTo.text;
  if (typeof m.html === "string") view.html = m.html;
  return view;
}

/** Fetch and parse a message; marks it read like opening it in the UI unless `peek`. */
export async function read(c: Client, uid: number, mbox: string, opts: { peek?: boolean } = {}): Promise<{ view: MessageView; parsed: ParsedMail }> {
  const raw = await source(c, uid, mbox);
  const parsed = await simpleParser(Buffer.from(raw));
  if (!opts.peek) await mark(c, [uid], mbox, "read");
  return { view: viewOf(uid, mbox, parsed), parsed };
}

export type Flag = "read" | "unread" | "flagged" | "unflagged" | "delete" | "undelete";
export const FLAGS: Flag[] = ["read", "unread", "flagged", "unflagged", "delete", "undelete"];

const uidParam = (uids: number[] | "*") => (uids === "*" ? "*" : uids.join(","));

/** POST `_action=mark&_uid&_flag&_mbox`. `*` marks the whole folder (Mark all as read). */
export async function mark(c: Client, uids: number[] | "*", mbox: string, flag: Flag): Promise<void> {
  await c.ajax("mail", "mark", { _uid: uidParam(uids), _flag: flag, _mbox: mbox, _quiet: 1 }, { post: true });
}

/** POST `_action=move&_uid&_target_mbox&_mbox`. */
export async function move(c: Client, uids: number[] | "*", mbox: string, target: string): Promise<string[]> {
  const r = await c.ajax("mail", "move", { _uid: uidParam(uids), _target_mbox: target, _mbox: mbox }, { post: true });
  return r.notices;
}

/** POST `_action=copy&_uid&_target_mbox&_mbox`. */
export async function copy(c: Client, uids: number[] | "*", mbox: string, target: string): Promise<string[]> {
  const r = await c.ajax("mail", "copy", { _uid: uidParam(uids), _target_mbox: target, _mbox: mbox }, { post: true });
  return r.notices;
}

/**
 * Delete as the UI does: flag for deletion if that pref is on, otherwise move to Trash, or
 * remove permanently (POST `_action=delete`) inside Trash, Junk with delete_junk, or when asked.
 */
export async function remove(c: Client, uids: number[] | "*", mbox: string, opts: { permanent?: boolean } = {}): Promise<string> {
  const env = await mailEnv(c);
  const trash = env.trash_mailbox as string | undefined;
  if (!opts.permanent && env.flag_for_deletion) {
    await mark(c, uids, mbox, "delete");
    return "flagged for deletion";
  }
  const permanent = opts.permanent || !trash || mbox === trash || (Boolean(env.delete_junk) && mbox === env.junk_mailbox);
  if (permanent) {
    await c.ajax("mail", "delete", { _uid: uidParam(uids), _mbox: mbox }, { post: true });
    return "deleted permanently";
  }
  await move(c, uids, mbox, trash);
  return `moved to ${trash}`;
}

/** archive plugin: POST `_action=plugin.move2archive&_uid&_mbox`. */
export async function archive(c: Client, uids: number[] | "*", mbox: string): Promise<string[]> {
  const r = await c.ajax("mail", "plugin.move2archive", { _uid: uidParam(uids), _mbox: mbox }, { post: true });
  return r.notices;
}

/** Empty a folder: POST `_action=purge&_mbox`. */
export async function purge(c: Client, mbox: string): Promise<string[]> {
  return (await c.ajax("mail", "purge", { _mbox: mbox }, { post: true })).notices;
}

/** Compact (expunge \Deleted messages): POST `_action=expunge&_mbox`. */
export async function expunge(c: Client, mbox: string): Promise<string[]> {
  return (await c.ajax("mail", "expunge", { _mbox: mbox }, { post: true })).notices;
}

/**
 * Redirect (bounce) a message unchanged. The UI first loads the framed bounce dialog
 * (`_action=bounce&_framed=1`, which allocates a compose `_id` holding the identity), then
 * POSTs that form's fields plus `_uid,_mbox` to `_action=bounce`.
 */
export async function bounce(c: Client, uid: number, mbox: string, to: string, cc = "", bcc = ""): Promise<string[]> {
  const page = await c.page({ _task: "mail", _action: "bounce", _uid: uid, _mbox: mbox, _framed: 1 });
  const form = parseForms(page.html).find((f) => f.fields.some((x) => x.name === "_id"));
  if (!form) throw new WebmailError(page.errors.join("; ") || `message ${uid} not found in ${mbox}`);
  const post: Record<string, string> = {};
  for (const [k, v] of serializeForm(form.fields)) if (k !== "_action" && k !== "_task") post[k] = v;
  Object.assign(post, { _to: to, _cc: cc, _bcc: bcc, _uid: String(uid), _mbox: mbox });
  return (await c.ajax("mail", "bounce", post, { post: true })).notices;
}

/** Check for new mail: POST `_action=check-recent&_mbox` → new rows + unread counts. */
export async function checkRecent(c: Client, mbox: string): Promise<{ rows: MessageRow[]; unread: Record<string, number> }> {
  const r = await c.ajax("mail", "check-recent", { _mbox: mbox, _list: 1, _folderlist: 1 }, { post: true });
  const unread: Record<string, number> = {};
  for (const [m, n] of callsOf(r, "set_unread_count")) unread[String(m)] = Number(n);
  return { rows: messageRows(r, mbox), unread };
}

/** Upload .eml/.mbox/.zip files into a folder: multipart POST `_action=import` with `_file[]`. */
export async function importMessages(c: Client, mbox: string, files: { name: string; data: Blob }[]): Promise<string[]> {
  // The server imports into the session's current folder, so select it first like the UI.
  await c.ajax("mail", "list", { _mbox: mbox, _page: 1, _layout: "widescreen" });
  const fd = new FormData();
  for (const f of files) fd.append("_file[]", f.data, f.name);
  const r = await c.ajax("mail", "import", { _mbox: mbox, _uploadid: `upload${Date.now()}`, _from: "" }, { body: fd });
  return r.notices;
}

/** zipdownload plugin: POST `_action=plugin.zipdownload.messages` with `_uid,_mbox,_mode=eml|mbox|maildir`. */
export async function zip(c: Client, mbox: string, uids: number[] | "*", mode: "eml" | "mbox" | "maildir"): Promise<Response> {
  return c.download({ _task: "mail", _action: "plugin.zipdownload.messages" }, { _uid: uidParam(uids), _mbox: mbox, _mode: mode });
}

/** Sender display name (or address) of a list row. */
export function fromText(r: MessageRow): string {
  const a = r.from[0];
  return a ? a.name || a.email : "";
}
