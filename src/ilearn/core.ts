/**
 * The action layer. Nothing here prints — the CLI decides rendering. Every
 * action takes the Moodle client so tests can hand in a fake.
 */
import { mkdirSync, renameSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Moodle } from "./moodle.ts";

// ── pure helpers ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };

/** Moodle returns names HTML-escaped (`ERP &amp; MES`). */
export function decodeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(s: string): string {
  return decodeHtml(s.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
}

/** One path segment, safe on Linux/macOS/Windows filesystems. */
export function safeName(s: string): string {
  const clean = decodeHtml(s).replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "_").replace(/[. ]+$/, "");
  return (clean || "_").slice(0, 120);
}

export interface Course { id: number; shortname: string; fullname: string; [k: string]: unknown }

/** A course argument is a numeric id or a unique, case-insensitive substring of its name. */
export function resolveCourse(courses: Course[], query: string): Course {
  if (/^\d+$/.test(query)) {
    const hit = courses.find((c) => c.id === Number(query));
    if (hit) return hit;
    throw new Error(`not enrolled in a course with id ${query}`);
  }
  const q = query.toLowerCase();
  const hits = courses.filter((c) => decodeHtml(c.fullname).toLowerCase().includes(q) || decodeHtml(c.shortname).toLowerCase().includes(q));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new Error(`no enrolled course matches '${query}'`);
  throw new Error(`'${query}' matches ${hits.length} courses:\n` + hits.map((c) => `  ${c.id}  ${decodeHtml(c.fullname)}`).join("\n"));
}

export interface ModFile { type: string; filename: string; filepath: string | null; filesize: number; fileurl: string; timemodified: number }
export interface Module { id: number; name: string; modname: string; instance: number; url?: string; uservisible?: boolean; contents?: ModFile[]; dates?: { label: string; timestamp: number }[] }
export interface Section { id: number; name: string; section: number; summary?: string; modules: Module[] }
export interface Assignment { id: number; cmid: number; name: string; duedate: number; cutoffdate: number; allowsubmissionsfromdate: number; intro?: string; introattachments?: ModFile[] }

export interface FileJob { path: string; url: string; size: number; mtime: number }

/** Module types whose files are course material. Pages/books are HTML; `--all` picks them up too. */
const MATERIAL: Record<string, true> = { resource: true, folder: true };

/**
 * Plan every download for one course: `<section>/<file>` for resources,
 * `<section>/<folder>/<subpath>/<file>` for folders, `Assignments/<name>/…`
 * for assignment handouts. Colliding paths get the module id appended.
 */
export function planFiles(sections: Section[], assignments: Assignment[], opts: { all?: boolean } = {}): FileJob[] {
  const jobs: FileJob[] = [];
  const add = (dir: string[], f: ModFile) => {
    const sub = (f.filepath ?? "/").split("/").filter(Boolean).map(safeName);
    jobs.push({ path: join(...dir, ...sub, safeName(f.filename)), url: f.fileurl, size: f.filesize, mtime: f.timemodified });
  };
  sections.forEach((s, i) => {
    const sdir = `${String(i).padStart(2, "0")} ${safeName(s.name)}`;
    for (const m of s.modules) {
      if (m.uservisible === false || !(opts.all || MATERIAL[m.modname])) continue;
      const files = (m.contents ?? []).filter((f) => f.type === "file");
      const own = m.modname === "folder" || files.length > 1 || (opts.all && m.modname !== "resource");
      for (const f of files) add(own ? [sdir, safeName(m.name)] : [sdir], f);
    }
  });
  for (const a of assignments) for (const f of a.introattachments ?? []) add(["Assignments", safeName(a.name)], f);

  const seen = new Map<string, number>();
  for (const j of jobs) {
    const n = seen.get(j.path) ?? 0;
    seen.set(j.path, n + 1);
    if (n) j.path = j.path.replace(/(\.[^./]+)?$/, ` (${n + 1})$1`);
  }
  return jobs;
}

/** Resume rule: a file on disk with the same size and an mtime no older than the server's is done. */
export function isCurrent(local: { size: number; mtimeMs: number } | undefined, job: FileJob): boolean {
  if (!local) return false;
  return (job.size === 0 || local.size === job.size) && Math.floor(local.mtimeMs / 1000) >= job.mtime;
}

// ── raw response shapes (only the fields read here) ─────────────────────────

interface Editor { text?: string }
interface PluginData { type: string; fileareas?: { files?: { filename: string }[] }[]; editorfields?: Editor[] }
interface ActionEvent { name: string; activityname?: string; timesort: number; instance?: number; modulename: string; overdue?: boolean; url: string; course?: { id: number; fullname: string }; action?: { name: string; actionable: boolean } }
interface GradeItem { itemname: string | null; itemtype: string; gradeformatted?: string; percentageformatted?: string; rangeformatted?: string; feedback?: string }
interface SubmissionStatus {
  lastattempt?: { submission?: { status: string; plugins?: PluginData[] }; gradingstatus?: string; canedit?: boolean; cansubmit?: boolean; locked?: boolean };
  feedback?: { gradefordisplay?: string; plugins?: PluginData[] };
}
interface Notification { id: number; timecreated: number; read: boolean; subject: string; contexturl: string | null; smallmessage?: string; fullmessage?: string }
interface Conversation { id: number; name: string; unreadcount: number | null; members: { fullname: string }[]; messages: { text: string; timecreated: number }[] }
interface Discussion { discussion: number; name: string; userfullname: string; created: number; numreplies: number; message?: string }

const editorText = (plugins: PluginData[] = []) => plugins.flatMap((p) => (p.editorfields ?? []).map((e) => stripHtml(e.text ?? ""))).filter(Boolean);

// ── actions ────────────────────────────────────────────────────────────────

export type Classification = "inprogress" | "past" | "future" | "all";

export async function listCourses(m: Moodle, userid: number, cls: Classification = "inprogress"): Promise<Course[]> {
  if (cls === "all") return m.call<Course[]>("core_enrol_get_users_courses", { userid });
  const r = await m.call<{ courses: Course[] }>("core_course_get_enrolled_courses_by_timeline_classification", { classification: cls, limit: 0 });
  return r.courses;
}

export async function findCourse(m: Moodle, userid: number, query: string): Promise<Course> {
  return resolveCourse(await listCourses(m, userid, "all"), query);
}

export async function courseContents(m: Moodle, courseid: number): Promise<Section[]> {
  return m.call<Section[]>("core_course_get_contents", { courseid });
}

export async function assignments(m: Moodle, courseids: number[] = []): Promise<(Assignment & { courseid: number; course: string })[]> {
  const r = await m.call<{ courses: { id: number; shortname: string; assignments: Assignment[] }[] }>("mod_assign_get_assignments", { courseids });
  return r.courses.flatMap((c) => c.assignments.map((a) => ({ ...a, courseid: c.id, course: c.shortname })));
}

export interface DownloadEvent { kind: "skip" | "done" | "fail" | "plan"; job: FileJob; error?: string }

/**
 * Download jobs under `out`. Resumable: each file is written to `.part` and
 * renamed, its mtime set to the server's, and already-current files are
 * skipped. One failure does not stop the batch.
 */
export async function downloadFiles(m: Moodle, jobs: FileJob[], out: string, opts: { dryRun?: boolean; onEvent?: (e: DownloadEvent) => void } = {}): Promise<DownloadEvent[]> {
  const events: DownloadEvent[] = [];
  const emit = (e: DownloadEvent) => { events.push(e); opts.onEvent?.(e); };
  for (const job of jobs) {
    const dest = join(out, job.path);
    let local: { size: number; mtimeMs: number } | undefined;
    try { local = statSync(dest); } catch { local = undefined; }
    if (isCurrent(local, job)) { emit({ kind: "skip", job }); continue; }
    if (opts.dryRun) { emit({ kind: "plan", job }); continue; }
    try {
      const r = await m.download(job.url);
      mkdirSync(dirname(dest), { recursive: true });
      await Bun.write(dest + ".part", r);
      renameSync(dest + ".part", dest);
      if (job.mtime) utimesSync(dest, new Date(), new Date(job.mtime * 1000));
      emit({ kind: "done", job });
    } catch (e) {
      emit({ kind: "fail", job, error: (e as Error).message });
    }
  }
  return events;
}

export interface Deadline {
  time: number;
  name: string;
  course: string;
  courseid: number | null;
  cmid: number | null;
  modname: string;
  action: string | undefined;
  actionable: boolean;
  overdue: boolean;
  url: string;
}

export async function deadlines(m: Moodle, days: number): Promise<Deadline[]> {
  const now = Math.floor(Date.now() / 1000);
  const r = await m.call<{ events: ActionEvent[] }>("core_calendar_get_action_events_by_timesort", { timesortfrom: now - 86400, timesortto: now + days * 86400, limitnum: 50 });
  return r.events.map((e) => ({
    time: e.timesort, name: decodeHtml(e.activityname ?? e.name), course: decodeHtml(e.course?.fullname ?? ""),
    courseid: e.course?.id ?? null, cmid: e.url ? Number(new URL(e.url).searchParams.get("id")) || null : null, modname: e.modulename,
    action: e.action?.name, actionable: !!e.action?.actionable, overdue: !!e.overdue, url: e.url,
  }));
}

export async function grades(m: Moodle, userid: number, courseid?: number) {
  if (courseid === undefined) {
    const [r, courses] = await Promise.all([
      m.call<{ grades: { courseid: number; grade: string; rawgrade: string | null }[] }>("gradereport_overview_get_course_grades", { userid }),
      listCourses(m, userid, "all"),
    ]);
    const name = new Map(courses.map((c) => [c.id, decodeHtml(c.fullname)]));
    return r.grades.map((g) => ({ courseid: g.courseid, course: name.get(g.courseid) ?? String(g.courseid), grade: decodeHtml(g.grade) }));
  }
  const r = await m.call<{ usergrades: { gradeitems: GradeItem[] }[] }>("gradereport_user_get_grade_items", { courseid, userid });
  return (r.usergrades[0]?.gradeitems ?? []).map((g) => ({
    item: decodeHtml(g.itemname ?? (g.itemtype === "course" ? "Course total" : "?")), type: g.itemtype,
    grade: decodeHtml(g.gradeformatted ?? "-"), percentage: decodeHtml(g.percentageformatted ?? "-"),
    range: decodeHtml(g.rangeformatted ?? ""), feedback: g.feedback ? stripHtml(g.feedback) : "",
  }));
}

/** A course-module id (what `ilearn course` shows) → its activity instance. */
export async function moduleInfo(m: Moodle, cmid: number) {
  const r = await m.call<{ cm: { id: number; instance: number; modname: string; course: number; name: string } }>("core_course_get_course_module", { cmid });
  return r.cm;
}

export interface AssignmentStatus {
  cmid: number;
  assignid: number;
  name: string;
  course: string;
  duedate: number;
  cutoffdate: number;
  intro: string;
  attachments: string[];
  status: string;
  gradingstatus: string;
  canedit: boolean;
  cansubmit: boolean;
  locked: boolean;
  files: string[];
  text: string[];
  grade: string;
  feedback: string[];
}

export async function assignmentStatus(m: Moodle, cmid: number): Promise<AssignmentStatus> {
  const cm = await moduleInfo(m, cmid);
  if (cm.modname !== "assign") throw new Error(`module ${cmid} is a ${cm.modname}, not an assignment`);
  const [list, st] = await Promise.all([
    assignments(m, [cm.course]),
    m.call<SubmissionStatus>("mod_assign_get_submission_status", { assignid: cm.instance }),
  ]);
  const a = list.find((x) => x.id === cm.instance);
  const sub = st.lastattempt?.submission;
  const files = (sub?.plugins ?? []).flatMap((p) => (p.fileareas ?? []).flatMap((fa) => (fa.files ?? []).map((f) => f.filename)));
  const text = editorText(sub?.plugins);
  const fb = st.feedback;
  return {
    cmid, assignid: cm.instance, name: decodeHtml(cm.name), course: a?.course ?? "",
    duedate: a?.duedate ?? 0, cutoffdate: a?.cutoffdate ?? 0, intro: a?.intro ? stripHtml(a.intro) : "",
    attachments: (a?.introattachments ?? []).map((f) => f.filename),
    status: sub?.status ?? "new", gradingstatus: st.lastattempt?.gradingstatus ?? "",
    canedit: !!st.lastattempt?.canedit, cansubmit: !!st.lastattempt?.cansubmit, locked: !!st.lastattempt?.locked,
    files, text,
    grade: fb ? decodeHtml(fb.gradefordisplay ?? "") : "",
    feedback: fb ? editorText(fb.plugins) : [],
  };
}

/**
 * Upload files (and/or online text) as the assignment submission draft.
 * With `final`, also submit for grading — the irreversible step in courses
 * that require clicking "Submit assignment".
 */
export async function submitAssignment(m: Moodle, cmid: number, input: { files: { name: string; data: Blob }[]; text?: string; final?: boolean }) {
  const cm = await moduleInfo(m, cmid);
  if (cm.modname !== "assign") throw new Error(`module ${cmid} is a ${cm.modname}, not an assignment`);
  if (!input.files.length && input.text === undefined) throw new Error("nothing to submit: give files and/or --text");
  const plugindata: Record<string, unknown> = {};
  if (input.files.length) plugindata.files_filemanager = await m.upload(input.files);
  if (input.text !== undefined) {
    const draft = await m.call<{ itemid: number }>("core_files_get_unused_draft_itemid");
    plugindata.onlinetext_editor = { text: input.text, format: 1, itemid: draft.itemid };
  }
  const warnings = await m.call<{ message: string }[]>("mod_assign_save_submission", { assignmentid: cm.instance, plugindata });
  if (warnings.length) throw new Error("save rejected: " + warnings.map((w) => w.message).join("; "));
  if (input.final) {
    const w2 = await m.call<{ message: string }[]>("mod_assign_submit_for_grading", { assignmentid: cm.instance, acceptsubmissionstatement: true });
    if (w2.length) throw new Error("submit-for-grading rejected: " + w2.map((w) => w.message).join("; "));
  }
  return assignmentStatus(m, cmid);
}

export async function notifications(m: Moodle, userid: number, limit: number) {
  const r = await m.call<{ notifications: Notification[]; unreadcount: number }>("message_popup_get_popup_notifications", { useridto: userid, limit, newestfirst: 1 });
  return {
    unread: r.unreadcount,
    items: r.notifications.map((n) => ({ id: n.id, time: n.timecreated, read: !!n.read, subject: decodeHtml(n.subject), url: n.contexturl, text: stripHtml(n.smallmessage ?? n.fullmessage ?? "") })),
  };
}

export async function conversations(m: Moodle, userid: number, limit: number) {
  const r = await m.call<{ conversations: Conversation[] }>("core_message_get_conversations", { userid, limitnum: limit });
  return r.conversations.map((c) => ({
    id: c.id, name: decodeHtml(c.name || c.members.map((x) => x.fullname).join(", ")), unread: c.unreadcount ?? 0,
    last: c.messages[0] ? { time: c.messages[0].timecreated, text: stripHtml(c.messages[0].text) } : null,
  }));
}

export async function forumDiscussions(m: Moodle, cmid: number, limit: number) {
  const cm = await moduleInfo(m, cmid);
  if (cm.modname !== "forum") throw new Error(`module ${cmid} is a ${cm.modname}, not a forum`);
  const r = await m.call<{ discussions: Discussion[] }>("mod_forum_get_forum_discussions", { forumid: cm.instance, perpage: limit, page: 0 });
  return r.discussions.map((d) => ({
    id: d.discussion, subject: decodeHtml(d.name), author: d.userfullname, time: d.created,
    replies: d.numreplies, message: stripHtml(d.message ?? ""),
  }));
}

export interface Post {
  id: number;
  subject: string;
  author: string;
  time: number;
  message: string;
  parentId: number | null;
}

/** Posts of one discussion (the `d=` in forum mail links), oldest first. */
export async function discussionPosts(m: Moodle, discussionid: number, limit: number): Promise<Post[]> {
  const r = await m.call<{ posts: { id: number; subject: string; message: string; timecreated: number; parentid: number | null; author?: { fullname?: string } }[] }>("mod_forum_get_discussion_posts", { discussionid, sortby: "created", sortdirection: "ASC" });
  return r.posts.slice(0, limit).map((p) => ({ id: p.id, subject: decodeHtml(p.subject), author: p.author?.fullname ?? "", time: p.timecreated, message: stripHtml(p.message), parentId: p.parentid }));
}

/** `key=value` pairs (keys may use `a[0]` / `a[b]` brackets) → nested params. Values that look like JSON are parsed. */
export function parseCallArgs(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq <= 0) throw new Error(`expected key=value, got '${p}'`);
    const keys = p.slice(0, eq).split(/[[\]]+/).filter(Boolean);
    const raw = p.slice(eq + 1);
    let value: unknown = raw;
    if (/^[\[{]/.test(raw)) {
      try { value = JSON.parse(raw); } catch { throw new Error(`value for ${p.slice(0, eq)} looks like JSON but does not parse`); }
    }
    let node = out;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) node[k] = value;
      else node = (node[k] ??= {}) as Record<string, unknown>;
    });
  }
  return out;
}
