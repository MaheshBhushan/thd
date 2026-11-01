/**
 * Compose, reply, forward, drafts.
 *
 * Observed flow (same as the web UI):
 *   1. GET  `_task=mail&_action=compose[&_reply_uid|_forward_uid|_draft_uid&_mbox…]`
 *      → 302 to `…&_id=<compose_id>`; the page holds form "form" with prefilled fields and
 *      `env.attachments` (forwarded/draft files already on the server).
 *   2. POST `_action=upload&_id=<compose_id>&_uploadid&_from=compose&_remote=1` multipart
 *      `_attachments[]` → `add2attachment_list("rcmfile<id>", …)` per file.
 *   3. POST `/?_task=mail&_unlock=<x>&_framed=1` urlencoded form fields + `_action=send`,
 *      `_attachments=<ids without rcmfile>`, compose options copied in as hidden fields;
 *      `_draft=1` saves to Drafts instead. Reply HTML calls `sent_successfully(...)` or
 *      `set_draft_id(...)`.
 */
import { Client, WebmailError } from "./client.ts";
import { callsOf, ORPHAN_FORM, parseForms, serializeForm, type FormField } from "./protocol.ts";

export type ComposeMode =
  | { kind: "new" }
  | { kind: "reply"; uid: number; mbox: string; all?: "all" | "list" }
  | { kind: "forward"; uid: number; mbox: string; asAttachment?: boolean }
  | { kind: "draft"; uid: number; mbox: string }
  | { kind: "edit"; uid: number; mbox: string };

export interface ComposeInput {
  to?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  followupTo?: string;
  subject?: string;
  /** Text written by the user; for replies/forwards it goes above the quoted original. */
  body?: string;
  html?: boolean;
  /** Identity id or (part of) its address/name. */
  from?: string;
  attachments?: { name: string; data: Blob }[];
  priority?: "lowest" | "low" | "normal" | "high" | "highest";
  receipt?: boolean;
  dsn?: boolean;
  /** Folder to store the sent copy in; "" means don't save. */
  saveTo?: string;
  /** Save to Drafts instead of sending. */
  draft?: boolean;
}

export interface ComposeResult {
  sent: boolean;
  draft: boolean;
  notices: string[];
  draftId?: string;
}

const PRIORITY: Record<NonNullable<ComposeInput["priority"]>, string> = { lowest: "5", low: "4", normal: "0", high: "2", highest: "1" };
const OPTION_FIELDS = ["_mdn", "_dsn", "_keepformatting", "_priority", "_store_target"];

function modeParams(m: ComposeMode): Record<string, string | number> {
  switch (m.kind) {
    case "new":
      return {};
    case "reply":
      return { _reply_uid: m.uid, _mbox: m.mbox, ...(m.all ? { _all: m.all } : {}) };
    case "forward":
      return { _forward_uid: m.uid, _mbox: m.mbox, ...(m.asAttachment ? { _attachment: 1 } : {}) };
    case "draft":
      return { _draft_uid: m.uid, _mbox: m.mbox };
    case "edit":
      return { _uid: m.uid, _mbox: m.mbox };
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Resolve an identity selector against the `_from` select. */
export function pickIdentity(field: FormField | undefined, wanted: string | undefined): string {
  const opts = field?.options ?? [];
  if (!wanted) return field?.value ?? "";
  const w = wanted.toLowerCase();
  const hit = opts.find((o) => o.value === wanted) ?? opts.find((o) => o.label.toLowerCase().includes(w));
  if (!hit) throw new WebmailError(`no identity matches "${wanted}"; identities: ${opts.map((o) => `${o.value} (${o.label})`).join(", ")}`);
  return hit.value;
}

export async function compose(c: Client, mode: ComposeMode, input: ComposeInput): Promise<ComposeResult> {
  const page = await c.page({ _task: "mail", _action: "compose", ...modeParams(mode) });
  const composeId = page.env.compose_id as string | undefined;
  if (!composeId) throw new WebmailError(page.errors.join("; ") || "compose page did not open (message missing?)");
  const forms = parseForms(page.html);
  const form = forms.find((f) => f.name === "form");
  if (!form) throw new WebmailError("compose form not found");
  const optionFields = (forms.find((f) => f.id === ORPHAN_FORM)?.fields ?? []).filter((f) => OPTION_FIELDS.includes(f.name));
  const get = (name: string) => form.fields.find((f) => f.name === name);

  // Attachments already on the server (forward/draft), then uploads.
  const fileIds = Object.keys((page.env.attachments as Record<string, unknown> | undefined) ?? {});
  for (const a of input.attachments ?? []) {
    const fd = new FormData();
    fd.append("_attachments[]", a.data, a.name);
    const up = await c.ajax("mail", "upload", { _id: composeId, _uploadid: `upload${Date.now()}`, _from: "compose" }, { body: fd });
    const ids = callsOf(up, "add2attachment_list").map(([id]) => String(id));
    if (!ids.length) throw new WebmailError(`upload of ${a.name} failed`);
    fileIds.push(...ids);
  }

  const values = new Map<string, string>();
  const set = (k: string, v: string | undefined) => v !== undefined && values.set(k, v);
  set("_to", input.to);
  set("_cc", input.cc);
  set("_bcc", input.bcc);
  set("_replyto", input.replyTo);
  set("_followupto", input.followupTo);
  set("_subject", input.subject);
  values.set("_from", pickIdentity(get("_from"), input.from));

  // Body: user text above the server-prefilled quote/forward header (Roundcube top-posting).
  const prefilled = (get("_message")?.value ?? "").replace(/^\s+/, "");
  const userText = input.body ?? "";
  const signature = signatureFor(page.env, values.get("_from")!, mode.kind);
  let message: string;
  if (input.html) {
    const quoted = prefilled ? `<blockquote><pre>${escapeHtml(prefilled)}</pre></blockquote>` : "";
    const sig = signature ? `<div class="pre">-- <br>${escapeHtml(signature).replace(/\n/g, "<br>")}</div>` : "";
    message = `<html><body>${userText}${sig}${quoted}</body></html>`;
  } else {
    message = [userText, signature ? `-- \n${signature}` : "", prefilled].filter(Boolean).join("\n\n");
  }
  if (mode.kind === "draft" || mode.kind === "edit") message = input.body ?? get("_message")?.value ?? "";
  values.set("_message", message);
  values.set("_is_html", input.html ? "1" : "0");
  values.set("_draft", input.draft ? "1" : "");
  values.set("_attachments", fileIds.map((id) => id.replace(/^rcmfile/, "")).join(","));

  const fields: [string, string][] = serializeForm(form.fields).filter(([k]) => !values.has(k) && k !== "editorSelector");
  for (const [k, v] of values) fields.push([k, v]);
  // Elastic copies the option controls into the form as hidden fields (unchecked → "").
  for (const f of optionFields) {
    let v = f.type === "checkbox" ? (f.checked ? f.value : "") : f.value;
    if (f.name === "_priority" && input.priority) v = PRIORITY[input.priority];
    if (f.name === "_mdn" && input.receipt !== undefined) v = input.receipt ? "1" : "";
    if (f.name === "_dsn" && input.dsn !== undefined) v = input.dsn ? "1" : "";
    if (f.name === "_store_target" && input.saveTo !== undefined) v = input.saveTo;
    fields.push([f.name, v]);
  }
  if (!input.draft && !values.get("_to") && !values.get("_cc") && !values.get("_bcc") && !get("_to")?.value) {
    throw new WebmailError("no recipient: pass --to, --cc or --bcc");
  }

  const r = await c.submit({ _task: "mail", _unlock: `loading${Date.now()}`, _framed: 1 }, fields);
  const sent = callsOf(r, "sent_successfully")[0];
  const draftId = callsOf(r, "set_draft_id")[0]?.[0];
  if (!input.draft && !sent) throw new WebmailError(r.errors.join("; ") || "server did not confirm sending");
  if (input.draft && draftId === undefined && !r.notices.length) throw new WebmailError(r.errors.join("; ") || "server did not confirm saving the draft");
  const result: ComposeResult = { sent: Boolean(sent), draft: Boolean(input.draft), notices: sent ? [String(sent[1])] : r.notices };
  if (draftId !== undefined) result.draftId = String(draftId);
  return result;
}

/** Signature the UI would insert (env.signatures keyed by identity, show_sig 1=always 2=new 3=reply/fwd). */
function signatureFor(env: Record<string, unknown>, identity: string, kind: ComposeMode["kind"]): string {
  const sigs = env.signatures as Record<string, { text?: string }> | undefined;
  const text = sigs?.[identity]?.text?.trim();
  if (!text) return "";
  const mode = Number(env.show_sig ?? 1);
  if (mode === 0) return "";
  if (mode === 2 && kind !== "new") return "";
  if (mode === 3 && kind === "new") return "";
  return text.replace(/^--\s*\n/, "");
}
