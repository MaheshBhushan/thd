/**
 * Settings (task=settings): preferences, identities, responses, folders, folder sharing (acl
 * plugin) and server-side filters (managesieve plugin).
 *
 * Most settings screens are framed HTML forms (`_framed=1`) that post back to the same URL with
 * a hidden `_action` (save-prefs, save-identity, save-response, save-folder,
 * plugin.managesieve-save, plugin.managesieve-saveraw). They are driven generically: load the
 * form, apply `key=value` edits, submit every field the way a browser would.
 */
import { parseHTML } from "linkedom";
import { Client, WebmailError, type Params } from "./client.ts";
import { applyEdits, callsOf, parseForms, serializeForm, stripTags, type FormField, type HtmlForm } from "./protocol.ts";

export async function loadForm(c: Client, params: Params, name = "form"): Promise<HtmlForm> {
  const page = await c.page({ _task: "settings", _framed: 1, ...params });
  const form = parseForms(page.html).find((f) => f.name === name || f.id === name);
  if (!form) throw new WebmailError(page.errors.join("; ") || `form "${name}" not found`);
  return form;
}

export async function submitForm(c: Client, form: HtmlForm, edits: Record<string, string>): Promise<string[]> {
  const fields = applyEdits(form.fields, edits);
  const r = await c.submit({ _task: "settings", _framed: 1 }, serializeForm(fields));
  return r.notices.length ? r.notices : ["Successfully saved."];
}

/** Editable fields of a form, as shown to the user (hidden plumbing omitted). */
export function visibleFields(form: HtmlForm): FormField[] {
  return form.fields.filter((f) => f.type !== "hidden" && f.type !== "file" && f.name !== "_token");
}

// ---- preferences ----------------------------------------------------------------------

/** Sections listed on Settings → Preferences (`rcmrow<section>`). */
export async function prefSections(c: Client): Promise<{ id: string; name: string }[]> {
  const page = await c.page({ _task: "settings", _action: "preferences" });
  return [...page.html.matchAll(/<tr[^>]*id="rcmrow(\w+)"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => ({ id: m[1]!, name: stripTags(m[2]!) }));
}

export const prefsForm = (c: Client, section: string) => loadForm(c, { _action: "edit-prefs", _section: section });

// ---- identities -----------------------------------------------------------------------

export interface Row {
  id: string;
  text: string;
}

function tableRows(html: string): Row[] {
  return [...html.matchAll(/<tr[^>]*id="rcmrow([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => ({ id: m[1]!, text: stripTags(m[2]!.replace(/<\/td>/g, " ")).replace(/\s+/g, " ") }));
}

export async function identities(c: Client): Promise<Row[]> {
  return tableRows((await c.page({ _task: "settings", _action: "identities" })).html);
}

export const identityForm = (c: Client, iid?: string) => loadForm(c, iid ? { _action: "edit-identity", _iid: iid } : { _action: "add-identity" });

export async function deleteIdentity(c: Client, iid: string): Promise<string[]> {
  return (await c.ajax("settings", "delete-identity", { _iid: iid }, { post: true })).notices;
}

// ---- responses (canned replies) -------------------------------------------------------

export async function responses(c: Client): Promise<Row[]> {
  return tableRows((await c.page({ _task: "settings", _action: "responses" })).html);
}

export const responseForm = (c: Client, id?: string) => loadForm(c, id ? { _action: "edit-response", _id: id } : { _action: "add-response" });

export async function deleteResponse(c: Client, id: string): Promise<string[]> {
  return (await c.ajax("settings", "delete-response", { _id: id }, { post: true })).notices;
}

// ---- folders --------------------------------------------------------------------------

/** Folder properties form: `_action=edit-folder&_mbox` (empty `_mbox` = new folder). */
export const folderForm = (c: Client, mbox: string) => loadForm(c, { _action: "edit-folder", _mbox: mbox });

export async function folderInfo(c: Client, mbox: string): Promise<{ mbox: string; messages: number; size: string; acl: Record<string, string>; form: HtmlForm }> {
  const page = await c.page({ _task: "settings", _action: "edit-folder", _mbox: mbox, _framed: 1 });
  const form = parseForms(page.html).find((f) => f.name === "form");
  if (!form) throw new WebmailError(page.errors.join("; ") || `folder ${mbox} not found`);
  const size = callsOf(await c.ajax("settings", "folder-size", { _mbox: mbox }, { post: true }), "folder_size_update")[0]?.[0];
  // env.acl is keyed by a mangled row id; the table row's data-userid holds the real identifier.
  const acl: Record<string, string> = {};
  for (const [rowId, rights] of Object.entries((page.env.acl ?? {}) as Record<string, string>)) {
    const user = new RegExp(`id="rcmrow${rowId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*data-userid="([^"]*)"`).exec(page.html)?.[1];
    acl[user ? stripTags(user) : rowId] = rights;
  }
  return { mbox, messages: Number(page.env.messagecount ?? 0), size: String(size ?? ""), acl, form };
}

export async function createFolder(c: Client, name: string, parent = "", viewmode?: "0" | "1"): Promise<string[]> {
  const form = await folderForm(c, "");
  return submitForm(c, form, { _name: name, _parent: parent, ...(viewmode ? { _viewmode: viewmode } : {}) });
}

/** Rename/move through the properties form, as the UI's Save does. */
export async function renameFolder(c: Client, mbox: string, newName: string, newParent?: string): Promise<string[]> {
  const form = await folderForm(c, mbox);
  if (!form.fields.some((f) => f.name === "_name")) throw new WebmailError(`${mbox} is a special folder and cannot be renamed`);
  return submitForm(c, form, { _name: newName, ...(newParent !== undefined ? { _parent: newParent } : {}) });
}

export async function deleteFolder(c: Client, mbox: string): Promise<string[]> {
  return (await c.ajax("settings", "delete-folder", { _mbox: mbox }, { post: true })).notices;
}

export async function subscribe(c: Client, mbox: string, on: boolean): Promise<string[]> {
  return (await c.ajax("settings", on ? "subscribe" : "unsubscribe", { _mbox: mbox }, { post: true })).notices;
}

/** acl plugin: POST `plugin.acl` `_act=save&_user&_acl&_mbox` (rights letters, e.g. lrs). */
export async function aclSet(c: Client, mbox: string, user: string, rights: string): Promise<string[]> {
  return (await c.ajax("settings", "plugin.acl", { _act: "save", _user: user, _acl: rights, _mbox: mbox }, { post: true })).notices;
}

export async function aclDelete(c: Client, mbox: string, user: string): Promise<string[]> {
  return (await c.ajax("settings", "plugin.acl", { _act: "delete", _user: user, _mbox: mbox }, { post: true })).notices;
}

// ---- filters (managesieve) ------------------------------------------------------------

export interface FilterSet {
  name: string;
  active: boolean;
}

export interface Filter {
  id: string;
  name: string;
  enabled: boolean;
}

export async function filterSets(c: Client): Promise<FilterSet[]> {
  const page = await c.page({ _task: "settings", _action: "plugin.managesieve" });
  const sets = (page.env.filtersets ?? {}) as Record<string, string>;
  const { document } = parseHTML(page.html);
  return Object.entries(sets).map(([rowId, name]) => ({ name, active: !(document.getElementById(`rcmrow${rowId}`)?.getAttribute("class") ?? "").split(/\s+/).includes("disabled") }));
}

async function currentSet(c: Client, set?: string): Promise<string> {
  if (set) return set;
  const sets = await filterSets(c);
  const s = sets.find((x) => x.active) ?? sets[0];
  if (!s) throw new WebmailError("no filter sets exist");
  return s.name;
}

/** POST `plugin.managesieve-action` `_act=list&_set` → managesieve_updatelist('list', {list}). Also selects the set server-side. */
export async function filters(c: Client, set?: string): Promise<{ set: string; filters: Filter[] }> {
  const name = await currentSet(c, set);
  const r = await c.ajax("settings", "plugin.managesieve-action", { _act: "list", _set: name }, { post: true });
  const list = (callsOf(r, "managesieve_updatelist").find(([a]) => a === "list")?.[1] as { list?: { id: number | string; name: string; class?: string }[] } | undefined)?.list ?? [];
  return { set: name, filters: list.map((f) => ({ id: String(f.id), name: stripTags(f.name), enabled: !String(f.class ?? "").includes("disabled") })) };
}

/** Toggle with `_act=act&_fid` only when the state differs (the endpoint is a toggle). */
export async function setFilterEnabled(c: Client, fid: string, enabled: boolean, set?: string): Promise<string[]> {
  const { filters: list } = await filters(c, set);
  const f = list.find((x) => x.id === fid);
  if (!f) throw new WebmailError(`no filter with id ${fid}`);
  if (f.enabled === enabled) return [`filter already ${enabled ? "enabled" : "disabled"}`];
  return (await c.ajax("settings", "plugin.managesieve-action", { _act: "act", _fid: fid }, { post: true })).notices;
}

export async function deleteFilter(c: Client, fid: string, set?: string): Promise<string[]> {
  await filters(c, set);
  return (await c.ajax("settings", "plugin.managesieve-action", { _act: "delete", _fid: fid }, { post: true })).notices;
}

/** Reorder: `_act=move&_fid&_to` (target position). */
export async function moveFilter(c: Client, fid: string, to: string, set?: string): Promise<string[]> {
  await filters(c, set);
  return (await c.ajax("settings", "plugin.managesieve-action", { _act: "move", _fid: fid, _to: to }, { post: true })).notices;
}

/** Filter editor form: `_fid=<id>` edits, `_nav=hide` without fid creates. */
export async function filterForm(c: Client, fid: string | undefined, set?: string): Promise<HtmlForm> {
  await filters(c, set);
  return loadForm(c, { _action: "plugin.managesieve-action", ...(fid ? { _fid: fid } : { _nav: "hide" }) }, "filterform");
}

/** Raw sieve script: form `filterseteditraw`, field `rawsetcontent`. */
export async function rawScriptForm(c: Client, set?: string): Promise<HtmlForm> {
  const name = await currentSet(c, set);
  return loadForm(c, { _action: "plugin.managesieve-action", _nav: "hide", _seteditraw: 1, _set: name }, "filterseteditraw");
}

export async function setAction(c: Client, act: "setact" | "deact" | "setdel", set: string): Promise<string[]> {
  return (await c.ajax("settings", "plugin.managesieve-action", { _act: act, _set: set }, { post: true })).notices;
}

/** New filter set form (`_newset=1`). */
export const newSetForm = (c: Client) => loadForm(c, { _action: "plugin.managesieve-action", _nav: "hide", _newset: 1 }, "filtersetform");
