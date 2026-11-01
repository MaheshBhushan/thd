/**
 * Address book (task=addressbook).
 *
 * Sources: 0 Personal Addresses (writable, groups), 1 Collected Recipients, 2 Trusted Senders,
 * `thd` the university LDAP directory (read-only, groups = mailing lists).
 * Listing/search rows arrive as `add_contact_row(cid, cols, type, data)`. Search results mix
 * sources and use `<cid>-<source>` ids.
 */
import { Client, WebmailError } from "./client.ts";
import { applyEdits, callsOf, parseForms, serializeForm, stripTags, type FormField } from "./protocol.ts";

export interface Source {
  id: string;
  name: string;
  readonly: boolean;
  groups: boolean;
}

export interface Group {
  source: string;
  id: string;
  name: string;
}

export interface ContactRow {
  cid: string;
  source: string;
  name: string;
  email?: string;
  type: string;
}

export interface ContactPage {
  page: number;
  pages: number;
  rows: ContactRow[];
  searchId?: string;
  count?: string;
}

const envCache = new WeakMap<Client, Promise<Record<string, unknown>>>();
function bookEnv(c: Client): Promise<Record<string, unknown>> {
  let p = envCache.get(c);
  if (!p) {
    p = c.page({ _task: "addressbook" }).then((r) => r.env);
    envCache.set(c, p);
  }
  return p;
}

export async function sources(c: Client): Promise<{ sources: Source[]; groups: Group[] }> {
  const env = await bookEnv(c);
  const src = Object.values((env.address_sources ?? {}) as Record<string, { id: string; name: string; readonly?: boolean; groups?: boolean }>).map((s) => ({
    id: String(s.id),
    name: s.name,
    readonly: Boolean(s.readonly),
    groups: Boolean(s.groups),
  }));
  const groups = Object.values((env.contactgroups ?? {}) as Record<string, { source: string; id: string; name: string }>).map((g) => ({ source: g.source, id: g.id, name: g.name }));
  return { sources: src, groups };
}

/** Split a search-result id `<cid>-<source>` when the suffix names a source. */
export async function resolveCid(c: Client, cid: string, source: string | undefined): Promise<{ cid: string; source: string }> {
  if (source) return { cid, source };
  const { sources: all } = await sources(c);
  for (const s of all) if (cid.endsWith(`-${s.id}`)) return { cid: cid.slice(0, -(s.id.length + 1)), source: s.id };
  return { cid, source: "0" };
}

function rowsOf(r: { calls: { method: string; args: unknown[] }[] }, source: string): ContactRow[] {
  return callsOf(r, "add_contact_row").map(([cid, cols, type, data]) => {
    const d = (data ?? {}) as Record<string, string>;
    const id = String(cid);
    const row: ContactRow = { cid: id, source, name: stripTags(String((cols as Record<string, string>)?.name ?? d.name ?? "")), type: String(type ?? "person") };
    if (d.email) row.email = d.email;
    return row;
  });
}

/** GET `_action=list&_source&_gid&_page`. */
export async function list(c: Client, o: { source: string; group?: string; page?: number }): Promise<ContactPage> {
  const r = await c.ajax("addressbook", "list", { _source: o.source, _gid: o.group, _page: o.page ?? 1 });
  return { page: o.page ?? 1, pages: Number(r.env.pagecount ?? 1), rows: rowsOf(r, o.source), count: String(callsOf(r, "set_rowcount")[0]?.[0] ?? "") };
}

/** GET `_action=search&_q[&_source&_gid]` (quick search over all sources unless one is given). */
export async function search(c: Client, q: string, o: { source?: string; group?: string; page?: number } = {}): Promise<ContactPage> {
  let r = await c.ajax("addressbook", "search", { _q: q, _source: o.source, _gid: o.group });
  const searchId = r.env.search_request as string | undefined;
  if ((o.page ?? 1) > 1 && searchId) r = await c.ajax("addressbook", "list", { _search: searchId, _page: o.page, _source: o.source ?? "" });
  return { page: o.page ?? 1, pages: Number(r.env.pagecount ?? 1), rows: rowsOf(r, o.source ?? ""), ...(searchId ? { searchId } : {}) };
}

/** vCard export: GET `_action=export&_source[&_cid|&_gid]`. */
export async function exportVcf(c: Client, o: { source: string; cid?: string; group?: string }): Promise<string> {
  const res = await c.download({ _task: "addressbook", _action: "export", _source: o.source, _cid: o.cid, _gid: o.group });
  return res.text();
}

/** Parse vCard text into simple records (unfolded, params kept as type list). */
export function parseVcards(text: string): Record<string, string[]>[] {
  const out: Record<string, string[]>[] = [];
  let cur: Record<string, string[]> | null = null;
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    if (/^BEGIN:VCARD/i.test(line)) cur = {};
    else if (/^END:VCARD/i.test(line)) {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur && line.includes(":")) {
      const i = line.indexOf(":");
      const [prop = "", ...params] = line.slice(0, i).split(";");
      const name = prop.replace(/^item\d+\./i, "").toUpperCase();
      if (["VERSION", "PRODID", "UID", "REV", "PHOTO"].includes(name)) continue;
      const types = params.map((p) => p.replace(/^type=/i, "").toLowerCase()).filter((p) => !p.includes("="));
      const value = line.slice(i + 1).replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").replace(/;+/g, " ").trim();
      if (value) (cur[name] ??= []).push(types.length ? `${value} (${types.join(",")})` : value);
    }
  }
  return out;
}

export interface ContactInput {
  prefix?: string;
  first?: string;
  middle?: string;
  last?: string;
  suffix?: string;
  name?: string;
  nickname?: string;
  organization?: string;
  department?: string;
  jobtitle?: string;
  emails?: string[];
  phones?: string[];
  birthday?: string;
  gender?: string;
  notes?: string;
  /** Any other edit-form field, e.g. `{ "_subtype_email[]": "work" }`. */
  extra?: Record<string, string>;
}

const SCALARS: [keyof ContactInput, string][] = [
  ["prefix", "_prefix"], ["first", "_firstname"], ["middle", "_middlename"], ["last", "_surname"], ["suffix", "_suffix"],
  ["name", "_name"], ["nickname", "_nickname"], ["organization", "_organization"], ["department", "_department"],
  ["jobtitle", "_jobtitle"], ["birthday", "_birthday"], ["gender", "_gender"], ["notes", "_notes"],
];

/** Replace a repeated field (`_email[]`) and its `_subtype_*[]` partner with new values. */
function setRepeated(fields: FormField[], name: string, subtype: string, values: string[]): FormField[] {
  const template = fields.find((f) => f.name === subtype);
  const kept = fields.filter((f) => f.name !== name && f.name !== subtype);
  const added: FormField[] = [];
  for (const v of values) {
    const [val, type] = v.split(/:(?=[a-z]+$)/i) as [string, string | undefined];
    if (template) added.push({ ...template, value: type ?? template.options?.[0]?.value ?? "home" });
    added.push({ name, type: "text", value: val });
  }
  return [...kept, ...added];
}

async function saveForm(c: Client, html: string, input: ContactInput): Promise<string[]> {
  const form = parseForms(html).find((f) => f.name === "editform");
  if (!form) throw new WebmailError("contact form not found (read-only address book?)");
  let fields = form.fields.filter((f) => f.type !== "file");
  const edits: Record<string, string> = {};
  for (const [k, field] of SCALARS) if (input[k] !== undefined) edits[field] = String(input[k]);
  Object.assign(edits, input.extra ?? {});
  fields = applyEdits(fields, edits);
  if (input.emails) fields = setRepeated(fields, "_email[]", "_subtype_email[]", input.emails);
  if (input.phones) fields = setRepeated(fields, "_phone[]", "_subtype_phone[]", input.phones);
  const r = await c.submit({ _task: "addressbook", _framed: 1 }, serializeForm(fields));
  return r.notices.length ? r.notices : ["Successfully saved."];
}

/** New contact: GET `_action=add&_source&_framed=1` form, POST `_action=save`. */
export async function add(c: Client, source: string, input: ContactInput, group?: string): Promise<string[]> {
  const page = await c.page({ _task: "addressbook", _action: "add", _source: source, _gid: group, _framed: 1 });
  return saveForm(c, page.html, input);
}

/** Edit: GET `_action=edit&_cid&_source&_framed=1`, POST `_action=save`. */
export async function edit(c: Client, cid: string, source: string, input: ContactInput): Promise<string[]> {
  const page = await c.page({ _task: "addressbook", _action: "edit", _cid: cid, _source: source, _framed: 1 });
  return saveForm(c, page.html, input);
}

/** POST `_action=delete&_cid&_source`. */
export async function remove(c: Client, cids: string[], source: string): Promise<string[]> {
  return (await c.ajax("addressbook", "delete", { _cid: cids.join(","), _source: source, _from: "" }, { post: true })).notices;
}

/** POST `_action=copy|move&_cid&_source&_to[&_togid]`. */
export async function transfer(c: Client, action: "copy" | "move", cids: string[], source: string, to: string, toGroup?: string): Promise<string[]> {
  return (await c.ajax("addressbook", action, { _cid: cids.join(","), _source: source, _to: to, _togid: toGroup, _from: "" }, { post: true })).notices;
}

export async function groupCreate(c: Client, source: string, name: string): Promise<string[]> {
  return (await c.ajax("addressbook", "group-create", { _source: source, _name: name }, { post: true })).notices;
}

export async function groupRename(c: Client, source: string, gid: string, name: string): Promise<string[]> {
  return (await c.ajax("addressbook", "group-rename", { _source: source, _gid: gid, _name: name }, { post: true })).notices;
}

export async function groupDelete(c: Client, source: string, gid: string): Promise<string[]> {
  return (await c.ajax("addressbook", "group-delete", { _source: source, _gid: gid }, { post: true })).notices;
}

/** POST `_action=group-addmembers|group-delmembers&_cid&_source&_gid`. */
export async function groupMembers(c: Client, op: "add" | "del", source: string, gid: string, cids: string[]): Promise<string[]> {
  return (await c.ajax("addressbook", `group-${op}members`, { _cid: cids.join(","), _source: source, _gid: gid }, { post: true })).notices;
}

/** vCard import: multipart POST `_action=import&_target&_replace&_groups` with `_file[]`. */
export async function importVcf(c: Client, target: string, files: { name: string; data: Blob }[], opts: { replace?: boolean; groups?: "0" | "1" | "2" } = {}): Promise<string[]> {
  const fields: [string, string | Blob, string?][] = [
    ["_target", target],
    ["_framed", "1"],
    ["_unlock", ""],
    ["_groups", opts.groups ?? "0"],
  ];
  if (opts.replace) fields.push(["_replace", "1"]);
  for (const f of files) fields.push(["_file[]", f.data, f.name]);
  const r = await c.submit({ _task: "addressbook", _action: "import", _framed: 1 }, fields);
  // Result page: <div class="propform"><p><b>Successfully imported N contacts</b>.</p><p>…skipped…</p></div>
  const summary = r.html.match(/<div class="propform">([\s\S]*?)<\/div>/)?.[1] ?? "";
  return [...r.notices, ...[...summary.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1]!)).filter(Boolean)];
}
