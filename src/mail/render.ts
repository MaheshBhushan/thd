/** Pure text rendering for the CLI. Data in, strings out. */
import type { FormField, HtmlForm, MessageRow } from "./protocol.ts";
import type { MessageView } from "./mail.ts";

const width = () => process.stdout.columns || 120;

export function truncate(s: string, n: number): string {
  if (n <= 1) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Left-aligned columns; the last column takes the remaining width. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (!all.length) return "";
  const cols = Math.max(...all.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const used = widths.slice(0, -1).reduce((a, b) => a + b + 2, 0);
  widths[cols - 1] = Math.max(10, Math.min(widths[cols - 1]!, width() - used));
  return all
    .map((r) => r.map((cell, i) => (i === cols - 1 ? truncate(cell, widths[i]!) : cell.padEnd(widths[i]!))).join("  ").trimEnd())
    .join("\n");
}

export function messageFlags(r: MessageRow): string {
  return [r.seen ? " " : "N", r.flagged ? "F" : " ", r.answered ? "R" : r.forwarded ? "→" : " ", r.hasAttachment ? "@" : " ", r.deleted ? "D" : " "].join("");
}

export function messageTable(rows: MessageRow[], showFolder = false): string {
  return table(
    rows.map((r) => [
      String(r.uid),
      ...(showFolder ? [r.mbox] : []),
      messageFlags(r),
      r.date,
      truncate(r.from[0] ? r.from[0].name || r.from[0].email : "", 28),
      `${"  ".repeat(r.depth ?? 0)}${r.subject}`,
    ]),
    ["UID", ...(showFolder ? ["FOLDER"] : []), "FLAGS", "DATE", "FROM", "SUBJECT"],
  );
}

export function messageView(v: MessageView, opts: { headers?: boolean; html?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.headers) {
    for (const [k, val] of Object.entries(v.headers)) lines.push(`${k}: ${val}`);
  } else {
    lines.push(`From:    ${v.from}`, `To:      ${v.to}`);
    if (v.cc) lines.push(`Cc:      ${v.cc}`);
    if (v.replyTo) lines.push(`Reply-To: ${v.replyTo}`);
    if (v.date) lines.push(`Date:    ${v.date}`);
    lines.push(`Subject: ${v.subject}`);
  }
  if (v.attachments.length) {
    lines.push(`Attachments:`);
    for (const a of v.attachments) lines.push(`  [${a.index}] ${a.filename} (${a.contentType}, ${humanSize(a.size)})${a.inline ? " inline" : ""}`);
  }
  lines.push("", opts.html && v.html ? v.html : v.text);
  return lines.join("\n");
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fieldValue(f: FormField): string {
  if (f.type === "checkbox") return f.checked ? "on" : "off";
  if (f.type === "select") {
    const label = f.options?.find((o) => o.value === f.value)?.label;
    return label && label !== f.value ? `${f.value} (${label})` : f.value;
  }
  return f.value.includes("\n") ? JSON.stringify(f.value) : f.value;
}

/** One line per editable field: key, current value, choices, label. Radios collapse into one key. */
export function formFields(form: HtmlForm, opts: { choices?: boolean } = {}): string {
  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const f of form.fields) {
    if (f.type === "hidden" || f.type === "file" || f.name === "_token" || seen.has(f.name)) continue;
    const key = f.name.replace(/^_/, "");
    if (f.type === "radio") {
      seen.add(f.name);
      const group = form.fields.filter((x) => x.name === f.name);
      rows.push([key, group.find((x) => x.checked)?.value ?? "", `one of: ${group.map((x) => x.value).join(", ")}`]);
      continue;
    }
    if (f.type === "checkbox" && form.fields.filter((x) => x.name === f.name).length > 1) {
      seen.add(f.name);
      const group = form.fields.filter((x) => x.name === f.name);
      rows.push([key, group.filter((x) => x.checked).map((x) => x.value).join(",") || "-", f.label ?? ""]);
      continue;
    }
    let extra = f.label ?? "";
    if (opts.choices && f.type === "select" && f.options) {
      extra = `${extra}${extra ? " — " : ""}${f.options.map((o) => o.value).join(" | ")}`;
    } else if (f.type === "select" && f.options && f.options.length <= 8) {
      extra = `${extra}${extra ? " — " : ""}${f.options.map((o) => o.value).join(" | ")}`;
    }
    rows.push([key, fieldValue(f), extra]);
  }
  return table(rows, ["FIELD", "VALUE", "LABEL / CHOICES"]);
}
